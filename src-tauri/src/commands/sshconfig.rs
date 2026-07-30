use tauri::State;

use crate::error::{AppError, AppResult};
use crate::sshconfig::{default_config_path, import_into, ImportReport};
use crate::state::AppState;

/// Import `~/.ssh/config` vào vault. `path` để trống thì dùng đường dẫn mặc định.
///
/// Idempotent: id của host dẫn xuất từ alias nên chạy lại là cập nhật, không
/// tạo bản sao — nhưng cũng có nghĩa là sửa tay một host đã import rồi import
/// lại sẽ bị ghi đè.
#[tauri::command]
pub fn import_ssh_config(
    state: State<'_, AppState>,
    path: Option<String>,
) -> AppResult<ImportReport> {
    let target = match path {
        Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p),
        _ => default_config_path()
            .ok_or_else(|| AppError::Invalid("không xác định được thư mục HOME".into()))?,
    };

    let text = std::fs::read_to_string(&target).map_err(|e| {
        AppError::Io(format!("không đọc được {}: {e}", target.display()))
    })?;

    import_into(&state.vault, &text)
}

/// Đường dẫn mặc định, để UI hiện sẵn cho người dùng xác nhận.
#[tauri::command]
pub fn ssh_config_path() -> AppResult<Option<String>> {
    Ok(default_config_path().map(|p| p.display().to_string()))
}
