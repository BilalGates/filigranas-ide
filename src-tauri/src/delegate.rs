use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{claude, db, err, AppState, CmdResult};

// Herramientas del coordinador para delegar en los agentes ejecutores:
// Codex las llama como herramientas dinámicas (`item/tool/call`) y el IDE
// crea las sesiones, envía las tareas y devuelve su estado. Las sesiones
// delegadas aparecen como pestañas y sus permisos los aprueba el usuario.

/// Sube al cambiar las herramientas: los hilos creados con otra versión se
/// sustituyen, porque Codex solo las acepta al crear el hilo.
pub const TOOLS_VERSION: i64 = 6;

const ENGINES: [(&str, &str); 5] = [
    ("claude", "claude code"),
    ("codex", "codex"),
    ("opencode", "opencode"),
    ("agy", "antigravity"),
    ("devin", "devin"),
];
const WAIT_DEFAULT: u64 = 300;
const WAIT_MAX: u64 = 900;

const FLOW_TOOLS: &[&str]=&["flow_plan_create","flow_plans","flow_plan","flow_task_create","flow_tasks","flow_task","flow_task_edit","flow_assign","flow_continue","flow_reassign","flow_review","flow_block","flow_cancel","flow_retry","flow_delivery"];

pub fn specs() -> Value {
    let mut tools=legacy_specs().as_array().unwrap().clone();
    for name in FLOW_TOOLS {
        tools.push(json!({"type":"function","name":name,"description":format!("Capacidad PM {name}. IDs estables. input contiene edición completa para crear/editar; nunca autoriza publicación ni cierre done."),
            "inputSchema":{"type":"object","properties":{"task":{"type":"integer"},"plan":{"type":"integer"},"session":{"type":"integer"},"run":{"type":"integer"},"prompt":{"type":"string"},"input":{"type":"object"}},"additionalProperties":false}}));
    }
    Value::Array(tools)
}

fn flow_tool(app: &AppHandle, project: &str, tool: &str, args: &Value) -> CmdResult<String> {
    let state=app.state::<AppState>();
    let id=|key:&str|args[key].as_i64().filter(|id|*id>0).ok_or_else(||format!("falta ID {key}"));
    let output=match tool {
        "flow_plan_create"=>{let conn=state.db.lock().map_err(err)?;json!({"plan":crate::tasks::create_plan(&conn,project,serde_json::from_value(args["input"].clone()).map_err(err)?)?})},
        "flow_plans"=>serde_json::to_value(crate::tasks::plans(&*state.db.lock().map_err(err)?,project)?).map_err(err)?,
        "flow_plan"=>serde_json::to_value(crate::tasks::plan_detail(&*state.db.lock().map_err(err)?,project,id("plan")?)?).map_err(err)?,
        "flow_tasks"=>serde_json::to_value(crate::tasks::list(&*state.db.lock().map_err(err)?,project)?).map_err(err)?,
        "flow_task"|"flow_delivery"=>{
            let conn=state.db.lock().map_err(err)?;let task=id("task")?;crate::tasks::task_in(&conn,project,task)?;
            json!({"task":crate::tasks::list(&conn,project)?.into_iter().map(|t|serde_json::to_value(t).map_err(err)).collect::<Result<Vec<_>,_>>()?.into_iter().find(|t|t["id"]==task),"runs":crate::runs::recent(&conn,task).map_err(err)?,"delivery":crate::work::current(&conn,project)?})
        },
        "flow_task_create"|"flow_task_edit"|"flow_review"|"flow_block"=>{
            let mut conn=state.db.lock().map_err(err)?;
            let mut input=if tool=="flow_task_create" {
                let mut value=json!({"id":null,"parentId":null,"title":"","goal":"","criteria":"","priority":"normal","risk":"normal","status":"ready","verification":"","tests":null,"dependencies":[]});
                for (key,v) in args["input"].as_object().ok_or("falta input")? {value[key]=v.clone();} value
            } else {
                let task=id("task")?;crate::tasks::task_in(&conn,project,task)?;
                let mut value=crate::tasks::list(&conn,project)?.into_iter().map(|t|serde_json::to_value(t).map_err(err)).collect::<Result<Vec<_>,_>>()?.into_iter().find(|t|t["id"]==task).ok_or("tarea desconocida")?;
                if let Some(patch)=args["input"].as_object() {for (key,v) in patch {if !["goal","criteria","dependencies","priority","title"].contains(&key.as_str()){return Err("campo no editable por PM".into());}value[key]=v.clone();}}
                value
            };
            if tool=="flow_task_create" {input["id"]=Value::Null;input["status"]=json!("ready");}
            if tool=="flow_review" {input["status"]=json!("verifying");}
            if tool=="flow_block" {input["status"]=json!("blocked");}
            json!({"task":crate::tasks::save(&mut conn,project,serde_json::from_value(input).map_err(err)?)?})
        },
        "flow_assign"|"flow_reassign"=>{let conn=state.db.lock().map_err(err)?;crate::tasks::link(&conn,project,id("task")?,id("session")?)?;json!({"session":id("session")?,"task":id("task")?})},
        "flow_continue"|"flow_retry"=>{
            let session=id("session")?;
            let prompt={let conn=state.db.lock().map_err(err)?;
                if !db::session(&conn,session).map_err(err)?.is_some_and(|s|s.project==project){return Err("sesión ajena".into());}
                if tool=="flow_retry" {conn.query_row("SELECT prompt FROM task_runs WHERE session_id=?1 AND outcome IN ('failed','interrupted','paused_quota') ORDER BY id DESC LIMIT 1",[session],|r|r.get::<_,String>(0)).map_err(err)?}else{args["prompt"].as_str().ok_or("falta prompt")?.into()}};
            json!({"run":crate::runs::enqueue_session(app,session,prompt,None)?,"session":session})
        },
        "flow_cancel"=>{crate::runs::flow_cancel_run(app.clone(),project.into(),id("run")?)?;json!({"run":id("run")?,"cancellationRequested":true})},
        _=>return Err("capacidad desconocida".into())
    };
    crate::tasks::changed(app);crate::runs::wake_queue(app);
    serde_json::to_string(&output).map_err(err)
}

fn legacy_specs() -> Value {
    json!([
        {
            "type": "function",
            "name": "delegar",
            "description": "Crea una subsesión visible de un agente ejecutor en este proyecto y le envía una tarea. Devuelve el nombre de la subsesión. \
Usa siempre esta herramienta para cualquier investigación, edición, ejecución de comandos, pruebas o auditoría: el Project Manager nunca ejecuta trabajo técnico directamente. \
La tarea debe ser autocontenida: objetivo, contexto, archivos relevantes, restricciones y cómo verificar que está hecha.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agente": { "type": "string", "enum": ["auto", "claude", "codex", "opencode", "agy", "devin"], "description": "auto = Jev elige entre proveedores disponibles; claude = Anthropic, codex = OpenAI, agy = Antigravity de Google; opencode y devin son motores anteriores" },
                    "titulo": { "type": "string", "description": "Título breve visible en «Conversaciones» (p. ej. «Investigar delegación»)." },
                    "rol": { "type": "string", "enum": ["researcher", "designer", "senior", "junior", "auditor", "auditor2"], "description": "Rol de skills del ejecutor. Por defecto senior." },
                    "archivos": { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "Opcional. Rutas relativas asignadas si existe una sesión de trabajo compartida activa." },
                    "objetivo": { "type": "string", "description": "Objetivo separado del prompt literal." },
                    "tarea": { "type": "string", "description": "Encargo completo para el agente ejecutor." },
                    "esfuerzo": { "type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "Nivel de esfuerzo; Antigravity valida el valor contra su catálogo real y usa el nivel actual si se omite." }
                },
                "required": ["agente", "tarea"],
                "additionalProperties": false
            }
        },
        {
            "type": "function",
            "name": "asignar_archivos",
            "description": "Cambia el área de un agente inactivo cuando existe una sesión de trabajo compartida. No mueve archivos.",
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
            "description": "Envía otro encargo o aclaración a una subsesión existente en el mismo hilo, sin crear otro chat.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sesion": { "type": "string", "description": "Nombre o título de la subsesión." },
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
                    "sesion": { "type": "string", "description": "Nombre o título de la sesión." },
                    "segundos": { "type": "integer", "minimum": 5, "maximum": WAIT_MAX, "description": "Plazo máximo de espera. Por defecto 300." }
                },
                "required": ["sesion"],
                "additionalProperties": false
            }
        }, {
        "type":"function","name":"catalogo_proveedores",
        "description":"Consulta disponibilidad, opciones reales de modelos/razonamiento, capacidades, cuota conocida y concurrencia de los proveedores. Solo coordinación; datos desconocidos permanecen null.",
        "inputSchema":{"type":"object","properties":{},"additionalProperties":false}
    }
    ])
}

/// Herramientas MCP del servidor embebido `filigranas` para sesiones de Claude Code.
pub fn claude_mcp_tools() -> Value {
    Value::Array(specs().as_array().unwrap().iter().cloned().map(|mut t|{t.as_object_mut().unwrap().remove("type");t}).collect())
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
    if s.parent_session.is_some() || s.delegated_by_pm {
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
        "sin turno activo en memoria; consulta el intento persistido"
    } else {
        "inactiva"
    };
    let mut line = format!("{} · {} · {}", s.name, label(&s.engine), status);
    if let (Some(b), Some(w)) = (&s.branch, &s.worktree) {
        line.push_str(&format!(" · rama {b} en {w}{}", if s.integrated.is_some() { " (integrada)" } else { "" }));
    }
    if let Ok(conn)=state.db.lock() {
        if let Ok((id,outcome,result,error))=conn.query_row("SELECT id,outcome,result,error FROM task_runs WHERE session_id=?1 ORDER BY id DESC LIMIT 1",[s.id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?))) {
            line.push_str(&format!("\nSesión #{} · intento #{id} · {outcome}",s.id));
            if let Some(result)=result { line.push_str(&format!("\nResultado persistido:\n{}",clip(&result,max))); }
            if let Some(error)=error { line.push_str(&format!("\nError:\n{}",clip(&error,max))); }
        } else {
            let durable=crate::acp::last_result(&conn,s.id).unwrap_or_default();
            let last=if t.last.trim().is_empty() { durable.as_str() } else { t.last.as_str() };
            if !last.trim().is_empty() { line.push_str(&format!("\nÚltima respuesta:\n{}",clip(last.trim(),max))); }
        }
    }
    line
}

fn include_closed_by_id(state: &AppState, project: &str, query: &str, list: &mut Vec<db::Session>) -> CmdResult<()> {
    if let Ok(id)=query.trim().trim_start_matches('#').parse::<i64>() {
        if !list.iter().any(|s|s.id==id) {
            if let Some(s)=db::session_any(&*state.db.lock().map_err(err)?,id).map_err(err)?.filter(|s|s.project==project) {list.push(s);}
        }
    }
    Ok(())
}

fn find_project_session<'a>(list: &'a [db::Session], query: &str) -> Option<&'a db::Session> {
    let q=query.trim();
    if let Ok(id)=q.strip_prefix('#').unwrap_or(q).parse::<i64>() { return list.iter().find(|s|s.id==id); }
    let mut matches=list.iter().filter(|s|s.name.eq_ignore_ascii_case(q)||s.title.as_deref().is_some_and(|t|t.eq_ignore_ascii_case(q)));
    let first=matches.next()?;
    matches.next().is_none().then_some(first)
}

/// Ejecuta una herramienta del coordinador del hilo `thread`. Puede tardar
/// (esperar_sesion): se llama fuera del hilo lector de Codex.
pub fn handle(app: &AppHandle, thread: &str, tool: &str, args: &Value) -> CmdResult<String> {
    let state = app.state::<AppState>();
    let project = db::project_for_thread(&*state.db.lock().map_err(err)?, thread).map_err(err)?.ok_or("este hilo no pertenece a ningún proyecto del IDE")?;
    if FLOW_TOOLS.contains(&tool) {return flow_tool(app,&project,tool,args);}
    match tool {
        "catalogo_proveedores" => crate::providers::overview(&state),
        "delegar" => {
            let parent_task=crate::runs::task_for_thread(&*state.db.lock().map_err(err)?,thread).map_err(err)?;
            dispatch_delegation(app,&project,None,parent_task,args)
        }
        "asignar_archivos" | "continuar_sesion" => {
            let name = args["sesion"].as_str().unwrap_or("");
            let list = db::sessions(&*state.db.lock().map_err(err)?, &project).map_err(err)?;
            let session = find_project_session(&list, name).ok_or_else(|| format!("no hay una sesión abierta llamada «{name}»"))?;
            if tool == "asignar_archivos" {
                let paths = args["archivos"].as_array().ok_or("falta la lista de archivos")?.iter()
                    .map(|p| p.as_str().map(str::to_owned).ok_or("cada archivo debe ser una ruta de texto")).collect::<Result<Vec<_>, _>>()?;
                crate::work::assign(&*state.db.lock().map_err(err)?, &project, session.id, paths)?;
                crate::tasks::changed(app);
                return Ok(format!("Reparto actualizado para {}. Se aplicará en su próximo turno.", session.name));
            }
            let task = args["tarea"].as_str().filter(|s| !s.trim().is_empty()).ok_or("falta el encargo")?;
            claude::send_message(app, session.id, task.into(), None)?;
            Ok(format!("Encargo enviado a «{}».", session.name))
        }
        "estado_sesiones" => {
            let list = db::sessions(&*state.db.lock().map_err(err)?, &project).map_err(err)?;
            if list.is_empty() {
                return Ok("No hay sesiones de agentes abiertas en este proyecto.".into());
            }
            Ok(list
                .iter()
                .map(|s| {
                    let head = s.title.as_deref().map(|t| format!("{t} ({})", s.name)).unwrap_or_else(|| s.name.clone());
                    format!("{head}\n{}", describe(&state, s, 600))
                })
                .collect::<Vec<_>>()
                .join("\n\n"))
        }
        "esperar_sesion" => {
            let name = args["sesion"].as_str().unwrap_or("");
            let mut list = db::sessions(&*state.db.lock().map_err(err)?, &project).map_err(err)?;
            include_closed_by_id(&state,&project,name,&mut list)?;
            let s = find_project_session(&list, name).ok_or_else(|| format!("no hay ninguna sesión abierta llamada «{name}»"))?;
            let secs = args["segundos"].as_u64().unwrap_or(WAIT_DEFAULT).clamp(5, WAIT_MAX);
            let t = state.tracker.wait_idle(s.id, Duration::from_secs(secs));
            let mut out = describe(&state, s, 8000);
            if t.running {
                out.push_str(&format!("\n(Sigue en marcha tras {secs} s de espera. Vuelve a llamar a esperar_sesion para esperar su resultado.)"));
            }
            Ok(out)
        }
        _ => Err(format!("herramienta desconocida: {tool}")),
    }
}

/// Both PM providers use this path: independent task, plan and linked session.
fn dispatch_delegation(app: &AppHandle, project: &str, parent: Option<i64>, parent_task: Option<i64>, args: &Value) -> CmdResult<String> {
    let state=app.state::<AppState>();
    let requested=args["agente"].as_str().unwrap_or("claude");
    if requested!="auto" && !ENGINES.iter().any(|(id,_)|*id==requested) { return Err("agente desconocido".into()); }
    let prompt=args["tarea"].as_str().filter(|p|!p.trim().is_empty()).ok_or("falta el encargo")?;
    let title=derive_title(args["titulo"].as_str(),prompt);
    let goal=args["objetivo"].as_str().filter(|g|!g.trim().is_empty()).unwrap_or(prompt);
    let role=args["rol"].as_str().unwrap_or("senior");
    if !["researcher","designer","senior","junior","auditor","auditor2"].contains(&role) { return Err("rol ejecutor no válido".into()); }
    let (chosen,route)=crate::jev::provider_choice(&state,requested,crate::skills::Role::from_key(Some(role)))?;
    let engine=chosen.as_str();
    let task={let mut conn=state.db.lock().map_err(err)?;crate::tasks::delegation(&mut conn,project,parent_task,&title,goal,prompt,engine,role)?};
    let session=claude::create_pm_subsession(app,project,parent,engine,Some(&title),Some(crate::skills::Role::from_key(Some(role))),Some(task))?;
    crate::jev::assign_provider(&*state.db.lock().map_err(err)?,session.id,&parent.map(crate::runs::session_scope).unwrap_or_else(|| project.to_owned()),&route)?;
    if let Some(paths)=args["archivos"].as_array() {
        let paths=paths.iter().map(|p|p.as_str().map(str::to_owned).ok_or("ruta no válida")).collect::<Result<Vec<_>,_>>()?;
        let conn=state.db.lock().map_err(err)?;
        if crate::work::current(&conn,project)?.is_some_and(|w|w.state!="finished") {crate::work::assign(&conn,project,session.id,paths)?;}
    }
    let effort=args["esfuerzo"].as_str().map(str::to_owned);
    let result=claude::send_message(app,session.id,prompt.into(),effort);
    crate::tasks::changed(app);
    Ok(format!("Tarea #{task} · sesión #{} · {title} · {}. {}. Usa esperar_sesion {{\"sesion\":\"{}\"}}.",session.id,label(engine),
        match result {Ok(())=>"Encargo enviado".into(),Err(error)=>format!("Inicio fallido, prompt conservado: {error}")},session.id))
}

fn derive_title(explicit: Option<&str>, task: &str) -> String {
    let raw = explicit.map(str::trim).filter(|s| !s.is_empty()).unwrap_or_else(|| {
        task.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Subsesión")
    });
    clip(raw, 60)
}

fn find_child<'a>(list: &'a [db::Session], parent_id: i64, query: &str) -> Option<&'a db::Session> {
    find_project_session(list,query).filter(|s|s.parent_session==Some(parent_id))
}

/// Ejecuta una herramienta MCP de delegación llamada por una sesión de Claude Code.
pub fn handle_claude(app: &AppHandle, parent_id: i64, tool: &str, args: &Value) -> CmdResult<String> {
    let state = app.state::<AppState>();
    let parent = claude::open_session(&state, parent_id)?;
    if !crate::chat::is_pm(&*state.db.lock().map_err(err)?,parent_id).map_err(err)? {
        return Err("las herramientas PM solo están disponibles al coordinador".into());
    }
    let project = parent.project.clone();
    if FLOW_TOOLS.contains(&tool) {return flow_tool(app,&project,tool,args);}
    match tool {
        "catalogo_proveedores" => crate::providers::overview(&state),
        "delegar" => {
            let parent_task={
                let conn=state.db.lock().map_err(err)?;
                crate::runs::task_for_thread(&conn,&crate::runs::session_scope(parent_id)).map_err(err)?
                    .or(crate::tasks::linked(&conn,parent_id).map_err(err)?)
            };
            dispatch_delegation(app,&project,Some(parent_id),parent_task,args)
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
            let mut list = db::sessions(&*state.db.lock().map_err(err)?, &project).map_err(err)?;
            include_closed_by_id(&state,&project,name,&mut list)?;
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
            let mut list = db::sessions(&*state.db.lock().map_err(err)?, &project).map_err(err)?;
            include_closed_by_id(&state,&project,name,&mut list)?;
            let s = find_child(&list, parent_id, name)
                .ok_or_else(|| format!("no hay ninguna subsesión abierta llamada «{name}»"))?;
            claude::send_message(app, s.id, task.into(), None)?;
            Ok(format!("Seguimiento enviado a la subsesión «{}».", s.name))
        }
        _ => Err(format!("herramienta desconocida: {tool}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flow_catalogs_share_all_explicit_pm_capabilities() {
        let codex=specs();let claude=claude_mcp_tools();
        for name in FLOW_TOOLS {
            assert!(codex.as_array().unwrap().iter().any(|t|t["name"]==*name));
            assert!(claude.as_array().unwrap().iter().any(|t|t["name"]==*name));
        }
        assert_eq!(codex.as_array().unwrap().len(),claude.as_array().unwrap().len());
    }

    #[test]
    fn flow_session_lookup_uses_ids_and_rejects_ambiguous_titles_and_wrong_parent() {
        let conn=db::open(std::path::Path::new(":memory:")).unwrap();
        let a=db::create_session(&conn,"/a","claude","a",&["one"]).unwrap();
        let b=db::create_session(&conn,"/a","codex","b",&["two"]).unwrap();
        db::set_session_parent(&conn,b.id,a.id,Some("duplicate")).unwrap();
        conn.execute("UPDATE sessions SET title='duplicate' WHERE id=?1",[a.id]).unwrap();
        let list=db::sessions(&conn,"/a").unwrap();
        assert!(find_project_session(&list,"duplicate").is_none());
        assert_eq!(find_project_session(&list,&b.id.to_string()).unwrap().id,b.id);
        assert_eq!(find_child(&list,a.id,&b.id.to_string()).unwrap().id,b.id);
        assert!(find_child(&list,b.id,&a.id.to_string()).is_none());
    }

    #[test]
    fn specs_are_valid_function_tools() {
        let specs = specs();
        let names: Vec<&str> = specs.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"flow_retry"));
        assert!(names.contains(&"catalogo_proveedores"));
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
        assert!(names.contains(&"flow_tasks"));
        assert!(names.contains(&"catalogo_proveedores"));
        let engines: Vec<&str> = arr[0]["inputSchema"]["properties"]["agente"]["enum"]
            .as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(engines, ["auto", "claude", "codex", "opencode", "agy", "devin"]);
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

        // Subsesión delegada por Codex PM (parent_session = None, delegated_by_pm = true):
        // no debe fallar con "inicia una sesión de trabajo..." al iniciar ni al continuar_sesion.
        let codex_child = db::create_session(&conn, "/r/p", "claude", "u-c", &["sesión 1", "sesión 2", "sesión 3"]).unwrap();
        db::set_session_delegated_by_pm(&conn, codex_child.id, None, Some("Auditar PR")).unwrap();
        let loaded_codex = db::session(&conn, codex_child.id).unwrap().unwrap();
        assert!(loaded_codex.delegated_by_pm);
        assert!(crate::work::before_turn(&conn, "/r/p", Some(codex_child.id)).is_ok());

        // Una sesión independiente (NO delegada por PM y sin worktree) sigue exigiendo work_session activa.
        let standalone = db::create_session(&conn, "/r/p", "claude", "u-s", &["sesión 1", "sesión 2", "sesión 3", "sesión 4"]).unwrap();
        assert!(crate::work::before_turn(&conn, "/r/p", Some(standalone.id)).is_err());

        // No entra en huérfanas de worktrees aunque comparta el worktree del padre.
        db::set_session_worktree(&conn, child.id, "/wt", "ide/p", "main", "abc").unwrap();
        db::close_session(&conn, child.id).unwrap();
        assert!(db::orphans(&conn, "/r/p").unwrap().is_empty());
    }
}
