use std::collections::HashMap;
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use tauri::AppHandle;

use crate::{db, err, git, github, pr, work, workspace::project_path, CmdResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HomeTask {
    id: i64,
    title: String,
    status: String,
    updated_at: i64,
}

#[derive(Serialize)]
pub struct Summary {
    path: String,
    tasks: Vec<HomeTask>,
    sessions: Vec<db::Session>,
    work: Option<work::Work>,
    branch: Option<String>,
    dates: Option<Vec<String>>,
    ci: Option<github::Pull>,
    #[serde(skip)]
    observations: Vec<github::Pull>,
}

fn read_summaries(conn: &Connection, paths: &[String], focus: Option<&str>) -> CmdResult<Vec<Summary>> {
    let mut summaries = Vec::new();
    for path in paths {
        let Ok(canonical) = project_path(conn, path) else { continue };
        if canonical != *path {
            continue;
        }
        summaries.push(Summary {
            path: canonical,
            tasks: Vec::new(),
            sessions: if focus == Some(path) { db::sessions(conn, path).map_err(err)? } else { Vec::new() },
            work: work::current(conn, path)?,
            branch: None,
            dates: None,
            ci: None,
            observations: Vec::new(),
        });
    }
    let indexes: HashMap<_, _> = summaries.iter().enumerate().map(|(i, item)| (item.path.clone(), i)).collect();
    let scope = serde_json::to_string(paths).map_err(err)?;
    let mut query = conn.prepare(
        "SELECT project,id,title,status,updated_at FROM tasks
         WHERE project IN (SELECT value FROM json_each(?1)) AND status NOT IN ('done','cancelled') ORDER BY id"
    ).map_err(err)?;
    let mut rows = query.query([&scope]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let path: String = row.get(0).map_err(err)?;
        if let Some(&i) = indexes.get(&path) {
            summaries[i].tasks.push(HomeTask {
                id: row.get(1).map_err(err)?, title: row.get(2).map_err(err)?,
                status: row.get(3).map_err(err)?, updated_at: row.get(4).map_err(err)?,
            });
        }
    }
    let mut ci = conn.prepare(
        "SELECT project,snapshot FROM (
             SELECT project,snapshot,ROW_NUMBER() OVER (
                PARTITION BY project ORDER BY observed_at DESC, number DESC
             ) AS rank
             FROM github_pulls WHERE project IN (SELECT value FROM json_each(?1))
               AND CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.state') END='OPEN'
         ) WHERE rank<=8 ORDER BY project,rank",
    ).map_err(err)?;
    let mut rows = ci.query([scope]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let path: String = row.get(0).map_err(err)?;
        if let Some(&i) = indexes.get(&path) {
            let snapshot: String = row.get(1).map_err(err)?;
            if let Ok(pull) = serde_json::from_str(&snapshot) {
                summaries[i].observations.push(pull);
            }
        }
    }
    Ok(summaries)
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentSession {
    pub project: String,
    pub session_id: Option<i64>,
    pub is_pm: bool,
    pub name: String,
    pub engine: String,
    pub branch: Option<String>,
    pub task: Option<String>,
    pub closed: bool,
    pub paused: bool,
    pub running: bool,
    pub last_outcome: Option<String>,
    pub last_active_ms: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HomeActivityItem {
    pub id: String,
    pub kind: String,
    pub phase: String,
    pub project: String,
    pub title: String,
    pub detail: Option<String>,
    pub timestamp_ms: i64,
    pub session_id: Option<i64>,
    pub task_id: Option<i64>,
}

fn canonical_scope(conn: &Connection, paths: &[String]) -> Vec<String> {
    let mut allowed = Vec::new();
    for path in paths {
        if let Ok(canonical) = project_path(conn, path) {
            if canonical == *path {
                allowed.push(canonical);
            }
        }
    }
    allowed
}

fn read_recent_sessions(conn: &Connection, paths: &[String], limit: usize) -> CmdResult<Vec<RecentSession>> {
    let allowed = canonical_scope(conn, paths);
    if allowed.is_empty() {
        return Ok(Vec::new());
    }
    let scope = serde_json::to_string(&allowed).map_err(err)?;
    let mut out = Vec::new();
    let mut pm_projects_seen = std::collections::HashSet::new();

    // 1. Sesiones registradas (abiertas o cerradas, excluyendo subsesiones internas).
    let mut stmt = conn.prepare(
        "SELECT s.id, s.project, s.engine, COALESCE(NULLIF(TRIM(s.title), ''), s.name),
                s.branch, s.task, s.closed,
                EXISTS(SELECT 1 FROM project_manager_claude pm WHERE pm.session_id = s.id) AS is_pm,
                COALESCE(MAX(COALESCE(r.ended_ms, r.started_ms)), s.created_at * 1000) AS last_ms,
                s.paused IS NOT NULL AS is_paused,
                EXISTS(SELECT 1 FROM task_runs r2 WHERE r2.session_id = s.id AND r2.ended_ms IS NULL) AS is_running,
                (SELECT r3.outcome FROM task_runs r3 WHERE r3.session_id = s.id
                 ORDER BY COALESCE(r3.ended_ms, r3.started_ms) DESC, r3.id DESC LIMIT 1) AS last_outcome
         FROM sessions s
         LEFT JOIN task_runs r ON r.session_id = s.id
         WHERE s.project IN (SELECT value FROM json_each(?1))
           AND s.parent_session IS NULL
         GROUP BY s.id
         ORDER BY last_ms DESC
         LIMIT ?2",
    ).map_err(err)?;
    let mut rows = stmt.query(rusqlite::params![&scope, limit as i64]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let project: String = row.get(1).map_err(err)?;
        let is_pm: bool = row.get(7).map_err(err)?;
        if is_pm {
            pm_projects_seen.insert(project.clone());
        }
        out.push(RecentSession {
            session_id: Some(row.get(0).map_err(err)?),
            project,
            is_pm,
            engine: row.get(2).map_err(err)?,
            name: if is_pm { "Project manager".into() } else { row.get(3).map_err(err)? },
            branch: row.get(4).map_err(err)?,
            task: row.get(5).map_err(err)?,
            closed: row.get::<_, i64>(6).map_err(err)? != 0,
            last_active_ms: row.get(8).map_err(err)?,
            paused: row.get::<_, i64>(9).map_err(err)? != 0,
            running: row.get::<_, i64>(10).map_err(err)? != 0,
            last_outcome: row.get(11).map_err(err)?,
        });
    }

    // 2. Hilos del Project manager de Codex con actividad registrada en task_runs.
    let mut pm_stmt = conn.prepare(
        "SELECT r.project,
                MAX(COALESCE(r.ended_ms, r.started_ms)) AS last_ms,
                EXISTS(SELECT 1 FROM task_runs r2 WHERE r2.session_id IS NULL AND r2.project = r.project AND r2.ended_ms IS NULL) AS is_running,
                (SELECT r3.outcome FROM task_runs r3 WHERE r3.session_id IS NULL AND r3.project = r.project
                 ORDER BY COALESCE(r3.ended_ms, r3.started_ms) DESC, r3.id DESC LIMIT 1) AS last_outcome
         FROM task_runs r
         WHERE r.session_id IS NULL
           AND r.project IN (SELECT value FROM json_each(?1))
         GROUP BY r.project
         ORDER BY last_ms DESC
         LIMIT ?2",
    ).map_err(err)?;
    let mut pm_rows = pm_stmt.query(rusqlite::params![&scope, limit as i64]).map_err(err)?;
    while let Some(row) = pm_rows.next().map_err(err)? {
        let project: String = row.get(0).map_err(err)?;
        if pm_projects_seen.contains(&project) {
            continue;
        }
        out.push(RecentSession {
            project,
            session_id: None,
            is_pm: true,
            name: "Project manager".into(),
            engine: "codex".into(),
            branch: None,
            task: None,
            closed: false,
            paused: false,
            running: row.get::<_, i64>(2).map_err(err)? != 0,
            last_outcome: row.get(3).map_err(err)?,
            last_active_ms: row.get(1).map_err(err)?,
        });
    }

    out.sort_by_key(|a| std::cmp::Reverse(a.last_active_ms));
    out.truncate(limit);
    Ok(out)
}

fn read_home_activity(conn: &Connection, paths: &[String], limit: usize) -> CmdResult<Vec<HomeActivityItem>> {
    let allowed = canonical_scope(conn, paths);
    if allowed.is_empty() {
        return Ok(Vec::new());
    }
    let scope = serde_json::to_string(&allowed).map_err(err)?;
    let cap = limit as i64;
    let mut items = Vec::new();

    // 1. Tareas finalizadas o fallidas.
    let mut task_stmt = conn.prepare(
        "SELECT id, project, title, status, updated_at
         FROM tasks
         WHERE project IN (SELECT value FROM json_each(?1))
           AND status IN ('done', 'failed')
         ORDER BY updated_at DESC, id DESC
         LIMIT ?2",
    ).map_err(err)?;
    let mut rows = task_stmt.query(rusqlite::params![&scope, cap]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let id: i64 = row.get(0).map_err(err)?;
        let project: String = row.get(1).map_err(err)?;
        let title: String = row.get(2).map_err(err)?;
        let status: String = row.get(3).map_err(err)?;
        let updated_at: i64 = row.get(4).map_err(err)?;
        let failed = status == "failed";
        items.push(HomeActivityItem {
            id: format!("task:{id}:{status}"),
            kind: if failed { "task_failed".into() } else { "task_done".into() },
            phase: if failed { "pending".into() } else { "history".into() },
            project,
            title,
            detail: Some(if failed { format!("Tarea #{id} fallida") } else { format!("Tarea #{id} completada") }),
            timestamp_ms: updated_at * 1000,
            session_id: None,
            task_id: Some(id),
        });
    }

    // 2. Turnos recientes terminados o con error (último por sesión/PM para evitar ruido).
    let mut run_stmt = conn.prepare(
        "SELECT r.id, r.project, r.session_id, r.task_id, r.provider, r.outcome, r.ended_ms,
                COALESCE(NULLIF(TRIM(s.title), ''), s.name) AS sname,
                t.title AS ttitle,
                EXISTS(SELECT 1 FROM project_manager_claude pm WHERE pm.session_id = s.id) AS is_pm
         FROM task_runs r
         LEFT JOIN sessions s ON s.id = r.session_id
         LEFT JOIN tasks t ON t.id = r.task_id
         WHERE r.project IN (SELECT value FROM json_each(?1))
           AND r.ended_ms IS NOT NULL
           AND (s.id IS NULL OR s.parent_session IS NULL)
         ORDER BY r.ended_ms DESC, r.id DESC
         LIMIT ?2",
    ).map_err(err)?;
    let mut seen_run_scope = std::collections::HashSet::new();
    let mut rows = run_stmt.query(rusqlite::params![&scope, cap * 2]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let id: i64 = row.get(0).map_err(err)?;
        let project: String = row.get(1).map_err(err)?;
        let session_id: Option<i64> = row.get(2).map_err(err)?;
        let task_id: Option<i64> = row.get(3).map_err(err)?;
        let provider: String = row.get(4).map_err(err)?;
        let outcome: String = row.get(5).map_err(err)?;
        let ended_ms: i64 = row.get(6).map_err(err)?;
        let sname: Option<String> = row.get(7).map_err(err)?;
        let ttitle: Option<String> = row.get(8).map_err(err)?;
        let is_pm: bool = row.get::<_, i64>(9).map_err(err)? != 0;
        let dedup_key = (project.clone(), session_id);
        if !seen_run_scope.insert(dedup_key) {
            continue;
        }
        let actor = if session_id.is_none() || is_pm {
            "Project manager".to_string()
        } else {
            sname.unwrap_or_else(|| provider.clone())
        };
        let failed = matches!(outcome.as_str(), "failed" | "error" | "quota" | "interrupted");
        let title = if failed {
            format!("{actor} · {}", match outcome.as_str() {
                "quota" => "pausado por cuota",
                "interrupted" => "interrumpido",
                _ => "error en ejecución",
            })
        } else {
            format!("{actor} terminó su turno")
        };
        items.push(HomeActivityItem {
            id: format!("run:{id}"),
            kind: if failed { "run_failed".into() } else { "run_completed".into() },
            phase: if outcome == "quota" { "pending".into() } else { "history".into() },
            project,
            title,
            detail: ttitle.or_else(|| Some(provider)),
            timestamp_ms: ended_ms,
            session_id,
            task_id,
        });
    }

    // 3. Revisiones y auditorías (health_runs).
    let mut rev_stmt = conn.prepare(
        "SELECT h.id, h.project, h.session, h.task, h.tool, h.outcome, h.observed,
                (SELECT COUNT(*) FROM health_findings f WHERE f.run = h.id) AS findings
         FROM health_runs h
         WHERE h.project IN (SELECT value FROM json_each(?1))
         ORDER BY h.observed DESC, h.id DESC
         LIMIT ?2",
    ).map_err(err)?;
    let mut rows = rev_stmt.query(rusqlite::params![&scope, cap]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let id: i64 = row.get(0).map_err(err)?;
        let project: String = row.get(1).map_err(err)?;
        let session_id: Option<i64> = row.get(2).map_err(err)?;
        let task_id: Option<i64> = row.get(3).map_err(err)?;
        let tool: String = row.get(4).map_err(err)?;
        let _outcome: String = row.get(5).map_err(err)?;
        let observed: i64 = row.get(6).map_err(err)?;
        let findings: i64 = row.get(7).map_err(err)?;
        let detail = if findings == 0 {
            "Sin hallazgos".to_string()
        } else {
            format!("{findings} hallazgo{}", if findings == 1 { "" } else { "s" })
        };
        items.push(HomeActivityItem {
            id: format!("review:{id}"),
            kind: "review".into(),
            phase: "history".into(),
            project,
            title: format!("Revisión · {tool}"),
            detail: Some(detail),
            timestamp_ms: observed * 1000,
            session_id,
            task_id,
        });
    }

    // 4. Entregas: PRs observadas y sesiones de trabajo en revisión o terminadas.
    let mut pr_stmt = conn.prepare(
        "SELECT project, number, branch, snapshot, observed_at
         FROM github_pulls
         WHERE project IN (SELECT value FROM json_each(?1))
         ORDER BY observed_at DESC, number DESC
         LIMIT ?2",
    ).map_err(err)?;
    let mut rows = pr_stmt.query(rusqlite::params![&scope, cap]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let project: String = row.get(0).map_err(err)?;
        let number: i64 = row.get(1).map_err(err)?;
        let branch: String = row.get(2).map_err(err)?;
        let snapshot: String = row.get(3).map_err(err)?;
        let observed_at: i64 = row.get(4).map_err(err)?;
        let parsed = serde_json::from_str::<github::Pull>(&snapshot).ok();
        let is_open = parsed.as_ref().map(|p| p.state == "OPEN").unwrap_or(false);
        let detail = parsed.as_ref().map(|p| {
            if p.checks_known && p.checks_state == "failure" {
                "CI fallido".to_string()
            } else if p.is_draft {
                "En borrador".to_string()
            } else if p.review.as_deref() == Some("APPROVED") && p.checks_state == "success" {
                "Aprobada y lista".to_string()
            } else if p.state == "MERGED" {
                "Fusionada".to_string()
            } else {
                "En revisión".to_string()
            }
        });
        items.push(HomeActivityItem {
            id: format!("pr:{project}:{number}"),
            kind: "delivery".into(),
            phase: if is_open { "pending".into() } else { "history".into() },
            project,
            title: format!("PR #{number} · {branch}"),
            detail,
            timestamp_ms: observed_at * 1000,
            session_id: None,
            task_id: None,
        });
    }

    let mut work_stmt = conn.prepare(
        "SELECT id, project, objective, state, created_at
         FROM work_sessions
         WHERE project IN (SELECT value FROM json_each(?1))
           AND state IN ('review', 'finished')
         ORDER BY created_at DESC, id DESC
         LIMIT ?2",
    ).map_err(err)?;
    let mut rows = work_stmt.query(rusqlite::params![&scope, cap]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let id: i64 = row.get(0).map_err(err)?;
        let project: String = row.get(1).map_err(err)?;
        let objective: String = row.get(2).map_err(err)?;
        let state: String = row.get(3).map_err(err)?;
        let created_at: i64 = row.get(4).map_err(err)?;
        let review = state == "review";
        items.push(HomeActivityItem {
            id: format!("work:{id}"),
            kind: "delivery".into(),
            phase: if review { "pending".into() } else { "history".into() },
            project,
            title: objective,
            detail: Some(if review { "Entrega en revisión".into() } else { "Entrega completada".into() }),
            timestamp_ms: created_at * 1000,
            session_id: None,
            task_id: None,
        });
    }

    items.sort_by_key(|a| std::cmp::Reverse(a.timestamp_ms));
    items.truncate(limit);
    Ok(items)
}

#[tauri::command]
pub async fn recent_sessions(app: AppHandle, paths: Vec<String>, limit: Option<usize>) -> CmdResult<Vec<RecentSession>> {
    if paths.len() > 64 {
        return Err("máximo de 64 proyectos por consulta".into());
    }
    let cap = limit.unwrap_or(24).clamp(1, 50);
    crate::background_read(app, move |state| {
        let conn = state.db.lock().map_err(err)?;
        read_recent_sessions(&conn, &paths, cap)
    }).await
}

#[tauri::command]
pub async fn home_activity(app: AppHandle, paths: Vec<String>, limit: Option<usize>) -> CmdResult<Vec<HomeActivityItem>> {
    if paths.len() > 64 {
        return Err("máximo de 64 proyectos por consulta".into());
    }
    let cap = limit.unwrap_or(18).clamp(1, 40);
    crate::background_read(app, move |state| {
        let conn = state.db.lock().map_err(err)?;
        read_home_activity(&conn, &paths, cap)
    }).await
}

#[tauri::command]
pub async fn home_summary(app: AppHandle, paths: Vec<String>, focus: Option<String>) -> CmdResult<Vec<Summary>> {
    if paths.len() > 31 {
        return Err("máximo de 31 resúmenes de proyecto por consulta".into());
    }
    crate::background_read(app, move |state| {
        let mut summaries = {
            let conn = state.db.lock().map_err(err)?;
            read_summaries(&conn, &paths, focus.as_deref())?
        };
        // Ejecutar Git después de soltar SQLite, con un máximo de cuatro procesos a la vez.
        std::thread::scope(|scope| {
            for batch in summaries.chunks_mut(8) {
                scope.spawn(move || {
                    for item in batch {
                        let repo = Path::new(&item.path);
                        item.branch = git::head_at(repo).ok();
                        item.dates = git::commit_dates(repo).ok();
                        let observed = std::mem::take(&mut item.observations);
                        let branch = item.branch.as_deref();
                        if observed.iter().any(|pull| Some(pull.branch.as_str()) == branch) {
                            let head = pr::value(repo, &["rev-parse", "--verify", "HEAD"]).ok();
                            item.ci = observed.into_iter().find(|pull|
                                Some(pull.branch.as_str()) == branch && Some(pull.head.as_str()) == head.as_deref());
                        }
                    }
                });
            }
        });
        Ok(summaries)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn recent_sessions_orders_by_activity_and_filters_to_valid_projects() {
        let root = std::env::temp_dir().join(format!("fili-recent-{}", uuid::Uuid::new_v4()));
        let alpha = root.join("alpha");
        let beta = root.join("beta");
        std::fs::create_dir_all(alpha.join(".git")).unwrap();
        std::fs::create_dir_all(beta.join(".git")).unwrap();
        let root_c = std::fs::canonicalize(&root).unwrap();
        let alpha_s = std::fs::canonicalize(&alpha).unwrap().to_string_lossy().into_owned();
        let beta_s = std::fs::canonicalize(&beta).unwrap().to_string_lossy().into_owned();

        let conn = db::open(Path::new(":memory:")).unwrap();
        db::set_setting(&conn, "root", &root_c.to_string_lossy()).unwrap();

        conn.execute(
            "INSERT INTO sessions(project,engine,name,provider_session,task,closed,created_at) VALUES(?1,'claude','sesión 1','p1','Revisar API',0,1000)",
            params![&alpha_s],
        ).unwrap();
        let s1 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO sessions(project,engine,name,provider_session,task,closed,created_at) VALUES(?1,'codex','sesión 2','p2','Ajustar CSS',1,2000)",
            params![&beta_s],
        ).unwrap();
        let s2 = conn.last_insert_rowid();
        // Subsesión hija: no debe aparecer como entrada raíz en el historial.
        conn.execute(
            "INSERT INTO sessions(project,engine,name,provider_session,parent_session,created_at) VALUES(?1,'claude','hija','p3',?2,9000)",
            params![&alpha_s, s1],
        ).unwrap();
        // Turno reciente en s1 para que pase por delante de s2.
        conn.execute(
            "INSERT INTO task_runs(session_id,scope,project,provider,started_ms,ended_ms,outcome,retry) VALUES(?1,'session:1',?2,'claude',5000000,5001000,'completed',0)",
            params![s1, &alpha_s],
        ).unwrap();
        // Turno del PM de Codex en beta aún más reciente.
        conn.execute(
            "INSERT INTO task_runs(session_id,scope,project,provider,started_ms,ended_ms,outcome,retry) VALUES(NULL,'thread-pm',?1,'codex',6000000,6002000,'completed',0)",
            params![&beta_s],
        ).unwrap();

        let list = read_recent_sessions(&conn, &[alpha_s.clone(), beta_s.clone()], 10).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!((list[0].project.as_str(), list[0].is_pm, list[0].session_id, list[0].running, list[0].last_outcome.as_deref()), (beta_s.as_str(), true, None, false, Some("completed")));
        assert_eq!((list[1].project.as_str(), list[1].session_id, list[1].closed, list[1].paused), (alpha_s.as_str(), Some(s1), false, false));
        assert_eq!((list[2].project.as_str(), list[2].session_id, list[2].closed), (beta_s.as_str(), Some(s2), true));

        // Actividad reciente real: tarea finalizada, turno y revisión.
        conn.execute(
            "INSERT INTO tasks(project,title,goal,criteria,priority,risk,status,updated_at) VALUES(?1,'Cerrar migración','','','alta','bajo','done',7000)",
            params![&alpha_s],
        ).unwrap();
        conn.execute(
            "INSERT INTO health_runs(project,tool,source,outcome,observed) VALUES(?1,'Auditor','SARIF','passed',6500)",
            params![&beta_s],
        ).unwrap();
        let activity = read_home_activity(&conn, &[alpha_s.clone(), beta_s.clone()], 10).unwrap();
        assert!(activity.iter().any(|item| item.kind == "task_done" && item.title == "Cerrar migración"));
        assert!(activity.iter().any(|item| item.kind == "review" && item.title.contains("Auditor")));
        assert!(activity.iter().any(|item| item.kind == "run_completed"));
        assert!(activity.windows(2).all(|pair| pair[0].timestamp_ms >= pair[1].timestamp_ms));

        std::fs::remove_dir_all(root).unwrap();
    }
}
