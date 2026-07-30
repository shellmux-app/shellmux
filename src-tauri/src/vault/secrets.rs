use std::sync::OnceLock;

use keyring::Entry;

use crate::error::AppResult;

const SERVICE: &str = "dev.shellmux.vault";

/// `keyring` 4 cài credential store mặc định *lazily* bên trong `Entry::new`,
/// và cờ đánh dấu được set trước khi store thật sự sẵn sàng. Hai task cùng
/// gọi lần đầu thì một task thấy cờ đã bật nhưng store còn trống và nhận
/// `NoDefaultStore`. `OnceLock` bắt mọi caller chờ lần khởi tạo đầu tiên xong.
static STORE_READY: OnceLock<()> = OnceLock::new();

fn entry(account: &str) -> AppResult<Entry> {
    STORE_READY.get_or_init(|| {
        // Chỉ để kích hoạt store; không đọc/ghi nên không có prompt nào.
        let _ = Entry::new(SERVICE, "__warmup__");
    });
    Ok(Entry::new(SERVICE, account)?)
}

/// Gọi lúc khởi động để lần connect đầu tiên không phải trả giá khởi tạo.
pub fn warm_up() {
    STORE_READY.get_or_init(|| {
        let _ = Entry::new(SERVICE, "__warmup__");
    });
}

/// Wrapper để password/passphrase không bao giờ lọt vào log hay panic message.
pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

/// Khoá trong keychain: `identity:<id>` — một secret cho mỗi identity
/// (password hoặc passphrase của key, tuỳ `auth_kind`).
fn account_for(identity_id: &str) -> String {
    format!("identity:{identity_id}")
}

pub fn store(identity_id: &str, value: &str) -> AppResult<()> {
    entry(&account_for(identity_id))?.set_password(value)?;
    Ok(())
}

/// Trả `None` khi chưa có secret nào được lưu — đây không phải lỗi, nhiều
/// identity (agent, key không passphrase) vốn không cần secret.
pub fn load(identity_id: &str) -> AppResult<Option<Secret>> {
    match entry(&account_for(identity_id))?.get_password() {
        Ok(v) => Ok(Some(Secret(v))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete(identity_id: &str) -> AppResult<()> {
    match entry(&account_for(identity_id))?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
