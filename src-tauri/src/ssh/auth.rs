use std::sync::Arc;

use russh::client::{AuthResult, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};

use super::handler::ShellmuxHandler;
use crate::error::{AppError, AppResult};
use crate::vault::{secrets, AuthKind, Host, Identity};

/// Authenticates using the identity assigned to the host. A host with no
/// identity tries the agent first (the most common case), then reports an error.
pub async fn authenticate(
    handle: &mut Handle<ShellmuxHandler>,
    host: &Host,
    identity: Option<&Identity>,
) -> AppResult<()> {
    let user = identity
        .and_then(|i| i.username.clone())
        .unwrap_or_else(|| host.username.clone());

    match identity {
        None => try_agent(handle, &user).await,
        Some(id) => match id.auth_kind {
            AuthKind::Agent => try_agent(handle, &user).await,
            AuthKind::PrivateKey => try_private_key(handle, &user, id).await,
            AuthKind::Password => try_password(handle, &user, id).await,
        },
    }
}

async fn try_agent(handle: &mut Handle<ShellmuxHandler>, user: &str) -> AppResult<()> {
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| AppError::Auth(format!("could not connect to ssh-agent: {e}")))?;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::Auth(format!("agent did not return an identity: {e}")))?;

    if identities.is_empty() {
        return Err(AppError::Auth("ssh-agent has no keys".into()));
    }

    let hash_alg = handle.best_supported_rsa_hash().await?.flatten();

    for ident in identities {
        let public = match &ident {
            AgentIdentity::PublicKey { key, .. } => key.clone(),
            // Certificate auth via agent is for Phase 2.
            AgentIdentity::Certificate { .. } => continue,
        };
        let result = handle
            .authenticate_publickey_with(user, public, hash_alg, &mut agent)
            .await
            .map_err(|e| AppError::Auth(format!("agent sign error: {e}")))?;
        if result.success() {
            return Ok(());
        }
    }

    Err(AppError::Auth(
        "server rejected every key in ssh-agent".into(),
    ))
}

async fn try_private_key(
    handle: &mut Handle<ShellmuxHandler>,
    user: &str,
    identity: &Identity,
) -> AppResult<()> {
    let path = identity
        .private_key_path
        .as_deref()
        .ok_or_else(|| AppError::Invalid("identity is missing a private key path".into()))?;

    // Passphrase only exists within this scope, then gets dropped.
    let passphrase = secrets::load(&identity.id)?;
    let key = load_secret_key(path, passphrase.as_ref().map(|s| s.expose()))?;

    let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
    let result = handle
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg))
        .await?;

    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(AppError::Auth(format!(
            "server rejected key {path} for user {user}"
        ))),
    }
}

async fn try_password(
    handle: &mut Handle<ShellmuxHandler>,
    user: &str,
    identity: &Identity,
) -> AppResult<()> {
    let secret = secrets::load(&identity.id)?
        .ok_or_else(|| AppError::Auth("no password saved for this identity".into()))?;

    if handle
        .authenticate_password(user, secret.expose())
        .await?
        .success()
    {
        return Ok(());
    }

    // Many servers disable `password` and only enable `keyboard-interactive`
    // with exactly one password prompt — try that instead of giving up.
    keyboard_interactive(handle, user, secret.expose()).await
}

async fn keyboard_interactive(
    handle: &mut Handle<ShellmuxHandler>,
    user: &str,
    password: &str,
) -> AppResult<()> {
    use russh::client::KeyboardInteractiveAuthResponse as Resp;

    let mut response = handle
        .authenticate_keyboard_interactive_start(user, None)
        .await?;

    // Cap the number of rounds so a server that keeps asking forever can't hang the app.
    for _ in 0..8 {
        match response {
            Resp::Success => return Ok(()),
            Resp::Failure { .. } => {
                return Err(AppError::Auth("password was rejected".into()));
            }
            Resp::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }

    Err(AppError::Auth(
        "keyboard-interactive did not finish after 8 rounds".into(),
    ))
}
