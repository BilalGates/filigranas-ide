use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{cli::login_path, db, err, runs, tasks, workspace::project_path, AppState, CmdResult};

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
/// Nombres de sesión: «sesión 1», «sesión 2»… la primera libre.
fn numbered() -> Vec<String> {
    (1..=99).map(|i| format!("sesión {i}")).collect()
}

const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const DECISIONS: [&str; 4] = ["accept", "acceptForSession", "decline", "cancel"];

#[derive(Clone)]
struct Input {
    stdin: Arc<Mutex<ChildStdin>>,
    run: Arc<Mutex<Option<i64>>>,
}

struct Proc {
    child: Child,
    input: Input,
    effort: Option<String>,
    pinned_model: Option<String>,
    alive: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
struct ModelOption {
    id: String,
    label: String,
}

fn model_catalog(message: &Value) -> Option<Vec<ModelOption>> {
    let models = message.pointer("/response/response/models")?.as_array()?;
    Some(models.iter().filter_map(|model| Some(ModelOption {
        id: model["value"].as_str()?.into(),
        label: model["displayName"].as_str()?.into(),
    })).collect())
}

impl Drop for Proc {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct PermissionRequest {
    session: i64,
    provider_id: String,
    request: Value,
    process: Arc<AtomicBool>,
}

impl PermissionRequest {
    fn register(pending: &mut HashMap<String, Self>, session: i64, msg: &mut Value, process: &Arc<AtomicBool>) -> Option<()> {
        let provider_id = msg["request_id"].as_str()?.to_owned();
        let id = uuid::Uuid::new_v4().to_string();
        pending.insert(id.clone(), Self { session, provider_id, request: msg["request"].clone(), process: process.clone() });
        msg["request_id"] = json!(id);
        Some(())
    }
}

#[derive(Default)]
pub struct Claude {
    procs: Mutex<HashMap<i64, Proc>>,
    models: Arc<Mutex<Vec<ModelOption>>>,
    /// Identificadores del IDE, independientes para cada petición de cada proceso.
    pending: Arc<Mutex<HashMap<String, PermissionRequest>>>,
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
    let base = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|h| PathBuf::from(h).join(".claude")))?;
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
pub(crate) fn read_history(provider: &str) -> CmdResult<Vec<Value>> {
    match transcript(provider) {
        Some(file) => Ok(history_from(&std::fs::read_to_string(file).map_err(err)?)),
        None => Ok(Vec::new()),
    }
}

fn forward(msg: &Value) -> bool {
    match msg["type"].as_str() {
        Some("system") => msg["subtype"] == json!("init"),
        Some("stream_event") => msg.pointer("/event/type") == Some(&json!("content_block_delta")),
        Some("control_response") | None => false,
        _ => true,
    }
}

fn system_prompt(name: &str, rules: &str, is_subsession: bool) -> String {
    if is_subsession {
        format!(
            "Eres «{name}», una subsesión delegada dentro de Filigranas IDE. Ejecuta el encargo directamente sin delegar ni crear otras subsesiones y entrega un resultado claro, verificado y completo para la sesión padre. \
Trabaja en la carpeta de la sesión y responde en español. Da prioridad a las instrucciones vigentes de ese proyecto sobre las skills incluidas, dentro de los permisos del entorno. Deja commit, push, merge y rebase a las acciones de Larry y del usuario.\n\n{}\n{rules}",
            crate::capabilities::POLICIES
        )
    } else {
        format!(
            "Eres «{name}», un agente ejecutor dentro de Filigranas IDE. El usuario o el coordinador del proyecto te encargan tareas concretas. \
Trabaja en la carpeta de la sesión y responde en español. Da prioridad a las instrucciones vigentes de ese proyecto sobre las skills incluidas, dentro de los permisos del entorno. \
Si necesitas delegar una subtarea o trabajar en paralelo, crea una subsesión visible de Filigranas con las herramientas MCP de `filigranas` (`delegar`, `estado_sesiones`, `esperar_sesion`, `continuar_sesion`) en lugar de usar subagentes internos de Claude Code; las subsesiones aparecen en «Conversaciones» bajo esta sesión, pueden durar lo que necesiten y devuelven su resultado mediante `esperar_sesion`. \
Deja commit, push, merge y rebase a las acciones de Larry y del usuario.\n\n{}\n{rules}",
            crate::capabilities::POLICIES
        )
    }
}

/// Emite `sessions-changed` cuando cambia el estado observable de una subsesión.
pub(crate) fn notify_subsession(app: &AppHandle, id: i64) {
    let state = app.state::<AppState>();
    let project = state.db.lock().ok()
        .and_then(|conn| db::session(&conn, id).ok().flatten())
        .filter(|s| s.parent_session.is_some() || s.delegated_by_pm)
        .map(|s| s.project);
    if let Some(project) = project {
        let _ = app.emit("sessions-changed", json!({ "project": project, "focus": null }));
    }
}

fn send_mcp_response(input: &Mutex<ChildStdin>, request_id: &str, mcp_response: Value) {
    let _ = write_line(
        input,
        &json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": { "mcp_response": mcp_response },
            }
        }),
    );
}

fn handle_mcp_message(
    handle: &AppHandle,
    session_id: i64,
    request_id: String,
    request: &Value,
    input: &Arc<Mutex<ChildStdin>>,
    alive: &Arc<AtomicBool>,
) {
    if request["server_name"].as_str() != Some("filigranas") {
        let _ = write_line(
            input,
            &json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": "servidor MCP desconocido" } }),
        );
        return;
    }
    let message = &request["message"];
    let method = message["method"].as_str().unwrap_or("");
    let rpc_id = message.get("id").cloned();
    match method {
        "initialize" => {
            let version = message.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2024-11-05");
            send_mcp_response(input, &request_id, json!({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "filigranas", "version": env!("CARGO_PKG_VERSION") },
                }
            }));
        }
        "notifications/initialized" | "notifications/cancelled" => {
            send_mcp_response(input, &request_id, json!({}));
        }
        "tools/list" => {
            send_mcp_response(input, &request_id, json!({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": { "tools": crate::delegate::claude_mcp_tools() },
            }));
        }
        "tools/call" => {
            let tool = message.pointer("/params/name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = message.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
            let (handle, input, alive) = (handle.clone(), input.clone(), alive.clone());
            std::thread::spawn(move || {
                let (text, is_error) = match crate::delegate::handle_claude(&handle, session_id, &tool, &args) {
                    Ok(text) => (text, false),
                    Err(error) => (error, true),
                };
                if alive.load(Ordering::SeqCst) {
                    send_mcp_response(&input, &request_id, json!({
                        "jsonrpc": "2.0",
                        "id": rpc_id,
                        "result": {
                            "content": [{ "type": "text", "text": text }],
                            "isError": is_error,
                        }
                    }));
                }
            });
        }
        _ if rpc_id.is_some() => {
            send_mcp_response(input, &request_id, json!({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "error": { "code": -32601, "message": format!("método MCP no soportado: {method}") },
            }));
        }
        _ => {
            send_mcp_response(input, &request_id, json!({}));
        }
    }
}

impl Claude {
    /// Pide a Claude Code que corte el turno en curso.
    pub fn interrupt(&self, id: i64) -> CmdResult<()> {
        let procs = self.procs.lock().map_err(err)?;
        let p = procs.get(&id).filter(|p| p.alive.load(Ordering::SeqCst)).ok_or("la sesión no está en marcha")?;
        write_line(&p.input.stdin, &json!({ "type": "control_request", "request_id": uuid::Uuid::new_v4().to_string(), "request": { "subtype": "interrupt" } }))
    }

    /// Termina el proceso de la sesión y olvida sus permisos pendientes.
    pub fn forget(&self, id: i64) {
        if let Ok(mut procs) = self.procs.lock() {
            procs.remove(&id);
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|_, request| request.session != id);
        }
    }

    /// Permisos sin contestar de una sesión.
    pub fn pending_for(&self, id: i64) -> usize {
        self.pending.lock().map(|p| p.values().filter(|request| request.session == id).count()).unwrap_or(0)
    }

    /// Si hay algún proceso de Claude vivo o arrancando (cerrojo ocupado).
    pub fn running(&self) -> bool {
        self.procs.try_lock().map(|p| p.values().any(|p| p.alive.load(Ordering::SeqCst))).unwrap_or(true)
    }

    /// Proceso de la sesión con el esfuerzo pedido. Si el esfuerzo cambia,
    /// se reinicia reanudando la misma conversación.
    fn proc(&self, app: &AppHandle, session: &db::Session, effort: Option<&str>) -> CmdResult<Input> {
        let state = app.state::<AppState>();
        let (pinned_model, is_pm, isolate) = {
            let conn = state.db.lock().map_err(err)?;
            (claude_model(&conn, session.id)?, crate::chat::is_pm(&conn, session.id).map_err(err)?,
                crate::capabilities::personal_config(&conn) != "all")
        };
        let mut procs = self.procs.lock().map_err(err)?;
        if let Some(p) = procs.get(&session.id) {
            let busy = state.tracker.get(session.id).running;
            let same_options = p.pinned_model == pinned_model && (effort.is_none() || p.effort.as_deref() == effort);
            if p.alive.load(Ordering::SeqCst) && (busy || same_options) {
                return Ok(p.input.clone());
            }
        }
        procs.remove(&session.id); // termina el anterior (Drop)

        let rules = crate::skills::RULES;
        let is_subsession = session.parent_session.is_some() || session.delegated_by_pm;
        let can_delegate = is_pm || !is_subsession;
        let prompt = if is_pm {
            let policy = include_str!("../resources/coordinadores/politica.md");
            format!(
                "{policy}\n\nUsa exclusivamente las herramientas MCP de `filigranas` (`delegar`, `estado_sesiones`, `esperar_sesion`, `continuar_sesion`) para delegar y supervisar subsesiones visibles; nunca uses subagentes internos de Claude Code ni herramientas directas de archivo o terminal.\n\n{}",
                crate::capabilities::POLICIES
            )
        } else {
            system_prompt(&session.name, rules, is_subsession)
        };
        let mut cmd = crate::cli::command(crate::cli::program("claude"));
        cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
            .args(["--permission-prompt-tool", "stdio"])
            .args([
                "--disallowedTools",
                if is_pm {
                    "Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,LS,WebFetch,WebSearch,Agent,Task,TodoWrite"
                } else {
                    "Agent,Task"
                },
            ])
            .args(["--append-system-prompt", &prompt]);
        if can_delegate {
            cmd.args(["--mcp-config", r#"{"mcpServers":{"filigranas":{"type":"sdk","name":"filigranas"}}}"#]);
        }
        // El PM y las subsesiones no heredan CLAUDE.md, skills, plugins ni
        // conectores personales: su contexto lo administra Filigranas.
        if (is_pm || is_subsession) && isolate {
            cmd.args(["--setting-sources", "project,local", "--strict-mcp-config", "--disable-slash-commands"]);
        }
        if transcript(&session.provider_session).is_some() {
            cmd.args(["--resume", &session.provider_session]);
        } else {
            cmd.args(["--session-id", &session.provider_session]);
        }
        // «auto»: sin --effort, Claude Code usa su nivel por defecto.
        if let Some(e) = effort.filter(|e| *e != "auto") {
            cmd.args(["--effort", e]);
        }
        if let Some(model) = &pinned_model {
            cmd.args(["--model", model]);
        }
        cmd.current_dir(session.cwd()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(path) = login_path() {
            cmd.env("PATH", path);
        }
        let mut child = cmd.spawn().map_err(|e| format!("no se pudo arrancar claude ({e}); comprueba que Claude Code está instalado"))?;
        let stdout = child.stdout.take().ok_or("sin salida de claude")?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("sin entrada de claude")?));
        let alive = Arc::new(AtomicBool::new(true));

        let run = Arc::new(Mutex::new(None));
        let active_run = run.clone();
        let catalog = self.models.clone();
        let (id, handle, pending, flag, input) = (session.id, app.clone(), self.pending.clone(), alive.clone(), stdin.clone());
        let cwd = PathBuf::from(session.cwd());
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(mut msg) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(models) = model_catalog(&msg) {
                    if let Ok(mut saved) = catalog.lock() {
                        *saved = models.clone();
                    }
                    let _ = handle.emit("session", Event { id, msg: json!({ "type": "model_catalog", "models": models }) });
                }
                let active = active_run.lock().ok().and_then(|run| *run);
                if active.is_some() {
                    crate::capabilities::observe_claude(&handle, id, &msg);
                }
                if let Some(run) = active {
                    match msg["type"].as_str() {
                        Some("control_request") if msg.pointer("/request/subtype") == Some(&json!("can_use_tool")) =>
                            runs::record(&handle, |conn| runs::phase(conn, run, "waiting_approval").map_err(err)),
                        Some("rate_limit_event") =>
                            runs::record(&handle, |conn| runs::quota(conn, run, runs::Quota::claude(&msg["rate_limit_info"])).map_err(err)),
                        Some("system") if msg["model"].is_string() =>
                            runs::record(&handle, |conn| runs::usage(conn, run, runs::Usage {
                                model: msg["model"].as_str().map(str::to_owned), ..Default::default()
                            }).map_err(err)),
                        Some("result") => {
                            let outcome = if msg["is_error"] == json!(true) {
                                if crate::handoff::quota_reason(&msg.to_string()).is_some() { "paused_quota" } else { "failed" }
                            } else if msg["subtype"] == "success" { "completed" } else { "cancelled" };
                            if let Ok(mut active) = active_run.lock() {
                                *active = None;
                            }
                            runs::record(&handle, |conn| {
                                runs::usage(conn, run, runs::Usage::claude(&msg)).map_err(err)?;
                                runs::finish(conn, run, outcome).map_err(err)
                            });
                        }
                        _ => {}
                    }
                }
                if msg["type"] == json!("control_request") {
                    let request_id = msg["request_id"].as_str().unwrap_or("").to_string();
                    let subtype = msg.pointer("/request/subtype").and_then(Value::as_str);
                    if subtype == Some("mcp_message") && can_delegate {
                        handle_mcp_message(&handle, id, request_id, &msg["request"], &input, &flag);
                        continue;
                    }
                    if subtype != Some("can_use_tool") {
                        let _ = write_line(
                            &input,
                            &json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": "Filigranas no admite esta petición" } }),
                        );
                        continue;
                    }
                    let tool_name = msg.pointer("/request/tool_name").and_then(Value::as_str).unwrap_or("");
                    if can_delegate && tool_name.starts_with("mcp__filigranas__") {
                        let _ = write_line(&input, &json!({ "type": "control_response", "response": { "subtype": "success",
                            "request_id": request_id, "response": permission(&msg["request"], "accept") } }));
                        runs::on_active(&handle, id, |conn, run| runs::phase(conn, run, "running"));
                        continue;
                    }
                    // Garantía arquitectónica: el Project Manager NUNCA ejecuta
                    // herramientas directas (archivo, terminal, búsqueda, web).
                    if is_pm {
                        let _ = write_line(&input, &json!({ "type": "control_response", "response": { "subtype": "success",
                            "request_id": request_id, "response": {
                                "behavior": "deny",
                                "message": format!("El Project Manager no puede ejecutar herramientas directas ({tool_name}). Delega el trabajo técnico a un agente ejecutor usando mcp__filigranas__delegar.")
                            } } }));
                        continue;
                    }
                    if matches!(tool_name, "Agent" | "Task") {
                        let _ = write_line(&input, &json!({ "type": "control_response", "response": { "subtype": "success",
                            "request_id": request_id, "response": { "behavior": "deny", "message": "En Filigranas no se usan subagentes internos de Claude Code; usa mcp__filigranas__delegar para crear una subsesión visible." } } }));
                        continue;
                    }
                    // Nivel de permisos de la sesión: Filigranas puede aprobar por su cuenta.
                    let mode = handle.state::<AppState>().permissions.get(id);
                    let (kind, paths) = crate::autoapprove::claude_request(&msg["request"]);
                    if crate::autoapprove::approves(mode, &cwd, kind, &paths) {
                        let _ = write_line(&input, &json!({ "type": "control_response", "response": { "subtype": "success",
                            "request_id": request_id, "response": permission(&msg["request"], "accept") } }));
                        runs::on_active(&handle, id, |conn, run| runs::phase(conn, run, "running"));
                        let _ = handle.emit("session", Event { id, msg: json!({ "type": "auto_approved",
                            "tool": msg.pointer("/request/tool_name"), "input": msg.pointer("/request/input") }) });
                        continue;
                    }
                    let Ok(mut requests) = pending.lock() else { break };
                    if !flag.load(Ordering::SeqCst) || PermissionRequest::register(&mut requests, id, &mut msg, &flag).is_none() {
                        continue;
                    }
                    drop(requests);
                    if is_subsession {
                        notify_subsession(&handle, id);
                    }
                }
                if msg["type"] == json!("rate_limit_event") && msg.pointer("/rate_limit_info/status") == Some(&json!("rejected")) {
                    let window = msg.pointer("/rate_limit_info/rateLimitType").and_then(Value::as_str).unwrap_or("del plan");
                    crate::handoff::pause(&handle, id, &format!("cuota agotada: límite {window} de Claude"));
                }
                if msg["type"] == json!("result") {
                    handle.state::<AppState>().tracker.finished(id, msg["result"].as_str());
                    if is_subsession {
                        notify_subsession(&handle, id);
                    }
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
            let unexpected_exit = flag.swap(false, Ordering::SeqCst);
            if let Some(run) = active_run.lock().ok().and_then(|mut run| run.take()) {
                runs::record(&handle, |conn| runs::finish(conn, run, "interrupted").map_err(err));
            }
            if let Ok(mut p) = pending.lock() {
                p.retain(|_, request| !Arc::ptr_eq(&request.process, &flag));
            }
            if unexpected_exit {
                handle.state::<AppState>().tracker.exited(id);
                if is_subsession {
                    notify_subsession(&handle, id);
                }
                let _ = handle.emit("session", Event { id, msg: json!({ "type": "exit" }) });
            }
        });

        // El modo host necesita el saludo de control antes del primer mensaje.
        let init_request = if can_delegate {
            json!({ "subtype": "initialize", "sdkMcpServers": ["filigranas"] })
        } else {
            json!({ "subtype": "initialize" })
        };
        write_line(&stdin, &json!({ "type": "control_request", "request_id": uuid::Uuid::new_v4().to_string(), "request": init_request }))?;
        let input = Input { stdin, run };
        procs.insert(session.id, Proc { child, input: input.clone(), effort: effort.map(str::to_string), pinned_model, alive });
        Ok(input)
    }
}

pub(crate) fn open_session(state: &AppState, id: i64) -> CmdResult<db::Session> {
    db::session(&*state.db.lock().map_err(err)?, id).map_err(err)?.ok_or_else(|| "la sesión ya no existe".into())
}

// ── comandos ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCatalog {
    pub sessions: Vec<db::Session>,
    pub pm_claude: HashMap<String, db::Session>,
    pub pm_codex_projects: Vec<String>,
}

/// Catálogo global de sesiones abiertas de todos los proyectos en una única lectura.
#[tauri::command]
pub async fn session_catalog(app: AppHandle, paths: Vec<String>) -> CmdResult<SessionCatalog> {
    if paths.len() > 128 {
        return Err("máximo de 128 proyectos por consulta".into());
    }
    crate::background_read(app, move |state| {
        let conn = state.db.lock().map_err(err)?;
        let mut allowed = Vec::new();
        for path in &paths {
            if let Ok(canonical) = project_path(&conn, path) {
                if canonical == *path {
                    allowed.push(canonical);
                }
            }
        }
        let mut list = db::sessions_in(&conn, &allowed).map_err(err)?;
        for s in &mut list {
            s.status = crate::delegate::session_status(state, &conn, s);
        }
        let mut pm_claude = HashMap::new();
        for mut pm in db::pm_claude_sessions_in(&conn, &allowed).map_err(err)? {
            pm.status = crate::delegate::session_status(state, &conn, &pm);
            pm_claude.insert(pm.project.clone(), pm);
        }
        let pm_codex_projects = db::pm_codex_projects_in(&conn, &allowed).map_err(err)?;
        Ok(SessionCatalog { sessions: list, pm_claude, pm_codex_projects })
    }).await
}

#[tauri::command]
pub fn session_list(state: State<AppState>, project: String) -> CmdResult<Vec<db::Session>> {
    let conn = state.db.lock().map_err(err)?;
    let path = project_path(&conn, &project)?;
    let mut list = db::sessions(&conn, &path).map_err(err)?;
    for s in &mut list {
        s.status = crate::delegate::session_status(&state, &conn, s);
    }
    Ok(list)
}

/// Crea una subsesión hija de `parent_id` compartiendo su carpeta, rama y permisos.
#[tauri::command]
pub async fn session_create_subsession(
    app: AppHandle,
    parent_id: i64,
    engine: String,
    title: Option<String>,
    skill_role: Option<crate::skills::Role>,
) -> CmdResult<db::Session> {
    tauri::async_runtime::spawn_blocking(move || {
        create_subsession(&app, parent_id, &engine, title.as_deref(), skill_role)
    })
    .await
    .map_err(err)?
}

/// Crea una subsesión delegada por el Project Manager (Codex o Claude) sin exigir
/// una sesión de trabajo previa. Si `parent_id` es `Some`, hereda worktree/rama/permisos
/// de la sesión padre; si es `None` (Codex PM), hereda los permisos del proyecto.
pub fn create_pm_subsession(
    app: &AppHandle,
    project: &str,
    parent_id: Option<i64>,
    engine: &str,
    title: Option<&str>,
    skill_role: Option<crate::skills::Role>,
    task_id: Option<i64>,
) -> CmdResult<db::Session> {
    let state = app.state::<AppState>();
    let parent = parent_id.map(|pid| open_session(&state, pid)).transpose()?;
    if parent.as_ref().is_some_and(|p| p.parent_session.is_some() || p.delegated_by_pm) {
        return Err("una subsesión no puede crear otras subsesiones".into());
    }
    let provider = match engine {
        "claude" => uuid::Uuid::new_v4().to_string(),
        "codex" => String::new(),
        e if crate::acp::ENGINES.contains(&e) => String::new(),
        _ => return Err(format!("motor desconocido: {engine}")),
    };
    let names = numbered();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let title = title.map(str::trim).filter(|t| !t.is_empty());
    let current_branch = crate::git::head_at(Path::new(project)).ok().filter(|b| !b.starts_with("HEAD ·"));
    let session = {
        let mut conn = state.db.lock().map_err(err)?;
        let tx = conn.transaction().map_err(err)?;
        let s = db::create_session(&tx, project, engine, &provider, &names).map_err(err)?;
        db::set_session_delegated_by_pm(&tx, s.id, parent.as_ref().map(|p| p.id), title).map_err(err)?;
        if let Some(role) = skill_role {
            crate::skills::assign_session(&tx, s.id, role)?;
        }
        if let Some(tid) = task_id {
            let _ = tasks::link(&tx, project, tid, s.id);
        }
        if let Some(p) = &parent {
            if let (Some(wt), Some(br)) = (&p.worktree, &p.branch) {
                db::set_session_worktree(
                    &tx,
                    s.id,
                    wt,
                    br,
                    p.base.as_deref().unwrap_or("main"),
                    p.base_commit.as_deref().unwrap_or(""),
                )
                .map_err(err)?;
            } else if let Some(br) = &p.branch {
                tx.execute(
                    "UPDATE sessions SET branch = ?2, base = ?3, base_commit = ?4 WHERE id = ?1",
                    rusqlite::params![s.id, br, p.base, p.base_commit],
                )
                .map_err(err)?;
            }
        } else if let Some(br) = &current_branch {
            tx.execute("UPDATE sessions SET branch = ?2 WHERE id = ?1", rusqlite::params![s.id, br])
                .map_err(err)?;
        }
        let saved = db::session(&tx, s.id).map_err(err)?.ok_or("la subsesión no se guardó")?;
        tx.commit().map_err(err)?;
        saved
    };
    if let Some(p) = &parent {
        state.permissions.inherit(p.id, session.id);
    } else {
        state.permissions.inherit_project(project, session.id);
    }
    let _ = app.emit("sessions-changed", json!({ "project": project, "focus": null }));
    tasks::changed(app);
    Ok(session)
}

/// Crea una subsesión visible en «Conversaciones» bajo la sesión padre.
pub fn create_subsession(
    app: &AppHandle,
    parent_id: i64,
    engine: &str,
    title: Option<&str>,
    skill_role: Option<crate::skills::Role>,
) -> CmdResult<db::Session> {
    let state = app.state::<AppState>();
    let parent = open_session(&state, parent_id)?;
    if parent.parent_session.is_some() {
        return Err("una subsesión no puede crear otras subsesiones".into());
    }
    let provider = match engine {
        "claude" => uuid::Uuid::new_v4().to_string(),
        "codex" => String::new(),
        e if crate::acp::ENGINES.contains(&e) => String::new(),
        _ => return Err(format!("motor desconocido: {engine}")),
    };
    let names = numbered();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let title = title.map(str::trim).filter(|t| !t.is_empty());
    let session = {
        let mut conn = state.db.lock().map_err(err)?;
        let tx = conn.transaction().map_err(err)?;
        let s = db::create_session(&tx, &parent.project, engine, &provider, &names).map_err(err)?;
        db::set_session_parent(&tx, s.id, parent.id, title).map_err(err)?;
        if let Some(role) = skill_role {
            crate::skills::assign_session(&tx, s.id, role)?;
        }
        // Comparte carpeta y rama de la sesión padre sin crear un worktree nuevo.
        if let (Some(wt), Some(br)) = (&parent.worktree, &parent.branch) {
            db::set_session_worktree(
                &tx,
                s.id,
                wt,
                br,
                parent.base.as_deref().unwrap_or("main"),
                parent.base_commit.as_deref().unwrap_or(""),
            )
            .map_err(err)?;
        } else if let Some(br) = &parent.branch {
            tx.execute(
                "UPDATE sessions SET branch = ?2, base = ?3, base_commit = ?4 WHERE id = ?1",
                rusqlite::params![s.id, br, parent.base, parent.base_commit],
            )
            .map_err(err)?;
        }
        let saved = db::session(&tx, s.id).map_err(err)?.ok_or("la subsesión no se guardó")?;
        tx.commit().map_err(err)?;
        saved
    };
    state.permissions.inherit(parent.id, session.id);
    let _ = app.emit("sessions-changed", json!({ "project": parent.project, "focus": null }));
    tasks::changed(app);
    Ok(session)
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
pub async fn session_create(app: AppHandle, project: String, engine: String, task: Option<i64>, skill_role: Option<crate::skills::Role>) -> CmdResult<Created> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = project_path(&*state.db.lock().map_err(err)?, &project)?;
        new_session(&app, &path, &engine, task, skill_role)
    })
    .await
    .map_err(err)?
}

/// Crea un chat. Las tareas nuevas disponen de una rama y un worktree propios.
pub fn new_session(app: &AppHandle, project: &str, engine: &str, task: Option<i64>, skill_role: Option<crate::skills::Role>) -> CmdResult<Created> {
    let state = app.state::<AppState>();
    let provider = match engine {
        "claude" => uuid::Uuid::new_v4().to_string(),
        "codex" => String::new(),
        e if crate::acp::ENGINES.contains(&e) => String::new(),
        _ => return Err(format!("motor desconocido: {engine}")),
    };
    let names = numbered();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let _git = task.map(|_| state.publication.try_lock()
        .map_err(|_| "hay una operación Git en curso")).transpose()?;
    let checkout = if let Some(task) = task {
        {
            let conn = state.db.lock().map_err(err)?;
            tasks::validate_start(&conn, project, task)?;
        }
        let dir = app.path().app_data_dir().map_err(err)?;
        Some(crate::isolate::create_task_checkout(&dir, Path::new(project), engine)?)
    } else {
        None
    };
    let save = || -> CmdResult<db::Session> {
        let mut conn = state.db.lock().map_err(err)?;
        let tx = conn.transaction().map_err(err)?;
        if let Some(task) = task { tasks::validate_start(&tx, project, task)?; }
        let s = db::create_session(&tx, project, engine, &provider, &names).map_err(err)?;
        if let Some(role) = skill_role { crate::skills::assign_session(&tx, s.id, role)?; }
        if let Some(checkout) = &checkout {
            db::set_session_worktree(&tx, s.id, &checkout.worktree, &checkout.branch, &checkout.base, &checkout.base_commit).map_err(err)?;
        }
        if let Some(task) = task { tasks::link(&tx, project, task, s.id)?; }
        crate::work::join(&tx, project, s.id)?;
        let session = db::session(&tx, s.id).map_err(err)?.ok_or("la sesión no se guardó")?;
        tx.commit().map_err(err)?;
        Ok(session)
    };
    let session = match save() {
        Ok(session) => session,
        Err(error) => {
            if let Some(checkout) = &checkout {
                if let Err(cleanup) = crate::isolate::discard_unregistered(Path::new(project), checkout) {
                    return Err(format!("{error}. Se conserva {} para recuperar su contenido: {cleanup}", checkout.worktree));
                }
            }
            return Err(error);
        }
    };
    let notice = match &checkout {
        Some(checkout) if checkout.main_dirty => Some("La tarea aislada parte del último commit. Los cambios pendientes del proyecto siguen en su carpeta original.".into()),
        Some(_) => None,
        None => Some("Este chat comparte la carpeta y la rama de la sesión de trabajo. Organiza su área desde Trabajo.".into()),
    };
    tasks::changed(app);
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
        if session.engine == "codex" {
            return Ok(Vec::new()); // El historial llega mediante coordinator_open.
        }
        if session.engine != "claude" {
            if session.provider_session.is_empty() {
                return Ok(Vec::new()); // sesión nueva: arranca con el primer mensaje
            }
            state.acp.attach(&app, &state, &session)?;
            return Ok(Vec::new());
        }
        read_history(&session.provider_session)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn session_send(app: AppHandle, id: i64, text: String, effort: Option<String>, task: Option<i64>,
    attachments: Option<Vec<crate::attachments::Attachment>>, expected_engine: Option<String>,
) -> CmdResult<()> {
    let attachments = attachments.unwrap_or_default();
    if text.trim().is_empty() && attachments.is_empty() {
        return Err("mensaje vacío".into());
    }
    if effort.as_deref().is_some_and(|e| !EFFORTS.contains(&e) && e != "auto") {
        return Err("nivel de esfuerzo no válido".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let message = crate::attachments::Message::prepare(&app.path().app_data_dir().map_err(err)?, text, attachments)?;
        send_content(&app, id, message, effort, Vec::new(), task, expected_engine.as_deref())
    }).await.map_err(err)?
}

/// Envía un mensaje a la sesión, arrancando su proceso si hace falta.
/// Bloquea mientras arranca: llamar fuera del hilo principal.
pub fn send_message(app: &AppHandle, id: i64, text: String, effort: Option<String>) -> CmdResult<()> {
    send_content(app, id, crate::attachments::Message::text(text), effort, Vec::new(), None, None)
}

pub(crate) fn send_with_images(app: &AppHandle, id: i64, text: &str, images: Vec<Value>) -> CmdResult<()> {
    send_content(app, id, crate::attachments::Message::text(text.into()), None, images, None, None)
}

fn send_content(app: &AppHandle, id: i64, mut message: crate::attachments::Message, effort: Option<String>,
    mut images: Vec<Value>, pm_task: Option<i64>, expected_engine: Option<&str>,
) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let gate = state.chat_gate.lock().map_err(err)?;
    let git_gate = state.publication.try_lock().map_err(|_| "hay una operación Git en curso; espera a que termine")?;
    let session = open_session(&state, id)?;
    if expected_engine.is_some_and(|engine| engine != session.engine) {
        return Err("La sesión ha cambiado de proveedor. Vuelve a enviar desde la sesión actual.".into());
    }
    if !images.is_empty() && session.engine != "claude" {
        return Err("la sesión no admite capturas de diseño".into());
    }
    if session.engine == "codex" {
        drop(git_gate);
        drop(gate);
        // En Codex, «auto» fuera de una tarea es el esfuerzo por defecto del modelo.
        let effort = effort.filter(|e| e != "auto");
        return crate::codex::send_turn(app, &session.project, Some(&session), None, message, effort);
    }
    if session.engine == "claude" {
        images.extend(message.take_claude_images());
    }
    let text = &message.text;
    let (run, input_text) = {
        let mut conn = state.db.lock().map_err(err)?;
        let tx = conn.transaction().map_err(err)?;
        let is_pm = crate::chat::is_pm(&tx, id).map_err(err)?;
        let task = if is_pm {
            if crate::chat::pm_id(&tx, &session.project).map_err(err)? != Some(id) {
                return Err("el Project manager ha cambiado de proveedor".into());
            }
            pm_task
        } else {
            tasks::linked(&tx, id).map_err(err)?
        };
        let scope = runs::session_scope(id);
        let previous = runs::last_task(&tx, &scope).map_err(err)?;
        let run = runs::begin(&tx, &session.project, &scope, &session.engine, (!is_pm).then_some(id), task)?;
        let input = runs::task_input(&tx, run, &session.project, task, previous, text)?;
        let input = crate::chat::with_context(&tx, &session.project, (!is_pm).then_some(id), run, input)?;
        let input = crate::capabilities::turn_context(app, &tx, &session.project, (!is_pm).then_some(id), run, input)?;
        db::set_session_task(&tx, id, text).map_err(err)?;
        if session.paused.is_some() {
            db::set_session_paused(&tx, id, None).map_err(err)?;
        }
        tx.commit().map_err(err)?;
        (run, input)
    };
    drop(git_gate);
    drop(gate);
    tasks::changed(app);
    let result = (|| {
        if session.engine != "claude" {
            message.retain_files();
            return state.acp.send(app, &state, &session, input_text, run);
        }
        if let Some(e) = &effort {
            db::set_session_effort(&*state.db.lock().map_err(err)?, id, e).map_err(err)?;
        }
        let input = state.claude.proc(app, &session, effort.as_deref())?;
        *input.run.lock().map_err(err)? = Some(run);
        state.tracker.started(id);
        if session.parent_session.is_some() {
            notify_subsession(app, id);
        }
        let content = if images.is_empty() { json!(input_text) } else {
            images.insert(0, json!({ "type": "text", "text": input_text }));
            json!(images)
        };
        message.retain_files();
        let sent = write_line(&input.stdin, &json!({ "type": "user", "message": { "role": "user", "content": content }, "parent_tool_use_id": null, "session_id": "" }));
        if sent.is_err() {
            *input.run.lock().map_err(err)? = None;
            state.tracker.exited(id);
            if session.parent_session.is_some() {
                notify_subsession(app, id);
            }
        }
        sent
    })();
    if result.is_err() {
        runs::record(app, |conn| runs::finish(conn, run, "failed").map_err(err));
    }
    result
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
pub fn session_respond(app: AppHandle, state: State<AppState>, request_id: String, decision: String) -> CmdResult<()> {
    if !DECISIONS.contains(&decision.as_str()) {
        return Err("decisión no válida".into());
    }
    let claimed = state.claude.pending.lock().map_err(err)?.remove(&request_id);
    let Some(claimed) = claimed else {
        return if state.acp.respond(&app, &request_id, &decision)? { Ok(()) } else { Err("esa petición ya no está pendiente".into()) };
    };
    let procs = state.claude.procs.lock().map_err(err)?;
    let p = procs.get(&claimed.session)
        .filter(|p| Arc::ptr_eq(&p.alive, &claimed.process) && p.alive.load(Ordering::SeqCst))
        .ok_or("el proceso que pidió el permiso ya no está en marcha")?;
    write_line(
        &p.input.stdin,
        &json!({ "type": "control_response", "response": { "subtype": "success",
            "request_id": claimed.provider_id, "response": permission(&claimed.request, &decision) } }),
    )?;
    drop(procs);
    if state.claude.pending_for(claimed.session) == 0 {
        runs::on_active(&app, claimed.session, |conn, run| runs::phase(conn, run, "running"));
        notify_subsession(&app, claimed.session);
    }
    Ok(())
}

fn claude_model(conn: &rusqlite::Connection, id: i64) -> CmdResult<Option<String>> {
    Ok(db::session_options(conn, id).map_err(err)?.get("model").and_then(Value::as_str).map(str::to_owned))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOptions {
    models: Vec<ModelOption>,
    pinned_model: Option<String>,
}

#[tauri::command]
pub async fn claude_chat_options(app: AppHandle, id: i64) -> CmdResult<ChatOptions> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.chat_gate.lock().map_err(err)?;
        let session = open_session(&state, id)?;
        if session.engine != "claude" {
            return Err("la sesión no es de Claude Code".into());
        }
        let pinned_model = claude_model(&*state.db.lock().map_err(err)?, id)?;
        let models = state.claude.models.lock().map_err(err)?.clone();
        if models.is_empty() {
            state.claude.proc(&app, &session, None)?;
        }
        Ok(ChatOptions { models, pinned_model })
    }).await.map_err(err)?
}

/// Cambia una opción admitida por el proveedor de la sesión.
#[tauri::command]
pub async fn session_set_option(app: AppHandle, id: i64, key: String, value: String) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.chat_gate.lock().map_err(err)?;
        let session = open_session(&state, id)?;
        if session.engine == "claude" && key == "model" {
            let valid = value.is_empty() || state.claude.models.lock().map_err(err)?.iter().any(|m| m.id == value);
            if !valid {
                return Err("el modelo no está disponible".into());
            }
            let conn = state.db.lock().map_err(err)?;
            if runs::active(&conn, &runs::session_scope(id))?.is_some() {
                return Err("espera a que termine el turno".into());
            }
            db::update_session_option(&conn, id, &key, (!value.is_empty()).then_some(value.as_str())).map_err(err)?;
            return Ok(json!([]));
        }
        if session.engine == "claude" || session.engine == "codex" {
            return Err("la opción no pertenece a un proveedor ACP".into());
        }
        state.acp.set_option(&app, &state, &session, &key, &value)
    })
    .await
    .map_err(err)?
}

/// Cierra la sesión: termina el proceso y la quita de las pestañas. El
/// transcript sigue en Claude Code.
#[tauri::command]
pub async fn session_close(app: AppHandle, id: i64) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.chat_gate.lock().map_err(err)?;
        let session = open_session(&state, id)?;
        if crate::chat::is_pm(&*state.db.lock().map_err(err)?, id).map_err(err)? {
            return Err("cierra el Project manager desde su pestaña".into());
        }
        if session.engine == "codex" && runs::session_active(&*state.db.lock().map_err(err)?, id).map_err(err)? {
            crate::codex::interrupt(&app, &session.provider_session)?;
        }
        state.claude.forget(id);
        state.acp.close(id)?;
        db::close_session(&*state.db.lock().map_err(err)?, id).map_err(err)?;
        tasks::changed(&app);
        Ok(())
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_requests_keep_their_process_when_provider_ids_match() {
        let mut pending = HashMap::new();
        let first_process = Arc::new(AtomicBool::new(true));
        let second_process = Arc::new(AtomicBool::new(true));
        let mut first = json!({ "request_id": "1", "request": { "input": "first" } });
        let mut second = json!({ "request_id": "1", "request": { "input": "second" } });
        PermissionRequest::register(&mut pending, 10, &mut first, &first_process).unwrap();
        PermissionRequest::register(&mut pending, 20, &mut second, &second_process).unwrap();

        let first = pending.remove(first["request_id"].as_str().unwrap()).unwrap();
        let second = pending.remove(second["request_id"].as_str().unwrap()).unwrap();
        assert!(Arc::ptr_eq(&first.process, &first_process));
        assert!(Arc::ptr_eq(&second.process, &second_process));
        assert_eq!((first.session, first.provider_id.as_str(), &first.request["input"]), (10, "1", &json!("first")));
        assert_eq!((second.session, second.provider_id.as_str(), &second.request["input"]), (20, "1", &json!("second")));
    }


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
            let mut cmd = crate::cli::command("claude");
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
