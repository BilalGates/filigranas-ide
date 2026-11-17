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

/// Nombres de sesión: leyendas históricas del Barça, al azar entre las libres.
pub const NAMES: [&str; 20] = [
    "kubala", "samitier", "cruyff", "neeskens", "migueli", "zubizarreta", "koeman", "stoichkov", "romario", "rivaldo", "basora", "cesar",
    "rexach", "laudrup", "sotil", "alexanco", "amor", "nadal", "guardiola", "ronaldinho",
];
/// Las leyendas en orden aleatorio: cada sesión nueva toma una libre al azar.
pub fn shuffled_names() -> Vec<&'static str> {
    let mut names = NAMES.to_vec();
    names.sort_by_cached_key(|_| uuid::Uuid::new_v4().as_u128());
    names
}

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
Trabaja en la carpeta del proyecto, responde en español, conciso y solo con lo necesario: sin preámbulos, sin repetir la tarea ni explicar lo obvio. No hagas commits, push, merge ni rebase: los commits los propone Larry. \
Una tarea no está terminada hasta que el diff, los comandos y las pruebas lo demuestran; termina con una o dos líneas: qué cambiaste y cómo lo comprobaste."
    )
}

impl Claude {
    /// Pide a Claude Code que corte el turno en curso.
    pub fn interrupt(&self, id: i64) -> CmdResult<()> {
        let procs = self.procs.lock().map_err(err)?;
        let p = procs.get(&id).filter(|p| p.alive.load(Ordering::SeqCst)).ok_or("la sesión no está en marcha")?;
        write_line(&p.stdin, &json!({ "type": "control_request", "request_id": uuid::Uuid::new_v4().to_string(), "request": { "subtype": "interrupt" } }))
    }

    /// Termina el proceso de la sesión y olvida sus permisos pendientes.
    pub fn forget(&self, id: i64) {
        if let Ok(mut procs) = self.procs.lock() {
            procs.remove(&id);
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|_, (sid, _)| *sid != id);
        }
    }

    /// Permisos sin contestar de una sesión.
    pub fn pending_for(&self, id: i64) -> usize {
        self.pending.lock().map(|p| p.values().filter(|(sid, _)| *sid == id).count()).unwrap_or(0)
    }

    /// Proceso de la sesión con el esfuerzo pedido. Si el esfuerzo cambia,
    /// se reinicia reanudando la misma conversación.
    fn proc(&self, app: &AppHandle, session: &db::Session, effort: Option<&str>) -> CmdResult<Arc<Mutex<ChildStdin>>> {
        let mut procs = self.procs.lock().map_err(err)?;
        if let Some(p) = procs.get(&session.id) {
            // Con un turno en marcha nunca se reinicia (cortaría, p. ej., el
            // turno de un relevo): el mensaje se encola y el esfuerzo nuevo
            // se aplicará en el siguiente arranque.
            let busy = app.state::<AppState>().tracker.get(session.id).running;
            if p.alive.load(Ordering::SeqCst) && (busy || effort.is_none() || p.effort.as_deref() == effort) {
                return Ok(p.stdin.clone());
            }
        }
        procs.remove(&session.id); // termina el anterior (Drop)

        let mut cmd = Command::new(crate::codex::program("claude"));
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
        cmd.current_dir(session.cwd()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
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
                if msg["type"] == json!("rate_limit_event") && msg.pointer("/rate_limit_info/status") == Some(&json!("rejected")) {
                    let window = msg.pointer("/rate_limit_info/rateLimitType").and_then(Value::as_str).unwrap_or("del plan");
                    crate::handoff::pause(&handle, id, &format!("cuota agotada: límite {window} de Claude"));
                }
                if msg["type"] == json!("result") {
                    handle.state::<AppState>().tracker.finished(id, msg["result"].as_str());
                    if msg["is_error"] == json!(true) {
                        if let Some(reason) = crate::handoff::quota_reason(&msg.to_string()) {
                            crate::handoff::pause(&handle, id, &reason);
                        }
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
            handle.state::<AppState>().tracker.exited(id);
            let _ = handle.emit("session", Event { id, msg: json!({ "type": "exit" }) });
        });

        // El modo host necesita el saludo de control antes del primer mensaje.
        write_line(&stdin, &json!({ "type": "control_request", "request_id": uuid::Uuid::new_v4().to_string(), "request": { "subtype": "initialize" } }))?;
        procs.insert(session.id, Proc { child, stdin: stdin.clone(), effort: effort.map(str::to_string), alive });
        Ok(stdin)
    }
}

pub(crate) fn open_session(state: &AppState, id: i64) -> CmdResult<db::Session> {
    db::session(&*state.db.lock().map_err(err)?, id).map_err(err)?.ok_or_else(|| "la sesión ya no existe".into())
}

// ── comandos ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn session_list(state: State<AppState>, project: String) -> CmdResult<Vec<db::Session>> {
    let conn = state.db.lock().map_err(err)?;
    let path = project_path(&conn, &project)?;
    db::sessions(&conn, &path).map_err(err)
}

/// Sesión recién creada y, si procede, un aviso para el usuario.
#[derive(Serialize)]
pub struct Created {
    #[serde(flatten)]
    pub session: db::Session,
    pub notice: Option<String>,
}

/// Crea una sesión. El proceso arranca con el primer mensaje.
#[tauri::command]
pub async fn session_create(app: AppHandle, project: String, engine: String) -> CmdResult<Created> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        new_session(&app, &path, &engine)
    })
    .await
    .map_err(err)?
}

/// Crea una sesión en un proyecto ya validado, aislada en su propia rama y
/// worktree cuando el repositorio tiene commits. Claude Code acepta un UUID
/// propio; los agentes ACP asignan el suyo al crearla y se guarda entonces.
pub fn new_session(app: &AppHandle, project: &str, engine: &str) -> CmdResult<Created> {
    let state = app.state::<AppState>();
    let provider = match engine {
        "claude" => uuid::Uuid::new_v4().to_string(),
        e if crate::acp::ENGINES.contains(&e) => String::new(),
        _ => return Err(format!("motor desconocido: {engine}")),
    };
    let session = db::create_session(&*state.db.lock().map_err(err)?, project, engine, &provider, &shuffled_names()).map_err(err)?;
    let data_dir = app.path().app_data_dir().map_err(err)?;
    let iso = match crate::isolate::create(&data_dir, std::path::Path::new(project), &session.name, session.id) {
        Ok(iso) => iso,
        Err(e) => {
            let _ = db::close_session(&*state.db.lock().map_err(err)?, session.id);
            return Err(format!("no se pudo crear la rama de la sesión: {e}"));
        }
    };
    let conn = state.db.lock().map_err(err)?;
    let notice = match &iso {
        Some(iso) => {
            db::set_session_worktree(&conn, session.id, &iso.worktree, &iso.branch, &iso.base, &iso.base_commit).map_err(err)?;
            iso.main_dirty.then(|| {
                format!("{} parte del último commit de {}: los cambios sin commit del proyecto no están en su rama", session.name, iso.base)
            })
        }
        None => Some(format!("{} trabaja directamente en el proyecto: el repositorio aún no tiene commits de los que partir", session.name)),
    };
    let session = db::session(&conn, session.id).map_err(err)?.ok_or("la sesión no se guardó")?;
    Ok(Created { session, notice })
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
    tauri::async_runtime::spawn_blocking(move || send_message(&app, id, text, effort)).await.map_err(err)?
}

/// Envía un mensaje a la sesión, arrancando su proceso si hace falta.
/// Bloquea mientras arranca: llamar fuera del hilo principal.
pub fn send_message(app: &AppHandle, id: i64, text: String, effort: Option<String>) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let session = open_session(&state, id)?;
    {
        // Enviar reanuda una sesión pausada; el primer mensaje es el objetivo.
        let conn = state.db.lock().map_err(err)?;
        db::set_session_task(&conn, id, &text).map_err(err)?;
        if session.paused.is_some() {
            db::set_session_paused(&conn, id, None).map_err(err)?;
        }
    }
    if session.engine != "claude" {
        return state.acp.send(app, &state, &session, text);
    }
    if let Some(e) = &effort {
        db::set_session_effort(&*state.db.lock().map_err(err)?, id, e).map_err(err)?;
    }
    let stdin = state.claude.proc(app, &session, effort.as_deref())?;
    write_line(&stdin, &json!({ "type": "user", "message": { "role": "user", "content": text }, "parent_tool_use_id": null, "session_id": "" }))?;
    state.tracker.started(id);
    Ok(())
}

#[tauri::command]
pub fn session_interrupt(state: State<AppState>, id: i64) -> CmdResult<()> {
    if open_session(&state, id)?.engine != "claude" {
        return state.acp.interrupt(id);
    }
    state.claude.interrupt(id)
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

/// Cambia el modelo o el razonamiento de una sesión ACP.
#[tauri::command]
pub async fn session_set_option(app: AppHandle, id: i64, key: String, value: String) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let session = open_session(&state, id)?;
        if session.engine == "claude" {
            return Err("en Claude Code el esfuerzo se elige junto al mensaje".into());
        }
        state.acp.set_option(&app, &state, &session, &key, &value)
    })
    .await
    .map_err(err)?
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
