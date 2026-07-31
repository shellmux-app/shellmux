use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};

use crate::error::AppResult;
use crate::events::{TransferEvent, EV_TRANSFER};
use crate::sftp::{self, RemoteEntry};
use crate::state::AppState;

/// Fast enough to look live, slow enough that a multi-GB transfer doesn't
/// flood the webview. See `progress_emitter`.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// SFTP latches onto the open SSH session's connection — no re-handshake.
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

/// Emits `sftp:transfer` after every chunk, so the frontend's transfer queue
/// never has to poll.
///
/// Deliberately carries *progress only*, never a terminal "done"/"failed"
/// state: the command's own return value already says how it ended, and
/// having two independent sources for that raced — a settled promise and a
/// pending event could each be waiting on the other. The last progress
/// event doubles as the resume offset when a transfer fails, since it's the
/// furthest point actually reached.
fn progress_emitter(app: AppHandle, transfer_id: String) -> impl FnMut(u64, Option<u64>) {
    let mut last_emit: Option<Instant> = None;

    move |bytes_done, bytes_total| {
        // Throttled: the callback fires once per 64 KiB chunk, which is
        // ~16k events per GiB. Each one JSON-serializes, crosses IPC, and
        // re-renders the transfer list — enough to saturate the webview on a
        // large file. A progress bar only needs to move a few times a second.
        // Dropping the final tick is harmless: the command's return value is
        // what sets the finished byte count, not this event.
        let now = Instant::now();
        let due = last_emit.is_none_or(|last| now.duration_since(last) >= PROGRESS_INTERVAL);
        if !due {
            return;
        }
        last_emit = Some(now);

        let _ = app.emit(
            EV_TRANSFER,
            TransferEvent {
                transfer_id: transfer_id.clone(),
                bytes_done,
                bytes_total,
            },
        );
    }
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote: String,
    local: String,
    transfer_id: String,
    resume: bool,
) -> AppResult<u64> {
    let sftp = session_for(&state, &session_id).await?;
    sftp::download_resumable(
        &sftp,
        &remote,
        &local,
        resume,
        progress_emitter(app, transfer_id),
    )
    .await
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local: String,
    remote: String,
    transfer_id: String,
    resume: bool,
) -> AppResult<u64> {
    let sftp = session_for(&state, &session_id).await?;
    sftp::upload_resumable(
        &sftp,
        &local,
        &remote,
        resume,
        progress_emitter(app, transfer_id),
    )
    .await
}
