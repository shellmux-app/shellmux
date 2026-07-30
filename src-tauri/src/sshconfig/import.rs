use serde::Serialize;

use super::parse::{first_jump_target, parse, SshConfigHost};
use crate::error::AppResult;
use crate::vault::{AuthKind, Group, Host, Identity, Vault};

/// Id cố định theo alias, nên import lại lần hai là *cập nhật* chứ không tạo
/// bản sao. Đổi lại: sửa tay một host đã import rồi import lại sẽ bị ghi đè.
const GROUP_ID: &str = "sshconfig";
const GROUP_NAME: &str = "Từ ~/.ssh/config";

fn host_id(alias: &str) -> String {
    format!("sshconfig:{alias}")
}

fn identity_id(path: &str) -> String {
    format!("sshconfig-key:{path}")
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub hosts: usize,
    pub identities: usize,
    pub jumps_linked: usize,
    /// Alias được `ProxyJump` trỏ tới nhưng không có trong file — không link được.
    pub unresolved_jumps: Vec<String>,
    pub includes_skipped: usize,
    pub wildcard_blocks: usize,
    /// Host khai `ForwardAgent yes` — Shellmux chưa hỗ trợ agent forwarding.
    pub agent_forward_ignored: usize,
}

pub fn import_into(vault: &Vault, text: &str) -> AppResult<ImportReport> {
    let parsed = parse(text);
    let mut report = ImportReport {
        includes_skipped: parsed.includes_skipped,
        wildcard_blocks: parsed.wildcard_blocks,
        ..Default::default()
    };

    if parsed.hosts.is_empty() {
        return Ok(report);
    }

    vault.upsert_group(&Group {
        id: GROUP_ID.into(),
        parent_id: None,
        name: GROUP_NAME.into(),
        sort: 0,
    })?;

    let known: Vec<String> = parsed.hosts.iter().map(|h| h.alias.clone()).collect();
    let mut seen_keys: Vec<String> = Vec::new();

    for (index, entry) in parsed.hosts.iter().enumerate() {
        let identity = ensure_identity(vault, entry, &mut seen_keys)?;
        let jump = resolve_jump(entry, &known, &mut report);

        vault.upsert_host(&Host {
            id: host_id(&entry.alias),
            group_id: Some(GROUP_ID.into()),
            label: entry.alias.clone(),
            hostname: entry.hostname.clone(),
            port: entry.port.unwrap_or(22),
            username: entry.user.clone().unwrap_or_else(default_user),
            identity_id: identity,
            jump_host_id: jump,
            theme: None,
            color_tag: None,
            notes: Some(format!("Import từ ~/.ssh/config (Host {})", entry.alias)),
            sort: index as i64,
        })?;
        report.hosts += 1;

        if entry.forward_agent {
            report.agent_forward_ignored += 1;
        }
    }

    report.identities = seen_keys.len();
    Ok(report)
}

/// Nhiều host thường dùng chung một key — tạo một identity rồi tái sử dụng.
fn ensure_identity(
    vault: &Vault,
    entry: &SshConfigHost,
    seen: &mut Vec<String>,
) -> AppResult<Option<String>> {
    let Some(path) = entry.identity_file.as_ref() else {
        return Ok(None);
    };

    let id = identity_id(path);
    if !seen.contains(path) {
        let name = path
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(path)
            .to_string();
        vault.upsert_identity(&Identity {
            id: id.clone(),
            name,
            auth_kind: AuthKind::PrivateKey,
            username: None,
            private_key_path: Some(path.clone()),
            // Key có passphrase thì người dùng tự nhập sau; import không đọc key.
            has_secret: false,
        })?;
        seen.push(path.clone());
    }
    Ok(Some(id))
}

fn resolve_jump(
    entry: &SshConfigHost,
    known: &[String],
    report: &mut ImportReport,
) -> Option<String> {
    let spec = entry.proxy_jump.as_ref()?;
    let target = first_jump_target(spec);

    if known.iter().any(|alias| alias == target) {
        report.jumps_linked += 1;
        return Some(host_id(target));
    }

    let missing = target.to_string();
    if !report.unresolved_jumps.contains(&missing) {
        report.unresolved_jumps.push(missing);
    }
    None
}

fn default_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".into())
}

pub fn default_config_path() -> Option<std::path::PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|home| std::path::PathBuf::from(home).join(".ssh").join("config"))
}
