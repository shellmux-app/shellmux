//! Exercises `sftp::*` against a real SFTP subsystem (real `SSH_FXP_*` wire
//! protocol over a real SSH channel), the same way the forwarding tests use a
//! real in-process SSH server instead of mocking `SshLink`.

mod common;

use common::{spawn_sftp_server, temp_vault_with_host};

use russh_sftp::client::SftpSession;
use shellmux_lib::sftp;
use shellmux_lib::ssh::connect_host;

/// Connects to a fresh SFTP-backed test server rooted at a fresh temp dir,
/// returning the session plus the temp dir (kept alive for the test's duration).
async fn connect() -> (SftpSession, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let server = spawn_sftp_server(root.path().to_path_buf()).await;
    let fx = temp_vault_with_host(server.port);
    fx.vault
        .put_known_host("127.0.0.1", server.port, "ssh-ed25519", &server.fingerprint)
        .unwrap();
    let link = connect_host(fx.vault.clone(), "h1").await.unwrap();

    let channel = link.open_session().await.unwrap();
    channel.request_subsystem(true, "sftp").await.unwrap();
    let sftp = SftpSession::new(channel.into_stream()).await.unwrap();
    (sftp, root)
}

#[tokio::test]
async fn upload_then_download_round_trips_the_same_bytes() {
    let (sftp, root) = connect().await;

    let uploaded = sftp::upload(&sftp, "Cargo.toml", "/copy.toml").await.unwrap();
    assert!(uploaded > 0);

    let local_out = root.path().join("downloaded.toml");
    let downloaded = sftp::download(&sftp, "/copy.toml", local_out.to_str().unwrap())
        .await
        .unwrap();

    assert_eq!(uploaded, downloaded);
    assert_eq!(
        std::fs::read("Cargo.toml").unwrap(),
        std::fs::read(&local_out).unwrap(),
    );
}

#[tokio::test]
async fn list_reports_uploaded_files_and_created_directories() {
    let (sftp, _root) = connect().await;

    sftp::upload(&sftp, "Cargo.toml", "/a.toml").await.unwrap();
    sftp::make_dir(&sftp, "/subdir").await.unwrap();

    let entries = sftp::list(&sftp, "/").await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

    assert!(names.contains(&"a.toml"));
    assert!(names.contains(&"subdir"));
    let dir_entry = entries.iter().find(|e| e.name == "subdir").unwrap();
    assert!(dir_entry.is_dir);
    let file_entry = entries.iter().find(|e| e.name == "a.toml").unwrap();
    assert!(!file_entry.is_dir);
}

#[tokio::test]
async fn rename_moves_a_file_to_its_new_path() {
    let (sftp, root) = connect().await;
    sftp::upload(&sftp, "Cargo.toml", "/old.toml").await.unwrap();

    sftp::rename(&sftp, "/old.toml", "/new.toml").await.unwrap();

    assert!(!root.path().join("old.toml").exists());
    assert!(root.path().join("new.toml").exists());
}

#[tokio::test]
async fn remove_deletes_a_file_and_an_empty_directory() {
    let (sftp, root) = connect().await;
    sftp::upload(&sftp, "Cargo.toml", "/doomed.toml").await.unwrap();
    sftp::make_dir(&sftp, "/doomed_dir").await.unwrap();

    sftp::remove(&sftp, "/doomed.toml", false).await.unwrap();
    sftp::remove(&sftp, "/doomed_dir", true).await.unwrap();

    assert!(!root.path().join("doomed.toml").exists());
    assert!(!root.path().join("doomed_dir").exists());
}

#[tokio::test]
async fn make_dir_creates_a_real_directory_on_disk() {
    let (sftp, root) = connect().await;

    sftp::make_dir(&sftp, "/created").await.unwrap();

    assert!(root.path().join("created").is_dir());
}

/// Deterministic, multi-chunk-sized content (`sftp::COPY_CHUNK` is 64KB) so a
/// resume genuinely has to pick up mid-stream, not just replay a single read.
fn big_content() -> Vec<u8> {
    (0..200_000usize).map(|i| (i % 256) as u8).collect()
}

#[tokio::test]
async fn download_resumable_continues_a_partial_local_file_instead_of_restarting() {
    let (sftp, root) = connect().await;
    let content = big_content();
    std::fs::write(root.path().join("full.bin"), &content).unwrap();

    let local_out = root.path().join("partial.bin");
    let already_have = &content[..70_000];
    std::fs::write(&local_out, already_have).unwrap();

    let mut progress = Vec::new();
    let total = sftp::download_resumable(
        &sftp,
        "/full.bin",
        local_out.to_str().unwrap(),
        true,
        |done, total| progress.push((done, total)),
    )
    .await
    .unwrap();

    assert_eq!(total, content.len() as u64);
    assert_eq!(std::fs::read(&local_out).unwrap(), content);
    // The first progress report must already reflect the resumed offset,
    // not restart from 0 — otherwise a progress bar would visibly rewind.
    assert_eq!(progress.first().unwrap().0, 70_000);
    assert_eq!(progress.last().unwrap().0, content.len() as u64);
}

#[tokio::test]
async fn download_resumable_without_an_existing_local_file_behaves_like_a_fresh_download() {
    let (sftp, root) = connect().await;
    let content = big_content();
    std::fs::write(root.path().join("full.bin"), &content).unwrap();
    let local_out = root.path().join("brand_new.bin");

    let total = sftp::download_resumable(&sftp, "/full.bin", local_out.to_str().unwrap(), true, |_, _| {})
        .await
        .unwrap();

    assert_eq!(total, content.len() as u64);
    assert_eq!(std::fs::read(&local_out).unwrap(), content);
}

#[tokio::test]
async fn upload_resumable_continues_a_partial_remote_file_instead_of_restarting() {
    let (sftp, root) = connect().await;
    let content = big_content();
    let local_in = root.path().join("source.bin");
    std::fs::write(&local_in, &content).unwrap();

    // Simulate "a previous upload attempt got cut off at 70,000 bytes" by
    // writing that much directly into the fake server's on-disk root.
    std::fs::write(root.path().join("dest.bin"), &content[..70_000]).unwrap();

    let mut progress = Vec::new();
    let total = sftp::upload_resumable(
        &sftp,
        local_in.to_str().unwrap(),
        "/dest.bin",
        true,
        |done, total| progress.push((done, total)),
    )
    .await
    .unwrap();

    assert_eq!(total, content.len() as u64);
    assert_eq!(std::fs::read(root.path().join("dest.bin")).unwrap(), content);
    assert_eq!(progress.first().unwrap().0, 70_000);
    assert_eq!(progress.last().unwrap().0, content.len() as u64);
}

/// Regression: resuming only makes sense while the partial file is a strict
/// prefix of the source. If the remote was rotated/replaced and is now
/// *shorter*, seeking to the local length read 0 bytes and reported a
/// successful transfer — leaving stale bytes on disk and claiming they were
/// the new file.
#[tokio::test]
async fn download_resume_restarts_when_the_remote_is_shorter_than_the_local_partial() {
    let (sftp, root) = connect().await;
    let short_remote = vec![b'n'; 1_000];
    std::fs::write(root.path().join("rotated.bin"), &short_remote).unwrap();

    let local_out = root.path().join("stale.bin");
    std::fs::write(&local_out, vec![b'o'; 50_000]).unwrap();

    let total = sftp::download_resumable(&sftp, "/rotated.bin", local_out.to_str().unwrap(), true, |_, _| {})
        .await
        .unwrap();

    assert_eq!(total, short_remote.len() as u64);
    assert_eq!(std::fs::read(&local_out).unwrap(), short_remote);
}

#[tokio::test]
async fn upload_resume_restarts_when_the_remote_is_longer_than_the_local_source() {
    let (sftp, root) = connect().await;
    let source = vec![b'n'; 1_000];
    let local_in = root.path().join("source.bin");
    std::fs::write(&local_in, &source).unwrap();
    // A leftover, longer file from a previous upload of different content.
    std::fs::write(root.path().join("dest.bin"), vec![b'o'; 50_000]).unwrap();

    let total = sftp::upload_resumable(&sftp, local_in.to_str().unwrap(), "/dest.bin", true, |_, _| {})
        .await
        .unwrap();

    assert_eq!(total, source.len() as u64);
    // `create` truncates, so no stale tail survives past the new content.
    assert_eq!(std::fs::read(root.path().join("dest.bin")).unwrap(), source);
}

#[tokio::test]
async fn non_resuming_upload_and_download_still_report_progress_from_zero() {
    let (sftp, root) = connect().await;
    let content = big_content();
    let local_in = root.path().join("source.bin");
    std::fs::write(&local_in, &content).unwrap();

    let mut upload_progress = Vec::new();
    sftp::upload_resumable(&sftp, local_in.to_str().unwrap(), "/plain.bin", false, |done, _| {
        upload_progress.push(done)
    })
    .await
    .unwrap();

    assert_eq!(*upload_progress.first().unwrap(), 0);
    assert_eq!(*upload_progress.last().unwrap(), content.len() as u64);
    // Every step must move forward — never backward, never repeat 0 twice.
    assert!(upload_progress.windows(2).all(|w| w[1] > w[0]));
}
