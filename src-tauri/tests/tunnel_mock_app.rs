//! `TunnelRegistry` exercised against a real SSH server + real TCP traffic,
//! using `tauri::test::mock_app()` for the `AppHandle` it needs to emit
//! `tunnel:state` events — this is what genericizing `TunnelRegistry::start`
//! over `R: tauri::Runtime` was for; before that it only compiled against
//! the real `Wry` runtime.

mod common;

use std::time::Duration;

use common::{spawn_server, temp_vault_with_host};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use shellmux_lib::ssh::connect_host;
use shellmux_lib::tunnel::TunnelRegistry;
use shellmux_lib::vault::{TunnelKind, TunnelSpec};

/// "Remote-side" service: TCP server that replies with the uppercased string.
async fn spawn_upcase_service() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 1024];
                while let Ok(n) = socket.read(&mut buf).await {
                    if n == 0 {
                        return;
                    }
                    let upper = buf[..n].to_ascii_uppercase();
                    if socket.write_all(&upper).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    port
}

fn local_tunnel_spec(target_port: u16) -> TunnelSpec {
    TunnelSpec {
        id: "t1".into(),
        host_id: "h1".into(),
        name: "test tunnel".into(),
        kind: TunnelKind::Local,
        bind_addr: "127.0.0.1".into(),
        bind_port: 0,
        target_host: "127.0.0.1".into(),
        target_port,
        auto_start: false,
    }
}

#[tokio::test]
async fn started_tunnel_carries_traffic_and_is_active_until_stopped() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let server = spawn_server(true).await;
    let service_port = spawn_upcase_service().await;
    let fx = temp_vault_with_host(server.port);
    fx.vault
        .put_known_host("127.0.0.1", server.port, "ssh-ed25519", &server.fingerprint)
        .unwrap();
    let link = connect_host(fx.vault.clone(), "h1").await.unwrap();

    let registry = TunnelRegistry::new();
    let spec = local_tunnel_spec(service_port);

    let bound_port = registry
        .start(handle.clone(), "s1", link.clone(), &spec)
        .await
        .expect("tunnel should start");
    assert!(registry.is_active("t1"));
    assert_eq!(registry.ids_for_session("s1"), vec!["t1".to_string()]);

    let mut client = TcpStream::connect(("127.0.0.1", bound_port)).await.unwrap();
    client.write_all(b"through the tunnel").await.unwrap();
    let mut buf = vec![0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buf))
        .await
        .expect("timed out waiting for data through the tunnel")
        .unwrap();
    assert_eq!(&buf[..n], b"THROUGH THE TUNNEL");

    registry
        .stop(&handle, "s1", "t1")
        .await
        .expect("tunnel should stop");
    assert!(!registry.is_active("t1"));

    // A new connection attempt must fail once the listener is torn down.
    assert!(TcpStream::connect(("127.0.0.1", bound_port)).await.is_err());
}

#[tokio::test]
async fn starting_the_same_tunnel_id_twice_is_rejected() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let server = spawn_server(true).await;
    let service_port = spawn_upcase_service().await;
    let fx = temp_vault_with_host(server.port);
    fx.vault
        .put_known_host("127.0.0.1", server.port, "ssh-ed25519", &server.fingerprint)
        .unwrap();
    let link = connect_host(fx.vault.clone(), "h1").await.unwrap();

    let registry = TunnelRegistry::new();
    let spec = local_tunnel_spec(service_port);

    registry
        .start(handle.clone(), "s1", link.clone(), &spec)
        .await
        .expect("first start should succeed");

    let result = registry.start(handle, "s1", link, &spec).await;

    assert!(result.is_err(), "starting the same tunnel id twice must be rejected");
}

#[tokio::test]
async fn stop_for_session_only_stops_that_sessions_tunnels() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let server = spawn_server(true).await;
    let service_port = spawn_upcase_service().await;
    let fx = temp_vault_with_host(server.port);
    fx.vault
        .put_known_host("127.0.0.1", server.port, "ssh-ed25519", &server.fingerprint)
        .unwrap();
    let link = connect_host(fx.vault.clone(), "h1").await.unwrap();

    let registry = TunnelRegistry::new();
    let mut spec_a = local_tunnel_spec(service_port);
    spec_a.id = "ta".into();
    let mut spec_b = local_tunnel_spec(service_port);
    spec_b.id = "tb".into();

    registry
        .start(handle.clone(), "session-a", link.clone(), &spec_a)
        .await
        .unwrap();
    registry
        .start(handle.clone(), "session-b", link, &spec_b)
        .await
        .unwrap();

    registry.stop_for_session(&handle, "session-a").await;

    assert!(!registry.is_active("ta"));
    assert!(registry.is_active("tb"));
}
