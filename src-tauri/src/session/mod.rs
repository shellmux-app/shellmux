pub mod local;
pub mod shell;

use std::sync::Arc;

use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};
use crate::ssh::SshLink;

/// Lệnh gửi xuống một session đang chạy. Dùng chung cho SSH và local PTY để
/// tầng command không phải phân biệt hai loại.
#[derive(Debug)]
pub enum Outbound {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    Ssh,
    Local,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub kind: SessionKind,
    pub host_id: Option<String>,
    pub label: String,
}

struct Entry {
    info: SessionInfo,
    tx: mpsc::Sender<Outbound>,
    link: Option<Arc<SshLink>>,
}

/// Sổ ghi các session đang mở. Một session SSH = một connection; SFTP và
/// tunnel bám vào `link` của session đó thay vì mở connection mới.
#[derive(Default)]
pub struct SessionManager {
    entries: DashMap<String, Entry>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(
        &self,
        info: SessionInfo,
        tx: mpsc::Sender<Outbound>,
        link: Option<Arc<SshLink>>,
    ) {
        self.entries
            .insert(info.id.clone(), Entry { info, tx, link });
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.entries.iter().map(|e| e.info.clone()).collect()
    }

    pub fn link(&self, session_id: &str) -> AppResult<Arc<SshLink>> {
        let entry = self
            .entries
            .get(session_id)
            .ok_or_else(|| AppError::NoSession(session_id.to_string()))?;
        entry
            .link
            .clone()
            .ok_or_else(|| AppError::Invalid("session này không phải SSH".into()))
    }

    pub async fn send(&self, session_id: &str, outbound: Outbound) -> AppResult<()> {
        let tx = {
            let entry = self
                .entries
                .get(session_id)
                .ok_or_else(|| AppError::NoSession(session_id.to_string()))?;
            entry.tx.clone()
        };
        tx.send(outbound)
            .await
            .map_err(|_| AppError::NoSession(session_id.to_string()))
    }

    /// Đóng session: gửi Close rồi bỏ khỏi sổ. Drop `link` ở đây là thứ thực
    /// sự ngắt TCP, kể cả toàn bộ chuỗi jump phía trên.
    pub async fn close(&self, session_id: &str) -> AppResult<()> {
        let removed = self.entries.remove(session_id);
        let Some((_, entry)) = removed else {
            return Err(AppError::NoSession(session_id.to_string()));
        };
        let _ = entry.tx.send(Outbound::Close).await;
        if let Some(link) = entry.link {
            link.disconnect().await;
        }
        Ok(())
    }

    pub fn close_all_sync(&self) {
        self.entries.clear();
    }
}
