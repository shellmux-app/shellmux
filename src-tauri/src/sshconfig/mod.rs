//! Import `~/.ssh/config` — cách nhanh nhất để onboard hàng trăm host có sẵn.
//!
//! Ý tưởng lấy từ Tabby (`tabby-electron/src/sshImporters.ts`): id của host
//! được dẫn xuất từ alias nên import lại là cập nhật, không nhân bản.

pub mod import;
pub mod parse;

pub use import::{default_config_path, import_into, ImportReport};
pub use parse::{parse, SshConfigHost};
