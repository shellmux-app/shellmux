use serde::{Deserialize, Serialize};

/// Nhóm host, lồng nhau được: `Production / eu-west / web`.
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
    /// Dùng ssh-agent đang chạy (SSH_AUTH_SOCK).
    Agent,
    /// Private key trên đĩa, passphrase (nếu có) nằm trong keychain.
    PrivateKey,
    /// Password nằm trong keychain.
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

/// Identity tách khỏi host để nhiều VPS dùng chung một key.
/// `has_secret` là cờ hiển thị — giá trị thật nằm trong OS keychain.
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
    /// -L: cổng local → dịch vụ phía remote.
    Local,
    /// -R: cổng trên remote → dịch vụ phía máy mình.
    Remote,
    /// -D: SOCKS5 proxy local, đích do từng kết nối tự khai.
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
    /// Mặc định 127.0.0.1 — muốn mở ra LAN phải sửa tay.
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
