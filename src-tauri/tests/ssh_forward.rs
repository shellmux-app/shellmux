//! Local forward (-L): dữ liệu phải chạy từ socket local, qua channel
//! direct-tcpip, tới đúng dịch vụ phía remote.
//!
//! Test dùng `SshLink::open_direct_tcpip` + `pipe::splice` — đúng hai thứ mà
//! `tunnel::start_local` gọi bên trong, nhưng không cần `AppHandle` của Tauri.

mod common;

use std::time::Duration;

use common::{spawn_server, temp_vault_with_host};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use shellmux_lib::pipe::splice;
use shellmux_lib::ssh::connect_host;

/// Dịch vụ "phía remote": TCP server trả lời bằng chuỗi đã in hoa.
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
    // Arrange: server SSH cho phép forward + dịch vụ đích + host đã tin cậy.
    let server = spawn_server(true).await;
    let service_port = spawn_upcase_service().await;
    let fx = temp_vault_with_host(server.port);
    fx.vault
        .put_known_host("127.0.0.1", server.port, "ssh-ed25519", &server.fingerprint)
        .unwrap();
    let link = connect_host(fx.vault.clone(), "h1").await.unwrap();

    // Listener local đóng vai cổng đã forward.
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
            .expect("mở direct-tcpip");
        let _ = splice(channel, socket).await;
    });

    // Act
    let mut client = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
    client.write_all(b"hello tunnel").await.unwrap();

    let mut buf = vec![0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buf))
        .await
        .expect("timeout khi chờ phản hồi qua tunnel")
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

    assert!(result.is_err(), "server từ chối thì client phải báo lỗi");
}
