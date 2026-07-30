//! Dynamic forward (-D): the client speaks SOCKS5 to Shellmux, and Shellmux opens
//! a direct-tcpip channel to the destination the client declares in each connection.

mod common;

use std::time::Duration;

use common::{spawn_server, temp_vault_with_host};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use shellmux_lib::pipe::splice;
use shellmux_lib::socks;
use shellmux_lib::ssh::connect_host;

/// Target service: returns the uppercased string.
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
                    if socket.write_all(&buf[..n].to_ascii_uppercase()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    port
}

/// SOCKS5 port that runs the exact flow of `tunnel::start_listener` in dynamic mode.
async fn spawn_socks_proxy(link: std::sync::Arc<shellmux_lib::ssh::SshLink>) -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        while let Ok((mut socket, origin)) = listener.accept().await {
            let link = link.clone();
            tokio::spawn(async move {
                let Ok(target) = socks::accept_connect(&mut socket).await else {
                    return;
                };
                let channel = match link
                    .open_direct_tcpip(
                        &target.host,
                        target.port,
                        &origin.ip().to_string(),
                        origin.port(),
                    )
                    .await
                {
                    Ok(channel) => channel,
                    Err(_) => {
                        let _ = socks::reply_failure(&mut socket).await;
                        return;
                    }
                };
                if socks::reply_success(&mut socket).await.is_ok() {
                    let _ = splice(channel, socket).await;
                }
            });
        }
    });

    port
}

/// Minimal SOCKS5 client: greeting + CONNECT to 127.0.0.1:port.
async fn socks_connect(proxy_port: u16, target_port: u16) -> TcpStream {
    let mut stream = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    stream.write_all(&[0x05, 0x01, 0x00]).await.unwrap();

    let mut greeting = [0u8; 2];
    stream.read_exact(&mut greeting).await.unwrap();
    assert_eq!(greeting, [0x05, 0x00], "proxy must choose no-auth");

    let mut request = vec![0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1];
    request.extend_from_slice(&target_port.to_be_bytes());
    stream.write_all(&request).await.unwrap();

    let mut reply = [0u8; 10];
    stream.read_exact(&mut reply).await.unwrap();
    assert_eq!(reply[1], 0x00, "SOCKS reply must report success");

    stream
}

#[tokio::test]
async fn socks5_proxy_carries_traffic_to_the_target_the_client_asked_for() {
    // Arrange
    let server = spawn_server(true).await;
    let service_port = spawn_upcase_service().await;
    let fx = temp_vault_with_host(server.port);
    fx.vault
        .put_known_host("127.0.0.1", server.port, "ssh-ed25519", &server.fingerprint)
        .unwrap();
    let link = connect_host(fx.vault.clone(), "h1").await.unwrap();
    let proxy_port = spawn_socks_proxy(link).await;

    // Act
    let mut client = socks_connect(proxy_port, service_port).await;
    client.write_all(b"through socks").await.unwrap();

    let mut buf = vec![0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buf))
        .await
        .expect("timed out waiting for response")
        .unwrap();

    // Assert
    assert_eq!(&buf[..n], b"THROUGH SOCKS");
}

#[tokio::test]
async fn two_socks_clients_can_reach_two_different_targets_on_one_connection() {
    let server = spawn_server(true).await;
    let service_a = spawn_upcase_service().await;
    let service_b = spawn_upcase_service().await;
    let fx = temp_vault_with_host(server.port);
    fx.vault
        .put_known_host("127.0.0.1", server.port, "ssh-ed25519", &server.fingerprint)
        .unwrap();
    let link = connect_host(fx.vault.clone(), "h1").await.unwrap();
    let proxy_port = spawn_socks_proxy(link).await;

    // What sets dynamic forward apart: the destination is declared by each
    // connection itself, so one SOCKS port can serve multiple different destinations.
    let mut first = socks_connect(proxy_port, service_a).await;
    let mut second = socks_connect(proxy_port, service_b).await;

    first.write_all(b"one").await.unwrap();
    second.write_all(b"two").await.unwrap();

    let mut buf_a = vec![0u8; 16];
    let mut buf_b = vec![0u8; 16];
    let na = tokio::time::timeout(Duration::from_secs(5), first.read(&mut buf_a))
        .await
        .unwrap()
        .unwrap();
    let nb = tokio::time::timeout(Duration::from_secs(5), second.read(&mut buf_b))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(&buf_a[..na], b"ONE");
    assert_eq!(&buf_b[..nb], b"TWO");
}
