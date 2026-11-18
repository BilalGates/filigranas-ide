use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{db, err, runs, tasks, workspace::project_path, AppState, CmdResult};

// Coordinador: Codex mediante `codex app-server`, JSON-RPC por stdio con un
// mensaje JSON por línea (sin el campo `jsonrpc`). Un solo proceso para
// toda la app; cada proyecto tiene su hilo, guardado en la base de datos.

// ── transporte ──────────────────────────────────────────────────────────

pub enum Incoming {
    Notification { method: String, params: Value },
    /// Petición del servidor (p. ej. una aprobación) que espera respuesta.
    Request { id: Value, method: String, params: Value },
    Closed,
}

pub struct Rpc {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    next: AtomicU64,
    alive: AtomicBool,
    /// Añadir `"jsonrpc": "2.0"` (ACP lo exige; Codex no lo usa).
    jsonrpc: bool,
}

const CLOSED: &str = "codex app-server se ha cerrado";

impl Rpc {
    /// Arranca el hilo lector. `on` recibe notificaciones y peticiones del
    /// servidor, y `Closed` cuando termina la salida.
    pub fn start(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
        on: impl FnMut(&Rpc, Incoming) + Send + 'static,
    ) -> Arc<Rpc> {
        Self::start_with(reader, writer, on, false)
    }

    /// Igual que `start`, pero con mensajes JSON-RPC 2.0 completos (ACP).
    pub fn start_with(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
        mut on: impl FnMut(&Rpc, Incoming) + Send + 'static,
        jsonrpc: bool,
    ) -> Arc<Rpc> {
        let rpc = Arc::new(Rpc {
            writer: Mutex::new(Box::new(writer)),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            jsonrpc,
        });
        let r = rpc.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    r.dispatch(msg, &mut on);
                }
            }
            r.alive.store(false, Ordering::SeqCst);
            for (_, tx) in r.pending.lock().unwrap_or_else(|p| p.into_inner()).drain() {
                let _ = tx.send(Err(CLOSED.into()));
            }
            on(&r, Incoming::Closed);
        });
        rpc
    }

    fn dispatch(&self, mut msg: Value, on: &mut impl FnMut(&Rpc, Incoming)) {
        let params = msg.get_mut("params").map(Value::take).unwrap_or(Value::Null);
        match (msg.get("method").and_then(Value::as_str), msg.get("id")) {
            (Some(method), Some(id)) => on(self, Incoming::Request { id: id.clone(), method: method.into(), params }),
            (Some(method), None) => on(self, Incoming::Notification { method: method.into(), params }),
            (None, Some(id)) => {
                let Some(tx) = id.as_u64().and_then(|id| self.pending.lock().ok()?.remove(&id)) else { return };
                let res = match msg.get("error") {
                    Some(e) => Err(e.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| e.to_string())),
                    None => Ok(msg.get_mut("result").map(Value::take).unwrap_or(Value::Null)),
                };
                let _ = tx.send(res);
            }
            _ => {}
        }
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn send(&self, msg: &Value) -> CmdResult<()> {
        let mut msg = msg.clone();
        if self.jsonrpc {
            msg["jsonrpc"] = json!("2.0");
        }
        let mut line = serde_json::to_string(&msg).map_err(err)?;
        line.push('\n');
        let mut w = self.writer.lock().map_err(err)?;
        w.write_all(line.as_bytes()).and_then(|_| w.flush()).map_err(|e| format!("{CLOSED}: {e}"))
    }

    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> CmdResult<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        self.pending.lock().map_err(err)?.insert(id, tx);
        // Comprobar después de registrar: si el lector ya terminó, nadie
        // contestaría y solo quedaría esperar al timeout.
        if !self.alive() {
            self.pending.lock().map_err(err)?.remove(&id);
            return Err(CLOSED.into());
        }
        if let Err(e) = self.send(&json!({ "id": id, "method": method, "params": params })) {
            self.pending.lock().map_err(err)?.remove(&id);
            return Err(e);
        }
        rx.recv_timeout(timeout).unwrap_or_else(|_| {
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&id);
            }
            Err(format!("codex no respondió a {method}"))
        })
    }

    pub fn notify(&self, method: &str) -> CmdResult<()> {
        self.send(&json!({ "method": method }))
    }

    pub fn notify_with(&self, method: &str, params: Value) -> CmdResult<()> {
        self.send(&json!({ "method": method, "params": params }))
    }

    pub fn respond(&self, id: Value, result: Value) -> CmdResult<()> {
        self.send(&json!({ "id": id, "result": result }))
    }

    pub fn respond_error(&self, id: Value, message: &str) -> CmdResult<()> {
        self.send(&json!({ "id": id, "error": { "code": -32601, "message": message } }))
    }
}

// ── proceso y estado ────────────────────────────────────────────────────

const PROFILES: [&str; 4] = ["hansi", "pep", "luis-enrique", "cruyff"];
const DECISIONS: [&str; 4] = ["accept", "acceptForSession", "decline", "cancel"];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const APPROVALS: [&str; 2] = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"];
/// Avisos internos del servidor que la interfaz no usa.
const QUIET: [&str; 3] = ["mcpServer/startupStatus/updated", "remoteControl/status/changed", "account/updated"];
const SHORT: Duration = Duration::from_secs(30);
const LONG: Duration = Duration::from_secs(120);

fn persona(profile: &str) -> &'static str {
    match profile {
        "pep" => include_str!("../resources/coordinadores/pep.md"),
        "luis-enrique" => include_str!("../resources/coordinadores/luis-enrique.md"),
        "cruyff" => include_str!("../resources/coordinadores/cruyff.md"),
        _ => include_str!("../resources/coordinadores/hansi.md"),
    }
}

fn instructions(profile: &str, rules: &str) -> String {
    if profile == "direct" {
        return format!("Eres un ejecutor Codex en una conversación directa. Trabaja en esta sesión y sigue las instrucciones del proyecto.\n\n{rules}");
    }
    format!("{}\n\n{rules}\n\n{}", include_str!("../resources/coordinadores/politica.md"), persona(profile))
}

/// Mensaje de desarrollador que cambia el perfil de un hilo ya creado.
/// `thread/resume` no aplica unas instrucciones nuevas a un hilo cargado;
/// inyectado en el historial, el modelo lo ve en los turnos siguientes.
fn profile_switch(profile: &str) -> Value {
    json!({
        "type": "message",
        "role": "developer",
        "content": [{
            "type": "input_text",
            "text": format!("El usuario ha cambiado tu perfil de coordinador. Este perfil sustituye al anterior desde ahora:\n\n{}", persona(profile)),
        }],
    })
}

/// Parámetros comunes de `thread/start` y `thread/resume`: el proyecto como
/// carpeta de trabajo, escritura dentro de él y aprobación para el resto
/// (decisión del usuario del 2026-11-16).
fn thread_params(cwd: &str, profile: &str, rules: &str) -> Value {
    json!({
        "cwd": cwd,
        "sandbox": "workspace-write",
        "approvalPolicy": "on-request",
        "developerInstructions": instructions(profile, rules),
    })
}

/// PATH del shell de login del usuario. Una app abierta desde el Finder
/// hereda un PATH mínimo en el que no están `codex` ni `node`.
/// Programa externo listo para lanzar. En Windows, `Command` solo busca
/// `.exe` en el PATH y las CLI instaladas con npm son `.cmd`: se resuelve la
/// ruta completa a mano. En macOS basta el nombre con el PATH de login.
pub(crate) fn program(name: &str) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let path = login_path().map(std::ffi::OsString::from).or_else(|| std::env::var_os("PATH")).unwrap_or_default();
        for dir in std::env::split_paths(&path) {
            for ext in ["exe", "cmd", "bat"] {
                let candidate = dir.join(format!("{name}.{ext}"));
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    std::path::PathBuf::from(name)
}

pub(crate) fn login_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        #[cfg(unix)]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let out = Command::new(shell).args(["-ilc", "printf '\\n<<%s>>' \"$PATH\""]).stdin(Stdio::null()).output().ok()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let start = text.rfind("<<")? + 2;
            let end = start + text[start..].find(">>")?;
            Some(text[start..end].to_string())
        }
        #[cfg(not(unix))]
        None
    })
    .as_deref()
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
    /// Hilos internos (p. ej. Larry) cuyos avisos espera el núcleo.
    waiters: HashMap<String, Sender<(String, Value)>>,
    models: HashMap<String, String>,
    sessions: HashMap<String, i64>,
    quota: runs::Quota,
    usage_baseline: HashMap<String, (String, runs::Usage)>,
}

enum Observation {
    Started(String, String),
    Completed(String, String, &'static str),
    Usage(String, String, runs::Usage),
    Phase(String, &'static str),
    Quota(runs::Quota),
    Closed,
}

impl Observation {
    fn store(self, conn: &rusqlite::Connection) -> CmdResult<()> {
        match self {
            Self::Started(thread, turn) => runs::bind_turn(conn, &thread, &turn).map_err(err),
            Self::Completed(thread, turn, outcome) => {
                if let Some(run) = runs::for_turn(conn, &thread, &turn).map_err(err)? {
                    runs::finish(conn, run, outcome).map_err(err)?;
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
            Some(Observation::Completed(thread, turn.into(), outcome))
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
    /// Turno único en un hilo efímero de solo lectura, con salida JSON según
    /// `schema`. Devuelve el texto final del agente. Para tareas internas
    /// del IDE como proponer commits.
    /// Si vence `limit`, interrumpe el turno y devuelve un error.
    #[allow(clippy::too_many_arguments)]
    pub fn run_structured(&self, app: &AppHandle, cwd: &str, instructions: &str, prompt: &str, schema: Value, effort: &str, limit: Duration) -> CmdResult<String> {
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
        let mut cmd = Command::new(program("codex"));
        cmd.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(path) = login_path() {
            cmd.env("PATH", path);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
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
                            "turn/started" => state.tracker.started(*id),
                            "turn/completed" => state.tracker.finished(*id, None),
                            "item/agentMessage/delta" => {
                                if let Some(delta) = params["delta"].as_str() {
                                    state.tracker.chunk(*id, delta);
                                }
                            }
                            _ => {}
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
                    sh.approvals.insert(id.to_string());
                    Event { method, params, request_id: Some(id) }
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

    /// Carga (o crea) el hilo del proyecto. Devuelve el proceso, el id y la
    /// respuesta de `thread/resume` o `thread/start` si hubo que pedirla.
    fn thread(&self, app: &AppHandle, state: &AppState, path: &str, session: Option<&db::Session>, force: bool) -> CmdResult<(Arc<Rpc>, String, Option<Value>)> {
        let _gate = self.thread_gate.lock().map_err(err)?;
        let (saved, profile) = match session {
            Some(s) => {
                let current = crate::claude::open_session(state, s.id)?;
                (Some(current.provider_session).filter(|id| !id.is_empty()), "direct".into())
            }
            None => {
                let conn = state.db.lock().map_err(err)?;
                let (saved, profile) = db::coordinator(&conn, path).map_err(err)?;
                let tools = db::coordinator_tools(&conn, path).map_err(err)?;
                (saved.filter(|_| tools == crate::delegate::TOOLS_VERSION), profile)
            }
        };
        let cwd = session.map(db::Session::cwd).unwrap_or(path);
        let rpc = self.rpc(app)?;
        if let Some(id) = &saved {
            if !force && self.shared.lock().map_err(err)?.loaded.contains(id) {
                return Ok((rpc, id.clone(), None));
            }
            let mut params = thread_params(cwd, &profile, &crate::skills::instructions(app));
            params["threadId"] = json!(id);
            match rpc.request("thread/resume", params, LONG) {
                Ok(res) => {
                    self.remember(id, &res, session.map(|s| s.id))?;
                    return Ok((rpc, id.clone(), Some(res)));
                }
                Err(e) => {
                    let conn = state.db.lock().map_err(err)?;
                    let has_history: bool = conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM task_runs WHERE scope=?1 AND turn IS NOT NULL)",
                        [id], |r| r.get(0),
                    ).map_err(err)?;
                    // Solo sustituimos un hilo sin historial del que el proveedor ya no tiene registro.
                    let missing = e.contains("no rollout") || e.contains("thread not found");
                    if (session.is_some() && (has_history || !missing)) || !rpc.alive() {
                        return Err(e);
                    }
                }
            }
        }
        let mut params = thread_params(cwd, &profile, &crate::skills::instructions(app));
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
        self.remember(&id, &res, session.map(|s| s.id))?;
        Ok((rpc, id, Some(res)))
    }

    fn remember(&self, id: &str, reply: &Value, session: Option<i64>) -> CmdResult<()> {
        let mut sh = self.shared.lock().map_err(err)?;
        sh.loaded.insert(id.into());
        if let Some(session) = session {
            sh.sessions.insert(id.into(), session);
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
    profile: String,
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
}

/// Abre el coordinador del proyecto: comprueba la sesión de Codex, reanuda
/// o crea el hilo y devuelve el historial.
#[tauri::command]
pub async fn coordinator_open(app: AppHandle, project: String, session: Option<i64>) -> CmdResult<Opened> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let codex = &state.codex;
        let rpc = codex.rpc(&app)?;
        let account = rpc.request("account/read", json!({}), SHORT)?;
        if account.get("account").is_none_or(Value::is_null) && account["requiresOpenaiAuth"] == json!(true) {
            return Err("Codex no tiene sesión iniciada: ejecuta `codex login` en el terminal y vuelve a abrir el coordinador".into());
        }
        let direct = direct_session(&state, &path, session)?;
        let (rpc, thread_id, res) = codex.thread(&app, &state, &path, direct.as_ref(), true)?;
        let res = res.unwrap_or(Value::Null);
        let model = res["model"].as_str().map(str::to_string);
        let catalog = rpc.request("model/list", json!({}), SHORT).ok();
        let available = parse_models(catalog.as_ref());
        let pinned_model = direct.as_ref().map(|s| pinned(&state, s.id)).transpose()?.flatten();
        let efforts = available.iter().find(|m| Some(m.id.as_str()) == pinned_model.as_deref().or(model.as_deref()))
            .map(|m| m.efforts.clone()).unwrap_or_else(|| EFFORTS[..3].iter().map(|e| e.to_string()).collect());
        let rate_limits = rpc.request("account/rateLimits/read", Value::Null, SHORT).map(|r| r["rateLimits"].clone()).unwrap_or(Value::Null);
        let mut shared = codex.shared.lock().map_err(err)?;
        shared.quota = runs::Quota::codex(&rate_limits);
        let active_turn = shared.turns.get(&thread_id).cloned();
        drop(shared);
        let profile = if direct.is_some() { "direct".into() } else {
            db::coordinator(&*state.db.lock().map_err(err)?, &path).map_err(err)?.1
        };
        Ok(Opened {
            thread_id,
            profile,
            model,
            effort: res["reasoningEffort"].as_str().map(str::to_string),
            efforts: efforts.into_iter().filter(|e| EFFORTS.contains(&e.as_str())).collect(),
            turns: res.pointer("/thread/turns").cloned().unwrap_or(json!([])),
            rate_limits,
            active_turn,
            models: if direct.is_some() { available } else { Vec::new() },
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
        Some(ModelOption { id: id.into(), label: label.into(), efforts })
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

fn pinned(state: &AppState, id: i64) -> CmdResult<Option<String>> {
    let conn = state.db.lock().map_err(err)?;
    Ok(db::session_options(&conn, id).map_err(err)?.get("model").and_then(Value::as_str).map(str::to_string))
}

/// Usa el mismo app-server para el PM y las conversaciones directas.
pub fn send_turn(app: &AppHandle, path: &str, direct: Option<&db::Session>, task: Option<i64>, text: String, effort: Option<String>) -> CmdResult<()> {
    let state = app.state::<AppState>();
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
    let pinned = direct.map(|s| pinned(&state, s.id)).transpose()?.flatten();
    let (model, quota) = {
        let shared = state.codex.shared.lock().map_err(err)?;
        (pinned.clone().or_else(|| shared.models.get(&thread_id).cloned()), shared.quota)
    };
    let (run, input) = {
        let mut conn = state.db.lock().map_err(err)?;
        let tx = conn.transaction().map_err(err)?;
        let task = if let Some(session) = direct { tasks::linked(&tx, session.id).map_err(err)? } else { task };
        let input = match task {
            Some(id) if runs::last_task(&tx, &thread_id).map_err(err)? != Some(id) => tasks::context(&tx, id, &text)?,
            _ => text.clone(),
        };
        let run = runs::begin(&tx, path, &thread_id, "codex", direct.map(|s| s.id), task)?;
        runs::quota(&tx, run, quota).map_err(err)?;
        runs::usage(&tx, run, runs::Usage { model, ..Default::default() }).map_err(err)?;
        if let Some(session) = direct {
            db::set_session_task(&tx, session.id, &text).map_err(err)?;
            db::set_session_paused(&tx, session.id, None).map_err(err)?;
        }
        tx.commit().map_err(err)?;
        (run, input)
    };
    tasks::changed(app);
    let mut params = json!({ "threadId": thread_id, "input": [{ "type": "text", "text": input, "text_elements": [] }] });
    if let Some(e) = effort {
        params["effort"] = json!(e);
    }
    if let Some(model) = pinned {
        params["model"] = json!(model);
    }
    let result = rpc.request("turn/start", params, LONG);
    if result.is_err() {
        let outcome = if rpc.alive() { "failed" } else { "interrupted" };
        runs::record(app, |conn| runs::finish(conn, run, outcome).map_err(err));
    }
    result.map(|_| ())
}

#[tauri::command]
pub async fn coordinator_send(app: AppHandle, project: String, text: String, effort: Option<String>, session: Option<i64>, task: Option<i64>) -> CmdResult<()> {
    if text.trim().is_empty() {
        return Err("mensaje vacío".into());
    }
    if effort.as_deref().is_some_and(|e| !EFFORTS.contains(&e)) {
        return Err("nivel de esfuerzo no válido".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let direct = direct_session(&state, &path, session)?;
        send_turn(&app, &path, direct.as_ref(), task, text, effort)
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
pub async fn codex_pin_model(app: AppHandle, project: String, session: i64, model: Option<String>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        direct_session(&state, &path, Some(session))?;
        if let Some(model) = &model {
            let rpc = state.codex.rpc(&app)?;
            let catalog = rpc.request("model/list", json!({}), SHORT)?;
            if !parse_models(Some(&catalog)).iter().any(|m| &m.id == model) {
                return Err("el modelo no está disponible".into());
            }
        }
        let conn = state.db.lock().map_err(err)?;
        if runs::session_active(&conn, session).map_err(err)? {
            return Err("espera a que termine el turno".into());
        }
        db::update_session_option(&conn, session, "model", model.as_deref()).map_err(err)
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
    state.codex.rpc(&app)?.respond(request_id, json!({ "decision": decision }))
}

/// Cambia el perfil del coordinador. En un hilo existente se inyecta el
/// perfil nuevo en su historial para que el modelo lo aplique ya.
#[tauri::command]
pub async fn coordinator_set_profile(app: AppHandle, project: String, profile: String) -> CmdResult<()> {
    if !PROFILES.contains(&profile.as_str()) {
        return Err("perfil desconocido".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let (thread, current) = db::coordinator(&*state.db.lock().map_err(err)?, &path).map_err(err)?;
        if current == profile {
            return Ok(());
        }
        db::set_coordinator_profile(&*state.db.lock().map_err(err)?, &path, &profile).map_err(err)?;
        if thread.is_some() {
            let (rpc, id, _) = state.codex.thread(&app, &state, &path, None, false)?;
            rpc.request("thread/inject_items", json!({ "threadId": id, "items": [profile_switch(&profile)] }), SHORT)?;
        }
        Ok(())
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{pipe, BufRead, BufReader, PipeReader, PipeWriter};

    /// Servidor falso: lee peticiones y las contesta con `reply`.
    fn fake(reply: impl Fn(&Value, &mut PipeWriter) + Send + 'static) -> (PipeReader, PipeWriter) {
        let (client_rx, mut server_tx) = pipe().unwrap();
        let (server_rx, client_tx) = pipe().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(server_rx).lines() {
                let msg: Value = serde_json::from_str(&line.unwrap()).unwrap();
                reply(&msg, &mut server_tx);
            }
        });
        (client_rx, client_tx)
    }

    fn write(w: &mut PipeWriter, v: Value) {
        writeln!(w, "{v}").unwrap();
    }

    #[test]
    fn requests_notifications_and_server_requests() {
        let (rx, tx) = fake(|msg, w| match msg["method"].as_str() {
            Some("lenta") => {
                // Responde después de la siguiente: el orden no importa.
                std::thread::sleep(Duration::from_millis(50));
                write(w, json!({ "id": msg["id"], "result": "lenta" }));
            }
            Some("rapida") => {
                write(w, json!({ "method": "aviso", "params": { "n": 1 } }));
                write(w, json!({ "id": 99, "method": "item/fileChange/requestApproval", "params": {} }));
                write(w, json!({ "id": msg["id"], "result": "rapida" }));
            }
            Some("falla") => write(w, json!({ "id": msg["id"], "error": { "code": 1, "message": "no" } })),
            // Respuesta a la aprobación: se devuelve como notificación para verla.
            None => write(w, json!({ "method": "respuesta", "params": msg })),
            _ => {}
        });
        let (seen_tx, seen_rx) = channel();
        let rpc = Rpc::start(rx, tx, move |rpc, msg| match msg {
            Incoming::Notification { method, params } => seen_tx.send(format!("{method} {params}")).unwrap(),
            Incoming::Request { id, method, .. } => {
                seen_tx.send(format!("pide {method}")).unwrap();
                rpc.respond(id, json!({ "decision": "decline" })).unwrap();
            }
            Incoming::Closed => {}
        });

        let slow = {
            let rpc = rpc.clone();
            std::thread::spawn(move || rpc.request("lenta", Value::Null, SHORT))
        };
        std::thread::sleep(Duration::from_millis(10));
        assert_eq!(rpc.request("rapida", Value::Null, SHORT).unwrap(), json!("rapida"));
        assert_eq!(slow.join().unwrap().unwrap(), json!("lenta"));
        assert_eq!(rpc.request("falla", Value::Null, SHORT).unwrap_err(), "no");

        let seen: Vec<String> = (0..3).map(|_| seen_rx.recv_timeout(SHORT).unwrap()).collect();
        assert_eq!(seen[0], r#"aviso {"n":1}"#);
        assert_eq!(seen[1], "pide item/fileChange/requestApproval");
        assert_eq!(seen[2], r#"respuesta {"id":99,"result":{"decision":"decline"}}"#);
    }

    #[test]
    fn closing_fails_pending_and_new_requests() {
        let (client_rx, server_tx) = pipe().unwrap();
        let (_server_rx, client_tx) = pipe().unwrap(); // nadie contesta
        let (closed_tx, closed_rx) = channel();
        let rpc = Rpc::start(client_rx, client_tx, move |_, msg| {
            if matches!(msg, Incoming::Closed) {
                closed_tx.send(()).unwrap();
            }
        });
        assert_eq!(rpc.request("x", Value::Null, Duration::from_millis(30)).unwrap_err(), "codex no respondió a x");
        let waiting = {
            let rpc = rpc.clone();
            std::thread::spawn(move || rpc.request("y", Value::Null, SHORT))
        };
        std::thread::sleep(Duration::from_millis(30));
        drop(server_tx); // el proceso termina
        assert_eq!(waiting.join().unwrap().unwrap_err(), CLOSED);
        closed_rx.recv_timeout(SHORT).unwrap();
        assert!(!rpc.alive());
        assert_eq!(rpc.request("z", Value::Null, SHORT).unwrap_err(), CLOSED);
    }

    #[test]
    fn thread_params_ask_before_leaving_the_project() {
        let p = thread_params("/r/p", "pep", crate::skills::RULES);
        assert_eq!((p["cwd"].as_str(), p["sandbox"].as_str(), p["approvalPolicy"].as_str()), (Some("/r/p"), Some("workspace-write"), Some("on-request")));
        let text = p["developerInstructions"].as_str().unwrap();
        assert!(text.contains("Coordinación en Filigranas IDE") && text.contains("Pep Guardiola"));
        assert!(instructions("desconocido", crate::skills::RULES).contains("Hansi Flick"));
        let switch = profile_switch("cruyff");
        assert_eq!((switch["role"].as_str(), switch["content"][0]["type"].as_str()), (Some("developer"), Some("input_text")));
        assert!(switch["content"][0]["text"].as_str().unwrap().contains("Johan Cruyff"));
    }

    #[test]
    fn timeout_discards_late_response_and_auth_errors_are_delivered() {
        let (rx, tx) = fake(|msg, w| {
            if msg["method"] == "slow" {
                std::thread::sleep(Duration::from_millis(40));
                write(w, json!({ "id": msg["id"], "result": "late" }));
            } else {
                write(w, json!({ "id": msg["id"], "error": { "code": 401, "message": "credentials expired" } }));
            }
        });
        let rpc = Rpc::start(rx, tx, |_, _| {});
        assert!(rpc.request("slow", Value::Null, Duration::from_millis(5)).unwrap_err().contains("no respondió"));
        assert!(rpc.pending.lock().unwrap().is_empty());
        assert_eq!(rpc.request("next", Value::Null, Duration::from_secs(1)).unwrap_err(), "credentials expired");
        assert!(rpc.pending.lock().unwrap().is_empty());
    }

    /// Contra Codex real: necesita sesión iniciada y gasta un turno corto.
    /// `cargo test -- --ignored real_codex_turn`
    #[test]
    #[ignore]
    fn real_codex_turn() {
        let mut child = Command::new("codex")
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
        let mut params = thread_params(dir.to_str().unwrap(), "hansi", crate::skills::RULES);
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
