use russh::{Channel, ChannelId, ChannelMsg};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const CHUNK: usize = 32 * 1024;

/// Joins an SSH channel with a local stream in both directions.
///
/// Shared by local forward (-L, stream is the TcpStream just accepted) and
/// remote forward (-R, stream is the TcpStream just connected to the local
/// service). Generic over the message type so it works for both client and
/// server channels.
pub async fn splice<M, S>(mut channel: Channel<M>, mut stream: S) -> std::io::Result<()>
where
    M: From<(ChannelId, ChannelMsg)> + Send + Sync + 'static,
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut stream_closed = false;

    loop {
        tokio::select! {
            read = stream.read(&mut buf), if !stream_closed => match read {
                Ok(0) => {
                    stream_closed = true;
                    let _ = channel.eof().await;
                }
                Ok(n) => {
                    if channel.data(&buf[..n]).await.is_err() {
                        break;
                    }
                }
                Err(e) => return Err(e),
            },
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { ref data }) => stream.write_all(data).await?,
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            },
        }
    }

    let _ = stream.flush().await;
    Ok(())
}
