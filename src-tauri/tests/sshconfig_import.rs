//! Import `~/.ssh/config` vào vault: đúng số host, link jump, và chạy lại
//! không nhân bản.

mod common;

use common::temp_vault_with_key;
use shellmux_lib::sshconfig::import_into;

// `Host *` nằm ở CUỐI file — đúng như ssh_config(5) khuyến nghị, vì OpenSSH lấy
// giá trị khớp *đầu tiên*. Đặt nó ở đầu thì nó sẽ đè mọi khối phía dưới.
const CONFIG: &str = "\
Host bastion
  HostName 203.0.113.10
  User admin
  IdentityFile ~/.ssh/id_bastion

Host db-1 db-2
  HostName 10.0.0.21
  Port 2222
  ProxyJump bastion
  IdentityFile ~/.ssh/id_prod

Host orphan
  HostName 10.0.0.99
  ProxyJump khong-ton-tai

Host *
  User ubuntu
  ServerAliveInterval 60
";

#[test]
fn imports_every_concrete_host_and_skips_wildcard_blocks() {
    // Arrange
    let fx = temp_vault_with_key();

    // Act
    let report = import_into(&fx.vault, CONFIG).expect("import");

    // Assert
    assert_eq!(report.hosts, 4, "bastion, db-1, db-2, orphan");
    assert_eq!(report.wildcard_blocks, 1);

    let hosts = fx.vault.list_hosts().unwrap();
    let labels: Vec<&str> = hosts.iter().map(|h| h.label.as_str()).collect();
    assert!(labels.contains(&"bastion"));
    assert!(labels.contains(&"db-1"));
    assert!(labels.contains(&"db-2"));
    assert!(!labels.contains(&"*"), "khối wildcard không được thành host");
}

#[test]
fn wildcard_defaults_apply_to_hosts_that_do_not_override_them() {
    let fx = temp_vault_with_key();
    import_into(&fx.vault, CONFIG).unwrap();

    let hosts = fx.vault.list_hosts().unwrap();
    let db = hosts.iter().find(|h| h.label == "db-1").unwrap();
    let bastion = hosts.iter().find(|h| h.label == "bastion").unwrap();

    assert_eq!(db.username, "ubuntu", "lấy từ khối Host * ở cuối file");
    assert_eq!(
        bastion.username, "admin",
        "khối riêng đứng trước nên thắng khối * đứng sau"
    );
    assert_eq!(db.port, 2222);
    assert_eq!(bastion.port, 22, "không khai Port thì mặc định 22");
}

#[test]
fn proxy_jump_is_linked_to_the_imported_bastion() {
    let fx = temp_vault_with_key();
    let report = import_into(&fx.vault, CONFIG).unwrap();

    let hosts = fx.vault.list_hosts().unwrap();
    let db = hosts.iter().find(|h| h.label == "db-1").unwrap();
    let bastion = hosts.iter().find(|h| h.label == "bastion").unwrap();

    assert_eq!(db.jump_host_id.as_deref(), Some(bastion.id.as_str()));
    assert_eq!(report.jumps_linked, 2, "db-1 và db-2");
}

#[test]
fn unresolved_jump_is_reported_not_silently_dropped() {
    let fx = temp_vault_with_key();
    let report = import_into(&fx.vault, CONFIG).unwrap();

    let hosts = fx.vault.list_hosts().unwrap();
    let orphan = hosts.iter().find(|h| h.label == "orphan").unwrap();

    assert_eq!(orphan.jump_host_id, None);
    assert_eq!(report.unresolved_jumps, vec!["khong-ton-tai".to_string()]);
}

#[test]
fn identity_files_become_reusable_identities_deduped_by_path() {
    let fx = temp_vault_with_key();
    let report = import_into(&fx.vault, CONFIG).unwrap();

    // id_bastion + id_prod = 2 identity mới; db-1 và db-2 dùng chung id_prod.
    assert_eq!(report.identities, 2);

    let hosts = fx.vault.list_hosts().unwrap();
    let db1 = hosts.iter().find(|h| h.label == "db-1").unwrap();
    let db2 = hosts.iter().find(|h| h.label == "db-2").unwrap();
    assert_eq!(db1.identity_id, db2.identity_id);
    assert!(db1.identity_id.is_some());
}

#[test]
fn importing_twice_updates_instead_of_duplicating() {
    let fx = temp_vault_with_key();

    import_into(&fx.vault, CONFIG).unwrap();
    let after_first = fx.vault.list_hosts().unwrap().len();

    // Lần hai: đổi cổng của db-1 trong file để kiểm tra là cập nhật thật.
    let changed = CONFIG.replace("Port 2222", "Port 2200");
    import_into(&fx.vault, &changed).unwrap();
    let hosts = fx.vault.list_hosts().unwrap();

    assert_eq!(hosts.len(), after_first, "không được sinh bản sao");
    let db = hosts.iter().find(|h| h.label == "db-1").unwrap();
    assert_eq!(db.port, 2200, "phải cập nhật giá trị mới");
}

#[test]
fn imported_hosts_land_in_their_own_group() {
    let fx = temp_vault_with_key();
    import_into(&fx.vault, CONFIG).unwrap();

    let groups = fx.vault.list_groups().unwrap();
    let group = groups
        .iter()
        .find(|g| g.name.contains("ssh/config"))
        .expect("phải có nhóm riêng");

    let hosts = fx.vault.list_hosts().unwrap();
    assert!(hosts
        .iter()
        .all(|h| h.group_id.as_deref() == Some(group.id.as_str())));
}

#[test]
fn empty_config_is_not_an_error() {
    let fx = temp_vault_with_key();

    let report = import_into(&fx.vault, "# không có gì\n").unwrap();

    assert_eq!(report.hosts, 0);
    assert!(fx.vault.list_hosts().unwrap().is_empty());
}
