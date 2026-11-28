use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::cli::{login_path, program};
use crate::rpc::{Incoming, Rpc};
use crate::{db, err, runs, tasks, workspace::project_path, AppState, CmdResult};

// Coordinador: Codex mediante `codex app-server`, JSON-RPC por stdio con un
// mensaje JSON por línea (sin el campo `jsonrpc`). Un solo proceso para
// toda la app; cada proyecto tiene su hilo, guardado en la base de datos.

const DECISIONS: [&str; 4] = ["accept", "acceptForSession", "decline", "cancel"];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const APPROVALS: [&str; 2] = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"];
/// Avisos internos del servidor que la interfaz no usa.
const QUIET: [&str; 3] = ["mcpServer/startupStatus/updated", "remoteControl/status/changed", "account/updated"];
const SHORT: Duration = Duration::from_secs(30);
const LONG: Duration = Duration::from_secs(120);

fn instructions(direct: bool, rules: &str) -> String {
    if direct {
        return format!("Eres un ejecutor Codex en una conversación directa. Trabaja en esta sesión y sigue las instrucciones del proyecto.\n\n{rules}");
    }
    format!("{}\n\n{rules}", include_str!("../resources/coordinadores/politica.md"))
}

fn retire_persona() -> Value {
    json!({
        "type": "message",
        "role": "developer",
        "content": [{
            "type": "input_text",
            "text": format!("Las instrucciones anteriores sobre nombres y personalidades quedan revocadas.\n\n{}", include_str!("../resources/coordinadores/politica.md")),
        }],
    })
}

/// Parámetros comunes de `thread/start` y `thread/resume`.
/// El Project Manager (`direct == false`) opera SIEMPRE en sandbox `read-only`
/// y jamás puede ejecutar comandos ni modificar archivos: todo trabajo técnico
/// debe delegarse mediante herramientas dinámicas.
fn thread_params(cwd: &str, direct: bool, rules: &str) -> Value {
    let mut params = json!({
        "cwd": cwd,
        "sandbox": "read-only",
        "approvalPolicy": "untrusted",
        "developerInstructions": instructions(direct, rules),
    });
    if !direct {
        params["config"] = json!({"features.shell_tool":false, "features.multi_agent":false,
            "features.multi_agent_v2":false, "features.apps":false,
            "features.browser_use":false, "features.computer_use":false,
            "features.image_generation":false, "web_search":"disabled"});
    }
    params
}

fn is_pm_codex_thread(sessions: &HashMap<String, i64>, projects: &HashMap<String, String>, thread: &str) -> bool {
    !sessions.contains_key(thread) && projects.contains_key(thread)
}

struct Server {
    rpc: Arc<Rpc>,
    child: Child,
}

#[derive(Default)]
struct Shared {
    /// Hilos ya cargados en el proceso actual.
    loaded: HashSet<String>,
    /// Turno en marcha por hilo, para poder interrumpirlo.
    turns: HashMap<String, String>,
    /// Peticiones de aprobación sin responder (id JSON serializado).
    approvals: HashSet<String>,
    /// Paths announced by the provider before a patch approval; never diffs.
    patch_paths: HashMap<String, Vec<String>>,
    /// Hilos internos (p. ej. Larry) cuyos avisos espera el núcleo.
    waiters: HashMap<String, Sender<(String, Value)>>,
    models: HashMap<String, String>,
    model_efforts: HashMap<String, Vec<String>>,
    default_model: Option<String>,
    low_text_models: Vec<String>,
    sessions: HashMap<String, i64>,
    projects: HashMap<String, String>,
    quota: runs::Quota,
    usage_baseline: HashMap<String, (String, runs::Usage)>,
}

enum Observation {
    Started(String, String),
    Completed(String, String, &'static str, bool),
    Usage(String, String, runs::Usage),
    Phase(String, &'static str),
    Quota(runs::Quota),
    Closed,
}

impl Observation {
    fn store(self, conn: &rusqlite::Connection) -> CmdResult<()> {
        match self {
            Self::Started(thread, turn) => runs::bind_turn(conn, &thread, &turn).map_err(err),
            Self::Completed(thread, turn, outcome, ambiguous) => {
                if let Some(run) = runs::for_turn(conn, &thread, &turn).map_err(err)? {
                    runs::finish(conn, run, outcome).map_err(err)?;
                    if ambiguous {
                        crate::jev::mark_ambiguous(conn, run).map_err(err)?;
                    }
                }
                Ok(())
            }
            Self::Usage(thread, turn, usage) => {
                if let Some(run) = runs::for_turn(conn, &thread, &turn).map_err(err)? {
                    runs::usage(conn, run, usage).map_err(err)?;
                }
                Ok(())
            }
            Self::Phase(thread, status) => {
                if let Some(run) = runs::active(conn, &thread)? {
                    runs::phase(conn, run, status).map_err(err)?;
                }
                Ok(())
            }
            Self::Quota(quota) => runs::codex_quota(conn, quota).map_err(err),
            Self::Closed => runs::provider_closed(conn, "codex"),
        }
    }
}

fn observation(shared: &mut Shared, event: &Event) -> Option<Observation> {
    let params = &event.params;
    if event.method == "server/closed" {
        return Some(Observation::Closed);
    }
    if event.method == "account/rateLimits/updated" {
        shared.quota = runs::Quota::codex(&params["rateLimits"]);
        return Some(Observation::Quota(shared.quota));
    }
    let thread = params["threadId"].as_str()?.to_string();
    match event.method.as_str() {
        "turn/started" => Some(Observation::Started(thread, params.pointer("/turn/id")?.as_str()?.into())),
        "turn/completed" => {
            let turn = params.pointer("/turn/id")?.as_str()?;
            let outcome = match params.pointer("/turn/status")?.as_str()? {
                "completed" => "completed",
                "interrupted" => "cancelled",
                _ if crate::handoff::quota_reason(&params["turn"]["error"].to_string()).is_some() => "paused_quota",
                _ => "failed",
            };
            let ambiguous = outcome == "failed" && params["turn"]["error"].is_null();
            Some(Observation::Completed(thread, turn.into(), outcome, ambiguous))
        }
        "thread/tokenUsage/updated" => {
            let turn = params["turnId"].as_str()?;
            let total = runs::Usage::codex(&params["tokenUsage"]["total"]);
            let last = runs::Usage::codex(&params["tokenUsage"]["last"]);
            let entry = shared.usage_baseline.entry(thread.clone()).or_default();
            if entry.0 != turn {
                *entry = (turn.into(), total.minus(&last));
            }
            let usage = total.minus(&entry.1).or(last);
            Some(Observation::Usage(thread, turn.into(), usage))
        }
        "model/rerouted" => {
            let model = params["toModel"].as_str()?;
            let turn = params["turnId"].as_str()?;
            Some(Observation::Usage(thread, turn.into(), runs::Usage { model: Some(model.into()), ..Default::default() }))
        }
        "serverRequest/resolved" => Some(Observation::Phase(thread, "running")),
        method if APPROVALS.contains(&method) => Some(Observation::Phase(thread, "waiting_approval")),
        _ => None,
    }
}

#[derive(Default)]
pub struct Codex {
    server: Mutex<Option<Server>>,
    shared: Arc<Mutex<Shared>>,
    thread_gate: Mutex<()>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Event {
    method: String,
    params: Value,
    request_id: Option<Value>,
}

impl Codex {
    pub fn jev_models(&self) -> CmdResult<Vec<String>> {
        Ok(self.shared.lock().map_err(err)?.low_text_models.clone())
    }

    /// Turno único en un hilo efímero de solo lectura, con salida JSON según
    /// `schema`. Devuelve el texto final del agente. Para tareas internas
    /// del IDE como proponer commits.
    /// Si vence `limit`, interrumpe el turno y devuelve un error.
    #[allow(clippy::too_many_arguments)]
    pub fn run_structured(&self, app: &AppHandle, cwd: &str, instructions: &str, prompt: &str, schema: Value, effort: &str, limit: Duration) -> CmdResult<String> {
        let _execution = crate::updates::Execution::enter()?;
        let rpc = self.rpc(app)?;
        let res = rpc.request(
            "thread/start",
            json!({ "cwd": cwd, "sandbox": "read-only", "approvalPolicy": "never", "developerInstructions": instructions, "ephemeral": true }),
            LONG,
        )?;
        let thread = res.pointer("/thread/id").and_then(Value::as_str).ok_or("codex no devolvió el hilo")?.to_string();
        let (tx, rx) = channel();
        self.shared.lock().map_err(err)?.waiters.insert(thread.clone(), tx);
        let deadline = std::time::Instant::now() + limit;
        let result = (|| {
            let started = rpc.request(
                "turn/start",
                json!({ "threadId": thread, "effort": effort, "outputSchema": schema, "input": [{ "type": "text", "text": prompt, "text_elements": [] }] }),
                LONG,
            )?;
            let turn = started.pointer("/turn/id").and_then(Value::as_str).unwrap_or("").to_string();
            let mut last = String::new();
            loop {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                let Ok((method, params)) = rx.recv_timeout(left) else {
                    let _ = rpc.request("turn/interrupt", json!({ "threadId": thread, "turnId": turn }), SHORT);
                    return Err(format!("codex no respondió en {} s", limit.as_secs()));
                };
                match method.as_str() {
                    "item/completed" if params.pointer("/item/type") == Some(&json!("agentMessage")) => {
                        last = params.pointer("/item/text").and_then(Value::as_str).unwrap_or("").to_string();
                    }
                    "turn/completed" => {
                        if let Some(e) = params.pointer("/turn/error/message").and_then(Value::as_str) {
                            return Err(e.to_string());
                        }
                        return Ok(last);
                    }
                    _ => {}
                }
            }
        })();
        self.shared.lock().map_err(err)?.waiters.remove(&thread);
        result
    }

    /// El proceso en marcha, sin arrancar otro.
    pub fn current(&self) -> Option<Arc<Rpc>> {
        self.server.lock().ok()?.as_ref().filter(|s| s.rpc.alive()).map(|s| s.rpc.clone())
    }

    /// Si el app-server está vivo o arrancando (cerrojo ocupado).
    pub fn running(&self) -> bool {
        self.server.try_lock().map(|s| s.as_ref().is_some_and(|s| s.rpc.alive())).unwrap_or(true)
    }

    /// El proceso en marcha, o uno nuevo si no hay o terminó.
    fn rpc(&self, app: &AppHandle) -> CmdResult<Arc<Rpc>> {
        let mut slot = self.server.lock().map_err(err)?;
        if let Some(s) = slot.as_ref() {
            if s.rpc.alive() {
                return Ok(s.rpc.clone());
            }
        }
        if let Some(mut old) = slot.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        let mut cmd = crate::cli::command(program("codex"));
        cmd.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(path) = login_path() {
            cmd.env("PATH", path);
        }
        let mut child = cmd.spawn().map_err(|e| format!("no se pudo arrancar codex ({e}); comprueba que Codex CLI está instalado"))?;
        let (stdout, stdin) = (child.stdout.take().ok_or("sin salida de codex")?, child.stdin.take().ok_or("sin entrada de codex")?);

        let shared = self.shared.clone();
        let handle = app.clone();
        let rpc = Rpc::start(stdout, stdin, move |rpc, msg| {
            let mut sh = shared.lock().unwrap_or_else(|p| p.into_inner());
            let event = match msg {
                Incoming::Notification { method, params } => {
                    let thread = params.get("threadId").and_then(Value::as_str).unwrap_or("").to_string();
                    if let Some(tx) = sh.waiters.get(&thread) {
                        let _ = tx.send((method.clone(), params.clone()));
                        return; // hilo interno: no va a la interfaz
                    }
                    if let Some(id) = sh.sessions.get(&thread) {
                        let state = handle.state::<AppState>();
                        match method.as_str() {
                            "turn/started" => {
                                state.tracker.started(*id);
                                crate::claude::notify_subsession(&handle, *id);
                            }
                            "turn/completed" => {
                                state.tracker.finished(*id, None);
                                crate::claude::notify_subsession(&handle, *id);
                            }
                            "item/agentMessage/delta" => {
                                if let Some(delta) = params["delta"].as_str() {
                                    state.tracker.chunk(*id, delta);
                                }
                            }
                            _ => {}
                        }
                    }
                    if method == "item/started" || method == "item/fileChange/patchUpdated" {
                        let item = params.get("item").unwrap_or(&params);
                        if let (Some(id), Some(changes)) = (item["id"].as_str().or_else(|| params["itemId"].as_str()), item["changes"].as_array()) {
                            let paths = changes.iter().flat_map(|c| [c["path"].as_str(),c.pointer("/kind/move_path").and_then(Value::as_str)]).flatten().map(str::to_owned).collect();
                            sh.patch_paths.insert(format!("{thread}:{id}"),paths);
                        }
                    }
                    match method.as_str() {
                        "turn/started" => {
                            if let Some(turn) = params.pointer("/turn/id").and_then(Value::as_str) {
                                sh.turns.insert(thread.clone(), turn.into());
                            }
                        }
                        "turn/completed" => {
                            sh.turns.remove(&thread);
                            sh.patch_paths.retain(|key,_| !key.starts_with(&format!("{thread}:")));
                        }
                        // Resuelta por otra vía (p. ej. turno interrumpido).
                        "serverRequest/resolved" => {
                            sh.approvals.remove(&params["requestId"].to_string());
                        }
                        _ => {}
                    }
                    if QUIET.contains(&method.as_str()) {
                        return;
                    }
                    Event { method, params, request_id: None }
                }
                Incoming::Request { id, method, params } => {
                    if method == "item/tool/call" {
                        // Herramientas del coordinador; pueden esperar minutos.
                        let app = handle.clone();
                        std::thread::spawn(move || {
                            let thread = params["threadId"].as_str().unwrap_or("");
                            let tool = params["tool"].as_str().unwrap_or("");
                            let (text, success) = match crate::delegate::handle(&app, thread, tool, &params["arguments"]) {
                                Ok(text) => (text, true),
                                Err(e) => (format!("error: {e}"), false),
                            };
                            let response = json!({ "contentItems": [{ "type": "inputText", "text": text }], "success": success });
                            if let Some(rpc) = app.state::<AppState>().codex.current() {
                                let _ = rpc.respond(id, response);
                            }
                        });
                        return;
                    }
                    if !APPROVALS.contains(&method.as_str()) {
                        // Sin soporte todavía: contestar para que Codex no espere.
                        let _ = rpc.respond_error(id, "Filigranas no admite esta petición todavía");
                        return;
                    }
                    // Garantía arquitectónica: el Project Manager en Codex NUNCA ejecuta
                    // comandos ni modifica archivos; toda solicitud de ejecución/edición se rechaza.
                    let thread = params["threadId"].as_str().unwrap_or("").to_string();
                    if is_pm_codex_thread(&sh.sessions, &sh.projects, &thread) {
                        let _ = rpc.respond(id.clone(), json!({ "decision": "decline" }));
                        Event {
                            method: "filigranas/pmExecutionBlocked".into(),
                            params: json!({ "threadId": thread, "request": method }),
                            request_id: None,
                        }
                    } else {
                        // En full control Filigranas aprueba por su cuenta en sesiones ejecutoras.
                        let permissions = &handle.state::<AppState>().permissions;
                        let mode = if let Some(sid) = sh.sessions.get(&thread) {
                            permissions.get(*sid)
                        } else if let Some(project) = sh.projects.get(&thread) {
                            permissions.get_project(project)
                        } else {
                            crate::autoapprove::Mode::Ask
                        };
                        let cwd = sh.sessions.get(&thread).and_then(|sid| {
                            let state = handle.state::<AppState>();
                            let conn = state.db.lock().ok()?;
                            db::session(&conn, *sid).ok().flatten().map(|s| s.worktree.unwrap_or(s.project))
                        }).or_else(|| sh.projects.get(&thread).cloned()).unwrap_or_default();
                        let (kind, mut paths, command) = crate::autoapprove::codex_request(&method, &params);
                        if method == "item/fileChange/requestApproval" && paths.is_empty() {
                            paths = sh.patch_paths.get(&format!("{thread}:{}", params["itemId"].as_str().unwrap_or(""))).cloned().unwrap_or_default();
                        }
                        match crate::autoapprove::evaluate(mode, std::path::Path::new(&cwd), kind, &paths, command.as_deref()) {
                            crate::autoapprove::PolicyDecision::Allow => {
                                let _ = rpc.respond(id, json!({ "decision": "accept" }));
                                Event { method: "filigranas/autoApproved".into(), params: json!({ "threadId": thread, "request": method }), request_id: None }
                            }
                            crate::autoapprove::PolicyDecision::DenyPolicy { origin, reason } => {
                                let _ = rpc.respond(id, json!({ "decision": "decline" }));
                                Event { method: "filigranas/policyDenied".into(), params: json!({ "threadId": thread, "origin": origin, "reason": reason }), request_id: None }
                            }
                            crate::autoapprove::PolicyDecision::Ask { origin, reason } => {
                                let mut params = params;
                                params["origin"] = json!(origin);
                                if let Some(reason) = reason { params["reason"] = json!(reason); }
                                sh.approvals.insert(id.to_string());
                                Event { method, params, request_id: Some(id) }
                            }
                        }
                    }
                }
                Incoming::Closed => {
                    for id in sh.sessions.values() {
                        handle.state::<AppState>().tracker.exited(*id);
                    }
                    *sh = Shared::default();
                    Event { method: "server/closed".into(), params: Value::Null, request_id: None }
                }
            };
            let observation = observation(&mut sh, &event);
            drop(sh);
            if let Some(observation) = observation {
                runs::record(&handle, |conn| observation.store(conn));
            }
            let _ = handle.emit("coordinator", event);
        });

        let init = rpc.request(
            "initialize",
            json!({
                "clientInfo": { "name": "filigranas", "title": "Filigranas", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true, "requestAttestation": false },
            }),
            SHORT,
        );
        if let Err(e) = init.and_then(|_| rpc.notify("initialized")) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("codex app-server no arrancó: {e}"));
        }
        *slot = Some(Server { rpc: rpc.clone(), child });
        Ok(rpc)
    }

    pub(crate) fn read_history(&self, app: &AppHandle, thread: &str) -> CmdResult<Value> {
        let rpc = self.rpc(app)?;
        let result = rpc.request("thread/read", json!({ "threadId": thread, "includeTurns": true }), LONG);
        if result.as_ref().is_err_and(|e| e.contains("not materialized") || e == "list_turns is not supported yet") {
            let metadata = rpc.request("thread/read", json!({ "threadId": thread, "includeTurns": false }), SHORT)?;
            if let Some(path) = metadata.pointer("/thread/path").and_then(Value::as_str) {
                let file = std::fs::File::open(path).map_err(err)?;
                let mut lines = BufReader::new(file).lines();
                if let Some(Ok(line)) = lines.next() {
                    if serde_json::from_str::<Value>(&line).is_ok_and(|item| item["type"] == "session_meta") && lines.next().is_none() {
                        return Ok(Value::Null);
                    }
                }
            }
        }
        result
    }

    /// Carga (o crea) el hilo del proyecto. Devuelve el proceso, el id y la
    /// respuesta de `thread/resume` o `thread/start` si hubo que pedirla.
    fn thread(&self, app: &AppHandle, state: &AppState, path: &str, session: Option<&db::Session>, force: bool) -> CmdResult<(Arc<Rpc>, String, Option<Value>)> {
        let _gate = self.thread_gate.lock().map_err(err)?;
        let (saved, legacy_persona, upgrade_from) = match session {
            Some(s) => {
                let current = crate::claude::open_session(state, s.id)?;
                (Some(current.provider_session).filter(|id| !id.is_empty()), false, None)
            }
            None => {
                let conn = state.db.lock().map_err(err)?;
                let (saved, profile) = db::coordinator(&conn, path).map_err(err)?;
                let tools = db::coordinator_tools(&conn, path).map_err(err)?;
                let upgrade_from = saved.clone().filter(|_| tools != crate::delegate::TOOLS_VERSION);
                (saved.filter(|_| tools == crate::delegate::TOOLS_VERSION), profile != "pm", upgrade_from)
            }
        };
        let cwd = session.map(db::Session::cwd).unwrap_or(path);
        let rpc = self.rpc(app)?;
        if let Some(previous) = upgrade_from {
            let history = self.read_history(app, &previous)?;
            crate::chat::archive_tool_upgrade(&mut *state.db.lock().map_err(err)?, path, &previous, &history)?;
        }
        if let Some(id) = &saved {
            if !force && self.shared.lock().map_err(err)?.loaded.contains(id) {
                return Ok((rpc, id.clone(), None));
            }
            let mut params = thread_params(cwd, session.is_some(), crate::skills::RULES);
            params["threadId"] = json!(id);
            match rpc.request("thread/resume", params, LONG) {
                Ok(res) => {
                    if legacy_persona {
                        rpc.request("thread/inject_items", json!({ "threadId": id, "items": [retire_persona()] }), SHORT)?;
                        db::set_coordinator_thread(&*state.db.lock().map_err(err)?, path, Some(id), crate::delegate::TOOLS_VERSION).map_err(err)?;
                    }
                    self.remember(id, &res, session.map(|s| s.id), path)?;
                    return Ok((rpc, id.clone(), Some(res)));
                }
                Err(e) => {
                    let conn = state.db.lock().map_err(err)?;
                    let has_history: bool = conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM task_runs WHERE scope=?1 AND turn IS NOT NULL)",
                        [id], |r| r.get(0),
                    ).map_err(err)?;
                    // Solo sustituimos un hilo sin historial del que el proveedor ya no tiene registro.
                    let missing = e.contains("no rollout") || e.contains("thread not found") || e == "list_turns is not supported yet";
                    if (session.is_some() && (has_history || !missing)) || !rpc.alive() {
                        return Err(e);
                    }
                }
            }
        }
        let mut params = thread_params(cwd, session.is_some(), crate::skills::RULES);
        if session.is_none() {
            params["dynamicTools"] = crate::delegate::specs();
        }
        let res = rpc.request("thread/start", params, LONG)?;
        let id = res.pointer("/thread/id").and_then(Value::as_str).ok_or("codex no devolvió el hilo")?.to_string();
        let conn = state.db.lock().map_err(err)?;
        if let Some(session) = session {
            db::set_provider_session(&conn, session.id, &id).map_err(err)?;
        } else {
            db::set_coordinator_thread(&conn, path, Some(&id), crate::delegate::TOOLS_VERSION).map_err(err)?;
        }
        drop(conn);
        self.remember(&id, &res, session.map(|s| s.id), path)?;
        Ok((rpc, id, Some(res)))
    }

    fn remember(&self, id: &str, reply: &Value, session: Option<i64>, project: &str) -> CmdResult<()> {
        let mut sh = self.shared.lock().map_err(err)?;
        sh.loaded.insert(id.into());
        if let Some(session) = session {
            sh.sessions.insert(id.into(), session);
        } else {
            sh.projects.insert(id.into(), project.into());
        }
        if let Some(model) = reply["model"].as_str() {
            sh.models.insert(id.into(), model.into());
        }
        Ok(())
    }

}

// ── comandos ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    thread_id: String,
    model: Option<String>,
    effort: Option<String>,
    /// Esfuerzos que admite el modelo, de menor a mayor.
    efforts: Vec<String>,
    turns: Value,
    rate_limits: Value,
    /// Turno en marcha, si lo hay (al volver a un proyecto).
    active_turn: Option<String>,
    models: Vec<ModelOption>,
    pinned_model: Option<String>,
}

#[derive(Serialize)]
struct ModelOption {
    id: String,
    label: String,
    efforts: Vec<String>,
    #[serde(skip)]
    is_default: bool,
    #[serde(skip)]
    accepts_text: bool,
}

/// Abre el coordinador del proyecto: comprueba la sesión de Codex, reanuda
/// o crea el hilo y devuelve el historial.
#[tauri::command]
pub async fn coordinator_open(app: AppHandle, project: String, session: Option<i64>) -> CmdResult<Opened> {
    tauri::async_runtime::spawn_blocking(move || {
        let _execution = crate::updates::Execution::enter()?;
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let _gate = state.chat_gate.lock().map_err(err)?;
        let direct = direct_session(&state, &path, session)?;
        ensure_pm_codex(&state, &path, session)?;
        let codex = &state.codex;
        let rpc = codex.rpc(&app)?;
        let account = rpc.request("account/read", json!({}), SHORT)?;
        if account.get("account").is_none_or(Value::is_null) && account["requiresOpenaiAuth"] == json!(true) {
            return Err("Codex no tiene sesión iniciada: ejecuta `codex login` en el terminal y vuelve a abrir el coordinador".into());
        }
        let (rpc, thread_id, res) = codex.thread(&app, &state, &path, direct.as_ref(), true)?;
        let res = res.unwrap_or(Value::Null);
        let catalog = rpc.request("model/list", json!({}), SHORT).ok();
        let available = parse_models(catalog.as_ref());
        let baseline = if direct.is_none() {
            crate::jev::baseline(&*state.db.lock().map_err(err)?, &thread_id).map_err(err)?
        } else {
            None
        };
        let model = baseline.and_then(|id| {
            if catalog.is_none() || available.iter().any(|m| m.id == id) { Some(id) }
            else { available.iter().find(|m| m.is_default).map(|m| m.id.clone()) }
        })
            .or_else(|| res["model"].as_str().map(str::to_string));
        let pinned_model = pinned(&state, &path, session)?;
        let efforts = available.iter().find(|m| Some(m.id.as_str()) == pinned_model.as_deref().or(model.as_deref()))
            .map(|m| m.efforts.clone()).unwrap_or_else(|| EFFORTS[..3].iter().map(|e| e.to_string()).collect());
        let rate_limits = read_rate_limits(&rpc).unwrap_or(Value::Null);
        let mut shared = codex.shared.lock().map_err(err)?;
        shared.quota = runs::Quota::codex(&rate_limits);
        if catalog.is_some() {
            shared.model_efforts = available.iter().map(|m| (m.id.clone(), m.efforts.clone())).collect();
            shared.default_model = available.iter().find(|m| m.is_default).map(|m| m.id.clone());
            shared.low_text_models = available.iter().filter(|m| m.accepts_text && m.efforts.iter().any(|e| e == "low"))
                .map(|m| m.id.clone()).collect();
            shared.low_text_models.sort();
        }
        let active_turn = shared.turns.get(&thread_id).cloned();
        drop(shared);
        Ok(Opened {
            thread_id,
            model,
            effort: res["reasoningEffort"].as_str().map(str::to_string),
            efforts: efforts.into_iter().filter(|e| EFFORTS.contains(&e.as_str())).collect(),
            turns: res.pointer("/thread/turns").cloned().unwrap_or(json!([])),
            rate_limits,
            active_turn,
            models: available,
            pinned_model,
        })
    })
    .await
    .map_err(err)?
}

fn parse_models(catalog: Option<&Value>) -> Vec<ModelOption> {
    catalog.and_then(|v| v["data"].as_array()).into_iter().flatten().filter_map(|model| {
        if model["hidden"] == json!(true) {
            return None;
        }
        let id = model["model"].as_str()?;
        let label = model["displayName"].as_str().unwrap_or(id);
        let efforts = model["supportedReasoningEfforts"].as_array().into_iter().flatten()
            .filter_map(|e| e["reasoningEffort"].as_str().or(e.as_str()))
            .filter(|e| EFFORTS.contains(e)).map(str::to_owned).collect();
        let accepts_text = model["inputModalities"].as_array().is_some_and(|modes| modes.iter().any(|mode| mode == "text"));
        Some(ModelOption { id: id.into(), label: label.into(), efforts, is_default: model["isDefault"] == true, accepts_text })
    }).collect()
}

fn direct_session(state: &AppState, project: &str, session: Option<i64>) -> CmdResult<Option<db::Session>> {
    session.map(|id| {
        let session = crate::claude::open_session(state, id)?;
        if session.project != project || session.engine != "codex" {
            return Err("la conversación Codex no pertenece al proyecto".into());
        }
        Ok(session)
    }).transpose()
}

fn ensure_pm_codex(state: &AppState, project: &str, session: Option<i64>) -> CmdResult<()> {
    if session.is_none() && crate::chat::pm_id(&*state.db.lock().map_err(err)?, project).map_err(err)?.is_some() {
        return Err("el Project manager ha cambiado de proveedor".into());
    }
    Ok(())
}

fn pm_model_key(project: &str) -> String {
    format!("codex.pm.model:{project}")
}

fn pinned(state: &AppState, project: &str, session: Option<i64>) -> CmdResult<Option<String>> {
    let conn = state.db.lock().map_err(err)?;
    match session {
        Some(id) => Ok(db::session_options(&conn, id).map_err(err)?.get("model").and_then(Value::as_str).map(str::to_string)),
        None => Ok(db::get_setting(&conn, &pm_model_key(project)).map_err(err)?.filter(|model| !model.is_empty())),
    }
}

fn failed_start_outcome(error: &str, provider_alive: bool) -> Option<&'static str> {
    match (error, provider_alive) {
        (_, false) => Some("interrupted"),
        ("codex no respondió a turn/start", true) => None,
        _ => Some("failed"),
    }
}

/// Usa el mismo app-server para el PM y las conversaciones directas.
pub(crate) fn send_turn(app: &AppHandle, path: &str, direct: Option<&db::Session>, task: Option<i64>,
    mut message: crate::attachments::Message, effort: Option<String>,
) -> CmdResult<()> {
    let text = &message.text;
    let state = app.state::<AppState>();
    let gate = state.chat_gate.lock().map_err(err)?;
    let git_gate = state.publication.try_lock().map_err(|_| "hay una operación Git en curso; espera a que termine")?;
    let session_id = direct.map(|s| s.id);
    let validated = direct_session(&state, path, session_id)?;
    let direct = validated.as_ref();
    ensure_pm_codex(&state, path, session_id)?;
    let task = {
        let conn = state.db.lock().map_err(err)?;
        let task = match direct {
            Some(s) => tasks::linked(&conn, s.id).map_err(err)?,
            None => task,
        };
        if let Some(task) = task {
            tasks::validate_start(&conn, path, task)?;
        }
        task
    };
    let (rpc, thread_id, _) = state.codex.thread(app, &state, path, direct, false)?;
    let pinned = pinned(&state, path, session_id)?;
    let model_pinned = pinned.is_some();
    let baseline = if direct.is_none() {
        crate::jev::baseline(&*state.db.lock().map_err(err)?, &thread_id).map_err(err)?
    } else {
        None
    };
    let (model, model_override, available, quota) = {
        let shared = state.codex.shared.lock().map_err(err)?;
        // Codex model overrides persist across turns. Restore the baseline on
        // subsequent PM turns, including when Jev is disabled or unavailable.
        let model_override = pinned.or_else(|| baseline.and_then(|id| {
            if shared.model_efforts.is_empty() || shared.model_efforts.contains_key(&id) { Some(id) }
            else { shared.default_model.clone() }
        }));
        let model = model_override.clone().or_else(|| shared.models.get(&thread_id).cloned());
        let available = model.as_ref().and_then(|id| shared.model_efforts.get(id)).cloned().unwrap_or_default();
        (model, model_override, available, shared.quota)
    };
    let automatic = direct.is_none() && task.is_some() && effort.as_deref() == Some("auto");
    let (run, input) = {
        let mut conn = state.db.lock().map_err(err)?;
        let tx = conn.transaction().map_err(err)?;
        let task = if let Some(session) = direct { tasks::linked(&tx, session.id).map_err(err)? } else { task };
        let previous = runs::last_task(&tx, &thread_id).map_err(err)?;
        let run = runs::begin(&tx, path, &thread_id, "codex", direct.map(|s| s.id), task)?;
        let input = runs::task_input(&tx, run, path, task, previous, text)?;
        let input = crate::chat::with_context(&tx, path, session_id, run, input)?;
        let input = crate::skills::with_catalog(app, &tx, path, session_id, input)?;
        runs::quota(&tx, run, quota).map_err(err)?;
        runs::usage(&tx, run, runs::Usage { model: model.clone(), ..Default::default() }).map_err(err)?;
        if let Some(session) = direct {
            db::set_session_task(&tx, session.id, text).map_err(err)?;
            db::set_session_paused(&tx, session.id, None).map_err(err)?;
        }
        tx.commit().map_err(err)?;
        (run, input)
    };
    drop(git_gate);
    drop(gate);
    tasks::changed(app);
    let (effort, model_override) = if automatic {
        crate::jev::route(&state, run, model.as_deref(), &available, !model_pinned && !message.has_images()).ok().and_then(|trace| {
            let mut conn = state.db.lock().ok()?;
            let tx = conn.transaction().ok()?;
            let override_model = if let Some(execution_model) = &trace.execution_model {
                crate::jev::preserve_baseline(&tx, &thread_id, model.as_deref()?).ok()?;
                runs::usage(&tx, run, runs::Usage { model: Some(execution_model.clone()), ..Default::default() }).ok()?;
                Some(execution_model.clone())
            } else {
                model_override.clone()
            };
            crate::jev::record(&tx, run, &trace).ok()?;
            tx.commit().ok()?;
            drop(conn);
            tasks::changed(app);
            Some((trace.effort, override_model))
        }).unwrap_or((None, model_override))
    } else { (effort, model_override) };
    let inputs: Vec<_> = std::iter::once(json!({ "type": "text", "text": input, "text_elements": [] }))
        .chain(message.codex_images()).collect();
    // Keep mutations behind app-server approval requests even in Full Control.
    // Filigranas resolves them through its policy; bypassing the CLI's gate
    // would also bypass the PM, publication and destructive-operation guards.
    let mut params = json!({ "threadId": thread_id, "input": inputs,
        "approvalPolicy": "untrusted", "sandboxPolicy": {"type":"readOnly"}
    });
    if let Some(e) = effort {
        params["effort"] = json!(e);
    }
    let _ = app.emit("coordinator", Event {
        method: "model/selected".into(),
        params: json!({ "threadId": thread_id, "model": model_override.as_ref().or(model.as_ref()) }),
        request_id: None,
    });
    if let Some(model) = model_override {
        params["model"] = json!(model);
    }
    // El servidor puede haber aceptado el turno aunque no llegue su respuesta.
    if let Some(s) = direct {
        state.tracker.started(s.id);
        if s.parent_session.is_some() {
            crate::claude::notify_subsession(app, s.id);
        }
    }
    message.retain_files();
    rpc.request("turn/start", params, LONG).map(|_| ()).map_err(|error| {
        match failed_start_outcome(&error, rpc.alive()) {
            Some(outcome) => {
                if let Some(s) = direct {
                    state.tracker.exited(s.id);
                    if s.parent_session.is_some() {
                        crate::claude::notify_subsession(app, s.id);
                    }
                }
                runs::record(app, |conn| runs::finish(conn, run, outcome).map_err(err));
                error
            }
            // Los eventos del turno o el cierre del proveedor liquidarán la reserva.
            None => "Codex no confirmó el inicio. El ámbito sigue reservado hasta que termine el turno o se reinicie el proveedor.".into(),
        }
    })
}

#[tauri::command]
pub async fn coordinator_send(app: AppHandle, project: String, text: String, effort: Option<String>, session: Option<i64>,
    task: Option<i64>, attachments: Option<Vec<crate::attachments::Attachment>>,
) -> CmdResult<()> {
    let attachments = attachments.unwrap_or_default();
    if text.trim().is_empty() && attachments.is_empty() {
        return Err("mensaje vacío".into());
    }
    // «auto» enruta con Jev en las tareas del PM; fuera de ellas usa el esfuerzo por defecto del modelo.
    let effort = effort.filter(|e| e != "auto" || (session.is_none() && task.is_some()));
    if effort.as_deref().is_some_and(|e| !EFFORTS.contains(&e) && e != "auto") {
        return Err("nivel de esfuerzo no válido".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let direct = direct_session(&state, &path, session)?;
        let message = crate::attachments::Message::prepare(&app.path().app_data_dir().map_err(err)?, text, attachments)?;
        send_turn(&app, &path, direct.as_ref(), task, message, effort)
    })
    .await
    .map_err(err)?
}

pub fn interrupt(app: &AppHandle, thread: &str) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let turn = state.codex.shared.lock().map_err(err)?.turns.get(thread).cloned().ok_or("no hay ningún turno en marcha")?;
    state.codex.rpc(app)?.request("turn/interrupt", json!({ "threadId": thread, "turnId": turn }), SHORT).map(|_| ())
}

#[tauri::command]
pub async fn coordinator_interrupt(app: AppHandle, project: String, session: Option<i64>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let thread = match direct_session(&state, &path, session)? {
            Some(s) => s.provider_session,
            None => db::coordinator(&*state.db.lock().map_err(err)?, &path).map_err(err)?.0.ok_or("no hay conversación")?,
        };
        interrupt(&app, &thread)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn codex_pin_model(app: AppHandle, project: String, session: Option<i64>, model: Option<String>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let _gate = state.chat_gate.lock().map_err(err)?;
        direct_session(&state, &path, session)?;
        ensure_pm_codex(&state, &path, session)?;
        if let Some(model) = &model {
            let rpc = state.codex.rpc(&app)?;
            let catalog = rpc.request("model/list", json!({}), SHORT)?;
            if !parse_models(Some(&catalog)).iter().any(|m| &m.id == model) {
                return Err("el modelo no está disponible".into());
            }
        }
        let conn = state.db.lock().map_err(err)?;
        if let Some(session) = session {
            if runs::session_active(&conn, session).map_err(err)? {
                return Err("espera a que termine el turno".into());
            }
            db::update_session_option(&conn, session, "model", model.as_deref()).map_err(err)
        } else {
            if let Some(thread) = db::coordinator(&conn, &path).map_err(err)?.0 {
                if runs::active(&conn, &thread)?.is_some() {
                    return Err("espera a que termine el turno".into());
                }
            }
            db::set_setting(&conn, &pm_model_key(&path), model.as_deref().unwrap_or_default()).map_err(err)
        }
    }).await.map_err(err)?
}

/// Responde a una petición de aprobación pendiente.
#[tauri::command]
pub fn coordinator_respond(app: AppHandle, state: State<AppState>, request_id: Value, decision: String) -> CmdResult<()> {
    if !DECISIONS.contains(&decision.as_str()) {
        return Err("decisión no válida".into());
    }
    if !state.codex.shared.lock().map_err(err)?.approvals.remove(&request_id.to_string()) {
        return Err("esa petición ya no está pendiente".into());
    }
    let decision = if decision == "acceptForSession" { "accept" } else { decision.as_str() };
    state.codex.rpc(&app)?.respond(request_id, json!({ "decision": decision }))
}

/// Lee la cuota de la cuenta sin abrir ni crear una conversación.
#[tauri::command]
pub async fn codex_rate_limits(app: AppHandle) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let rpc = state.codex.rpc(&app)?;
        read_rate_limits(&rpc)
    }).await.map_err(err)?
}

fn read_rate_limits(rpc: &Rpc) -> CmdResult<Value> {
    let mut response = rpc.request("account/rateLimits/read", Value::Null, SHORT)?;
    let mut limits = response["rateLimits"].take();
    if !limits.is_object() {
        return Err("Codex no devolvió la cuota".into());
    }
    if let Some(allowed) = response["ordinaryUsageAllowed"].as_bool() {
        limits["ordinaryUsageAllowed"] = json!(allowed);
    }
    Ok(limits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::tests::{fake, write};

    #[test]
    fn a_late_codex_start_keeps_the_reservation_until_completion() {
        let mut conn = db::open(std::path::Path::new(":memory:")).unwrap();
        let tx = conn.transaction().unwrap();
        let run = runs::begin(&tx, "/repo", "thread", "codex", None, None).unwrap();
        tx.commit().unwrap();

        let timeout = "codex no respondió a turn/start";
        assert_eq!(failed_start_outcome(timeout, true), None);
        assert_eq!(failed_start_outcome(timeout, false), Some("interrupted"));
        assert_eq!(failed_start_outcome("modelo no disponible", true), Some("failed"));
        assert_eq!(runs::active(&conn, "thread").unwrap(), Some(run));
        Observation::Started("thread".into(), "turn".into()).store(&conn).unwrap();
        Observation::Completed("thread".into(), "turn".into(), "completed", false).store(&conn).unwrap();
        assert_eq!(runs::active(&conn, "thread").unwrap(), None);
    }

    #[test]
    fn rate_limit_read_keeps_the_account_block_even_without_percentages() {
        let (rx, tx) = fake(|msg, w| {
            assert_eq!(msg["method"], "account/rateLimits/read");
            write(w, json!({
                "id": msg["id"],
                "result": {
                    "ordinaryUsageAllowed": false,
                    "rateLimits": { "primary": null, "secondary": null }
                }
            }));
        });
        let rpc = Rpc::start(rx, tx, |_, _| {});
        let limits = read_rate_limits(&rpc).unwrap();
        assert_eq!(limits["ordinaryUsageAllowed"], false);
        assert!(limits["primary"].is_null());
    }

    #[test]
    fn thread_params_ask_before_leaving_the_project() {
        let pm = thread_params("/r/p", false, crate::skills::RULES);
        assert_eq!(
            (pm["cwd"].as_str(), pm["sandbox"].as_str(), pm["approvalPolicy"].as_str()),
            (Some("/r/p"), Some("read-only"), Some("untrusted"))
        );
        let exec = thread_params("/r/p", true, crate::skills::RULES);
        assert_eq!(
            (exec["cwd"].as_str(), exec["sandbox"].as_str(), exec["approvalPolicy"].as_str()),
            (Some("/r/p"), Some("read-only"), Some("untrusted"))
        );
        let text = pm["developerInstructions"].as_str().unwrap();
        assert!(text.contains("Coordinación en Filigranas IDE"));
        assert!(text.contains("Project manager"));
        assert!(text.contains("NUNCA ejecutas trabajo técnico directamente"));
        let switch = retire_persona();
        assert_eq!((switch["role"].as_str(), switch["content"][0]["type"].as_str()), (Some("developer"), Some("input_text")));
        assert!(switch["content"][0]["text"].as_str().unwrap().contains("Project manager"));

        let mut sessions = HashMap::new();
        sessions.insert("exec-t".into(), 1);
        let mut projects = HashMap::new();
        projects.insert("pm-t".into(), "/r/p".into());
        assert!(is_pm_codex_thread(&sessions, &projects, "pm-t"));
        assert!(!is_pm_codex_thread(&sessions, &projects, "exec-t"));
    }

    /// Contra Codex real: necesita sesión iniciada y gasta un turno corto.
    /// `cargo test -- --ignored real_codex_turn`
    #[test]
    #[ignore]
    fn real_codex_turn() {
        let mut child = crate::cli::command("codex")
            .arg("app-server")
            .env("PATH", login_path().unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let (events_tx, events) = channel();
        let rpc = Rpc::start(child.stdout.take().unwrap(), child.stdin.take().unwrap(), move |_, msg| {
            if let Incoming::Notification { method, params } = msg {
                let _ = events_tx.send((method, params));
            }
        });
        rpc.request("initialize", json!({ "clientInfo": { "name": "filigranas-test", "title": null, "version": "0" }, "capabilities": null }), SHORT).unwrap();
        rpc.notify("initialized").unwrap();
        let dir = std::env::temp_dir();
        let mut params = thread_params(dir.to_str().unwrap(), false, crate::skills::RULES);
        params["sandbox"] = json!("read-only");
        params["ephemeral"] = json!(true);
        let thread = rpc.request("thread/start", params, LONG).unwrap();
        let id = thread.pointer("/thread/id").and_then(Value::as_str).unwrap().to_string();
        rpc.request(
            "turn/start",
            json!({ "threadId": id, "effort": "low", "input": [{ "type": "text", "text": "Responde solo con la palabra: hola", "text_elements": [] }] }),
            LONG,
        )
        .unwrap();
        let mut text = String::new();
        loop {
            let (method, params) = events.recv_timeout(LONG).expect("el turno no terminó");
            match method.as_str() {
                "item/agentMessage/delta" => text += params["delta"].as_str().unwrap_or(""),
                "turn/completed" => break,
                _ => {}
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        assert!(text.to_lowercase().contains("hola"), "respuesta: {text:?}");
    }
}
