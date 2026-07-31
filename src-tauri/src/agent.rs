//! SSH agent forwarding: bridges a server-initiated `auth-agent@openssh.com`
//! channel to either the system's ssh-agent or an in-process agent seeded
//! with exactly one key.
//!
//! The in-process case reuses russh's own agent *client* and *server*
//! implementations for the wire protocol and the actual signing — this
//! module is plumbing (seed one key, splice bytes), not cryptography.

use std::sync::Arc;

use futures::stream;
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::server::{self, Agent};
use russh::keys::PrivateKey;
use russh::{Channel, ChannelId, ChannelMsg};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::pipe::splice;

/// What a session's forwarded `auth-agent` requests should be bridged to.
#[derive(Clone)]
pub enum AgentBacking {
    /// `agent_forward` is off for this host, or there's nothing to forward.
    None,
    /// Splice straight through to the local system's `SSH_AUTH_SOCK` — used
    /// when this connection itself authenticated via the system agent.
    System,
    /// Serve exactly one key — the one this connection authenticated with —
    /// from an in-process agent. Nothing else in the vault is exposed to
    /// whatever is on the other end of the forwarded channel.
    Key(Arc<PrivateKey>),
}

#[derive(Clone)]
struct NoConfirm;
impl Agent for NoConfirm {}

/// Accepts a forwarded agent channel and bridges it to `backing`. Runs until
/// the remote side closes the channel. Errors are logged, not propagated —
/// a forwarding hiccup must not tear down the session it rides on.
pub async fn bridge<M>(channel: Channel<M>, backing: AgentBacking)
where
    M: From<(ChannelId, ChannelMsg)> + Send + Sync + 'static,
{
    let result = match backing {
        AgentBacking::None => return,
        AgentBacking::System => bridge_system(channel).await,
        AgentBacking::Key(key) => bridge_key(channel, key).await,
    };
    if let Err(e) = result {
        log::warn!("agent forward: {e}");
    }
}

#[cfg(unix)]
async fn bridge_system<M>(channel: Channel<M>) -> std::io::Result<()>
where
    M: From<(ChannelId, ChannelMsg)> + Send + Sync + 'static,
{
    let path = std::env::var("SSH_AUTH_SOCK")
        .map_err(|_| std::io::Error::other("SSH_AUTH_SOCK is not set"))?;
    let socket = tokio::net::UnixStream::connect(path).await?;
    splice(channel, socket).await
}

#[cfg(not(unix))]
async fn bridge_system<M>(_channel: Channel<M>) -> std::io::Result<()>
where
    M: From<(ChannelId, ChannelMsg)> + Send + Sync + 'static,
{
    Err(std::io::Error::other(
        "forwarding to the system ssh-agent isn't supported on this platform yet",
    ))
}

/// Spins up a one-shot in-process agent seeded with exactly `key`, using
/// russh's own agent client to seed it — the same wire round-trip a real
/// `ssh-add` would perform — then splices the forwarded channel straight to
/// that agent's connection.
async fn bridge_key<M>(channel: Channel<M>, key: Arc<PrivateKey>) -> std::io::Result<()>
where
    M: From<(ChannelId, ChannelMsg)> + Send + Sync + 'static,
{
    let stream = seed_single_key_agent(key).await?;
    splice(channel, stream).await
}

/// The seeding half of [`bridge_key`], split out so tests can drive the
/// returned connection directly (as a stand-in for "whatever the remote end
/// of the forwarded channel would send") without needing a real SSH channel.
async fn seed_single_key_agent(
    key: Arc<PrivateKey>,
) -> std::io::Result<impl AsyncRead + AsyncWrite + Unpin> {
    let (seed_end, serve_end) = tokio::io::duplex(8192);
    let accept_once = Box::pin(stream::once(async move {
        Ok::<_, std::io::Error>(serve_end)
    }));

    let server_task = tokio::spawn(async move {
        let _ = server::serve(accept_once, NoConfirm).await;
    });

    let mut seeder = AgentClient::connect(seed_end);
    if seeder.add_identity(&key, &[]).await.is_err() {
        server_task.abort();
        return Err(std::io::Error::other("could not seed the built-in agent"));
    }

    Ok(seeder.into_inner())
}

#[cfg(test)]
mod tests {
    use russh::keys::ssh_key::HashAlg;
    use russh::keys::{Algorithm, PrivateKey};

    use super::*;

    #[tokio::test]
    async fn built_in_agent_serves_exactly_the_seeded_key_and_signs_correctly() {
        // Arrange: a real key, never written to disk — exactly what a
        // decrypted vault identity looks like at this point in the code.
        let key = Arc::new(PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap());
        let public = key.public_key().clone();

        // Act: seed the in-process agent, then talk to it as the remote
        // side of a forwarded channel would — request identities, then ask
        // it to sign something.
        let stream = seed_single_key_agent(key).await.unwrap();
        let mut client = AgentClient::connect(stream);

        let identities = client.request_identities().await.unwrap();
        assert_eq!(identities.len(), 1);
        let identity = identities[0].clone();

        let data = b"assert this exact payload was signed".to_vec();
        // `AgentClient::sign_request` returns the original `data` with the
        // agent's encoded response appended: a bare 4-byte length, then a
        // wire-encoded `Signature` (algorithm string + raw signature bytes).
        let response = client
            .sign_request(&identity, Some(HashAlg::Sha512), data.clone())
            .await
            .unwrap();
        let encoded_signature = &response[data.len() + 4..];

        // Assert: the identity's public half matches the seeded key.
        match &identity {
            russh::keys::agent::AgentIdentity::PublicKey { key: returned, .. } => {
                assert_eq!(returned.key_data(), public.key_data());
            }
            other => panic!("expected a plain public key identity, got {other:?}"),
        }

        // Assert: what the agent returned actually verifies against the
        // public key and the exact data that was signed — proves the key
        // really signed with it, not just that a plausible-looking response
        // arrived over the wire.
        use russh::keys::signature::Verifier;
        use russh::keys::ssh_encoding::Decode;
        let signature = russh::keys::ssh_key::Signature::decode(&mut &encoded_signature[..])
            .expect("agent response must decode as a wire-format Signature");
        let key_data = public.key_data();
        Verifier::verify(key_data, &data, &signature)
            .expect("signature must verify against the seeded key and the signed data");

        // And a signature over *different* data must not verify — catches a
        // handler that ignores the payload and always returns some fixed blob.
        assert!(Verifier::verify(key_data, b"not what was signed", &signature).is_err());
    }

    #[tokio::test]
    async fn built_in_agent_does_not_expose_a_second_key_never_added() {
        let seeded = Arc::new(PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap());
        let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();

        let stream = seed_single_key_agent(seeded.clone()).await.unwrap();
        let mut client = AgentClient::connect(stream);
        let identities = client.request_identities().await.unwrap();

        assert_eq!(identities.len(), 1);
        let russh::keys::agent::AgentIdentity::PublicKey { key: returned, .. } = &identities[0]
        else {
            panic!("expected a plain public key identity");
        };
        assert_ne!(returned.key_data(), other.public_key().key_data());
        assert_eq!(returned.key_data(), seeded.public_key().key_data());
    }
}
