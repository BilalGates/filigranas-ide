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
    let has_in = |table: &str, col: &str| -> rusqlite::Result<bool> {
        conn.query_row("SELECT count(*) FROM pragma_table_info(?1) WHERE name = ?2", [table, col], |r| r.get::<_, i64>(0)).map(|n| n > 0)
    };
    let has = |col: &str| has_in("projects", col);
    if !has("coordinator_thread")? {
        // Hilo de Codex del coordinador del proyecto.
        conn.execute_batch("ALTER TABLE projects ADD COLUMN coordinator_thread TEXT")?;
    }
    if !has("coordinator_profile")? {
        conn.execute_batch("ALTER TABLE projects ADD COLUMN coordinator_profile TEXT NOT NULL DEFAULT 'hansi'")?;
    }
    if !has("coordinator_tools")? {
        // Versión de las herramientas con que se creó el hilo (0: ninguna).
        conn.execute_batch("ALTER TABLE projects ADD COLUMN coordinator_tools INTEGER NOT NULL DEFAULT 0")?;
    }
    // Aislamiento de sesiones (entrega 4): rama y worktree propios, el
    // commit del que parten y la huella del diff integrado.
    // Relevos y pausas: primer encargo, sesión de la que viene y motivo de pausa.
    for (col, ty) in [
        ("worktree", "TEXT"),
        ("branch", "TEXT"),
        ("base", "TEXT"),
        ("base_commit", "TEXT"),
        ("integrated", "TEXT"),
        ("task", "TEXT"),
        ("handoff_from", "INTEGER"),
        ("paused", "TEXT"),
        // Opciones elegidas en un agente ACP (JSON: id de opción → valor).
        ("options", "TEXT"),
    ] {
        if !has_in("sessions", col)? {
            conn.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {col} {ty}"))?;
        }
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

/// Guarda el hilo del coordinador y la versión de herramientas con que se creó.
pub fn set_coordinator_thread(conn: &Connection, path: &str, thread: Option<&str>, tools: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO projects (path, coordinator_thread, coordinator_tools) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET coordinator_thread = excluded.coordinator_thread, coordinator_tools = excluded.coordinator_tools",
        params![path, thread, tools],
    )?;
    Ok(())
}

pub fn coordinator_tools(conn: &Connection, path: &str) -> rusqlite::Result<i64> {
    conn.query_row("SELECT coordinator_tools FROM projects WHERE path = ?1", [path], |r| r.get(0)).optional().map(|v| v.unwrap_or(0))
}

/// Proyecto al que pertenece un hilo del coordinador.
pub fn project_for_thread(conn: &Connection, thread: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT path FROM projects WHERE coordinator_thread = ?1", [thread], |r| r.get(0)).optional()
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
    /// Copia de trabajo aislada; sin ella la sesión trabaja en el proyecto.
    pub worktree: Option<String>,
    pub branch: Option<String>,
    /// Rama de origen y commit del que partió.
    pub base: Option<String>,
    pub base_commit: Option<String>,
    /// Huella del diff ya integrado en el checkout principal.
    pub integrated: Option<String>,
    /// Primer encargo recibido: el objetivo para un relevo.
    pub task: Option<String>,
    /// Sesión de la que viene por relevo.
    pub handoff_from: Option<i64>,
    /// Motivo de pausa (cuota o manual); `None` si no está pausada.
    pub paused: Option<String>,
}

impl Session {
    /// Carpeta en la que trabaja el agente.
    pub fn cwd(&self) -> &str {
        self.worktree.as_deref().unwrap_or(&self.project)
    }
}

const SESSION_COLS: &str = "id, project, engine, name, provider_session, effort, worktree, branch, base, base_commit, integrated, task, handoff_from, paused";

fn session_row(r: &rusqlite::Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        project: r.get(1)?,
        engine: r.get(2)?,
        name: r.get(3)?,
        provider_session: r.get(4)?,
        effort: r.get(5)?,
        worktree: r.get(6)?,
        branch: r.get(7)?,
        base: r.get(8)?,
        base_commit: r.get(9)?,
        integrated: r.get(10)?,
        task: r.get(11)?,
        handoff_from: r.get(12)?,
        paused: r.get(13)?,
    })
}

/// Guarda el primer encargo de la sesión (los siguientes no lo cambian).
pub fn set_session_task(conn: &Connection, id: i64, task: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE sessions SET task = ?2 WHERE id = ?1 AND task IS NULL", params![id, task])?;
    Ok(())
}

pub fn set_session_paused(conn: &Connection, id: i64, reason: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE sessions SET paused = ?2 WHERE id = ?1", params![id, reason])?;
    Ok(())
}

/// Crea la sesión que recibe un relevo: misma rama y worktree que `from`.
pub fn create_handoff(conn: &Connection, from: &Session, engine: &str, provider_session: &str, names: &[&str]) -> rusqlite::Result<Session> {
    let new = create_session(conn, &from.project, engine, provider_session, names)?;
    conn.execute(
        "UPDATE sessions SET worktree = ?2, branch = ?3, base = ?4, base_commit = ?5, integrated = ?6, task = ?7, handoff_from = ?8 WHERE id = ?1",
        params![new.id, from.worktree, from.branch, from.base, from.base_commit, from.integrated, from.task, from.id],
    )?;
    Ok(session(conn, new.id)?.expect("recién creada"))
}

/// Rama y worktree de una sesión aislada.
pub fn set_session_worktree(conn: &Connection, id: i64, worktree: &str, branch: &str, base: &str, base_commit: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET worktree = ?2, branch = ?3, base = ?4, base_commit = ?5 WHERE id = ?1",
        params![id, worktree, branch, base, base_commit],
    )?;
    Ok(())
}

pub fn set_session_integrated(conn: &Connection, id: i64, fingerprint: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE sessions SET integrated = ?2 WHERE id = ?1", params![id, fingerprint])?;
    Ok(())
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

/// Opciones elegidas para la sesión (modelo, razonamiento…).
pub fn session_options(conn: &Connection, id: i64) -> rusqlite::Result<serde_json::Map<String, serde_json::Value>> {
    let raw: Option<String> = conn.query_row("SELECT options FROM sessions WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten();
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default())
}

pub fn set_session_option(conn: &Connection, id: i64, key: &str, value: &str) -> rusqlite::Result<()> {
    let mut opts = session_options(conn, id)?;
    opts.insert(key.into(), serde_json::Value::String(value.into()));
    conn.execute("UPDATE sessions SET options = ?2 WHERE id = ?1", params![id, serde_json::Value::Object(opts).to_string()])?;
    Ok(())
}

/// Sesión abierta o cerrada (las ramas pendientes son sesiones cerradas).
pub fn session_any(conn: &Connection, id: i64) -> rusqlite::Result<Option<Session>> {
    conn.query_row(&format!("SELECT {SESSION_COLS} FROM sessions WHERE id = ?1"), [id], session_row).optional()
}

/// Sesiones cerradas que conservan su rama y worktree: por cada worktree, la
/// última que lo usó, y solo si ninguna sesión abierta lo usa (un relevo
/// cierra la anterior pero la nueva sigue en la misma carpeta).
pub fn orphans(conn: &Connection, project: &str) -> rusqlite::Result<Vec<Session>> {
    let cols = SESSION_COLS.split(", ").map(|c| format!("s.{c}")).collect::<Vec<_>>().join(", ");
    let mut stmt = conn.prepare(&format!(
        "SELECT {cols} FROM sessions s
         WHERE s.project = ?1 AND s.closed = 1 AND s.worktree IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM sessions o WHERE o.worktree = s.worktree AND (o.closed = 0 OR o.id > s.id))
         ORDER BY s.id"
    ))?;
    let rows = stmt.query_map([project], session_row)?;
    rows.collect()
}

/// Vuelve a abrir una sesión cerrada. Si otra abierta del proyecto usa ya su
/// nombre, recibe el primero libre de `names`.
pub fn reopen_session(conn: &Connection, id: i64, names: &[&str]) -> rusqlite::Result<Option<Session>> {
    let Some(s) = session_any(conn, id)? else { return Ok(None) };
    let used: Vec<String> = sessions(conn, &s.project)?.into_iter().map(|o| o.name).collect();
    let name = if used.contains(&s.name) {
        names.iter().find(|n| !used.iter().any(|u| u == *n)).map(|n| n.to_string()).unwrap_or_else(|| format!("{}-{}", s.name, s.id))
    } else {
        s.name.clone()
    };
    conn.execute("UPDATE sessions SET closed = 0, name = ?2 WHERE id = ?1", params![id, name])?;
    session(conn, id)
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
        set_coordinator_thread(&conn, "/r/a", Some("t1"), 1).unwrap();
        assert_eq!(coordinator_tools(&conn, "/r/a").unwrap(), 1);
        assert_eq!(project_for_thread(&conn, "t1").unwrap().as_deref(), Some("/r/a"));
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
             provider_session TEXT NOT NULL, effort TEXT, closed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
             worktree TEXT, branch TEXT, base TEXT, base_commit TEXT, integrated TEXT, task TEXT, handoff_from INTEGER, paused TEXT, options TEXT);",
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
        set_session_option(&conn, b.id, "model", "opencode/big-pickle").unwrap();
        set_session_option(&conn, b.id, "thought_level", "high").unwrap();
        set_session_option(&conn, b.id, "model", "otro").unwrap();
        let opts = session_options(&conn, b.id).unwrap();
        assert_eq!((opts["model"].as_str(), opts["thought_level"].as_str()), (Some("otro"), Some("high")));

        // El primer encargo se conserva; el relevo hereda rama y objetivo.
        conn.execute("UPDATE sessions SET worktree = '/w', branch = 'ide/iniesta-2' WHERE id = ?1", [b.id]).unwrap();
        set_session_task(&conn, b.id, "arregla la cola").unwrap();
        set_session_task(&conn, b.id, "otra cosa").unwrap();
        let from = session(&conn, b.id).unwrap().unwrap();
        let to = create_handoff(&conn, &from, "opencode", "", &names).unwrap();
        assert_eq!((to.worktree.as_deref(), to.branch.as_deref(), to.task.as_deref(), to.handoff_from), (Some("/w"), Some("ide/iniesta-2"), Some("arregla la cola"), Some(b.id)));
        set_session_paused(&conn, to.id, Some("cuota")).unwrap();

        // Pendientes: la sesión relevada no cuenta mientras la nueva siga
        // abierta en su worktree; al cerrar la nueva, aparece solo ella.
        close_session(&conn, b.id).unwrap();
        assert!(orphans(&conn, "/r/p").unwrap().is_empty());
        close_session(&conn, to.id).unwrap();
        let pending: Vec<i64> = orphans(&conn, "/r/p").unwrap().iter().map(|s| s.id).collect();
        assert_eq!(pending, vec![to.id]);
        // Reabrir con el nombre ocupado da otro libre.
        let clash = create_session(&conn, "/r/p", "claude", "u9", &names).unwrap();
        conn.execute("UPDATE sessions SET name = ?2 WHERE id = ?1", params![clash.id, to.name]).unwrap();
        let back = reopen_session(&conn, to.id, &["xavi", "iniesta", "puyol"]).unwrap().unwrap();
        assert_ne!(back.name, to.name);
        assert!(orphans(&conn, "/r/p").unwrap().is_empty());
        assert_eq!(session(&conn, to.id).unwrap().unwrap().paused.as_deref(), Some("cuota"));
    }
}
