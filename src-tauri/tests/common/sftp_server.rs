//! Minimal but real SFTP server, backed by an actual directory on disk.
//!
//! This exists so the SFTP tests exercise the real wire protocol (a real
//! `SSH_FXP_*` exchange over a real SSH channel) end to end, the same way the
//! other integration tests use a real in-process SSH server instead of
//! mocking `SshLink`. It implements only the operations `src/sftp.rs` actually
//! calls — this is a test fixture, not a general-purpose SFTP server.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use russh_sftp::protocol::{
    Attrs, File as SftpFile, FileAttributes, Handle, Name, Status, StatusCode,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

enum OpenHandle {
    Dir { entries: Vec<std::fs::DirEntry>, sent: bool },
    File(tokio::fs::File),
}

pub struct TestSftpHandler {
    /// Real directory on disk that stands in for the SFTP root ("/").
    root: PathBuf,
    handles: HashMap<String, OpenHandle>,
    next_handle: u64,
}

impl TestSftpHandler {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            handles: HashMap::new(),
            next_handle: 0,
        }
    }

    fn new_handle(&mut self) -> String {
        self.next_handle += 1;
        format!("h{}", self.next_handle)
    }

    /// Maps a client-supplied path (relative to the virtual "/") onto the
    /// real temp directory, refusing to leave it — a test double for a
    /// chrooted SFTP server, and a second, independent check alongside
    /// `sftp::validate_remote`'s `..`-segment guard on the client side.
    fn to_disk_path(&self, virtual_path: &str) -> Option<PathBuf> {
        let cleaned = virtual_path.trim_start_matches('/');
        let joined = if cleaned.is_empty() || cleaned == "." {
            self.root.clone()
        } else {
            self.root.join(cleaned)
        };
        // `join` doesn't resolve `..` itself; reject anything that would climb
        // out rather than trying to canonicalize a path that may not exist yet
        // (canonicalize requires the target to exist, which isn't true for e.g.
        // a file about to be created).
        if joined.components().any(|c| c == std::path::Component::ParentDir) {
            return None;
        }
        Some(joined)
    }

    fn to_virtual_path(&self, disk_path: &Path) -> String {
        match disk_path.strip_prefix(&self.root) {
            Ok(rel) if !rel.as_os_str().is_empty() => format!("/{}", rel.to_string_lossy()),
            _ => "/".to_string(),
        }
    }

    fn attrs_for(meta: &std::fs::Metadata) -> FileAttributes {
        let mut attrs = FileAttributes {
            size: Some(meta.len()),
            permissions: Some(if meta.is_dir() { 0o755 } else { 0o644 }),
            ..Default::default()
        };
        attrs.set_dir(meta.is_dir());
        attrs.set_regular(meta.is_file());
        attrs.set_symlink(meta.file_type().is_symlink());
        if let Ok(mtime) = meta.modified() {
            if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                attrs.mtime = Some(dur.as_secs() as u32);
            }
        }
        attrs
    }

    fn ok(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_string(),
            language_tag: "en-US".to_string(),
        }
    }
}

impl russh_sftp::server::Handler for TestSftpHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<russh_sftp::protocol::Version, Self::Error> {
        Ok(russh_sftp::protocol::Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let disk = self.to_disk_path(&path).ok_or(StatusCode::NoSuchFile)?;
        Ok(Name {
            id,
            files: vec![SftpFile::dummy(self.to_virtual_path(&disk))],
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let disk = self.to_disk_path(&path).ok_or(StatusCode::NoSuchFile)?;
        let entries: Vec<_> = std::fs::read_dir(&disk)
            .map_err(|_| StatusCode::NoSuchFile)?
            .filter_map(|e| e.ok())
            .collect();
        let handle = self.new_handle();
        self.handles
            .insert(handle.clone(), OpenHandle::Dir { entries, sent: false });
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let Some(OpenHandle::Dir { entries, sent }) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        // The real protocol streams a directory across several READDIR calls;
        // one batch is enough for test fixtures, which are always small.
        if *sent {
            return Err(StatusCode::Eof);
        }
        *sent = true;

        let files = entries
            .iter()
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                Some(SftpFile::new(
                    entry.file_name().to_string_lossy().into_owned(),
                    Self::attrs_for(&meta),
                ))
            })
            .collect();
        Ok(Name { id, files })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        if let Some(OpenHandle::File(mut file)) = self.handles.remove(&handle) {
            let _ = file.flush().await;
        }
        Ok(Self::ok(id))
    }

    /// Only what `sftp::upload_resumable` needs: the current on-disk length
    /// of an already-open file handle, to know where a resumed write starts.
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let Some(OpenHandle::File(file)) = self.handles.get(&handle) else {
            return Err(StatusCode::Failure);
        };
        let meta = file.metadata().await.map_err(|_| StatusCode::Failure)?;
        Ok(Attrs {
            id,
            attrs: Self::attrs_for(&meta),
        })
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let disk = self.to_disk_path(&path).ok_or(StatusCode::NoSuchFile)?;
        std::fs::create_dir(&disk).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let disk = self.to_disk_path(&path).ok_or(StatusCode::NoSuchFile)?;
        std::fs::remove_dir(&disk).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let disk = self.to_disk_path(&filename).ok_or(StatusCode::NoSuchFile)?;
        std::fs::remove_file(&disk).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let from = self.to_disk_path(&oldpath).ok_or(StatusCode::NoSuchFile)?;
        let to = self.to_disk_path(&newpath).ok_or(StatusCode::NoSuchFile)?;
        std::fs::rename(&from, &to).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok(id))
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: russh_sftp::protocol::OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let disk = self.to_disk_path(&filename).ok_or(StatusCode::NoSuchFile)?;
        let file = tokio::fs::OpenOptions::new()
            .read(pflags.contains(russh_sftp::protocol::OpenFlags::READ))
            .write(pflags.contains(russh_sftp::protocol::OpenFlags::WRITE))
            .create(pflags.contains(russh_sftp::protocol::OpenFlags::CREATE))
            .truncate(pflags.contains(russh_sftp::protocol::OpenFlags::TRUNCATE))
            .open(&disk)
            .await
            .map_err(|_| StatusCode::Failure)?;

        let handle = self.new_handle();
        self.handles.insert(handle.clone(), OpenHandle::File(file));
        Ok(Handle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<russh_sftp::protocol::Data, Self::Error> {
        let Some(OpenHandle::File(file)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|_| StatusCode::Failure)?;
        let mut buf = vec![0u8; len as usize];
        let n = file.read(&mut buf).await.map_err(|_| StatusCode::Failure)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        buf.truncate(n);
        Ok(russh_sftp::protocol::Data { id, data: buf })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let Some(OpenHandle::File(file)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|_| StatusCode::Failure)?;
        file.write_all(&data).await.map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok(id))
    }
}
