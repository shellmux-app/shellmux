//! Shared test fixtures. Each test binary only uses part of this, so warnings are disabled.
#![allow(dead_code)]

//! In-process SSH server for the integration tests.
//!
//! No test needs a real network or a remote machine: each test spawns a server
//! on 127.0.0.1 with an OS-chosen port, using a randomly generated host key.

pub mod sftp_server;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{Auth, Msg, Server as _, Session};
use russh::{server, Channel, ChannelId};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;

use sftp_server::TestSftpHandler;
use shellmux_lib::pipe::splice;
use shellmux_lib::vault::{AuthKind, Host, Identity, Vault};

/// Test server: echoes every byte on the session channel, (optionally) allows
/// direct-tcpip so it can act as a bastion or as the target of a local forward,
/// and (optionally) serves a real SFTP subsystem backed by a directory on disk.
#[derive(Clone)]
pub struct TestServer {
    allow_forward: bool,
    /// russh pushes data to *both* `Channel` and `Handler::data`. Whichever channel is
    /// currently being spliced must be skipped by `data()`, otherwise the echo will
    /// overwrite the tunnel's bytes and break the handshake inside it.
    forwarded: Arc<Mutex<HashSet<ChannelId>>>,
    sftp_root: Option<PathBuf>,
    /// Holds a session channel between `channel_open_session` (which only gets a
    /// `ChannelId` handed onward) and `subsystem_request` (which needs the real
    /// `Channel` to turn into a byte stream) — the same pattern russh-sftp's own
    /// example server uses.
    pending_channels: Arc<AsyncMutex<std::collections::HashMap<ChannelId, Channel<Msg>>>>,
}

impl TestServer {
    fn new(allow_forward: bool) -> Self {
        Self {
            allow_forward,
            forwarded: Arc::new(Mutex::new(HashSet::new())),
            sftp_root: None,
            pending_channels: Arc::new(AsyncMutex::new(std::collections::HashMap::new())),
        }
    }

    fn with_sftp(root: PathBuf) -> Self {
        Self {
            sftp_root: Some(root),
            ..Self::new(false)
        }
    }
}

impl server::Server for TestServer {
    type Handler = Self;
    fn new_client(&mut self, _addr: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for TestServer {
    type Error = russh::Error;

    /// The test exercises the client side, so the server accepts every public key.
    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &russh::keys::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Stashed for `subsystem_request`, which only receives a `ChannelId` —
        // this is the same hand-off pattern russh-sftp's own example server uses.
        self.pending_channels
            .lock()
            .await
            .insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            if let Some(root) = self.sftp_root.clone() {
                let channel = self.pending_channels.lock().await.remove(&channel_id);
                if let Some(channel) = channel {
                    session.channel_success(channel_id)?;
                    russh_sftp::server::run(channel.into_stream(), TestSftpHandler::new(root))
                        .await;
                    return Ok(());
                }
            }
        }
        session.channel_failure(channel_id)?;
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.allow_forward {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }

        let target = (host_to_connect.to_string(), port_to_connect as u16);
        if let Ok(mut set) = self.forwarded.lock() {
            set.insert(channel.id());
        }
        reply.accept().await;
        tokio::spawn(async move {
            if let Ok(stream) = TcpStream::connect(target).await {
                let _ = splice(channel, stream).await;
            }
        });
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let is_tunnel = self
            .forwarded
            .lock()
            .map(|set| set.contains(&channel))
            .unwrap_or(false);
        if is_tunnel {
            return Ok(());
        }
        session.data(channel, data.to_vec())?;
        Ok(())
    }
}

pub struct RunningServer {
    pub port: u16,
    pub fingerprint: String,
}

pub async fn spawn_server(allow_forward: bool) -> RunningServer {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let fingerprint = key.public_key().fingerprint(Default::default()).to_string();

    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(0),
        keys: vec![key],
        ..Default::default()
    });

    let socket = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = socket.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut server = TestServer::new(allow_forward);
        let _ = server.run_on_socket(config, &socket).await;
    });

    RunningServer { port, fingerprint }
}

/// Same as `spawn_server`, but the session channel serves a real SFTP
/// subsystem backed by `root` instead of echoing bytes.
pub async fn spawn_sftp_server(root: PathBuf) -> RunningServer {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let fingerprint = key.public_key().fingerprint(Default::default()).to_string();

    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(0),
        keys: vec![key],
        ..Default::default()
    });

    let socket = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = socket.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut server = TestServer::with_sftp(root);
        let _ = server.run_on_socket(config, &socket).await;
    });

    RunningServer { port, fingerprint }
}

/// Temporary vault with an identity using a passphrase-less private key — so the
/// auth path doesn't need to touch the keychain of the machine running the tests.
pub struct VaultFixture {
    pub dir: tempfile::TempDir,
    pub vault: Arc<Vault>,
}

pub fn temp_vault_with_key() -> VaultFixture {
    let dir = tempfile::tempdir().unwrap();

    let client_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let key_path = dir.path().join("id_ed25519");
    std::fs::write(&key_path, client_key.to_openssh(LineEnding::LF).unwrap()).unwrap();

    let vault = Arc::new(Vault::open(&dir.path().join("vault.db")).unwrap());
    vault
        .upsert_identity(&Identity {
            id: "i1".into(),
            name: "test key".into(),
            private_key_path: key_path.to_string_lossy().into_owned(),
            has_secret: false,
        })
        .unwrap();

    VaultFixture { dir, vault }
}

/// Temporary vault that already has host `h1` pointing at `port` (host key *not yet* trusted).
pub fn temp_vault_with_host(port: u16) -> VaultFixture {
    let fx = temp_vault_with_key();
    fx.vault.upsert_host(&host_at("h1", port, None)).unwrap();
    fx
}

pub fn host_at(id: &str, port: u16, jump: Option<&str>) -> Host {
    Host {
        id: id.into(),
        group_id: None,
        label: id.into(),
        hostname: "127.0.0.1".into(),
        port,
        username: "tester".into(),
        auth_kind: AuthKind::Key,
        identity_id: Some("i1".into()),
        jump_host_id: jump.map(str::to_string),
        theme: None,
        color_tag: None,
        notes: None,
        sort: 0,
        agent_forward: false,
    }
}

/// Reads the first chunk of data from a channel, with a timeout so the test doesn't hang.
pub async fn first_data(channel: &mut Channel<russh::client::Msg>) -> Option<Vec<u8>> {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(msg) = channel.wait().await {
            if let russh::ChannelMsg::Data { data } = msg {
                return Some(data.to_vec());
            }
        }
        None
    })
    .await
    .expect("timed out waiting for data")
}
