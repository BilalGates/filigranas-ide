use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::{db, err, runs, workspace::project_path, AppState, CmdResult};

const CONTEXT_MARKER: &str = "\n\n[Filigranas IDE: historial del proveedor anterior]\n";

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_history (
             scope TEXT PRIMARY KEY, items TEXT NOT NULL, context_run INTEGER REFERENCES task_runs(id)
         );
         CREATE TABLE IF NOT EXISTS project_manager_claude (
             project TEXT PRIMARY KEY, session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id), active INTEGER NOT NULL
         );",
    )
}

fn scope(project: &str, session: Option<i64>) -> String {
    session.map(runs::session_scope).unwrap_or_else(|| format!("pm:{project}"))
}

pub fn pm_id(conn: &Connection, project: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT session_id FROM project_manager_claude WHERE project=?1 AND active=1", [project], |r| r.get(0)).optional()
}

pub fn is_pm(conn: &Connection, id: i64) -> rusqlite::Result<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM project_manager_claude WHERE session_id=?1)", [id], |r| r.get(0))
}

fn pm_session(conn: &Connection, project: &str) -> CmdResult<Option<db::Session>> {
    pm_id(conn, project).map_err(err)?.map(|id| db::session(conn, id).map_err(err)).transpose().map(Option::flatten)
}

fn archived(conn: &Connection, scope: &str) -> CmdResult<Vec<Value>> {
    let data: Option<String> = conn.query_row("SELECT items FROM chat_history WHERE scope=?1", [scope], |r| r.get(0)).optional().map_err(err)?;
    data.map(|data| serde_json::from_str(&data).map_err(err)).transpose().map(Option::unwrap_or_default)
}

fn text_parts(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    content.as_array().into_iter().flatten()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>().join("\n")
}

fn message(user: bool, text: &str, engine: &str) -> Option<Value> {
    let text = text.split_once(crate::skills::MARKER).filter(|_| user).map(|(text, _)| text).unwrap_or(text);
    let text = text.split_once(CONTEXT_MARKER).filter(|_| user).map(|(text, _)| text).unwrap_or(text);
    if text.trim().is_empty() {
        return None;
    }
    let id = uuid::Uuid::new_v4().to_string();
    Some(if user {
        json!({"id":id,"type":"userMessage","content":[{"type":"text","text":text}]})
    } else {
        let by = if engine == "codex" { "Codex" } else { "Claude Code" };
        json!({"id":id,"type":"agentMessage","text":text,"by":by})
    })
}

fn codex_messages(thread: &Value) -> Vec<Value> {
    thread.pointer("/thread/turns").and_then(Value::as_array).into_iter().flatten()
        .flat_map(|turn| turn["items"].as_array().into_iter().flatten())
        .filter_map(|item| match item["type"].as_str() {
            Some("userMessage") => message(true, &text_parts(&item["content"]), "codex"),
            Some("agentMessage") => message(false, item["text"].as_str()?, "codex"),
            _ => None,
        }).collect()
}

/// Conserva la conversación al renovar las herramientas del coordinador.
/// El marcador evita duplicarla si falla el arranque del nuevo hilo.
pub fn archive_tool_upgrade(conn: &mut Connection, project: &str, thread: &str, history: &Value) -> CmdResult<()> {
    let tx = conn.transaction().map_err(err)?;
    let marker = format!("tools-history:{thread}");
    if db::get_setting(&tx, &marker).map_err(err)?.is_some() { return Ok(()); }
    let scope = scope(project, None);
    let mut items = archived(&tx, &scope)?;
    items.extend(codex_messages(history));
    tx.execute("INSERT INTO chat_history(scope,items) VALUES(?1,?2)
                ON CONFLICT(scope) DO UPDATE SET items=excluded.items,context_run=NULL",
        params![scope,serde_json::to_string(&items).map_err(err)?]).map_err(err)?;
    db::set_setting(&tx, &marker, "archived").map_err(err)?;
    tx.commit().map_err(err)
}

fn claude_messages(entries: Vec<Value>) -> Vec<Value> {
    entries.into_iter().filter_map(|entry| {
        let user = entry["type"] == "user";
        message(user, &text_parts(&entry["message"]["content"]), "claude")
    }).collect()
}

/// Envía contexto reciente hasta que el proveedor complete un turno.
pub fn with_context(conn: &Connection, project: &str, session: Option<i64>, run: i64, text: String) -> CmdResult<String> {
    let scope = scope(project, session);
    let pending: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_history h LEFT JOIN task_runs r ON r.id=h.context_run
         WHERE h.scope=?1 AND (r.outcome IS NULL OR r.outcome!='completed'))", [&scope], |r| r.get(0),
    ).map_err(err)?;
    if !pending {
        return Ok(text);
    }
    conn.execute("UPDATE chat_history SET context_run=?2 WHERE scope=?1", params![scope, run]).map_err(err)?;
    let items = archived(conn, &scope)?;
    if items.is_empty() {
        return Ok(text);
    }
    let mut remaining = 18_000;
    let mut recent = Vec::new();
    for item in items.iter().rev().take(24) {
        let user = item["type"] == "userMessage";
        let role = if user { "Usuario" } else { item["by"].as_str().unwrap_or("Asistente") };
        let body = if user { text_parts(&item["content"]) } else { item["text"].as_str().unwrap_or_default().to_owned() };
        let excerpt: String = body.chars().take(remaining.min(4_000)).collect();
        remaining -= excerpt.chars().count();
        recent.push(format!("{role}: {excerpt}"));
        if remaining == 0 {
            break;
        }
    }
    recent.reverse();
    Ok(format!("{text}{CONTEXT_MARKER}Contexto histórico. Atiende el mensaje actual y comprueba el estado de los archivos antes de continuar.\n\n{}", recent.join("\n\n")))
}

#[tauri::command]
pub fn chat_pm(state: State<AppState>, project: String) -> CmdResult<Option<db::Session>> {
    let conn = state.db.lock().map_err(err)?;
    let project = project_path(&conn, &project)?;
    pm_session(&conn, &project)
}

#[tauri::command]
pub fn chat_history(state: State<AppState>, project: String, session: Option<i64>) -> CmdResult<Vec<Value>> {
    let conn = state.db.lock().map_err(err)?;
    let project = project_path(&conn, &project)?;
    if let Some(id) = session {
        validate_session(&conn, &project, id)?;
    }
    archived(&conn, &scope(&project, session))
}

fn validate_session(conn: &Connection, project: &str, id: i64) -> CmdResult<db::Session> {
    db::session(conn, id).map_err(err)?.filter(|s| s.project == project)
        .ok_or_else(|| "la sesión no pertenece al proyecto".into())
}

#[tauri::command]
pub async fn chat_switch(app: AppHandle, project: String, session: Option<i64>, engine: String) -> CmdResult<Option<db::Session>> {
    if !matches!(engine.as_str(), "codex" | "claude") {
        return Err("proveedor desconocido".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.chat_gate.lock().map_err(err)?;
        let (project, current, thread) = {
            let conn = state.db.lock().map_err(err)?;
            let project = project_path(&conn, &project)?;
            let current = match session {
                Some(id) if !is_pm(&conn, id).map_err(err)? => Some(validate_session(&conn, &project, id)?),
                Some(_) => return Err("selecciona el proveedor del Project manager desde su pestaña".into()),
                None => pm_session(&conn, &project)?,
            };
            let old = current.as_ref().map(|s| s.engine.as_str()).unwrap_or("codex");
            if old == engine {
                return Ok(current);
            }
            if !matches!(old, "codex" | "claude") {
                return Err("esta sesión usa relevo de tarea para cambiar de proveedor".into());
            }
            let thread = match &current {
                Some(s) if s.engine == "codex" => Some(s.provider_session.clone()).filter(|id| !id.is_empty()),
                Some(_) => None,
                None => db::coordinator(&conn, &project).map_err(err)?.0,
            };
            let busy = match (session, &current, &thread) {
                (Some(id), _, _) => runs::session_active(&conn, id).map_err(err)?,
                (None, Some(pm), _) => runs::active(&conn, &runs::session_scope(pm.id))?.is_some(),
                (None, None, Some(thread)) => runs::active(&conn, thread)?.is_some(),
                _ => false,
            };
            if busy {
                return Err("espera a que termine el turno o interrúmpelo para cambiar de proveedor".into());
            }
            (project, current, thread)
        };

        let outgoing = if let Some(thread) = thread {
            codex_messages(&state.codex.read_history(&app, &thread)?)
        } else if let Some(s) = &current {
            claude_messages(crate::claude::read_history(&s.provider_session)?)
        } else {
            Vec::new()
        };

        let mut conn = state.db.lock().map_err(err)?;
        let tx = conn.transaction().map_err(err)?;
        let next = save_switch(&tx, &project, session, &engine, outgoing)?;
        tx.commit().map_err(err)?;
        drop(conn);
        if let Some(s) = current.filter(|s| s.engine == "claude") {
            state.claude.forget(s.id);
        }
        if session.is_some() {
            crate::tasks::changed(&app);
        }
        Ok(next)
    }).await.map_err(err)?
}

fn save_switch(tx: &rusqlite::Transaction<'_>, project: &str, session: Option<i64>, engine: &str, outgoing: Vec<Value>) -> CmdResult<Option<db::Session>> {
    let key = scope(project, session);
    let mut items = archived(tx, &key)?;
    items.extend(outgoing);
    tx.execute(
        "INSERT INTO chat_history(scope,items) VALUES(?1,?2)
         ON CONFLICT(scope) DO UPDATE SET items=excluded.items,context_run=NULL",
        params![key, serde_json::to_string(&items).map_err(err)?],
    ).map_err(err)?;
    let provider = if engine == "claude" { uuid::Uuid::new_v4().to_string() } else { String::new() };
    let next = if let Some(id) = session {
        // Conserva la sesión, su worktree, sus tareas y las opciones de cada proveedor.
        tx.execute(
            "UPDATE sessions SET engine=?2, provider_session=?3, paused=NULL,
             other_options=options, options=other_options, other_effort=effort, effort=other_effort WHERE id=?1",
            params![id, engine, provider],
        ).map_err(err)?;
        db::session(tx, id).map_err(err)?
    } else if engine == "claude" {
        db::set_coordinator_thread(tx, project, None, 0).map_err(err)?;
        let existing: Option<i64> = tx.query_row(
            "SELECT session_id FROM project_manager_claude WHERE project=?1",
            [project], |row| row.get(0),
        ).optional().map_err(err)?;
        let id = if let Some(id) = existing {
            tx.execute("UPDATE sessions SET provider_session=?2,paused=NULL WHERE id=?1", params![id, provider]).map_err(err)?;
            tx.execute("UPDATE project_manager_claude SET active=1 WHERE project=?1", [project]).map_err(err)?;
            id
        } else {
            tx.execute(
                "INSERT INTO sessions(project,engine,name,provider_session) VALUES(?1,'claude','Project manager',?2)",
                params![project, provider],
            ).map_err(err)?;
            let id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO project_manager_claude(project,session_id,active) VALUES(?1,?2,1)",
                params![project, id],
            ).map_err(err)?;
            id
        };
        db::session(tx, id).map_err(err)?
    } else {
        tx.execute("UPDATE project_manager_claude SET active=0 WHERE project=?1", [project]).map_err(err)?;
        None
    };
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_upgrade_preserves_pm_messages_once_and_restores_context() {
        let mut conn = db::open(std::path::Path::new(":memory:")).unwrap();
        let history = json!({"thread":{"turns":[{"items":[
            {"type":"userMessage","content":[{"type":"text","text":"Conserva mi objetivo"}]},
            {"type":"agentMessage","text":"Seguiremos en la rama compartida"},
            {"type":"reasoning","text":"no archivar razonamiento"}
        ]}]}});
        archive_tool_upgrade(&mut conn, "/repo", "old-thread", &history).unwrap();
        archive_tool_upgrade(&mut conn, "/repo", "old-thread", &history).unwrap();
        let items = archived(&conn, &scope("/repo", None)).unwrap();
        assert_eq!(items.len(), 2);
        assert!(archived(&conn, &scope("/other", None)).unwrap().is_empty());
        let tx = conn.transaction().unwrap();
        let run = runs::begin(&tx, "/repo", "new-thread", "codex", None, None).unwrap();
        let input = with_context(&tx, "/repo", None, run, "Continúa".into()).unwrap();
        assert!(input.contains("Conserva mi objetivo"));
        assert!(input.contains("Seguiremos en la rama compartida"));
        assert!(!input.contains("no archivar razonamiento"));
        tx.commit().unwrap();
    }

    #[test]
    fn switch_keeps_the_session_and_reuses_its_model_preference() {
        let mut conn = db::open(std::path::Path::new(":memory:")).unwrap();
        let original = db::create_session(&conn, "/repo", "codex", "thread", &["sesión 1"]).unwrap();
        let id = original.id;
        db::set_session_worktree(&conn, id, "/worktree", "ide/sesion", "main", "sha").unwrap();
        db::set_session_option(&conn, id, "model", "gpt").unwrap();

        let tx = conn.transaction().unwrap();
        let user = message(true, "Conserva este dato", "codex").unwrap();
        let changed = save_switch(&tx, "/repo", Some(id), "claude", vec![user.clone()]).unwrap().unwrap();
        assert_eq!((changed.id, changed.name.as_str(), changed.cwd()), (id, original.name.as_str(), "/worktree"));
        assert_ne!(changed.provider_session, "thread");
        assert!(db::session_options(&tx, id).unwrap().is_empty());

        let run = runs::begin(&tx, "/repo", "claude", "claude", Some(id), None).unwrap();
        let input = with_context(&tx, "/repo", Some(id), run, "Continúa".into()).unwrap();
        assert!(input.starts_with("Continúa"));
        assert!(input.contains("Conserva este dato"));
        assert_eq!(message(true, &input, "claude").unwrap()["content"][0]["text"], "Continúa");
        tx.commit().unwrap();

        runs::finish(&conn, run, "completed").unwrap();
        let tx = conn.transaction().unwrap();
        let run = runs::begin(&tx, "/repo", "claude", "claude", Some(id), None).unwrap();
        assert_eq!(with_context(&tx, "/repo", Some(id), run, "Siguiente".into()).unwrap(), "Siguiente");
        tx.commit().unwrap();
        runs::finish(&conn, run, "completed").unwrap();

        let tx = conn.transaction().unwrap();
        let restored = save_switch(&tx, "/repo", Some(id), "codex", Vec::new()).unwrap().unwrap();
        assert_eq!((restored.engine.as_str(), restored.branch.as_deref()), ("codex", Some("ide/sesion")));
        assert_eq!(db::session_options(&tx, id).unwrap()["model"], "gpt");
        assert_eq!(archived(&tx, &scope("/repo", Some(id))).unwrap(), vec![user]);
    }

    #[test]
    fn project_manager_choice_and_history_survive_reopening() {
        let dir = std::env::temp_dir().join(format!("filigranas-chat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("db");
        let mut conn = db::open(&path).unwrap();
        assert!(pm_id(&conn, "/repo").unwrap().is_none());
        db::set_coordinator_thread(&conn, "/repo", Some("pm-codex"), 1).unwrap();
        let tx = conn.transaction().unwrap();
        let reply = message(false, "Plan acordado", "codex").unwrap();
        let pm = save_switch(&tx, "/repo", None, "claude", vec![reply.clone()]).unwrap().unwrap();
        assert!(db::sessions(&tx, "/repo").unwrap().is_empty());
        tx.commit().unwrap();
        drop(conn);

        let mut conn = db::open(&path).unwrap();
        assert_eq!(pm_id(&conn, "/repo").unwrap(), Some(pm.id));
        assert!(pm_id(&conn, "/otro").unwrap().is_none());
        assert_eq!(pm.cwd(), "/repo");
        let tx = conn.transaction().unwrap();
        assert!(save_switch(&tx, "/repo", None, "codex", Vec::new()).unwrap().is_none());
        assert!(pm_id(&tx, "/repo").unwrap().is_none());
        assert!(db::coordinator(&tx, "/repo").unwrap().0.is_none());
        assert_eq!(archived(&tx, &scope("/repo", None)).unwrap(), vec![reply]);
        tx.commit().unwrap();
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
