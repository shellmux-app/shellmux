pub mod local;
pub mod shell;

use std::sync::Arc;

use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};
use crate::ssh::SshLink;

/// Commands sent down to a running session. Shared between SSH and local PTY so
/// the command layer doesn't have to distinguish between the two kinds.
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
    /// Incremented on every reconnect. If the old pump emits a late closed event
    /// carrying the old generation, the frontend knows to ignore it.
    generation: u64,
}

/// Registry of open sessions. One SSH session = one connection; SFTP and
/// tunnels latch onto that session's `link` instead of opening a new connection.
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
        self.entries.insert(
            info.id.clone(),
            Entry {
                info,
                tx,
                link,
                generation: 0,
            },
        );
    }

    pub fn info(&self, session_id: &str) -> AppResult<SessionInfo> {
        self.entries
            .get(session_id)
            .map(|e| e.info.clone())
            .ok_or_else(|| AppError::NoSession(session_id.to_string()))
    }

    pub fn generation(&self, session_id: &str) -> AppResult<u64> {
        self.entries
            .get(session_id)
            .map(|e| e.generation)
            .ok_or_else(|| AppError::NoSession(session_id.to_string()))
    }

    /// Detaches the old transport but **keeps the same session id**, so the
    /// UI-side terminal doesn't need to reinitialize and doesn't lose scrollback.
    pub async fn detach(&self, session_id: &str) -> AppResult<u64> {
        let (tx, link, generation) = {
            let entry = self
                .entries
                .get(session_id)
                .ok_or_else(|| AppError::NoSession(session_id.to_string()))?;
            (entry.tx.clone(), entry.link.clone(), entry.generation)
        };

        let _ = tx.send(Outbound::Close).await;
        if let Some(link) = link {
            link.disconnect().await;
        }
        Ok(generation + 1)
    }

    pub fn reattach(
        &self,
        session_id: &str,
        tx: mpsc::Sender<Outbound>,
        link: Option<Arc<SshLink>>,
        generation: u64,
    ) -> AppResult<()> {
        let mut entry = self
            .entries
            .get_mut(session_id)
            .ok_or_else(|| AppError::NoSession(session_id.to_string()))?;
        entry.tx = tx;
        entry.link = link;
        entry.generation = generation;
        Ok(())
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
            .ok_or_else(|| AppError::Invalid("this session isn't SSH".into()))
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

    /// Closes a session: sends Close, then removes it from the registry. Dropping
    /// `link` here is what actually cuts the TCP connection, including the entire
    /// jump chain above it.
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
