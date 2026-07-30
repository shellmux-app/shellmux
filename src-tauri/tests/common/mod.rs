//! Shared test fixtures. Mỗi test binary chỉ dùng một phần nên tắt cảnh báo.
#![allow(dead_code)]

//! SSH server chạy trong process cho các test tích hợp.
//!
//! Không có test nào cần network thật hay máy remote: mỗi test spawn một server
//! trên 127.0.0.1 với cổng do OS chọn, dùng host key sinh ngẫu nhiên.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{Auth, Msg, Server as _, Session};
use russh::{server, Channel, ChannelId};
use tokio::net::{TcpListener, TcpStream};

use shellmux_lib::pipe::splice;
use shellmux_lib::vault::{AuthKind, Host, Identity, Vault};

/// Server test: echo mọi byte trên session channel, và (tuỳ chọn) cho phép
/// direct-tcpip để làm bastion hoặc đích của local forward.
#[derive(Clone)]
pub struct TestServer {
    allow_forward: bool,
    /// russh đẩy data tới *cả* `Channel` và `Handler::data`. Channel nào đang
    /// được splice thì `data()` phải bỏ qua, nếu không echo sẽ đè lên byte của
    /// tunnel và phá handshake bên trong.
    forwarded: Arc<Mutex<HashSet<ChannelId>>>,
}

impl TestServer {
    fn new(allow_forward: bool) -> Self {
        Self {
            allow_forward,
            forwarded: Arc::new(Mutex::new(HashSet::new())),
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

    /// Test kiểm tra phía client, nên server nhận mọi public key.
    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &russh::keys::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
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

/// Vault tạm kèm một identity dùng private key không passphrase — nên đường đi
/// auth không cần chạm keychain của máy chạy test.
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
            auth_kind: AuthKind::PrivateKey,
            username: None,
            private_key_path: Some(key_path.to_string_lossy().into_owned()),
            has_secret: false,
        })
        .unwrap();

    VaultFixture { dir, vault }
}

/// Vault tạm đã có sẵn host `h1` trỏ tới `port` (host key *chưa* được tin cậy).
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
        identity_id: Some("i1".into()),
        jump_host_id: jump.map(str::to_string),
        theme: None,
        color_tag: None,
        notes: None,
        sort: 0,
    }
}

/// Đọc chunk dữ liệu đầu tiên từ một channel, có timeout để test không treo.
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
    .expect("timeout khi chờ dữ liệu")
}
