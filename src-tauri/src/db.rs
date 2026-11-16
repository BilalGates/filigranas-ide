use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

/// Abre (o crea) la base de datos local y aplica el esquema.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS settings (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS groups (
             id       INTEGER PRIMARY KEY,
             name     TEXT NOT NULL UNIQUE,
             position INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS projects (
             path     TEXT PRIMARY KEY,
             group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
             archived INTEGER NOT NULL DEFAULT 0
         );
         -- Sesiones de agentes ejecutores. `provider_session` es el id que
         -- usa el motor para reanudarla (p. ej. el UUID de Claude Code).
         CREATE TABLE IF NOT EXISTS sessions (
             id               INTEGER PRIMARY KEY,
             project          TEXT NOT NULL,
             engine           TEXT NOT NULL,
             name             TEXT NOT NULL,
             provider_session TEXT NOT NULL,
             effort           TEXT,
             closed           INTEGER NOT NULL DEFAULT 0,
             created_at       INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project, closed);",
    )?;
    migrate(&conn)?;
    Ok(conn)
}

/// Cambios aditivos sobre bases ya creadas: solo añaden columnas que falten.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let has = |col: &str| -> rusqlite::Result<bool> {
        conn.query_row("SELECT count(*) FROM pragma_table_info('projects') WHERE name = ?1", [col], |r| r.get::<_, i64>(0))
            .map(|n| n > 0)
    };
    if !has("coordinator_thread")? {
        // Hilo de Codex del coordinador del proyecto.
        conn.execute_batch("ALTER TABLE projects ADD COLUMN coordinator_thread TEXT")?;
    }
    if !has("coordinator_profile")? {
        conn.execute_batch("ALTER TABLE projects ADD COLUMN coordinator_profile TEXT NOT NULL DEFAULT 'hansi'")?;
    }
    Ok(())
}

/// Hilo guardado y perfil del coordinador de un proyecto.
pub fn coordinator(conn: &Connection, path: &str) -> rusqlite::Result<(Option<String>, String)> {
    conn.query_row("SELECT coordinator_thread, coordinator_profile FROM projects WHERE path = ?1", [path], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .optional()
    .map(|row| row.unwrap_or((None, "hansi".into())))
}

pub fn set_coordinator_thread(conn: &Connection, path: &str, thread: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO projects (path, coordinator_thread) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET coordinator_thread = excluded.coordinator_thread",
        params![path, thread],
    )?;
    Ok(())
}

pub fn set_coordinator_profile(conn: &Connection, path: &str, profile: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO projects (path, coordinator_profile) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET coordinator_profile = excluded.coordinator_profile",
        params![path, profile],
    )?;
    Ok(())
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: i64,
    pub project: String,
    pub engine: String,
    pub name: String,
    pub provider_session: String,
    pub effort: Option<String>,
}

const SESSION_COLS: &str = "id, project, engine, name, provider_session, effort";

fn session_row(r: &rusqlite::Row) -> rusqlite::Result<Session> {
    Ok(Session { id: r.get(0)?, project: r.get(1)?, engine: r.get(2)?, name: r.get(3)?, provider_session: r.get(4)?, effort: r.get(5)? })
}

/// Sesiones abiertas de un proyecto, de la más antigua a la más nueva.
pub fn sessions(conn: &Connection, project: &str) -> rusqlite::Result<Vec<Session>> {
    let mut stmt = conn.prepare(&format!("SELECT {SESSION_COLS} FROM sessions WHERE project = ?1 AND closed = 0 ORDER BY id"))?;
    let rows = stmt.query_map([project], session_row)?;
    rows.collect()
}

pub fn session(conn: &Connection, id: i64) -> rusqlite::Result<Option<Session>> {
    conn.query_row(&format!("SELECT {SESSION_COLS} FROM sessions WHERE id = ?1 AND closed = 0"), [id], session_row).optional()
}

/// Crea una sesión con el primer nombre de `names` que no use otra sesión
/// abierta del proyecto.
pub fn create_session(conn: &Connection, project: &str, engine: &str, provider_session: &str, names: &[&str]) -> rusqlite::Result<Session> {
    let used: Vec<String> = sessions(conn, project)?.into_iter().map(|s| s.name).collect();
    let name = names
        .iter()
        .find(|n| !used.iter().any(|u| u == *n))
        .map(|n| n.to_string())
        .unwrap_or_else(|| format!("{}-{}", names[0], used.len() + 1));
    conn.execute(
        "INSERT INTO sessions (project, engine, name, provider_session) VALUES (?1, ?2, ?3, ?4)",
        params![project, engine, name, provider_session],
    )?;
    Ok(session(conn, conn.last_insert_rowid())?.expect("recién creada"))
}

/// Id de sesión del motor, cuando el motor lo asigna al crearla (ACP).
pub fn set_provider_session(conn: &Connection, id: i64, provider_session: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE sessions SET provider_session = ?2 WHERE id = ?1", params![id, provider_session])?;
    Ok(())
}

pub fn set_session_effort(conn: &Connection, id: i64, effort: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE sessions SET effort = ?2 WHERE id = ?1", params![id, effort])?;
    Ok(())
}

/// Cierra la sesión en el IDE. El motor conserva su transcript.
pub fn close_session(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE sessions SET closed = 1 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_keeps_existing_rows() {
        let dir = std::env::temp_dir().join(format!("filigranas-db-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("app.db");
        // Base con el esquema de la entrega 1 y datos.
        let old = Connection::open(&file).unwrap();
        old.execute_batch(
            "CREATE TABLE projects (path TEXT PRIMARY KEY, group_id INTEGER, archived INTEGER NOT NULL DEFAULT 0);
             INSERT INTO projects (path, archived) VALUES ('/r/a', 1);",
        )
        .unwrap();
        drop(old);

        let conn = open(&file).unwrap();
        open(&file).unwrap(); // idempotente
        assert_eq!(coordinator(&conn, "/r/a").unwrap(), (None, "hansi".into()));
        assert_eq!(coordinator(&conn, "/r/nuevo").unwrap(), (None, "hansi".into()));
        set_coordinator_thread(&conn, "/r/a", Some("t1")).unwrap();
        set_coordinator_profile(&conn, "/r/b", "pep").unwrap();
        assert_eq!(coordinator(&conn, "/r/a").unwrap(), (Some("t1".into()), "hansi".into()));
        assert_eq!(coordinator(&conn, "/r/b").unwrap(), (None, "pep".into()));
        let archived: i64 = conn.query_row("SELECT archived FROM projects WHERE path = '/r/a'", [], |r| r.get(0)).unwrap();
        assert_eq!(archived, 1);
        drop(conn);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn session_names_are_unique_among_open_sessions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        // Esquema completo a través de `open` no admite memoria: se repite aquí.
        conn.execute_batch(
            "CREATE TABLE sessions (id INTEGER PRIMARY KEY, project TEXT NOT NULL, engine TEXT NOT NULL, name TEXT NOT NULL,
             provider_session TEXT NOT NULL, effort TEXT, closed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()));",
        )
        .unwrap();
        let names = ["xavi", "iniesta"];
        let a = create_session(&conn, "/r/p", "claude", "u1", &names).unwrap();
        let b = create_session(&conn, "/r/p", "claude", "u2", &names).unwrap();
        let other = create_session(&conn, "/r/q", "claude", "u3", &names).unwrap();
        assert_eq!((a.name.as_str(), b.name.as_str(), other.name.as_str()), ("xavi", "iniesta", "xavi"));
        assert_eq!(create_session(&conn, "/r/p", "claude", "u4", &names).unwrap().name, "xavi-3");
        close_session(&conn, a.id).unwrap();
        assert_eq!(create_session(&conn, "/r/p", "claude", "u5", &names).unwrap().name, "xavi");
        set_session_effort(&conn, b.id, "high").unwrap();
        assert_eq!(session(&conn, b.id).unwrap().unwrap().effort.as_deref(), Some("high"));
        assert!(session(&conn, a.id).unwrap().is_none());
        assert_eq!(sessions(&conn, "/r/p").unwrap().len(), 3);
    }
}
