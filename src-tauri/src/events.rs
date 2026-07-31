use serde::Serialize;

pub const EV_DATA: &str = "session:data";
pub const EV_CLOSED: &str = "session:closed";
pub const EV_TUNNEL: &str = "tunnel:state";
pub const EV_TRANSFER: &str = "sftp:transfer";

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

/// Progress for one queued SFTP transfer. `bytes_total` is `None` when the
/// remote didn't report a size up front (rare, but `stat` can fail on some
/// servers) — the UI falls back to a plain byte counter instead of a bar.
///
/// Carries progress only. Whether a transfer *ended*, and how, comes from
/// the `sftp_upload`/`sftp_download` command's own return value — one source
/// of truth. An earlier version also emitted a terminal event here, which
/// raced: the queue advanced on the settled promise but flipped status on
/// the event, so whichever arrived second found the other still pending and
/// the queue stalled. Commands can also fail before any transfer starts
/// (e.g. the SFTP channel won't open), where no event would ever be sent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    pub transfer_id: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
}
