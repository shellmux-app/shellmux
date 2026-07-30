//! SOCKS5 tối giản cho dynamic forward (-D).
//!
//! Chỉ hiện thực lệnh CONNECT không xác thực — đúng phần mà `ssh -D` dùng.
//! Không có BIND/UDP ASSOCIATE vì SSH không mang được hai thứ đó.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{AppError, AppResult};

const VERSION: u8 = 0x05;
const AUTH_NONE: u8 = 0x00;
const CMD_CONNECT: u8 = 0x01;

const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;

const REP_SUCCESS: u8 = 0x00;
const REP_CMD_NOT_SUPPORTED: u8 = 0x07;
const REP_ATYP_NOT_SUPPORTED: u8 = 0x08;

/// Đích mà client SOCKS muốn tới — sẽ thành tham số của direct-tcpip channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
}

/// Bắt tay SOCKS5 tới bước nhận được CONNECT. Chưa trả lời client —
/// caller phải mở channel SSH trước rồi mới `reply` thành công hay thất bại,
/// nếu không sẽ báo OK cho một kết nối chưa chắc mở được.
pub async fn accept_connect<S>(stream: &mut S) -> AppResult<Target>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // Greeting: VER | NMETHODS | METHODS...
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await?;
    if head[0] != VERSION {
        return Err(AppError::Tunnel(format!(
            "SOCKS version không hỗ trợ: {}",
            head[0]
        )));
    }
    let mut methods = vec![0u8; head[1] as usize];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&AUTH_NONE) {
        // 0xFF = không có method nào chấp nhận được.
        stream.write_all(&[VERSION, 0xFF]).await?;
        return Err(AppError::Tunnel(
            "client SOCKS đòi xác thực, tunnel này chỉ nhận no-auth".into(),
        ));
    }
    stream.write_all(&[VERSION, AUTH_NONE]).await?;

    // Request: VER | CMD | RSV | ATYP | ADDR | PORT
    let mut request = [0u8; 4];
    stream.read_exact(&mut request).await?;
    if request[0] != VERSION {
        return Err(AppError::Tunnel("SOCKS request sai version".into()));
    }
    if request[1] != CMD_CONNECT {
        reply(stream, REP_CMD_NOT_SUPPORTED).await?;
        return Err(AppError::Tunnel(format!(
            "chỉ hỗ trợ CONNECT, nhận lệnh {}",
            request[1]
        )));
    }

    let host = match request[3] {
        ATYP_IPV4 => {
            let mut octets = [0u8; 4];
            stream.read_exact(&mut octets).await?;
            std::net::Ipv4Addr::from(octets).to_string()
        }
        ATYP_IPV6 => {
            let mut octets = [0u8; 16];
            stream.read_exact(&mut octets).await?;
            std::net::Ipv6Addr::from(octets).to_string()
        }
        ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            stream.read_exact(&mut name).await?;
            String::from_utf8(name)
                .map_err(|_| AppError::Tunnel("tên miền trong SOCKS không phải UTF-8".into()))?
        }
        other => {
            reply(stream, REP_ATYP_NOT_SUPPORTED).await?;
            return Err(AppError::Tunnel(format!("address type lạ: {other}")));
        }
    };

    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await?;

    Ok(Target {
        host,
        port: u16::from_be_bytes(port),
    })
}

pub async fn reply_success<S>(stream: &mut S) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    reply(stream, REP_SUCCESS).await
}

/// Báo lỗi chung (0x01 general failure) khi không mở được channel SSH.
pub async fn reply_failure<S>(stream: &mut S) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    reply(stream, 0x01).await
}

async fn reply<S>(stream: &mut S, code: u8) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // BND.ADDR/BND.PORT để 0 — client không dùng chúng cho CONNECT.
    let frame = [VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0];
    stream.write_all(&frame).await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncReadExt, AsyncWriteExt};

    /// Dựng một "client SOCKS" giả trên duplex stream trong bộ nhớ.
    async fn run_handshake(client_bytes: Vec<u8>) -> (AppResult<Target>, Vec<u8>) {
        let (mut client, mut server) = duplex(1024);
        let writer = tokio::spawn(async move {
            client.write_all(&client_bytes).await.unwrap();
            let mut out = Vec::new();
            // Đọc tới khi server đóng để lấy toàn bộ phản hồi.
            let _ = client.read_to_end(&mut out).await;
            out
        });

        let result = accept_connect(&mut server).await;
        if result.is_ok() {
            reply_success(&mut server).await.unwrap();
        }
        drop(server);

        (result, writer.await.unwrap())
    }

    #[tokio::test]
    async fn accepts_connect_to_an_ipv4_address() {
        // VER,NMETHODS,NOAUTH | VER,CONNECT,RSV,IPV4, 127.0.0.1, 8080
        let bytes = vec![
            0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90,
        ];

        let (result, response) = run_handshake(bytes).await;

        let target = result.expect("handshake phải thành công");
        assert_eq!(target.host, "127.0.0.1");
        assert_eq!(target.port, 8080);
        assert_eq!(response[0..2], [0x05, 0x00], "chọn method no-auth");
        assert_eq!(response[2..4], [0x05, 0x00], "reply thành công");
    }

    #[tokio::test]
    async fn accepts_connect_to_a_domain_name() {
        let mut bytes = vec![0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x03, 11];
        bytes.extend_from_slice(b"example.com");
        bytes.extend_from_slice(&443u16.to_be_bytes());

        let (result, _) = run_handshake(bytes).await;

        let target = result.expect("domain phải parse được");
        assert_eq!(target.host, "example.com");
        assert_eq!(target.port, 443);
    }

    #[tokio::test]
    async fn accepts_connect_to_an_ipv6_address() {
        let mut bytes = vec![0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x04];
        bytes.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
        bytes.extend_from_slice(&22u16.to_be_bytes());

        let (result, _) = run_handshake(bytes).await;

        assert_eq!(result.unwrap().host, "::1");
    }

    #[tokio::test]
    async fn rejects_a_client_that_refuses_no_auth() {
        // Chỉ khai method 0x02 (username/password).
        let bytes = vec![0x05, 0x01, 0x02];

        let (result, response) = run_handshake(bytes).await;

        assert!(result.is_err());
        assert_eq!(response[0..2], [0x05, 0xFF], "phải báo no acceptable methods");
    }

    #[tokio::test]
    async fn rejects_bind_and_udp_commands() {
        // CMD 0x02 = BIND.
        let bytes = vec![0x05, 0x01, 0x00, 0x05, 0x02, 0x00, 0x01, 127, 0, 0, 1, 0, 22];

        let (result, response) = run_handshake(bytes).await;

        assert!(result.is_err());
        assert_eq!(response[2..4], [0x05, REP_CMD_NOT_SUPPORTED]);
    }

    #[tokio::test]
    async fn rejects_a_non_socks5_greeting() {
        // SOCKS4 bắt đầu bằng 0x04.
        let (result, _) = run_handshake(vec![0x04, 0x01, 0x00]).await;

        assert!(result.is_err());
    }
}
