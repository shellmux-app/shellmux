use tauri::State;
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;
use crate::vault::{secrets, Group, Host, Identity, KnownHost, Snippet, TunnelSpec};

/// An empty id means a new record — generate a uuid instead of leaving it to the frontend.
fn ensure_id(id: &str) -> String {
    if id.trim().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        id.to_string()
    }
}

// -------------------------------------------------------------------- groups

#[tauri::command]
pub fn list_groups(state: State<'_, AppState>) -> AppResult<Vec<Group>> {
    state.vault.list_groups()
}

#[tauri::command]
pub fn save_group(state: State<'_, AppState>, group: Group) -> AppResult<Group> {
    let next = Group {
        id: ensure_id(&group.id),
        ..group
    };
    state.vault.upsert_group(&next)?;
    Ok(next)
}

#[tauri::command]
pub fn delete_group(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.vault.delete_group(&id)
}

// ---------------------------------------------------------------- identities

#[tauri::command]
pub fn list_identities(state: State<'_, AppState>) -> AppResult<Vec<Identity>> {
    state.vault.list_identities()
}

/// `secret` only flows one way: into the keychain, then it's gone. No command
/// reads the secret back out to the frontend.
#[tauri::command]
pub fn save_identity(
    state: State<'_, AppState>,
    identity: Identity,
    secret: Option<String>,
) -> AppResult<Identity> {
    let id = ensure_id(&identity.id);

    let has_secret = match secret {
        Some(value) if !value.is_empty() => {
            secrets::store(&id, &value)?;
            true
        }
        Some(_) => {
            secrets::delete(&id)?;
            false
        }
        None => identity.has_secret,
    };

    let next = Identity {
        id,
        has_secret,
        ..identity
    };
    state.vault.upsert_identity(&next)?;
    Ok(next)
}

#[tauri::command]
pub fn delete_identity(state: State<'_, AppState>, id: String) -> AppResult<()> {
    secrets::delete(&id)?;
    state.vault.delete_identity(&id)
}

// --------------------------------------------------------------------- hosts

#[tauri::command]
pub fn list_hosts(state: State<'_, AppState>) -> AppResult<Vec<Host>> {
    state.vault.list_hosts()
}

/// `password` behaves like `save_identity`'s `secret`: it goes into the OS
/// keychain keyed by the host id and is never readable back. `None` leaves any
/// stored password untouched, so saving an unrelated edit doesn't wipe it.
#[tauri::command]
pub fn save_host(
    state: State<'_, AppState>,
    host: Host,
    password: Option<String>,
) -> AppResult<Host> {
    let id = ensure_id(&host.id);

    match password {
        Some(value) if !value.is_empty() => secrets::store_host_password(&id, &value)?,
        Some(_) => secrets::delete_host_password(&id)?,
        None => {}
    }

    let next = Host { id, ..host };
    state.vault.upsert_host(&next)?;
    Ok(next)
}

#[tauri::command]
pub fn delete_host(state: State<'_, AppState>, id: String) -> AppResult<()> {
    // Drop the password with the host, so removing a host doesn't leave a
    // credential behind in the keychain.
    secrets::delete_host_password(&id)?;
    state.vault.delete_host(&id)
}

/// True when a password is stored for this host. Only ever the flag — the
/// password itself has no path back to the frontend.
#[tauri::command]
pub fn host_has_password(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    // Must consult the same legacy fallback `ssh/auth.rs` uses, otherwise a
    // host migrated from a pre-v2 vault (whose password is still keyed by
    // the old identity id) connects fine while the UI claims it has none.
    let legacy = state.vault.get_host(&id).ok().and_then(|h| h.identity_id);
    Ok(secrets::load_host_password(&id, legacy.as_deref())?.is_some())
}

// ------------------------------------------------------------------ snippets

#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> AppResult<Vec<Snippet>> {
    state.vault.list_snippets()
}

#[tauri::command]
pub fn save_snippet(state: State<'_, AppState>, snippet: Snippet) -> AppResult<Snippet> {
    let next = Snippet {
        id: ensure_id(&snippet.id),
        ..snippet
    };
    state.vault.upsert_snippet(&next)?;
    Ok(next)
}

#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.vault.delete_snippet(&id)
}

// ------------------------------------------------------------------- tunnels

#[tauri::command]
pub fn list_tunnels(state: State<'_, AppState>) -> AppResult<Vec<TunnelSpec>> {
    state.vault.list_tunnels()
}

#[tauri::command]
pub fn save_tunnel(state: State<'_, AppState>, tunnel: TunnelSpec) -> AppResult<TunnelSpec> {
    let next = TunnelSpec {
        id: ensure_id(&tunnel.id),
        ..tunnel
    };
    state.vault.upsert_tunnel(&next)?;
    Ok(next)
}

#[tauri::command]
pub fn delete_tunnel(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.vault.delete_tunnel(&id)
}

// --------------------------------------------------------------- known hosts

#[tauri::command]
pub fn list_known_hosts(state: State<'_, AppState>) -> AppResult<Vec<KnownHost>> {
    state.vault.list_known_hosts()
}

#[tauri::command]
pub fn get_known_host(
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> AppResult<Option<KnownHost>> {
    state.vault.get_known_host(&host, port)
}

/// Called after the user has viewed the fingerprint and clicked accept.
#[tauri::command]
pub fn trust_host_key(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    algo: String,
    fingerprint: String,
) -> AppResult<()> {
    state
        .vault
        .put_known_host(&host, port, &algo, &fingerprint)
}

#[tauri::command]
pub fn forget_host_key(state: State<'_, AppState>, host: String, port: u16) -> AppResult<()> {
    state.vault.forget_known_host(&host, port)
}

// -------------------------------------------------------- encrypted export

/// Writes an encrypted snapshot of the vault's data (groups, hosts,
/// identities, snippets, tunnels, known hosts) to `path`, sealed with
/// `passphrase`. Does not include OS-keychain secrets — see `vault/export.rs`.
#[tauri::command]
pub fn vault_export(state: State<'_, AppState>, path: String, passphrase: String) -> AppResult<()> {
    let data = crate::vault::export::export_encrypted(&state.vault, &passphrase)?;
    std::fs::write(&path, data)?;
    Ok(())
}

#[tauri::command]
pub fn vault_import(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> AppResult<crate::vault::export::ImportSummary> {
    let data = std::fs::read(&path)?;
    crate::vault::export::import_encrypted(&state.vault, &data, &passphrase)
}
