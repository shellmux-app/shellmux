use serde::Serialize;

/// Error returned to the frontend. Variants carry extra data (host key) so
/// the UI can show a confirmation modal instead of just a text string.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{kind} with id {id} not found")]
    NotFound { kind: &'static str, id: String },

    #[error("host key for {host}:{port} is not trusted")]
    HostKeyUnknown {
        host: String,
        port: u16,
        fingerprint: String,
        algo: String,
    },

    #[error("host key for {host}:{port} has changed — possible MITM")]
    HostKeyMismatch {
        host: String,
        port: u16,
        expected: String,
        actual: String,
    },

    #[error("authentication failed: {0}")]
    Auth(String),

    #[error("jump host chain too long (max {max} hops)")]
    JumpChainTooDeep { max: usize },

    #[error("session {0} does not exist")]
    NoSession(String),

    #[error("ssh: {0}")]
    Ssh(String),

    #[error("sftp: {0}")]
    Sftp(String),

    #[error("tunnel: {0}")]
    Tunnel(String),

    #[error("pty: {0}")]
    Pty(String),

    #[error("vault: {0}")]
    Vault(String),

    #[error("keychain: {0}")]
    Keychain(String),

    #[error("io: {0}")]
    Io(String),

    #[error("{0}")]
    Invalid(String),
}

pub type AppResult<T> = Result<T, AppError>;

/// Tauri requires errors to be serializable. Uses a tagged shape so the
/// frontend can `switch` on `kind` and read the extra field.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 3)?;
        st.serialize_field("message", &self.to_string())?;
        match self {
            AppError::HostKeyUnknown {
                host,
                port,
                fingerprint,
                algo,
            } => {
                st.serialize_field("kind", "hostKeyUnknown")?;
                st.serialize_field(
                    "data",
                    &serde_json::json!({
                        "host": host, "port": port,
                        "fingerprint": fingerprint, "algo": algo,
                    }),
                )?;
            }
            AppError::HostKeyMismatch {
                host,
                port,
                expected,
                actual,
            } => {
                st.serialize_field("kind", "hostKeyMismatch")?;
                st.serialize_field(
                    "data",
                    &serde_json::json!({
                        "host": host, "port": port,
                        "expected": expected, "actual": actual,
                    }),
                )?;
            }
            AppError::Auth(_) => {
                st.serialize_field("kind", "auth")?;
                st.serialize_field("data", &serde_json::Value::Null)?;
            }
            _ => {
                st.serialize_field("kind", "generic")?;
                st.serialize_field("data", &serde_json::Value::Null)?;
            }
        }
        st.end()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Vault(e.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Keychain(e.to_string())
    }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::Ssh(e.to_string())
    }
}

impl From<russh::keys::Error> for AppError {
    fn from(e: russh::keys::Error) -> Self {
        AppError::Ssh(format!("key: {e}"))
    }
}

impl From<russh_sftp::client::error::Error> for AppError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        AppError::Sftp(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}
