/// Schema version currently expected by the code. `Vault::open` compares it
/// against the database's `user_version` and applies the missing steps from
/// `MIGRATIONS`, so an existing vault is upgraded in place rather than reset.
///
/// To change the schema: append a step to `MIGRATIONS`, bump this number, and
/// leave `INIT_SQL` and the earlier steps alone — they describe databases that
/// already exist on disk.
pub const SCHEMA_VERSION: i64 = 3;

pub const INIT_SQL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS groups (
    id        TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    sort      INTEGER NOT NULL DEFAULT 0
);

-- An identity is a reusable *private key*. `auth_kind` and `username` are
-- retained only so that vaults created before schema v2 still open; nothing
-- reads them any more. See MIGRATIONS[0] for why they went away.
CREATE TABLE IF NOT EXISTS identities (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    auth_kind        TEXT NOT NULL,
    username         TEXT,
    private_key_path TEXT,
    has_secret       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hosts (
    id           TEXT PRIMARY KEY,
    group_id     TEXT REFERENCES groups(id) ON DELETE SET NULL,
    label        TEXT NOT NULL,
    hostname     TEXT NOT NULL,
    port         INTEGER NOT NULL DEFAULT 22,
    username     TEXT NOT NULL,
    identity_id  TEXT REFERENCES identities(id) ON DELETE SET NULL,
    jump_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
    theme        TEXT,
    color_tag    TEXT,
    notes        TEXT,
    sort         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_hosts_group ON hosts(group_id);

CREATE TABLE IF NOT EXISTS snippets (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    body         TEXT NOT NULL,
    group_id     TEXT REFERENCES groups(id) ON DELETE SET NULL,
    send_newline INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tunnels (
    id          TEXT PRIMARY KEY,
    host_id     TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    bind_addr   TEXT NOT NULL DEFAULT '127.0.0.1',
    bind_port   INTEGER NOT NULL,
    target_host TEXT NOT NULL,
    target_port INTEGER NOT NULL,
    auto_start  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS known_hosts (
    host        TEXT NOT NULL,
    port        INTEGER NOT NULL,
    algo        TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (host, port)
);
"#;

/// One entry per schema version, applied in order. `MIGRATIONS[n]` upgrades a
/// database at `user_version == n` to `user_version == n + 1`.
pub const MIGRATIONS: &[&str] = &[
    // v1 -> v2: how a host authenticates becomes a property of the *host*.
    //
    // Before this, credentials could only be attached by pointing a host at an
    // identity, and the identity carried the auth kind. That works for keys,
    // which are genuinely shared between hosts, but it forces a password —
    // which belongs to exactly one account on one machine — through the same
    // shared object, and lets the identity silently override the host's
    // username. Hosts now say how they authenticate; identities are only keys.
    //
    // `identity_id` stays as the payload of the 'key' choice, and the legacy
    // `identities.auth_kind` / `identities.username` columns are left in place
    // so this migration stays reversible by restoring a file copy.
    r#"
    ALTER TABLE hosts ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'agent';

    UPDATE hosts SET auth_kind = CASE
        WHEN identity_id IS NULL THEN 'agent'
        ELSE COALESCE(
            (SELECT CASE i.auth_kind
                        WHEN 'privateKey' THEN 'key'
                        WHEN 'password'   THEN 'password'
                        ELSE 'agent'
                    END
             FROM identities i WHERE i.id = hosts.identity_id),
            'agent')
    END;
    "#,
    // v2 -> v3: per-host opt-in to forward this connection's own auth onward
    // (the system ssh-agent, or a decrypted-in-memory copy of the host's own
    // key) to whatever the host itself connects to next.
    r#"
    ALTER TABLE hosts ADD COLUMN agent_forward INTEGER NOT NULL DEFAULT 0;
    "#,
];
