use std::sync::Arc;

use dashmap::DashMap;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::ssh::SshLink;

const COPY_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub permissions: Option<u32>,
    pub modified: Option<u32>,
    pub user: Option<String>,
    pub group: Option<String>,
}

/// SFTP session được cache theo session id: mở subsystem tốn một round-trip,
/// không đáng làm lại cho từng lần `ls`.
#[derive(Default)]
pub struct SftpRegistry {
    sessions: DashMap<String, Arc<SftpSession>>,
}

impl SftpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get_or_open(
        &self,
        session_id: &str,
        link: Arc<SshLink>,
    ) -> AppResult<Arc<SftpSession>> {
        if let Some(existing) = self.sessions.get(session_id) {
            return Ok(existing.clone());
        }

        let channel = link.open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = Arc::new(SftpSession::new(channel.into_stream()).await?);

        self.sessions.insert(session_id.to_string(), sftp.clone());
        Ok(sftp)
    }

    pub async fn close(&self, session_id: &str) {
        if let Some((_, sftp)) = self.sessions.remove(session_id) {
            let _ = sftp.close().await;
        }
    }
}

/// Chặn path traversal và path rỗng trước khi gửi lên server.
fn validate_remote(path: &str) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::Invalid("đường dẫn remote rỗng".into()));
    }
    if path.split('/').any(|seg| seg == "..") {
        return Err(AppError::Invalid(
            "đường dẫn remote không được chứa '..'".into(),
        ));
    }
    Ok(())
}

pub async fn list(sftp: &SftpSession, path: &str) -> AppResult<Vec<RemoteEntry>> {
    validate_remote(path)?;
    let canonical = sftp.canonicalize(path).await?;
    let entries = sftp.read_dir(canonical.clone()).await?;

    let mut out: Vec<RemoteEntry> = entries
        .map(|entry| {
            let meta = entry.metadata();
            RemoteEntry {
                name: entry.file_name(),
                path: entry.path(),
                is_dir: entry.file_type().is_dir(),
                is_symlink: entry.file_type().is_symlink(),
                size: meta.size.unwrap_or(0),
                permissions: meta.permissions,
                modified: meta.mtime,
                user: meta.user.clone(),
                group: meta.group.clone(),
            }
        })
        .collect();

    // Thư mục lên trước, rồi theo tên — giống Finder, đỡ phải sort ở UI.
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

pub async fn canonicalize(sftp: &SftpSession, path: &str) -> AppResult<String> {
    validate_remote(path)?;
    Ok(sftp.canonicalize(path).await?)
}

pub async fn make_dir(sftp: &SftpSession, path: &str) -> AppResult<()> {
    validate_remote(path)?;
    sftp.create_dir(path).await?;
    Ok(())
}

pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> AppResult<()> {
    validate_remote(from)?;
    validate_remote(to)?;
    sftp.rename(from, to).await?;
    Ok(())
}

pub async fn remove(sftp: &SftpSession, path: &str, is_dir: bool) -> AppResult<()> {
    validate_remote(path)?;
    if is_dir {
        sftp.remove_dir(path).await?;
    } else {
        sftp.remove_file(path).await?;
    }
    Ok(())
}

/// Remote → local, stream theo chunk để file lớn không nuốt hết RAM.
pub async fn download(sftp: &SftpSession, remote: &str, local: &str) -> AppResult<u64> {
    validate_remote(remote)?;
    let mut src = sftp.open(remote).await?;
    let mut dst = tokio::fs::File::create(local).await?;

    let mut buf = vec![0u8; COPY_CHUNK];
    let mut total = 0u64;
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        total += n as u64;
    }
    dst.flush().await?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::validate_remote;

    #[test]
    fn accepts_absolute_and_relative_paths() {
        assert!(validate_remote("/var/log/nginx").is_ok());
        assert!(validate_remote("./logs").is_ok());
        assert!(validate_remote("logs/today.txt").is_ok());
    }

    #[test]
    fn rejects_empty_or_whitespace_paths() {
        assert!(validate_remote("").is_err());
        assert!(validate_remote("   ").is_err());
    }

    #[test]
    fn rejects_parent_traversal_segments_anywhere_in_the_path() {
        assert!(validate_remote("..").is_err());
        assert!(validate_remote("../etc/passwd").is_err());
        assert!(validate_remote("/var/log/../../etc/shadow").is_err());
        assert!(validate_remote("logs/../..").is_err());
    }

    #[test]
    fn does_not_reject_names_that_merely_contain_dots() {
        // `..` chỉ bị chặn khi là cả một segment, không phải khi là tiền tố tên.
        assert!(validate_remote("/var/log/..hidden").is_ok());
        assert!(validate_remote("/data/archive..2026").is_ok());
    }
}

/// Local → remote.
pub async fn upload(sftp: &SftpSession, local: &str, remote: &str) -> AppResult<u64> {
    validate_remote(remote)?;
    let mut src = tokio::fs::File::open(local).await?;
    let mut dst = sftp.create(remote).await?;

    let mut buf = vec![0u8; COPY_CHUNK];
    let mut total = 0u64;
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        total += n as u64;
    }
    dst.flush().await?;
    Ok(total)
}
