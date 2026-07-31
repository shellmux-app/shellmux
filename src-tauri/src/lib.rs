pub mod agent;
pub mod commands;
pub mod error;
pub mod events;
pub mod keyinfo;
pub mod paths;
pub mod pipe;
pub mod session;
pub mod sftp;
pub mod socks;
pub mod ssh;
pub mod sshconfig;
pub mod state;
pub mod tunnel;
pub mod vault;

use tauri::Manager;

use state::AppState;
use vault::Vault;

const VAULT_FILE: &str = "vault.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            vault::secrets::warm_up();
            let dir = app.path().app_data_dir()?;
            let vault = Vault::open(&dir.join(VAULT_FILE))?;
            app.manage(AppState::new(vault));

            apply_window_vibrancy(app);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // vault
            commands::vault::list_groups,
            commands::vault::save_group,
            commands::vault::delete_group,
            commands::vault::list_identities,
            commands::vault::save_identity,
            commands::vault::delete_identity,
            commands::vault::list_hosts,
            commands::vault::save_host,
            commands::vault::delete_host,
            commands::vault::host_has_password,
            commands::vault::list_snippets,
            commands::vault::save_snippet,
            commands::vault::delete_snippet,
            commands::vault::list_tunnels,
            commands::vault::save_tunnel,
            commands::vault::delete_tunnel,
            commands::vault::list_known_hosts,
            commands::vault::get_known_host,
            commands::vault::trust_host_key,
            commands::vault::forget_host_key,
            commands::vault::vault_export,
            commands::vault::vault_import,
            // session
            commands::session::ssh_connect,
            commands::session::local_open,
            commands::session::session_write,
            commands::session::session_resize,
            commands::session::session_close,
            commands::session::session_list,
            commands::session::session_reconnect,
            commands::session::session_start_logging,
            commands::session::session_stop_logging,
            commands::session::snippet_send,
            // sftp
            commands::sftp::sftp_list,
            commands::sftp::sftp_canonicalize,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_download,
            commands::sftp::sftp_upload,
            // key inspection
            commands::keyinfo::inspect_key,
            commands::keyinfo::inspect_keys,
            // ssh config
            commands::sshconfig::import_ssh_config,
            commands::sshconfig::ssh_config_path,
            // tunnel
            commands::tunnel::tunnel_start,
            commands::tunnel::tunnel_stop,
            commands::tunnel::tunnel_active,
            // window
            commands::window::set_window_theme,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Shellmux");
}

/// A real NSVisualEffectView instead of CSS's `backdrop-filter` approximation
/// — the only thing that can blur the actual desktop behind the window, the
/// real TablePlus feel. Not fatal if it fails: the window still works, it
/// just loses the glass layer.
#[cfg(target_os = "macos")]
fn apply_window_vibrancy(app: &tauri::App) {
    use tauri::Manager;
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

    let Some(window) = app.get_webview_window("main") else {
        log::warn!("could not find the main window to apply vibrancy to");
        return;
    };

    // `Sidebar` is the material Finder/Mail/TablePlus use for navigation panels.
    //
    // Tried `HeaderView` for comparison (see git history) — no difference.
    // Light-mode vibrancy renders noticeably more washed-out than dark-mode
    // vibrancy *at every material*, measured directly on real hardware
    // (macOS 26). That's a system characteristic of AppKit, not a bad material
    // choice — compensated via the `--glass` token on the CSS side
    // (tokens.css) instead of chasing another material swap.
    if let Err(e) = apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None) {
        log::warn!("failed to apply macOS vibrancy (requires macOS 10.10+): {e}");
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_window_vibrancy(_app: &tauri::App) {
    // Windows/Linux: not implemented yet (see Cargo.toml). The window is still
    // `transparent` per tauri.conf.json, but nothing draws behind it — the
    // frontend keeps its opaque `--canvas` since `hasNativeVibrancy()` is only
    // true on macOS.
}
