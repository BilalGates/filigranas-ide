use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{db, err, workspace::project_path, AppState, CmdResult};

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS tasks (
           id INTEGER PRIMARY KEY, project TEXT NOT NULL, parent_id INTEGER REFERENCES tasks(id),
           title TEXT NOT NULL, goal TEXT NOT NULL, criteria TEXT NOT NULL,
           priority TEXT NOT NULL, risk TEXT NOT NULL, status TEXT NOT NULL,
           verification TEXT NOT NULL DEFAULT '', tests TEXT,
           created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project);
         CREATE TABLE IF NOT EXISTS task_dependencies (
           task_id INTEGER NOT NULL REFERENCES tasks(id), requires_id INTEGER NOT NULL REFERENCES tasks(id),
           PRIMARY KEY (task_id, requires_id)
         );
         CREATE TABLE IF NOT EXISTS task_sessions (
           session_id INTEGER PRIMARY KEY REFERENCES sessions(id), task_id INTEGER NOT NULL REFERENCES tasks(id)
         );
         CREATE INDEX IF NOT EXISTS task_sessions_task ON task_sessions(task_id);
         COMMIT;",
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    id: Option<i64>,
    parent_id: Option<i64>,
    title: String,
    goal: String,
    criteria: String,
    priority: String,
    risk: String,
    status: String,
    verification: String,
    tests: Option<String>,
    dependencies: Vec<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    id: i64,
    parent_id: Option<i64>,
    title: String,
    goal: String,
    criteria: String,
    priority: String,
    risk: String,
    status: String,
    verification: String,
    tests: Option<String>,
    created_at: i64,
    updated_at: i64,
    dependencies: Vec<i64>,
    waiting_for: Vec<i64>,
    sessions: Vec<Link>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    id: i64,
    name: String,
    engine: String,
    branch: Option<String>,
    worktree: Option<String>,
    base_commit: Option<String>,
    closed: bool,
}

fn task_in(conn: &Connection, project: &str, id: i64) -> CmdResult<()> {
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND project=?2)", params![id, project], |row| row.get(0)).map_err(err)?;
    exists.then_some(()).ok_or_else(|| "la tarea no pertenece al proyecto".into())
}

fn waiting_for(conn: &Connection, id: i64) -> rusqlite::Result<Vec<i64>> {
    let mut q = conn.prepare(
        "SELECT tasks.id FROM task_dependencies JOIN tasks ON tasks.id=requires_id
         WHERE task_id=?1 AND tasks.status!='done' ORDER BY tasks.id"
    )?;
    let rows = q.query_map([id], |r| r.get(0))?;
    rows.collect()
}

pub fn list(conn: &Connection, project: &str) -> CmdResult<Vec<Task>> {
    let mut query = conn.prepare(
        "SELECT id,parent_id,title,goal,criteria,priority,risk,status,verification,tests,created_at,updated_at
         FROM tasks WHERE project=?1 ORDER BY id"
    ).map_err(err)?;
    let rows = query.query_map([project], |r| Ok(Task {
        id: r.get(0)?, parent_id: r.get(1)?, title: r.get(2)?, goal: r.get(3)?, criteria: r.get(4)?,
        priority: r.get(5)?, risk: r.get(6)?, status: r.get(7)?, verification: r.get(8)?,
        tests: r.get(9)?, created_at: r.get(10)?, updated_at: r.get(11)?,
        dependencies: Vec::new(), waiting_for: Vec::new(), sessions: Vec::new(),
    })).map_err(err)?;
    let mut tasks = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?;
    let mut links = conn.prepare(
        "SELECT s.id,s.name,s.engine,s.branch,s.worktree,s.base_commit,s.closed FROM task_sessions t
         JOIN sessions s ON s.id=t.session_id WHERE t.task_id=?1 ORDER BY s.id"
    ).map_err(err)?;
    let mut deps = conn.prepare("SELECT requires_id FROM task_dependencies WHERE task_id=?1 ORDER BY requires_id").map_err(err)?;
    for task in &mut tasks {
        task.dependencies = deps.query_map([task.id], |r| r.get(0)).map_err(err)?.collect::<rusqlite::Result<_>>().map_err(err)?;
        task.waiting_for = waiting_for(conn, task.id).map_err(err)?;
        task.sessions = links.query_map([task.id], |r| Ok(Link {
            id: r.get(0)?, name: r.get(1)?, engine: r.get(2)?, branch: r.get(3)?,
            worktree: r.get(4)?, base_commit: r.get(5)?, closed: r.get(6)?,
        })).map_err(err)?.collect::<rusqlite::Result<_>>().map_err(err)?;
    }
    Ok(tasks)
}

pub fn save(conn: &mut Connection, project: &str, input: Edit) -> CmdResult<i64> {
    const MANUAL: [&str; 9] = ["backlog", "ready", "blocked", "verifying", "review", "ready_to_merge", "done", "cancelled", "failed"];
    let Edit { id, parent_id, title, goal, criteria, priority, risk, status, verification, tests, dependencies } = input;
    let (title, goal, criteria) = (title.trim(), goal.trim(), criteria.trim());
    if title.is_empty() || goal.is_empty() || criteria.is_empty() {
        return Err("completa el título, el objetivo y los criterios".into());
    }
    if !["low", "normal", "high", "urgent"].contains(&priority.as_str())
        || !["low", "normal", "high", "critical"].contains(&risk.as_str())
        || tests.as_deref().is_some_and(|t| !["passed", "failed", "not_applicable"].contains(&t))
    {
        return Err("prioridad, riesgo o resultado de pruebas no válido".into());
    }
    let tx = conn.transaction().map_err(err)?;
    let previous = id.map(|id| {
        task_in(&tx, project, id)?;
        tx.query_row("SELECT status FROM tasks WHERE id=?1", [id], |r| r.get::<_, String>(0)).map_err(err)
    }).transpose()?;
    if !MANUAL.contains(&status.as_str()) && previous.as_deref() != Some(&status) {
        return Err("ese estado lo registra el runtime".into());
    }
    if let Some(id) = id {
        if crate::runs::task_active(&tx, id).map_err(err)? {
            return Err("espera a que termine el turno de la tarea".into());
        }
    }
    for related in parent_id.iter().chain(&dependencies) {
        task_in(&tx, project, *related)?;
    }
    let id = match id {
        Some(id) => {
            tx.execute(
                "UPDATE tasks SET parent_id=?2,title=?3,goal=?4,criteria=?5,priority=?6,risk=?7,status=?8,
                 verification=?9,tests=?10,updated_at=unixepoch() WHERE id=?1",
                params![id,parent_id,title,goal,criteria,priority,risk,status,verification.trim(),tests],
            ).map_err(err)?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO tasks(project,parent_id,title,goal,criteria,priority,risk,status,verification,tests)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![project,parent_id,title,goal,criteria,priority,risk,status,verification.trim(),tests],
            ).map_err(err)?;
            tx.last_insert_rowid()
        }
    };
    tx.execute("DELETE FROM task_dependencies WHERE task_id=?1", [id]).map_err(err)?;
    for requires in dependencies {
        tx.execute("INSERT OR IGNORE INTO task_dependencies(task_id,requires_id) VALUES(?1,?2)", [id,requires]).map_err(err)?;
    }
    // La tarea padre también espera a sus subtareas antes de cerrarse.
    let cycle: bool = tx.query_row(
        "WITH RECURSIVE edges(source,dest) AS (
           SELECT task_id,requires_id FROM task_dependencies UNION SELECT parent_id,id FROM tasks WHERE parent_id IS NOT NULL
         ), reachable(node) AS (
           SELECT dest FROM edges WHERE source=?1 UNION SELECT e.dest FROM edges e JOIN reachable r ON r.node=e.source
         ) SELECT EXISTS(SELECT 1 FROM reachable WHERE node=?1)",
        [id], |r| r.get(0),
    ).map_err(err)?;
    if cycle {
        return Err("esa relación crea un ciclo entre tareas".into());
    }
    if status == "done" {
        if !matches!(previous.as_deref(), Some("verifying" | "review" | "ready_to_merge" | "done"))
            || verification.trim().is_empty() || !matches!(tests.as_deref(), Some("passed" | "not_applicable"))
        {
            return Err("para cerrar, verifica la tarea y registra las pruebas y la evidencia de integración o aceptación".into());
        }
        if !waiting_for(&tx, id).map_err(err)?.is_empty() {
            return Err("quedan dependencias por completar".into());
        }
        let children_open: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE parent_id=?1 AND status!='done')", [id], |r| r.get(0)).map_err(err)?;
        if children_open {
            return Err("quedan subtareas por completar".into());
        }
        verify_worktrees(&tx, id)?;
    }
    // Impide reabrir una dependencia o añadir una subtarea a una tarea cerrada.
    let invalid_done: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.project=?1 AND t.status='done' AND (
           EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id=t.id AND c.status!='done')
           OR EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks r ON r.id=d.requires_id WHERE d.task_id=t.id AND r.status!='done')
         ))", [project], |r| r.get(0),
    ).map_err(err)?;
    if invalid_done {
        return Err("reabre primero la tarea completada que depende de estos cambios".into());
    }
    tx.commit().map_err(err)?;
    Ok(id)
}

pub fn delegated(conn: &mut Connection, project: &str, goal: &str) -> CmdResult<i64> {
    let title = goal.lines().find(|l| !l.trim().is_empty()).unwrap_or("Encargo delegado").chars().take(110).collect();
    save(conn, project, Edit {
        id: None, parent_id: None, title, goal: goal.into(),
        criteria: "Validar el objetivo delegado y registrar el resultado comprobado.".into(),
        priority: "normal".into(), risk: "normal".into(), status: "ready".into(),
        verification: String::new(), tests: None, dependencies: Vec::new(),
    })
}

pub fn link(conn: &Connection, project: &str, task: i64, session: i64) -> CmdResult<()> {
    task_in(conn, project, task)?;
    let session = db::session(conn, session).map_err(err)?.filter(|s| s.project == project)
        .ok_or("la sesión abierta no pertenece al proyecto")?;
    if crate::runs::session_active(conn, session.id).map_err(err)? {
        return Err("espera a que termine el turno antes de vincular la sesión".into());
    }
    let previous = linked(conn, session.id).map_err(err)?;
    if previous.is_some_and(|id| id != task) {
        let has_history: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM task_runs WHERE session_id=?1 AND task_id=?2)",
            params![session.id,previous], |r| r.get(0),
        ).map_err(err)?;
        if has_history {
            return Err("la sesión ya tiene turnos vinculados a otra tarea".into());
        }
    }
    conn.execute(
        "INSERT INTO task_sessions(session_id,task_id) VALUES(?1,?2)
         ON CONFLICT(session_id) DO UPDATE SET task_id=excluded.task_id",
        params![session.id,task],
    ).map_err(err)?;
    Ok(())
}

fn verify_worktrees(conn: &Connection, task: i64) -> CmdResult<()> {
    let mut query = conn.prepare(
        "SELECT max(s.id) FROM task_sessions t JOIN sessions s ON s.id=t.session_id
         WHERE t.task_id=?1 AND s.worktree IS NOT NULL GROUP BY s.worktree"
    ).map_err(err)?;
    for id in query.query_map([task], |r| r.get(0)).map_err(err)? {
        let session = db::session_any(conn, id.map_err(err)?).map_err(err)?.ok_or("falta una sesión vinculada")?;
        if !crate::isolate::integration_verified(&session)? {
            return Err(format!("integra y verifica los cambios de {} antes de cerrar la tarea", session.name));
        }
    }
    Ok(())
}

pub fn linked(conn: &Connection, session: i64) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT task_id FROM task_sessions WHERE session_id=?1", [session], |r| r.get(0)).optional()
}

pub fn validate_start(conn: &Connection, project: &str, id: i64) -> CmdResult<()> {
    task_in(conn, project, id)?;
    if !waiting_for(conn, id).map_err(err)?.is_empty() {
        return Err("completa primero las dependencias de la tarea".into());
    }
    let status: String = conn.query_row("SELECT status FROM tasks WHERE id=?1", [id], |r| r.get(0)).map_err(err)?;
    if matches!(status.as_str(), "backlog" | "blocked" | "done" | "cancelled") {
        return Err("pon la tarea en lista antes de iniciar el turno".into());
    }
    Ok(())
}

pub fn context(conn: &Connection, id: i64, text: &str) -> CmdResult<String> {
    conn.query_row("SELECT title,goal,criteria FROM tasks WHERE id=?1", [id], |row| {
        let title: String = row.get(0)?;
        let goal: String = row.get(1)?;
        let criteria: String = row.get(2)?;
        Ok(format!("Tarea #{id} · {title}\nObjetivo\n{goal}\nCriterios de aceptación\n{criteria}\n\nMensaje\n{text}"))
    }).map_err(err)
}

fn limit_key(project: &str) -> String {
    format!("tasks.parallel:{project}")
}

pub fn parallel_limit(conn: &Connection, project: &str) -> rusqlite::Result<u32> {
    Ok(db::get_setting(conn, &limit_key(project))?.and_then(|v| v.parse::<u32>().ok()).filter(|v| *v > 0).unwrap_or(3))
}

#[tauri::command]
pub fn task_parallel_limit(state: State<AppState>, project: String, limit: Option<u32>) -> CmdResult<u32> {
    let conn = state.db.lock().map_err(err)?;
    let project = project_path(&conn, &project)?;
    if let Some(limit) = limit {
        if limit == 0 {
            return Err("el límite debe ser mayor que cero".into());
        }
        db::set_setting(&conn, &limit_key(&project), &limit.to_string()).map_err(err)?;
    }
    parallel_limit(&conn, &project).map_err(err)
}

pub fn changed(app: &AppHandle) {
    let _ = app.emit("tasks-changed", ());
}

#[tauri::command]
pub fn tasks_list(state: State<AppState>, project: String) -> CmdResult<Vec<Task>> {
    let conn = state.db.lock().map_err(err)?;
    list(&conn, &project_path(&conn, &project)?)
}

#[tauri::command]
pub async fn task_save(app: AppHandle, project: String, input: Edit) -> CmdResult<i64> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut conn = state.db.lock().map_err(err)?;
        let project = project_path(&conn, &project)?;
        let id = save(&mut conn, &project, input)?;
        drop(conn);
        changed(&app);
        Ok(id)
    }).await.map_err(err)?
}

#[tauri::command]
pub fn task_link(app: AppHandle, project: String, task: i64, session: i64) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let mut conn = state.db.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    link(&tx, &project_path(&tx, &project)?, task, session)?;
    tx.commit().map_err(err)?;
    drop(conn);
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn task_runs(state: State<AppState>, project: String, task: i64) -> CmdResult<Vec<crate::runs::Run>> {
    let conn = state.db.lock().map_err(err)?;
    task_in(&conn, &project_path(&conn, &project)?, task)?;
    crate::runs::recent(&conn, task).map_err(err)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::{git::git, isolate, runs};

    fn draft(title: &str) -> Edit {
        Edit {
            id: None, parent_id: None, title: title.into(), goal: "objetivo".into(), criteria: "criterio".into(),
            priority: "normal".into(), risk: "low".into(), status: "ready".into(), verification: String::new(),
            tests: None, dependencies: Vec::new(),
        }
    }

    fn begin_run(conn: &mut Connection, project: &str, scope: &str, provider: &str, session: Option<i64>, task: Option<i64>) -> CmdResult<i64> {
        let tx = conn.transaction().map_err(err)?;
        let run = runs::begin(&tx, project, scope, provider, session, task)?;
        tx.commit().map_err(err)?;
        Ok(run)
    }

    fn fixture() -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("filigranas-tasks-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]).unwrap();
        git(&repo, &["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
            "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "base"]).unwrap();
        (dir, repo.to_string_lossy().into_owned())
    }

    #[test]
    fn graph_rejects_cross_project_links_and_cycles_without_losing_previous_edges() {
        let mut conn = db::open(Path::new(":memory:")).unwrap();
        let parent = save(&mut conn, "one", draft("padre")).unwrap();
        let prerequisite = save(&mut conn, "one", draft("prerrequisito")).unwrap();
        let other = save(&mut conn, "two", draft("otro proyecto")).unwrap();
        let child = save(&mut conn, "one", Edit { parent_id: Some(parent), dependencies: vec![prerequisite], ..draft("hija") }).unwrap();
        let bad = Edit { id: Some(prerequisite), dependencies: vec![parent], ..draft("prerrequisito") };
        assert!(save(&mut conn, "one", bad).unwrap_err().contains("ciclo"));
        let bad = Edit { id: Some(child), parent_id: Some(other), ..draft("hija") };
        assert!(save(&mut conn, "one", bad).is_err());
        assert_eq!(waiting_for(&conn, child).unwrap(), vec![prerequisite]);
        assert!(begin_run(&mut conn, "one", "pm", "codex", None, Some(child)).is_err());
        assert!(save(&mut conn, "one", Edit { id: Some(parent), status: "done".into(), ..draft("padre") }).is_err());
        let verified = |id, status: &str| Edit {
            id: Some(id), status: status.into(), verification: "prueba local".into(), tests: Some("passed".into()), ..draft("prerrequisito")
        };
        save(&mut conn, "one", verified(prerequisite, "verifying")).unwrap();
        save(&mut conn, "one", verified(prerequisite, "done")).unwrap();
        assert!(begin_run(&mut conn, "one", "pm", "codex", None, Some(child)).is_ok());
    }

    #[test]
    fn legacy_sessions_and_parallel_runs_survive_restart_with_worktrees_and_handoff() {
        let (dir, project) = fixture();
        let file = dir.join("v1.db");
        let legacy = Connection::open(&file).unwrap();
        legacy.execute_batch(
            "CREATE TABLE sessions(id INTEGER PRIMARY KEY, project TEXT NOT NULL, engine TEXT NOT NULL,
              name TEXT NOT NULL, provider_session TEXT NOT NULL, effort TEXT, closed INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL DEFAULT (unixepoch()));"
        ).unwrap();
        legacy.execute("INSERT INTO sessions(id,project,engine,name,provider_session) VALUES(41,?1,'claude','xavi','old-native')", [&project]).unwrap();
        drop(legacy);

        let mut conn = db::open(&file).unwrap();
        let a = save(&mut conn, &project, draft("primera")).unwrap();
        let b = save(&mut conn, &project, Edit { parent_id: Some(a), ..draft("segunda") }).unwrap();
        let c = save(&mut conn, &project, Edit { dependencies: vec![b], ..draft("tercera") }).unwrap();
        db::set_setting(&conn, &limit_key(&project), "2").unwrap();
        let third = save(&mut conn, &project, draft("cuarta")).unwrap();
        let second_session = db::create_session(&conn, &project, "opencode", "native-b", &["iniesta"]).unwrap();
        let path = Path::new(&project);
        let first_wt = isolate::create(&dir, path, "xavi", 41).unwrap().unwrap();
        let second_wt = isolate::create(&dir, path, "iniesta", second_session.id).unwrap().unwrap();
        for (id, task, wt) in [(41, a, &first_wt), (second_session.id, b, &second_wt)] {
            db::set_session_worktree(&conn, id, &wt.worktree, &wt.branch, &wt.base, &wt.base_commit).unwrap();
            link(&conn, &project, task, id).unwrap();
        }
        let scope = runs::session_scope(41);
        let run = begin_run(&mut conn, &project, &scope, "claude", Some(41), Some(a)).unwrap();
        let other_run = begin_run(&mut conn, &project, &runs::session_scope(second_session.id), "opencode", Some(second_session.id), Some(b)).unwrap();
        assert!(begin_run(&mut conn, &project, "pm", "codex", None, Some(third)).unwrap_err().contains("límite"));
        assert!(begin_run(&mut conn, &project, "pm", "codex", None, Some(c)).unwrap_err().contains("dependencias"));
        runs::usage(&conn, other_run, runs::Usage { context: Some(7), ..Default::default() }).unwrap();
        runs::finish(&conn, other_run, "completed").unwrap();
        std::fs::write(Path::new(&first_wt.worktree).join("first.txt"), "resultado").unwrap();
        assert!(!Path::new(&second_wt.worktree).join("first.txt").exists());
        drop(conn);

        let mut conn = db::open(&file).unwrap();
        runs::recovery(&conn).unwrap();
        assert_eq!(parallel_limit(&conn, &project).unwrap(), 2);
        assert_eq!(db::session(&conn, 41).unwrap().unwrap().provider_session, "old-native");
        let tasks = list(&conn, &project).unwrap();
        assert_eq!(tasks.iter().map(|t| t.status.as_str()).collect::<Vec<_>>(), ["ready", "verifying", "ready", "ready"]);
        assert_eq!(tasks[1].parent_id, Some(a));
        assert_eq!(tasks[2].dependencies, [b]);
        let history = serde_json::to_value(runs::recent(&conn, a).unwrap()).unwrap();
        assert_eq!(history[0]["id"], run);
        assert_eq!(history[0]["outcome"], "interrupted");
        assert!(history[0]["inputTokens"].is_null());
        let retry = begin_run(&mut conn, &project, &scope, "claude", Some(41), Some(a)).unwrap();
        runs::finish(&conn, retry, "completed").unwrap();
        let history = serde_json::to_value(runs::recent(&conn, a).unwrap()).unwrap();
        assert_eq!(history[0]["retry"], true);
        let next = db::create_handoff(&mut conn, 41, "codex", "", &["puyol"]).unwrap();
        assert_eq!(linked(&conn, next.id).unwrap(), Some(a));
        assert_eq!(next.worktree.as_deref(), Some(first_wt.worktree.as_str()));
        assert_eq!(std::fs::read_to_string(Path::new(next.cwd()).join("first.txt")).unwrap(), "resultado");
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn closing_requires_user_evidence_and_current_worktree_integration() {
        let (dir, project) = fixture();
        let mut conn = db::open(&dir.join("test.db")).unwrap();
        let task = save(&mut conn, &project, draft("cambio aislado")).unwrap();
        let session = db::create_session(&conn, &project, "codex", "native", &["xavi"]).unwrap();
        let wt = isolate::create(&dir, Path::new(&project), "xavi", session.id).unwrap().unwrap();
        db::set_session_worktree(&conn, session.id, &wt.worktree, &wt.branch, &wt.base, &wt.base_commit).unwrap();
        link(&conn, &project, task, session.id).unwrap();
        let run = begin_run(&mut conn, &project, "thread", "codex", Some(session.id), Some(task)).unwrap();
        runs::finish(&conn, run, "completed").unwrap();
        assert_eq!(list(&conn, &project).unwrap()[0].status, "verifying");
        assert!(save(&mut conn, &project, Edit { id: Some(task), status: "done".into(), ..draft("cambio aislado") }).is_err());

        let completion = || Edit { id: Some(task), status: "done".into(), tests: Some("passed".into()),
            verification: "comprobado por el usuario".into(), ..draft("cambio aislado") };
        std::fs::write(Path::new(&wt.worktree).join("new.txt"), "cambio\n").unwrap();
        assert!(save(&mut conn, &project, completion()).unwrap_err().contains("integra"));
        let session = db::session(&conn, session.id).unwrap().unwrap();
        let (_, fingerprint) = isolate::integrate(&session).unwrap();
        db::set_session_integrated(&conn, session.id, Some(&fingerprint)).unwrap();
        save(&mut conn, &project, completion()).unwrap();
        assert_eq!(list(&conn, &project).unwrap()[0].status, "done");
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
