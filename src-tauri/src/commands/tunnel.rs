use tauri::{AppHandle, State};

use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub async fn tunnel_start(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    tunnel_id: String,
) -> AppResult<u16> {
    let spec = state.vault.get_tunnel(&tunnel_id)?;
    let link = state.sessions.link(&session_id)?;
    state
        .tunnels
        .start(app, &session_id, link, &spec)
        .await
}

#[tauri::command]
pub async fn tunnel_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    tunnel_id: String,
) -> AppResult<()> {
    state.tunnels.stop(&app, &session_id, &tunnel_id).await
}

#[tauri::command]
pub fn tunnel_active(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.tunnels.active_ids())
}
