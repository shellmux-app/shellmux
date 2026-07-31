use std::sync::Arc;

use base64::Engine;
use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use super::Outbound;
use crate::error::AppResult;
use crate::events::{ClosedEvent, DataEvent, EV_CLOSED, EV_DATA};
use crate::ssh::SshLink;

const TERM: &str = "xterm-256color";
const OUTBOUND_BUFFER: usize = 256;

/// Opens a shell channel on an already-authenticated connection and spawns a
/// task that pumps data both ways. Returns a sender so the `session_write`
/// command can push input into it.
pub async fn start<R: tauri::Runtime>(
    app: AppHandle<R>,
    link: Arc<SshLink>,
    session_id: String,
    generation: u64,
    cols: u16,
    rows: u16,
    agent_forward: bool,
) -> AppResult<mpsc::Sender<Outbound>> {
    let channel = link.open_session().await?;
    channel
        .request_pty(false, TERM, cols as u32, rows as u32, 0, 0, &[])
        .await?;
    if agent_forward {
        // Best-effort: a server that doesn't support forwarding just never
        // opens the auth-agent channel back to us, nothing else changes.
        // Marking the link is what actually permits the handler to accept
        // that channel — the host's setting alone is not enough, since a
        // server can open one unprompted. See `ShellmuxHandler`.
        link.mark_agent_forward_requested();
        let _ = channel.agent_forward(true).await;
    }
    channel.request_shell(true).await?;

    let (tx, rx) = mpsc::channel::<Outbound>(OUTBOUND_BUFFER);

    tokio::spawn(async move {
        let reason = pump(&app, &session_id, channel, rx).await;
        let _ = app.emit(
            EV_CLOSED,
            ClosedEvent {
                session_id,
                reason,
                generation,
            },
        );
        // Hold onto the link until the end of the session's lifetime: dropping it early closes the connection.
        drop(link);
    });

    Ok(tx)
}

async fn pump<R: tauri::Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    mut channel: Channel<Msg>,
    mut rx: mpsc::Receiver<Outbound>,
) -> String {
    let engine = base64::engine::general_purpose::STANDARD;
    let mut log_file: Option<tokio::fs::File> = None;

    loop {
        tokio::select! {
            outbound = rx.recv() => match outbound {
                Some(Outbound::Data(bytes)) => {
                    if channel.data(&bytes[..]).await.is_err() {
                        return "write failed".into();
                    }
                }
                Some(Outbound::Resize { cols, rows }) => {
                    let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                }
                Some(Outbound::StartLogging(path)) => {
                    log_file = open_log(session_id, &path).await;
                }
                Some(Outbound::StopLogging) => {
                    close_log(&mut log_file).await;
                }
                Some(Outbound::Close) | None => {
                    let _ = channel.eof().await;
                    let _ = channel.close().await;
                    return "closed".into();
                }
            },
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { ref data }) => {
                    emit_and_log(app, session_id, &engine, data, &mut log_file).await;
                }
                // The remote's stderr also flows into the same terminal.
                Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                    emit_and_log(app, session_id, &engine, data, &mut log_file).await;
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    return format!("exit status {exit_status}");
                }
                Some(ChannelMsg::ExitSignal { ref signal_name, .. }) => {
                    return format!("exit signal {signal_name:?}");
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                    return "eof".into();
                }
                Some(_) => {}
            },
        }
    }
}

fn emit_data<R: tauri::Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    engine: &base64::engine::general_purpose::GeneralPurpose,
    data: &[u8],
) {
    let _ = app.emit(
        EV_DATA,
        DataEvent {
            session_id: session_id.to_string(),
            data: engine.encode(data),
        },
    );
}

/// Same as `emit_data`, but also appends the raw bytes to the session log when
/// one is open. Kept separate from `emit_data` since most callers (SFTP, local
/// PTY reads elsewhere) have no log to write to.
async fn emit_and_log<R: tauri::Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    engine: &base64::engine::general_purpose::GeneralPurpose,
    data: &[u8],
    log_file: &mut Option<tokio::fs::File>,
) {
    emit_data(app, session_id, engine, data);
    if let Some(file) = log_file {
        use tokio::io::AsyncWriteExt;
        if file.write_all(data).await.is_err() {
            log::warn!("session {session_id}: log write failed, stopping logging");
            *log_file = None;
        }
    }
}

async fn open_log(session_id: &str, path: &str) -> Option<tokio::fs::File> {
    match tokio::fs::File::create(path).await {
        Ok(file) => Some(file),
        Err(e) => {
            log::warn!("session {session_id}: could not open log file {path}: {e}");
            None
        }
    }
}

async fn close_log(log_file: &mut Option<tokio::fs::File>) {
    if let Some(mut file) = log_file.take() {
        use tokio::io::AsyncWriteExt;
        let _ = file.flush().await;
    }
}
