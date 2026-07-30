//! Vault store: CRUD and known-hosts. Doesn't touch the keychain, so it's safe in CI.

use shellmux_lib::vault::{
    AuthKind, Group, Host, Identity, Snippet, TunnelKind, TunnelSpec, Vault,
};

fn temp_vault() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = Vault::open(&dir.path().join("vault.db")).expect("open vault");
    (dir, vault)
}

fn host_fixture(id: &str, group_id: Option<String>) -> Host {
    Host {
        id: id.into(),
        group_id,
        label: "web-01".into(),
        hostname: "10.0.0.5".into(),
        port: 2222,
        username: "deploy".into(),
        identity_id: None,
        jump_host_id: None,
        theme: None,
        color_tag: None,
        notes: None,
        sort: 0,
    }
}

#[test]
fn upsert_host_then_read_back_roundtrips_every_field() {
    // Arrange
    let (_dir, vault) = temp_vault();
    let host = host_fixture("h1", None);

    // Act
    vault.upsert_host(&host).expect("insert");
    let loaded = vault.get_host("h1").expect("get");

    // Assert
    assert_eq!(loaded.hostname, "10.0.0.5");
    assert_eq!(loaded.port, 2222);
    assert_eq!(loaded.username, "deploy");
    assert_eq!(loaded.label, "web-01");
}

#[test]
fn upsert_with_existing_id_updates_instead_of_duplicating() {
    let (_dir, vault) = temp_vault();
    vault.upsert_host(&host_fixture("h1", None)).unwrap();

    let renamed = Host {
        label: "web-01-renamed".into(),
        port: 22,
        ..host_fixture("h1", None)
    };
    vault.upsert_host(&renamed).unwrap();

    let all = vault.list_hosts().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].label, "web-01-renamed");
    assert_eq!(all[0].port, 22);
}

#[test]
fn get_host_returns_not_found_for_unknown_id() {
    let (_dir, vault) = temp_vault();
    let err = vault.get_host("missing").unwrap_err();
    assert!(err.to_string().contains("missing"), "got: {err}");
}

#[test]
fn deleting_group_leaves_hosts_but_clears_their_group() {
    let (_dir, vault) = temp_vault();
    let group = Group {
        id: "g1".into(),
        parent_id: None,
        name: "Production".into(),
        sort: 0,
    };
    vault.upsert_group(&group).unwrap();
    vault
        .upsert_host(&host_fixture("h1", Some("g1".into())))
        .unwrap();

    vault.delete_group("g1").unwrap();

    let host = vault.get_host("h1").expect("host should still exist");
    assert_eq!(host.group_id, None, "ON DELETE SET NULL must keep the host");
}

#[test]
fn nested_groups_survive_parent_child_links() {
    let (_dir, vault) = temp_vault();
    vault
        .upsert_group(&Group {
            id: "root".into(),
            parent_id: None,
            name: "Production".into(),
            sort: 0,
        })
        .unwrap();
    vault
        .upsert_group(&Group {
            id: "child".into(),
            parent_id: Some("root".into()),
            name: "eu-west".into(),
            sort: 1,
        })
        .unwrap();

    let groups = vault.list_groups().unwrap();
    let child = groups.iter().find(|g| g.id == "child").unwrap();
    assert_eq!(child.parent_id.as_deref(), Some("root"));
}

#[test]
fn identity_secret_flag_persists_without_storing_the_secret() {
    let (_dir, vault) = temp_vault();
    let identity = Identity {
        id: "i1".into(),
        name: "deploy key".into(),
        auth_kind: AuthKind::PrivateKey,
        username: Some("deploy".into()),
        private_key_path: Some("/tmp/id_ed25519".into()),
        has_secret: true,
    };

    vault.upsert_identity(&identity).unwrap();
    let loaded = vault.get_identity("i1").unwrap();

    assert!(loaded.has_secret);
    assert_eq!(loaded.auth_kind, AuthKind::PrivateKey);
    // Only the flag and the path — no field contains the secret.
    assert_eq!(loaded.private_key_path.as_deref(), Some("/tmp/id_ed25519"));
}

#[test]
fn known_host_stores_then_overwrites_fingerprint_on_explicit_trust() {
    let (_dir, vault) = temp_vault();

    assert!(vault.get_known_host("10.0.0.5", 22).unwrap().is_none());

    vault
        .put_known_host("10.0.0.5", 22, "ssh-ed25519", "SHA256:aaa")
        .unwrap();
    let first = vault.get_known_host("10.0.0.5", 22).unwrap().unwrap();
    assert_eq!(first.fingerprint, "SHA256:aaa");

    vault
        .put_known_host("10.0.0.5", 22, "ssh-ed25519", "SHA256:bbb")
        .unwrap();
    let second = vault.get_known_host("10.0.0.5", 22).unwrap().unwrap();
    assert_eq!(second.fingerprint, "SHA256:bbb");
}

#[test]
fn known_host_is_keyed_by_port_so_two_ports_stay_independent() {
    let (_dir, vault) = temp_vault();
    vault
        .put_known_host("10.0.0.5", 22, "ssh-ed25519", "SHA256:aaa")
        .unwrap();
    vault
        .put_known_host("10.0.0.5", 2222, "ssh-ed25519", "SHA256:bbb")
        .unwrap();

    assert_eq!(
        vault.get_known_host("10.0.0.5", 22).unwrap().unwrap().fingerprint,
        "SHA256:aaa"
    );
    assert_eq!(
        vault
            .get_known_host("10.0.0.5", 2222)
            .unwrap()
            .unwrap()
            .fingerprint,
        "SHA256:bbb"
    );
}

#[test]
fn forget_known_host_removes_only_that_entry() {
    let (_dir, vault) = temp_vault();
    vault
        .put_known_host("a.example", 22, "ssh-ed25519", "SHA256:aaa")
        .unwrap();
    vault
        .put_known_host("b.example", 22, "ssh-ed25519", "SHA256:bbb")
        .unwrap();

    vault.forget_known_host("a.example", 22).unwrap();

    assert!(vault.get_known_host("a.example", 22).unwrap().is_none());
    assert!(vault.get_known_host("b.example", 22).unwrap().is_some());
}

#[test]
fn snippets_and_tunnels_roundtrip() {
    let (_dir, vault) = temp_vault();
    vault
        .upsert_snippet(&Snippet {
            id: "s1".into(),
            name: "restart nginx".into(),
            body: "sudo systemctl restart nginx".into(),
            group_id: None,
            send_newline: true,
        })
        .unwrap();
    vault.upsert_host(&host_fixture("h1", None)).unwrap();
    vault
        .upsert_tunnel(&TunnelSpec {
            id: "t1".into(),
            host_id: "h1".into(),
            name: "pg".into(),
            kind: TunnelKind::Local,
            bind_addr: "127.0.0.1".into(),
            bind_port: 15432,
            target_host: "127.0.0.1".into(),
            target_port: 5432,
            auto_start: false,
        })
        .unwrap();

    let snippet = &vault.list_snippets().unwrap()[0];
    assert!(snippet.send_newline);

    let tunnel = vault.get_tunnel("t1").unwrap();
    assert_eq!(tunnel.kind, TunnelKind::Local);
    assert_eq!(tunnel.bind_port, 15432);
}

#[test]
fn deleting_host_cascades_to_its_tunnels() {
    let (_dir, vault) = temp_vault();
    vault.upsert_host(&host_fixture("h1", None)).unwrap();
    vault
        .upsert_tunnel(&TunnelSpec {
            id: "t1".into(),
            host_id: "h1".into(),
            name: "pg".into(),
            kind: TunnelKind::Remote,
            bind_addr: "127.0.0.1".into(),
            bind_port: 15432,
            target_host: "127.0.0.1".into(),
            target_port: 5432,
            auto_start: false,
        })
        .unwrap();

    vault.delete_host("h1").unwrap();

    assert!(vault.list_tunnels().unwrap().is_empty());
}
