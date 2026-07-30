use serde::Serialize;

pub const EV_DATA: &str = "session:data";
pub const EV_CLOSED: &str = "session:closed";
pub const EV_TUNNEL: &str = "tunnel:state";

/// Byte của terminal không phải UTF-8 hợp lệ nên phải base64 — payload Tauri
/// là JSON, string thô sẽ bị mangle.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedEvent {
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelEvent {
    pub tunnel_id: String,
    pub session_id: String,
    pub active: bool,
    pub message: Option<String>,
}
