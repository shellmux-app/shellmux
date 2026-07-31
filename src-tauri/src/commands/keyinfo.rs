use crate::error::AppResult;
use crate::keyinfo::{self, KeyInfo};

/// Describes a key file the user just picked. Reads only the file's own
/// metadata — no passphrase is required and none is asked for.
#[tauri::command]
pub fn inspect_key(path: String) -> AppResult<KeyInfo> {
    Ok(keyinfo::inspect(&path))
}

/// Batch version for the Keychain list, which needs a verdict per saved key.
/// Results line up with `paths` by index.
#[tauri::command]
pub fn inspect_keys(paths: Vec<String>) -> AppResult<Vec<KeyInfo>> {
    Ok(paths.iter().map(|p| keyinfo::inspect(p)).collect())
}
