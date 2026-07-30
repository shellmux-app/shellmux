//! Jump host chain: the destination host is only reachable through the bastion.
//!
//! The bastion opens a direct-tcpip channel to the destination server; the client
//! must build the chain correctly and keep the bastion connection alive for the
//! whole lifetime of the child session.

mod common;

use std::sync::Arc;

use common::{first_data, host_at, spawn_server, temp_vault_with_key};
use shellmux_lib::ssh::connect_host;
use shellmux_lib::vault::Vault;

struct Chain {
    _dir: tempfile::TempDir,
    vault: Arc<Vault>,
}

/// bastion (allows forwarding) → target. Both host keys are already trusted.
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
        .expect("must be able to connect through the bastion");

    // Being able to open a channel means the bastion connection is still alive — if
    // the bastion's handle were dropped, the underlying direct-tcpip channel would
    // have died with it.
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
    // This kind of configuration (a host pointing at itself) must not hang the app
    // via infinite recursion.
    let bastion = chain.vault.get_host("bastion").unwrap();
    chain
        .vault
        .upsert_host(&shellmux_lib::vault::Host {
            jump_host_id: Some("bastion".into()),
            ..bastion
        })
        .unwrap();

    let link = connect_host(chain.vault.clone(), "bastion").await;

    assert!(link.is_ok(), "must connect directly instead of recursing");
}

#[tokio::test]
async fn unreachable_jump_host_fails_instead_of_silently_connecting_direct() {
    let chain = build_chain().await;
    // Bastion points to a port that's certainly not being listened on.
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
        "if the bastion is dead, the target must not be considered a successful connection"
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
    // Only trust the bastion — each layer of the chain must verify independently.
    fx.vault
        .put_known_host("127.0.0.1", bastion.port, "ssh-ed25519", &bastion.fingerprint)
        .unwrap();

    let result = connect_host(fx.vault.clone(), "target").await;

    assert!(
        matches!(
            result,
            Err(shellmux_lib::error::AppError::HostKeyUnknown { .. })
        ),
        "trusting the bastion must not imply trusting the target"
    );
}
