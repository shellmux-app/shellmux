use std::sync::Arc;

use crate::session::SessionManager;
use crate::sftp::SftpRegistry;
use crate::tunnel::TunnelRegistry;
use crate::vault::Vault;

/// State toàn app, đưa vào Tauri qua `manage()`.
pub struct AppState {
    pub vault: Arc<Vault>,
    pub sessions: Arc<SessionManager>,
    pub sftp: Arc<SftpRegistry>,
    pub tunnels: Arc<TunnelRegistry>,
}

impl AppState {
    pub fn new(vault: Vault) -> Self {
        Self {
            vault: Arc::new(vault),
            sessions: Arc::new(SessionManager::new()),
            sftp: Arc::new(SftpRegistry::new()),
            tunnels: Arc::new(TunnelRegistry::new()),
        }
    }
}
