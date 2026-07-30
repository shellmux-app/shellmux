//! Chuỗi jump host: host đích chỉ đến được qua bastion.
//!
//! Bastion mở channel direct-tcpip tới server đích; client phải dựng đúng chuỗi
//! và giữ connection bastion sống suốt vòng đời session con.

mod common;

use std::sync::Arc;

use common::{first_data, host_at, spawn_server, temp_vault_with_key};
use shellmux_lib::ssh::connect_host;
use shellmux_lib::vault::Vault;

struct Chain {
    _dir: tempfile::TempDir,
    vault: Arc<Vault>,
}

/// bastion (cho phép forward) → target. Cả hai host key đều đã được tin cậy.
async fn build_chain() -> Chain {
    let bastion = spawn_server(true).await;
    let target = spawn_server(false).await;
    let fx = temp_vault_with_key();

    fx.vault
        .upsert_host(&host_at("bastion", bastion.port, None))
        .unwrap();
    fx.vault
        .upsert_host(&host_at("target", target.port, Some("bastion")))
        .unwrap();
    fx.vault
        .put_known_host("127.0.0.1", bastion.port, "ssh-ed25519", &bastion.fingerprint)
        .unwrap();
    fx.vault
        .put_known_host("127.0.0.1", target.port, "ssh-ed25519", &target.fingerprint)
        .unwrap();

    Chain {
        _dir: fx.dir,
        vault: fx.vault,
    }
}

#[tokio::test]
async fn connects_through_a_jump_host_and_keeps_the_chain_usable() {
    let chain = build_chain().await;

    let link = connect_host(chain.vault.clone(), "target")
        .await
        .expect("phải kết nối được qua bastion");

    // Mở được channel nghĩa là connection bastion vẫn sống — nếu handle của
    // bastion bị drop thì channel direct-tcpip bên dưới đã chết theo.
    let mut channel = link.open_session().await.expect("session channel");
    channel.request_shell(true).await.expect("shell");
    channel.data(&b"via-jump\n"[..]).await.unwrap();

    assert_eq!(
        first_data(&mut channel).await.as_deref(),
        Some(&b"via-jump\n"[..])
    );
}

#[tokio::test]
async fn jump_host_pointing_at_itself_falls_back_to_a_direct_connection() {
    let chain = build_chain().await;
    // Cấu hình kiểu này (host tự trỏ vào chính nó) không được làm treo app
    // bằng đệ quy vô hạn.
    let bastion = chain.vault.get_host("bastion").unwrap();
    chain
        .vault
        .upsert_host(&shellmux_lib::vault::Host {
            jump_host_id: Some("bastion".into()),
            ..bastion
        })
        .unwrap();

    let link = connect_host(chain.vault.clone(), "bastion").await;

    assert!(link.is_ok(), "phải nối trực tiếp thay vì đệ quy");
}

#[tokio::test]
async fn unreachable_jump_host_fails_instead_of_silently_connecting_direct() {
    let chain = build_chain().await;
    // Bastion trỏ tới một cổng chắc chắn không ai nghe.
    let bastion = chain.vault.get_host("bastion").unwrap();
    chain
        .vault
        .upsert_host(&shellmux_lib::vault::Host {
            port: 1,
            ..bastion
        })
        .unwrap();

    let result = connect_host(chain.vault.clone(), "target").await;

    assert!(
        result.is_err(),
        "bastion chết thì target không được coi là kết nối thành công"
    );
}

#[tokio::test]
async fn target_key_must_be_trusted_separately_from_the_bastion_key() {
    let bastion = spawn_server(true).await;
    let target = spawn_server(false).await;
    let fx = temp_vault_with_key();
    fx.vault
        .upsert_host(&host_at("bastion", bastion.port, None))
        .unwrap();
    fx.vault
        .upsert_host(&host_at("target", target.port, Some("bastion")))
        .unwrap();
    // Chỉ tin cậy bastion — mỗi tầng của chuỗi phải verify độc lập.
    fx.vault
        .put_known_host("127.0.0.1", bastion.port, "ssh-ed25519", &bastion.fingerprint)
        .unwrap();

    let result = connect_host(fx.vault.clone(), "target").await;

    assert!(
        matches!(
            result,
            Err(shellmux_lib::error::AppError::HostKeyUnknown { .. })
        ),
        "tin cậy bastion không được kéo theo tin cậy target"
    );
}
