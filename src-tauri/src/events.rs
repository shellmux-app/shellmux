use serde::Serialize;

pub const EV_DATA: &str = "session:data";
pub const EV_CLOSED: &str = "session:closed";
pub const EV_TUNNEL: &str = "tunnel:state";

/// Terminal bytes aren't guaranteed to be valid UTF-8 so they must be
/// base64 — Tauri's payload is JSON, and a raw string would get mangled.
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
    /// The number of times this session has been reconnected. After a
    /// reconnect, the old pump is still shutting down and will emit a late
    /// closed event — the frontend compares generation to ignore it instead
    /// of marking the new session as dead.
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelEvent {
    pub tunnel_id: String,
    pub session_id: String,
    pub active: bool,
    pub message: Option<String>,
}
