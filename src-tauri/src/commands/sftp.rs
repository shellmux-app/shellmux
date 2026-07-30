use tauri::State;

use crate::error::AppResult;
use crate::sftp::{self, RemoteEntry};
use crate::state::AppState;

/// SFTP bám vào connection của session SSH đang mở — không handshake lại.
async fn session_for(
    state: &State<'_, AppState>,
    session_id: &str,
) -> AppResult<std::sync::Arc<russh_sftp::client::SftpSession>> {
    let link = state.sessions.link(session_id)?;
    state.sftp.get_or_open(session_id, link).await
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<Vec<RemoteEntry>> {
    let sftp = session_for(&state, &session_id).await?;
    sftp::list(&sftp, &path).await
}

#[tauri::command]
pub async fn sftp_canonicalize(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<String> {
    let sftp = session_for(&state, &session_id).await?;
    sftp::canonicalize(&sftp, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<()> {
    let sftp = session_for(&state, &session_id).await?;
    sftp::make_dir(&sftp, &path).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let sftp = session_for(&state, &session_id).await?;
    sftp::rename(&sftp, &from, &to).await
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> AppResult<()> {
    let sftp = session_for(&state, &session_id).await?;
    sftp::remove(&sftp, &path, is_dir).await
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    session_id: String,
    remote: String,
    local: String,
) -> AppResult<u64> {
    let sftp = session_for(&state, &session_id).await?;
    sftp::download(&sftp, &remote, &local).await
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    session_id: String,
    local: String,
    remote: String,
) -> AppResult<u64> {
    let sftp = session_for(&state, &session_id).await?;
    sftp::upload(&sftp, &local, &remote).await
}
