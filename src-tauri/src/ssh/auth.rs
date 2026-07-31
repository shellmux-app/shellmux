use std::sync::Arc;

use russh::client::{AuthResult, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};

use super::handler::ShellmuxHandler;
use crate::error::{AppError, AppResult};
use crate::paths::expand_tilde;
use crate::vault::{secrets, AuthKind, Host, Identity};

/// Servers count every offered key against `MaxAuthTries` (default 6) and drop
/// the connection once it's exhausted — with a message that blames the user
/// rather than the agent. Stopping first leaves room for a clearer error.
const MAX_AGENT_KEYS: usize = 4;

/// A hostile or misconfigured server can keep sending prompts forever; cap the
/// exchange rather than letting it hang the session.
const MAX_KEYBOARD_ROUNDS: usize = 16;

/// Authenticates according to the host's chosen method.
pub async fn authenticate(
    handle: &mut Handle<ShellmuxHandler>,
    host: &Host,
    identity: Option<&Identity>,
) -> AppResult<()> {
    let user = host.username.clone();

    match host.auth_kind {
        AuthKind::Agent => try_agent(handle, &user).await,
        AuthKind::Password => try_password(handle, host, &user).await,
        AuthKind::Key => match identity {
            Some(id) => try_private_key(handle, &user, id).await,
            None => Err(AppError::Auth(
                "this host is set to use a key, but no key is selected — pick one in the \
                 host's settings, or switch it to ssh-agent"
                    .into(),
            )),
        },
    }
}

async fn try_agent(handle: &mut Handle<ShellmuxHandler>, user: &str) -> AppResult<()> {
    let mut agent = AgentClient::connect_env().await.map_err(|e| {
        AppError::Auth(format!(
            "could not connect to ssh-agent: {e} — is SSH_AUTH_SOCK set?"
        ))
    })?;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::Auth(format!("agent did not return an identity: {e}")))?;

    if identities.is_empty() {
        return Err(AppError::Auth(
            "ssh-agent is running but holds no keys — add one with `ssh-add`, or set this \
             host to use a specific key"
                .into(),
        ));
    }

    let total = identities.len();
    let hash_alg = handle.best_supported_rsa_hash().await?.flatten();

    for ident in identities.into_iter().take(MAX_AGENT_KEYS) {
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

    Err(AppError::Auth(if total > MAX_AGENT_KEYS {
        format!(
            "none of the first {MAX_AGENT_KEYS} of your {total} ssh-agent keys were accepted \
             for user \"{user}\". Servers cut the connection after a handful of attempts, so \
             the rest were not tried — set a specific key on this host instead."
        )
    } else {
        format!(
            "server rejected every key in ssh-agent for user \"{user}\" — check that the \
             username is correct (it's case-sensitive) and that a matching public key is in \
             that user's ~/.ssh/authorized_keys"
        )
    }))
}

async fn try_private_key(
    handle: &mut Handle<ShellmuxHandler>,
    user: &str,
    identity: &Identity,
) -> AppResult<()> {
    let key = decrypt_identity_key(identity)?;

    let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
    let result = handle
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(key, hash_alg))
        .await?;

    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(AppError::Auth(format!(
            "server rejected key {} for user \"{user}\" — check that the username is \
             correct (it's case-sensitive) and that this key is in that user's \
             ~/.ssh/authorized_keys",
            identity.private_key_path
        ))),
    }
}

/// Reads and decrypts a saved identity's private key file. Shared by
/// key-based auth above and by agent-forwarding setup in `dial.rs`, which
/// needs the same decrypted key to seed the built-in forwarding agent.
pub fn decrypt_identity_key(identity: &Identity) -> AppResult<Arc<russh::keys::PrivateKey>> {
    // `~/.ssh/id_ed25519` is what users type and what ssh_config contains, but
    // nothing below expands it — without this the error is a puzzling "file not
    // found" naming a path that plainly exists.
    let path = expand_tilde(&identity.private_key_path);

    // The passphrase only exists within this scope, then gets dropped.
    let passphrase = secrets::load(&identity.id)?;
    let key = load_secret_key(&path, passphrase.as_ref().map(|s| s.expose())).map_err(|e| {
        AppError::Auth(match e {
            russh::keys::Error::KeyIsEncrypted => format!(
                "key {path} is protected by a passphrase — add it to this key in Keychain"
            ),
            other => format!("could not read key {path}: {other}"),
        })
    })?;
    Ok(Arc::new(key))
}

async fn try_password(
    handle: &mut Handle<ShellmuxHandler>,
    host: &Host,
    user: &str,
) -> AppResult<()> {
    let secret = secrets::load_host_password(&host.id, host.identity_id.as_deref())?
        .ok_or_else(|| AppError::Auth("no password saved for this host".into()))?;

    if handle
        .authenticate_password(user, secret.expose())
        .await?
        .success()
    {
        return Ok(());
    }

    // Many servers disable `password` outright and only offer
    // `keyboard-interactive`, where the first prompt is the same password.
    keyboard_interactive(handle, user, secret.expose()).await
}

/// Runs a keyboard-interactive exchange, filling in the saved password *only*
/// where that is unambiguously what is being asked for.
///
/// The obvious implementation — answer every prompt with the password — is
/// wrong and actively harmful. With `pam_google_authenticator`, OpenSSH sends
/// two rounds: "Password:" then "Verification code:". Replying to both with the
/// password sends it into the OTP field, which the server logs and rate-limits
/// as a second factor, and the user just sees "authentication failed". So:
/// only the first round, only a single prompt, only when it is masked
/// (`echo == false`) and reads like a password. Anything else means a second
/// factor is in play, and we stop with an explanation rather than guessing.
async fn keyboard_interactive(
    handle: &mut Handle<ShellmuxHandler>,
    user: &str,
    password: &str,
) -> AppResult<()> {
    use russh::client::KeyboardInteractiveAuthResponse as Resp;

    let mut response = handle
        .authenticate_keyboard_interactive_start(user, None)
        .await?;
    let mut round = 0usize;
    // Tracks whether the password has already been handed over, rather than
    // trusting the *round number* to identify the password prompt. PAM
    // routinely sends a zero-prompt notice first (expiry warnings, banners),
    // which would push the real "Password:" to round 2 and get it rejected
    // as a second factor — breaking password auth on those servers entirely.
    let mut sent_password = false;

    loop {
        round += 1;
        if round > MAX_KEYBOARD_ROUNDS {
            return Err(AppError::Auth(format!(
                "the server kept asking for more input after {MAX_KEYBOARD_ROUNDS} rounds"
            )));
        }

        match response {
            Resp::Success => return Ok(()),
            Resp::Failure { .. } => {
                return Err(AppError::Auth(format!(
                    "password rejected for user \"{user}\" — check the username (it's \
                     case-sensitive) and the password"
                )))
            }
            Resp::InfoRequest { ref prompts, .. } => {
                // A zero-prompt request is the server showing a notice; answer
                // it with nothing and let the exchange continue.
                let answers = if prompts.is_empty() {
                    Vec::new()
                } else if !sent_password && prompts.len() == 1 && is_password_prompt(&prompts[0]) {
                    // At most once, ever: a server that asks a second time is
                    // either wrong or fishing, and a 2FA prompt arriving after
                    // the password still falls through to the error below.
                    sent_password = true;
                    vec![password.to_string()]
                } else {
                    return Err(AppError::Auth(format!(
                        "this server asks for another factor ({}). Interactive prompts \
                         aren't supported yet — connect once with `ssh {user}@…` in a \
                         terminal to complete setup.",
                        describe_prompts(prompts)
                    )));
                };

                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
}

/// True for the prompt OpenSSH sends when it wants the account password: masked
/// input whose text says so. A visible prompt is never a password.
fn is_password_prompt(prompt: &russh::client::Prompt) -> bool {
    !prompt.echo && {
        let text = prompt.prompt.to_lowercase();
        text.contains("password") || text.contains("passphrase")
    }
}

fn describe_prompts(prompts: &[russh::client::Prompt]) -> String {
    prompts
        .iter()
        .map(|p| p.prompt.trim().trim_end_matches(':').to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::client::Prompt;

    fn prompt(text: &str, echo: bool) -> Prompt {
        Prompt {
            prompt: text.to_string(),
            echo,
        }
    }

    #[test]
    fn recognises_the_prompts_openssh_uses_for_a_password() {
        assert!(is_password_prompt(&prompt("Password: ", false)));
        assert!(is_password_prompt(&prompt(
            "user@host's password: ",
            false
        )));
        assert!(is_password_prompt(&prompt(
            "Enter passphrase for key: ",
            false
        )));
    }

    #[test]
    fn does_not_treat_a_second_factor_as_a_password() {
        // The whole point: these must never be auto-answered with the password.
        assert!(!is_password_prompt(&prompt("Verification code: ", false)));
        assert!(!is_password_prompt(&prompt("One-time code: ", false)));
        assert!(!is_password_prompt(&prompt("Duo passcode: ", false)));
        assert!(!is_password_prompt(&prompt("Second Factor: ", false)));
    }

    #[test]
    fn a_visible_prompt_is_never_a_password() {
        // Echoed input means the server expects something non-secret.
        assert!(!is_password_prompt(&prompt("Password hint: ", true)));
    }

    #[test]
    fn names_the_unexpected_prompts_so_the_error_says_what_was_asked() {
        let prompts = vec![prompt("Verification code: ", false)];
        assert_eq!(describe_prompts(&prompts), "Verification code");
    }
}
