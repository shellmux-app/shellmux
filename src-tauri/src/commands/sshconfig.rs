use tauri::State;

use crate::error::{AppError, AppResult};
use crate::sshconfig::{default_config_path, import_into, ImportReport};
use crate::state::AppState;

/// Imports `~/.ssh/config` into the vault. If `path` is empty, the default path is used.
///
/// Idempotent: a host's id is derived from its alias, so running it again
/// updates instead of duplicating — but that also means manually editing an
/// already-imported host and then re-importing will overwrite those edits.
#[tauri::command]
pub fn import_ssh_config(
    state: State<'_, AppState>,
    path: Option<String>,
) -> AppResult<ImportReport> {
    let target = match path {
        Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p),
        _ => default_config_path()
            .ok_or_else(|| AppError::Invalid("could not determine the HOME directory".into()))?,
    };

    let text = std::fs::read_to_string(&target).map_err(|e| {
        AppError::Io(format!("could not read {}: {e}", target.display()))
    })?;

    import_into(&state.vault, &text)
}

/// Default path, so the UI can pre-fill it for the user to confirm.
#[tauri::command]
pub fn ssh_config_path() -> AppResult<Option<String>> {
    Ok(default_config_path().map(|p| p.display().to_string()))
}
