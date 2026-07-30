use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use russh::client;
use russh::keys::PublicKey;
use russh::ChannelOpenFailure;
use tokio::net::TcpStream;

use crate::pipe::splice;
use crate::vault::Vault;

/// Đích đến của remote forward (-R): cổng trên server → dịch vụ phía máy mình.
#[derive(Debug, Clone)]
pub struct RemoteTarget {
    pub host: String,
    pub port: u16,
}

/// Bảng tra cổng remote đang forward. Handler phải biết bảng này ngay từ lúc
/// connect, nên nó là một Arc dùng chung với `SshLink`.
pub type ForwardRegistry = Arc<DashMap<u32, RemoteTarget>>;

/// Fingerprint server vừa trình ra — dùng để dựng lỗi có ngữ cảnh cho UI.
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

    /// Trust-on-first-use *có xác nhận*: key lạ trả `false` để russh huỷ
    /// handshake. Lớp trên đọc `observed` rồi hỏi người dùng. Không bao giờ
    /// accept-any.
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
                log::error!("không đọc được known_hosts: {e}");
                Ok(false)
            }
        }
    }

    /// Server mở channel ngược lại cho remote forward (-R).
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
                log::warn!("từ chối forwarded-tcpip cho cổng {connected_port} (không đăng ký)");
                reply
                    .reject(ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
            }
        }
        Ok(())
    }
}

/// Nối một channel forwarded-tcpip vào socket local.
async fn pipe_to_local(
    channel: russh::Channel<client::Msg>,
    target: RemoteTarget,
) -> Result<(), std::io::Error> {
    let socket = TcpStream::connect((target.host.as_str(), target.port)).await?;
    splice(channel, socket).await
}
