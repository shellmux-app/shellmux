//! Minimal SOCKS5 for dynamic forward (-D).
//!
//! Only implements the unauthenticated CONNECT command — exactly the part
//! that `ssh -D` uses. No BIND/UDP ASSOCIATE since SSH can't carry those two.

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

/// The destination the SOCKS client wants to reach — becomes the
/// direct-tcpip channel's parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
}

/// SOCKS5 handshake up through receiving CONNECT. Does not reply to the
/// client yet — the caller must open the SSH channel first and only then
/// `reply` success or failure, otherwise it would report OK for a
/// connection that might not actually open.
pub async fn accept_connect<S>(stream: &mut S) -> AppResult<Target>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // Greeting: VER | NMETHODS | METHODS...
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await?;
    if head[0] != VERSION {
        return Err(AppError::Tunnel(format!(
            "unsupported SOCKS version: {}",
            head[0]
        )));
    }
    let mut methods = vec![0u8; head[1] as usize];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&AUTH_NONE) {
        // 0xFF = no acceptable method.
        stream.write_all(&[VERSION, 0xFF]).await?;
        return Err(AppError::Tunnel(
            "SOCKS client demands authentication, this tunnel only accepts no-auth".into(),
        ));
    }
    stream.write_all(&[VERSION, AUTH_NONE]).await?;

    // Request: VER | CMD | RSV | ATYP | ADDR | PORT
    let mut request = [0u8; 4];
    stream.read_exact(&mut request).await?;
    if request[0] != VERSION {
        return Err(AppError::Tunnel("SOCKS request has the wrong version".into()));
    }
    if request[1] != CMD_CONNECT {
        reply(stream, REP_CMD_NOT_SUPPORTED).await?;
        return Err(AppError::Tunnel(format!(
            "only CONNECT is supported, received command {}",
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
                .map_err(|_| AppError::Tunnel("domain name in SOCKS is not valid UTF-8".into()))?
        }
        other => {
            reply(stream, REP_ATYP_NOT_SUPPORTED).await?;
            return Err(AppError::Tunnel(format!("unknown address type: {other}")));
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

/// Reports a general error (0x01 general failure) when the SSH channel fails to open.
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
    // BND.ADDR/BND.PORT left at 0 — the client doesn't use them for CONNECT.
    let frame = [VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0];
    stream.write_all(&frame).await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncReadExt, AsyncWriteExt};

    /// Builds a fake "SOCKS client" over an in-memory duplex stream.
    async fn run_handshake(client_bytes: Vec<u8>) -> (AppResult<Target>, Vec<u8>) {
        let (mut client, mut server) = duplex(1024);
        let writer = tokio::spawn(async move {
            client.write_all(&client_bytes).await.unwrap();
            let mut out = Vec::new();
            // Read until the server closes to get the full response.
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

        let target = result.expect("handshake must succeed");
        assert_eq!(target.host, "127.0.0.1");
        assert_eq!(target.port, 8080);
        assert_eq!(response[0..2], [0x05, 0x00], "selects no-auth method");
        assert_eq!(response[2..4], [0x05, 0x00], "successful reply");
    }

    #[tokio::test]
    async fn accepts_connect_to_a_domain_name() {
        let mut bytes = vec![0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x03, 11];
        bytes.extend_from_slice(b"example.com");
        bytes.extend_from_slice(&443u16.to_be_bytes());

        let (result, _) = run_handshake(bytes).await;

        let target = result.expect("domain must parse");
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
        // Only declares method 0x02 (username/password).
        let bytes = vec![0x05, 0x01, 0x02];

        let (result, response) = run_handshake(bytes).await;

        assert!(result.is_err());
        assert_eq!(response[0..2], [0x05, 0xFF], "must report no acceptable methods");
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
        // SOCKS4 starts with 0x04.
        let (result, _) = run_handshake(vec![0x04, 0x01, 0x00]).await;

        assert!(result.is_err());
    }
}
