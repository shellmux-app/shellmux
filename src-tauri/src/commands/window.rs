use tauri::{Theme, WebviewWindow};

use crate::error::{AppError, AppResult};

/// Syncs the window theme (chrome + vibrancy) with the theme the user picked
/// in the app. Skipping this step means switching to "light" in the app
/// while the window keeps a dark appearance, which makes the
/// NSVisualEffectView layer tint incorrectly — the glass looks murky
/// instead of clear.
///
/// `theme` is `"light"`, `"dark"`, or `None` to revert to following the OS.
#[tauri::command]
pub fn set_window_theme(window: WebviewWindow, theme: Option<String>) -> AppResult<()> {
    let parsed = match theme.as_deref() {
        Some("light") => Some(Theme::Light),
        Some("dark") => Some(Theme::Dark),
        None => None,
        Some(other) => {
            return Err(AppError::Invalid(format!("invalid theme: {other}")));
        }
    };

    window
        .set_theme(parsed)
        .map_err(|e| AppError::Invalid(format!("could not set window theme: {e}")))
}
