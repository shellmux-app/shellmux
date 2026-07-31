use std::sync::Arc;

use dashmap::DashMap;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

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

/// SFTP session cached per session id: opening the subsystem costs a
/// round-trip, not worth repeating for every `ls`.
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

/// Blocks path traversal and empty paths before sending to the server.
fn validate_remote(path: &str) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::Invalid("remote path is empty".into()));
    }
    if path.split('/').any(|seg| seg == "..") {
        return Err(AppError::Invalid(
            "remote path must not contain '..'".into(),
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

    // Directories first, then by name — like Finder, saves sorting in the UI.
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

/// Remote → local, streamed in chunks so large files don't eat up all the RAM.
pub async fn download(sftp: &SftpSession, remote: &str, local: &str) -> AppResult<u64> {
    download_resumable(sftp, remote, local, false, |_, _| {}).await
}

/// Same as [`download`], but reports progress after every chunk and, when
/// `resume` is set, picks up where a previous attempt at the same `local`
/// path left off instead of starting over.
///
/// Resuming trusts that `local`'s current length really is a prefix of the
/// remote file — true for "the last attempt got cut off mid-transfer", not
/// guaranteed if the remote file changed since. Good enough for retrying a
/// dropped connection, not a substitute for checksums.
pub async fn download_resumable<F>(
    sftp: &SftpSession,
    remote: &str,
    local: &str,
    resume: bool,
    mut on_progress: F,
) -> AppResult<u64>
where
    F: FnMut(u64, Option<u64>),
{
    validate_remote(remote)?;
    let mut src = sftp.open(remote).await?;
    let total = src.metadata().await.ok().and_then(|m| m.size);

    // Resuming is only safe while the local partial is a strict prefix of the
    // remote file. If it's already as long — or longer, because the remote was
    // rotated or replaced since the failed attempt — seeking there would read
    // 0 bytes and report a "successful" transfer of stale data. Start over
    // instead; a redundant re-download beats silently keeping the wrong file.
    let existing_len = if resume {
        tokio::fs::metadata(local).await.map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };
    let resumable = resume && existing_len > 0 && total.is_some_and(|t| existing_len < t);

    let mut start = 0u64;
    let mut dst = if resumable {
        let existing = tokio::fs::OpenOptions::new().append(true).open(local).await?;
        start = existing_len;
        existing
    } else {
        tokio::fs::File::create(local).await?
    };

    if start > 0 {
        src.seek(std::io::SeekFrom::Start(start)).await?;
    }

    let mut buf = vec![0u8; COPY_CHUNK];
    let mut done = start;
    on_progress(done, total);
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        done += n as u64;
        on_progress(done, total);
    }
    dst.flush().await?;
    Ok(done)
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
        // `..` is only blocked when it's a whole segment, not when it's a name prefix.
        assert!(validate_remote("/var/log/..hidden").is_ok());
        assert!(validate_remote("/data/archive..2026").is_ok());
    }
}

/// Local → remote.
pub async fn upload(sftp: &SftpSession, local: &str, remote: &str) -> AppResult<u64> {
    upload_resumable(sftp, local, remote, false, |_, _| {}).await
}

/// Same as [`upload`], but reports progress after every chunk and, when
/// `resume` is set, continues an existing remote file from its current
/// length instead of truncating it — see [`download_resumable`] for the
/// same trust caveat, mirrored here on the remote side.
pub async fn upload_resumable<F>(
    sftp: &SftpSession,
    local: &str,
    remote: &str,
    resume: bool,
    mut on_progress: F,
) -> AppResult<u64>
where
    F: FnMut(u64, Option<u64>),
{
    validate_remote(remote)?;
    let mut src = tokio::fs::File::open(local).await?;
    let total = src.metadata().await.map(|m| m.len())?;

    // Mirror of the guard in `download_resumable`: only resume while what's
    // already on the remote is a strict prefix of the local file. `create`
    // truncates, so falling back to it also clears any stale tail — which
    // `OpenFlags::WRITE` alone would leave in place.
    let remote_len = if resume {
        match sftp.open_with_flags(remote, OpenFlags::WRITE).await {
            Ok(existing) => existing.metadata().await.ok().and_then(|m| m.size).unwrap_or(0),
            Err(_) => 0,
        }
    } else {
        0
    };
    let resumable = resume && remote_len > 0 && remote_len < total;

    let mut start = 0u64;
    let mut dst = if resumable {
        start = remote_len;
        sftp.open_with_flags(remote, OpenFlags::WRITE).await?
    } else {
        sftp.create(remote).await?
    };

    if start > 0 {
        src.seek(std::io::SeekFrom::Start(start)).await?;
        dst.seek(std::io::SeekFrom::Start(start)).await?;
    }

    let mut buf = vec![0u8; COPY_CHUNK];
    let mut done = start;
    on_progress(done, Some(total));
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        done += n as u64;
        on_progress(done, Some(total));
    }
    dst.flush().await?;
    Ok(done)
}
