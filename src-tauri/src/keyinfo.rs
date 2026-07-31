//! Works out what a key file actually *is*, so the user never has to tell us.
//!
//! Two things motivate this. First, labelling: a saved key should show up as
//! "Ed25519 · SHA256:… · needs passphrase" without anyone typing that in.
//! Second, and more useful: the failure modes here are famously opaque. Picking
//! `id_ed25519.pub` instead of `id_ed25519` is the single most common mistake,
//! and left alone it surfaces much later as an unexplained "server rejected
//! key". Detecting it at pick time turns it into one clear sentence.
//!
//! The load-bearing fact that makes this work: in the modern
//! `BEGIN OPENSSH PRIVATE KEY` format only the *private* section is encrypted —
//! the public key, and therefore the algorithm, size and fingerprint, sit in
//! cleartext (OpenSSH PROTOCOL.key). So an encrypted key can be fully described
//! without ever asking for the passphrase. Legacy PEM formats are not so kind;
//! there we can only report the algorithm from the header label.

use russh::keys::{Algorithm, Certificate, EcdsaCurve, HashAlg, PrivateKey, PublicKey};
use serde::Serialize;

use crate::paths::expand_tilde;

/// A key file is a few KB. Anything past this is something else entirely, and
/// reading it into a String first would be the wrong way to find that out.
const MAX_KEY_BYTES: u64 = 1024 * 1024;

const OPENSSH_HEADER: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
const PPK_PREFIX: &str = "PuTTY-User-Key-File-";

/// What the file turned out to be. Anything other than `PrivateKey` means the
/// user picked the wrong file and the UI should say which one to pick instead —
/// that is the whole point of this enum being wider than `Result`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum KeyInfo {
    PrivateKey(PrivateKeyInfo),
    /// `id_ed25519.pub` picked instead of `id_ed25519`.
    #[serde(rename_all = "camelCase")]
    PublicKey {
        algorithm: String,
        comment: Option<String>,
        /// The private key that almost certainly sits next to it.
        private_key_guess: Option<String>,
    },
    /// An OpenSSH certificate (`*-cert.pub`). Also not the file to pick — the
    /// private key it was issued against is.
    #[serde(rename_all = "camelCase")]
    Certificate { algorithm: String, key_id: String },
    /// Parsed, but nothing can authenticate with it.
    Unsupported { reason: String },
    NotAKey { reason: String },
    Unreadable { reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateKeyInfo {
    /// Ready to show: `Ed25519`, `RSA 4096`, `ECDSA P-256`.
    pub label: String,
    /// Stable and lowercase, for grouping and icon lookup — not for display.
    pub algorithm_id: String,
    pub bits: Option<u32>,
    /// OpenSSH's own format, e.g. `SHA256:Ll1t…` — the same string
    /// `ssh-keygen -l` prints, so it can be compared against GitHub et al.
    pub fingerprint: Option<String>,
    pub comment: Option<String>,
    /// True when a passphrase is needed to use it.
    pub encrypted: bool,
    /// `openssh` · `pkcs1` · `pkcs8` · `sec1` · `ppk`
    pub format: String,
    /// Set when the key still works but shouldn't be relied on.
    pub warning: Option<String>,
}

/// Reads and classifies the file at `raw_path`. Never returns `Err`: every
/// outcome, including "this isn't a key", is a value the UI can render.
pub fn inspect(raw_path: &str) -> KeyInfo {
    let path = expand_tilde(raw_path);

    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > MAX_KEY_BYTES => {
            return KeyInfo::NotAKey {
                reason: "This file is far too large to be an SSH key.".into(),
            }
        }
        Ok(_) => {}
        Err(e) => {
            return KeyInfo::Unreadable {
                reason: match e.kind() {
                    std::io::ErrorKind::NotFound => format!("File not found: {path}"),
                    std::io::ErrorKind::PermissionDenied => {
                        format!("No permission to read {path}")
                    }
                    _ => format!("Cannot read {path}: {e}"),
                },
            }
        }
    }

    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            return KeyInfo::Unreadable {
                reason: format!("Cannot read {path}: {e}"),
            }
        }
    };

    // Every key format is text. Bailing here keeps a stray binary out of the
    // parsers, which would otherwise report something misleading about PEM.
    if bytes.contains(&0) {
        return KeyInfo::NotAKey {
            reason: "This is a binary file, not an SSH key.".into(),
        };
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(t) => t,
        Err(_) => {
            return KeyInfo::NotAKey {
                reason: "This is not a text file, so it can't be an SSH key.".into(),
            }
        }
    };

    classify(text, &path)
}

/// Split out from `inspect` so the format rules can be tested without touching
/// the filesystem. `path` is only used to name the sibling `.pub` and to
/// suggest the right file when the user picked a public key.
fn classify(text: &str, path: &str) -> KeyInfo {
    // A BOM makes every exact-match header comparison below fail, and the
    // resulting error would blame the key rather than the encoding.
    let text = text.trim_start_matches('\u{feff}');
    let head = text.trim_start();

    if head.starts_with(PPK_PREFIX) {
        return classify_ppk(head);
    }
    if text.contains(OPENSSH_HEADER) {
        return classify_openssh(text, path);
    }
    if let Some(label) = pem_label(head) {
        return classify_legacy_pem(&label);
    }
    if let Some(info) = classify_public_or_cert(head, path) {
        return info;
    }

    KeyInfo::NotAKey {
        reason: "Not an SSH key. Expected a file starting with \
                 -----BEGIN OPENSSH PRIVATE KEY----- or PuTTY-User-Key-File-."
            .into(),
    }
}

fn classify_openssh(text: &str, path: &str) -> KeyInfo {
    let key = match PrivateKey::from_openssh(text) {
        Ok(k) => k,
        Err(e) => {
            return KeyInfo::NotAKey {
                reason: format!("This looks like an OpenSSH key but could not be read: {e}"),
            }
        }
    };

    let algorithm = key.algorithm();
    let bits = key.public_key().key_data().rsa().map(|r| r.key_size());
    let encrypted = key.is_encrypted();

    // The comment lives inside the encrypted section, so for a locked key the
    // sibling `.pub` is the only place it can be read from.
    let comment = if encrypted {
        sibling_pub_comment(path)
    } else {
        non_empty(key.comment().as_str_lossy())
    };

    KeyInfo::PrivateKey(PrivateKeyInfo {
        label: label_for(&algorithm, bits),
        algorithm_id: algorithm_id(&algorithm),
        bits,
        fingerprint: Some(key.fingerprint(HashAlg::Sha256).to_string()),
        comment,
        encrypted,
        format: "openssh".into(),
        warning: warning_for(&algorithm, bits),
    })
}

/// Legacy PEM. The header label is all we get without decrypting — for the
/// encrypted variants even the algorithm is inside the ciphertext.
fn classify_legacy_pem(label: &str) -> KeyInfo {
    let (algorithm_id, display, format) = match label {
        "RSA PRIVATE KEY" => ("rsa", "RSA", "pkcs1"),
        "EC PRIVATE KEY" => ("ecdsa", "ECDSA", "sec1"),
        "PRIVATE KEY" => ("unknown", "Private key", "pkcs8"),
        "ENCRYPTED PRIVATE KEY" => ("unknown", "Private key", "pkcs8"),
        "DSA PRIVATE KEY" => {
            return KeyInfo::Unsupported {
                reason: "DSA keys were removed in OpenSSH 10.0 and no current server \
                         accepts them. Generate a new key with \
                         `ssh-keygen -t ed25519`."
                    .into(),
            }
        }
        "SSH2 ENCRYPTED PRIVATE KEY" | "SSH2 PRIVATE KEY" => {
            return KeyInfo::Unsupported {
                reason: "This is an RFC4716 (ssh.com) key. Convert it with \
                         `ssh-keygen -i -f <file>` first."
                    .into(),
            }
        }
        other => {
            return KeyInfo::NotAKey {
                reason: format!("This is a PEM file, but not a private key ({other})."),
            }
        }
    };

    KeyInfo::PrivateKey(PrivateKeyInfo {
        label: display.into(),
        algorithm_id: algorithm_id.into(),
        bits: None,
        fingerprint: None,
        comment: None,
        encrypted: label == "ENCRYPTED PRIVATE KEY",
        format: format.into(),
        warning: Some(
            "Older PEM key format. It works, but `ssh-keygen -p -f <file>` will \
             re-save it in the modern OpenSSH format."
                .into(),
        ),
    })
}

/// PuTTY keys. The header block is cleartext even when the body is encrypted,
/// so the algorithm and comment are always readable.
fn classify_ppk(text: &str) -> KeyInfo {
    let mut algorithm = None;
    let mut comment = None;
    let mut encrypted = false;
    let mut version = None;

    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            k if k.starts_with(PPK_PREFIX) => {
                version = k.trim_start_matches(PPK_PREFIX).parse::<u8>().ok();
                algorithm = Some(value.to_string());
            }
            "Encryption" => encrypted = value != "none",
            "Comment" => comment = non_empty(value),
            _ => {}
        }
        // Everything needed is in the first few lines; the rest is base64.
        if line.starts_with("Public-Lines") {
            break;
        }
    }

    if !matches!(version, Some(2) | Some(3)) {
        return KeyInfo::Unsupported {
            reason: format!(
                "PuTTY key version {} is not supported. Convert it with \
                 `puttygen key.ppk -O private-openssh-new -o key`.",
                version.map(|v| v.to_string()).unwrap_or_else(|| "?".into())
            ),
        };
    }

    let algorithm = algorithm
        .as_deref()
        .map(|a| Algorithm::new(a).unwrap_or(Algorithm::Ed25519));

    KeyInfo::PrivateKey(PrivateKeyInfo {
        label: algorithm
            .as_ref()
            .map(|a| label_for(a, None))
            .unwrap_or_else(|| "PuTTY key".into()),
        algorithm_id: algorithm
            .as_ref()
            .map(algorithm_id)
            .unwrap_or_else(|| "unknown".into()),
        bits: None,
        fingerprint: None,
        comment,
        encrypted,
        format: "ppk".into(),
        warning: None,
    })
}

/// The wrong-file cases. Returns `None` when the text is neither, so the caller
/// can fall through to a generic "not a key".
fn classify_public_or_cert(head: &str, path: &str) -> Option<KeyInfo> {
    let first_word = head.split_whitespace().next()?;
    let line = head.lines().next()?.trim();

    if first_word.ends_with("-cert-v01@openssh.com") {
        // `PublicKey::from_openssh` rejects certificates outright, so this has
        // to be tried first and with the dedicated parser.
        return Some(match Certificate::from_openssh(line) {
            Ok(cert) => KeyInfo::Certificate {
                algorithm: cert.algorithm().to_string(),
                key_id: cert.key_id().to_string(),
            },
            Err(e) => KeyInfo::NotAKey {
                reason: format!("This looks like a certificate but could not be read: {e}"),
            },
        });
    }

    let key = PublicKey::from_openssh(line).ok()?;
    Some(KeyInfo::PublicKey {
        algorithm: label_for(&key.algorithm(), key.key_data().rsa().map(|r| r.key_size())),
        comment: non_empty(key.comment().as_str_lossy()),
        private_key_guess: path.strip_suffix(".pub").map(str::to_string),
    })
}

/// Reads the comment out of `<path>.pub`, the only place it survives when the
/// private key itself is encrypted.
fn sibling_pub_comment(path: &str) -> Option<String> {
    let text = std::fs::read_to_string(format!("{path}.pub")).ok()?;
    let key = PublicKey::from_openssh(text.trim()).ok()?;
    non_empty(key.comment().as_str_lossy())
}

fn pem_label(head: &str) -> Option<String> {
    let line = head.lines().next()?.trim();
    let inner = line.strip_prefix("-----BEGIN ")?.strip_suffix("-----")?;
    Some(inner.to_string())
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn label_for(algorithm: &Algorithm, bits: Option<u32>) -> String {
    match algorithm {
        Algorithm::Ed25519 => "Ed25519".into(),
        Algorithm::Rsa { .. } => match bits {
            Some(b) => format!("RSA {b}"),
            None => "RSA".into(),
        },
        Algorithm::Ecdsa { curve } => format!(
            "ECDSA {}",
            match curve {
                EcdsaCurve::NistP256 => "P-256",
                EcdsaCurve::NistP384 => "P-384",
                EcdsaCurve::NistP521 => "P-521",
            }
        ),
        Algorithm::Dsa => "DSA".into(),
        Algorithm::SkEd25519 => "Ed25519 (security key)".into(),
        Algorithm::SkEcdsaSha2NistP256 => "ECDSA (security key)".into(),
        other => other.to_string(),
    }
}

fn algorithm_id(algorithm: &Algorithm) -> String {
    match algorithm {
        Algorithm::Ed25519 => "ed25519",
        Algorithm::Rsa { .. } => "rsa",
        Algorithm::Ecdsa { .. } => "ecdsa",
        Algorithm::Dsa => "dsa",
        Algorithm::SkEd25519 => "sk-ed25519",
        Algorithm::SkEcdsaSha2NistP256 => "sk-ecdsa",
        _ => "other",
    }
    .into()
}

/// Only flags what a *server* will actually reject or what is genuinely weak.
/// Notably absent: `ssh-rsa` keys. OpenSSH 8.8 disabled the SHA-1 *signature*
/// algorithm, not RSA keys, and its release notes say plainly that most users
/// need not replace them — we negotiate rsa-sha2-* in `ssh::auth`.
fn warning_for(algorithm: &Algorithm, bits: Option<u32>) -> Option<String> {
    match algorithm {
        Algorithm::Dsa => Some(
            "DSA was removed in OpenSSH 10.0. No current server will accept this key.".into(),
        ),
        Algorithm::Rsa { .. } => match bits {
            Some(b) if b < 2048 => Some(format!(
                "This RSA key is only {b} bits. Replace it with `ssh-keygen -t ed25519`."
            )),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real `ssh-keygen` output, pinned here so the tests exercise the actual
    // byte layout rather than a hand-written approximation. Both were made with
    // `ssh-keygen -t ed25519`; LOCKED additionally had `-N hunter2`. These are
    // throwaway keys that exist only in this file.
    const ED25519_PLAIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n\
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n\
QyNTUxOQAAACDSBh79R2kh+Adx/YTb9uZxRBrt10GLJFDDbK28JydGPAAAAJjBKFUywShV\n\
MgAAAAtzc2gtZWQyNTUxOQAAACDSBh79R2kh+Adx/YTb9uZxRBrt10GLJFDDbK28JydGPA\n\
AAAEAx+wPL6+MjYF0UR/TVgCZi1pOl2BeI5GoysqAndiWXCtIGHv1HaSH4B3H9hNv25nFE\n\
Gu3XQYskUMNsrbwnJ0Y8AAAAEXNoZWxsbXV4LXRlc3Qta2V5AQIDBA==\n\
-----END OPENSSH PRIVATE KEY-----\n";

    /// Same format, but passphrase-protected. The whole detection strategy
    /// rests on this file still yielding its algorithm and fingerprint.
    const ED25519_LOCKED: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n\
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABCtvhsy/D\n\
Wz6xQ2yy9bzmIHAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIF4DXa9SfycFEu+P\n\
jQ4Xx99ngX7bdJWLgXHSuz8K2yugAAAAkPtsjmYwci40LjKgCGbbDdZL8tRzBnW76QDPfv\n\
7TpBU6wkD1WQkLl0+Cz7WbzSEWyOzrHSBtVDfc/5xTp9JKAs00FcsQqwbcLquddJD397RW\n\
ZCzlkWJpwKuodCwXaJFC4g7eV05CGBSr0BBo3Y9hokVv+uB+mPcwwpSf3UBqmvpCoegCFe\n\
vQU0RBUBhMiO66VA==\n\
-----END OPENSSH PRIVATE KEY-----\n";

    #[test]
    fn reads_algorithm_fingerprint_and_comment_from_an_openssh_key() {
        let KeyInfo::PrivateKey(info) = classify(ED25519_PLAIN, "/tmp/id_ed25519") else {
            panic!("expected a private key");
        };
        assert_eq!(info.label, "Ed25519");
        assert_eq!(info.algorithm_id, "ed25519");
        assert!(!info.encrypted);
        assert_eq!(info.comment.as_deref(), Some("shellmux-test-key"));
        // Byte-for-byte what `ssh-keygen -l -f plain.pub` prints.
        assert_eq!(
            info.fingerprint.as_deref(),
            Some("SHA256:18qXOa+Ye9qrqR6Gh1cI4gIeez0PSsBRdksBL7ZQfDc")
        );
        assert_eq!(info.warning, None);
    }

    /// The premise the whole feature depends on: in the OpenSSH format the
    /// public half is *outside* the encrypted blob, so a locked key can still
    /// be fully labelled without ever asking for the passphrase.
    #[test]
    fn an_encrypted_key_still_reports_its_algorithm_and_fingerprint() {
        let KeyInfo::PrivateKey(info) = classify(ED25519_LOCKED, "/tmp/locked") else {
            panic!("expected a private key");
        };
        assert!(info.encrypted);
        assert_eq!(info.label, "Ed25519");
        assert_eq!(
            info.fingerprint.as_deref(),
            Some("SHA256:oXkSTlK2w11mHt6CbDTSBo0Y/ccaCrIJgra6XEUSy2Q")
        );
        // The comment lives inside the ciphertext, and no sibling .pub exists
        // at this path — so it is genuinely unavailable, not silently wrong.
        assert_eq!(info.comment, None);
    }

    #[test]
    fn a_leading_bom_does_not_break_detection() {
        let with_bom = format!("\u{feff}{ED25519_PLAIN}");
        assert!(matches!(
            classify(&with_bom, "/tmp/k"),
            KeyInfo::PrivateKey(_)
        ));
    }

    #[test]
    fn crlf_line_endings_still_parse() {
        let crlf = ED25519_PLAIN.replace('\n', "\r\n");
        assert!(matches!(classify(&crlf, "/tmp/k"), KeyInfo::PrivateKey(_)));
    }

    #[test]
    fn picking_the_pub_file_is_reported_with_the_private_key_to_use_instead() {
        let pub_line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINIGHv1HaSH4B3H9hNv25nFEGu3XQYskUMNsrbwnJ0Y8 me@laptop\n";
        let KeyInfo::PublicKey {
            algorithm,
            comment,
            private_key_guess,
        } = classify(pub_line, "/home/me/.ssh/id_ed25519.pub")
        else {
            panic!("expected a public key");
        };
        assert_eq!(algorithm, "Ed25519");
        assert_eq!(comment.as_deref(), Some("me@laptop"));
        assert_eq!(private_key_guess.as_deref(), Some("/home/me/.ssh/id_ed25519"));
    }

    #[test]
    fn dsa_is_rejected_with_a_reason_rather_than_offered() {
        let KeyInfo::Unsupported { reason } =
            classify("-----BEGIN DSA PRIVATE KEY-----\nMIIB\n", "/tmp/id_dsa")
        else {
            panic!("expected DSA to be unsupported");
        };
        assert!(reason.contains("OpenSSH 10.0"), "got: {reason}");
    }

    #[test]
    fn legacy_pkcs1_rsa_is_recognised_without_a_fingerprint() {
        let KeyInfo::PrivateKey(info) =
            classify("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n", "/tmp/id_rsa")
        else {
            panic!("expected a private key");
        };
        assert_eq!(info.algorithm_id, "rsa");
        assert_eq!(info.format, "pkcs1");
        // Nothing outside the header is readable in this format.
        assert_eq!(info.fingerprint, None);
        assert!(info.warning.is_some());
    }

    #[test]
    fn encrypted_pkcs8_is_flagged_as_needing_a_passphrase() {
        let KeyInfo::PrivateKey(info) = classify(
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBO\n",
            "/tmp/k",
        ) else {
            panic!("expected a private key");
        };
        assert!(info.encrypted);
    }

    #[test]
    fn a_ppk_header_block_is_read_even_though_the_body_is_encrypted() {
        let ppk = "PuTTY-User-Key-File-3: ssh-ed25519\n\
                   Encryption: aes256-cbc\n\
                   Comment: work-laptop\n\
                   Public-Lines: 2\n\
                   AAAAC3NzaC1lZDI1NTE5\n";
        let KeyInfo::PrivateKey(info) = classify(ppk, "/tmp/key.ppk") else {
            panic!("expected a private key");
        };
        assert_eq!(info.format, "ppk");
        assert_eq!(info.algorithm_id, "ed25519");
        assert!(info.encrypted);
        assert_eq!(info.comment.as_deref(), Some("work-laptop"));
    }

    #[test]
    fn random_text_is_not_mistaken_for_a_key() {
        let KeyInfo::NotAKey { .. } = classify("hello world\n", "/tmp/notes.txt") else {
            panic!("expected NotAKey");
        };
    }

    #[test]
    fn a_missing_file_reports_the_path_rather_than_a_parse_error() {
        let KeyInfo::Unreadable { reason } = inspect("/nonexistent/shellmux/key") else {
            panic!("expected Unreadable");
        };
        assert!(reason.contains("not found"), "got: {reason}");
    }
}
