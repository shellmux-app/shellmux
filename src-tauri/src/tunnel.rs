use std::sync::Arc;

use dashmap::DashMap;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult};
use crate::events::{TunnelEvent, EV_TUNNEL};
use crate::pipe::splice;
use crate::socks;
use crate::ssh::{RemoteTarget, SshLink};
use crate::vault::{TunnelKind, TunnelSpec};

enum Transport {
    /// -L: listener local, mỗi kết nối mở một channel direct-tcpip.
    Local { task: JoinHandle<()> },
    /// -R: server nghe hộ, channel đi ngược về qua handler.
    Remote {
        link: Arc<SshLink>,
        bind_addr: String,
        bind_port: u16,
    },
}

struct Running {
    /// Session sở hữu tunnel. Đóng một session chỉ được dừng tunnel của chính
    /// nó, không được đụng tới tunnel của session khác.
    session_id: String,
    transport: Transport,
}

#[derive(Default)]
pub struct TunnelRegistry {
    running: DashMap<String, Running>,
}

impl TunnelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_active(&self, tunnel_id: &str) -> bool {
        self.running.contains_key(tunnel_id)
    }

    pub fn active_ids(&self) -> Vec<String> {
        self.running.iter().map(|e| e.key().clone()).collect()
    }

    pub fn ids_for_session(&self, session_id: &str) -> Vec<String> {
        self.running
            .iter()
            .filter(|e| e.value().session_id == session_id)
            .map(|e| e.key().clone())
            .collect()
    }

    /// Trả về cổng thật đang dùng — với `bind_port = 0` thì server/OS chọn hộ.
    pub async fn start(
        &self,
        app: AppHandle,
        session_id: &str,
        link: Arc<SshLink>,
        spec: &TunnelSpec,
    ) -> AppResult<u16> {
        if self.running.contains_key(&spec.id) {
            return Err(AppError::Tunnel("tunnel này đang chạy".into()));
        }

        let port = match spec.kind {
            // Local và Dynamic dùng chung một listener; khác nhau ở chỗ đích
            // đến là cố định hay do từng kết nối SOCKS tự khai.
            TunnelKind::Local | TunnelKind::Dynamic => {
                self.start_listener(app.clone(), session_id, link, spec)
                    .await?
            }
            TunnelKind::Remote => {
                let target = RemoteTarget {
                    host: spec.target_host.clone(),
                    port: spec.target_port,
                };
                let port = link
                    .request_remote_forward(&spec.bind_addr, spec.bind_port, target)
                    .await?;
                self.running.insert(
                    spec.id.clone(),
                    Running {
                        session_id: session_id.to_string(),
                        transport: Transport::Remote {
                            link,
                            bind_addr: spec.bind_addr.clone(),
                            bind_port: port,
                        },
                    },
                );
                port
            }
        };

        emit_state(&app, &spec.id, session_id, true, None);
        Ok(port)
    }

    async fn start_listener(
        &self,
        app: AppHandle,
        session_id: &str,
        link: Arc<SshLink>,
        spec: &TunnelSpec,
    ) -> AppResult<u16> {
        let dynamic = spec.kind == TunnelKind::Dynamic;
        let listener = TcpListener::bind((spec.bind_addr.as_str(), spec.bind_port))
            .await
            .map_err(|e| AppError::Tunnel(format!("bind {}:{} — {e}", spec.bind_addr, spec.bind_port)))?;
        let port = listener
            .local_addr()
            .map(|a| a.port())
            .unwrap_or(spec.bind_port);

        let target_host = spec.target_host.clone();
        let target_port = spec.target_port;
        let tunnel_id = spec.id.clone();
        let owner = session_id.to_string();

        let task = tokio::spawn(async move {
            loop {
                let (socket, origin) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(e) => {
                        emit_state(&app, &tunnel_id, &owner, false, Some(e.to_string()));
                        return;
                    }
                };

                let link = link.clone();
                let host = target_host.clone();
                let id = tunnel_id.clone();
                tokio::spawn(async move {
                    let mut socket = socket;

                    // Dynamic: đích lấy từ bắt tay SOCKS5 của chính kết nối này.
                    let (host, port) = if dynamic {
                        match socks::accept_connect(&mut socket).await {
                            Ok(target) => (target.host, target.port),
                            Err(e) => {
                                log::warn!("tunnel {id}: SOCKS handshake lỗi — {e}");
                                return;
                            }
                        }
                    } else {
                        (host, target_port)
                    };

                    let channel = match link
                        .open_direct_tcpip(&host, port, &origin.ip().to_string(), origin.port())
                        .await
                    {
                        Ok(channel) => channel,
                        Err(e) => {
                            log::warn!("tunnel {id}: mở channel thất bại — {e}");
                            // Chỉ báo OK cho client SOCKS *sau khi* channel mở
                            // được, nếu không client tưởng đã kết nối xong.
                            if dynamic {
                                let _ = socks::reply_failure(&mut socket).await;
                            }
                            return;
                        }
                    };

                    if dynamic {
                        if let Err(e) = socks::reply_success(&mut socket).await {
                            log::warn!("tunnel {id}: không trả lời được SOCKS — {e}");
                            return;
                        }
                    }

                    if let Err(e) = splice(channel, socket).await {
                        log::debug!("tunnel {id}: kết thúc — {e}");
                    }
                });
            }
        });

        self.running.insert(
            spec.id.clone(),
            Running {
                session_id: session_id.to_string(),
                transport: Transport::Local { task },
            },
        );
        Ok(port)
    }

    pub async fn stop(&self, app: &AppHandle, session_id: &str, tunnel_id: &str) -> AppResult<()> {
        let Some((_, running)) = self.running.remove(tunnel_id) else {
            return Err(AppError::Tunnel("tunnel không chạy".into()));
        };

        match running.transport {
            Transport::Local { task } => task.abort(),
            Transport::Remote {
                link,
                bind_addr,
                bind_port,
            } => {
                link.cancel_remote_forward(&bind_addr, bind_port).await?;
            }
        }

        emit_state(app, tunnel_id, session_id, false, None);
        Ok(())
    }

    /// Dọn mọi tunnel thuộc một session khi session đó đóng — và chỉ của
    /// session đó.
    pub async fn stop_for_session(&self, app: &AppHandle, session_id: &str) {
        for id in self.ids_for_session(session_id) {
            let _ = self.stop(app, session_id, &id).await;
        }
    }
}

fn emit_state(
    app: &AppHandle,
    tunnel_id: &str,
    session_id: &str,
    active: bool,
    message: Option<String>,
) {
    let _ = app.emit(
        EV_TUNNEL,
        TunnelEvent {
            tunnel_id: tunnel_id.to_string(),
            session_id: session_id.to_string(),
            active,
            message,
        },
    );
}
