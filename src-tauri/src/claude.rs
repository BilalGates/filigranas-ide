use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{codex::login_path, db, err, workspace::project_path, AppState, CmdResult};

// Sesiones de Claude Code como agentes ejecutores: un proceso
// `claude -p` con entrada y salida stream-json por sesión. Los permisos
// llegan como `control_request` (`can_use_tool`) y los contesta el usuario
// desde el IDE. El transcript lo guarda el propio Claude; aquí solo se
// recuerda el UUID para reanudar con `--resume`.

/// Nombres de sesión: futbolistas históricos del Barça (PLAN.md).
pub const NAMES: [&str; 20] = [
    "xavi", "iniesta", "puyol", "messi", "ronaldinho", "kubala", "koeman", "stoichkov", "laudrup", "rivaldo", "busquets", "pique",
    "valdes", "abidal", "alves", "suarez", "neymar", "pedri", "gavi", "yamal",
];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const DECISIONS: [&str; 4] = ["accept", "acceptForSession", "decline", "cancel"];

struct Proc {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    effort: Option<String>,
    alive: Arc<AtomicBool>,
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct Claude {
    procs: Mutex<HashMap<i64, Proc>>,
    /// Permisos sin contestar: id de la petición → (sesión, petición).
    pending: Arc<Mutex<HashMap<String, (i64, Value)>>>,
}

#[derive(Serialize, Clone)]
struct Event {
    id: i64,
    msg: Value,
}

fn write_line(stdin: &Mutex<ChildStdin>, msg: &Value) -> CmdResult<()> {
    let mut line = serde_json::to_string(msg).map_err(err)?;
    line.push('\n');
    let mut w = stdin.lock().map_err(err)?;
    w.write_all(line.as_bytes()).and_then(|_| w.flush()).map_err(|e| format!("la sesión de Claude no responde: {e}"))
}

/// Carpeta de proyectos de Claude Code (`CLAUDE_CONFIG_DIR` o `~/.claude`).
fn claude_projects() -> Option<PathBuf> {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")))?;
    Some(base.join("projects"))
}

/// Transcript de una sesión: `<proyectos>/<carpeta>/<uuid>.jsonl`. Se busca
/// en todas las carpetas para no depender de cómo Claude codifica la ruta.
fn transcript(uuid: &str) -> Option<PathBuf> {
    let file = format!("{uuid}.jsonl");
    std::fs::read_dir(claude_projects()?).ok()?.flatten().map(|d| d.path().join(&file)).find(|p| p.is_file())
}

/// Mensajes de usuario y asistente del transcript, en orden.
fn history_from(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| matches!(v["type"].as_str(), Some("user" | "assistant")) && v["isMeta"] != json!(true) && v.get("message").is_some())
        .map(|v| json!({ "type": v["type"], "message": v["message"] }))
        .collect()
}

/// Qué se reenvía a la interfaz. Se descartan avisos internos y, del
/// streaming parcial, todo salvo los fragmentos de texto y razonamiento.
fn forward(msg: &Value) -> bool {
    match msg["type"].as_str() {
        Some("system") => msg["subtype"] == json!("init"),
        Some("stream_event") => msg.pointer("/event/type") == Some(&json!("content_block_delta")),
        Some("control_response") | None => false,
        _ => true,
    }
}

fn system_prompt(name: &str) -> String {
    format!(
        "Eres «{name}», un agente ejecutor dentro de Filigranas IDE. El usuario o el coordinador del proyecto te encargan tareas concretas. \
Trabaja en la carpeta del proyecto, responde en español y con frases cortas. No hagas commits, push, merge ni rebase: los commits los propone Larry. \
Una tarea no está terminada hasta que el diff, los comandos y las pruebas lo demuestran; resume al final qué cambiaste y cómo lo comprobaste."
    )
}

impl Claude {
    /// Proceso de la sesión con el esfuerzo pedido. Si el esfuerzo cambia,
    /// se reinicia reanudando la misma conversación.
    fn proc(&self, app: &AppHandle, session: &db::Session, effort: Option<&str>) -> CmdResult<Arc<Mutex<ChildStdin>>> {
        let mut procs = self.procs.lock().map_err(err)?;
        if let Some(p) = procs.get(&session.id) {
            if p.alive.load(Ordering::SeqCst) && (effort.is_none() || p.effort.as_deref() == effort) {
                return Ok(p.stdin.clone());
            }
        }
        procs.remove(&session.id); // termina el anterior (Drop)

        let mut cmd = Command::new("claude");
        cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
            .args(["--permission-prompt-tool", "stdio"])
            .args(["--append-system-prompt", &system_prompt(&session.name)]);
        if transcript(&session.provider_session).is_some() {
            cmd.args(["--resume", &session.provider_session]);
        } else {
            cmd.args(["--session-id", &session.provider_session]);
        }
        if let Some(e) = effort {
            cmd.args(["--effort", e]);
        }
        cmd.current_dir(&session.project).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(path) = login_path() {
            cmd.env("PATH", path);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("no se pudo arrancar claude ({e}); comprueba que Claude Code está instalado"))?;
        let stdout = child.stdout.take().ok_or("sin salida de claude")?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("sin entrada de claude")?));
        let alive = Arc::new(AtomicBool::new(true));

        let (id, handle, pending, flag, input) = (session.id, app.clone(), self.pending.clone(), alive.clone(), stdin.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                if msg["type"] == json!("control_request") {
                    let request_id = msg["request_id"].as_str().unwrap_or("").to_string();
                    if msg.pointer("/request/subtype") != Some(&json!("can_use_tool")) {
                        let _ = write_line(
                            &input,
                            &json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": "Filigranas no admite esta petición" } }),
                        );
                        continue;
                    }
                    if let Ok(mut p) = pending.lock() {
                        p.insert(request_id, (id, msg["request"].clone()));
                    }
                }
                if forward(&msg) {
                    let _ = handle.emit("session", Event { id, msg });
                }
            }
            flag.store(false, Ordering::SeqCst);
            if let Ok(mut p) = pending.lock() {
                p.retain(|_, (sid, _)| *sid != id);
            }
            let _ = handle.emit("session", Event { id, msg: json!({ "type": "exit" }) });
        });

        // El modo host necesita el saludo de control antes del primer mensaje.
        write_line(&stdin, &json!({ "type": "control_request", "request_id": uuid::Uuid::new_v4().to_string(), "request": { "subtype": "initialize" } }))?;
        procs.insert(session.id, Proc { child, stdin: stdin.clone(), effort: effort.map(str::to_string), alive });
        Ok(stdin)
    }
}

fn open_session(state: &AppState, id: i64) -> CmdResult<db::Session> {
    db::session(&*state.db.lock().map_err(err)?, id).map_err(err)?.ok_or_else(|| "la sesión ya no existe".into())
}

// ── comandos ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn session_list(state: State<AppState>, project: String) -> CmdResult<Vec<db::Session>> {
    let conn = state.db.lock().map_err(err)?;
    let path = project_path(&conn, &project)?;
    db::sessions(&conn, &path).map_err(err)
}

/// Crea una sesión. El proceso arranca con el primer mensaje.
#[tauri::command]
pub fn session_create(state: State<AppState>, project: String, engine: String) -> CmdResult<db::Session> {
    // Claude Code acepta un UUID propio; los agentes ACP asignan el suyo al
    // crear la sesión y se guarda entonces.
    let provider = match engine.as_str() {
        "claude" => uuid::Uuid::new_v4().to_string(),
        e if crate::acp::ENGINES.contains(&e) => String::new(),
        _ => return Err(format!("motor desconocido: {engine}")),
    };
    let conn = state.db.lock().map_err(err)?;
    let path = project_path(&conn, &project)?;
    db::create_session(&conn, &path, &engine, &provider, &NAMES).map_err(err)
}

/// Conversación guardada, para pintarla al abrir la sesión. La de Claude
/// Code se lee de su transcript; la de un agente ACP llega como eventos al
/// cargar la sesión, así que aquí solo se arranca.
#[tauri::command]
pub async fn session_history(app: AppHandle, id: i64) -> CmdResult<Vec<Value>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let session = open_session(&state, id)?;
        if session.engine != "claude" {
            if session.provider_session.is_empty() {
                return Ok(Vec::new()); // sesión nueva: arranca con el primer mensaje
            }
            state.acp.attach(&app, &state, &session)?;
            return Ok(Vec::new());
        }
        match transcript(&session.provider_session) {
            Some(file) => Ok(history_from(&std::fs::read_to_string(file).map_err(err)?)),
            None => Ok(Vec::new()),
        }
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn session_send(app: AppHandle, id: i64, text: String, effort: Option<String>) -> CmdResult<()> {
    if text.trim().is_empty() {
        return Err("mensaje vacío".into());
    }
    if effort.as_deref().is_some_and(|e| !EFFORTS.contains(&e)) {
        return Err("nivel de esfuerzo no válido".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let session = open_session(&state, id)?;
        if session.engine != "claude" {
            return state.acp.send(&app, &state, &session, text);
        }
        if let Some(e) = &effort {
            db::set_session_effort(&*state.db.lock().map_err(err)?, id, e).map_err(err)?;
        }
        let stdin = state.claude.proc(&app, &session, effort.as_deref())?;
        write_line(&stdin, &json!({ "type": "user", "message": { "role": "user", "content": text }, "parent_tool_use_id": null, "session_id": "" }))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn session_interrupt(state: State<AppState>, id: i64) -> CmdResult<()> {
    if open_session(&state, id)?.engine != "claude" {
        return state.acp.interrupt(id);
    }
    let procs = state.claude.procs.lock().map_err(err)?;
    let p = procs.get(&id).filter(|p| p.alive.load(Ordering::SeqCst)).ok_or("la sesión no está en marcha")?;
    write_line(&p.stdin, &json!({ "type": "control_request", "request_id": uuid::Uuid::new_v4().to_string(), "request": { "subtype": "interrupt" } }))
}

/// Respuesta de permiso de Claude Code para una decisión del usuario.
fn permission(request: &Value, decision: &str) -> Value {
    match decision {
        "accept" => json!({ "behavior": "allow", "updatedInput": request["input"] }),
        "acceptForSession" => json!({
            "behavior": "allow",
            "updatedInput": request["input"],
            "updatedPermissions": request.get("permission_suggestions").cloned().unwrap_or(json!([])),
        }),
        "cancel" => json!({ "behavior": "deny", "message": "El usuario ha detenido la tarea", "interrupt": true }),
        _ => json!({ "behavior": "deny", "message": "El usuario ha rechazado esta acción" }),
    }
}

#[tauri::command]
pub fn session_respond(state: State<AppState>, request_id: String, decision: String) -> CmdResult<()> {
    if !DECISIONS.contains(&decision.as_str()) {
        return Err("decisión no válida".into());
    }
    let claimed = state.claude.pending.lock().map_err(err)?.remove(&request_id);
    let Some((id, request)) = claimed else {
        return if state.acp.respond(&request_id, &decision)? { Ok(()) } else { Err("esa petición ya no está pendiente".into()) };
    };
    let procs = state.claude.procs.lock().map_err(err)?;
    let p = procs.get(&id).ok_or("la sesión ya no está en marcha")?;
    write_line(
        &p.stdin,
        &json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": permission(&request, &decision) } }),
    )
}

/// Cierra la sesión: termina el proceso y la quita de las pestañas. El
/// transcript sigue en Claude Code.
#[tauri::command]
pub fn session_close(state: State<AppState>, id: i64) -> CmdResult<()> {
    state.claude.procs.lock().map_err(err)?.remove(&id);
    state.claude.pending.lock().map_err(err)?.retain(|_, (sid, _)| *sid != id);
    state.acp.close(id)?;
    db::close_session(&*state.db.lock().map_err(err)?, id).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_keeps_user_and_assistant_messages() {
        let text = [
            r#"{"type":"summary","summary":"x"}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<meta>"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"hola"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"buenas"}]}}"#,
            "no es json",
        ]
        .join("\n");
        let h = history_from(&text);
        assert_eq!(h.len(), 2);
        assert_eq!(h[0]["message"]["content"], json!("hola"));
        assert_eq!(h[1]["message"]["content"][0]["text"], json!("buenas"));
    }

    #[test]
    fn forwards_only_what_the_ui_paints() {
        assert!(forward(&json!({ "type": "assistant" })));
        assert!(forward(&json!({ "type": "system", "subtype": "init" })));
        assert!(!forward(&json!({ "type": "system", "subtype": "hook_started" })));
        assert!(forward(&json!({ "type": "stream_event", "event": { "type": "content_block_delta" } })));
        assert!(!forward(&json!({ "type": "stream_event", "event": { "type": "message_start" } })));
        assert!(!forward(&json!({ "type": "control_response" })));
    }

    #[test]
    fn permission_responses() {
        let req = json!({ "input": { "file_path": "a" }, "permission_suggestions": [{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }] });
        assert_eq!(permission(&req, "accept"), json!({ "behavior": "allow", "updatedInput": { "file_path": "a" } }));
        assert_eq!(permission(&req, "acceptForSession")["updatedPermissions"][0]["mode"], json!("acceptEdits"));
        assert_eq!(permission(&req, "decline")["behavior"], json!("deny"));
        assert_eq!(permission(&req, "cancel")["interrupt"], json!(true));
    }

    /// Contra Claude Code real: gasta un turno corto. Comprueba que un
    /// permiso rechazado no crea el archivo y que la sesión se reanuda.
    /// `cargo test -- --ignored real_claude_permission`
    #[test]
    #[ignore]
    fn real_claude_permission() {
        let dir = std::env::temp_dir().join(format!("filigranas-claude-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let uuid = uuid::Uuid::new_v4().to_string();
        let run = |resume: bool, text: &str, decision: &str| -> Vec<Value> {
            let mut cmd = Command::new("claude");
            cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--effort", "low"])
                .args([if resume { "--resume" } else { "--session-id" }, &uuid])
                .current_dir(&dir)
                .env("PATH", login_path().unwrap_or_default())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            let mut child = cmd.spawn().unwrap();
            let stdin = Mutex::new(child.stdin.take().unwrap());
            write_line(&stdin, &json!({ "type": "control_request", "request_id": "i", "request": { "subtype": "initialize" } })).unwrap();
            write_line(&stdin, &json!({ "type": "user", "message": { "role": "user", "content": text }, "parent_tool_use_id": null, "session_id": "" })).unwrap();
            let mut seen = Vec::new();
            for line in BufReader::new(child.stdout.take().unwrap()).lines() {
                let msg: Value = serde_json::from_str(&line.unwrap()).unwrap();
                if msg["type"] == json!("control_request") && msg.pointer("/request/subtype") == Some(&json!("can_use_tool")) {
                    let response = permission(&msg["request"], decision);
                    write_line(&stdin, &json!({ "type": "control_response", "response": { "subtype": "success", "request_id": msg["request_id"], "response": response } })).unwrap();
                }
                let done = msg["type"] == json!("result");
                seen.push(msg);
                if done {
                    break;
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            seen
        };
        let first = run(false, "Crea el archivo hola.txt con el texto hola. Si no puedes, dilo en una frase.", "decline");
        assert!(first.iter().any(|m| m["type"] == json!("control_request")), "no pidió permiso");
        assert!(!dir.join("hola.txt").exists(), "creó el archivo pese a rechazarlo");
        assert!(transcript(&uuid).is_some(), "no hay transcript");
        let second = run(true, "¿Qué te pedí en el mensaje anterior? Responde en una frase y no uses herramientas.", "decline");
        let answer: String = second.iter().filter(|m| m["type"] == json!("result")).filter_map(|m| m["result"].as_str()).collect();
        assert!(answer.to_lowercase().contains("hola"), "no recuerda la conversación: {answer}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
