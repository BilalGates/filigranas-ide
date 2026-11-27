use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::{claude, db, err, AppState, CmdResult};

// Herramientas del coordinador para delegar en los agentes ejecutores:
// Codex las llama como herramientas dinámicas (`item/tool/call`) y el IDE
// crea las sesiones, envía las tareas y devuelve su estado. Las sesiones
// delegadas aparecen como pestañas y sus permisos los aprueba el usuario.

/// Sube al cambiar las herramientas: los hilos creados con otra versión se
/// sustituyen, porque Codex solo las acepta al crear el hilo.
pub const TOOLS_VERSION: i64 = 3;

const ENGINES: [(&str, &str); 5] = [
    ("claude", "claude code"),
    ("codex", "codex"),
    ("opencode", "opencode"),
    ("agy", "antigravity"),
    ("devin", "devin"),
];
const WAIT_DEFAULT: u64 = 300;
const WAIT_MAX: u64 = 900;

pub fn specs() -> Value {
    json!([
        {
            "type": "function",
            "name": "delegar",
            "description": "Crea una sesión de un agente ejecutor en este proyecto y le envía una tarea. Devuelve el nombre de la sesión. \
La tarea debe ser autocontenida: objetivo, archivos relevantes, restricciones y cómo comprobar que está hecha. \
Los permisos que pida el agente los aprueba el usuario en la pestaña de la sesión.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agente": { "type": "string", "enum": ["claude", "opencode", "agy", "devin"], "description": "claude = Claude Code, opencode = OpenCode (modelo gratuito), agy = Antigravity (Gemini), devin = Devin" },
                    "archivos": { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "Archivos o carpetas relativos asignados al agente, sin comodines. Usa . para todo el proyecto, en ejecución secuencial." },
                    "tarea": { "type": "string", "description": "Encargo completo para el agente." },
                    "esfuerzo": { "type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "Solo Claude Code. Por defecto medium." }
                },
                "required": ["agente", "tarea"],
                "additionalProperties": false
            }
        },
        {
            "type": "function",
            "name": "asignar_archivos",
            "description": "Cambia el área de un agente inactivo de la sesión compartida. No mueve archivos. Los ámbitos solapados se ejecutan por turnos.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sesion": { "type": "string" },
                    "archivos": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
                },
                "required": ["sesion", "archivos"], "additionalProperties": false
            }
        },
        {
            "type": "function",
            "name": "continuar_sesion",
            "description": "Envía otro encargo al mismo agente. Permite continuar después de esperar un ámbito ocupado, sin crear otro chat.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sesion": { "type": "string" },
                    "tarea": { "type": "string" }
                },
                "required": ["sesion", "tarea"], "additionalProperties": false
            }
        },
        {
            "type": "function",
            "name": "estado_sesiones",
            "description": "Lista las sesiones de agentes abiertas en este proyecto con su estado (en marcha, esperando permiso, inactiva) y su última respuesta.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "type": "function",
            "name": "esperar_sesion",
            "description": "Espera a que una sesión termine su turno y devuelve su última respuesta. Si vence el plazo, devuelve el estado actual.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sesion": { "type": "string", "description": "Nombre de la sesión (p. ej. xavi)." },
                    "segundos": { "type": "integer", "minimum": 5, "maximum": WAIT_MAX, "description": "Plazo máximo de espera. Por defecto 300." }
                },
                "required": ["sesion"],
                "additionalProperties": false
            }
        }
    ])
}

/// Herramientas MCP del servidor embebido `filigranas` para sesiones de Claude Code.
pub fn claude_mcp_tools() -> Value {
    json!([
        {
            "name": "delegar",
            "description": "Crea una subsesión visible en Filigranas bajo esta conversación (en el panel «Conversaciones»), con su propio hilo, rol y motor, y le envía un encargo. Comparte la carpeta y rama de la sesión padre. Usa esta herramienta siempre que necesites delegar o lanzar un subagente.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "titulo": { "type": "string", "description": "Título breve de la subsesión visible en el panel «Conversaciones» (p. ej. «Investigar autenticación»)." },
                    "tarea": { "type": "string", "description": "Encargo completo y autocontenido: objetivo, contexto, archivos relevantes y qué resultado devolver." },
                    "agente": { "type": "string", "enum": ["claude", "codex", "opencode", "agy", "devin"], "description": "Motor que ejecutará la subsesión. Por defecto claude." },
                    "rol": { "type": "string", "enum": ["researcher", "designer", "senior", "junior", "auditor", "auditor2"], "description": "Rol de skills de la subsesión. Por defecto senior." },
                    "esfuerzo": { "type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "Nivel de esfuerzo para Claude Code o Codex. Por defecto medium." }
                },
                "required": ["titulo", "tarea"],
                "additionalProperties": false
            }
        },
        {
            "name": "estado_sesiones",
            "description": "Lista las subsesiones creadas desde esta conversación con su título, motor, estado (trabajando, esperando permiso, terminada, en espera) y su última respuesta.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "esperar_sesion",
            "description": "Espera a que una subsesión termine su turno y devuelve su respuesta completa. Si vence el plazo sigue viva y trabajando: vuelve a llamar a esperar_sesion para continuar esperando.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sesion": { "type": "string", "description": "Nombre o título de la subsesión devuelto por delegar." },
                    "segundos": { "type": "integer", "minimum": 5, "maximum": WAIT_MAX, "description": "Plazo máximo de esta espera en segundos. Por defecto 300; se puede repetir si sigue trabajando." }
                },
                "required": ["sesion"],
                "additionalProperties": false
            }
        },
        {
            "name": "continuar_sesion",
            "description": "Envía otro encargo o aclaración a una subsesión existente para continuar en el mismo hilo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sesion": { "type": "string", "description": "Nombre o título de la subsesión." },
                    "tarea": { "type": "string", "description": "Nuevo mensaje o encargo para la subsesión." }
                },
                "required": ["sesion", "tarea"],
                "additionalProperties": false
            }
        }
    ])
}

/// Estado observable de una sesión para pintarlo en el panel «Conversaciones».
pub fn session_status(state: &AppState, conn: &rusqlite::Connection, s: &db::Session) -> Option<String> {
    let t = state.tracker.get(s.id);
    let asking = state.claude.pending_for(s.id) + state.acp.pending_for(s.id);
    if asking > 0 {
        return Some("esperando".into());
    }
    if t.running {
        return Some("trabajando".into());
    }
    if t.turns > 0 || t.exited {
        return Some("terminada".into());
    }
    if s.parent_session.is_some() {
        let done: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM task_runs WHERE session_id = ?1 AND ended_ms IS NOT NULL)", [s.id], |r| r.get(0))
            .unwrap_or(false);
        return Some(if done { "terminada" } else { "en_espera" }.into());
    }
    None
}

fn label(engine: &str) -> &str {
    ENGINES.iter().find(|(id, _)| *id == engine).map(|(_, l)| *l).unwrap_or(engine)
}

/// Recorta a `max` caracteres sin partir ningún carácter.
fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

fn describe(state: &AppState, s: &db::Session, max: usize) -> String {
    let t = state.tracker.get(s.id);
    let asking = state.claude.pending_for(s.id) + state.acp.pending_for(s.id);
    let status = if asking > 0 {
        "esperando permiso del usuario"
    } else if t.running {
        "en marcha"
    } else if t.exited {
        "el proceso terminó sin acabar el turno"
    } else if t.turns == 0 {
        "sin turnos terminados en esta ejecución del IDE"
    } else {
        "inactiva"
    };
    let mut line = format!("{} · {} · {}", s.name, label(&s.engine), status);
    if let (Some(b), Some(w)) = (&s.branch, &s.worktree) {
        line.push_str(&format!(" · rama {b} en {w}{}", if s.integrated.is_some() { " (integrada)" } else { "" }));
    }
    if !t.last.trim().is_empty() {
        line.push_str(&format!("\nÚltima respuesta:\n{}", clip(t.last.trim(), max)));
    }
    line
}

/// Ejecuta una herramienta del coordinador del hilo `thread`. Puede tardar
/// (esperar_sesion): se llama fuera del hilo lector de Codex.
pub fn handle(app: &AppHandle, thread: &str, tool: &str, args: &Value) -> CmdResult<String> {
    let state = app.state::<AppState>();
    let project = db::project_for_thread(&*state.db.lock().map_err(err)?, thread).map_err(err)?.ok_or("este hilo no pertenece a ningún proyecto del IDE")?;
    match tool {
        "delegar" => {
            let engine = args["agente"].as_str().unwrap_or("");
            if !ENGINES.iter().any(|(id, _)| *id == engine) {
                return Err(format!("agente desconocido: {engine}"));
            }
            let task = args["tarea"].as_str().unwrap_or("").trim();
            if task.is_empty() {
                return Err("falta la tarea".into());
            }
            let paths = args["archivos"].as_array().map(|paths| paths.iter().map(|p| p.as_str().map(str::to_owned).ok_or("cada archivo debe ser una ruta de texto")).collect::<Result<Vec<_>, _>>()).transpose()?.unwrap_or_else(|| vec![".".into()]);
            let effort = (engine == "claude").then(|| args["esfuerzo"].as_str().map(str::to_string)).flatten();
            let task_id = {
                let mut conn = state.db.lock().map_err(err)?;
                match crate::runs::task_for_thread(&conn, thread).map_err(err)? {
                    Some(id) => id,
                    None => crate::tasks::delegated(&mut conn, &project, task)?,
                }
            };
            crate::tasks::changed(app);
            let created = claude::new_session(app, &project, engine, Some(task_id), None)?;
            let session = created.session;
            {
                let conn = state.db.lock().map_err(err)?;
                if let Err(error) = crate::work::assign(&conn, &project, session.id, paths) {
                    db::close_session(&conn, session.id).map_err(err)?;
                    return Err(error);
                }
            }
            let _ = app.emit("sessions-changed", json!({ "project": project, "focus": null }));
            if let Err(error) = claude::send_message(app, session.id, format!("Encargo del coordinador del proyecto:\n\n{task}"), effort) {
                return Ok(format!("Sesión «{}» creada para la tarea #{task_id}, pero el turno no se inició: {error}. Conserva este chat. Tras resolverlo o esperar al agente ocupado, usa continuar_sesion con este nombre para reintentar.", session.name));
            }
            let place = match (&session.branch, &session.worktree) {
                (Some(b), Some(w)) => format!("Trabaja en la rama {b}, en {w}; sus cambios no llegan al proyecto hasta que el usuario los integre."),
                _ => format!("Comparte la carpeta del proyecto y la rama {}. No necesita integrar diffs de worktrees.", session.branch.as_deref().unwrap_or("de la sesión de trabajo")),
            };
            let notice = created.notice.map(|n| format!("\nAviso: {n}.")).unwrap_or_default();
            Ok(format!(
                "Tarea #{task_id} enviada a la sesión «{}» ({}). {place}{notice}\nSigue su avance con estado_sesiones o espera el resultado con esperar_sesion {{\"sesion\": \"{}\"}}. \
Si el agente pide permisos, el usuario los aprueba en la pestaña de la sesión.",
                session.name,
                label(engine),
                session.name
            ))
        }
        "asignar_archivos" | "continuar_sesion" => {
            let name = args["sesion"].as_str().unwrap_or("");
            let list = db::sessions(&*state.db.lock().map_err(err)?, &project).map_err(err)?;
            let session = list.iter().find(|s| s.name == name).ok_or_else(|| format!("no hay una sesión abierta llamada «{name}»"))?;
            if tool == "asignar_archivos" {
                let paths = args["archivos"].as_array().ok_or("falta la lista de archivos")?.iter()
                    .map(|p| p.as_str().map(str::to_owned).ok_or("cada archivo debe ser una ruta de texto")).collect::<Result<Vec<_>, _>>()?;
                crate::work::assign(&*state.db.lock().map_err(err)?, &project, session.id, paths)?;
                crate::tasks::changed(app);
                return Ok(format!("Reparto actualizado para {name}. Se aplicará en su próximo turno."));
            }
            let task = args["tarea"].as_str().filter(|s| !s.trim().is_empty()).ok_or("falta el encargo")?;
            claude::send_message(app, session.id, format!("Encargo del coordinador del proyecto:\n\n{task}"), None)?;
            Ok(format!("Encargo enviado a {name}."))
        }
        "estado_sesiones" => {
            let list = db::sessions(&*state.db.lock().map_err(err)?, &project).map_err(err)?;
            if list.is_empty() {
                return Ok("No hay sesiones de agentes abiertas en este proyecto.".into());
            }
            Ok(list.iter().map(|s| describe(&state, s, 600)).collect::<Vec<_>>().join("\n\n"))
        }
        "esperar_sesion" => {
            let name = args["sesion"].as_str().unwrap_or("");
            let list = db::sessions(&*state.db.lock().map_err(err)?, &project).map_err(err)?;
            let s = list.iter().find(|s| s.name == name).ok_or_else(|| format!("no hay ninguna sesión abierta llamada «{name}»"))?;
            let secs = args["segundos"].as_u64().unwrap_or(WAIT_DEFAULT).clamp(5, WAIT_MAX);
            let t = state.tracker.wait_idle(s.id, Duration::from_secs(secs));
            let mut out = describe(&state, s, 4000);
            if t.running {
                out.push_str(&format!("\n(Sigue en marcha tras {secs} s de espera.)"));
            }
            Ok(out)
        }
        _ => Err(format!("herramienta desconocida: {tool}")),
    }
}

fn derive_title(explicit: Option<&str>, task: &str) -> String {
    let raw = explicit.map(str::trim).filter(|s| !s.is_empty()).unwrap_or_else(|| {
        task.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Subsesión")
    });
    clip(raw, 60)
}

fn find_child<'a>(list: &'a [db::Session], parent_id: i64, query: &str) -> Option<&'a db::Session> {
    let q = query.trim();
    list.iter()
        .find(|s| s.parent_session == Some(parent_id) && (s.name == q || s.title.as_deref() == Some(q)))
        .or_else(|| list.iter().find(|s| s.parent_session == Some(parent_id) && (s.name.eq_ignore_ascii_case(q) || s.title.as_deref().is_some_and(|t| t.eq_ignore_ascii_case(q)))))
        .or_else(|| list.iter().find(|s| s.name == q || s.title.as_deref() == Some(q)))
}

/// Ejecuta una herramienta MCP de delegación llamada por una sesión de Claude Code.
pub fn handle_claude(app: &AppHandle, parent_id: i64, tool: &str, args: &Value) -> CmdResult<String> {
    let state = app.state::<AppState>();
    let parent = claude::open_session(&state, parent_id)?;
    if parent.parent_session.is_some() {
        return Err("una subsesión no puede crear otras subsesiones".into());
    }
    let project = parent.project.clone();
    match tool {
        "delegar" => {
            let engine = args["agente"].as_str().filter(|s| !s.is_empty()).unwrap_or("claude");
            if !ENGINES.iter().any(|(id, _)| *id == engine) {
                return Err(format!("agente desconocido: {engine}"));
            }
            let task = args["tarea"].as_str().unwrap_or("").trim();
            if task.is_empty() {
                return Err("falta la tarea".into());
            }
            let title = derive_title(args["titulo"].as_str(), task);
            let role = args["rol"].as_str().filter(|r| *r != "pm").map(|r| crate::skills::Role::from_key(Some(r)));
            let effort = matches!(engine, "claude" | "codex").then(|| args["esfuerzo"].as_str().map(str::to_string)).flatten();
            let session = claude::create_subsession(app, parent_id, engine, Some(&title), role)?;
            let prompt = format!("Encargo delegado desde «{}» ({title}):\n\n{task}", parent.name);
            if let Err(error) = claude::send_message(app, session.id, prompt, effort) {
                return Ok(format!(
                    "Subsesión «{}» ({title}, {}) creada, pero el turno no pudo arrancar: {error}. Puedes reintentar con continuar_sesion.",
                    session.name,
                    label(engine),
                ));
            }
            Ok(format!(
                "Subsesión «{}» creada ({title} · {}) y en marcha bajo esta conversación.\n\
Comparte la carpeta y rama actuales. Sigue su estado con estado_sesiones o espera su resultado con esperar_sesion {{\"sesion\": \"{}\"}}.",
                session.name,
                label(engine),
                session.name,
            ))
        }
        "estado_sesiones" => {
            let list = db::sessions(&*state.db.lock().map_err(err)?, &project).map_err(err)?;
            let children: Vec<&db::Session> = list.iter().filter(|s| s.parent_session == Some(parent_id)).collect();
            if children.is_empty() {
                return Ok("No hay subsesiones abiertas bajo esta conversación.".into());
            }
            Ok(children
                .into_iter()
                .map(|s| {
                    let head = s.title.as_deref().map(|t| format!("{t} ({})", s.name)).unwrap_or_else(|| s.name.clone());
                    format!("{head}\n{}", describe(&state, s, 600))
                })
                .collect::<Vec<_>>()
                .join("\n\n"))
        }
        "esperar_sesion" => {
            let name = args["sesion"].as_str().unwrap_or("");
            let list = db::sessions(&*state.db.lock().map_err(err)?, &project).map_err(err)?;
            let s = find_child(&list, parent_id, name)
                .ok_or_else(|| format!("no hay ninguna subsesión abierta llamada «{name}»"))?;
            let secs = args["segundos"].as_u64().unwrap_or(WAIT_DEFAULT).clamp(5, WAIT_MAX);
            let t = state.tracker.wait_idle(s.id, Duration::from_secs(secs));
            let mut out = describe(&state, s, 8000);
            if t.running {
                out.push_str(&format!("\n(La subsesión sigue trabajando tras {secs} s y no se ha cerrado. Vuelve a llamar a esperar_sesion para esperar su resultado.)"));
            }
            Ok(out)
        }
        "continuar_sesion" => {
            let name = args["sesion"].as_str().unwrap_or("");
            let task = args["tarea"].as_str().filter(|s| !s.trim().is_empty()).ok_or("falta el encargo")?;
            let list = db::sessions(&*state.db.lock().map_err(err)?, &project).map_err(err)?;
            let s = find_child(&list, parent_id, name)
                .ok_or_else(|| format!("no hay ninguna subsesión abierta llamada «{name}»"))?;
            claude::send_message(app, s.id, format!("Seguimiento desde «{}»:\n\n{task}", parent.name), None)?;
            Ok(format!("Seguimiento enviado a la subsesión «{}».", s.name))
        }
        _ => Err(format!("herramienta desconocida: {tool}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_are_valid_function_tools() {
        let specs = specs();
        let names: Vec<&str> = specs.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["delegar", "asignar_archivos", "continuar_sesion", "estado_sesiones", "esperar_sesion"]);
        for t in specs.as_array().unwrap() {
            assert_eq!(t["type"], json!("function"));
            assert_eq!(t["inputSchema"]["type"], json!("object"));
        }
    }

    #[test]
    fn clip_respects_characters() {
        assert_eq!(clip("añoñ", 2), "añ…");
        assert_eq!(clip("hola", 10), "hola");
    }

    #[test]
    fn claude_mcp_tools_include_all_engines_and_subsession_ops() {
        let tools = claude_mcp_tools();
        let arr = tools.as_array().unwrap();
        let names: Vec<&str> = arr.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["delegar", "estado_sesiones", "esperar_sesion", "continuar_sesion"]);
        let engines: Vec<&str> = arr[0]["inputSchema"]["properties"]["agente"]["enum"]
            .as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(engines, ["claude", "codex", "opencode", "agy", "devin"]);
        assert_eq!(derive_title(Some("  Investigar auth "), "tarea"), "Investigar auth");
        assert_eq!(derive_title(None, "\nPrimera línea\nSegunda"), "Primera línea");
    }

    #[test]
    fn subsession_db_parent_and_work_before_turn() {
        let conn = db::open(std::path::Path::new(":memory:")).unwrap();
        let parent = db::create_session(&conn, "/r/p", "claude", "u-parent", &["sesión 1"]).unwrap();
        let child = db::create_session(&conn, "/r/p", "codex", "", &["sesión 1", "sesión 2"]).unwrap();
        db::set_session_parent(&conn, child.id, parent.id, Some("Investigar API")).unwrap();
        let loaded = db::session(&conn, child.id).unwrap().unwrap();
        assert_eq!(loaded.parent_session, Some(parent.id));
        assert_eq!(loaded.title.as_deref(), Some("Investigar API"));
        // Una subsesión puede arrancar sin work_session activa en el proyecto.
        assert!(crate::work::before_turn(&conn, "/r/p", Some(child.id)).is_ok());
        // No entra en huérfanas de worktrees aunque comparta el worktree del padre.
        db::set_session_worktree(&conn, child.id, "/wt", "ide/p", "main", "abc").unwrap();
        db::close_session(&conn, child.id).unwrap();
        assert!(db::orphans(&conn, "/r/p").unwrap().is_empty());
    }
}
