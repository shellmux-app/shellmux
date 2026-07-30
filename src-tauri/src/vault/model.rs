use serde::{Deserialize, Serialize};

/// A host group, nestable: `Production / eu-west / web`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub sort: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    /// Uses the running ssh-agent (SSH_AUTH_SOCK).
    Agent,
    /// Private key on disk; its passphrase (if any) lives in the keychain.
    PrivateKey,
    /// Password lives in the keychain.
    Password,
}

impl AuthKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthKind::Agent => "agent",
            AuthKind::PrivateKey => "privateKey",
            AuthKind::Password => "password",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "privateKey" => AuthKind::PrivateKey,
            "password" => AuthKind::Password,
            _ => AuthKind::Agent,
        }
    }
}

/// Identity is separate from host so multiple VPSes can share one key.
/// `has_secret` is a display-only flag — the real value lives in the OS keychain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub auth_kind: AuthKind,
    pub username: Option<String>,
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub has_secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub group_id: Option<String>,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub identity_id: Option<String>,
    pub jump_host_id: Option<String>,
    pub theme: Option<String>,
    pub color_tag: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub sort: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub body: String,
    pub group_id: Option<String>,
    #[serde(default)]
    pub send_newline: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TunnelKind {
    /// -L: local port → a service on the remote side.
    Local,
    /// -R: port on the remote → a service on our own machine.
    Remote,
    /// -D: local SOCKS5 proxy, destination declared per-connection.
    Dynamic,
}

impl TunnelKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TunnelKind::Local => "local",
            TunnelKind::Remote => "remote",
            TunnelKind::Dynamic => "dynamic",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "remote" => TunnelKind::Remote,
            "dynamic" => TunnelKind::Dynamic,
            _ => TunnelKind::Local,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSpec {
    pub id: String,
    pub host_id: String,
    pub name: String,
    pub kind: TunnelKind,
    /// Defaults to 127.0.0.1 — opening it up to the LAN requires editing this by hand.
    pub bind_addr: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub algo: String,
    pub fingerprint: String,
    pub added_at: i64,
}
