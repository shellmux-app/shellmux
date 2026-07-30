//! Đường đi bảo mật quan trọng nhất: host key phải được xác nhận tường minh.

mod common;

use std::sync::Arc;

use common::{first_data, spawn_server, temp_vault_with_host};
use shellmux_lib::error::AppError;
use shellmux_lib::ssh::connect_host;
use shellmux_lib::vault::Vault;

struct Fixture {
    _dir: tempfile::TempDir,
    vault: Arc<Vault>,
    port: u16,
    server_fingerprint: String,
}

async fn fixture() -> Fixture {
    let server = spawn_server(false).await;
    let vault_fx = temp_vault_with_host(server.port);
    Fixture {
        _dir: vault_fx.dir,
        vault: vault_fx.vault,
        port: server.port,
        server_fingerprint: server.fingerprint,
    }
}

#[tokio::test]
async fn first_connect_refuses_unknown_host_key_and_reports_the_fingerprint() {
    // Arrange
    let fx = fixture().await;

    // Act
    let Err(err) = connect_host(fx.vault.clone(), "h1").await else {
        panic!("host key chưa lưu thì phải bị từ chối");
    };

    // Assert
    match err {
        AppError::HostKeyUnknown {
            fingerprint, port, ..
        } => {
            assert_eq!(fingerprint, fx.server_fingerprint);
            assert_eq!(port, fx.port);
        }
        other => panic!("mong đợi HostKeyUnknown, nhận {other:?}"),
    }
}

#[tokio::test]
async fn connect_succeeds_after_the_key_is_explicitly_trusted() {
    let fx = fixture().await;
    fx.vault
        .put_known_host("127.0.0.1", fx.port, "ssh-ed25519", &fx.server_fingerprint)
        .unwrap();

    let link = connect_host(fx.vault.clone(), "h1")
        .await
        .expect("đã tin cậy key thì phải kết nối được");

    // Chứng minh connection dùng được thật, không chỉ handshake xong.
    let channel = link.open_session().await.expect("mở session channel");
    channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .expect("pty");
    channel.request_shell(true).await.expect("shell");
}

#[tokio::test]
async fn changed_host_key_is_reported_as_mismatch_not_as_a_new_host() {
    let fx = fixture().await;
    fx.vault
        .put_known_host("127.0.0.1", fx.port, "ssh-ed25519", "SHA256:mot-key-khac")
        .unwrap();

    let Err(err) = connect_host(fx.vault.clone(), "h1").await else {
        panic!("key khác với bản đã lưu phải bị chặn");
    };

    match err {
        AppError::HostKeyMismatch {
            expected, actual, ..
        } => {
            assert_eq!(expected, "SHA256:mot-key-khac");
            assert_eq!(actual, fx.server_fingerprint);
        }
        other => panic!("mong đợi HostKeyMismatch, nhận {other:?}"),
    }
}

#[tokio::test]
async fn trusting_one_port_does_not_trust_the_same_ip_on_another_port() {
    let fx = fixture().await;
    // Fingerprint đúng nhưng gắn cho cổng khác — vẫn phải bị coi là host mới.
    fx.vault
        .put_known_host("127.0.0.1", fx.port + 1, "ssh-ed25519", &fx.server_fingerprint)
        .unwrap();

    let result = connect_host(fx.vault.clone(), "h1").await;

    assert!(
        matches!(result, Err(AppError::HostKeyUnknown { .. })),
        "known_hosts phải tính cả port"
    );
}

#[tokio::test]
async fn shell_channel_round_trips_data_over_the_trusted_connection() {
    let fx = fixture().await;
    fx.vault
        .put_known_host("127.0.0.1", fx.port, "ssh-ed25519", &fx.server_fingerprint)
        .unwrap();

    let link = connect_host(fx.vault.clone(), "h1").await.unwrap();
    let mut channel = link.open_session().await.unwrap();
    channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .unwrap();
    channel.request_shell(true).await.unwrap();
    channel.data(&b"ping\n"[..]).await.unwrap();

    assert_eq!(first_data(&mut channel).await.as_deref(), Some(&b"ping\n"[..]));
}
