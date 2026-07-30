pub mod commands;
pub mod error;
pub mod events;
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
            commands::vault::list_snippets,
            commands::vault::save_snippet,
            commands::vault::delete_snippet,
            commands::vault::list_tunnels,
            commands::vault::save_tunnel,
            commands::vault::delete_tunnel,
            commands::vault::get_known_host,
            commands::vault::trust_host_key,
            commands::vault::forget_host_key,
            // session
            commands::session::ssh_connect,
            commands::session::local_open,
            commands::session::session_write,
            commands::session::session_resize,
            commands::session::session_close,
            commands::session::session_list,
            commands::session::session_reconnect,
            commands::session::snippet_send,
            // sftp
            commands::sftp::sftp_list,
            commands::sftp::sftp_canonicalize,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_download,
            commands::sftp::sftp_upload,
            // ssh config
            commands::sshconfig::import_ssh_config,
            commands::sshconfig::ssh_config_path,
            // tunnel
            commands::tunnel::tunnel_start,
            commands::tunnel::tunnel_stop,
            commands::tunnel::tunnel_active,
        ])
        .run(tauri::generate_context!())
        .expect("không khởi động được Shellmux");
}
