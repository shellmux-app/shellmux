//! Imports `~/.ssh/config` — the fastest way to onboard hundreds of existing hosts.
//!
//! Idea borrowed from Tabby (`tabby-electron/src/sshImporters.ts`): a host's id
//! is derived from its alias, so re-importing updates instead of duplicating.

pub mod import;
pub mod parse;

pub use import::{default_config_path, import_into, ImportReport};
pub use parse::{parse, SshConfigHost};
