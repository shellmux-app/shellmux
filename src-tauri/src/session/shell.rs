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
pub async fn start(
    app: AppHandle,
    link: Arc<SshLink>,
    session_id: String,
    generation: u64,
    cols: u16,
    rows: u16,
) -> AppResult<mpsc::Sender<Outbound>> {
    let channel = link.open_session().await?;
    channel
        .request_pty(false, TERM, cols as u32, rows as u32, 0, 0, &[])
        .await?;
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

async fn pump(
    app: &AppHandle,
    session_id: &str,
    mut channel: Channel<Msg>,
    mut rx: mpsc::Receiver<Outbound>,
) -> String {
    let engine = base64::engine::general_purpose::STANDARD;

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
                Some(Outbound::Close) | None => {
                    let _ = channel.eof().await;
                    let _ = channel.close().await;
                    return "closed".into();
                }
            },
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { ref data }) => {
                    emit_data(app, session_id, &engine, data);
                }
                // The remote's stderr also flows into the same terminal.
                Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                    emit_data(app, session_id, &engine, data);
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

fn emit_data(
    app: &AppHandle,
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
