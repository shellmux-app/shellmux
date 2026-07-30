use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use russh::client;
use russh::keys::PublicKey;
use russh::ChannelOpenFailure;
use tokio::net::TcpStream;

use crate::pipe::splice;
use crate::vault::Vault;

/// The destination of a remote forward (-R): a port on the server → a service on our side.
#[derive(Debug, Clone)]
pub struct RemoteTarget {
    pub host: String,
    pub port: u16,
}

/// Lookup table of remote ports being forwarded. The handler must know this
/// table from the moment it connects, so it's an Arc shared with `SshLink`.
pub type ForwardRegistry = Arc<DashMap<u32, RemoteTarget>>;

/// The fingerprint the server just presented — used to build a contextual error for the UI.
pub type ObservedKey = Arc<Mutex<Option<(String, String)>>>;

pub struct ShellmuxHandler {
    vault: Arc<Vault>,
    host: String,
    port: u16,
    observed: ObservedKey,
    forwards: ForwardRegistry,
}

impl ShellmuxHandler {
    pub fn new(
        vault: Arc<Vault>,
        host: String,
        port: u16,
        observed: ObservedKey,
        forwards: ForwardRegistry,
    ) -> Self {
        Self {
            vault,
            host,
            port,
            observed,
            forwards,
        }
    }
}

impl client::Handler for ShellmuxHandler {
    type Error = russh::Error;

    /// Trust-on-first-use *with confirmation*: an unknown key returns
    /// `false` so russh cancels the handshake. The layer above reads
    /// `observed` and then asks the user. Never accept-any.
    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let algo = key.algorithm().to_string();
        let fingerprint = key.fingerprint(Default::default()).to_string();

        if let Ok(mut slot) = self.observed.lock() {
            *slot = Some((algo, fingerprint.clone()));
        }

        match self.vault.get_known_host(&self.host, self.port) {
            Ok(Some(known)) => Ok(known.fingerprint == fingerprint),
            Ok(None) => Ok(false),
            Err(e) => {
                log::error!("could not read known_hosts: {e}");
                Ok(false)
            }
        }
    }

    /// Server opens a reverse channel for remote forward (-R).
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = self.forwards.get(&connected_port).map(|t| t.clone());
        match target {
            Some(target) => {
                reply.accept().await;
                tokio::spawn(async move {
                    if let Err(e) = pipe_to_local(channel, target).await {
                        log::warn!("remote forward: {e}");
                    }
                });
            }
            None => {
                log::warn!("rejecting forwarded-tcpip for port {connected_port} (not registered)");
                reply
                    .reject(ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
            }
        }
        Ok(())
    }
}

/// Joins a forwarded-tcpip channel to a local socket.
async fn pipe_to_local(
    channel: russh::Channel<client::Msg>,
    target: RemoteTarget,
) -> Result<(), std::io::Error> {
    let socket = TcpStream::connect((target.host.as_str(), target.port)).await?;
    splice(channel, socket).await
}
