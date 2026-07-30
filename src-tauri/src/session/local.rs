use std::io::{Read, Write};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use super::Outbound;
use crate::error::{AppError, AppResult};
use crate::events::{ClosedEvent, DataEvent, EV_CLOSED, EV_DATA};

const OUTBOUND_BUFFER: usize = 256;
const READ_CHUNK: usize = 32 * 1024;

/// Tab shell local. `portable-pty` là API blocking nên mỗi session dùng hai
/// thread thật thay vì task async: một đọc, một ghi + resize.
pub fn start(
    app: AppHandle,
    session_id: String,
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

    // Thread đọc: PTY → event.
    let reader_app = app.clone();
    let reader_id = session_id.clone();
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
                }
            }
        }
        let reason = match child.wait() {
            Ok(status) => format!("exit code {}", status.exit_code()),
            Err(e) => format!("pty lỗi: {e}"),
        };
        let _ = reader_app.emit(
            EV_CLOSED,
            ClosedEvent {
                session_id: reader_id,
                reason,
            },
        );
    });

    // Thread ghi: giữ cả writer và master để xử lý input lẫn resize.
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
