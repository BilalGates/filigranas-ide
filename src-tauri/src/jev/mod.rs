//! Opt-in routing for automatic task turns of the existing Codex coordinator.
mod credential;
pub mod delegation;
mod typesafe;

use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::{db, err, AppState, CmdResult};
use typesafe::Failure;

// Changing the data disclosed to TypeSafe requires a new consent setting.
const SETTING: &str = "jev.routing.v2";
const DAILY_ATTEMPTS: u32 = 100;
const EFFORTS: [&str; 3] = ["low", "medium", "high"];

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "snake_case")]
enum Mode {
    #[default]
    Local,
    Active,
    Shadow,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "snake_case")]
enum Policy {
    Economy,
    #[default]
    Balanced,
    Quality,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    mode: Mode,
    policy: Policy,
    timeout_secs: u32,
    model: Option<String>,
    light_model: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { mode: Mode::Local, policy: Policy::Balanced, timeout_secs: 3, model: None, light_model: None }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    mode: Mode,
    policy: Policy,
    timeout_secs: u32,
    consent: bool,
    light_model: Option<String>,
}

#[derive(Serialize)]
pub struct Status {
    settings: Settings,
    supported: bool,
    service: &'static str,
    account: &'static str,
    #[serde(rename = "codexModels")]
    codex_models: Vec<String>,
    credential: &'static str,
}

impl Status {
    fn new(settings: Settings, codex_models: Vec<String>) -> Self {
        Self {
            settings, supported: cfg!(any(target_os = "macos", windows)),
            service: credential::SERVICE, account: credential::ACCOUNT,
            codex_models,
            credential: if credential::read(false).is_some() { "available" } else { "missing_or_locked" },
        }
    }
}

fn settings(conn: &Connection) -> rusqlite::Result<Settings> {
    Ok(db::get_setting(conn, SETTING)?.and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .filter(|s| (1..=10).contains(&s.timeout_secs)).unwrap_or_default())
}

#[tauri::command]
pub fn jev_status(state: State<AppState>) -> CmdResult<Status> {
    let saved = settings(&*state.db.lock().map_err(err)?).map_err(err)?;
    Ok(Status::new(saved, state.codex.jev_models()?))
}

#[tauri::command]
pub async fn jev_credential_set(app: AppHandle, key: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.jev_gate.lock().map_err(err)?;
        credential::save(key.trim())
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn jev_credential_delete(app: AppHandle) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.jev_gate.lock().map_err(err)?;
        credential::delete()?;
        let mut saved = settings(&*state.db.lock().map_err(err)?).map_err(err)?;
        saved.mode = Mode::Local;
        saved.model = None;
        let conn = state.db.lock().map_err(err)?;
        db::set_setting(&conn, SETTING, &serde_json::to_string(&saved).map_err(err)?).map_err(err)
    }).await.map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest { authenticated: bool, model: Option<String>, duration_ms: u64, error: Option<&'static str> }

#[tauri::command]
pub async fn jev_test_connection() -> CmdResult<ConnectionTest> {
    tauri::async_runtime::spawn_blocking(|| {
        let started = std::time::Instant::now();
        let result = credential::read(true).ok_or(Failure::Credential).and_then(|key| typesafe::models(&key, 10));
        let (authenticated, model, error) = match result {
            Ok(value) => (true, select_model(&value), None),
            Err(failure) => (false, None, Some(failure.code())),
        };
        Ok(ConnectionTest { authenticated, model, error, duration_ms: started.elapsed().as_millis() as u64 })
    }).await.map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statusbar {
    mode: Mode,
    used: u32,
    limit: u32,
}

#[tauri::command]
pub fn jev_statusbar(state: State<AppState>) -> CmdResult<Statusbar> {
    let conn = state.db.lock().map_err(err)?;
    let mode = settings(&conn).map_err(err)?.mode;
    let used = attempt_count(&conn).map_err(err)?;
    Ok(Statusbar { mode, used, limit: DAILY_ATTEMPTS })
}

fn select_model(value: &Value) -> Option<String> {
    let models = value["models"].as_array()?;
    let mut names = models.iter().filter_map(|entry| entry["name"].as_str())
        .filter(|name| valid_model(name));
    names.clone().find(|name| name.ends_with("-latest"))
        .or_else(|| names.find(|name| !name.ends_with("-preview"))).map(str::to_owned)
}

fn valid_model(name: &str) -> bool {
    let Some(version) = name.strip_prefix("jev-") else { return false };
    matches!(version, "latest" | "preview") || (
        version.len() <= 24 && version.split('.').count() == 3
            && version.split('.').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    )
}

fn configure(change: Change, discover: impl FnOnce(u32) -> Result<Value, Failure>) -> CmdResult<Settings> {
    if !(1..=10).contains(&change.timeout_secs) {
        return Err("El plazo debe estar entre 1 y 10 segundos".into());
    }
    let model = match change.mode {
        Mode::Local => None,
        _ if !change.consent => return Err("Autoriza el envío de metadatos a TypeSafe para activar Jev".into()),
        _ => {
            let catalog = discover(change.timeout_secs).map_err(|e| match e {
                Failure::Credential | Failure::Http(401 | 403) => "Añade una clave válida de TypeSafe al almacén del sistema y permite su lectura",
                Failure::Timeout => "TypeSafe no respondió dentro del plazo",
                Failure::RateLimit => "TypeSafe alcanzó su límite de peticiones",
                _ => "No se pudo consultar el catálogo de TypeSafe",
            })?;
            Some(select_model(&catalog).ok_or("El catálogo de TypeSafe no ofrece un modelo Jev estable")?)
        }
    };
    let light_model = change.light_model.filter(|id| !id.is_empty() && id.len() <= 128);
    Ok(Settings { mode: change.mode, policy: change.policy, timeout_secs: change.timeout_secs, model, light_model })
}

#[tauri::command]
pub async fn jev_configure(app: AppHandle, change: Change) -> CmdResult<Status> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.jev_gate.lock().map_err(err)?;
        let settings = configure(change, |timeout| {
            let key = credential::read(true).ok_or(Failure::Credential)?;
            typesafe::models(&key, timeout)
        })?;
        db::set_setting(&*state.db.lock().map_err(err)?, SETTING, &serde_json::to_string(&settings).map_err(err)?).map_err(err)?;
        Ok(Status::new(settings, state.codex.jev_models()?))
    }).await.map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevUsage {
    tokens: i64,
    cost_usd: Option<f64>,
}

fn totals(conn: &Connection) -> rusqlite::Result<JevUsage> {
    conn.query_row(
        "WITH usage AS (
           SELECT json_extract(data, '$.inputTokens') AS input,
                  json_extract(data, '$.outputTokens') AS output,
                  json_extract(data, '$.costEstimateUsd') AS cost,
                  json_extract(data, '$.model') AS model
           FROM jev_routes
         )
         SELECT coalesce(sum(coalesce(input,0) + coalesce(output,0)),0),
                CASE WHEN count(*) FILTER (WHERE cost IS NULL) = 0
                     THEN coalesce(sum(cost),0.0) END
         FROM usage WHERE input IS NOT NULL OR output IS NOT NULL OR model IS NOT NULL",
        [],
        |row| Ok(JevUsage { tokens: row.get(0)?, cost_usd: row.get(1)? }),
    )
}

#[tauri::command]
pub fn jev_usage(state: State<AppState>) -> CmdResult<JevUsage> {
    let conn = state.db.lock().map_err(err)?;
    totals(&conn).map_err(err)
}

fn usd_per_euro(xml: &str) -> Option<f64> {
    let usd = xml.split("<Cube").filter_map(|part| part.split_once('>').map(|(attrs, _)| attrs))
        .find(|attrs| attrs.contains("currency='USD'") || attrs.contains(r#"currency="USD""#))?;
    let rate = usd.split_once("rate=")?.1;
    let quote = rate.chars().next()?;
    if !matches!(quote, '\'' | '"') {
        return None;
    }
    rate[1..].split_once(quote)?.0.parse::<f64>().ok().filter(|rate| rate.is_finite() && *rate > 0.0)
}

#[tauri::command]
pub async fn jev_euro_rate() -> CmdResult<f64> {
    tauri::async_runtime::spawn_blocking(|| {
        let result = typesafe::curl_command().args([
            "--disable", "--proto", "=https", "--fail", "--silent", "--max-time", "5",
            "--max-filesize", "16384", "--url", "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
        ]).output().map_err(err)?;
        if !result.status.success() {
            return Err("Cambio del BCE no disponible".into());
        }
        usd_per_euro(&String::from_utf8_lossy(&result.stdout)).ok_or_else(|| "Cambio del BCE no disponible".into())
    }).await.map_err(err)?
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS jev_delegations (session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS jev_attempts (at INTEGER NOT NULL DEFAULT (unixepoch()));
         CREATE INDEX IF NOT EXISTS jev_attempts_at ON jev_attempts(at);
         CREATE TABLE IF NOT EXISTS jev_ambiguous_runs (
           run_id INTEGER PRIMARY KEY REFERENCES task_runs(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS jev_codex_baselines (
           thread TEXT PRIMARY KEY, model TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS jev_routes (
           run_id INTEGER PRIMARY KEY REFERENCES task_runs(id) ON DELETE CASCADE,
           data TEXT NOT NULL
         );",
    )
}

fn attempt_count(conn: &Connection) -> rusqlite::Result<u32> {
    conn.query_row("SELECT count(*) FROM jev_attempts WHERE at > unixepoch()-86400", [], |r| r.get(0))
}

fn reserve(db: &Mutex<Connection>) -> CmdResult<bool> {
    let mut conn = db.lock().map_err(err)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(err)?;
    tx.execute("DELETE FROM jev_attempts WHERE at <= unixepoch()-86400", []).map_err(err)?;
    let count = attempt_count(&tx).map_err(err)?;
    let available = count < DAILY_ATTEMPTS;
    if available {
        tx.execute("INSERT INTO jev_attempts DEFAULT VALUES", []).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(available)
}

struct Signals {
    risk: &'static str,
    priority: &'static str,
    scope: &'static str,
    history: &'static str,
    ambiguous_failure: bool,
}

impl Signals {
    fn for_run(conn: &Connection, run: i64) -> rusqlite::Result<Self> {
        // Read categorical signals only. Transmit neither identifiers nor free text.
        conn.query_row(
            "SELECT t.risk,t.priority,length(t.goal)+length(t.criteria),previous.outcome,
             EXISTS(SELECT 1 FROM jev_ambiguous_runs e WHERE e.run_id=previous.id)
             FROM tasks t JOIN task_runs r ON r.task_id=t.id
             LEFT JOIN task_runs previous ON previous.id=(
                 SELECT p.id FROM task_runs p WHERE p.task_id=r.task_id AND p.scope=r.scope AND p.id<r.id
                 ORDER BY p.id DESC LIMIT 1
             ) WHERE r.id=?1",
            [run],
            |row| {
                let risk = match row.get::<_, String>(0)?.as_str() {
                    "low" => "low", "normal" => "normal", "high" => "high", _ => "critical",
                };
                let priority = match row.get::<_, String>(1)?.as_str() {
                    "low" => "low", "high" => "high", "urgent" => "urgent", _ => "normal",
                };
                let scope = match row.get::<_, i64>(2)? { 0..=400 => "small", 401..=1500 => "medium", _ => "large" };
                let history = match row.get::<_, Option<String>>(3)?.as_deref() {
                    Some("completed") => "completed",
                    Some("failed" | "interrupted" | "cancelled" | "paused_quota") => "incomplete",
                    _ => "fresh",
                };
                Ok(Self { risk, priority, scope, history, ambiguous_failure: row.get(4)? })
            },
        )
    }

    fn floor(&self, policy: Policy) -> usize {
        if matches!(self.risk, "high" | "critical") || policy == Policy::Quality {
            2
        } else if self.risk == "normal" || self.scope == "large" || self.ambiguous_failure
            || matches!(self.priority, "high" | "urgent") {
            1
        } else {
            0
        }
    }
}

pub fn mark_ambiguous(conn: &Connection, run: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO jev_ambiguous_runs(run_id)
         SELECT id FROM task_runs WHERE id=?1 AND task_id IS NOT NULL AND session_id IS NULL AND outcome='failed'",
        [run],
    )?;
    Ok(())
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    source: String,
    reason: Option<String>,
    pub effort: Option<String>,
    recommended_effort: Option<String>,
    confidence: Option<f64>,
    model: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cost_estimate_usd: Option<f64>,
    duration_ms: Option<u64>,
    complexity: Option<String>,
    review: Option<String>,
    context: Option<String>,
    event_advice: Option<String>,
    lightweight: bool,
    pub execution_model: Option<String>,
    #[serde(default)]
    pub execution_provider: Option<String>,
    #[serde(default)]
    api_attempted: bool,
    #[serde(default)]
    http_status: Option<u16>,
    #[serde(default)]
    endpoint: Option<String>,
}

fn best_effort(available: &[String], target: usize, floor: usize) -> Option<String> {
    // A missing tier may be replaced by a supported higher effort. When the
    // model cannot meet the floor, leave the model's native default in charge.
    (floor..EFFORTS.len()).filter(|&i| available.iter().any(|e| e == EFFORTS[i]))
        .min_by_key(|&i| (i.abs_diff(target), i < target)).map(|i| EFFORTS[i].into())
        .or_else(|| available.iter().find(|e| e.as_str() == "xhigh").cloned())
        .or_else(|| available.iter().find(|e| e.as_str() == "max").cloned())
}

fn request_body(model: &str, settings: &Settings, signals: &Signals, available: &[String], lightweight: bool) -> Value {
    let mut body = json!({
        "model": model,
        "state": {
            "risk": signals.risk, "priority": signals.priority, "scope": signals.scope,
            "policy": settings.policy, "available_efforts": available,
            "history": signals.history, "ambiguous_failure": signals.ambiguous_failure,
            "lightweight_available": lightweight
        },
        "questions": {
            "route": {
                "type": "choice",
                "instructions": "Choose the lowest available Codex reasoning effort sufficient for this software task. Scope is a rough size bucket. Quality and risk take precedence over economy.",
                "criteria": {
                    "low": "Small, low-risk work with a straightforward outcome.",
                    "medium": "Routine implementation or review with moderate scope or risk.",
                    "high": "Large, high-risk or critical work, or a quality-first policy."
                }
            },
            "complexity": {
                "type": "choice",
                "instructions": "Classify the estimated complexity using risk and scope only.",
                "criteria": { "simple": "Small and low risk.", "standard": "Routine scope.", "complex": "Large or high risk.", "critical": "Critical risk." }
            },
            "review": {
                "type": "choice",
                "instructions": "Recommend a review level. Critical or high-risk work requires independent review.",
                "criteria": { "standard": "Usual local validation.", "independent": "Additional review by a different reviewer." }
            },
            "context": {
                "type": "choice",
                "instructions": "Recommend the best way for the IDE to prepare context. This is advisory.",
                "criteria": {
                    "reuse": "Use the current thread context, including for a first turn if appropriate.",
                    "recover": "Recover relevant files and previous evidence before continuing.",
                    "summarize": "Ask the local coordinator to summarize a large, established context.",
                    "handoff": "Prepare a relay for a complex interrupted task."
                }
            },
        }
    });
    if signals.ambiguous_failure {
        body["questions"]["event"] = json!({
            "type": "choice",
            "instructions": "A previous turn failed without an identified cause. Recommend triage without assuming permissions or automatic retries.",
            "criteria": {
                "inspect": "The coordinator should inspect local evidence and check the worktree before continuing.",
                "retry_after_checks": "Consider a retry only after the coordinator establishes it is safe.",
                "ask_user": "Ask the user for input before proceeding."
            }
        });
    }
    if lightweight {
        body["questions"]["model_tier"] = json!({
            "type": "choice",
            "instructions": "Choose a model tier within Codex under the economy policy.",
            "criteria": {
                "lightweight": "Small, straightforward, low-risk task with no ambiguity.",
                "standard": "Work needing more reasoning capability, reliable context reuse or independent review."
            }
        });
    }
    body
}

fn advice(answer: &Value, name: &str, allowed: &[&str]) -> Option<String> {
    let answer = &answer["answers"][name];
    let choice = answer["choice"].as_str()?;
    let confidence = answer["confidence"].as_f64()?;
    (answer["type"] == "choice" && (0.65..=1.0).contains(&confidence) && allowed.contains(&choice))
        .then(|| choice.into())
}

fn decide(
    settings: &Settings, signals: &Signals, available: &[String],
    lightweight_available: bool,
    evaluate: impl FnOnce(&Value) -> Result<Value, &'static str>,
) -> Trace {
    let floor = signals.floor(settings.policy);
    let target = if settings.policy == Policy::Economy { floor } else { floor.max(1) };
    let high_risk = matches!(signals.risk, "high" | "critical");
    let complexity = match (signals.risk, signals.scope) {
        ("critical", _) => "critical",
        ("high", _) | (_, "large") => "complex",
        ("low", "small") if !signals.ambiguous_failure => "simple",
        _ => "standard",
    };
    let mut trace = Trace {
        source: if settings.model.is_none() { "unconfigured" } else { "local" }.into(),
        effort: best_effort(available, target, floor),
        complexity: Some(complexity.into()),
        review: Some(if high_risk { "independent" } else { "standard" }.into()),
        event_advice: signals.ambiguous_failure.then(|| "inspect".into()),
        ..Trace::default()
    };
    let Some(model) = settings.model.as_deref().filter(|m| valid_model(m)) else { return trace };
    if settings.mode == Mode::Local {
        return trace;
    }
    if !available.iter().any(|e| EFFORTS.contains(&e.as_str())) {
        trace.reason = Some("capability".into());
        return trace;
    }
    let start = std::time::Instant::now();
    let lightweight = lightweight_available && settings.policy == Policy::Economy
        && floor == 0 && signals.scope == "small" && !signals.ambiguous_failure;
    let result = evaluate(&request_body(model, settings, signals, available, lightweight));
    trace.duration_ms = Some(start.elapsed().as_millis() as u64);
    let answer = match result {
        Ok(value) => value,
        Err(reason) => {
            trace.source = "api_error".into();
            trace.reason = Some(reason.into());
            return trace;
        }
    };
    trace.model = answer["model"].as_str().filter(|m| valid_model(m)).map(str::to_owned);
    trace.input_tokens = answer["usage"]["input_tokens"].as_u64();
    trace.output_tokens = answer["usage"]["output_tokens"].as_u64();
    trace.cost_estimate_usd = trace.model.as_deref().zip(trace.input_tokens)
        .and_then(|(model, input)| estimate_usd(model, input));
    let mut supports_lightweight = false;
    if trace.model.is_some() {
        let remote_complexity = advice(&answer, "complexity", &["simple", "standard", "complex", "critical"]);
        let remote_review = advice(&answer, "review", &["standard", "independent"]);
        supports_lightweight = remote_complexity.as_deref() == Some("simple") && remote_review.as_deref() == Some("standard");
        if !high_risk {
            trace.complexity = remote_complexity.or(trace.complexity);
            trace.review = remote_review.or(trace.review);
        }
        trace.context = advice(&answer, "context", &["reuse", "recover", "summarize", "handoff"]);
        if signals.ambiguous_failure {
            trace.event_advice = advice(&answer, "event", &["inspect", "retry_after_checks", "ask_user"]).or(trace.event_advice);
        }
    }
    let route = &answer["answers"]["route"];
    let confidence = route["confidence"].as_f64().filter(|n| (0.0..=1.0).contains(n));
    trace.confidence = confidence;
    let chosen = route["choice"].as_str()
        .and_then(|chosen| EFFORTS.iter().position(|e| *e == chosen));
    let Some(chosen) = chosen.filter(|_| trace.model.is_some() && route["type"] == "choice" && confidence.is_some()) else {
        trace.reason = Some(Failure::InvalidResponse.code().into());
        return trace;
    };
    trace.recommended_effort = Some(EFFORTS[chosen].into());
    if confidence.unwrap_or_default() < 0.65 {
        trace.reason = Some("confidence".into());
    } else if chosen < floor || !available.iter().any(|e| e == EFFORTS[chosen]) {
        trace.reason = Some("policy".into());
    } else if settings.mode == Mode::Shadow {
        trace.source = "shadow".into();
    } else {
        trace.source = "jev".into();
        trace.effort = trace.recommended_effort.clone();
        trace.lightweight = lightweight && chosen == 0
            && supports_lightweight
            && advice(&answer, "model_tier", &["lightweight", "standard"]).as_deref() == Some("lightweight");
    }
    trace
}

fn estimate_usd(model: &str, input: u64) -> Option<f64> {
    let catalog: Value = serde_json::from_str(include_str!("prices.json")).ok()?;
    let price = catalog["inputUsdPerMillion"][model].as_f64()?;
    Some(input as f64 * price / 1_000_000.0)
}

pub fn route(state: &AppState, run: i64, baseline: Option<&str>, available: &[String], allow_model_override: bool) -> CmdResult<Trace> {
    // A concurrent route falls back locally. A revocation that has returned
    // holds the same gate used for network calls, so it cannot race a new send.
    let gate = state.jev_gate.try_lock();
    let (settings, signals) = {
        let conn = state.db.lock().map_err(err)?;
        (settings(&conn).map_err(err)?, Signals::for_run(&conn, run).map_err(err)?)
    };
    let candidates = state.codex.jev_models()?;
    let light_model = settings.light_model.as_ref().filter(|id| allow_model_override && baseline.is_some_and(|b| b != *id) && candidates.contains(id));
    let mut api_attempted = false;
    let mut http_status = None;
    let mut trace = decide(&settings, &signals, available, light_model.is_some(), |body| {
        let _gate = gate.map_err(|_| "busy")?;
        let key = credential::read(false).ok_or("credential")?;
        if !reserve(&state.db).map_err(|_| "budget")? {
            return Err("budget");
        }
        api_attempted = true;
        let result = typesafe::evaluate(&key, settings.timeout_secs, body);
        http_status = match &result { Ok(_) => Some(200), Err(failure) => failure.status() };
        result.map_err(Failure::code)
    });
    trace.api_attempted = api_attempted;
    trace.http_status = http_status;
    trace.endpoint = api_attempted.then(|| "POST /v1/systemone".into());
    if trace.lightweight {
        trace.execution_model = light_model.cloned();
    }
    Ok(trace)
}

pub fn baseline(conn: &Connection, thread: &str) -> rusqlite::Result<Option<String>> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT model FROM jev_codex_baselines WHERE thread=?1", [thread], |r| r.get(0)).optional()
}

pub fn preserve_baseline(conn: &Connection, thread: &str, model: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR IGNORE INTO jev_codex_baselines(thread,model) VALUES(?1,?2)", params![thread, model])?;
    Ok(())
}

pub fn record(conn: &Connection, run: i64, trace: &Trace) -> CmdResult<()> {
    let data = serde_json::to_string(trace).map_err(err)?;
    conn.execute("INSERT INTO jev_routes(run_id,data) VALUES(?1,?2)", params![run, data]).map_err(err)?;
    Ok(())
}

#[derive(Default, Debug, Clone)]
pub struct ComposerClassification {
    pub used_jev: bool,
    pub next_action: Option<String>,
    pub generation_tier: Option<String>,
    pub confidence: Option<f64>,
    pub model: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_estimate_usd: Option<f64>,
    pub reason: Option<String>,
}

const COMPOSER_ACTIONS: [&str; 10] = [
    "approve_plan",
    "fix_audit",
    "fix_ci",
    "resolve_blocker",
    "verify_and_review",
    "prepare_commit",
    "prepare_pr",
    "continue_task",
    "resume_work",
    "none",
];

const COMPOSER_TIERS: [&str; 3] = ["local", "light_model", "skip"];

fn composer_request_body(model: &str, signals: &Value) -> Value {
    json!({
        "model": model,
        "state": signals,
        "questions": {
            "next_action": {
                "type": "choice",
                "instructions": "Classify the most helpful next user intent in a multi-agent IDE based only on structured workflow signals. Choose none if there is no clear next step.",
                "criteria": {
                    "approve_plan": "The Project Manager just presented a plan waiting for user approval to begin delegation.",
                    "fix_audit": "Code health or audit reported open findings or errors that need remediation and re-audit.",
                    "fix_ci": "An open Pull Request has failing CI checks that should be diagnosed and fixed.",
                    "resolve_blocker": "A task or session is blocked, failed, paused, or waiting on dependencies.",
                    "verify_and_review": "Implementation finished or files changed and tests or independent review are still pending.",
                    "prepare_commit": "Implementation is verified with local changes ready to ask Larry for a commit.",
                    "prepare_pr": "Clean branch with verified commits ready to review and open or update a Pull Request.",
                    "continue_task": "Open tasks or active work remain and a normal next-step follow-up applies.",
                    "resume_work": "User resumed a prior conversation or project with pending context.",
                    "none": "No clear or useful next suggestion applies right now."
                }
            },
            "generation_tier": {
                "type": "choice",
                "instructions": "Decide whether a fast deterministic local suggestion suffices, a lightweight LLM is needed for conversation-specific wording, or no suggestion should be shown.",
                "criteria": {
                    "local": "Structured workflow state cleanly determines the next instruction without LLM prose.",
                    "light_model": "Recent conversation context has nuance that benefits from a fast lightweight LLM.",
                    "skip": "No suggestion should be shown to avoid noise."
                }
            }
        }
    })
}

pub(crate) fn classify_composer_with(
    settings: &Settings,
    signals: &Value,
    evaluate: impl FnOnce(&Value) -> Result<Value, &'static str>,
) -> ComposerClassification {
    let mut out = ComposerClassification::default();
    let Some(model) = settings.model.as_deref().filter(|m| valid_model(m)) else {
        out.reason = Some("unconfigured".into());
        return out;
    };
    if settings.mode == Mode::Local {
        out.reason = Some("local_mode".into());
        return out;
    }
    let answer = match evaluate(&composer_request_body(model, signals)) {
        Ok(value) => value,
        Err(reason) => {
            out.reason = Some(reason.into());
            return out;
        }
    };
    out.model = answer["model"].as_str().filter(|m| valid_model(m)).map(str::to_owned);
    out.input_tokens = answer["usage"]["input_tokens"].as_u64();
    out.output_tokens = answer["usage"]["output_tokens"].as_u64();
    out.cost_estimate_usd = out.model.as_deref().zip(out.input_tokens).and_then(|(m, i)| estimate_usd(m, i));
    if out.model.is_none() {
        out.reason = Some(Failure::InvalidResponse.code().into());
        return out;
    }
    let next = &answer["answers"]["next_action"];
    let conf = next["confidence"].as_f64().filter(|n| (0.0..=1.0).contains(n));
    out.confidence = conf;
    out.next_action = advice(&answer, "next_action", &COMPOSER_ACTIONS);
    out.generation_tier = advice(&answer, "generation_tier", &COMPOSER_TIERS);
    if out.next_action.is_some() || out.generation_tier.is_some() {
        out.used_jev = true;
    } else {
        out.reason = Some("confidence".into());
    }
    out
}

/// Clasifica la situación del Compositor inteligente usando únicamente el
/// contrato oficial `Choice` de TypeSafe y las credenciales personales del usuario.
/// Nunca envía texto libre, código, rutas ni secretos.
pub fn classify_composer(state: &AppState, signals: &Value) -> ComposerClassification {
    let gate = state.jev_gate.try_lock();
    let saved = match state.db.lock().ok().and_then(|conn| settings(&conn).ok()) {
        Some(s) => s,
        None => return ComposerClassification { reason: Some("db".into()), ..Default::default() },
    };
    classify_composer_with(&saved, signals, |body| {
        let _gate = gate.map_err(|_| "busy")?;
        let key = credential::read(false).ok_or("credential")?;
        if !reserve(&state.db).map_err(|_| "budget")? {
            return Err("budget");
        }
        typesafe::evaluate(&key, saved.timeout_secs.min(4), body).map_err(Failure::code)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composer_classification_uses_the_choice_contract_and_falls_back_locally() {
        let settings = Settings { mode: Mode::Active, model: Some("jev-latest".into()), ..Settings::default() };
        let signals = json!({ "event": "turn_end", "audit_errors": "few" });
        let mut sent = Value::Null;
        let out = classify_composer_with(&settings, &signals, |body| {
            sent = body.clone();
            Ok(json!({ "model": "jev-1.14.0", "usage": { "input_tokens": 90, "output_tokens": 4 }, "answers": {
                "next_action": { "type": "choice", "choice": "fix_audit", "confidence": 0.9 },
                "generation_tier": { "type": "choice", "choice": "local", "confidence": 0.8 } } }))
        });
        assert_eq!(sent["questions"]["next_action"]["type"], "choice");
        assert_eq!(sent["state"], signals, "solo viajan las señales categóricas");
        assert!(out.used_jev);
        assert_eq!((out.next_action.as_deref(), out.generation_tier.as_deref()), (Some("fix_audit"), Some("local")));
        let unsure = classify_composer_with(&settings, &signals, |_| Ok(json!({ "model": "jev-1.14.0", "answers": {
            "next_action": { "type": "choice", "choice": "fix_audit", "confidence": 0.3 } } })));
        assert!(!unsure.used_jev && unsure.next_action.is_none());
        let invented = classify_composer_with(&settings, &signals, |_| Ok(json!({ "model": "jev-1.14.0", "answers": {
            "next_action": { "type": "choice", "choice": "merge_now", "confidence": 0.99 } } })));
        assert!(invented.next_action.is_none());
        let offline = classify_composer_with(&settings, &signals, |_| Err("unavailable"));
        assert_eq!(offline.reason.as_deref(), Some("unavailable"));
        let local = classify_composer_with(&Settings { mode: Mode::Local, ..settings }, &signals, |_| unreachable!());
        assert_eq!(local.reason.as_deref(), Some("local_mode"));
    }

    #[test]
    fn usage_counts_all_reported_tokens_and_detects_unpriced_usage() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE task_runs(id INTEGER PRIMARY KEY);
                            INSERT INTO task_runs(id) VALUES (1),(2),(3),(4);").unwrap();
        migrate(&conn).unwrap();
        assert_eq!(totals(&conn).unwrap().cost_usd, Some(0.0));
        for (id, data) in [
            (1, json!({"source":"local","reason":"unavailable"})),
            (2, json!({"source":"shadow","inputTokens":250,"outputTokens":12,"costEstimateUsd":0.0000105})),
            (3, json!({"source":"local","reason":"confidence","inputTokens":100,"outputTokens":3,"costEstimateUsd":0.0000042})),
        ] {
            conn.execute("INSERT INTO jev_routes(run_id,data) VALUES(?1,?2)", params![id, data.to_string()]).unwrap();
        }
        let usage = totals(&conn).unwrap();
        assert_eq!(usage.tokens, 365);
        assert!((usage.cost_usd.unwrap() - 0.0000147).abs() < 1e-10);
        conn.execute(r#"INSERT INTO jev_routes VALUES(4, '{"inputTokens":1}')"#, []).unwrap();
        assert_eq!(totals(&conn).unwrap().cost_usd, None);
    }

    #[test]
    fn daily_reference_rate_selects_usd() {
        assert_eq!(usd_per_euro("<Cube currency='JPY' rate='160'/><Cube currency='USD' rate='1.16'/>"), Some(1.16));
        assert_eq!(usd_per_euro(r#"<Cube currency="USD" rate="0"/>"#), None);
    }

    fn change(mode: Mode, consent: bool) -> Change {
        Change { mode, consent, policy: Policy::Balanced, timeout_secs: 2, light_model: None }
    }

    fn modes() -> Vec<String> {
        EFFORTS.map(str::to_owned).to_vec()
    }

    fn response(choice: &str, confidence: f64) -> Value {
        json!({"model":"jev-1.14.0","answers":{"route":{"type":"choice","choice":choice,"confidence":confidence}},
              "usage":{"input_tokens":250,"output_tokens":12}})
    }

    #[test]
    fn configuration_activates_real_route_only_with_consent() {
        assert!(configure(change(Mode::Active, false), |_| panic!("no network without consent")).is_err());
        let settings = configure(change(Mode::Active, true), |_| Ok(json!({"models":[{"name":"jev-latest"}]}))).unwrap();
        let signals = Signals { risk: "low", priority: "normal", scope: "small", history: "fresh", ambiguous_failure: false };
        let trace = decide(&settings, &signals, &modes(), false, |body| {
            assert_eq!(body["model"], "jev-latest");
            assert_eq!(body["state"], json!({
                "risk":"low","priority":"normal","scope":"small","policy":"balanced","available_efforts":modes(),
                "history":"fresh","ambiguous_failure":false,"lightweight_available":false
            }));
            assert_eq!(body["questions"]["route"]["type"], "choice");
            Ok(response("low", 0.91))
        });
        assert_eq!(trace.source, "jev");
        assert_eq!(trace.effort.as_deref(), Some("low"));
        assert_eq!(trace.input_tokens, Some(250));
        assert!((trace.cost_estimate_usd.unwrap() - 0.0000105).abs() < 1e-10);
    }

    #[test]
    fn timeout_refusal_shadow_and_high_risk_keep_the_local_route() {
        let normal = Signals { risk: "low", priority: "normal", scope: "medium", history: "fresh", ambiguous_failure: false };
        let high = Signals { risk: "high", ..normal };
        let settings = Settings { mode: Mode::Active, model: Some("jev-latest".into()), ..Settings::default() };
        for (result, reason) in [(Err("timeout"), "timeout"), (Err("rate_limit"), "rate_limit"),
            (Err("credential"), "credential"), (Ok(response("invented", 0.91)), "invalid_response"),
            (Ok(response("low", 0.5)), "confidence")] {
            let trace = decide(&settings, &normal, &modes(), false, |_| result);
            assert_eq!((trace.source.as_str(), trace.reason.as_deref(), trace.effort.as_deref()),
                (if matches!(reason, "timeout" | "rate_limit" | "credential") { "api_error" } else { "local" }, Some(reason), Some("medium")));
        }
        let trace = decide(&settings, &high, &modes(), false, |_| Ok(response("low", 0.99)));
        assert_eq!((trace.reason.as_deref(), trace.effort.as_deref()), (Some("policy"), Some("high")));
        let shadow = Settings { mode: Mode::Shadow, ..settings };
        let trace = decide(&shadow, &normal, &modes(), false, |_| Ok(response("low", 0.99)));
        assert_eq!((trace.source.as_str(), trace.effort.as_deref(), trace.recommended_effort.as_deref()),
            ("shadow", Some("medium"), Some("low")));
        let local = Settings { mode: Mode::Local, ..shadow };
        assert_eq!(decide(&local, &normal, &modes(), false, |_| panic!("local connects")).source, "local");
    }

    #[test]
    fn fallback_triages_large_and_ambiguous_tasks_within_the_local_policy() {
        let settings = Settings { mode: Mode::Active, model: Some("jev-latest".into()),
            policy: Policy::Economy, ..Settings::default() };
        let signals = Signals { risk: "low", priority: "normal", scope: "large", history: "incomplete", ambiguous_failure: true };
        let trace = decide(&settings, &signals, &modes(), true, |_| Err("unavailable"));
        assert_eq!((trace.source.as_str(), trace.effort.as_deref()), ("api_error", Some("medium")));
        assert_eq!(trace.complexity.as_deref(), Some("complex"));
        assert_eq!(trace.event_advice.as_deref(), Some("inspect"));
        assert!(!trace.lightweight);
        assert_eq!(trace.cost_estimate_usd, None);
        let critical = Signals { risk: "critical", ..signals };
        let trace = decide(&settings, &critical, &modes(), true, |_| Ok(response("low", 0.99)));
        assert_eq!(trace.effort.as_deref(), Some("high"));
        assert_eq!(trace.review.as_deref(), Some("independent"));
    }

    #[test]
    fn chooses_lightweight_only_when_eligible_and_treats_context_and_triage_as_advice() {
        let settings = Settings { mode: Mode::Active, model: Some("jev-latest".into()),
            policy: Policy::Economy, ..Settings::default() };
        let small = Signals { risk: "low", priority: "normal", scope: "small", history: "incomplete", ambiguous_failure: false };
        let mut answer = response("low", 0.93);
        for (key, choice) in [("model_tier", "lightweight"), ("complexity", "simple"), ("review", "standard"),
            ("context", "recover"), ("event", "retry_after_checks")] {
            answer["answers"][key] = json!({"type":"choice","choice":choice,"confidence":0.9});
        }
        let trace = decide(&settings, &small, &modes(), true, |body| {
            assert_eq!(body["questions"]["model_tier"]["type"], "choice");
            assert!(body["questions"]["event"].is_null());
            Ok(answer.clone())
        });
        assert!(trace.lightweight);
        assert_eq!(trace.context.as_deref(), Some("recover"));
        assert!(trace.event_advice.is_none());
        let ambiguous = Signals { ambiguous_failure: true, ..small };
        let trace = decide(&settings, &ambiguous, &modes(), true, |body| {
            assert_eq!(body["questions"]["event"]["type"], "choice");
            assert!(body["questions"]["model_tier"].is_null());
            Ok(answer.clone())
        });
        assert!(!trace.lightweight);
        assert_eq!(trace.event_advice.as_deref(), Some("retry_after_checks"));
        assert!(!decide(&settings, &small, &modes(), false, |_| Ok(answer)).lightweight);
    }

    #[test]
    fn persists_consent_budget_and_trace_without_task_content() {
        let path = std::env::temp_dir().join(format!("filigranas-jev-{}.db", uuid::Uuid::new_v4()));
        let settings = configure(change(Mode::Active, true), |_| Ok(json!({"models":[{"name":"jev-latest"}]}))).unwrap();
        let conn = crate::db::open(&path).unwrap();
        db::set_setting(&conn, SETTING, &serde_json::to_string(&settings).unwrap()).unwrap();
        conn.execute(
            "INSERT INTO tasks(id,project,title,goal,criteria,priority,risk,status)
             VALUES(1,'/private/repo','Secret title','Secret goal','Secret criteria','normal','low','ready')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO task_runs(id,task_id,scope,project,provider,started_ms,retry)
             VALUES(1,1,'thread','/private/repo','codex',0,0)", [],
        ).unwrap();
        let signals = Signals::for_run(&conn, 1).unwrap();
        let trace = decide(&settings, &signals, &modes(), false, |body| {
            assert!(!body.to_string().contains("Secret"));
            assert!(!body.to_string().contains("/private/repo"));
            Ok(response("low", 0.9))
        });
        record(&conn, 1, &trace).unwrap();
        preserve_baseline(&conn, "thread", "verified-default").unwrap();
        preserve_baseline(&conn, "thread", "configured-lightweight").unwrap();
        crate::runs::finish(&conn, 1, "failed").unwrap();
        mark_ambiguous(&conn, 1).unwrap();
        conn.execute(
            "INSERT INTO task_runs(id,task_id,scope,project,provider,started_ms,retry)
             VALUES(2,1,'thread','/private/repo','codex',0,1)", [],
        ).unwrap();
        assert!(Signals::for_run(&conn, 2).unwrap().ambiguous_failure);
        let conn = Mutex::new(conn);
        for _ in 0..DAILY_ATTEMPTS {
            assert!(reserve(&conn).unwrap());
        }
        drop(conn);

        let reopened = Mutex::new(crate::db::open(&path).unwrap());
        assert!(!reserve(&reopened).unwrap());
        let conn = reopened.into_inner().unwrap();
        assert_eq!(super::settings(&conn).unwrap().mode, Mode::Active);
        conn.execute("INSERT INTO jev_attempts(at) VALUES(unixepoch()-90000)", []).unwrap();
        assert_eq!(attempt_count(&conn).unwrap(), DAILY_ATTEMPTS);
        assert_eq!(baseline(&conn, "thread").unwrap().as_deref(), Some("verified-default"));
        let runs = serde_json::to_value(crate::runs::recent(&conn, 1).unwrap()).unwrap();
        assert_eq!(runs[1]["routing"]["effort"], "low");
        assert_eq!(runs[1]["routing"]["source"], "jev");
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod real_acceptance {
    use super::*;
    #[test]
    #[ignore = "real personal Keychain credential, network and billable TypeSafe request"]
    fn real_typesafe_personal_api() {
        let key = credential::read(false).expect("personal_credential_missing_or_native_access_denied");
        let start = std::time::Instant::now();
        let catalog = typesafe::models(&key, 10).unwrap_or_else(|failure| panic!("catalog_failed:{}", failure.code()));
        let model = select_model(&catalog).expect("no_compatible_jev_model");
        println!("TYPE_SAFE_CATALOG authenticated=true model={} latency_ms={}",model,start.elapsed().as_millis());
        let saved = Settings { mode: Mode::Active, model: Some(model), timeout_secs:10, ..Default::default() };
        let signals = Signals { risk:"low",priority:"normal",scope:"small",history:"fresh",ambiguous_failure:false };
        let available = vec!["low".into(),"medium".into(),"high".into()];
        let trace = decide(&saved, &signals, &available, false, |body| typesafe::evaluate(&key, 10, body).map_err(Failure::code));
        println!("TYPE_SAFE_DECISION {}",serde_json::to_string(&trace).unwrap());
        assert_eq!(trace.source,"jev", "real API decision was not applied; see sanitized trace");
        assert!(trace.input_tokens.is_some());
        assert!(trace.effort.is_some());
        // Exact credential audit: subprocess output stays private in memory.
        let objects = crate::cli::command("git").args(["rev-list","--objects","--all"]).output().unwrap();
        assert!(objects.status.success());
        let mut checked = 0;
        for line in String::from_utf8_lossy(&objects.stdout).lines() {
            let oid = line.split_whitespace().next().unwrap();
            let object = crate::cli::command("git").args(["cat-file","-p",oid]).output().unwrap();
            assert!(object.status.success());
            assert!(!object.stdout.windows(key.len()).any(|v| v == key.as_bytes()), "personal credential exposed in Git object {}: revoke and rotate immediately",oid);
            checked += 1;
        }
        println!("SECRET_AUDIT exact_personal_key_git_objects_checked={} findings=0",checked);
    }
}
