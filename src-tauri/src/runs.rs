use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::{err, tasks, AppState, CmdResult};

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS task_runs (
           id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id), session_id INTEGER REFERENCES sessions(id),
           scope TEXT NOT NULL, project TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, turn TEXT,
           started_ms INTEGER NOT NULL, ended_ms INTEGER, outcome TEXT NOT NULL DEFAULT 'running',
           retry INTEGER NOT NULL, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER,
           cost_estimate_usd REAL, quota_short_percent REAL, quota_long_percent REAL,
           quota_short_minutes INTEGER, quota_long_minutes INTEGER, context_tokens INTEGER
         );
         CREATE UNIQUE INDEX IF NOT EXISTS task_runs_active ON task_runs(scope) WHERE ended_ms IS NULL;
         CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs(task_id,id);
         CREATE INDEX IF NOT EXISTS task_runs_session ON task_runs(session_id,ended_ms);
         CREATE UNIQUE INDEX IF NOT EXISTS task_runs_turn ON task_runs(scope,turn) WHERE turn IS NOT NULL;
         COMMIT;",
    )?;
    crate::db::add_columns(conn, "task_runs", &[
        ("attempt", "INTEGER CHECK(attempt IS NULL OR attempt > 0)"),
        ("prompt", "TEXT"), ("result", "TEXT"), ("dispatched_ms", "INTEGER"),
        ("queue_effort", "TEXT"), ("error", "TEXT"), ("coordinator", "INTEGER NOT NULL DEFAULT 0"),
        ("waiting_permissions", "INTEGER NOT NULL DEFAULT 0"),
    ])
}

pub fn session_scope(id: i64) -> String {
    format!("session:{id}")
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

/// Commit the literal input before provider/thread startup or runtime validation.
#[allow(clippy::too_many_arguments)]
pub fn prepare(conn: &Connection, project: &str, scope: &str, provider: &str, session: Option<i64>, task: Option<i64>, prompt: &str, coordinator: bool) -> CmdResult<i64> {
    if let Some(session) = session {
        let s = crate::db::session(conn, session).map_err(err)?.filter(|s| s.project == project).ok_or("sesión fuera del proyecto")?;
        if s.engine != provider { return Err("proveedor de sesión incorrecto".into()); }
    }
    if let Some(task) = task { tasks::task_in(conn, project, task)?; }
    if active(conn, scope)?.is_some() || session.map(|id| session_active(conn,id)).transpose().map_err(err)?.unwrap_or(false) {
        return Err("ya hay un turno en marcha; no se duplicó el intento".into());
    }
    let tx = conn.unchecked_transaction().map_err(err)?;
    let attempt: i64 = tx.query_row("SELECT coalesce(max(attempt),0)+1 FROM task_runs WHERE project=?1 AND session_id IS ?2 AND task_id IS ?3 AND coordinator=?4",
        params![project,session,task,coordinator], |r| r.get(0)).map_err(err)?;
    tx.execute("INSERT INTO task_runs(project,scope,provider,session_id,task_id,started_ms,retry,attempt,prompt,outcome,coordinator)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'preparing',?10)",
        params![project,scope,provider,session,task,now(),attempt>1,attempt,prompt,coordinator]).map_err(err)?;
    let run=tx.last_insert_rowid();
    if !coordinator {
        if let Some(task) = task { tx.execute("UPDATE tasks SET prompt=?2,updated_at=unixepoch() WHERE id=?1",params![task,prompt]).map_err(err)?; }
    }
    if let Some(session)=session { crate::db::set_session_task(&tx,session,prompt).map_err(err)?; }
    tx.commit().map_err(err)?;
    Ok(run)
}

/// Count executions, including unlinked sessions and several sessions of one task.
pub fn technical_active(conn: &Connection, project: &str) -> rusqlite::Result<u32> {
    conn.query_row("SELECT count(*) FROM task_runs r WHERE project=?1 AND ended_ms IS NULL
        AND outcome NOT IN ('preparing','queued') AND coordinator=0
        AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.path=r.project AND p.coordinator_thread=r.scope)
        AND NOT EXISTS(SELECT 1 FROM project_manager_claude p WHERE r.scope='session:'||p.session_id)",
        [project],|r|r.get(0))
}

pub fn fail_start(conn: &Connection, run: i64, error: &str) -> rusqlite::Result<()> {
    let ended: bool=conn.query_row("SELECT ended_ms IS NOT NULL FROM task_runs WHERE id=?1",[run],|r|r.get(0))?;
    conn.execute("UPDATE task_runs SET error=coalesce(error,?2) WHERE id=?1 AND outcome!='completed'",params![run,error])?;
    if ended { return Ok(()); }
    let preparing: bool=conn.query_row("SELECT outcome='preparing' FROM task_runs WHERE id=?1",[run],|r|r.get(0))?;
    if preparing { finish(conn,run,"failed") } else { Ok(()) }
}

pub fn result(conn: &Connection, run: i64, text: Option<&str>, error: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE task_runs SET result=coalesce(?2,result),error=coalesce(?3,error) WHERE id=?1 AND ended_ms IS NULL",
        params![run,text,error])?;
    Ok(())
}

pub fn append_result(conn: &Connection, run: i64, text: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE task_runs SET result=coalesce(result,'')||?2 WHERE id=?1 AND ended_ms IS NULL",params![run,text])?;
    Ok(())
}

#[cfg(test)]
pub fn begin(tx: &rusqlite::Transaction<'_>, project: &str, scope: &str, provider: &str, session: Option<i64>, task: Option<i64>) -> CmdResult<i64> {
    begin_prepared(tx,project,scope,provider,session,task,None)
}

#[allow(clippy::too_many_arguments)]
pub fn begin_prepared(tx: &rusqlite::Transaction<'_>, project: &str, scope: &str, provider: &str, session: Option<i64>, task: Option<i64>, prepared: Option<i64>) -> CmdResult<i64> {
    if let Some(run)=prepared {
        let valid: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM task_runs WHERE id=?1 AND project=?2 AND provider=?3 AND session_id IS ?4 AND task_id IS ?5 AND outcome='preparing' AND ended_ms IS NULL)",params![run,project,provider,session,task],|r|r.get(0)).map_err(err)?;
        if !valid { return Err("intento inválido o ya despachado".into()); }
    }
    let coordinator = prepared.map(|run|tx.query_row("SELECT coordinator FROM task_runs WHERE id=?1",[run],|r|r.get::<_,bool>(0))).transpose().map_err(err)?.unwrap_or(false);
    if crate::updates::INSTALLING.load(std::sync::atomic::Ordering::SeqCst) { return Err("instalando actualización".into()); }
    if active(tx, scope)?.is_some_and(|id| Some(id)!=prepared) || session.map(|id|
        tx.query_row("SELECT EXISTS(SELECT 1 FROM task_runs WHERE session_id=?1 AND ended_ms IS NULL AND id IS NOT ?2)",params![id,prepared],|r|r.get::<_,bool>(0))).transpose().map_err(err)?.unwrap_or(false) {
        return Err("ya hay un turno en marcha".into());
    }
    crate::work::before_turn(tx, project, session)?;
    if let Some(id) = task.filter(|_|!coordinator) {
        tasks::validate_start(tx, project, id)?;
    }
    if !coordinator && technical_active(tx,project).map_err(err)? >= tasks::parallel_limit(tx,project).map_err(err)? {
        return Err("se alcanzó el límite de ejecuciones técnicas en paralelo".into());
    }
    if let Some(run)=prepared {
        tx.execute("UPDATE task_runs SET scope=?2,outcome='running',dispatched_ms=?3 WHERE id=?1",params![run,scope,now()]).map_err(err)?;
        if !coordinator {
            if let Some(task)=task { tx.execute("UPDATE tasks SET status='running',tests=NULL,updated_at=unixepoch() WHERE id=?1",[task]).map_err(err)?; }
        }
        return Ok(run);
    }
    let previous = tx.query_row("SELECT outcome FROM task_runs WHERE scope=?1 AND task_id IS ?2 ORDER BY id DESC LIMIT 1",
        params![scope,task], |r| r.get::<_, String>(0)).optional().map_err(err)?;
    let retry = matches!(previous.as_deref(), Some("failed" | "interrupted" | "paused_quota"));
    tx.execute(
        "INSERT INTO task_runs(project,scope,provider,session_id,task_id,started_ms,retry)
         VALUES(?1,?2,?3,?4,?5,?6,?7)", params![project,scope,provider,session,task,now(),retry],
    ).map_err(err)?;
    let id = tx.last_insert_rowid();
    if let Some(task) = task {
        tx.execute("UPDATE tasks SET status='running',tests=NULL,updated_at=unixepoch() WHERE id=?1", [task]).map_err(err)?;
    }
    Ok(id)
}

pub fn active(conn: &Connection, scope: &str) -> CmdResult<Option<i64>> {
    conn.query_row("SELECT id FROM task_runs WHERE scope=?1 AND ended_ms IS NULL", [scope], |r| r.get(0)).optional().map_err(err)
}

pub fn task_active(conn: &Connection, task: i64) -> rusqlite::Result<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM task_runs WHERE task_id=?1 AND ended_ms IS NULL)", [task], |r| r.get(0))
}

pub fn session_active(conn: &Connection, session: i64) -> rusqlite::Result<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM task_runs WHERE session_id=?1 AND ended_ms IS NULL)", [session], |r| r.get(0))
}

pub fn task_for_thread(conn: &Connection, thread: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT task_id FROM task_runs WHERE scope=?1 AND ended_ms IS NULL", [thread], |r| r.get(0)).optional().map(Option::flatten)
}

pub fn last_task(conn: &Connection, scope: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT CASE WHEN outcome='completed' THEN task_id END FROM task_runs WHERE scope=?1 ORDER BY id DESC LIMIT 1", [scope], |r| r.get(0)).optional().map(Option::flatten)
}

pub fn task_input(tx: &rusqlite::Transaction<'_>, run: i64, project: &str, task: Option<i64>, previous: Option<i64>, text: &str) -> CmdResult<String> {
    let input = match task.filter(|id| Some(*id) != previous) {
        Some(id) => {
            let input = tasks::context(tx, id, text)?;
            crate::brain::augment(tx, run, project, id, text, input)?
        }
        None => text.into(),
    };
    let (session, handoff): (Option<i64>, Option<String>) = tx.query_row(
        "SELECT session_id,(SELECT handoff_context FROM sessions WHERE id=task_runs.session_id) FROM task_runs WHERE id=?1",
        [run], |r| Ok((r.get(0)?,r.get(1)?)),
    ).map_err(err)?;
    let input = match handoff {
        Some(context) => format!("{input}\n\n{context}"),
        None => input,
    };
    crate::work::context(tx, project, session, input)
}

pub fn bind_turn(conn: &Connection, scope: &str, turn: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE task_runs SET turn=?2 WHERE scope=?1 AND ended_ms IS NULL AND turn IS NULL", [scope,turn])?;
    Ok(())
}

pub fn for_turn(conn: &Connection, scope: &str, turn: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT id FROM task_runs WHERE scope=?1 AND turn=?2", [scope,turn], |r| r.get(0)).optional()
}

pub fn finish(conn: &Connection, run: i64, outcome: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    if tx.execute("UPDATE task_runs SET ended_ms=?2,outcome=?3,waiting_permissions=0 WHERE id=?1 AND ended_ms IS NULL",
        params![run,now(),outcome])? > 0
    {
        let next = match outcome {
            "completed" => {
                tx.execute("UPDATE sessions SET handoff_context=NULL WHERE handoff_context IS NOT NULL
                    AND id=(SELECT session_id FROM task_runs WHERE id=?1)", [run])?;
                "verifying"
            }
            "paused_quota" => "paused_quota",
            "cancelled" => "cancelled",
            "interrupted" => "ready",
            _ => "failed",
        };
        tx.execute(
            "UPDATE tasks SET status=?2,updated_at=unixepoch() WHERE id=(SELECT task_id FROM task_runs WHERE id=?1 AND coordinator=0)
             AND status IN ('running','waiting_approval') AND NOT EXISTS
             (SELECT 1 FROM task_runs r WHERE r.task_id=tasks.id AND r.ended_ms IS NULL)",
            params![run,next],
        )?;
    }
    tx.commit()
}

pub fn recovery(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("UPDATE task_runs SET ended_ms=?1,outcome='interrupted',waiting_permissions=0 WHERE ended_ms IS NULL AND outcome!='queued'", [now()])?;
    tx.execute("UPDATE tasks SET status='ready',updated_at=unixepoch() WHERE status IN ('running','waiting_approval')", [])?;
    tx.commit()
}

pub fn provider_closed(conn: &Connection, provider: &str) -> CmdResult<()> {
    let mut stmt = conn.prepare("SELECT id FROM task_runs WHERE provider=?1 AND ended_ms IS NULL").map_err(err)?;
    let ids = stmt.query_map([provider], |row| row.get(0)).map_err(err)?.collect::<rusqlite::Result<Vec<i64>>>().map_err(err)?;
    drop(stmt);
    for run in ids {
        finish(conn, run, "interrupted").map_err(err)?;
    }
    Ok(())
}

pub fn phase(conn: &Connection, run: i64, phase: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE task_runs SET waiting_permissions=?2 WHERE id=?1 AND ended_ms IS NULL",params![run,phase=="waiting_approval"])?;
    conn.execute(
        "UPDATE tasks SET status=?2,updated_at=unixepoch() WHERE id=
         (SELECT task_id FROM task_runs WHERE id=?1 AND ended_ms IS NULL AND coordinator=0) AND status IN ('running','waiting_approval')",
        params![run,phase],
    )?;
    Ok(())
}

#[derive(Default)]
pub struct Usage {
    pub input: Option<i64>,
    pub cached: Option<i64>,
    pub output: Option<i64>,
    pub cost: Option<f64>,
    pub model: Option<String>,
    pub context: Option<i64>,
}

fn count(value: &Value) -> Option<i64> {
    value.as_i64().filter(|n| *n >= 0)
}

impl Usage {
    pub fn minus(&self, previous: &Self) -> Self {
        let difference = |current: Option<i64>, before: Option<i64>| current.zip(before)
            .and_then(|(current, before)| current.checked_sub(before)).filter(|n| *n >= 0);
        Self { input: difference(self.input, previous.input), cached: difference(self.cached, previous.cached),
            output: difference(self.output, previous.output), ..Self::default() }
    }

    pub fn or(self, fallback: Self) -> Self {
        Self { input: self.input.or(fallback.input), cached: self.cached.or(fallback.cached),
            output: self.output.or(fallback.output), ..self }
    }

    pub fn codex(last: &Value) -> Self {
        Self { input: count(&last["inputTokens"]), cached: count(&last["cachedInputTokens"]),
            output: count(&last["outputTokens"]), ..Self::default() }
    }

    pub fn claude(result: &Value) -> Self {
        let usage = &result["usage"];
        let cached = count(&usage["cache_read_input_tokens"]);
        let input = count(&usage["input_tokens"]).and_then(|n| n.checked_add(count(&usage["cache_creation_input_tokens"]).unwrap_or_default()))
            .and_then(|n| n.checked_add(cached.unwrap_or_default()));
        let model = result["modelUsage"].as_object().filter(|m| m.len() == 1)
            .and_then(|m| m.keys().next()).cloned();
        Self { input, cached, output: count(&usage["output_tokens"]),
            cost: result["total_cost_usd"].as_f64().filter(|n| n.is_finite() && *n >= 0.0), model, context: None }
    }

    pub fn acp(update: &Value) -> Self {
        // usage_update.used mide la ocupación de contexto, no consumo API.
        Self { context: count(&update["used"]), ..Self::default() }
    }
}

pub fn usage(conn: &Connection, run: i64, values: Usage) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE task_runs SET input_tokens=coalesce(?2,input_tokens),cached_input_tokens=coalesce(?3,cached_input_tokens),
         output_tokens=coalesce(?4,output_tokens),cost_estimate_usd=coalesce(?5,cost_estimate_usd),
         model=coalesce(?6,model),context_tokens=coalesce(?7,context_tokens) WHERE id=?1",
        params![run,values.input,values.cached,values.output,values.cost,values.model,values.context],
    )?;
    Ok(())
}

#[derive(Clone, Copy, Default)]
pub struct Quota {
    short: Option<(f64, i64)>,
    long: Option<(f64, i64)>,
}

fn window(value: &Value, key: &str, minutes: Option<i64>, scale: f64) -> Option<(f64, i64)> {
    let percent = value[key].as_f64()? * scale;
    let minutes = minutes.or_else(|| count(&value["windowDurationMins"]))?;
    (percent.is_finite() && percent >= 0.0 && minutes > 0).then_some((percent, minutes))
}

impl Quota {
    pub fn codex(limits: &Value) -> Self {
        Self { short: window(&limits["primary"], "usedPercent", None, 1.0),
            long: window(&limits["secondary"], "usedPercent", None, 1.0) }
    }

    pub fn claude(limits: &Value) -> Self {
        let windows = &limits["unifiedWindows"];
        Self { short: window(&windows["five_hour"], "utilization", Some(300), 100.0),
            long: window(&windows["seven_day"], "utilization", Some(10080), 100.0) }
    }
}

pub fn quota(conn: &Connection, run: i64, snapshot: Quota) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE task_runs SET quota_short_percent=coalesce(?2,quota_short_percent),quota_short_minutes=coalesce(?3,quota_short_minutes),
         quota_long_percent=coalesce(?4,quota_long_percent),quota_long_minutes=coalesce(?5,quota_long_minutes) WHERE id=?1",
        params![run,snapshot.short.map(|w| w.0),snapshot.short.map(|w| w.1),snapshot.long.map(|w| w.0),snapshot.long.map(|w| w.1)],
    )?;
    Ok(())
}

pub fn codex_quota(conn: &Connection, snapshot: Quota) -> rusqlite::Result<()> {
    let mut query = conn.prepare("SELECT id FROM task_runs WHERE provider='codex' AND ended_ms IS NULL")?;
    let rows = query.query_map([], |r| r.get(0))?;
    for row in rows {
        quota(conn, row?, snapshot)?;
    }
    Ok(())
}

pub fn record(app: &AppHandle, update: impl FnOnce(&Connection) -> CmdResult<()>) {
    let state = app.state::<AppState>();
    let result = state.db.lock().map_err(err).and_then(|conn| update(&conn));
    if let Err(error) = result {
        eprintln!("no se pudo registrar el turno: {error}");
    }
    tasks::changed(app);
    wake_queue(app);
}

pub fn on_active(app: &AppHandle, session: i64, update: impl FnOnce(&Connection, i64) -> rusqlite::Result<()>) {
    record(app, |conn| {
        if let Some(run) = active(conn, &session_scope(session))? {
            update(conn, run).map_err(err)?;
        }
        Ok(())
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    error: Option<String>,
    waiting_permissions: u32,
    attempt: Option<i64>,
    prompt: Option<String>,
    result: Option<String>,
    dispatched_ms: Option<i64>,
    id: i64,
    session_id: Option<i64>,
    provider: String,
    model: Option<String>,
    started_ms: i64,
    duration_ms: Option<i64>,
    outcome: String,
    retry: bool,
    input_tokens: Option<i64>,
    cached_input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cost_estimate_usd: Option<f64>,
    quota_short: Option<(f64, i64)>,
    quota_long: Option<(f64, i64)>,
    context_tokens: Option<i64>,
    routing: Option<crate::jev::Trace>,
    memory: Vec<crate::brain::Reference>,
}

const RECENT_FIELDS: &str = "r.id,r.session_id,r.provider,r.model,r.started_ms,max(0,r.ended_ms-r.started_ms),
    r.outcome,r.retry,r.input_tokens,r.cached_input_tokens,r.output_tokens,r.cost_estimate_usd,
    r.quota_short_percent,r.quota_short_minutes,r.quota_long_percent,r.quota_long_minutes,
    r.context_tokens,jev_routes.data,r.attempt,r.prompt,r.result,r.dispatched_ms,r.error,r.waiting_permissions";

fn run_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        error: r.get(22)?, waiting_permissions: r.get(23)?,
        attempt: r.get(18)?, prompt: r.get(19)?, result: r.get(20)?, dispatched_ms: r.get(21)?,
        id: r.get(0)?, session_id: r.get(1)?, provider: r.get(2)?, model: r.get(3)?,
        started_ms: r.get(4)?, duration_ms: r.get(5)?, outcome: r.get(6)?, retry: r.get(7)?,
        input_tokens: r.get(8)?, cached_input_tokens: r.get(9)?, output_tokens: r.get(10)?,
        cost_estimate_usd: r.get(11)?, quota_short: r.get::<_, Option<f64>>(12)?.zip(r.get(13)?),
        quota_long: r.get::<_, Option<f64>>(14)?.zip(r.get(15)?), context_tokens: r.get(16)?,
        routing: r.get::<_, Option<String>>(17)?.and_then(|data| serde_json::from_str(&data).ok()),
        memory: Vec::new(),
    })
}

pub fn recent(conn: &Connection, task: i64) -> rusqlite::Result<Vec<Run>> {
    let mut query = conn.prepare(&format!(
        "SELECT {RECENT_FIELDS}
         FROM task_runs r LEFT JOIN jev_routes ON jev_routes.run_id=r.id
         WHERE r.task_id=?1 ORDER BY r.id DESC LIMIT 30"
    ))?;
    let rows = query.query_map([task], run_row)?;
    rows.map(|row| {
        let mut run = row?;
        run.memory = crate::brain::references(conn, run.id)?;
        Ok(run)
    }).collect()
}

/// Flow renders the latest traces for many tasks at once. Only the detailed
/// task history loads memory citations, which are unused in the graph.
pub fn recent_for_project(conn: &Connection, project: &str) -> rusqlite::Result<HashMap<i64, Vec<Run>>> {
    let mut query = conn.prepare(&format!(
        "SELECT {RECENT_FIELDS},t.id
         FROM tasks t JOIN task_runs r ON r.id IN (
            SELECT candidate.id FROM task_runs candidate WHERE candidate.task_id=t.id AND candidate.project=?1
            ORDER BY candidate.id DESC LIMIT 30
         )
         LEFT JOIN jev_routes ON jev_routes.run_id=r.id
         WHERE t.project=?1 ORDER BY t.id,r.id DESC"
    ))?;
    let mut result: HashMap<i64, Vec<Run>> = HashMap::new();
    let mut rows = query.query([project])?;
    while let Some(row) = rows.next()? {
        result.entry(row.get(24)?).or_default().push(run_row(row)?);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn technical_session(conn: &Connection, project: &str, name: &str) -> i64 {
        let session=crate::db::create_session(conn,project,"claude",name,&[name]).unwrap();
        crate::db::set_session_delegated_by_pm(conn,session.id,None,Some(name)).unwrap();
        session.id
    }

    fn start_prepared(conn: &mut Connection, run: i64, scope: &str, session: Option<i64>, task: Option<i64>) -> CmdResult<i64> {
        let tx=conn.transaction().unwrap();
        let id=begin_prepared(&tx,"/a",scope,"claude",session,task,Some(run))?;
        tx.commit().unwrap();
        Ok(id)
    }

    #[test]
    fn flow_runtime_capacity_counts_sessions_not_tasks_and_excludes_pm() {
        let mut conn=crate::db::open(std::path::Path::new(":memory:")).unwrap();
        conn.execute_batch("INSERT INTO tasks(id,project,title,goal,criteria,priority,risk,status) VALUES(1,'/a','Task','g','c','normal','low','ready');
            INSERT INTO settings(key,value) VALUES('tasks.parallel:/a','2');").unwrap();
        let pm=prepare(&conn,"/a","pm:/a","claude",None,Some(1),"coordinate",true).unwrap();
        start_prepared(&mut conn,pm,"pm:/a",None,Some(1)).unwrap();
        assert_eq!(technical_active(&conn,"/a").unwrap(),0);
        let first=technical_session(&conn,"/a","first");
        let second=technical_session(&conn,"/a","second");
        let unlinked=technical_session(&conn,"/a","unlinked");
        let a=prepare(&conn,"/a",&session_scope(first),"claude",Some(first),Some(1),"a",false).unwrap();
        start_prepared(&mut conn,a,&session_scope(first),Some(first),Some(1)).unwrap();
        let b=prepare(&conn,"/a",&session_scope(second),"claude",Some(second),Some(1),"b",false).unwrap();
        start_prepared(&mut conn,b,&session_scope(second),Some(second),Some(1)).unwrap();
        assert_eq!(technical_active(&conn,"/a").unwrap(),2);
        let c=prepare(&conn,"/a",&session_scope(unlinked),"claude",Some(unlinked),None,"  preserve me\n",false).unwrap();
        assert!(start_prepared(&mut conn,c,&session_scope(unlinked),Some(unlinked),None).unwrap_err().contains("límite"));
        fail_start(&conn,c,"límite").unwrap();
        assert_eq!(technical_active(&conn,"/a").unwrap(),2);
        finish(&conn,a,"completed").unwrap();
        assert_eq!(technical_active(&conn,"/a").unwrap(),1);
        let retry=prepare(&conn,"/a",&session_scope(unlinked),"claude",Some(unlinked),None,"retry",false).unwrap();
        start_prepared(&mut conn,retry,&session_scope(unlinked),Some(unlinked),None).unwrap();
        assert_eq!(technical_active(&conn,"/a").unwrap(),2);
        finish(&conn,pm,"completed").unwrap();
        assert_eq!(technical_active(&conn,"/a").unwrap(),2);
    }

    #[test]
    fn flow_runtime_preparation_preserves_failure_prompt_attempt_and_project_boundary() {
        let mut conn=crate::db::open(std::path::Path::new(":memory:")).unwrap();
        let session=technical_session(&conn,"/a","agent");
        let prompt="  exact literal\n\nwith trailing space  ";
        let run=prepare(&conn,"/a",&session_scope(session),"claude",Some(session),None,prompt,false).unwrap();
        assert!(prepare(&conn,"/a",&session_scope(session),"claude",Some(session),None,prompt,false).is_err());
        assert!(prepare(&conn,"/b","foreign","claude",Some(session),None,prompt,false).is_err());
        fail_start(&conn,run,"provider missing before begin").unwrap();
        fail_start(&conn,run,"duplicate failure").unwrap();
        let row:(String,String,i64,Option<i64>)=conn.query_row("SELECT prompt,error,attempt,dispatched_ms FROM task_runs WHERE id=?1",[run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(row,(prompt.into(),"provider missing before begin".into(),1,None));
        let run=prepare(&conn,"/a",&session_scope(session),"claude",Some(session),None,prompt,false).unwrap();
        start_prepared(&mut conn,run,"provider-thread",Some(session),None).unwrap();
        assert!(start_prepared(&mut conn,run,"provider-thread",Some(session),None).is_err());
        result(&conn,run,Some("final result"),None).unwrap();
        finish(&conn,run,"completed").unwrap();
        finish(&conn,run,"failed").unwrap();
        result(&conn,run,Some("late duplicate"),Some("late error")).unwrap();
        let row:(String,String,i64,bool)=conn.query_row("SELECT result,outcome,attempt,dispatched_ms IS NOT NULL FROM task_runs WHERE id=?1",[run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(row,("final result".into(),"completed".into(),2,true));
        let third=prepare(&conn,"/a",&session_scope(session),"claude",Some(session),None,"third",false).unwrap();
        assert_eq!(conn.query_row("SELECT attempt FROM task_runs WHERE id=?1",[third],|r|r.get::<_,i64>(0)).unwrap(),3);
    }

    #[test]
    fn flow_runtime_permissions_finish_and_restart_never_leave_waiting() {
        let file=std::env::temp_dir().join(format!("flow-runtime-{}.sqlite",uuid::Uuid::new_v4()));
        let mut conn=crate::db::open(&file).unwrap();
        conn.execute_batch("INSERT INTO tasks(id,project,title,goal,criteria,priority,risk,status) VALUES(1,'/a','Task','g','c','normal','low','ready');").unwrap();
        let session=technical_session(&conn,"/a","agent");
        let run=prepare(&conn,"/a",&session_scope(session),"claude",Some(session),Some(1),"prompt",false).unwrap();
        start_prepared(&mut conn,run,&session_scope(session),Some(session),Some(1)).unwrap();
        phase(&conn,run,"waiting_approval").unwrap();
        let snapshot=serde_json::to_value(tasks::list(&conn,"/a").unwrap()).unwrap();
        assert_eq!(snapshot[0]["phase"],"waiting_permission");
        phase(&conn,run,"running").unwrap();
        assert_eq!(serde_json::to_value(tasks::list(&conn,"/a").unwrap()).unwrap()[0]["phase"],"running");
        append_result(&conn,run,"durable ").unwrap(); append_result(&conn,run,"result").unwrap();
        phase(&conn,run,"waiting_approval").unwrap();
        finish(&conn,run,"completed").unwrap();
        phase(&conn,run,"waiting_approval").unwrap();
        assert_eq!(serde_json::to_value(tasks::list(&conn,"/a").unwrap()).unwrap()[0]["phase"],"verifying");
        let next=prepare(&conn,"/a",&session_scope(session),"claude",Some(session),Some(1),"next",false).unwrap();
        start_prepared(&mut conn,next,&session_scope(session),Some(session),Some(1)).unwrap();
        phase(&conn,next,"waiting_approval").unwrap();
        drop(conn);
        let conn=crate::db::open(&file).unwrap(); recovery(&conn).unwrap(); recovery(&conn).unwrap();
        let runs=recent(&conn,1).unwrap();
        assert_eq!(runs[0].outcome,"interrupted"); assert_eq!(runs[0].waiting_permissions,0);
        assert_eq!(runs[1].result.as_deref(),Some("durable result"));
        assert_eq!(serde_json::to_value(tasks::list(&conn,"/a").unwrap()).unwrap()[0]["phase"],"interrupted");
        assert_eq!(technical_active(&conn,"/a").unwrap(),0);
        let cancelled=prepare(&conn,"/a",&session_scope(session),"claude",Some(session),Some(1),"cancel",false).unwrap();
        let tx=conn.unchecked_transaction().unwrap();
        begin_prepared(&tx,"/a",&session_scope(session),"claude",Some(session),Some(1),Some(cancelled)).unwrap(); tx.commit().unwrap();
        phase(&conn,cancelled,"waiting_approval").unwrap();
        finish(&conn,cancelled,"cancelled").unwrap(); finish(&conn,cancelled,"completed").unwrap();
        assert_eq!(serde_json::to_value(tasks::list(&conn,"/a").unwrap()).unwrap()[0]["phase"],"cancelled");
        assert_eq!(recent(&conn,1).unwrap()[0].waiting_permissions,0);
        assert_eq!(technical_active(&conn,"/a").unwrap(),0);
        drop(conn); std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn flow_runtime_legacy_coordinators_do_not_consume_technical_capacity() {
        let conn=crate::db::open(std::path::Path::new(":memory:")).unwrap();
        conn.execute_batch("INSERT INTO projects(path,coordinator_thread) VALUES('/a','pm-thread');
            INSERT INTO task_runs(scope,project,provider,started_ms,retry) VALUES('pm-thread','/a','codex',1,0);").unwrap();
        let pm=technical_session(&conn,"/a","pm");
        conn.execute("INSERT INTO project_manager_claude(project,session_id,active) VALUES('/a',?1,1)",[pm]).unwrap();
        conn.execute("INSERT INTO task_runs(scope,project,provider,started_ms,retry) VALUES(?1,'/a','claude',1,0)",[session_scope(pm)]).unwrap();
        assert_eq!(technical_active(&conn,"/a").unwrap(),0);
        conn.execute_batch("INSERT INTO task_runs(scope,project,provider,started_ms,retry) VALUES('unlinked-tech','/a','codex',1,0);").unwrap();
        assert_eq!(technical_active(&conn,"/a").unwrap(),1);
    }

    #[test]
    fn flow_queue_claims_same_attempt_after_capacity_and_dependencies_and_restart() {
        let mut conn=crate::db::open(std::path::Path::new(":memory:")).unwrap();
        conn.execute_batch("INSERT INTO tasks(id,project,title,goal,criteria,priority,risk,status) VALUES(1,'/a','a','g','c','normal','low','ready'),(2,'/a','b','g','c','high','low','ready');
            INSERT INTO task_dependencies VALUES(2,1); INSERT INTO settings(key,value) VALUES('tasks.parallel:/a','1');").unwrap();
        let a=technical_session(&conn,"/a","a");let b=technical_session(&conn,"/a","b");
        let first=prepare(&conn,"/a",&session_scope(a),"claude",Some(a),Some(1),"first",false).unwrap();
        start_prepared(&mut conn,first,&session_scope(a),Some(a),Some(1)).unwrap();
        let queued=prepare(&conn,"/a",&session_scope(b),"claude",Some(b),Some(2)," exact queued ",false).unwrap();
        conn.execute("UPDATE task_runs SET outcome='queued' WHERE id=?1",[queued]).unwrap();
        assert!(claim_queued(&conn).unwrap().is_none());
        finish(&conn,first,"completed").unwrap();assert!(claim_queued(&conn).unwrap().is_none());
        recovery(&conn).unwrap();
        assert_eq!(conn.query_row("SELECT outcome FROM task_runs WHERE id=?1",[queued],|r|r.get::<_,String>(0)).unwrap(),"queued");
        conn.execute("UPDATE tasks SET status='done' WHERE id=1",[]).unwrap();
        let claim=claim_queued(&conn).unwrap().unwrap();assert_eq!(claim.0,queued);assert_eq!(claim.2," exact queued ");
        assert!(claim_queued(&conn).unwrap().is_none());
        start_prepared(&mut conn,queued,&session_scope(b),Some(b),Some(2)).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM task_runs WHERE session_id=?1",[b],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn flow_run_metadata_roundtrips_in_detail_and_project_queries() {
        let conn = crate::db::open(std::path::Path::new(":memory:")).unwrap();
        conn.execute_batch("INSERT INTO tasks(id,project,title,goal,criteria,priority,risk,status)
            VALUES(1,'/a','Task','Goal','Criteria','normal','low','verifying');
            INSERT INTO task_runs(task_id,scope,project,provider,started_ms,ended_ms,retry,outcome,attempt,prompt,result,dispatched_ms)
            VALUES(1,'session:1','/a','claude',100,200,0,'completed',2,'  exact prompt  ','verified result',110);").unwrap();
        for run in [recent(&conn, 1).unwrap().remove(0), recent_for_project(&conn, "/a").unwrap().remove(&1).unwrap().remove(0)] {
            assert_eq!(run.attempt, Some(2));
            assert_eq!(run.prompt.as_deref(), Some("  exact prompt  "));
            assert_eq!(run.result.as_deref(), Some("verified result"));
            assert_eq!(run.dispatched_ms, Some(110));
            let json = serde_json::to_value(run).unwrap();
            assert_eq!(json["dispatchedMs"], 110);
        }
        assert!(recent_for_project(&conn, "/b").unwrap().is_empty());
        assert!(conn.execute("UPDATE task_runs SET attempt=0", []).is_err());
    }

    #[test]
    fn recent_project_runs_keep_the_latest_thirty_for_each_task() {
        let conn = crate::db::open(std::path::Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "INSERT INTO tasks(id,project,title,goal,criteria,priority,risk,status) VALUES
              (1,'/a','Uno','','','normal','normal','ready'),
              (2,'/a','Dos','','','normal','normal','ready'),
              (3,'/b','Tres','','','normal','normal','ready'),
              (4,'/a','Sin ejecuciones','','','normal','normal','ready');
             WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<35)
             INSERT INTO task_runs(id,task_id,scope,project,provider,started_ms,ended_ms,retry)
              SELECT i,1,'fixture','/a','codex',i,i+1,0 FROM seq;
             INSERT INTO task_runs(id,task_id,scope,project,provider,started_ms,ended_ms,retry) VALUES
              (36,2,'fixture','/a','claude',36,37,0),
              (37,3,'fixture','/b','codex',37,38,0);",
        ).unwrap();

        let latest = recent_for_project(&conn, "/a").unwrap();
        assert_eq!(latest.len(), 2);
        assert_eq!(latest[&1].iter().map(|run| run.id).collect::<Vec<_>>(), (6..=35).rev().collect::<Vec<_>>());
        assert_eq!(latest[&2][0].id, 36);
    }

    #[test]
    fn observed_tokens_keep_provider_semantics_and_absence() {
        let usage = Usage::claude(&json!({
            "usage": {"input_tokens": 9, "cache_creation_input_tokens": 7, "cache_read_input_tokens": 80, "output_tokens": 8},
            "total_cost_usd": 0.01, "modelUsage": {"provider-model": {}}
        }));
        assert_eq!((usage.input, usage.cached, usage.output, usage.cost), (Some(96), Some(80), Some(8), Some(0.01)));
        assert_eq!(usage.model.as_deref(), Some("provider-model"));
        assert_eq!(Usage::claude(&Value::Null).input, None);
        let acp = Usage::acp(&json!({"used": 100, "size": 1000}));
        assert_eq!((acp.context, acp.input, acp.cost), (Some(100), None, None));
        assert_eq!(Quota::codex(&json!({"primary":{"usedPercent":0,"windowDurationMins":300}})).short, Some((0.0, 300)));
        assert_eq!(Quota::claude(&json!({"unifiedWindows":{"seven_day":{"utilization":0.25}}})).long, Some((25.0, 10080)));
        assert_eq!(Quota::claude(&Value::Null).long, None);
    }
}


/// Text delegation queue. The same task_run is claimed and dispatched exactly once.
pub fn enqueue_session(app: &AppHandle, session: i64, prompt: String, effort: Option<String>) -> CmdResult<i64> {
    let state=app.state::<AppState>();
    let run={
        let mut conn=state.db.lock().map_err(err)?;
        let s=crate::db::session(&conn,session).map_err(err)?.ok_or("sesión cerrada")?;
        if crate::chat::is_pm(&conn,session).map_err(err)? {return Err("usa el envío del coordinador para el PM".into());}
        let task=match tasks::linked(&conn,session).map_err(err)? {Some(task)=>task,None=>{
            let title=prompt.lines().find(|l|!l.trim().is_empty()).unwrap_or("Encargo").chars().take(110).collect::<String>();
            let task=tasks::delegation(&mut conn,&s.project,None,&title,&prompt,&prompt,&s.engine,"senior")?;
            tasks::link(&conn,&s.project,task,session)?;task
        }};
        let run=prepare(&conn,&s.project,&session_scope(session),&s.engine,Some(session),Some(task),&prompt,false)?;
        conn.execute("UPDATE task_runs SET outcome='queued',queue_effort=?2 WHERE id=?1",rusqlite::params![run,effort]).map_err(err)?;
        run
    };
    tasks::changed(app); wake_queue(app); Ok(run)
}

/// Intento reclamado: (run, sesión, prompt literal, esfuerzo).
pub type QueueClaim = (i64, i64, String, Option<String>);

pub fn claim_queued(conn: &Connection) -> CmdResult<Option<QueueClaim>> {
    let mut q=conn.prepare("SELECT r.id,r.session_id,r.prompt,r.queue_effort,r.project,r.task_id FROM task_runs r JOIN tasks t ON t.id=r.task_id JOIN sessions s ON s.id=r.session_id
        WHERE r.outcome='queued' AND r.ended_ms IS NULL AND s.closed=0 AND t.status NOT IN ('blocked','done','cancelled','backlog')
        AND NOT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id=d.requires_id WHERE d.task_id=t.id AND dep.status!='done')
        ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,r.id").map_err(err)?;
    let mut rows=q.query([]).map_err(err)?;
    while let Some(row)=rows.next().map_err(err)? {
        let project:String=row.get(4).map_err(err)?;
        if technical_active(conn,&project).map_err(err)? >= tasks::parallel_limit(conn,&project).map_err(err)? {continue;}
        let id:i64=row.get(0).map_err(err)?;
        if conn.execute("UPDATE task_runs SET outcome='preparing' WHERE id=?1 AND outcome='queued' AND ended_ms IS NULL",[id]).map_err(err)?==1 {
            return Ok(Some((id,row.get(1).map_err(err)?,row.get(2).map_err(err)?,row.get(3).map_err(err)?)));
        }
    }
    Ok(None)
}

pub fn wake_queue(app: &AppHandle) {
    let queued=app.state::<AppState>().db.lock().ok().and_then(|conn|conn.query_row("SELECT EXISTS(SELECT 1 FROM task_runs WHERE outcome='queued' AND ended_ms IS NULL)",[],|r|r.get::<_,bool>(0)).ok()).unwrap_or(false);
    if !queued {return;}
    let app=app.clone();
    std::thread::spawn(move || {
        let state=app.state::<AppState>();
        let Ok(_worker)=state.flow_dispatch.lock() else {return};
        loop {
            let next=state.db.lock().map_err(err).and_then(|conn|claim_queued(&conn));
            let (run,id,prompt,effort)=match next {Ok(Some(next))=>next,Ok(None)=>break,Err(e)=>{eprintln!("cola Flow: {e}");break}};
            let result=(|| {
                let session=crate::claude::open_session(&state,id)?;
                let message=crate::attachments::Message::text(prompt);
                if session.engine=="codex" {
                    let task=tasks::linked(&*state.db.lock().map_err(err)?,id).map_err(err)?;
                    crate::codex::send_prepared(&app,&session.project,Some(&session),task,message,effort,run)
                } else {crate::claude::send_prepared_content(&app,id,message,effort,Vec::new(),None,None,run)}
            })();
            if let Err(error)=result {record(&app,|conn|fail_start(conn,run,&error).map_err(err));}
            tasks::changed(&app);
        }
    });
}

#[tauri::command]
pub fn flow_enqueue(app: AppHandle, project: String, session: i64, prompt: String, effort: Option<String>) -> CmdResult<i64> {
    {let state=app.state::<AppState>();let conn=state.db.lock().map_err(err)?;
     let project=crate::workspace::project_path(&conn,&project)?;
     if !crate::db::session(&conn,session).map_err(err)?.is_some_and(|s|s.project==project) {return Err("sesión fuera del proyecto".into());}}
    enqueue_session(&app,session,prompt,effort)
}

#[tauri::command]
pub fn flow_cancel_run(app: AppHandle, project: String, run: i64) -> CmdResult<()> {
    let state=app.state::<AppState>();
    let (provider,scope,session,outcome)={let conn=state.db.lock().map_err(err)?;
        let project=crate::workspace::project_path(&conn,&project)?;
        conn.query_row("SELECT provider,scope,session_id,outcome FROM task_runs WHERE id=?1 AND project=?2 AND ended_ms IS NULL",params![run,project],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<i64>>(2)?,r.get::<_,String>(3)?))).optional().map_err(err)?.ok_or("intento no activo o ajeno")?};
    if outcome=="queued" {record(&app,|conn|finish(conn,run,"cancelled").map_err(err));return Ok(());}
    if outcome=="preparing" {return Err("el intento está arrancando; espera la confirmación de despacho".into());}
    if provider=="codex" {crate::codex::interrupt(&app,&scope)} else {
        let id=session.or_else(||scope.strip_prefix("session:").and_then(|s|s.parse().ok())).ok_or("falta identidad de sesión")?;
        if provider=="claude" {state.claude.interrupt(id)} else {state.acp.interrupt(id)}
    }
}
