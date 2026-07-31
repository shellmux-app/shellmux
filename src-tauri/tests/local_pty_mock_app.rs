//! `session::local::start` exercised against a real PTY-backed shell process,
//! using `tauri::test::mock_app()` for the `AppHandle` it needs to emit
//! `session:data`/`session:closed` events.

use std::sync::mpsc as std_mpsc;
use std::time::{Duration, Instant};

use base64::Engine;
use tauri::Listener;

use shellmux_lib::events::EV_DATA;
use shellmux_lib::session::{local, Outbound};

/// Collects every `session:data` payload's decoded bytes until `marker`
/// shows up or the deadline passes, returning what was collected either way.
fn collect_until(rx: &std_mpsc::Receiver<String>, marker: &str, timeout: Duration) -> String {
    let engine = base64::engine::general_purpose::STANDARD;
    let deadline = Instant::now() + timeout;
    let mut collected = String::new();
    while Instant::now() < deadline && !collected.contains(marker) {
        let Ok(remaining) = deadline.checked_duration_since(Instant::now()).ok_or(()) else {
            break;
        };
        if let Ok(chunk_b64) = rx.recv_timeout(remaining.min(Duration::from_millis(200))) {
            if let Ok(bytes) = engine.decode(chunk_b64) {
                collected.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
    }
    collected
}

#[test]
fn shell_output_reaches_the_frontend_through_emitted_data_events() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let (tx_data, rx_data) = std_mpsc::channel::<String>();
    handle.listen_any(EV_DATA, move |event| {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            if let Some(data) = payload.get("data").and_then(|v| v.as_str()) {
                let _ = tx_data.send(data.to_string());
            }
        }
    });

    let tx = local::start(handle, "s1".into(), 0, None, None, 80, 24)
        .expect("pty should start");

    tx.try_send(Outbound::Data(b"echo PTY_TEST_MARKER\n".to_vec()))
        .expect("writing to the pty should succeed");

    let output = collect_until(&rx_data, "PTY_TEST_MARKER", Duration::from_secs(5));
    assert!(
        output.contains("PTY_TEST_MARKER"),
        "expected the echoed marker in the pty output, got: {output:?}"
    );

    tx.try_send(Outbound::Close).unwrap();
}

#[test]
fn resize_does_not_crash_or_stop_the_session() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let (tx_data, rx_data) = std_mpsc::channel::<String>();
    handle.listen_any(EV_DATA, move |event| {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            if let Some(data) = payload.get("data").and_then(|v| v.as_str()) {
                let _ = tx_data.send(data.to_string());
            }
        }
    });

    let tx = local::start(handle, "s1".into(), 0, None, None, 80, 24)
        .expect("pty should start");

    tx.try_send(Outbound::Resize { cols: 120, rows: 40 }).unwrap();
    tx.try_send(Outbound::Data(b"echo AFTER_RESIZE_MARKER\n".to_vec()))
        .unwrap();

    let output = collect_until(&rx_data, "AFTER_RESIZE_MARKER", Duration::from_secs(5));
    assert!(
        output.contains("AFTER_RESIZE_MARKER"),
        "session should keep working after a resize, got: {output:?}"
    );

    tx.try_send(Outbound::Close).unwrap();
}
