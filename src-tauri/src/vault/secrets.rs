use std::sync::OnceLock;

use keyring::Entry;

use crate::error::AppResult;

const SERVICE: &str = "dev.shellmux.vault";

/// `keyring` 4 installs the default credential store *lazily* inside `Entry::new`,
/// and the ready flag gets set before the store is actually ready. If two tasks
/// both call it for the first time, one of them can see the flag already set
/// while the store is still empty and get `NoDefaultStore`. `OnceLock` makes
/// every caller wait for the first initialization to finish.
static STORE_READY: OnceLock<()> = OnceLock::new();

fn entry(account: &str) -> AppResult<Entry> {
    STORE_READY.get_or_init(|| {
        // Only to activate the store; no read/write means no prompt.
        let _ = Entry::new(SERVICE, "__warmup__");
    });
    Ok(Entry::new(SERVICE, account)?)
}

/// Called at startup so the first connection doesn't pay the initialization cost.
pub fn warm_up() {
    STORE_READY.get_or_init(|| {
        let _ = Entry::new(SERVICE, "__warmup__");
    });
}

/// Wrapper so passwords/passphrases never leak into logs or panic messages.
pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

/// Keychain account for a key's passphrase — one per identity.
fn account_for(identity_id: &str) -> String {
    format!("identity:{identity_id}")
}

/// Keychain account for a host's password. Keyed by host rather than by a
/// shared credential, because a password is only ever valid for one account on
/// one machine.
fn account_for_host(host_id: &str) -> String {
    format!("host:{host_id}")
}

pub fn store(identity_id: &str, value: &str) -> AppResult<()> {
    entry(&account_for(identity_id))?.set_password(value)?;
    Ok(())
}

/// Returns `None` when no secret has been stored yet — this isn't an error;
/// a key without a passphrase simply has none.
pub fn load(identity_id: &str) -> AppResult<Option<Secret>> {
    read(&account_for(identity_id))
}

pub fn delete(identity_id: &str) -> AppResult<()> {
    remove(&account_for(identity_id))
}

pub fn store_host_password(host_id: &str, value: &str) -> AppResult<()> {
    entry(&account_for_host(host_id))?.set_password(value)?;
    Ok(())
}

/// Reads a host's password. `legacy_identity_id` covers vaults written before
/// schema v2, where a password was attached through a shared identity and so
/// still lives under that identity's account — re-saving the host moves it.
pub fn load_host_password(
    host_id: &str,
    legacy_identity_id: Option<&str>,
) -> AppResult<Option<Secret>> {
    if let Some(found) = read(&account_for_host(host_id))? {
        return Ok(Some(found));
    }
    match legacy_identity_id {
        Some(id) => read(&account_for(id)),
        None => Ok(None),
    }
}

pub fn delete_host_password(host_id: &str) -> AppResult<()> {
    remove(&account_for_host(host_id))
}

fn read(account: &str) -> AppResult<Option<Secret>> {
    match entry(account)?.get_password() {
        Ok(v) => Ok(Some(Secret(v))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn remove(account: &str) -> AppResult<()> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
