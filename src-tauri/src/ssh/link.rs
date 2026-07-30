use russh::client::{Handle, Msg};
use russh::{Channel, Disconnect};
use tokio::sync::Mutex;

use super::handler::{ForwardRegistry, RemoteTarget, ShellmuxHandler};
use crate::error::AppResult;

/// Một SSH connection cùng toàn bộ chuỗi jump host phía trên nó.
///
/// `parents` phải được giữ sống: drop một `Handle` là đóng connection đó, kéo
/// theo channel direct-tcpip mà connection con đang chạy trên đó.
///
/// Handle nằm trong `Mutex` vì `russh` chỉ cho một luồng chờ reply tại một
/// thời điểm. Chi phí là serialize lúc *mở* channel, còn channel đã mở thì
/// hoạt động độc lập — nên terminal, SFTP và tunnel không chặn nhau.
pub struct SshLink {
    pub host_id: String,
    handle: Mutex<Handle<ShellmuxHandler>>,
    _parents: Mutex<Vec<Handle<ShellmuxHandler>>>,
    forwards: ForwardRegistry,
}

impl SshLink {
    pub fn new(
        host_id: String,
        handle: Handle<ShellmuxHandler>,
        parents: Vec<Handle<ShellmuxHandler>>,
        forwards: ForwardRegistry,
    ) -> Self {
        Self {
            host_id,
            handle: Mutex::new(handle),
            _parents: Mutex::new(parents),
            forwards,
        }
    }

    pub async fn open_session(&self) -> AppResult<Channel<Msg>> {
        let channel = self.handle.lock().await.channel_open_session().await?;
        Ok(channel)
    }

    pub async fn open_direct_tcpip(
        &self,
        target_host: &str,
        target_port: u16,
        origin_host: &str,
        origin_port: u16,
    ) -> AppResult<Channel<Msg>> {
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_direct_tcpip(
                target_host.to_string(),
                target_port as u32,
                origin_host.to_string(),
                origin_port as u32,
            )
            .await?;
        Ok(channel)
    }

    /// Đăng ký đích local *trước* khi xin server forward, để channel ngược
    /// đầu tiên không rơi vào khoảng trống chưa có registry.
    pub async fn request_remote_forward(
        &self,
        bind_addr: &str,
        bind_port: u16,
        target: RemoteTarget,
    ) -> AppResult<u16> {
        self.forwards.insert(bind_port as u32, target.clone());

        let granted = self
            .handle
            .lock()
            .await
            .tcpip_forward(bind_addr.to_string(), bind_port as u32)
            .await;

        match granted {
            Ok(port) => {
                let effective = if bind_port == 0 { port as u16 } else { bind_port };
                if effective as u32 != bind_port as u32 {
                    self.forwards.remove(&(bind_port as u32));
                    self.forwards.insert(effective as u32, target);
                }
                Ok(effective)
            }
            Err(e) => {
                self.forwards.remove(&(bind_port as u32));
                Err(e.into())
            }
        }
    }

    pub async fn cancel_remote_forward(&self, bind_addr: &str, bind_port: u16) -> AppResult<()> {
        self.forwards.remove(&(bind_port as u32));
        self.handle
            .lock()
            .await
            .cancel_tcpip_forward(bind_addr.to_string(), bind_port as u32)
            .await?;
        Ok(())
    }

    pub async fn disconnect(&self) {
        let handle = self.handle.lock().await;
        let _ = handle
            .disconnect(Disconnect::ByApplication, "shellmux: closed by user", "en")
            .await;
    }
}
