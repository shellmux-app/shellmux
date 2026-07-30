//! Local forward (-L): data must flow from the local socket, through the
//! direct-tcpip channel, to the correct service on the remote side.
//!
//! The test uses `SshLink::open_direct_tcpip` + `pipe::splice` — exactly the two
//! things `tunnel::start_local` calls internally, but without needing Tauri's
//! `AppHandle`.

mod common;

use std::time::Duration;

use common::{spawn_server, temp_vault_with_host};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use shellmux_lib::pipe::splice;
use shellmux_lib::ssh::connect_host;

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

#[tokio::test]
async fn local_forward_carries_traffic_to_the_remote_service() {
    // Arrange: SSH server that allows forwarding + target service + trusted host.
    let server = spawn_server(true).await;
    let service_port = spawn_upcase_service().await;
    let fx = temp_vault_with_host(server.port);
    fx.vault
        .put_known_host("127.0.0.1", server.port, "ssh-ed25519", &server.fingerprint)
        .unwrap();
    let link = connect_host(fx.vault.clone(), "h1").await.unwrap();

    // Local listener plays the role of the forwarded port.
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let local_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (socket, origin) = listener.accept().await.unwrap();
        let channel = link
            .open_direct_tcpip(
                "127.0.0.1",
                service_port,
                &origin.ip().to_string(),
                origin.port(),
            )
            .await
            .expect("open direct-tcpip");
        let _ = splice(channel, socket).await;
    });

    // Act
    let mut client = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
    client.write_all(b"hello tunnel").await.unwrap();

    let mut buf = vec![0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buf))
        .await
        .expect("timed out waiting for response through tunnel")
        .unwrap();

    // Assert
    assert_eq!(&buf[..n], b"HELLO TUNNEL");
}

#[tokio::test]
async fn direct_tcpip_is_rejected_when_the_server_forbids_forwarding() {
    let server = spawn_server(false).await;
    let fx = temp_vault_with_host(server.port);
    fx.vault
        .put_known_host("127.0.0.1", server.port, "ssh-ed25519", &server.fingerprint)
        .unwrap();
    let link = connect_host(fx.vault.clone(), "h1").await.unwrap();

    let result = link.open_direct_tcpip("127.0.0.1", 9, "127.0.0.1", 1234).await;

    assert!(result.is_err(), "if the server refuses, the client must report an error");
}
