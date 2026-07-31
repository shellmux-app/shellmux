//! Encrypted export/import of the vault's own data — for backup, or moving
//! to another machine.
//!
//! Deliberately does **not** include OS-keychain secrets (passwords, key
//! passphrases): those never leave the keychain, the same as the vault
//! database itself never holds them (see `vault/secrets.rs`). What *is*
//! exported is still worth encrypting at rest — hostnames, usernames, and
//! key file paths are a map of someone's infrastructure — so the whole
//! payload is sealed with a passphrase the user chooses for this file only,
//! independent of anything in the keychain.
//!
//! Format: `b"SMXVLT01"` magic, a 16-byte Argon2id salt, a 24-byte XChaCha20
//! nonce, then the ciphertext (JSON plaintext, AEAD-sealed with that key and
//! nonce). Everything needed to decrypt except the passphrase itself is
//! right there in the file, same as any password-protected archive format.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::Rng;
use serde::{Deserialize, Serialize};

use super::model::{Group, Host, Identity, KnownHost, Snippet, TunnelSpec};
use super::Vault;
use crate::error::{AppError, AppResult};

const MAGIC: &[u8; 8] = b"SMXVLT01";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;
const HEADER_LEN: usize = MAGIC.len() + SALT_LEN + NONCE_LEN;

/// Argon2id cost, pinned explicitly rather than taken from
/// `Argon2::default()`. The header doesn't record these, so the reader has
/// to derive with exactly the same values the writer used — and the crate's
/// own defaults have changed across releases (4096 → 19456 KiB). Inheriting
/// them would mean a routine dependency bump silently made every existing
/// export undecryptable, reported to the user as "wrong passphrase" on a
/// file that is perfectly intact. Changing these values requires a new
/// `MAGIC` so old files can still be read.
const ARGON2_M_COST: u32 = 19_456; // KiB
const ARGON2_T_COST: u32 = 2;
const ARGON2_P_COST: u32 = 1;

/// Short enough to type, long enough that the Argon2 cost above makes an
/// offline guess expensive. This file is meant to leave the machine, so the
/// passphrase is the only thing protecting it.
const MIN_PASSPHRASE_LEN: usize = 8;

#[derive(Debug, Serialize, Deserialize)]
struct ExportPayload {
    groups: Vec<Group>,
    hosts: Vec<Host>,
    identities: Vec<Identity>,
    snippets: Vec<Snippet>,
    tunnels: Vec<TunnelSpec>,
    known_hosts: Vec<KnownHost>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub groups: usize,
    pub hosts: usize,
    pub identities: usize,
    pub snippets: usize,
    pub tunnels: usize,
    pub known_hosts: usize,
    /// `host:port` entries whose pinned fingerprint differs from the one in
    /// the file. Left untouched rather than overwritten — see `import_encrypted`.
    pub known_host_conflicts: Vec<String>,
}

pub fn export_encrypted(vault: &Vault, passphrase: &str) -> AppResult<Vec<u8>> {
    if passphrase.chars().count() < MIN_PASSPHRASE_LEN {
        return Err(AppError::Invalid(format!(
            "the export passphrase must be at least {MIN_PASSPHRASE_LEN} characters — \
             it's the only thing protecting this file once it leaves this machine"
        )));
    }

    let payload = ExportPayload {
        groups: vault.list_groups()?,
        hosts: vault.list_hosts()?,
        identities: vault.list_identities()?,
        snippets: vault.list_snippets()?,
        tunnels: vault.list_tunnels()?,
        known_hosts: vault.list_known_hosts()?,
    };
    let plaintext = serde_json::to_vec(&payload)
        .map_err(|e| AppError::Vault(format!("could not serialize the vault: {e}")))?;

    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut salt);
    rand::rng().fill_bytes(&mut nonce_bytes);

    let key = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new(&key.into());
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_slice())
        .map_err(|_| AppError::Vault("could not encrypt the export".into()))?;

    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypts and merges an export into `vault`, using the same
/// insert-or-update-by-id semantics as importing `~/.ssh/config` — running
/// it twice is safe, and existing hosts/groups sharing an id get updated
/// rather than duplicated.
pub fn import_encrypted(vault: &Vault, data: &[u8], passphrase: &str) -> AppResult<ImportSummary> {
    let plaintext = decrypt(data, passphrase)?;
    let payload: ExportPayload = serde_json::from_slice(&plaintext)
        .map_err(|e| AppError::Vault(format!("this file isn't a valid vault export: {e}")))?;

    let mut summary = ImportSummary::default();

    for g in &payload.groups {
        vault.upsert_group(g)?;
        summary.groups += 1;
    }
    for i in &payload.identities {
        // The keychain entry never traveled with the export — reset the
        // flag rather than claim a passphrase is available when it isn't.
        vault.upsert_identity(&Identity {
            has_secret: false,
            ..i.clone()
        })?;
        summary.identities += 1;
    }
    // Two passes: `jump_host_id` can point at any other host in the export,
    // in any order, and the column is a foreign key checked immediately —
    // so every host is inserted once without its jump link, then re-saved
    // with the real link once every id in the batch actually exists.
    for h in &payload.hosts {
        vault.upsert_host(&Host {
            jump_host_id: None,
            ..h.clone()
        })?;
    }
    for h in &payload.hosts {
        vault.upsert_host(h)?;
        summary.hosts += 1;
    }
    for s in &payload.snippets {
        vault.upsert_snippet(s)?;
        summary.snippets += 1;
    }
    for t in &payload.tunnels {
        vault.upsert_tunnel(t)?;
        summary.tunnels += 1;
    }
    // Never silently replace a fingerprint already pinned on this machine.
    // `put_known_host` is an upsert, so importing a file authored by someone
    // else could otherwise re-pin a host to an attacker-chosen key and the
    // next connection would succeed with no warning — exactly the MITM that
    // trust-on-first-use exists to catch. Restoring your own backup hits no
    // conflicts; anything that does is surfaced for the user to resolve.
    for k in &payload.known_hosts {
        match vault.get_known_host(&k.host, k.port)? {
            Some(existing) if existing.fingerprint != k.fingerprint => {
                summary.known_host_conflicts.push(format!("{}:{}", k.host, k.port));
            }
            _ => {
                vault.put_known_host(&k.host, k.port, &k.algo, &k.fingerprint)?;
                summary.known_hosts += 1;
            }
        }
    }

    Ok(summary)
}

fn decrypt(data: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    if data.len() < HEADER_LEN {
        return Err(AppError::Invalid("this file is too small to be a vault export".into()));
    }
    let (magic, rest) = data.split_at(MAGIC.len());
    if magic != MAGIC {
        return Err(AppError::Invalid(
            "this doesn't look like a Shellmux vault export".into(),
        ));
    }
    let (salt, rest) = rest.split_at(SALT_LEN);
    let (nonce_bytes, ciphertext) = rest.split_at(NONCE_LEN);

    let key = derive_key(passphrase, salt)?;
    let cipher = XChaCha20Poly1305::new(&key.into());
    let nonce = XNonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AppError::Invalid("wrong passphrase, or the file is corrupted".into()))
}

fn derive_key(passphrase: &str, salt: &[u8]) -> AppResult<[u8; KEY_LEN]> {
    let params = Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, Some(KEY_LEN))
        .map_err(|e| AppError::Vault(format!("invalid Argon2 parameters: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::Vault(format!("key derivation failed: {e}")))?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{AuthKind, TunnelKind};

    fn sample_vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(&dir.path().join("vault.db")).unwrap();
        vault
            .upsert_group(&Group {
                id: "g1".into(),
                parent_id: None,
                name: "Production".into(),
                sort: 0,
            })
            .unwrap();
        vault
            .upsert_identity(&Identity {
                id: "i1".into(),
                name: "deploy key".into(),
                private_key_path: "/tmp/id_ed25519".into(),
                has_secret: true,
            })
            .unwrap();
        vault
            .upsert_host(&Host {
                id: "bastion".into(),
                group_id: Some("g1".into()),
                label: "bastion".into(),
                hostname: "10.0.0.1".into(),
                port: 22,
                username: "admin".into(),
                auth_kind: AuthKind::Key,
                identity_id: Some("i1".into()),
                jump_host_id: None,
                theme: None,
                color_tag: None,
                notes: None,
                sort: 0,
                agent_forward: true,
            })
            .unwrap();
        vault
            .upsert_host(&Host {
                id: "db".into(),
                group_id: Some("g1".into()),
                label: "db".into(),
                hostname: "10.0.0.2".into(),
                port: 22,
                username: "root".into(),
                auth_kind: AuthKind::Agent,
                identity_id: None,
                // Forward reference on purpose — exercises the two-pass import.
                jump_host_id: Some("bastion".into()),
                theme: None,
                color_tag: None,
                notes: None,
                sort: 1,
                agent_forward: false,
            })
            .unwrap();
        vault
            .upsert_tunnel(&TunnelSpec {
                id: "t1".into(),
                host_id: "db".into(),
                name: "postgres".into(),
                kind: TunnelKind::Local,
                bind_addr: "127.0.0.1".into(),
                bind_port: 5432,
                target_host: "127.0.0.1".into(),
                target_port: 5432,
                auto_start: true,
            })
            .unwrap();
        vault.put_known_host("10.0.0.1", 22, "ssh-ed25519", "SHA256:abc").unwrap();
        (dir, vault)
    }

    #[test]
    fn round_trips_every_record_into_a_fresh_vault() {
        let (_dir, source) = sample_vault();
        let exported = export_encrypted(&source, "correct horse battery staple").unwrap();

        let target_dir = tempfile::tempdir().unwrap();
        let target = Vault::open(&target_dir.path().join("vault.db")).unwrap();
        let summary = import_encrypted(&target, &exported, "correct horse battery staple").unwrap();

        assert_eq!(summary.groups, 1);
        assert_eq!(summary.hosts, 2);
        assert_eq!(summary.identities, 1);
        assert_eq!(summary.tunnels, 1);
        assert_eq!(summary.known_hosts, 1);

        let db = target.get_host("db").unwrap();
        assert_eq!(db.hostname, "10.0.0.2");
        assert_eq!(db.jump_host_id.as_deref(), Some("bastion"));
        assert!(target.get_host("bastion").unwrap().agent_forward);
    }

    #[test]
    fn imported_identities_never_claim_a_secret_the_new_keychain_does_not_have() {
        let (_dir, source) = sample_vault();
        let exported = export_encrypted(&source, "correct-horse-battery").unwrap();

        let target_dir = tempfile::tempdir().unwrap();
        let target = Vault::open(&target_dir.path().join("vault.db")).unwrap();
        import_encrypted(&target, &exported, "correct-horse-battery").unwrap();

        let identities = target.list_identities().unwrap();
        assert_eq!(identities.len(), 1);
        assert!(
            !identities[0].has_secret,
            "the source identity's has_secret was true, but no passphrase bytes were ever \
             exported — the imported copy must not claim one exists"
        );
    }

    #[test]
    fn wrong_passphrase_is_rejected_without_corrupting_anything() {
        let (_dir, source) = sample_vault();
        let exported = export_encrypted(&source, "right passphrase").unwrap();

        let target_dir = tempfile::tempdir().unwrap();
        let target = Vault::open(&target_dir.path().join("vault.db")).unwrap();
        let err = import_encrypted(&target, &exported, "wrong passphrase").unwrap_err();

        assert!(matches!(err, AppError::Invalid(_)));
        assert_eq!(target.list_hosts().unwrap().len(), 0);
    }

    #[test]
    fn a_file_that_is_not_a_shellmux_export_is_rejected_by_magic_check() {
        let target_dir = tempfile::tempdir().unwrap();
        let target = Vault::open(&target_dir.path().join("vault.db")).unwrap();

        let err = import_encrypted(&target, b"not a vault export at all", "correct-horse-battery").unwrap_err();

        assert!(matches!(err, AppError::Invalid(_)));
    }

    #[test]
    fn empty_passphrase_is_rejected_at_export_time() {
        let (_dir, source) = sample_vault();
        assert!(export_encrypted(&source, "").is_err());
    }

    #[test]
    fn a_too_short_passphrase_is_rejected_at_export_time() {
        let (_dir, source) = sample_vault();
        // The file is designed to leave the machine, so a 2-character
        // passphrase is brute-forceable regardless of the Argon2 cost.
        assert!(export_encrypted(&source, "pw").is_err());
        assert!(export_encrypted(&source, "1234567").is_err());
        assert!(export_encrypted(&source, "12345678").is_ok());
    }

    /// The whole point of trust-on-first-use is that a host's key can't
    /// change behind your back. An import must not be a way around that.
    #[test]
    fn import_never_overwrites_a_fingerprint_already_pinned_on_this_machine() {
        let (_dir, source) = sample_vault();
        let exported = export_encrypted(&source, "correct-horse-battery").unwrap();

        let target_dir = tempfile::tempdir().unwrap();
        let target = Vault::open(&target_dir.path().join("vault.db")).unwrap();
        // This machine already trusts a *different* key for that host.
        target
            .put_known_host("10.0.0.1", 22, "ssh-ed25519", "SHA256:the-real-one")
            .unwrap();

        let summary = import_encrypted(&target, &exported, "correct-horse-battery").unwrap();

        assert_eq!(
            target.get_known_host("10.0.0.1", 22).unwrap().unwrap().fingerprint,
            "SHA256:the-real-one",
            "an imported file must not silently re-pin a host to another key"
        );
        assert_eq!(summary.known_host_conflicts, vec!["10.0.0.1:22".to_string()]);
        assert_eq!(summary.known_hosts, 0);
    }

    #[test]
    fn import_still_adds_known_hosts_this_machine_has_never_seen() {
        let (_dir, source) = sample_vault();
        let exported = export_encrypted(&source, "correct-horse-battery").unwrap();

        let target_dir = tempfile::tempdir().unwrap();
        let target = Vault::open(&target_dir.path().join("vault.db")).unwrap();
        let summary = import_encrypted(&target, &exported, "correct-horse-battery").unwrap();

        assert_eq!(summary.known_hosts, 1);
        assert!(summary.known_host_conflicts.is_empty());
        assert_eq!(
            target.get_known_host("10.0.0.1", 22).unwrap().unwrap().fingerprint,
            "SHA256:abc"
        );
    }

    #[test]
    fn running_the_same_import_twice_updates_instead_of_duplicating() {
        let (_dir, source) = sample_vault();
        let exported = export_encrypted(&source, "correct-horse-battery").unwrap();

        let target_dir = tempfile::tempdir().unwrap();
        let target = Vault::open(&target_dir.path().join("vault.db")).unwrap();
        import_encrypted(&target, &exported, "correct-horse-battery").unwrap();
        import_encrypted(&target, &exported, "correct-horse-battery").unwrap();

        assert_eq!(target.list_hosts().unwrap().len(), 2);
        assert_eq!(target.list_groups().unwrap().len(), 1);
    }
}
