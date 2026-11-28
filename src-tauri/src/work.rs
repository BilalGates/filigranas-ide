//! Una sesión de trabajo coordina turnos, copias de trabajo y entrega.
use std::collections::HashSet;
use std::path::{Component, Path};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{db, err, pr, runs, AppState, CmdResult};

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_sessions (
           id INTEGER PRIMARY KEY, project TEXT NOT NULL, objective TEXT NOT NULL,
           branch TEXT NOT NULL, base_commit TEXT, state TEXT NOT NULL DEFAULT 'active',
           tests TEXT, evidence TEXT, reviewed_head TEXT, pr_url TEXT,
           created_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE UNIQUE INDEX IF NOT EXISTS work_project_active ON work_sessions(project) WHERE state!='finished';
         CREATE TABLE IF NOT EXISTS work_agents (
           session_id INTEGER PRIMARY KEY REFERENCES sessions(id),
           work_id INTEGER NOT NULL REFERENCES work_sessions(id),
           paths TEXT NOT NULL DEFAULT '[\".\"]'
         );",
    )
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    pub id: i64,
    pub objective: String,
    pub branch: String,
    pub base_commit: Option<String>,
    pub state: String,
    pub tests: Option<String>,
    pub evidence: Option<String>,
    pub reviewed_head: Option<String>,
    pub pr_url: Option<String>,
    pub agents: Vec<Agent>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub session_id: i64,
    pub name: String,
    pub paths: Vec<String>,
    pub running: bool,
    pub closed: bool,
    pub isolated: bool,
}

pub fn current(conn: &Connection, project: &str) -> CmdResult<Option<Work>> {
    let work = conn.query_row(
        "SELECT id,objective,branch,base_commit,state,tests,evidence,reviewed_head,pr_url
         FROM work_sessions WHERE project=?1 ORDER BY (state!='finished') DESC,id DESC LIMIT 1",
        [project], |r| Ok(Work { id: r.get(0)?, objective: r.get(1)?, branch: r.get(2)?,
            base_commit: r.get(3)?, state: r.get(4)?, tests: r.get(5)?, evidence: r.get(6)?,
            reviewed_head: r.get(7)?, pr_url: r.get(8)?, agents: Vec::new() }),
    ).optional().map_err(err)?;
    work.map(|mut work| {
        let mut stmt = conn.prepare(
            "SELECT a.session_id,s.name,a.paths,s.closed,EXISTS(SELECT 1 FROM task_runs r WHERE r.session_id=s.id AND r.ended_ms IS NULL),s.worktree IS NOT NULL
             FROM work_agents a JOIN sessions s ON s.id=a.session_id WHERE a.work_id=?1 ORDER BY s.id",
        ).map_err(err)?;
        work.agents = stmt.query_map([work.id], |r| {
            let paths: String = r.get(2)?;
            Ok(Agent { session_id: r.get(0)?, name: r.get(1)?, paths: serde_json::from_str(&paths).unwrap_or_else(|_| vec![".".into()]),
                closed: r.get(3)?, running: r.get(4)?, isolated: r.get(5)? })
        }).map_err(err)?.collect::<rusqlite::Result<_>>().map_err(err)?;
        Ok(work)
    }).transpose()
}

pub fn idle(conn: &Connection, project: &str) -> CmdResult<()> {
    let busy: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM task_runs WHERE project=?1 AND ended_ms IS NULL)",
        [project], |r| r.get(0)).map_err(err)?;
    if busy { return Err("espera a que terminen los agentes y el coordinador".into()); }
    Ok(())
}

fn active(conn: &Connection, project: &str) -> CmdResult<Work> {
    current(conn, project)?.filter(|w| w.state != "finished")
        .ok_or_else(|| "no hay una sesión de trabajo Git activa; si quieres coordinar una rama de entrega compartida, iníciala desde Entrega".into())
}

fn check_branch(project: &str, work: &Work) -> CmdResult<()> {
    if pr::value(Path::new(project), &["branch", "--show-current"])? != work.branch {
        return Err(format!("la sesión de trabajo requiere la rama {}. Recupera esa rama antes de continuar", work.branch));
    }
    Ok(())
}

/// Al abrir un chat no se crea ninguna copia ni se cambia la rama.
pub fn join(conn: &Connection, project: &str, session: i64) -> CmdResult<()> {
    let Some(work) = current(conn, project)?.filter(|w| w.state != "finished") else { return Ok(()); };
    conn.execute("INSERT INTO work_agents(session_id,work_id) VALUES(?1,?2)
                  ON CONFLICT(session_id) DO NOTHING", params![session,work.id]).map_err(err)?;
    let assigned: i64 = conn.query_row("SELECT work_id FROM work_agents WHERE session_id=?1", [session], |r| r.get(0)).map_err(err)?;
    if assigned != work.id { return Err("este chat pertenece a una sesión de trabajo anterior; abre un chat nuevo para el objetivo actual".into()); }
    conn.execute("UPDATE sessions SET branch=?2,base='main',base_commit=?3 WHERE id=?1 AND worktree IS NULL",
        params![session,work.branch,work.base_commit]).map_err(err)?;
    Ok(())
}

pub fn branch_name(kind: &str, objective: &str) -> CmdResult<String> {
    if !["feat", "fix", "refactor", "docs", "test", "chore"].contains(&kind) {
        return Err("tipo de rama no válido".into());
    }
    let slug: String = objective.to_lowercase().chars().map(|c| match c {
        'á' | 'à' => 'a', 'é' | 'è' => 'e', 'í' | 'ï' => 'i', 'ó' | 'ò' => 'o',
        'ú' | 'ü' => 'u', 'ñ' => 'n', 'ç' => 'c',
        c if c.is_ascii_alphanumeric() => c, _ => '-',
    }).collect();
    let slug = slug.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    let slug = slug.chars().take(72).collect::<String>();
    let slug = slug.trim_matches('-');
    if slug.len() < 3 { return Err("describe el objetivo para dar nombre a la rama".into()); }
    Ok(format!("{kind}/{slug}"))
}

fn start(conn: &mut Connection, project: &str, objective: &str, kind: &str, description: &str, include_existing: bool) -> CmdResult<Work> {
    let objective = objective.trim();
    if objective.is_empty() { return Err("falta el objetivo de la sesión".into()); }
    idle(conn, project)?;
    if current(conn, project)?.is_some_and(|w| w.state != "finished") {
        return Err("ya hay una sesión de trabajo abierta en este proyecto".into());
    }
    let repo = Path::new(project);
    let branch = branch_name(kind, description)?;
    pr::value(repo, &["check-ref-format", "--branch", &branch])?;
    let dirty = !pr::value(repo, &["status", "--porcelain"])?.is_empty();
    if dirty && !include_existing {
        return Err("hay cambios previos: revísalos y marca incluir cambios existentes para incorporarlos a esta sesión".into());
    }
    let previous = pr::value(repo, &["symbolic-ref", "--short", "HEAD"])
        .map_err(|_| "cambia a una rama antes de iniciar la sesión")?;
    let head = pr::value(repo, &["rev-parse", "--verify", "HEAD"]).ok();
    // Nunca trasladar un árbol sucio a otra base ni descartar sus cambios.
    let base = if include_existing { "HEAD" } else if pr::value(repo, &["rev-parse", "--verify", "refs/remotes/origin/main"]).is_ok() {
        "refs/remotes/origin/main"
    } else if pr::value(repo, &["rev-parse", "--verify", "refs/heads/main"]).is_ok() { "refs/heads/main" } else { "HEAD" };
    let base_commit = if head.is_some() { Some(pr::value(repo, &["rev-parse", base])?) } else { None };
    let tx = conn.transaction().map_err(err)?;
    tx.execute("INSERT INTO work_sessions(project,objective,branch,base_commit) VALUES(?1,?2,?3,?4)",
        params![project,objective,branch,base_commit]).map_err(err)?;
    let id = tx.last_insert_rowid();
    // Vincula chats todavía sin sesión de trabajo; conserva su historia al cerrar.
    tx.execute("INSERT INTO work_agents(session_id,work_id)
                SELECT id,?2 FROM sessions WHERE project=?1 AND worktree IS NULL AND closed=0
                AND id NOT IN (SELECT session_id FROM project_manager_claude)
                AND id NOT IN (SELECT session_id FROM work_agents)",
        params![project,id]).map_err(err)?;
    tx.execute("UPDATE sessions SET branch=?2,base='main',base_commit=?3 WHERE id IN (SELECT session_id FROM work_agents WHERE work_id=?4)",
        params![project,branch,base_commit,id]).map_err(err)?;
    if head.is_some() { pr::value(repo, &["switch", "--no-track", "-c", &branch, base])?; }
    else { pr::value(repo, &["switch", "--no-track", "-c", &branch])?; }
    if let Err(error) = tx.commit() {
        let restored = pr::value(repo, &["switch", &previous]);
        return Err(format!("no se pudo guardar la sesión: {error}. Recuperación de rama: {restored:?}. La rama {branch} se conserva"));
    }
    current(conn, project)?.ok_or_else(|| "no se guardó la sesión".into())
}

fn normalize_paths(paths: Vec<String>) -> CmdResult<Vec<String>> {
    if paths.is_empty() { return Err("asigna al menos un archivo o carpeta; usa . para todo el proyecto".into()); }
    let mut result = Vec::new();
    for path in paths {
        let path = path.trim().trim_end_matches('/');
        if path != "." && (path.is_empty() || path.contains(['\\', '*', '\0']) || !Path::new(path).components().all(|c| matches!(c, Component::Normal(_)))
            || path.split('/').any(|p| p.eq_ignore_ascii_case(".git") || p == "." || p == "..")) {
            return Err(format!("asignación no válida: {path}. Usa rutas relativas sin comodines"));
        }
        if !result.iter().any(|p| p == path) { result.push(path.to_string()); }
    }
    Ok(result)
}

fn overlap(a: &str, b: &str) -> bool {
    // Conservador también para volúmenes insensibles a mayúsculas.
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    a == "." || b == "." || Path::new(&a).starts_with(&b) || Path::new(&b).starts_with(&a)
}

pub fn assign(conn: &Connection, project: &str, session: i64, paths: Vec<String>) -> CmdResult<()> {
    let work = active(conn, project)?;
    if work.state != "active" { return Err("reanuda la sesión antes de cambiar el reparto".into()); }
    if runs::session_active(conn, session).map_err(err)? { return Err("espera a que termine el turno para cambiar su asignación".into()); }
    let s = db::session(conn, session).map_err(err)?.ok_or("sesión cerrada o inexistente")?;
    if s.project != project || crate::chat::is_pm(conn, session).map_err(err)? {
        return Err("el agente no pertenece a este proyecto".into());
    }
    let paths = normalize_paths(paths)?;
    for path in &paths {
        let mut ancestor = std::path::PathBuf::from(s.cwd());
        for component in Path::new(path).components() {
            ancestor.push(component);
            if std::fs::symlink_metadata(&ancestor).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("asigna rutas reales en lugar de enlaces simbólicos para evitar ámbitos duplicados".into());
            }
        }
    }
    let tx = conn.unchecked_transaction().map_err(err)?;
    join(&tx, project, session)?;
    tx.execute("UPDATE work_agents SET paths=?3 WHERE session_id=?1 AND work_id=?2",
        params![session,work.id,serde_json::to_string(&paths).map_err(err)?]).map_err(err)?;
    tx.commit().map_err(err)
}

pub fn check_merge(repo: &Path, base: &str, head: &str) -> CmdResult<()> {
    let base_ref = format!("refs/remotes/origin/{base}");
    let out = crate::git::git_output(repo, &["merge-tree", "--write-tree", "--no-messages", &base_ref, head])?;
    match out.status.code() {
        Some(0) => Ok(()),
        Some(1) => Err(format!("hay conflictos con origin/{base}. Resuélvelos en la rama de trabajo y vuelve a ejecutar las pruebas")),
        _ => Err(format!("no se pudo comprobar la integración con origin/{base}. Comprueba la referencia y la versión de Git (2.38 o posterior)")),
    }
}

/// Se llama dentro de la misma transacción que registra el turno.
pub fn before_turn(conn: &Connection, project: &str, session: Option<i64>) -> CmdResult<()> {
    if current(conn, project)?.is_some_and(|w| w.state == "review") {
        return Err("El trabajo Git está en revisión. reanuda desde Entrega antes de iniciar otro turno.".into());
    }
    if let Some(id) = session {
        let s = db::session(conn, id).map_err(err)?.ok_or("sesión inexistente")?;
        if s.worktree.is_some() {
            let work_state: Option<(i64, String)> = conn.query_row(
                "SELECT w.id,w.state FROM work_agents a JOIN work_sessions w ON w.id=a.work_id WHERE a.session_id=?1",
                [id], |r| Ok((r.get(0)?, r.get(1)?))
            ).optional().map_err(err)?;
            if let Some((work, status)) = work_state {
                if status != "active" { return Err("reanuda el trabajo antes de ejecutar otro turno en esta sesión aislada".into()); }
                conn.execute("UPDATE work_sessions SET tests=NULL,evidence=NULL,reviewed_head=NULL WHERE id=?1", [work]).map_err(err)?;
            }
            return Ok(());
        }
        // Una sesión independiente puede conversar y trabajar sobre el checkout actual
        // sin exigir una sesión de trabajo Git activa. Solo si existe una sesión de
        // trabajo abierta se aplican sus controles de revisión, rama y reparto de archivos.
        let Some(work) = current(conn, project)?.filter(|w| w.state != "finished") else {
            return Ok(());
        };
        if work.state != "active" { return Err("la sesión de trabajo está en revisión para su PR; reanúdala desde Entrega para seguir trabajando".into()); }
        check_branch(project, &work)?;
        join(conn, project, id)?;
        let paths = work.agents.iter().find(|a| a.session_id == id).map(|a| a.paths.clone()).unwrap_or_else(|| vec![".".into()]);
        for agent in &work.agents {
            if agent.session_id != id && agent.running && !agent.isolated && paths.iter().any(|a| agent.paths.iter().any(|b| overlap(a,b))) {
                return Err(format!("{} está trabajando en archivos que se solapan con tu asignación. Espera a que termine o reparte áreas distintas", agent.name));
            }
        }
        conn.execute("UPDATE work_sessions SET tests=NULL,evidence=NULL,reviewed_head=NULL WHERE id=?1", [work.id]).map_err(err)?;
    } else if let Some(work) = current(conn, project)?.filter(|w| w.state != "finished") {
        if work.state != "active" { return Err("la sesión está en revisión para publicar su PR; reanúdala para abrir otro turno".into()); }
        check_branch(project, &work)?;
    }
    Ok(())
}

pub fn context(conn: &Connection, project: &str, session: Option<i64>, input: String) -> CmdResult<String> {
    let isolated = session.map(|id| db::session(conn, id)).transpose().map_err(err)?.flatten().is_some_and(|s| s.worktree.is_some());
    let Some(work) = current(conn, project)?.filter(|w| w.state != "finished") else { return Ok(input); };
    let scope = session.and_then(|id| work.agents.iter().find(|a| a.session_id == id));
    if isolated {
        return Ok(match scope {
            Some(agent) => format!("{input}\n\nTrabajas en una copia aislada. Área asignada: {}. Mantén los cambios en esta copia. Deja la integración al usuario.", agent.paths.join(", ")),
            None => input,
        });
    }
    let rules = match scope {
        Some(agent) => format!("Tu área asignada: {}. Modifica solo estas rutas. Si necesitas otra área, pide al coordinador que cambie el reparto y espera. No hagas commits, push, merge, checkout, stash ni operaciones del índice; los gestiona Larry desde el IDE. Conserva el trabajo ajeno.", agent.paths.join(", ")),
        None => "Coordina el reparto y revisa resultados. Mientras haya ejecutores activos, no edites archivos ni ejecutes operaciones Git que escriban. Usa los chats ejecutores para implementar. El cierre se realiza desde Entrega con una PR a main.".into(),
    };
    Ok(format!("{input}\n\n[Sesión de trabajo compartida #{}]\nObjetivo: {}\nRama: {} · destino: main\nTodos los agentes usan la carpeta del proyecto. {rules}", work.id, work.objective, work.branch))
}

/// Protege Git del IDE; las CLI externas no pasan por este bloqueo.
pub fn git_idle(conn: &Connection, project: &str) -> CmdResult<()> {
    idle(conn, project)?;
    if let Some(work) = current(conn, project)?.filter(|w| w.state != "finished") {
        if work.state != "active" { return Err("la sesión está en revisión; reanúdala antes de modificar Git".into()); }
        check_branch(project, &work)?;
    }
    Ok(())
}

fn require_integrated(conn: &Connection, work: &Work) -> CmdResult<()> {
    let mut checked = HashSet::new();
    // Un relevo conserva el mismo worktree. Solo su último titular puede
    // haber actualizado la huella de la integración.
    for agent in work.agents.iter().rev().filter(|agent| agent.isolated) {
        let Some(session) = db::session_any(conn, agent.session_id).map_err(err)? else { continue };
        if session.worktree.as_ref().is_some_and(|path| checked.insert(path.clone()))
            && !crate::isolate::integration_verified(&session)? {
            return Err(format!("integra primero los cambios de {}", session.name));
        }
    }
    Ok(())
}

fn prepare(conn: &Connection, project: &str, tests: &str, evidence: &str) -> CmdResult<()> {
    let work = active(conn, project)?;
    idle(conn, project)?;
    check_branch(project, &work)?;
    if !["passed", "not_applicable"].contains(&tests) || evidence.trim().is_empty() {
        return Err("registra pruebas correctas o no aplicables y su evidencia antes de finalizar".into());
    }
    require_integrated(conn, &work)?;
    let repo = Path::new(project);
    if !pr::value(repo, &["status", "--porcelain"])?.is_empty() {
        return Err("revisa y crea los commits con Larry antes de finalizar; quedan cambios sin commit".into());
    }
    pr::value(repo, &["diff", "--check", "refs/remotes/origin/main...HEAD"])?;
    let commits = pr::value(repo, &["rev-list", "--count", "refs/remotes/origin/main..HEAD"])?;
    if commits == "0" { return Err("no hay commits nuevos hacia main; la sesión se conserva abierta".into()); }
    let head = pr::value(repo, &["rev-parse", "HEAD"])?;
    check_merge(repo, "main", &head)?;
    conn.execute("UPDATE work_sessions SET state='review',tests=?2,evidence=?3,reviewed_head=?4 WHERE id=?1",
        params![work.id,tests,evidence.trim(),head]).map_err(err)?;
    Ok(())
}

pub fn publication(conn: &Connection, project: &str, dir: &Path, base: &str) -> CmdResult<Option<i64>> {
    if dir != Path::new(project) { return Ok(None); }
    let Some(work) = current(conn, project)?.filter(|w| w.state != "finished") else { return Ok(None); };
    idle(conn, project)?;
    check_branch(project, &work)?;
    if work.state != "review" || base != "main" { return Err("finaliza la sesión desde Entrega para revisar su PR hacia main".into()); }
    require_integrated(conn, &work)?;
    if !pr::value(dir, &["status", "--porcelain"])?.is_empty() || work.reviewed_head.as_deref() != Some(pr::value(dir, &["rev-parse", "HEAD"])?.as_str()) {
        return Err("el trabajo cambió después de las pruebas. Reanuda la sesión y vuelve a verificarlo".into());
    }
    Ok(Some(work.id))
}

pub fn complete(conn: &Connection, id: i64, pull: &crate::github::Pull) -> CmdResult<()> {
    let changed = conn.execute("UPDATE work_sessions SET state='finished',pr_url=?2 WHERE id=?1 AND state='review'
        AND branch=?3 AND reviewed_head=?4 AND ?5='main' AND ?6 IN ('OPEN','MERGED')",
        params![id,pull.url,pull.branch,pull.head,pull.base,pull.state]).map_err(err)?;
    if changed != 1 { return Err("la PR no coincide con el cierre revisado; consulta su estado y reintenta".into()); }
    Ok(())
}

fn changed(app: &AppHandle, project: &str) {
    crate::tasks::changed(app);
    let _ = app.emit("sessions-changed", serde_json::json!({"project":project}));
    let _ = app.emit("project-changed", ());
}

#[tauri::command]
pub fn work_current(state: State<AppState>, project: String) -> CmdResult<Option<Work>> {
    let conn = state.db.lock().map_err(err)?;
    let project = crate::workspace::project_path(&conn, &project)?;
    current(&conn, &project)
}

#[tauri::command]
pub async fn work_start(app: AppHandle, project: String, objective: String, kind: String, description: String, include_existing: bool) -> CmdResult<Work> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.chat_gate.lock().map_err(err)?;
        let _git = state.publication.try_lock().map_err(|_| "hay una operación Git en curso")?;
        let mut conn = state.db.lock().map_err(err)?;
        let project = crate::workspace::project_path(&conn, &project)?;
        let work = start(&mut conn, &project, &objective, &kind, &description, include_existing)?;
        drop(conn);
        changed(&app, &project);
        Ok(work)
    }).await.map_err(err)?
}

#[tauri::command]
pub fn work_assign(app: AppHandle, project: String, session: i64, paths: Vec<String>) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let conn = state.db.lock().map_err(err)?;
    let project = crate::workspace::project_path(&conn, &project)?;
    assign(&conn, &project, session, paths)?;
    drop(conn);
    changed(&app, &project);
    Ok(())
}

#[tauri::command]
pub async fn work_prepare(app: AppHandle, project: String, tests: String, evidence: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _git = state.publication.try_lock().map_err(|_| "hay una operación Git en curso")?;
        let conn = state.db.lock().map_err(err)?;
        let project = crate::workspace::project_path(&conn, &project)?;
        prepare(&conn, &project, &tests, &evidence)?;
        drop(conn);
        changed(&app, &project);
        Ok(())
    }).await.map_err(err)?
}

#[tauri::command]
pub fn work_resume(app: AppHandle, project: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let _git = state.publication.try_lock().map_err(|_| "hay una operación de publicación en curso")?;
    let conn = state.db.lock().map_err(err)?;
    let project = crate::workspace::project_path(&conn, &project)?;
    let work = active(&conn, &project)?;
    conn.execute("UPDATE work_sessions SET state='active',tests=NULL,evidence=NULL,reviewed_head=NULL WHERE id=?1", [work.id]).map_err(err)?;
    drop(conn);
    changed(&app, &project);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (std::path::PathBuf, String, Connection) {
        let dir = std::env::temp_dir().join(format!("filigranas-work-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let project = repo.to_string_lossy().into_owned();
        pr::value(&repo, &["init", "-q", "-b", "main"]).unwrap();
        pr::value(&repo, &["config", "user.name", "Test"]).unwrap();
        pr::value(&repo, &["config", "user.email", "test@example.invalid"]).unwrap();
        pr::value(&repo, &["config", "commit.gpgsign", "false"]).unwrap();
        pr::value(&repo, &["commit", "--allow-empty", "-qm", "base"]).unwrap();
        pr::value(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).unwrap();
        let conn = db::open(&dir.join("app.db")).unwrap();
        (dir, project, conn)
    }

    fn begin(conn: &mut Connection, project: &str, id: i64) -> CmdResult<i64> {
        let tx = conn.transaction().map_err(err)?;
        let run = runs::begin(&tx, project, &runs::session_scope(id), "claude", Some(id), None)?;
        tx.commit().map_err(err)?;
        Ok(run)
    }

    fn commit(project: &str) {
        let repo = Path::new(project);
        std::fs::write(repo.join("feature.txt"), "resultado\n").unwrap();
        pr::value(repo, &["add", "feature.txt"]).unwrap();
        pr::value(repo, &["commit", "-qm", "feat: resultado compartido"]).unwrap();
    }

    #[test]
    fn shared_checkout_reservations_restart_and_handoff() {
        let (dir, project, mut conn) = fixture();
        let a = db::create_session(&conn, &project, "claude", "a", &["uno"]).unwrap();
        let b = db::create_session(&conn, &project, "opencode", "b", &["dos"]).unwrap();
        let c = db::create_session(&conn, &project, "codex", "c", &["tres"]).unwrap();
        // Una sesión independiente puede iniciar turnos sin sesión de trabajo previa.
        let standalone = begin(&mut conn, &project, a.id).unwrap();
        runs::finish(&conn, standalone, "completed").unwrap();
        let work = start(&mut conn, &project, "Compartir el trabajo", "refactor", "agentes rama compartida", false).unwrap();
        assert_eq!(work.branch, "refactor/agentes-rama-compartida");
        assert!(pr::value(Path::new(&project), &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_err());
        assert_eq!(work.agents.len(), 3);
        for id in [a.id,b.id,c.id] {
            let s = db::session(&conn, id).unwrap().unwrap();
            assert!(s.worktree.is_none());
            assert_eq!(s.cwd(), project);
            assert_eq!(s.branch.as_deref(), Some(work.branch.as_str()));
        }
        assign(&conn, &project, a.id, vec!["src".into()]).unwrap();
        assign(&conn, &project, b.id, vec!["SRC/api.rs".into()]).unwrap();
        assign(&conn, &project, c.id, vec!["docs".into()]).unwrap();
        let first = begin(&mut conn, &project, a.id).unwrap();
        assert!(begin(&mut conn, &project, b.id).unwrap_err().contains("solapan"));
        let third = begin(&mut conn, &project, c.id).unwrap();
        assert!(git_idle(&conn, &project).is_err());
        assert!(assign(&conn, &project, a.id, vec!["other".into()]).is_err());
        assert!(prepare(&conn, &project, "passed", "pruebas").is_err());
        let instructions = context(&conn, &project, Some(a.id), "implementa".into()).unwrap();
        assert!(instructions.contains("Tu área asignada: src") && instructions.contains(&work.branch));
        runs::finish(&conn, first, "completed").unwrap();
        runs::finish(&conn, third, "completed").unwrap();
        let second = begin(&mut conn, &project, b.id).unwrap();
        runs::finish(&conn, second, "completed").unwrap();
        let next = db::create_handoff(&mut conn, a.id, "codex", "next", &["relevo"], "Decisión pendiente del relevo").unwrap();
        let after = current(&conn, &project).unwrap().unwrap();
        assert_eq!(after.agents.iter().find(|a| a.session_id == next.id).unwrap().paths, vec!["src"]);
        drop(conn);
        let mut conn = db::open(&dir.join("app.db")).unwrap();
        let restarted = current(&conn, &project).unwrap().unwrap();
        assert_eq!(restarted.id, work.id);
        assert_eq!(restarted.agents.len(), 4);
        let interrupted = begin(&mut conn, &project, next.id).unwrap();
        runs::recovery(&conn).unwrap();
        assert_eq!(runs::active(&conn, &runs::session_scope(next.id)).unwrap(), None);
        assert!(interrupted > 0);
        let tx = conn.transaction().unwrap();
        let retry = runs::begin(&tx, &project, &runs::session_scope(next.id), "codex", Some(next.id), None).unwrap();
        let input = runs::task_input(&tx, retry, &project, None, None, "Continúa").unwrap();
        assert!(input.contains("Decisión pendiente del relevo"));
        tx.commit().unwrap();
        runs::finish(&conn, retry, "completed").unwrap();
        let tx = conn.transaction().unwrap();
        let resumed = runs::begin(&tx, &project, &runs::session_scope(next.id), "codex", Some(next.id), None).unwrap();
        let input = runs::task_input(&tx, resumed, &project, None, None, "Nueva orden").unwrap();
        assert!(!input.contains("Decisión pendiente del relevo"));
        tx.rollback().unwrap();
        assert_eq!(pr::value(Path::new(&project), &["worktree", "list", "--porcelain"]).unwrap().matches("worktree ").count(), 1);
        drop(conn); // Windows no borra la base mientras siga abierta.
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn isolated_handoff_blocks_review_until_its_latest_owner_integrates() {
        let (dir, project, mut conn) = fixture();
        start(&mut conn, &project, "Aislar cambios", "feat", "cambio aislado", false).unwrap();
        let first = db::create_session(&conn, &project, "claude", "a", &["uno"]).unwrap();
        let checkout = crate::isolate::create_task_checkout(&dir, Path::new(&project), "claude").unwrap();
        db::set_session_worktree(&conn, first.id, &checkout.worktree, &checkout.branch, &checkout.base, &checkout.base_commit).unwrap();
        assign(&conn, &project, first.id, vec!["isolated.txt".into()]).unwrap();
        let handoff = db::create_handoff(&mut conn, first.id, "codex", "b", &["dos"], "").unwrap();
        std::fs::write(Path::new(&checkout.worktree).join("isolated.txt"), "contenido\n").unwrap();
        assert!(prepare(&conn, &project, "passed", "verificado").unwrap_err().contains("integra primero"));
        let (_, fingerprint) = crate::isolate::integrate(&handoff).unwrap();
        db::set_session_integrated(&conn, handoff.id, Some(&fingerprint)).unwrap();
        pr::value(Path::new(&project), &["add", "isolated.txt"]).unwrap();
        pr::value(Path::new(&project), &["commit", "-qm", "feat: trabajo aislado"]).unwrap();
        prepare(&conn, &project, "passed", "verificado").unwrap();
        assert!(begin(&mut conn, &project, handoff.id).unwrap_err().contains("reanuda"));
        let repo = Path::new(&project);
        assert!(publication(&conn, &project, repo, "main").unwrap().is_some());
        std::fs::write(Path::new(&checkout.worktree).join("isolated.txt"), "cambio posterior\n").unwrap();
        assert!(publication(&conn, &project, repo, "main").unwrap_err().contains("integra primero"));
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn closing_checks_evidence_sha_dirty_work_and_exact_pull() {
        let (dir, project, mut conn) = fixture();
        let s = db::create_session(&conn, &project, "claude", "a", &["uno"]).unwrap();
        let work = start(&mut conn, &project, "Brain global", "feat", "brain global", false).unwrap();
        assert!(prepare(&conn, &project, "passed", "sin commits").is_err());
        commit(&project);
        assert!(prepare(&conn, &project, "failed", "fallos").is_err());
        assert!(prepare(&conn, &project, "passed", " ").is_err());
        prepare(&conn, &project, "passed", "cargo test: correcto").unwrap();
        assert!(begin(&mut conn, &project, s.id).unwrap_err().contains("revisión"));
        let repo = Path::new(&project);
        assert_eq!(publication(&conn, &project, repo, "main").unwrap(), Some(work.id));
        assert!(publication(&conn, &project, repo, "other").is_err());
        std::fs::write(repo.join("later.txt"), "cambio externo").unwrap();
        assert!(publication(&conn, &project, repo, "main").is_err());
        std::fs::remove_file(repo.join("later.txt")).unwrap();
        pr::value(repo, &["commit", "--allow-empty", "-qm", "cambio posterior"]).unwrap();
        assert!(publication(&conn, &project, repo, "main").is_err());
        prepare(&conn, &project, "passed", "pruebas repetidas").unwrap();
        let head = pr::value(repo, &["rev-parse", "HEAD"]).unwrap();
        let mut pull = crate::github::Pull { number: 1, url: "https://github.com/example/repo/pull/1".into(),
            state: "OPEN".into(), is_draft: true, branch: work.branch.clone(), base: "main".into(), head,
            checks: (0,0,0), checks_state: "unknown".into(), checks_known: false, review: None,
            merge_state: "UNKNOWN".into(), observed_at: 0 };
        pull.base = "other".into();
        assert!(complete(&conn, work.id, &pull).is_err());
        pull.base = "main".into();
        complete(&conn, work.id, &pull).unwrap();
        assert_eq!(current(&conn, &project).unwrap().unwrap().state, "finished");
        let next = start(&mut conn, &project, "Corregir editor", "fix", "guardado editor", false).unwrap();
        assert_eq!(next.branch, "fix/guardado-editor");
        assert!(current(&conn, &project).unwrap().unwrap().agents.is_empty());
        assert!(begin(&mut conn, &project, s.id).unwrap_err().contains("sesión de trabajo anterior"));
        assert_eq!(db::session(&conn, s.id).unwrap().unwrap().branch.as_deref(), Some(work.branch.as_str()));
        drop(conn); // Windows no borra la base mientras siga abierta.
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn review_rejects_conflicts_without_changing_the_checkout() {
        let (dir, project, mut conn) = fixture();
        let repo = Path::new(&project);
        start(&mut conn, &project, "Entrega", "feat", "entrega", false).unwrap();
        commit(&project);
        let head = pr::value(repo, &["rev-parse", "HEAD"]).unwrap();
        pr::value(repo, &["switch", "main"]).unwrap();
        std::fs::write(repo.join("feature.txt"), "otro resultado\n").unwrap();
        pr::value(repo, &["add", "feature.txt"]).unwrap();
        pr::value(repo, &["commit", "-qm", "cambio de main"]).unwrap();
        pr::value(repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).unwrap();
        pr::value(repo, &["switch", "feat/entrega"]).unwrap();

        assert!(prepare(&conn, &project, "passed", "pruebas").unwrap_err().contains("conflictos"));
        assert_eq!(current(&conn, &project).unwrap().unwrap().state, "active");
        assert_eq!(pr::value(repo, &["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(pr::value(repo, &["status", "--porcelain"]).unwrap(), "");
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn dirty_start_is_explicit_and_failed_start_preserves_work() {
        let (dir, project, mut conn) = fixture();
        let repo = Path::new(&project);
        std::fs::write(repo.join("prior.txt"), "trabajo previo\n").unwrap();
        assert!(start(&mut conn, &project, "Mejorar editor", "fix", "mejorar editor", false).is_err());
        assert!(current(&conn, &project).unwrap().is_none());
        start(&mut conn, &project, "Mejorar editor", "fix", "mejorar editor", true).unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("prior.txt")).unwrap(), "trabajo previo\n");
        assert!(start(&mut conn, &project, "Otra sesión", "feat", "otra sesion", true).is_err());
        assert_eq!(pr::value(repo, &["branch", "--show-current"]).unwrap(), "fix/mejorar-editor");
        drop(conn); // Windows no borra la base mientras siga abierta.
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn descriptive_names_and_path_boundaries() {
        assert_eq!(branch_name("fix", "Guardado del éditor").unwrap(), "fix/guardado-del-editor");
        assert!(branch_name("ide", "xavi 1").is_err());
        assert!(branch_name("feat", "---").is_err());
        for invalid in ["/tmp", "../src", ".git/config", ".GIT/config", "src/../docs", "src/*.rs", "src\\api"] {
            assert!(normalize_paths(vec![invalid.into()]).is_err(), "{invalid}");
        }
        assert!(overlap("src", "src/api.rs"));
        assert!(!overlap("src/ui", "src/ui2"));
        assert!(overlap(".", "docs"));
    }
}
