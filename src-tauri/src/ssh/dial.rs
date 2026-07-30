use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dashmap::DashMap;
use russh::client::{self, Handle};

use super::handler::{ForwardRegistry, ObservedKey, ShellmuxHandler};
use super::link::SshLink;
use crate::error::{AppError, AppResult};
use crate::ssh::auth::authenticate;
use crate::vault::{Host, Vault};

/// Guards against `jump_host_id` pointing in a circle or an absurdly long chain.
const MAX_JUMPS: usize = 8;
const KEEPALIVE_SECS: u64 = 30;

struct Chain {
    handle: Handle<ShellmuxHandler>,
    parents: Vec<Handle<ShellmuxHandler>>,
    forwards: ForwardRegistry,
}

pub async fn connect_host(vault: Arc<Vault>, host_id: &str) -> AppResult<Arc<SshLink>> {
    let chain = dial(vault, host_id.to_string(), 0).await?;
    Ok(Arc::new(SshLink::new(
        host_id.to_string(),
        chain.handle,
        chain.parents,
        chain.forwards,
    )))
}

/// Recursive, so it has to be boxed: each jump hop is a nested call to `dial`.
fn dial(
    vault: Arc<Vault>,
    host_id: String,
    depth: usize,
) -> Pin<Box<dyn Future<Output = AppResult<Chain>> + Send>> {
    Box::pin(async move {
        if depth > MAX_JUMPS {
            return Err(AppError::JumpChainTooDeep { max: MAX_JUMPS });
        }

        let host = vault.get_host(&host_id)?;
        let identity = match &host.identity_id {
            Some(id) => Some(vault.get_identity(id)?),
            None => None,
        };

        let observed: ObservedKey = Arc::new(Mutex::new(None));
        let forwards: ForwardRegistry = Arc::new(DashMap::new());
        let handler = ShellmuxHandler::new(
            vault.clone(),
            host.hostname.clone(),
            host.port,
            observed.clone(),
            forwards.clone(),
        );
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(KEEPALIVE_SECS)),
            nodelay: true,
            ..Default::default()
        });

        let (mut handle, parents) = match &host.jump_host_id {
            Some(jump_id) if jump_id != &host.id => {
                let up = dial(vault.clone(), jump_id.clone(), depth + 1).await?;
                // Tunnel through the jump: open direct-tcpip then run SSH on that stream.
                let channel = up
                    .handle
                    .channel_open_direct_tcpip(
                        host.hostname.clone(),
                        host.port as u32,
                        "127.0.0.1",
                        0,
                    )
                    .await?;
                let handle = client::connect_stream(config, channel.into_stream(), handler)
                    .await
                    .map_err(|e| classify(&vault, &host, &observed, e))?;
                let mut parents = up.parents;
                parents.push(up.handle);
                (handle, parents)
            }
            _ => {
                let handle =
                    client::connect(config, (host.hostname.as_str(), host.port), handler)
                        .await
                        .map_err(|e| classify(&vault, &host, &observed, e))?;
                (handle, Vec::new())
            }
        };

        authenticate(&mut handle, &host, identity.as_ref()).await?;

        Ok(Chain {
            handle,
            parents,
            forwards,
        })
    })
}

/// `russh` only reports `UnknownKey` when `check_server_key` returns false.
/// Only here do we learn whether this is a new host or a changed key — two
/// situations that need different UI.
fn classify(
    vault: &Arc<Vault>,
    host: &Host,
    observed: &ObservedKey,
    err: russh::Error,
) -> AppError {
    if !matches!(err, russh::Error::UnknownKey) {
        return err.into();
    }

    let seen = observed.lock().ok().and_then(|slot| slot.clone());
    let (algo, fingerprint) = match seen {
        Some(pair) => pair,
        None => return err.into(),
    };

    match vault.get_known_host(&host.hostname, host.port) {
        Ok(Some(known)) if known.fingerprint != fingerprint => AppError::HostKeyMismatch {
            host: host.hostname.clone(),
            port: host.port,
            expected: known.fingerprint,
            actual: fingerprint,
        },
        _ => AppError::HostKeyUnknown {
            host: host.hostname.clone(),
            port: host.port,
            fingerprint,
            algo,
        },
    }
}
