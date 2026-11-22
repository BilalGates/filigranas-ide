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

const ENGINES: [(&str, &str); 4] = [("claude", "claude code"), ("opencode", "opencode"), ("agy", "antigravity"), ("devin", "devin")];
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
}
