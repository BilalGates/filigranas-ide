use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{db, err, workspace::project_path, AppState, CmdResult};

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS task_plans (
           id INTEGER PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL,
           goal TEXT NOT NULL, criteria TEXT NOT NULL,
           created_at INTEGER NOT NULL DEFAULT (unixepoch()),
           updated_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(id, project)
         );
         CREATE INDEX IF NOT EXISTS task_plans_project ON task_plans(project);
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
    )?;
    db::add_columns(conn, "tasks", &[
        ("plan_id", "INTEGER REFERENCES task_plans(id)"),
        ("prompt", "TEXT"), ("agent", "TEXT"), ("role", "TEXT"),
    ])?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS tasks_plan ON tasks(plan_id);
         CREATE TRIGGER IF NOT EXISTS tasks_plan_project_insert BEFORE INSERT ON tasks
         WHEN NEW.plan_id IS NOT NULL AND NOT EXISTS
           (SELECT 1 FROM task_plans WHERE id=NEW.plan_id AND project=NEW.project)
         BEGIN SELECT RAISE(ABORT, 'plan fuera del proyecto'); END;
         CREATE TRIGGER IF NOT EXISTS tasks_plan_project_update BEFORE UPDATE OF plan_id,project ON tasks
         WHEN NEW.plan_id IS NOT NULL AND NOT EXISTS
           (SELECT 1 FROM task_plans WHERE id=NEW.plan_id AND project=NEW.project)
         BEGIN SELECT RAISE(ABORT, 'plan fuera del proyecto'); END;"
    )
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    plan_id: Option<i64>,
    prompt: Option<String>,
    agent: Option<String>,
    role: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    #[serde(flatten)]
    metadata: Metadata,
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
    #[serde(flatten)]
    metadata: Metadata,
    phase: String,
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
    github: Option<crate::github::Branch>,
}

pub(crate) fn task_in(conn: &Connection, project: &str, id: i64) -> CmdResult<()> {
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
        "SELECT id,parent_id,title,goal,criteria,priority,risk,status,verification,tests,created_at,updated_at,plan_id,prompt,agent,role
         FROM tasks WHERE project=?1 ORDER BY id"
    ).map_err(err)?;
    let rows = query.query_map([project], |r| Ok(Task {
        id: r.get(0)?, parent_id: r.get(1)?, title: r.get(2)?, goal: r.get(3)?, criteria: r.get(4)?,
        priority: r.get(5)?, risk: r.get(6)?, status: r.get(7)?, verification: r.get(8)?,
        tests: r.get(9)?, created_at: r.get(10)?, updated_at: r.get(11)?,
        phase: String::new(),
        metadata: Metadata { plan_id: r.get(12)?, prompt: r.get(13)?, agent: r.get(14)?, role: r.get(15)? },
        dependencies: Vec::new(), waiting_for: Vec::new(), sessions: Vec::new(),
    })).map_err(err)?;
    let mut tasks = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?;
    let indexes: HashMap<_, _> = tasks.iter().enumerate().map(|(i, task)| (task.id, i)).collect();
    let mut deps = conn.prepare(
        "SELECT d.task_id,d.requires_id,r.status!='done' FROM tasks t
         JOIN task_dependencies d ON d.task_id=t.id JOIN tasks r ON r.id=d.requires_id
         WHERE t.project=?1 ORDER BY d.task_id,d.requires_id"
    ).map_err(err)?;
    let mut rows = deps.query([project]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let task = &mut tasks[indexes[&row.get::<_, i64>(0).map_err(err)?]];
        let dependency = row.get(1).map_err(err)?;
        task.dependencies.push(dependency);
        if row.get::<_, bool>(2).map_err(err)? {
            task.waiting_for.push(dependency);
        }
    }
    let mut links = conn.prepare(
        "SELECT l.task_id,s.id,s.name,s.engine,s.branch,s.worktree,s.base_commit,s.closed FROM tasks t
         JOIN task_sessions l ON l.task_id=t.id JOIN sessions s ON s.id=l.session_id
         WHERE t.project=?1 ORDER BY l.task_id,s.id"
    ).map_err(err)?;
    let mut branches = HashMap::new();
    let mut rows = links.query([project]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let task = &mut tasks[indexes[&row.get::<_, i64>(0).map_err(err)?]];
        let mut link = Link {
            id: row.get(1).map_err(err)?, name: row.get(2).map_err(err)?, engine: row.get(3).map_err(err)?,
            branch: row.get(4).map_err(err)?, worktree: row.get(5).map_err(err)?,
            base_commit: row.get(6).map_err(err)?, closed: row.get(7).map_err(err)?, github: None,
        };
        if let Some(branch) = &link.branch {
            let snapshot = match branches.entry(branch.clone()) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => entry.insert(crate::github::branch(conn, project, branch)?),
            };
            link.github = Some(snapshot.clone());
        }
        task.sessions.push(link);
    }
    for task in &mut tasks { task.phase = derived_phase(conn,task)?; }
    Ok(tasks)
}

fn derived_phase(conn: &Connection, task: &Task) -> CmdResult<String> {
    if matches!(task.status.as_str(),"done"|"cancelled"|"blocked") { return Ok(task.status.clone()); }
    let active: Option<(String,u32)> = conn.query_row("SELECT outcome,waiting_permissions FROM task_runs
        WHERE task_id=?1 AND ended_ms IS NULL AND coordinator=0 ORDER BY waiting_permissions DESC,id DESC LIMIT 1",
        [task.id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(err)?;
    if let Some((outcome,permissions))=active {
        return Ok(if permissions>0 {"waiting_permission"} else if outcome=="queued" {if task.waiting_for.is_empty(){"queued"}else{"waiting_dependencies"}} else if outcome=="preparing" {"pending"} else {"running"}.into());
    }
    if !task.waiting_for.is_empty() { return Ok("waiting_dependencies".into()); }
    if task.status=="ready" {
        let last: Option<String>=conn.query_row("SELECT outcome FROM task_runs WHERE task_id=?1 AND coordinator=0 ORDER BY id DESC LIMIT 1",[task.id],|r|r.get(0)).optional().map_err(err)?;
        if let Some(last)=last.filter(|s|matches!(s.as_str(),"failed"|"interrupted"|"paused_quota")) { return Ok(last); }
    }
    Ok(match task.status.as_str() {
        "ready"|"backlog"=>"pending", "waiting_approval"|"running"=>"interrupted",
        "review"|"ready_to_merge"=>"verifying", status=>status,
    }.into())
}

pub fn save(conn: &mut Connection, project: &str, input: Edit) -> CmdResult<i64> {
    const MANUAL: [&str; 9] = ["backlog", "ready", "blocked", "verifying", "review", "ready_to_merge", "done", "cancelled", "failed"];
    let Edit { metadata, id, parent_id, title, goal, criteria, priority, risk, status, verification, tests, dependencies } = input;
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
    if let Some(plan) = metadata.plan_id {
        plan_detail(&tx, project, plan)?;
    }
    if metadata.agent.as_deref().is_some_and(|v| !["claude", "codex", "opencode", "agy", "devin"].contains(&v))
        || metadata.role.as_deref().is_some_and(|v| !["researcher", "designer", "senior", "junior", "auditor", "auditor2"].contains(&v)) {
        return Err("agente o rol no válido para una tarea ejecutora".into());
    }
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
    // Missing/null metadata preserves existing values for legacy editors.
    tx.execute("UPDATE tasks SET plan_id=coalesce(?2,plan_id),prompt=coalesce(?3,prompt),
        agent=coalesce(?4,agent),role=coalesce(?5,role) WHERE id=?1",
        params![id,metadata.plan_id,metadata.prompt,metadata.agent,metadata.role]).map_err(err)?;
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

#[allow(clippy::too_many_arguments)]
pub fn delegation(conn: &mut Connection, project: &str, parent: Option<i64>, title: &str, goal: &str, prompt: &str, agent: &str, role: &str) -> CmdResult<i64> {
    if let Some(parent)=parent { task_in(conn,project,parent)?; }
    let plan=create_plan(conn,project,PlanInput{title:title.into(),goal:goal.into(),criteria:"Validar el objetivo delegado y registrar el resultado comprobado.".into()})?;
    let result=save(conn,project,Edit {
        metadata: Metadata {plan_id:Some(plan),prompt:Some(prompt.into()),agent:Some(agent.into()),role:Some(role.into())},
        parent_id:parent,id:None,title:title.into(),goal:goal.into(),criteria:"Validar el objetivo delegado y registrar el resultado comprobado.".into(),
        priority:"normal".into(),risk:"normal".into(),status:"ready".into(),verification:String::new(),tests:None,dependencies:Vec::new(),
    });
    if result.is_err() { conn.execute("DELETE FROM task_plans WHERE id=?1",[plan]).map_err(err)?; }
    result
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
        if !crate::isolate::integration_verified(&session)? && !crate::pr::merged_worktree(conn, &session)? {
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
pub async fn tasks_list(app: AppHandle, project: String) -> CmdResult<Vec<Task>> {
    crate::background_read(app, move |state| {
        let conn = state.db.lock().map_err(err)?;
        list(&conn, &project_path(&conn, &project)?)
    }).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    progress: PlanProgress,
    id: i64, project: String, title: String, goal: String, criteria: String,
    created_at: i64, updated_at: i64,
}

#[derive(Default, Serialize)]
pub struct PlanProgress { total: u32, done: u32 }

#[derive(Deserialize)]
pub struct PlanInput { title: String, goal: String, criteria: String }

fn plan_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Plan> {
    Ok(Plan { progress: PlanProgress::default(), id: row.get(0)?, project: row.get(1)?, title: row.get(2)?, goal: row.get(3)?,
        criteria: row.get(4)?, created_at: row.get(5)?, updated_at: row.get(6)? })
}

pub fn plans(conn: &Connection, project: &str) -> CmdResult<Vec<Plan>> {
    let mut q = conn.prepare("SELECT id,project,title,goal,criteria,created_at,updated_at FROM task_plans WHERE project=?1 ORDER BY id").map_err(err)?;
    let rows = q.query_map([project], plan_row).map_err(err)?;
    let mut plans=rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?;
    for plan in &mut plans { plan.progress=plan_progress(conn,plan.id)?; }
    Ok(plans)
}

fn plan_progress(conn: &Connection, id: i64) -> CmdResult<PlanProgress> {
    conn.query_row("SELECT count(*),coalesce(sum(status='done'),0) FROM tasks WHERE plan_id=?1",[id],|r|Ok(PlanProgress{total:r.get(0)?,done:r.get(1)?})).map_err(err)
}

pub fn plan_detail(conn: &Connection, project: &str, id: i64) -> CmdResult<Plan> {
    let mut plan=conn.query_row("SELECT id,project,title,goal,criteria,created_at,updated_at FROM task_plans WHERE project=?1 AND id=?2",
        params![project,id], plan_row).optional().map_err(err)?.ok_or("el plan no pertenece al proyecto")?;
    plan.progress=plan_progress(conn,id)?;
    Ok(plan)
}

pub fn create_plan(conn: &Connection, project: &str, input: PlanInput) -> CmdResult<i64> {
    let (title, goal, criteria) = (input.title.trim(), input.goal.trim(), input.criteria.trim());
    if title.is_empty() || goal.is_empty() || criteria.is_empty() || title.chars().count() > 110 {
        return Err("completa título breve (máximo 110 caracteres), objetivo y criterios del plan".into());
    }
    conn.execute("INSERT INTO task_plans(project,title,goal,criteria) VALUES(?1,?2,?3,?4)",
        params![project,title,goal,criteria]).map_err(err)?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub async fn task_plans_list(app: AppHandle, project: String) -> CmdResult<Vec<Plan>> {
    crate::background_read(app, move |state| {
        let conn = state.db.lock().map_err(err)?;
        plans(&conn, &project_path(&conn, &project)?)
    }).await
}

#[tauri::command]
pub async fn task_plan_detail(app: AppHandle, project: String, plan: i64) -> CmdResult<Plan> {
    crate::background_read(app, move |state| {
        let conn = state.db.lock().map_err(err)?;
        plan_detail(&conn, &project_path(&conn, &project)?, plan)
    }).await
}

#[tauri::command]
pub fn task_plan_create(app: AppHandle, project: String, input: PlanInput) -> CmdResult<i64> {
    let state = app.state::<AppState>();
    let conn = state.db.lock().map_err(err)?;
    let id = create_plan(&conn, &project_path(&conn, &project)?, input)?;
    drop(conn);
    changed(&app);
    Ok(id)
}

#[derive(Serialize)]
pub struct FlowSnapshot {
    plans: Vec<Plan>,
    tasks: Vec<Task>,
    runs: HashMap<i64, Vec<crate::runs::Run>>,
}

#[tauri::command]
pub async fn task_flow(app: AppHandle, project: String) -> CmdResult<FlowSnapshot> {
    crate::background_read(app, move |state| {
        let conn = state.db.lock().map_err(err)?;
        let project = project_path(&conn, &project)?;
        Ok(FlowSnapshot {
            plans: plans(&conn, &project)?,
            tasks: list(&conn, &project)?,
            runs: crate::runs::recent_for_project(&conn, &project).map_err(err)?,
        })
    }).await
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
        crate::runs::wake_queue(&app);
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
            metadata: Metadata::default(), id: None, parent_id: None, title: title.into(), goal: "objetivo".into(), criteria: "criterio".into(),
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
    fn flow_dependency_failure_keeps_prompt_and_never_marks_dispatch_or_done() {
        let mut conn=db::open(std::path::Path::new(":memory:")).unwrap();
        let dependency=save(&mut conn,"one",draft("Dependency")).unwrap();
        let task=save(&mut conn,"one",Edit{dependencies:vec![dependency],..draft("Blocked")}).unwrap();
        let prompt=" exact blocked prompt  ";
        let run=runs::prepare(&conn,"one","scope","codex",None,Some(task),prompt,false).unwrap();
        let tx=conn.transaction().unwrap();
        let error=runs::begin_prepared(&tx,"one","scope","codex",None,Some(task),Some(run)).unwrap_err();
        assert!(error.contains("dependencias")); drop(tx);
        runs::fail_start(&conn,run,&error).unwrap();
        let row=list(&conn,"one").unwrap().pop().unwrap();
        assert_eq!(row.phase,"waiting_dependencies"); assert_eq!(row.metadata.prompt.as_deref(),Some(prompt));
        let json=serde_json::to_value(runs::recent(&conn,task).unwrap()).unwrap();
        assert_eq!(json[0]["prompt"],prompt); assert!(json[0]["dispatchedMs"].is_null()); assert_eq!(json[0]["outcome"],"failed");
        assert!(save(&mut conn,"one",Edit{id:Some(task),status:"done".into(),..draft("Blocked")}).is_err());
    }

    #[test]
    fn flow_delegation_keeps_independent_tasks_plans_prompts_and_parent() {
        let mut conn=db::open(std::path::Path::new(":memory:")).unwrap();
        let parent=save(&mut conn,"one",draft("PM objective")).unwrap();
        for (agent,prompt) in [("claude"," literal Claude  "),("codex"," literal Codex\n"),("agy","literal ACP")] {
            delegation(&mut conn,"one",Some(parent),"Brief title","Separate goal",prompt,agent,"senior").unwrap();
        }
        let rows=list(&conn,"one").unwrap();
        assert_eq!(rows.len(),4);
        assert!(rows[0].metadata.plan_id.is_none());
        assert!(rows[0].metadata.prompt.is_none());
        let plan_ids=rows[1..].iter().map(|t|t.metadata.plan_id.unwrap()).collect::<std::collections::HashSet<_>>();
        assert_eq!(plan_ids.len(),3);
        assert_eq!(rows[1].metadata.prompt.as_deref(),Some(" literal Claude  "));
        for task in &rows[1..] { assert_eq!(task.parent_id,Some(parent)); assert_eq!(task.goal,"Separate goal"); assert_eq!(task.title,"Brief title"); }
        for plan in plans(&conn,"one").unwrap() {assert_eq!(plan.progress.total,1);assert_eq!(plan.progress.done,0);}
        let count=plans(&conn,"one").unwrap().len();
        assert!(delegation(&mut conn,"two",Some(parent),"title","goal","prompt","codex","senior").is_err());
        assert!(delegation(&mut conn,"one",None,"title","goal","prompt","invalid","senior").is_err());
        assert_eq!(plans(&conn,"one").unwrap().len(),count);
    }

    #[test]
    fn flow_contract_accepts_legacy_edits_and_validates_new_metadata() {
        let mut conn = db::open(std::path::Path::new(":memory:")).unwrap();
        let legacy = serde_json::json!({"id":null,"parentId":null,"title":"Legacy","goal":"Goal",
            "criteria":"Check","priority":"normal","risk":"low","status":"ready",
            "verification":"","tests":null,"dependencies":[]});
        let id = save(&mut conn, "one", serde_json::from_value(legacy.clone()).unwrap()).unwrap();
        let value = serde_json::to_value(list(&conn, "one").unwrap()).unwrap();
        for key in ["planId", "prompt", "agent", "role"] { assert!(value[0][key].is_null()); }
        assert_eq!(value[0]["id"], id);
        let mut bad = legacy.clone();
        bad["role"] = serde_json::json!("pm");
        assert!(save(&mut conn, "one", serde_json::from_value(bad).unwrap()).is_err());
        let mut bad = legacy;
        bad["agent"] = serde_json::json!("unknown");
        assert!(save(&mut conn, "one", serde_json::from_value(bad).unwrap()).is_err());
        for title in [" ".to_owned(), "x".repeat(111)] {
            assert!(create_plan(&conn, "one", PlanInput { title, goal: "g".into(), criteria: "c".into() }).is_err());
        }
        assert!(create_plan(&conn, "one", PlanInput { title: "ñ".repeat(110), goal: "g".into(), criteria: "c".into() }).is_ok());
        assert_eq!(list(&conn, "one").unwrap().len(), 1);
    }

    #[test]
    fn flow_plans_persist_exact_prompt_and_reject_foreign_assignment() {
        let path = std::env::temp_dir().join(format!("flow-plans-{}.sqlite", uuid::Uuid::new_v4()));
        let mut conn = db::open(&path).unwrap();
        let plan = create_plan(&conn, "one", PlanInput { title: "Plan breve".into(), goal: "Objetivo separado".into(), criteria: "Comprobar".into() }).unwrap();
        let prompt = "  encargo exacto\n\ncon espacios finales  ";
        let task = save(&mut conn, "one", Edit { metadata: Metadata { plan_id: Some(plan), prompt: Some(prompt.into()), agent: Some("codex".into()), role: Some("senior".into()) }, ..draft("Título corto") }).unwrap();
        assert!(plan_detail(&conn, "two", plan).is_err());
        assert!(plans(&conn, "two").unwrap().is_empty());
        assert!(save(&mut conn, "two", Edit { metadata: Metadata { plan_id: Some(plan), ..Metadata::default() }, ..draft("Ajena") }).is_err());
        assert!(conn.execute("UPDATE tasks SET project='two' WHERE id=?1", [task]).is_err());
        assert!(conn.execute("INSERT INTO tasks(project,title,goal,criteria,priority,risk,status,plan_id) VALUES('two','x','','','normal','low','ready',?1)", [plan]).is_err());
        // A legacy editor must not erase metadata it does not know about.
        save(&mut conn, "one", Edit { id: Some(task), ..draft("Renombrada") }).unwrap();
        drop(conn);
        let conn = db::open(&path).unwrap();
        let tasks = list(&conn, "one").unwrap();
        assert_eq!(tasks[0].metadata.plan_id, Some(plan));
        assert_eq!(tasks[0].metadata.prompt.as_deref(), Some(prompt));
        assert_eq!(tasks[0].metadata.agent.as_deref(), Some("codex"));
        assert_eq!(tasks[0].metadata.role.as_deref(), Some("senior"));
        assert_eq!(tasks[0].title, "Renombrada");
        assert_eq!(plan_detail(&conn, "one", plan).unwrap().goal, "Objetivo separado");
        assert_eq!(serde_json::to_value(&tasks[0]).unwrap()["planId"], plan);
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn flow_migration_is_additive_idempotent_and_preserves_legacy_unknowns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE tasks (
          id INTEGER PRIMARY KEY,project TEXT NOT NULL,parent_id INTEGER,title TEXT NOT NULL,
          goal TEXT NOT NULL,criteria TEXT NOT NULL,priority TEXT NOT NULL,risk TEXT NOT NULL,
          status TEXT NOT NULL,verification TEXT NOT NULL DEFAULT '',tests TEXT,
          created_at INTEGER NOT NULL DEFAULT 10,updated_at INTEGER NOT NULL DEFAULT 20);
          INSERT INTO tasks(id,project,title,goal,criteria,priority,risk,status) VALUES(42,'one','Anterior','Objetivo','Criterios','normal','low','done');
          CREATE TABLE task_runs (
          id INTEGER PRIMARY KEY,task_id INTEGER,session_id INTEGER,scope TEXT NOT NULL,
          project TEXT NOT NULL,provider TEXT NOT NULL,model TEXT,turn TEXT,started_ms INTEGER NOT NULL,
          ended_ms INTEGER,outcome TEXT NOT NULL DEFAULT 'running',retry INTEGER NOT NULL,
          input_tokens INTEGER,cached_input_tokens INTEGER,output_tokens INTEGER,cost_estimate_usd REAL,
          quota_short_percent REAL,quota_long_percent REAL,quota_short_minutes INTEGER,
          quota_long_minutes INTEGER,context_tokens INTEGER);
          INSERT INTO task_runs(id,task_id,scope,project,provider,started_ms,ended_ms,retry,outcome)
          VALUES(9,42,'legacy','one','codex',100,200,1,'completed');").unwrap();
        for _ in 0..2 { migrate(&conn).unwrap(); runs::migrate(&conn).unwrap(); }
        let legacy: (String, String, Option<i64>, Option<String>) = conn.query_row(
            "SELECT title,status,plan_id,prompt FROM tasks WHERE id=42", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(legacy, ("Anterior".into(), "done".into(), None, None));
        assert!(plans(&conn, "one").unwrap().is_empty());
        let unknown: (Option<i64>, Option<String>, Option<String>, Option<i64>) = conn.query_row(
            "SELECT attempt,prompt,result,dispatched_ms FROM task_runs WHERE id=9", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(unknown, (None, None, None, None));
        let previous: (i64,i64,bool,String) = conn.query_row("SELECT started_ms,ended_ms,retry,outcome FROM task_runs WHERE id=9", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(previous, (100,200,true,"completed".into()));
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
        let next = db::create_handoff(&mut conn, 41, "codex", "", &["puyol"], "resumen guardado").unwrap();
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
