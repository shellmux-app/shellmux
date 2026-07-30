use base64::Engine;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::session::{local, shell, Outbound, SessionInfo, SessionKind};
use crate::ssh;
use crate::state::AppState;

fn decode(data: &str) -> AppResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| AppError::Invalid(format!("payload base64 không hợp lệ: {e}")))
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<SessionInfo> {
    let host = state.vault.get_host(&host_id)?;
    let link = ssh::connect_host(state.vault.clone(), &host_id).await?;

    let session_id = Uuid::new_v4().to_string();
    let tx = shell::start(
        app,
        link.clone(),
        session_id.clone(),
        cols.max(2),
        rows.max(2),
    )
    .await?;

    let info = SessionInfo {
        id: session_id,
        kind: SessionKind::Ssh,
        host_id: Some(host_id),
        label: host.label,
    };
    state.sessions.insert(info.clone(), tx, Some(link));
    Ok(info)
}

#[tauri::command]
pub fn local_open(
    app: AppHandle,
    state: State<'_, AppState>,
    shell_path: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> AppResult<SessionInfo> {
    let session_id = Uuid::new_v4().to_string();
    let tx = local::start(
        app,
        session_id.clone(),
        shell_path,
        cwd,
        cols.max(2),
        rows.max(2),
    )?;

    let info = SessionInfo {
        id: session_id,
        kind: SessionKind::Local,
        host_id: None,
        label: "local".into(),
    };
    state.sessions.insert(info.clone(), tx, None);
    Ok(info)
}

#[tauri::command]
pub async fn session_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    let bytes = decode(&data)?;
    state
        .sessions
        .send(&session_id, Outbound::Data(bytes))
        .await
}

#[tauri::command]
pub async fn session_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    state
        .sessions
        .send(
            &session_id,
            Outbound::Resize {
                cols: cols.max(2),
                rows: rows.max(2),
            },
        )
        .await
}

#[tauri::command]
pub async fn session_close(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<()> {
    // Dọn tunnel và SFTP của *session này* trước, nếu không channel treo lại
    // trên một connection đã đóng.
    state.tunnels.stop_for_session(&app, &session_id).await;
    state.sftp.close(&session_id).await;
    state.sessions.close(&session_id).await
}

#[tauri::command]
pub fn session_list(state: State<'_, AppState>) -> AppResult<Vec<SessionInfo>> {
    Ok(state.sessions.list())
}

/// Gửi một snippet tới nhiều session cùng lúc (broadcast).
/// Snippet đi thẳng vào PTY stream, không qua shell của máy này — nên không có
/// chỗ nào để nội suy hay inject.
#[tauri::command]
pub async fn snippet_send(
    state: State<'_, AppState>,
    session_ids: Vec<String>,
    snippet_id: String,
) -> AppResult<usize> {
    let snippet = state
        .vault
        .list_snippets()?
        .into_iter()
        .find(|s| s.id == snippet_id)
        .ok_or_else(|| AppError::NotFound {
            kind: "snippet",
            id: snippet_id.clone(),
        })?;

    let payload = if snippet.send_newline {
        format!("{}\n", snippet.body.trim_end())
    } else {
        snippet.body.clone()
    };

    let mut sent = 0usize;
    for id in session_ids {
        match state
            .sessions
            .send(&id, Outbound::Data(payload.clone().into_bytes()))
            .await
        {
            Ok(()) => sent += 1,
            Err(e) => log::warn!("snippet tới session {id} thất bại: {e}"),
        }
    }
    Ok(sent)
}
