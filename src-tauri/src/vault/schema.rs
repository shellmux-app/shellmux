/// Initial schema. Each time a table is added, bump `SCHEMA_VERSION` and add a
/// migration step in `migrate()` — don't edit the old DDL directly.
pub const SCHEMA_VERSION: i64 = 1;

pub const INIT_SQL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS groups (
    id        TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    sort      INTEGER NOT NULL DEFAULT 0
);

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
