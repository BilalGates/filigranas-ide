use std::collections::HashMap;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::cli::{login_path, program};
use crate::rpc::{Incoming, Rpc};
use crate::{db, err, AppState, CmdResult};

// Agentes por ACP (Agent Client Protocol): OpenCode, Antigravity y Devin.
// JSON-RPC 2.0 por stdio, un proceso por sesión. El cliente no ofrece
// acceso a archivos ni terminal: cada agente usa sus propias herramientas y
// pide permiso con `session/request_permission`.

pub const ENGINES: [&str; 3] = ["opencode", "agy", "devin"];
const INIT: Duration = Duration::from_secs(90);
const TURN: Duration = Duration::from_secs(24 * 3600);

fn auth_hint(engine: &str) -> &'static str {
    match engine {
        "opencode" => "ejecuta `opencode auth login` en el terminal",
        "agy" => "abre `agy` en el terminal e inicia sesión con Google",
        "devin" => "ejecuta `devin auth login` en el terminal",
        _ => "inicia sesión en la CLI del agente",
    }
}

/// Mensaje de error con la pista de inicio de sesión si es un fallo de auth.
fn explain(engine: &str, message: String) -> String {
    let lower = message.to_lowercase();
    if lower.contains("auth") || lower.contains("login") || lower.contains("sign in") {
        format!("{message}: {}", auth_hint(engine))
    } else {
        message
    }
}

/// Opción de permiso para una decisión del IDE, por orden de preferencia.
/// `None` significa responder «cancelled».
fn pick_option(options: &Value, decision: &str) -> Option<String> {
    let prefs: &[&str] = match decision {
        "accept" => &["allow_once", "allow_always"],
        "acceptForSession" => &["allow_always", "allow_once"],
        "decline" => &["reject_once", "reject_always"],
        _ => &[],
    };
    let options = options.as_array()?;
    prefs.iter().find_map(|kind| options.iter().find(|o| o["kind"].as_str() == Some(kind))?["optionId"].as_str().map(str::to_string))
}

struct Proc {
    rpc: Arc<Rpc>,
    _child: crate::cli::ChildProcess,
    session_id: String,
    /// Agente lanzado (`opencode`, `agy`, `devin`).
    engine: String,
    /// Opciones que ofrece el agente (`configOptions` de ACP).
    config: Value,
    history: Arc<Mutex<Vec<Value>>>,
    last_used: std::time::Instant,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

/// Categorías de opción que el IDE deja cambiar. El modo queda fuera: en
/// algunos agentes incluye saltarse los permisos.
const EDITABLE: [&str; 2] = ["model", "thought_level"];

/// Comprueba que la opción existe, es editable y admite ese valor.
fn allowed(config: &Value, id: &str, value: &str) -> bool {
    config.as_array().into_iter().flatten().any(|o| {
        o["id"].as_str() == Some(id)
            && o["category"].as_str().is_some_and(|c| EDITABLE.contains(&c))
            && o["options"].as_array().into_iter().flatten().any(|x| x["value"].as_str() == Some(value))
    })
}

/// Solo las opciones editables, para la interfaz.
fn editable(config: &Value) -> Value {
    Value::Array(config.as_array().into_iter().flatten().filter(|o| o["category"].as_str().is_some_and(|c| EDITABLE.contains(&c))).cloned().collect())
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.rpc.notify_with("session/cancel", json!({ "sessionId": self.session_id }));
        self.rpc.close_input();

    }
}

type Slot = Arc<Mutex<Option<Proc>>>;
/// Clave «sesión:id» → (sesión, id JSON de la petición, opciones).
type Pending = Arc<Mutex<HashMap<String, (i64, Value, Value)>>>;

#[derive(Default)]
pub struct Acp {
    procs: Mutex<HashMap<i64, Slot>>,
    /// Permisos sin contestar.
    pending: Pending,
}

#[derive(Serialize, Clone)]
struct Event {
    id: i64,
    msg: Value,
}

impl Acp {
    fn admit(&self, state: &AppState, current: i64) -> CmdResult<()> {
        let limit = crate::providers::concurrency_limit(&*state.db.lock().map_err(err)?,"agy");
        let mut busy = 0;
        let mut idle = Vec::new();
        let procs = self.procs.lock().map_err(err)?;
        for (id,slot) in procs.iter().filter(|(id,_)| **id != current) {
            match slot.try_lock() {
                Ok(mut guard) => {
                    if guard.as_ref().is_some_and(|p|p.engine=="agy" && p.rpc.alive()) {
                        if !state.tracker.get(*id).running && self.pending_for(*id)==0 { idle.extend(guard.take()); }
                        else { busy+=1; }
                    }
                }
                Err(_) => busy+=1,
            }
        }
        drop(procs);
        drop(idle);
        if busy >= limit { Err("Antigravity alcanzó su límite de procesos activos; espera a que termine una ejecución".into()) } else { Ok(()) }
    }

    /// Permisos sin contestar de una sesión.
    pub fn pending_for(&self, id: i64) -> usize {
        self.pending.lock().map(|p| p.values().filter(|(sid, _, _)| *sid == id).count()).unwrap_or(0)
    }

    /// Si hay un proceso vivo o arrancando (cerrojo ocupado) del agente `engine`.
    pub fn running(&self, engine: &str) -> bool {
        let Ok(procs) = self.procs.try_lock() else { return true };
        procs.values().any(|slot| match slot.try_lock() {
            Ok(p) => p.as_ref().is_some_and(|p| p.engine == engine && p.rpc.alive()),
            Err(_) => true,
        })
    }

    fn slot(&self, id: i64) -> CmdResult<Slot> {
        Ok(self.procs.lock().map_err(err)?.entry(id).or_default().clone())
    }

    /// Proceso y sesión del agente, arrancándolo y cargando la sesión si hace
    /// falta. La carga reproduce el historial como `session/update`.
    fn ensure(&self, app: &AppHandle, state: &AppState, session: &db::Session) -> CmdResult<(Arc<Rpc>, String)> {
        let slot = self.slot(session.id)?;
        let mut guard = slot.lock().map_err(err)?;
        if let Some(p) = guard.as_mut() {
            if p.rpc.alive() {
                p.last_used = std::time::Instant::now();
                return Ok((p.rpc.clone(), p.session_id.clone()));
            }
        }
        *guard = None;

        let engine = session.engine.as_str();
        if engine == "agy" { self.admit(state,session.id)?; }
        let agy_root = (engine == "agy").then(|| crate::antigravity::root(app, session)).transpose()?;
        let mut cmd = match &agy_root {
            Some(root) => crate::antigravity::command(app, session, root)?,
            None => crate::cli::command(program(engine)),
        };
        cmd.arg("acp");
        if engine == "agy" {
            crate::antigravity::configure(&mut cmd, agy_root.as_ref().ok_or("sin perfil de Antigravity")?, crate::antigravity::reader(session))?;
        }
        #[cfg(unix)] { use std::os::unix::process::CommandExt; cmd.process_group(0); }
        cmd.current_dir(session.cwd()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(path) = login_path() {
            cmd.env("PATH", path);
        }
        let mut child = crate::cli::ChildProcess(cmd.spawn().map_err(|e| format!("no se pudo arrancar {engine} ({e}); comprueba que está instalado"))?);
        let (stdout, stdin) = (child.stdout.take().ok_or("sin salida del agente")?, child.stdin.take().ok_or("sin entrada del agente")?);

        let (id, handle, pending) = (session.id, app.clone(), self.pending.clone());
        let cwd = std::path::PathBuf::from(session.cwd());
        let controlled = engine == "agy";
        let read_only = crate::antigravity::reader(session);
        let skill_roots: Vec<std::path::PathBuf> = [
            app.path().resource_dir().ok().map(|p|p.join("src-tauri/resources/skills")),
            cfg!(dev).then(||std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/skills"))
        ].into_iter().flatten().filter(|p|p.is_dir()).collect();
        let history = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = history.clone();
        let emit = move |msg: Value| {
            let _ = handle.emit("session", Event { id, msg });
        };
        let on_emit = emit.clone();
        let tracker_handle = app.clone();
        let rpc = Rpc::start_with(
            stdout,
            stdin,
            move |rpc, msg| match msg {
                Incoming::Notification { method, params } => {
                    if method == "session/update" {
                        let update = &params["update"];
                        if visible_update(update) {
                            if let Ok(mut h) = captured.lock() { h.push(update.clone()); }
                        }
                        if update["sessionUpdate"] == json!("agent_message_chunk") {
                            if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                                tracker_handle.state::<AppState>().tracker.chunk(id, text);
                            }
                        }
                        if update["sessionUpdate"] == "usage_update" {
                            crate::runs::on_active(&tracker_handle, id, |conn, run| crate::runs::usage(conn, run, crate::runs::Usage::acp(update)));
                        }
                        on_emit(json!({ "type": "update", "update": update }));
                    }
                }
                Incoming::Request { id: rid, method, params } => {
                    if method != "session/request_permission" {
                        let _ = rpc.respond_error(rid, "Filigranas no ofrece este método");
                        return;
                    }
                    let (request_kind, request_paths) = crate::autoapprove::acp_request(&params["toolCall"]);
                    let skill_read = request_kind == crate::autoapprove::Kind::Read && !request_paths.is_empty()
                        && request_paths.iter().all(|p|skill_roots.iter().any(|root|crate::autoapprove::inside(root,p)));
                    if controlled && !skill_read && !crate::antigravity::permits(&cwd, &params["toolCall"], read_only) {
                        let _ = rpc.respond(rid, json!({ "outcome": { "outcome": "cancelled" } }));
                        on_emit(json!({ "type": "policy_denied", "message": "La herramienta excede el alcance autorizado de esta sesión." }));
                        return;
                    }
                    // Nivel de permisos de la sesión: Filigranas puede aprobar por su cuenta.
                    let mode = tracker_handle.state::<AppState>().permissions.get(id);
                    let (kind, paths) = crate::autoapprove::acp_request(&params["toolCall"]);
                    if (!controlled || kind != crate::autoapprove::Kind::Other) && crate::autoapprove::approves(mode, &cwd, kind, &paths) {
                        if let Some(option) = pick_option(&params["options"], "accept") {
                            let _ = rpc.respond(rid, json!({ "outcome": { "outcome": "selected", "optionId": option } }));
                            on_emit(json!({ "type": "auto_approved", "toolCall": params["toolCall"] }));
                            return;
                        }
                    }
                    let key = format!("{id}:{rid}");
                    if let Ok(mut p) = pending.lock() {
                        p.insert(key.clone(), (id, rid, params["options"].clone()));
                    }
                    crate::runs::on_active(&tracker_handle, id, |conn, run| crate::runs::phase(conn, run, "waiting_approval"));
                    on_emit(json!({ "type": "permission", "requestId": key, "toolCall": params["toolCall"], "options": params["options"] }));
                }
                Incoming::Closed => {
                    if let Ok(mut p) = pending.lock() {
                        p.retain(|_, (sid, _, _)| *sid != id);
                    }
                    tracker_handle.state::<AppState>().tracker.exited(id);
                    on_emit(json!({ "type": "exit" }));
                }
            },
            true,
        );

        let fail = |child: &mut Child, e: String| {
            let _ = child.kill();
            let _ = child.wait();
            explain(engine, e)
        };
        let init = rpc.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": "filigranas", "title": "Filigranas", "version": env!("CARGO_PKG_VERSION") },
            }),
            INIT,
        );
        let init = match init {
            Ok(v) => v,
            Err(e) => return Err(fail(&mut child, format!("{engine} no arrancó: {e}"))),
        };
        if init["protocolVersion"] != 1 { return Err(fail(&mut child, "versión ACP incompatible".into())); }
        let can_load = init.pointer("/agentCapabilities/loadSession") == Some(&json!(true));
        let base = json!({ "cwd": session.cwd(), "mcpServers": [] });

        // A failed recovery must never replace the provider identity.
        let (session_id, res) = if !session.provider_session.is_empty() {
            if !can_load { return Err(fail(&mut child, "el proveedor no permite recuperar esta conversación; se conserva su identidad".into())); }
            let mut params = base.clone();
            params["sessionId"] = json!(session.provider_session);
            emit(json!({ "type": "replay" }));
            match rpc.request("session/load", params, INIT) {
                Ok(res) => (session.provider_session.clone(), res),
                Err(e) => return Err(fail(&mut child, format!("no se pudo recuperar la conversación; vuelve a intentarlo sin cambiar de sesión: {e}"))),
            }
        } else {
            let res = match rpc.request("session/new", base, INIT) {
                Ok(v) => v,
                Err(e) => return Err(fail(&mut child, e)),
            };
            let Some(sid) = res["sessionId"].as_str().filter(|id| !id.is_empty()) else {
                return Err(fail(&mut child, "el agente no devolvió la sesión".into()));
            };
            if let Err(e) = db::set_provider_session(&*state.db.lock().map_err(err)?, session.id, sid) {
                return Err(fail(&mut child, err(e)));
            }
            (sid.to_string(), res)
        };
        // Reaplicar lo elegido antes en el IDE (sobrevive a reinicios).
        let mut config = res["configOptions"].clone();
        let chosen = db::session_options(&*state.db.lock().map_err(err)?, session.id).map_err(err)?;
        for (key, value) in chosen {
            let Some(value) = value.as_str() else { continue };
            if !allowed(&config, &key, value) {
                if engine == "agy" && matches!(key.as_str(),"model"|"thought_level") {
                    return Err(fail(&mut child,format!("la opción guardada {key} ya no está disponible; se conserva la conversación")));
                }
                continue;
            }
            if let Ok(r) = rpc.request("session/set_config_option", json!({ "sessionId": session_id, "configId": key, "value": value }), INIT) {
                if r.get("configOptions").is_some() {
                    config = r["configOptions"].clone();
                }
            }
        }
        if engine == "agy" {
            // An untrusted persisted/native mode must not bypass strict review.
            if let Err(e) = rpc.request("session/set_config_option", json!({"sessionId":session_id,"configId":"mode","value":"default"}), INIT) {
                return Err(fail(&mut child, format!("no se pudo fijar el modo seguro: {e}")));
            }
        }
        if engine == "agy" {
            let old = crate::providers::health(&*state.db.lock().map_err(err)?,engine);
            crate::providers::observe(app, crate::providers::Health {id:engine.into(),connected:Some(true),observed_at:crate::providers::now(),message:"Cuenta conectada mediante ACP".into(),config:config.clone(),capabilities:init["agentCapabilities"].clone(),..old})?;
        }
        // Modelo actual, para la cabecera.
        let model = config
            .as_array()
            .and_then(|opts| opts.iter().find(|o| o["category"] == json!("model")))
            .and_then(|o| {
                let current = o["currentValue"].as_str()?;
                let name = o["options"].as_array()?.iter().find(|x| x["value"].as_str() == Some(current)).and_then(|x| x["name"].as_str());
                Some(name.unwrap_or(current).to_string())
            })
            .or_else(|| res.pointer("/models/currentModelId").and_then(Value::as_str).map(str::to_string));
        emit(json!({ "type": "ready", "model": model, "options": editable(&config) }));

        store_history(state, session.id, &history, &config)?;
        *guard = Some(Proc { rpc: rpc.clone(), _child: child, engine: engine.to_string(), session_id: session_id.clone(), config, history, last_used: std::time::Instant::now(), cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)) });
        Ok((rpc, session_id))
    }

    /// Arranca (o reanuda) la sesión para pintar su historial.
    pub fn attach(&self, app: &AppHandle, state: &AppState, session: &db::Session) -> CmdResult<()> {
        // A running transcript belongs to the backend, independently of the view.
        let live = {
            let slot = self.slot(session.id)?;
            let guard = slot.lock().map_err(err)?;
            guard.as_ref().filter(|p| p.rpc.alive()).map(|p| (p.history.lock().map(|h| h.clone()).unwrap_or_default(), p.config.clone()))
        };
        // Reopening an idle view reads SQLite and does not start a CLI process.
        let cached = if live.is_some() { None } else {
            let conn = state.db.lock().map_err(err)?;
            read_history(&conn, session.id)?
        };
        if let Some((events, config)) = live.or(cached) {
            let emit = |msg: Value| { let _ = app.emit("session", Event { id:session.id, msg }); };
            emit(json!({"type":"replay"}));
            for update in events { emit(json!({"type":"update","update":update})); }
            emit(json!({"type":"ready","options":editable(&config),"running":state.tracker.get(session.id).running}));
            Ok(())
        } else { self.ensure(app, state, session).map(|_| ()) }
    }

    /// Envía el mensaje. El turno termina cuando responde `session/prompt`.
    pub fn send(&self, app: &AppHandle, state: &AppState, session: &db::Session, text: String, run: i64, effort: Option<&str>) -> CmdResult<()> {
        let (rpc, sid) = self.ensure(app, state, session)?;
        let (id, handle, engine) = (session.id, app.clone(), session.engine.clone());
        let slot = self.slot(id)?;
        let (history, config, cancelled) = {
            let mut guard = slot.lock().map_err(err)?;
            let proc = guard.as_mut().ok_or("la sesión no está en marcha")?;
            if engine == "agy" {
                if let Some(value) = effort.filter(|value| *value != "auto") {
                    let key = proc.config.as_array().and_then(|options|options.iter().find(|o|o["category"]=="thought_level")).and_then(|o|o["id"].as_str()).ok_or("este modelo no ofrece selección de razonamiento")?.to_string();
                    if !allowed(&proc.config,&key,value) { return Err("el nivel de razonamiento delegado no está disponible para este modelo".into()); }
                    let updated=proc.rpc.request("session/set_config_option",json!({"sessionId":sid,"configId":key,"value":value}),INIT)?;
                    if updated["configOptions"].is_array() { proc.config=updated["configOptions"].clone(); }
                    db::set_session_option(&*state.db.lock().map_err(err)?,id,&key,value).map_err(err)?;
                }
            }
            (proc.history.clone(), proc.config.clone(), proc.cancelled.clone())
        };
        if let Ok(mut h) = history.lock() { h.push(json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":text}})); }
        store_history(state, id, &history, &config)?;
        let model = slot.lock().map_err(err)?.as_ref().and_then(|p| {
            p.config.as_array()?.iter().find(|o| o["category"] == "model")?["currentValue"].as_str().map(str::to_owned)
        });
        crate::runs::record(app, |conn| crate::runs::usage(conn, run, crate::runs::Usage { model, ..Default::default() }).map_err(err));
        cancelled.store(false,std::sync::atomic::Ordering::SeqCst);
        state.tracker.started(id);
        crate::claude::notify_subsession(app, id);
        std::thread::spawn(move || {
            let tracker = &handle.state::<AppState>().tracker;
            let result = rpc.request("session/prompt", json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": text }] }), TURN);
            let stored = store_history(&handle.state::<AppState>(), id, &history, &config);
            let result = stored.and(result);
            let msg = match result {
                Ok(res) => {
                    crate::runs::record(&handle, |conn| crate::runs::usage(conn, run, crate::runs::Usage::acp_result(&res)).map_err(err));
                    let quota = if engine == "agy" { history.lock().ok().and_then(|h| quota_notice(&result_text(&h))) } else { None };
                    let outcome = match res["stopReason"].as_str() {
                        _ if quota.is_some() => "paused_quota",
                        Some("end_turn") => "completed",
                        Some("cancelled") => "cancelled",
                        _ => "failed",
                    };
                    crate::runs::record(&handle, |conn| crate::runs::finish(conn, run, outcome).map_err(err));
                    tracker.finished(id, None);
                    crate::claude::notify_subsession(&handle, id);
                    if let Some(reason) = quota {
                        crate::handoff::pause(&handle, id, &reason);
                        let mut health = crate::providers::health(&handle.state::<AppState>().db.lock().unwrap_or_else(|p| p.into_inner()),"agy");
                        health.quota_model = config.as_array().and_then(|o| o.iter().find(|o| o["category"]=="model")).and_then(|o| o["currentValue"].as_str()).map(str::to_owned);
                        health.quota_observed_at = Some(crate::providers::now());
                        health.message = "Cuota agotada para el modelo utilizado; cuota agregada desconocida".into();
                        let _ = crate::providers::observe(&handle,health);
                        json!({"type":"error","message":reason})
                    } else {
                        if engine == "agy" && res.pointer("/usage/inputTokens").is_some() {
                            let mut health = crate::providers::health(&handle.state::<AppState>().db.lock().unwrap_or_else(|p|p.into_inner()),"agy");
                            health.quota_model = None;
                            health.quota_observed_at = None;
                            health.observed_at = crate::providers::now();
                            health.message = "Cuenta conectada mediante ACP".into();
                            let _ = crate::providers::observe(&handle,health);
                        }
                        json!({ "type": "turn_end", "stopReason": res["stopReason"] })
                    }
                }
                Err(_) if cancelled.load(std::sync::atomic::Ordering::SeqCst) => {
                    crate::runs::record(&handle, |conn| crate::runs::finish(conn,run,"cancelled").map_err(err));
                    tracker.finished(id,None);
                    crate::claude::notify_subsession(&handle,id);
                    json!({"type":"turn_end","stopReason":"cancelled"})
                }
                Err(e) => {
                    let message = explain(&engine, e);
                    tracker.finished(id, Some(&format!("error: {message}")));
                    crate::claude::notify_subsession(&handle, id);
                    let quota = crate::handoff::quota_reason(&message);
                    let outcome = if quota.is_some() { "paused_quota" } else if !rpc.alive() { "interrupted" } else { "failed" };
                    crate::runs::record(&handle, |conn| crate::runs::finish(conn, run, outcome).map_err(err));
                    if let Some(reason) = quota {
                        crate::handoff::pause(&handle, id, &reason);
                    }
                    json!({ "type": "error", "message": message })
                }
            };
            let _ = handle.emit("session", Event { id, msg });
        });
        Ok(())
    }

    /// Cancela el turno y da por canceladas las peticiones de permiso
    /// pendientes, como pide el protocolo.
    pub fn interrupt(&self, id: i64) -> CmdResult<()> {
        let slot = self.slot(id)?;
        let guard = slot.lock().map_err(err)?;
        let p = guard.as_ref().filter(|p| p.rpc.alive()).ok_or("la sesión no está en marcha")?;
        p.cancelled.store(true,std::sync::atomic::Ordering::SeqCst);
        let waiting: Vec<Value> = {
            let mut pending = self.pending.lock().map_err(err)?;
            let keys: Vec<String> = pending.iter().filter(|(_, (sid, _, _))| *sid == id).map(|(k, _)| k.clone()).collect();
            keys.iter().filter_map(|k| pending.remove(k)).map(|(_, rid, _)| rid).collect()
        };
        for rid in waiting {
            let _ = p.rpc.respond(rid, json!({ "outcome": { "outcome": "cancelled" } }));
        }
        p.rpc.notify_with("session/cancel", json!({ "sessionId": p.session_id }))
    }

    pub fn interrupt_bounded(&self, app: &AppHandle, id: i64) -> CmdResult<()> {
        let expected = crate::runs::active(&*app.state::<AppState>().db.lock().map_err(err)?,&crate::runs::session_scope(id))?;
        self.interrupt(id)?;
        let handle = app.clone();
        std::thread::spawn(move || {
            let state = handle.state::<AppState>();
            let _ = state.tracker.wait_idle(id,Duration::from_secs(5));
            let Ok(_admission) = state.chat_gate.lock() else { return; };
            let active = state.db.lock().ok().and_then(|conn| crate::runs::active(&conn,&crate::runs::session_scope(id)).ok().flatten());
            if expected.is_some() && active == expected { let _ = state.acp.close(id); }
        });
        Ok(())
    }

    /// `Ok(false)` si la petición no es de ACP.
    pub fn respond(&self, app: &AppHandle, request_id: &str, decision: &str) -> CmdResult<bool> {
        let Some((id, rid, options)) = self.pending.lock().map_err(err)?.remove(request_id) else { return Ok(false) };
        let slot = self.slot(id)?;
        let guard = slot.lock().map_err(err)?;
        let p = guard.as_ref().ok_or("la sesión ya no está en marcha")?;
        let outcome = match pick_option(&options, decision) {
            Some(option) => json!({ "outcome": "selected", "optionId": option }),
            None => json!({ "outcome": "cancelled" }),
        };
        p.rpc.respond(rid, json!({ "outcome": outcome }))?;
        drop(guard);
        if self.pending_for(id) == 0 {
            crate::runs::on_active(app, id, |conn, run| crate::runs::phase(conn, run, "running"));
        }
        Ok(true)
    }

    /// Cambia una opción (modelo o razonamiento) y la guarda para las
    /// siguientes ejecuciones. Devuelve las opciones editables actualizadas.
    pub fn set_option(&self, app: &AppHandle, state: &AppState, session: &db::Session, key: &str, value: &str) -> CmdResult<Value> {
        if crate::runs::session_active(&*state.db.lock().map_err(err)?,session.id).map_err(err)? {
            return Err("espera a que termine el turno para cambiar sus opciones".into());
        }
        self.ensure(app, state, session)?;
        let slot = self.slot(session.id)?;
        let mut guard = slot.lock().map_err(err)?;
        let p = guard.as_mut().ok_or("la sesión no está en marcha")?;
        if !allowed(&p.config, key, value) {
            return Err("esa opción no está disponible en este agente".into());
        }
        let r = p.rpc.request("session/set_config_option", json!({ "sessionId": p.session_id, "configId": key, "value": value }), INIT)?;
        if r.get("configOptions").is_some() {
            p.config = r["configOptions"].clone();
        }
        db::set_session_option(&*state.db.lock().map_err(err)?, session.id, key, value).map_err(err)?;
        store_history(state, session.id, &p.history, &p.config)?;
        Ok(editable(&p.config))
    }

    pub fn shutdown(&self) {
        if let Ok(mut procs) = self.procs.lock() { procs.clear(); }
        if let Ok(mut pending) = self.pending.lock() { pending.clear(); }
    }

    pub fn close(&self, id: i64) -> CmdResult<()> {
        self.procs.lock().map_err(err)?.remove(&id); // Drop termina el proceso
        self.pending.lock().map_err(err)?.retain(|_, (sid, _, _)| *sid != id);
        Ok(())
    }
}

pub fn start_reaper(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let state = app.state::<AppState>();
        let mut idle = Vec::new();
        if let Ok(procs) = state.acp.procs.lock() {
            for (id,slot) in procs.iter() {
                if state.tracker.get(*id).running || state.acp.pending_for(*id)>0 { continue; }
                if let Ok(mut proc) = slot.try_lock() {
                    if proc.as_ref().is_some_and(|p|p.last_used.elapsed()>Duration::from_secs(180)) { idle.extend(proc.take()); }
                }
            }
        }
        drop(idle);
    });
}

pub fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS acp_transcripts (
        session_id INTEGER PRIMARY KEY REFERENCES sessions(id), events TEXT NOT NULL, config TEXT NOT NULL
    );")
}

fn visible_update(update: &Value) -> bool {
    matches!(update["sessionUpdate"].as_str(), Some("user_message_chunk" | "agent_message_chunk" | "tool_call" | "tool_call_update" | "plan"))
}

fn store_history(state: &AppState, id: i64, history: &Mutex<Vec<Value>>, config: &Value) -> CmdResult<()> {
    let events = serde_json::to_string(&*history.lock().map_err(err)?).map_err(err)?;
    let conn = state.db.lock().map_err(err)?;
    conn.execute("INSERT INTO acp_transcripts(session_id,events,config) VALUES(?1,?2,?3)
        ON CONFLICT(session_id) DO UPDATE SET events=excluded.events,config=excluded.config",
        rusqlite::params![id,events,serde_json::to_string(config).map_err(err)?]).map_err(err)?;
    Ok(())
}

type Transcript = (Vec<Value>, Value);
fn read_history(conn: &rusqlite::Connection, id: i64) -> CmdResult<Option<Transcript>> {
    use rusqlite::OptionalExtension;
    let row: Option<(String,String)> = conn.query_row("SELECT events,config FROM acp_transcripts WHERE session_id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(err)?;
    row.map(|(events,config)| Ok((serde_json::from_str(&events).map_err(err)?,serde_json::from_str(&config).map_err(err)?))).transpose()
}

fn result_text(events: &[Value]) -> String {
    let mut text = String::new();
    for update in events {
        if update["sessionUpdate"] == "user_message_chunk" { text.clear(); }
        if update["sessionUpdate"] == "agent_message_chunk" {
            if let Some(chunk) = update.pointer("/content/text").and_then(Value::as_str) { text.push_str(chunk); }
        }
    }
    text
}

fn quota_notice(text: &str) -> Option<String> {
    // Observed official ACP 1.5.18 response: an end_turn containing this notice,
    // without a JSON-RPC error or usage. Do not classify ordinary prose about quotas.
    text.trim_start().starts_with("⚠ Individual quota reached.")
        .then(|| format!("cuota agotada: {}", text.trim().chars().take(240).collect::<String>()))
}

pub fn last_result(conn: &rusqlite::Connection, id: i64) -> CmdResult<String> {
    Ok(read_history(conn,id)?.map(|(events,_)| result_text(&events)).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_and_identity_survive_database_reopening_without_a_provider_process() {
        let file = std::env::temp_dir().join(format!("filigranas-acp-{}.db",uuid::Uuid::new_v4()));
        let id = {
            let conn = db::open(&file).unwrap();
            let s = db::create_session(&conn,"/synthetic","agy","native-original",&["test"]).unwrap();
            let events = json!([
                {"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"First"}},
                {"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Original result"}}
            ]);
            conn.execute("INSERT INTO acp_transcripts VALUES(?1,?2,'[]')",rusqlite::params![s.id,events.to_string()]).unwrap();
            s.id
        };
        {
            let conn = db::open(&file).unwrap();
            assert_eq!(db::session(&conn,id).unwrap().unwrap().provider_session,"native-original");
            assert_eq!(last_result(&conn,id).unwrap(),"Original result");
            assert!(read_history(&conn,id+1).unwrap().is_none());
        }
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn quota_notice_from_real_end_turn_is_not_success_or_ordinary_quota_discussion() {
        assert!(quota_notice("\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 130h45m22s.\n").is_some());
        assert!(quota_notice("The quota checker was implemented successfully.").is_none());
        assert!(!visible_update(&json!({"sessionUpdate":"agent_thought_chunk","content":{"text":"private reasoning"}})));
    }

    #[test]
    fn decisions_map_to_offered_options() {
        let options = json!([
            { "optionId": "a1", "kind": "allow_once" },
            { "optionId": "a2", "kind": "allow_always" },
            { "optionId": "r1", "kind": "reject_once" },
        ]);
        assert_eq!(pick_option(&options, "accept").as_deref(), Some("a1"));
        assert_eq!(pick_option(&options, "acceptForSession").as_deref(), Some("a2"));
        assert_eq!(pick_option(&options, "decline").as_deref(), Some("r1"));
        assert_eq!(pick_option(&options, "cancel"), None);
        // Si el agente no ofrece «siempre», vale una vez; sin rechazo, se cancela.
        let only_once = json!([{ "optionId": "x", "kind": "allow_once" }]);
        assert_eq!(pick_option(&only_once, "acceptForSession").as_deref(), Some("x"));
        assert_eq!(pick_option(&only_once, "decline"), None);
    }

    #[test]
    fn only_model_and_reasoning_are_editable() {
        let config = json!([
            { "id": "model", "category": "model", "options": [{ "value": "a" }, { "value": "b" }] },
            { "id": "mode", "category": "mode", "options": [{ "value": "bypass" }] },
            { "id": "thought_level", "category": "thought_level", "options": [{ "value": "high" }] }
        ]);
        assert!(allowed(&config, "model", "b"));
        assert!(!allowed(&config, "model", "z"));
        assert!(!allowed(&config, "mode", "bypass"));
        assert!(allowed(&config, "thought_level", "high"));
        let shown = editable(&config);
        let ids: Vec<&str> = shown.as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["model", "thought_level"]);
    }

    #[test]
    fn auth_errors_get_a_hint() {
        assert!(explain("devin", "Authentication required".into()).contains("devin auth login"));
        assert_eq!(explain("opencode", "otra cosa".into()), "otra cosa");
    }

    /// Contra OpenCode real con su modelo gratuito: sesión nueva, un turno
    /// corto y reanudación con `session/load`.
    /// `cargo test -- --ignored real_opencode_turn`
    #[test]
    #[ignore]
    fn real_opencode_turn() {
        let dir = std::env::temp_dir();
        let start = || {
            let mut child = crate::cli::command("opencode")
                .arg("acp")
                .current_dir(&dir)
                .env("PATH", login_path().unwrap_or_default())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            let rpc = Rpc::start_with(
                child.stdout.take().unwrap(),
                child.stdin.take().unwrap(),
                move |rpc, msg| match msg {
                    Incoming::Notification { params, .. } => {
                        let _ = tx.send(params["update"].clone());
                    }
                    Incoming::Request { id, .. } => {
                        let _ = rpc.respond(id, json!({ "outcome": { "outcome": "cancelled" } }));
                    }
                    Incoming::Closed => {}
                },
                true,
            );
            rpc.request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false } }), INIT).unwrap();
            (child, rpc, rx)
        };
        let base = json!({ "cwd": dir, "mcpServers": [] });

        let (mut child, rpc, rx) = start();
        let sid = rpc.request("session/new", base.clone(), INIT).unwrap()["sessionId"].as_str().unwrap().to_string();
        let res = rpc.request("session/prompt", json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": "Responde solo con la palabra: hola. No uses herramientas." }] }), INIT).unwrap();
        assert_eq!(res["stopReason"], json!("end_turn"));
        let text: String = rx.try_iter().filter(|u| u["sessionUpdate"] == json!("agent_message_chunk")).filter_map(|u| u.pointer("/content/text").and_then(Value::as_str).map(str::to_string)).collect();
        assert!(text.to_lowercase().contains("hola"), "respuesta: {text:?}");
        let _ = child.kill();
        let _ = child.wait();

        // Reanudar en otro proceso: la carga reproduce el mensaje del usuario.
        let (mut child, rpc, rx) = start();
        let mut params = base;
        params["sessionId"] = json!(sid);
        rpc.request("session/load", params, INIT).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let replay: Vec<Value> = rx.try_iter().collect();
        assert!(replay.iter().any(|u| u["sessionUpdate"] == json!("user_message_chunk")), "sin historial: {replay:?}");
        let _ = child.kill();
        let _ = child.wait();
    }
}
