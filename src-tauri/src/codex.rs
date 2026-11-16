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

use crate::{db, err, workspace::project_path, AppState, CmdResult};

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

fn instructions(profile: &str) -> String {
    let persona = match profile {
        "pep" => include_str!("../resources/coordinadores/pep.md"),
        "luis-enrique" => include_str!("../resources/coordinadores/luis-enrique.md"),
        "cruyff" => include_str!("../resources/coordinadores/cruyff.md"),
        _ => include_str!("../resources/coordinadores/hansi.md"),
    };
    format!("{}\n\n{}", include_str!("../resources/coordinadores/politica.md"), persona)
}

/// Parámetros comunes de `thread/start` y `thread/resume`: el proyecto como
/// carpeta de trabajo, escritura dentro de él y aprobación para el resto
/// (decisión del usuario del 2026-11-16).
fn thread_params(cwd: &str, profile: &str) -> Value {
    json!({
        "cwd": cwd,
        "sandbox": "workspace-write",
        "approvalPolicy": "on-request",
        "developerInstructions": instructions(profile),
    })
}

/// PATH del shell de login del usuario. Una app abierta desde el Finder
/// hereda un PATH mínimo en el que no están `codex` ni `node`.
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
}

#[derive(Default)]
pub struct Codex {
    server: Mutex<Option<Server>>,
    shared: Arc<Mutex<Shared>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Event {
    method: String,
    params: Value,
    request_id: Option<Value>,
}

impl Codex {
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
        let mut cmd = Command::new("codex");
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
                    match method.as_str() {
                        "turn/started" => {
                            if let Some(turn) = params.pointer("/turn/id").and_then(Value::as_str) {
                                sh.turns.insert(thread, turn.into());
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
                    if !APPROVALS.contains(&method.as_str()) {
                        // Sin soporte todavía: contestar para que Codex no espere.
                        let _ = rpc.respond_error(id, "Filigranas no admite esta petición todavía");
                        return;
                    }
                    sh.approvals.insert(id.to_string());
                    Event { method, params, request_id: Some(id) }
                }
                Incoming::Closed => {
                    *sh = Shared::default();
                    Event { method: "server/closed".into(), params: Value::Null, request_id: None }
                }
            };
            drop(sh);
            let _ = handle.emit("coordinator", event);
        });

        let init = rpc.request(
            "initialize",
            json!({
                "clientInfo": { "name": "filigranas", "title": "Filigranas", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": false, "requestAttestation": false },
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
    fn thread(&self, app: &AppHandle, state: &AppState, path: &str, force: bool) -> CmdResult<(Arc<Rpc>, String, Option<Value>)> {
        let (saved, profile) = db::coordinator(&*state.db.lock().map_err(err)?, path).map_err(err)?;
        let rpc = self.rpc(app)?;
        if let Some(id) = &saved {
            if !force && self.shared.lock().map_err(err)?.loaded.contains(id) {
                return Ok((rpc, id.clone(), None));
            }
            let mut params = thread_params(path, &profile);
            params["threadId"] = json!(id);
            if let Ok(res) = rpc.request("thread/resume", params, LONG) {
                self.shared.lock().map_err(err)?.loaded.insert(id.clone());
                return Ok((rpc, id.clone(), Some(res)));
            }
            // Un hilo sin turnos no llega a guardarse en disco: empezar otro.
        }
        let res = rpc.request("thread/start", thread_params(path, &profile), LONG)?;
        let id = res.pointer("/thread/id").and_then(Value::as_str).ok_or("codex no devolvió el hilo")?.to_string();
        db::set_coordinator_thread(&*state.db.lock().map_err(err)?, path, Some(&id)).map_err(err)?;
        self.shared.lock().map_err(err)?.loaded.insert(id.clone());
        Ok((rpc, id, Some(res)))
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
}

/// Abre el coordinador del proyecto: comprueba la sesión de Codex, reanuda
/// o crea el hilo y devuelve el historial.
#[tauri::command]
pub async fn coordinator_open(app: AppHandle, project: String) -> CmdResult<Opened> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let codex = &state.codex;
        let rpc = codex.rpc(&app)?;
        let account = rpc.request("account/read", json!({}), SHORT)?;
        if account.get("account").is_none_or(Value::is_null) && account["requiresOpenaiAuth"] == json!(true) {
            return Err("Codex no tiene sesión iniciada: ejecuta `codex login` en el terminal y vuelve a abrir el coordinador".into());
        }
        let (rpc, thread_id, res) = codex.thread(&app, &state, &path, true)?;
        let res = res.unwrap_or(Value::Null);
        let model = res["model"].as_str().map(str::to_string);
        let efforts: Vec<String> = rpc
            .request("model/list", json!({}), SHORT)
            .ok()
            .and_then(|list| {
                let m = list["data"].as_array()?.iter().find(|m| m["model"].as_str() == model.as_deref())?.clone();
                Some(m["supportedReasoningEfforts"].as_array()?.iter().filter_map(|e| e["reasoningEffort"].as_str().or(e.as_str())).map(str::to_string).collect())
            })
            .unwrap_or_else(|| EFFORTS[..3].iter().map(|e| e.to_string()).collect());
        let rate_limits = rpc.request("account/rateLimits/read", Value::Null, SHORT).map(|r| r["rateLimits"].clone()).unwrap_or(Value::Null);
        let (_, profile) = db::coordinator(&*state.db.lock().map_err(err)?, &path).map_err(err)?;
        let active_turn = codex.shared.lock().map_err(err)?.turns.get(&thread_id).cloned();
        Ok(Opened {
            thread_id,
            profile,
            model,
            effort: res["reasoningEffort"].as_str().map(str::to_string),
            efforts: efforts.into_iter().filter(|e| EFFORTS.contains(&e.as_str())).collect(),
            turns: res.pointer("/thread/turns").cloned().unwrap_or(json!([])),
            rate_limits,
            active_turn,
        })
    })
    .await
    .map_err(err)?
}

/// Envía un mensaje al coordinador. El turno avanza por eventos.
#[tauri::command]
pub async fn coordinator_send(app: AppHandle, project: String, text: String, effort: Option<String>) -> CmdResult<()> {
    if text.trim().is_empty() {
        return Err("mensaje vacío".into());
    }
    if effort.as_deref().is_some_and(|e| !EFFORTS.contains(&e)) {
        return Err("nivel de esfuerzo no válido".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let (rpc, thread_id, _) = state.codex.thread(&app, &state, &path, false)?;
        let mut params = json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": text, "text_elements": [] }],
        });
        if let Some(e) = effort {
            params["effort"] = json!(e);
        }
        rpc.request("turn/start", params, LONG).map(|_| ())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn coordinator_interrupt(app: AppHandle, project: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let (thread, _) = db::coordinator(&*state.db.lock().map_err(err)?, &path).map_err(err)?;
        let thread = thread.ok_or("no hay conversación")?;
        let turn = state.codex.shared.lock().map_err(err)?.turns.get(&thread).cloned().ok_or("no hay ningún turno en marcha")?;
        state.codex.rpc(&app)?.request("turn/interrupt", json!({ "threadId": thread, "turnId": turn }), SHORT).map(|_| ())
    })
    .await
    .map_err(err)?
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

/// Cambia el perfil del coordinador. Se aplica al volver a abrirlo.
#[tauri::command]
pub fn coordinator_set_profile(state: State<AppState>, project: String, profile: String) -> CmdResult<()> {
    if !PROFILES.contains(&profile.as_str()) {
        return Err("perfil desconocido".into());
    }
    let conn = state.db.lock().map_err(err)?;
    let path = project_path(&conn, &project)?;
    db::set_coordinator_profile(&conn, &path, &profile).map_err(err)
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
        let p = thread_params("/r/p", "pep");
        assert_eq!((p["cwd"].as_str(), p["sandbox"].as_str(), p["approvalPolicy"].as_str()), (Some("/r/p"), Some("workspace-write"), Some("on-request")));
        let text = p["developerInstructions"].as_str().unwrap();
        assert!(text.contains("Coordinación en Filigranas IDE") && text.contains("Pep Guardiola"));
        assert!(instructions("desconocido").contains("Hansi Flick"));
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
        let mut params = thread_params(dir.to_str().unwrap(), "hansi");
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
