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
    )
}

pub fn session_scope(id: i64) -> String {
    format!("session:{id}")
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

pub fn begin(tx: &rusqlite::Transaction<'_>, project: &str, scope: &str, provider: &str, session: Option<i64>, task: Option<i64>) -> CmdResult<i64> {
    if crate::updates::INSTALLING.load(std::sync::atomic::Ordering::SeqCst) { return Err("instalando actualización".into()); }
    if active(tx, scope)?.is_some() || session.map(|id| session_active(tx, id)).transpose().map_err(err)?.unwrap_or(false) {
        return Err("ya hay un turno en marcha".into());
    }
    crate::work::before_turn(tx, project, session)?;
    if let Some(id) = task {
        tasks::validate_start(tx, project, id)?;
        let active: u32 = tx.query_row(
            "SELECT count(DISTINCT task_id) FROM task_runs WHERE project=?1 AND task_id!=?2 AND ended_ms IS NULL",
            params![project,id], |r| r.get(0),
        ).map_err(err)?;
        if !task_active(tx, id).map_err(err)? && active >= tasks::parallel_limit(tx, project).map_err(err)? {
            return Err("se alcanzó el límite de tareas en paralelo".into());
        }
    }
    let previous = tx.query_row("SELECT outcome FROM task_runs WHERE scope=?1 AND task_id IS ?2 ORDER BY id DESC LIMIT 1",
        params![scope,task], |r| r.get::<_, String>(0)).optional().map_err(err)?;
    let retry = matches!(previous.as_deref(), Some("failed" | "interrupted" | "paused_quota"));
    tx.execute(
        "INSERT INTO task_runs(project,scope,provider,session_id,task_id,started_ms,retry)
         VALUES(?1,?2,?3,?4,?5,?6,?7)", params![project,scope,provider,session,task,now(),retry],
    ).map_err(err)?;
    let id = tx.last_insert_rowid();
    if let Some(session) = session {
        tx.execute("INSERT INTO jev_routes(run_id,data) SELECT ?1,data FROM jev_delegations WHERE session_id=?2", params![id,session]).map_err(err)?;
        tx.execute("DELETE FROM jev_delegations WHERE session_id=?1", [session]).map_err(err)?;
    }
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
    if tx.execute("UPDATE task_runs SET ended_ms=?2,outcome=?3 WHERE id=?1 AND ended_ms IS NULL",
        params![run,now(),outcome])? > 0
    {
        let next = match outcome {
            "completed" => {
                tx.execute("UPDATE sessions SET handoff_context=NULL WHERE handoff_context IS NOT NULL
                    AND id=(SELECT session_id FROM task_runs WHERE id=?1)", [run])?;
                "verifying"
            }
            "paused_quota" => "paused_quota",
            "cancelled" | "interrupted" => "ready",
            _ => "failed",
        };
        tx.execute(
            "UPDATE tasks SET status=?2,updated_at=unixepoch() WHERE id=(SELECT task_id FROM task_runs WHERE id=?1)
             AND status IN ('running','waiting_approval') AND NOT EXISTS
             (SELECT 1 FROM task_runs r WHERE r.task_id=tasks.id AND r.ended_ms IS NULL)",
            params![run,next],
        )?;
    }
    tx.commit()
}

pub fn recovery(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("UPDATE task_runs SET ended_ms=?1,outcome='interrupted' WHERE ended_ms IS NULL", [now()])?;
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
    conn.execute(
        "UPDATE tasks SET status=?2,updated_at=unixepoch() WHERE id=
         (SELECT task_id FROM task_runs WHERE id=?1 AND ended_ms IS NULL) AND status IN ('running','waiting_approval')",
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
    r.context_tokens,jev_routes.data";

fn run_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
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
        result.entry(row.get(18)?).or_default().push(run_row(row)?);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
