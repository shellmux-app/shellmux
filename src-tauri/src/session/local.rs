use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use super::Outbound;
use crate::error::{AppError, AppResult};
use crate::events::{ClosedEvent, DataEvent, EV_CLOSED, EV_DATA};

const OUTBOUND_BUFFER: usize = 256;
const READ_CHUNK: usize = 32 * 1024;

/// Local shell tab. `portable-pty` is a blocking API, so each session uses two
/// real threads instead of async tasks: one for reading, one for writing + resize.
pub fn start<R: tauri::Runtime>(
    app: AppHandle<R>,
    session_id: String,
    generation: u64,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> AppResult<mpsc::Sender<Outbound>> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Pty(e.to_string()))?;

    let program = shell.unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(program);
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Pty(e.to_string()))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::Pty(e.to_string()))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Pty(e.to_string()))?;
    let master = pair.master;

    let (tx, mut rx) = mpsc::channel::<Outbound>(OUTBOUND_BUFFER);

    // Shared with the writer thread, which owns start/stop; the reader thread
    // only ever reads it, once per chunk, to decide whether to also append to it.
    let log_file: Arc<Mutex<Option<std::fs::File>>> = Arc::new(Mutex::new(None));

    // Reader thread: PTY → event.
    let reader_app = app.clone();
    let reader_id = session_id.clone();
    let reader_log = log_file.clone();
    std::thread::spawn(move || {
        let engine = base64::engine::general_purpose::STANDARD;
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = reader_app.emit(
                        EV_DATA,
                        DataEvent {
                            session_id: reader_id.clone(),
                            data: engine.encode(&buf[..n]),
                        },
                    );
                    if let Ok(mut guard) = reader_log.lock() {
                        if let Some(file) = guard.as_mut() {
                            if file.write_all(&buf[..n]).is_err() {
                                log::warn!("session {reader_id}: log write failed, stopping logging");
                                *guard = None;
                            }
                        }
                    }
                }
            }
        }
        let reason = match child.wait() {
            Ok(status) => format!("exit code {}", status.exit_code()),
            Err(e) => format!("pty error: {e}"),
        };
        let _ = reader_app.emit(
            EV_CLOSED,
            ClosedEvent {
                session_id: reader_id,
                reason,
                generation,
            },
        );
    });

    // Writer thread: holds both the writer and master to handle input and resize.
    let writer_id = session_id.clone();
    std::thread::spawn(move || {
        while let Some(outbound) = rx.blocking_recv() {
            match outbound {
                Outbound::Data(bytes) => {
                    if writer.write_all(&bytes).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
                Outbound::Resize { cols, rows } => {
                    let _ = master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                Outbound::StartLogging(path) => match std::fs::File::create(&path) {
                    Ok(file) => *log_file.lock().unwrap() = Some(file),
                    Err(e) => log::warn!("session {writer_id}: could not open log file {path}: {e}"),
                },
                Outbound::StopLogging => {
                    if let Some(mut file) = log_file.lock().unwrap().take() {
                        let _ = file.flush();
                    }
                }
                Outbound::Close => break,
            }
        }
    });

    Ok(tx)
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}
