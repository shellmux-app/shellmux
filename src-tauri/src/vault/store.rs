use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::model::*;
use super::schema::{INIT_SQL, SCHEMA_VERSION};
use crate::error::{AppError, AppResult};

/// Metadata store. Does not hold secrets — only the `has_secret` flag.
/// Every function returns a new struct; none take `&mut` to mutate in place.
pub struct Vault {
    conn: Mutex<Connection>,
}

impl Vault {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(INIT_SQL)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| AppError::Vault("vault mutex was poisoned".into()))
    }

    // ---------------------------------------------------------------- groups

    pub fn list_groups(&self) -> AppResult<Vec<Group>> {
        let conn = self.lock()?;
        let mut stmt =
            conn.prepare("SELECT id, parent_id, name, sort FROM groups ORDER BY sort, name")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Group {
                    id: r.get(0)?,
                    parent_id: r.get(1)?,
                    name: r.get(2)?,
                    sort: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn upsert_group(&self, g: &Group) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO groups (id, parent_id, name, sort) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET parent_id = ?2, name = ?3, sort = ?4",
            params![g.id, g.parent_id, g.name, g.sort],
        )?;
        Ok(())
    }

    pub fn delete_group(&self, id: &str) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM groups WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------------------------------------------------------ identities

    pub fn list_identities(&self) -> AppResult<Vec<Identity>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, auth_kind, username, private_key_path, has_secret
             FROM identities ORDER BY name",
        )?;
        let rows = stmt
            .query_map([], map_identity)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_identity(&self, id: &str) -> AppResult<Identity> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT id, name, auth_kind, username, private_key_path, has_secret
             FROM identities WHERE id = ?1",
            params![id],
            map_identity,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound {
            kind: "identity",
            id: id.to_string(),
        })
    }

    pub fn upsert_identity(&self, i: &Identity) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO identities (id, name, auth_kind, username, private_key_path, has_secret)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                name = ?2, auth_kind = ?3, username = ?4, private_key_path = ?5, has_secret = ?6",
            params![
                i.id,
                i.name,
                i.auth_kind.as_str(),
                i.username,
                i.private_key_path,
                i.has_secret as i64,
            ],
        )?;
        Ok(())
    }

    pub fn set_identity_secret_flag(&self, id: &str, has_secret: bool) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE identities SET has_secret = ?2 WHERE id = ?1",
            params![id, has_secret as i64],
        )?;
        Ok(())
    }

    pub fn delete_identity(&self, id: &str) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM identities WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ----------------------------------------------------------------- hosts

    pub fn list_hosts(&self) -> AppResult<Vec<Host>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, group_id, label, hostname, port, username, identity_id,
                    jump_host_id, theme, color_tag, notes, sort
             FROM hosts ORDER BY sort, label",
        )?;
        let rows = stmt
            .query_map([], map_host)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_host(&self, id: &str) -> AppResult<Host> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT id, group_id, label, hostname, port, username, identity_id,
                    jump_host_id, theme, color_tag, notes, sort
             FROM hosts WHERE id = ?1",
            params![id],
            map_host,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound {
            kind: "host",
            id: id.to_string(),
        })
    }

    pub fn upsert_host(&self, h: &Host) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO hosts (id, group_id, label, hostname, port, username, identity_id,
                                jump_host_id, theme, color_tag, notes, sort)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                group_id = ?2, label = ?3, hostname = ?4, port = ?5, username = ?6,
                identity_id = ?7, jump_host_id = ?8, theme = ?9, color_tag = ?10,
                notes = ?11, sort = ?12",
            params![
                h.id,
                h.group_id,
                h.label,
                h.hostname,
                h.port,
                h.username,
                h.identity_id,
                h.jump_host_id,
                h.theme,
                h.color_tag,
                h.notes,
                h.sort,
            ],
        )?;
        Ok(())
    }

    pub fn delete_host(&self, id: &str) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM hosts WHERE id = ?1", params![id])?;
        Ok(())
    }

    // -------------------------------------------------------------- snippets

    pub fn list_snippets(&self) -> AppResult<Vec<Snippet>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, body, group_id, send_newline FROM snippets ORDER BY name",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Snippet {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    body: r.get(2)?,
                    group_id: r.get(3)?,
                    send_newline: r.get::<_, i64>(4)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn upsert_snippet(&self, s: &Snippet) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO snippets (id, name, body, group_id, send_newline)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET name = ?2, body = ?3, group_id = ?4, send_newline = ?5",
            params![s.id, s.name, s.body, s.group_id, s.send_newline as i64],
        )?;
        Ok(())
    }

    pub fn delete_snippet(&self, id: &str) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --------------------------------------------------------------- tunnels

    pub fn list_tunnels(&self) -> AppResult<Vec<TunnelSpec>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, host_id, name, kind, bind_addr, bind_port, target_host,
                    target_port, auto_start
             FROM tunnels ORDER BY name",
        )?;
        let rows = stmt
            .query_map([], map_tunnel)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_tunnel(&self, id: &str) -> AppResult<TunnelSpec> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT id, host_id, name, kind, bind_addr, bind_port, target_host,
                    target_port, auto_start
             FROM tunnels WHERE id = ?1",
            params![id],
            map_tunnel,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound {
            kind: "tunnel",
            id: id.to_string(),
        })
    }

    pub fn upsert_tunnel(&self, t: &TunnelSpec) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO tunnels (id, host_id, name, kind, bind_addr, bind_port,
                                  target_host, target_port, auto_start)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                host_id = ?2, name = ?3, kind = ?4, bind_addr = ?5, bind_port = ?6,
                target_host = ?7, target_port = ?8, auto_start = ?9",
            params![
                t.id,
                t.host_id,
                t.name,
                t.kind.as_str(),
                t.bind_addr,
                t.bind_port,
                t.target_host,
                t.target_port,
                t.auto_start as i64,
            ],
        )?;
        Ok(())
    }

    pub fn delete_tunnel(&self, id: &str) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM tunnels WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ----------------------------------------------------------- known hosts

    pub fn get_known_host(&self, host: &str, port: u16) -> AppResult<Option<KnownHost>> {
        let conn = self.lock()?;
        let row = conn
            .query_row(
                "SELECT host, port, algo, fingerprint, added_at
                 FROM known_hosts WHERE host = ?1 AND port = ?2",
                params![host, port],
                |r| {
                    Ok(KnownHost {
                        host: r.get(0)?,
                        port: r.get::<_, i64>(1)? as u16,
                        algo: r.get(2)?,
                        fingerprint: r.get(3)?,
                        added_at: r.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn list_known_hosts(&self) -> AppResult<Vec<KnownHost>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT host, port, algo, fingerprint, added_at
             FROM known_hosts ORDER BY host, port",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(KnownHost {
                    host: r.get(0)?,
                    port: r.get::<_, i64>(1)? as u16,
                    algo: r.get(2)?,
                    fingerprint: r.get(3)?,
                    added_at: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn put_known_host(&self, host: &str, port: u16, algo: &str, fp: &str) -> AppResult<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default();
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO known_hosts (host, port, algo, fingerprint, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(host, port) DO UPDATE SET algo = ?3, fingerprint = ?4, added_at = ?5",
            params![host, port, algo, fp, now],
        )?;
        Ok(())
    }

    pub fn forget_known_host(&self, host: &str, port: u16) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute(
            "DELETE FROM known_hosts WHERE host = ?1 AND port = ?2",
            params![host, port],
        )?;
        Ok(())
    }
}

fn map_identity(r: &Row<'_>) -> rusqlite::Result<Identity> {
    Ok(Identity {
        id: r.get(0)?,
        name: r.get(1)?,
        auth_kind: AuthKind::from_str(&r.get::<_, String>(2)?),
        username: r.get(3)?,
        private_key_path: r.get(4)?,
        has_secret: r.get::<_, i64>(5)? != 0,
    })
}

fn map_host(r: &Row<'_>) -> rusqlite::Result<Host> {
    Ok(Host {
        id: r.get(0)?,
        group_id: r.get(1)?,
        label: r.get(2)?,
        hostname: r.get(3)?,
        port: r.get::<_, i64>(4)? as u16,
        username: r.get(5)?,
        identity_id: r.get(6)?,
        jump_host_id: r.get(7)?,
        theme: r.get(8)?,
        color_tag: r.get(9)?,
        notes: r.get(10)?,
        sort: r.get(11)?,
    })
}

fn map_tunnel(r: &Row<'_>) -> rusqlite::Result<TunnelSpec> {
    Ok(TunnelSpec {
        id: r.get(0)?,
        host_id: r.get(1)?,
        name: r.get(2)?,
        kind: TunnelKind::from_str(&r.get::<_, String>(3)?),
        bind_addr: r.get(4)?,
        bind_port: r.get::<_, i64>(5)? as u16,
        target_host: r.get(6)?,
        target_port: r.get::<_, i64>(7)? as u16,
        auto_start: r.get::<_, i64>(8)? != 0,
    })
}
