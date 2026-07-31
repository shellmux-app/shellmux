use std::sync::Arc;

use base64::Engine;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::events::{TunnelEvent, EV_TUNNEL};
use crate::session::{local, shell, Outbound, SessionInfo, SessionKind};
use crate::ssh::{self, SshLink};
use crate::state::AppState;

fn decode(data: &str) -> AppResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| AppError::Invalid(format!("invalid base64 payload: {e}")))
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
        app.clone(),
        link.clone(),
        session_id.clone(),
        0,
        cols.max(2),
        rows.max(2),
        host.agent_forward,
    )
    .await?;

    let info = SessionInfo {
        id: session_id.clone(),
        kind: SessionKind::Ssh,
        host_id: Some(host_id.clone()),
        label: host.label,
    };
    state.sessions.insert(info.clone(), tx, Some(link.clone()));

    start_auto_tunnels(&app, &state, &host_id, &session_id, &link).await;

    Ok(info)
}

/// Starts every tunnel configured with `autoStart` for this host, now that its
/// session is up. Best-effort and independent per tunnel: one failing to bind
/// (e.g. the port is already taken) must not affect the others, and must not
/// fail the connection that just succeeded — it's reported through the same
/// `tunnel:state` event the manual Start button uses, so the UI surfaces it
/// the same way instead of failing silently.
async fn start_auto_tunnels(
    app: &AppHandle,
    state: &State<'_, AppState>,
    host_id: &str,
    session_id: &str,
    link: &Arc<SshLink>,
) {
    let tunnels = match state.vault.list_tunnels() {
        Ok(t) => t,
        Err(e) => {
            log::warn!("could not load tunnels to auto-start for host {host_id}: {e}");
            return;
        }
    };

    for spec in tunnels
        .into_iter()
        .filter(|t| t.host_id == host_id && t.auto_start)
    {
        let tunnel_id = spec.id.clone();
        if let Err(e) = state
            .tunnels
            .start(app.clone(), session_id, link.clone(), &spec)
            .await
        {
            log::warn!("tunnel {tunnel_id} did not auto-start: {e}");
            let _ = app.emit(
                EV_TUNNEL,
                TunnelEvent {
                    tunnel_id,
                    session_id: session_id.to_string(),
                    active: false,
                    message: Some(e.to_string()),
                },
            );
        }
    }
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
        0,
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
    // Clean up this *session's* tunnels and SFTP first, otherwise their channels
    // are left hanging on a connection that's already closed.
    state.tunnels.stop_for_session(&app, &session_id).await;
    state.sftp.close(&session_id).await;
    state.sessions.close(&session_id).await
}

#[tauri::command]
pub fn session_list(state: State<'_, AppState>) -> AppResult<Vec<SessionInfo>> {
    Ok(state.sessions.list())
}

/// Starts writing everything the terminal displays to `path` (truncating it
/// first). The path is chosen by the frontend, normally via a native save
/// dialog — nothing here picks a location on the user's behalf.
#[tauri::command]
pub async fn session_start_logging(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<()> {
    state
        .sessions
        .send(&session_id, Outbound::StartLogging(path))
        .await
}

#[tauri::command]
pub async fn session_stop_logging(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<()> {
    state.sessions.send(&session_id, Outbound::StopLogging).await
}

/// Reconnects a dropped session while **keeping the same session id**, so the
/// UI-side pane and scrollback don't get rebuilt. Idea borrowed from Tabby's
/// `reconnect()` (`ConnectableTerminalTabComponent`).
#[tauri::command]
pub async fn session_reconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<SessionInfo> {
    let info = state.sessions.info(&session_id)?;

    // Tunnels and SFTP latch onto the old connection — must clean them up before replacing it.
    state.tunnels.stop_for_session(&app, &session_id).await;
    state.sftp.close(&session_id).await;

    let generation = state.sessions.detach(&session_id).await?;

    match info.kind {
        SessionKind::Ssh => {
            let host_id = info
                .host_id
                .clone()
                .ok_or_else(|| AppError::Invalid("SSH session is missing a host".into()))?;
            let link = ssh::connect_host(state.vault.clone(), &host_id).await?;
            let agent_forward = state.vault.get_host(&host_id)?.agent_forward;
            let tx = shell::start(
                app.clone(),
                link.clone(),
                session_id.clone(),
                generation,
                cols.max(2),
                rows.max(2),
                agent_forward,
            )
            .await?;
            state
                .sessions
                .reattach(&session_id, tx, Some(link.clone()), generation)?;

            // The tunnels that were running before are gone with the old
            // connection (stopped above, before `detach`) — bring back the
            // ones the user marked as autoStart, same as on first connect.
            start_auto_tunnels(&app, &state, &host_id, &session_id, &link).await;
        }
        SessionKind::Local => {
            let tx = local::start(
                app,
                session_id.clone(),
                generation,
                None,
                None,
                cols.max(2),
                rows.max(2),
            )?;
            state.sessions.reattach(&session_id, tx, None, generation)?;
        }
    }

    Ok(info)
}

/// Sends a snippet to multiple sessions at once (broadcast).
/// The snippet goes straight into the PTY stream, not through this machine's
/// shell — so there's no place for interpolation or injection.
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
            Err(e) => log::warn!("snippet to session {id} failed: {e}"),
        }
    }
    Ok(sent)
}
