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

/// How a host proves who it is. This lives on the *host*, not on a shared
/// credential: a password belongs to one account on one machine, whereas a key
/// is deliberately reused across many. Keeping both in one shared object was
/// the old design, and it forced every password through a detour and let the
/// credential silently override the host's username.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    /// Offer whatever the running ssh-agent holds (`SSH_AUTH_SOCK`).
    Agent,
    /// Password for this host, stored in the OS keychain under the host id.
    Password,
    /// A saved private key — the host's `identity_id` says which.
    Key,
}

impl AuthKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthKind::Agent => "agent",
            AuthKind::Password => "password",
            AuthKind::Key => "key",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "password" => AuthKind::Password,
            "key" => AuthKind::Key,
            _ => AuthKind::Agent,
        }
    }
}

/// A reusable private key. Deliberately *only* a key: it carries no username,
/// because one key is normally used with different accounts on different hosts
/// (`ubuntu` here, `deploy` there) and an override on the credential would
/// force a duplicate identity per host. `has_secret` means "a passphrase for
/// this key is in the keychain" — the passphrase itself never comes back out.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub private_key_path: String,
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
    #[serde(default = "default_auth_kind")]
    pub auth_kind: AuthKind,
    /// Which saved key to use. Only meaningful when `auth_kind` is `Key`.
    pub identity_id: Option<String>,
    pub jump_host_id: Option<String>,
    pub theme: Option<String>,
    pub color_tag: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub sort: i64,
    /// Forward this host's own auth to it: the system ssh-agent when
    /// `auth_kind` is `Agent`, or a decrypted-in-memory copy of just this
    /// host's key when `auth_kind` is `Key`. Off by default — anything on
    /// the other end can ask for a signature while the channel is open.
    #[serde(default)]
    pub agent_forward: bool,
}

fn default_auth_kind() -> AuthKind {
    AuthKind::Agent
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
