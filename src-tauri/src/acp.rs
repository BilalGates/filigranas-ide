use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
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
    child: Child,
    session_id: String,
    /// Agente lanzado (`opencode`, `agy`, `devin`).
    engine: String,
    /// Opciones que ofrece el agente (`configOptions` de ACP).
    config: Value,
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
        let _ = self.child.kill();
        let _ = self.child.wait();
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
        if let Some(p) = guard.as_ref() {
            if p.rpc.alive() {
                return Ok((p.rpc.clone(), p.session_id.clone()));
            }
        }
        *guard = None;

        let engine = session.engine.as_str();
        let mut cmd = Command::new(program(engine));
        cmd.arg("acp").current_dir(session.cwd()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(path) = login_path() {
            cmd.env("PATH", path);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("no se pudo arrancar {engine} ({e}); comprueba que está instalado"))?;
        let (stdout, stdin) = (child.stdout.take().ok_or("sin salida del agente")?, child.stdin.take().ok_or("sin entrada del agente")?);

        let (id, handle, pending) = (session.id, app.clone(), self.pending.clone());
        let cwd = std::path::PathBuf::from(session.cwd());
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
                    // Nivel de permisos de la sesión: Filigranas puede aprobar por su cuenta.
                    let mode = tracker_handle.state::<AppState>().permissions.get(id);
                    let (kind, paths) = crate::autoapprove::acp_request(&params["toolCall"]);
                    if crate::autoapprove::approves(mode, &cwd, kind, &paths) {
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
        let can_load = init.pointer("/agentCapabilities/loadSession") == Some(&json!(true));
        let base = json!({ "cwd": session.cwd(), "mcpServers": [] });

        let mut loaded = None;
        if can_load && !session.provider_session.is_empty() {
            emit(json!({ "type": "replay" })); // la interfaz vacía la conversación
            let mut params = base.clone();
            params["sessionId"] = json!(session.provider_session);
            if let Ok(res) = rpc.request("session/load", params, INIT) {
                loaded = Some((session.provider_session.clone(), res));
            }
        }
        let (session_id, res) = match loaded {
            Some(l) => l,
            None => {
                let res = match rpc.request("session/new", base, INIT) {
                    Ok(v) => v,
                    Err(e) => return Err(fail(&mut child, e)),
                };
                let sid = res["sessionId"].as_str().ok_or("el agente no devolvió la sesión")?.to_string();
                db::set_provider_session(&*state.db.lock().map_err(err)?, session.id, &sid).map_err(err)?;
                (sid, res)
            }
        };
        // Reaplicar lo elegido antes en el IDE (sobrevive a reinicios).
        let mut config = res["configOptions"].clone();
        let chosen = db::session_options(&*state.db.lock().map_err(err)?, session.id).map_err(err)?;
        for (key, value) in chosen {
            let Some(value) = value.as_str() else { continue };
            if !allowed(&config, &key, value) {
                continue;
            }
            if let Ok(r) = rpc.request("session/set_config_option", json!({ "sessionId": session_id, "configId": key, "value": value }), INIT) {
                if r.get("configOptions").is_some() {
                    config = r["configOptions"].clone();
                }
            }
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

        *guard = Some(Proc { rpc: rpc.clone(), child, engine: engine.to_string(), session_id: session_id.clone(), config });
        Ok((rpc, session_id))
    }

    /// Arranca (o reanuda) la sesión para pintar su historial.
    pub fn attach(&self, app: &AppHandle, state: &AppState, session: &db::Session) -> CmdResult<()> {
        self.ensure(app, state, session).map(|_| ())
    }

    /// Envía el mensaje. El turno termina cuando responde `session/prompt`.
    pub fn send(&self, app: &AppHandle, state: &AppState, session: &db::Session, text: String, run: i64) -> CmdResult<()> {
        let (rpc, sid) = self.ensure(app, state, session)?;
        let (id, handle, engine) = (session.id, app.clone(), session.engine.clone());
        let slot = self.slot(id)?;
        let model = slot.lock().map_err(err)?.as_ref().and_then(|p| {
            p.config.as_array()?.iter().find(|o| o["category"] == "model")?["currentValue"].as_str().map(str::to_owned)
        });
        crate::runs::record(app, |conn| crate::runs::usage(conn, run, crate::runs::Usage { model, ..Default::default() }).map_err(err));
        state.tracker.started(id);
        std::thread::spawn(move || {
            let tracker = &handle.state::<AppState>().tracker;
            let msg = match rpc.request("session/prompt", json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": text }] }), TURN) {
                Ok(res) => {
                    let outcome = match res["stopReason"].as_str() {
                        Some("end_turn") => "completed",
                        Some("cancelled") => "cancelled",
                        _ => "failed",
                    };
                    crate::runs::record(&handle, |conn| crate::runs::finish(conn, run, outcome).map_err(err));
                    tracker.finished(id, None);
                    json!({ "type": "turn_end", "stopReason": res["stopReason"] })
                }
                Err(e) => {
                    let message = explain(&engine, e);
                    tracker.finished(id, Some(&format!("error: {message}")));
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
        Ok(editable(&p.config))
    }

    pub fn close(&self, id: i64) -> CmdResult<()> {
        self.procs.lock().map_err(err)?.remove(&id); // Drop termina el proceso
        self.pending.lock().map_err(err)?.retain(|_, (sid, _, _)| *sid != id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            let mut child = Command::new("opencode")
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
