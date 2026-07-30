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

/// Keychain key: `identity:<id>` — one secret per identity
/// (password or key passphrase, depending on `auth_kind`).
fn account_for(identity_id: &str) -> String {
    format!("identity:{identity_id}")
}

pub fn store(identity_id: &str, value: &str) -> AppResult<()> {
    entry(&account_for(identity_id))?.set_password(value)?;
    Ok(())
}

/// Returns `None` when no secret has been stored yet — this isn't an error,
/// many identities (agent, passphrase-less key) simply don't need a secret.
pub fn load(identity_id: &str) -> AppResult<Option<Secret>> {
    match entry(&account_for(identity_id))?.get_password() {
        Ok(v) => Ok(Some(Secret(v))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete(identity_id: &str) -> AppResult<()> {
    match entry(&account_for(identity_id))?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
