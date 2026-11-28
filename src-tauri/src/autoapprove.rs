//! Motor efectivo de permisos de cada sesión y proyecto en Filigranas.
//!
//! Cuatro modos reales:
//! - `readonly` (Solo lectura): permite consultar e investigar sin modificar archivos ni ejecutar comandos con escritura.
//! - `ask` (Con autorización, por defecto): solicita confirmación explícita al usuario.
//! - `auto` (Automático): aprueba lecturas, ediciones dentro del proyecto y comandos seguros de verificación/lectura dentro del alcance.
//! - `full` (Full Control): aprueba automáticamente operaciones en el alcance autorizado sin interrupciones,
//!   manteniendo siempre los guardrails superiores (bloqueo del Project Manager, operaciones destructivas y push/merge remotos).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;
use tauri::State;

use crate::{err, AppState, CmdResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Mode {
    ReadOnly,
    #[default]
    Ask,
    Auto,
    Full,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "readonly" => Some(Self::ReadOnly),
            "ask" => Some(Self::Ask),
            "auto" => Some(Self::Auto),
            "full" => Some(Self::Full),
            _ => None,
        }
    }

    /// Orden de permisividad: Solo lectura < Con autorización < Automático < Control total.
    fn rank(self) -> u8 {
        match self { Self::ReadOnly => 0, Self::Ask => 1, Self::Auto => 2, Self::Full => 3 }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "readonly",
            Self::Ask => "ask",
            Self::Auto => "auto",
            Self::Full => "full",
        }
    }
}

/// Qué pide el agente, reducido a lo que importa para aplicar la política.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Read,
    Edit,
    Exec,
    /// Red, borrados u otras herramientas externas.
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    /// Aprobado automáticamente por Filigranas según el modo vigente.
    Allow,
    /// Debe mostrarse al usuario indicando origen y motivo.
    Ask { origin: &'static str, reason: Option<String> },
    /// Prohibido por una política superior (Solo lectura, PM o protección destructiva).
    DenyPolicy { origin: &'static str, reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Scope {
    Session(i64),
    Project(String),
}

#[derive(Default)]
pub struct Modes(Mutex<HashMap<Scope, Mode>>);

impl Modes {
    pub fn get(&self, session: i64) -> Mode {
        self.0.lock().ok().and_then(|m| m.get(&Scope::Session(session)).copied()).unwrap_or_default()
    }

    pub fn has_session(&self, session: i64) -> bool {
        self.0.lock().ok().is_some_and(|m| m.contains_key(&Scope::Session(session)))
    }

    pub fn get_project(&self, project: &str) -> Mode {
        self.0.lock().ok().and_then(|m| m.get(&Scope::Project(project.to_owned())).copied()).unwrap_or_default()
    }

    /// Hereda el nivel de permisos de una sesión padre en una subsesión hija.
    pub fn inherit(&self, parent: i64, child: i64) {
        let mode = self.get(parent);
        let _ = self.set(Scope::Session(child), mode);
    }

    /// Hereda el nivel de permisos del proyecto en una subsesión delegada por el PM.
    pub fn inherit_project(&self, project: &str, child: i64) {
        let mode = self.get_project(project);
        let _ = self.set(Scope::Session(child), mode);
    }

    /// Baja el modo de una sesión a `limit` si es más permisivo.
    pub fn cap(&self, session: i64, limit: Mode) -> CmdResult<()> {
        if self.get(session).rank() > limit.rank() { self.set(Scope::Session(session), limit)?; }
        Ok(())
    }

    fn set(&self, scope: Scope, mode: Mode) -> CmdResult<()> {
        let mut modes = self.0.lock().map_err(err)?;
        modes.insert(scope, mode);
        Ok(())
    }
}

/// Comandos catastróficos bloqueados en todos los modos por política superior.
/// Se buscan también dentro de comillas o de un `sh -c`, porque no se aprueban nunca.
pub fn is_catastrophic_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase().replace(['\'', '"', '\\'], " ");
    let compact = format!(" {} ", lower.split_whitespace().collect::<Vec<_>>().join(" "));
    let wipe = ["rm -rf", "rm -fr", "rm -r -f", "rm -f -r"].iter().any(|rm| {
        ["/ ", "/* ", "~ ", "~/ ", "$home ", "${home} ", "$home/ "].iter().any(|target| compact.contains(&format!("{rm} {target}")))
    });
    wipe
        || compact.contains("mkfs")
        || compact.contains("diskutil erase")
        || compact.contains("dd if=") && compact.contains("of=/dev/")
        || compact.contains(":(){")
        || compact.contains(" shutdown ")
        || compact.contains(" reboot ")
}

/// Un comando sin metacaracteres de shell: un único programa con argumentos
/// literales. Cualquier otra forma (saltos de línea, `;`, `&`, `|`, redirecciones,
/// subshells, variables, comillas, escapes) no se puede razonar sin ejecutarla.
fn simple_tokens(cmd: &str) -> Option<Vec<&str>> {
    if cmd.trim().is_empty() || cmd.chars().any(|c| "\n\r;|&><`$(){}[]*?!#~\\\"'".contains(c)) { return None; }
    Some(cmd.split_whitespace().collect())
}

/// Consultas que no escriben ni ejecutan código del proyecto.
fn is_query(t: &[&str]) -> bool {
    match t.first().copied() {
        Some("pwd") => t.len() == 1,
        Some("ls" | "cat" | "head" | "tail" | "wc" | "rg" | "grep" | "file" | "stat") =>
            !t.iter().skip(1).any(|v| v.starts_with('-') &&
                (v.contains("pre") || v.contains("hostname") || v.contains("files-with") || v.contains("follow"))),
        _ => false,
    }
}

/// Consultas de Git sin opciones globales (`-c`, `-C`, alias…). Ejecutan la
/// configuración local del repositorio (p. ej. `core.fsmonitor`), así que no
/// entran en Solo lectura.
fn is_git_query(t: &[&str]) -> bool {
    t.first() == Some(&"git") && t.len() >= 2
        && matches!(t[1], "status" | "diff" | "log" | "show" | "rev-parse" | "ls-files" | "merge-base" | "blame")
        && !t.iter().any(|v| v.starts_with("--output") || v.starts_with("--config") || v.starts_with("--ext-diff") || v.starts_with("--exec"))
}

/// Verificación local: ejecuta scripts del proyecto dentro de su carpeta.
fn is_project_check(t: &[&str]) -> bool {
    matches!(t, ["pnpm" | "npm", "test" | "build" | "typecheck" | "lint" | "check"]
        | ["cargo", "test" | "check" | "clippy" | "build", ..])
}

/// Lista positiva de Control total: comandos simples cuyo efecto queda en la
/// carpeta del proyecto. Publicar, integrar, borrar, cambiar de rama o de
/// configuración, la red y los intérpretes siguen preguntando.
fn is_full_command(t: &[&str]) -> bool {
    is_query(t) || is_git_query(t) || is_project_check(t)
        || matches!(t.first().copied(), Some("mkdir" | "touch" | "cp" | "mv"))
        || matches!(t, ["git", "add", ..] | ["pnpm" | "npm" | "cargo", "fmt" | "install" | "ci" | "run", ..] | ["cargo", "doc", ..])
        || matches!(t, ["gh", "pr" | "issue" | "run", "view" | "list" | "status" | "checks" | "diff", ..])
}

pub fn is_readonly_command(cmd: &str) -> bool {
    simple_tokens(cmd).is_some_and(|t| is_query(&t))
}

pub fn is_auto_safe_command(cmd: &str) -> bool {
    simple_tokens(cmd).is_some_and(|t| is_query(&t) || is_git_query(&t) || is_project_check(&t))
}

/// Por qué un comando necesita confirmación, para mostrarlo al usuario.
pub fn protected_operation_reason(cmd: &str) -> Option<&'static str> {
    let Some(t) = simple_tokens(cmd) else {
        return Some("El comando combina órdenes, redirecciones, variables o comillas: Filigranas no puede comprobar su alcance sin ejecutarlo.");
    };
    match t.as_slice() {
        ["git", "push", ..] | ["git", "send-pack", ..] => Some("Publicar requiere autorización explícita (usa Entrega para publicar con confirmación de SHA)."),
        ["git", ..] if !is_git_query(&t) && t.get(1) != Some(&"add") => Some("Esta operación Git requiere autorización para conservar ramas, historial y configuración."),
        ["gh", ..] if !is_full_command(&t) => Some("Las operaciones de escritura en GitHub requieren aprobación humana explícita."),
        [program, ..] if !is_full_command(&t) => Some(match Path::new(program).file_name().and_then(|p| p.to_str()).unwrap_or(program) {
            "rm" | "rmdir" | "unlink" => "Borrar archivos requiere autorización específica.",
            "sudo" | "su" | "doas" => "Elevar privilegios requiere autorización específica.",
            "curl" | "wget" | "ssh" | "scp" | "rsync" | "nc" => "El acceso a red requiere autorización específica.",
            _ => "El comando está fuera de la lista de operaciones que Filigranas aprueba sola.",
        }),
        _ => None,
    }
}

/// Archivos que controlan Git, los agentes o la ejecución de herramientas.
/// Editarlos cambia lo que harán después órdenes ya aprobadas.
fn guards_execution(cwd: &Path, path: &str, strict: bool) -> bool {
    let raw = Path::new(path);
    let rel = raw.strip_prefix(cwd).unwrap_or(raw);
    let parts: Vec<String> = rel.components().filter_map(|c| match c { Component::Normal(s) => s.to_str().map(str::to_lowercase), _ => None }).collect();
    let agents = parts.iter().any(|p| matches!(p.as_str(), ".git" | ".claude" | ".codex" | ".agents" | ".mcp.json" | ".gitmodules" | ".husky" | ".githooks"));
    let name = parts.last().map(String::as_str).unwrap_or("");
    let build = name == "package.json" || name == "build.rs" || name == "cargo.toml" || name == "makefile" || name == ".npmrc"
        || name.starts_with(".env") || name.contains(".config.") || name == "tauri.conf.json"
        || parts.first().is_some_and(|p| p == ".github" || p == ".vscode");
    agents || (strict && build)
}

/// Evalúa la decisión de permisos efectiva para cualquier proveedor (Claude, Codex, ACP).
pub fn evaluate(mode: Mode, cwd: &Path, kind: Kind, paths: &[String], command: Option<&str>) -> PolicyDecision {
    let ask = |origin: &'static str, reason: &str| PolicyDecision::Ask { origin, reason: Some(reason.into()) };
    let deny = |reason: &str| PolicyDecision::DenyPolicy { origin: "modo Solo lectura", reason: reason.into() };
    if let Some(cmd) = command {
        if is_catastrophic_command(cmd) {
            return PolicyDecision::DenyPolicy {
                origin: "política de seguridad",
                reason: "Operación destructiva bloqueada por política superior de Filigranas.".into(),
            };
        }
    }
    if !paths.iter().all(|p| inside(cwd, p)) && mode != Mode::ReadOnly {
        return ask("alcance del proyecto", "La ruta sale de la carpeta autorizada.");
    }
    if kind == Kind::Exec {
        let Some(cmd) = command else {
            return if mode == Mode::ReadOnly { deny("Solo lectura no admite órdenes sin texto verificable.") }
                else { ask("política de Filigranas", "El proveedor no ha informado la orden exacta; requiere una decisión humana.") };
        };
        if let Some(tokens) = simple_tokens(cmd) {
            let outside = tokens.iter().skip(1).filter(|t| !t.starts_with('-') || t.contains('='))
                .map(|t| t.split_once('=').map_or(*t, |(_, v)| v))
                .any(|t| !inside(cwd, t));
            if outside && mode != Mode::ReadOnly {
                return ask("alcance del proyecto", "El comando incluye una ruta fuera del alcance autorizado.");
            }
        }
    }
    match mode {
        Mode::ReadOnly => match kind {
            Kind::Read => PolicyDecision::Allow,
            Kind::Exec if command.is_some_and(is_readonly_command) => PolicyDecision::Allow,
            Kind::Edit => deny("La sesión está en modo Solo lectura: no se permiten modificaciones de archivos."),
            Kind::Exec | Kind::Other => deny("La sesión está en modo Solo lectura: solo se permiten consultas e investigación sin escritura."),
        },
        Mode::Ask => PolicyDecision::Ask { origin: "Filigranas (Con autorización)", reason: None },
        Mode::Auto | Mode::Full => {
            let full = mode == Mode::Full;
            let origin = if full { "política Control total" } else { "política Automático" };
            match kind {
                Kind::Read => PolicyDecision::Allow,
                Kind::Edit if paths.is_empty() => ask("alcance del proyecto", "El proveedor no ha informado las rutas del cambio; no se puede autorizar su alcance."),
                Kind::Edit if paths.iter().any(|p| guards_execution(cwd, p, !full)) =>
                    ask(origin, "El archivo controla Git, los agentes o la ejecución de herramientas; su cambio requiere confirmación."),
                Kind::Edit => PolicyDecision::Allow,
                Kind::Exec => {
                    let cmd = command.unwrap_or_default();
                    let allowed = if full { simple_tokens(cmd).is_some_and(|t| is_full_command(&t)) } else { is_auto_safe_command(cmd) };
                    if allowed { PolicyDecision::Allow }
                    else { ask(origin, protected_operation_reason(cmd).unwrap_or("Comando fuera de la política automática (lectura, build, lint y tests locales).")) }
                }
                Kind::Other => ask(origin, "Herramienta sin clasificar: requiere confirmación."),
            }
        }
    }
}

/// Compatibilidad booleana simple para callers/tests existentes.
#[cfg(all(test, unix))]
pub fn approves(mode: Mode, cwd: &Path, kind: Kind, paths: &[String]) -> bool {
    matches!(evaluate(mode, cwd, kind, paths, None), PolicyDecision::Allow)
}

/// `path` (absoluta o relativa a `cwd`) queda dentro de `cwd`, siguiendo
/// enlaces simbólicos de la parte que ya existe.
pub(crate) fn inside(cwd: &Path, path: &str) -> bool {
    let Ok(root) = std::fs::canonicalize(cwd) else { return false };
    let raw = Path::new(path);
    let joined = if raw.is_absolute() { raw.to_path_buf() } else { cwd.join(raw) };
    let mut clean = PathBuf::new();
    for part in joined.components() {
        match part {
            // `..` actúa sobre el destino real: un enlace simbólico se resuelve antes de subir.
            Component::ParentDir => {
                if let Ok(real) = std::fs::canonicalize(&clean) { clean = real; }
                if !clean.pop() { return false; }
            }
            Component::CurDir => {}
            other => clean.push(other),
        }
    }
    let mut existing = clean.clone();
    let mut rest = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name().map(|n| n.to_owned()) else { return false };
        rest.push(name);
        if !existing.pop() { return false; }
    }
    let Ok(mut real) = std::fs::canonicalize(&existing) else { return false };
    for name in rest.into_iter().rev() {
        real.push(name);
    }
    real.starts_with(&root)
}

/// Petición `can_use_tool` de Claude Code.
pub fn claude_request(request: &Value) -> (Kind, Vec<String>, Option<String>) {
    let tool = request["tool_name"].as_str().unwrap_or("");
    let input = &request["input"];
    let kind = match tool {
        "Read" | "Glob" | "Grep" | "LS" | "NotebookRead" => Kind::Read,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => Kind::Edit,
        "Bash" => Kind::Exec,
        _ => Kind::Other,
    };
    let paths: Vec<String> = ["file_path", "notebook_path", "path"]
        .iter()
        .filter_map(|k| input[*k].as_str().map(str::to_owned))
        .collect();
    let command = if kind == Kind::Exec {
        input["command"].as_str().map(str::to_owned)
    } else {
        None
    };
    (kind, paths, command)
}

/// Petición de aprobación de Codex app-server.
pub fn codex_request(method: &str, params: &Value) -> (Kind, Vec<String>, Option<String>) {
    match method {
        "item/fileChange/requestApproval" => {
            let mut paths = Vec::new();
            if let Some(p) = params["grantRoot"].as_str() {
                paths.push(p.to_string());
            }
            if let Some(arr) = params["changes"].as_array() {
                for ch in arr {
                    if let Some(p) = ch["path"].as_str() {
                        paths.push(p.to_string());
                    }
                }
            }
            if let Some(p) = params["path"].as_str() {
                paths.push(p.to_string());
            }
            (Kind::Edit, paths, None)
        }
        "item/commandExecution/requestApproval" => {
            // Solo una orden normal se puede evaluar. `writeStdin`, `humanCommand`
            // o una orden ausente quedan sin texto y siempre llegan al usuario.
            let plain = params["kind"].as_str().is_none_or(|k| k == "command");
            let cmd = params["command"].as_str().map(str::to_owned)
                .or_else(|| params["command"].as_array().map(|arr| arr.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")))
                .filter(|_| plain);
            let paths = params["cwd"].as_str().map(|s| vec![s.to_string()]).unwrap_or_default();
            (Kind::Exec, paths, cmd)
        }
        "item/permissions/requestApproval" => {
            let paths = params
                .pointer("/permissions/fileSystem/write")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_default();
            (Kind::Other, paths, None)
        }
        _ => (Kind::Other, Vec::new(), None),
    }
}

/// Petición `session/request_permission` de ACP (OpenCode, Antigravity, Devin).
pub fn acp_request(tool_call: &Value) -> (Kind, Vec<String>, Option<String>) {
    let kind = match tool_call["kind"].as_str().unwrap_or("") {
        "read" | "search" => Kind::Read,
        "edit" => Kind::Edit,
        "execute" => Kind::Exec,
        _ => Kind::Other,
    };
    let paths: Vec<String> = tool_call["locations"]
        .as_array()
        .map(|l| l.iter().filter_map(|loc| loc["path"].as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    let command = if kind == Kind::Exec {
        tool_call
            .pointer("/rawInput/command")
            .and_then(Value::as_str)
            .or_else(|| tool_call["title"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    if kind == Kind::Edit && paths.is_empty() {
        return (Kind::Other, paths, command);
    }
    (kind, paths, command)
}

/// Subsesiones de una sesión, a cualquier profundidad.
fn descendants(conn: &rusqlite::Connection, id: i64) -> CmdResult<Vec<i64>> {
    let mut stmt = conn.prepare("WITH RECURSIVE d(id) AS (SELECT id FROM sessions WHERE parent_session=?1
        UNION SELECT s.id FROM sessions s JOIN d ON s.parent_session=d.id) SELECT id FROM d").map_err(err)?;
    let rows = stmt.query_map([id], |r| r.get(0)).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

#[tauri::command]
pub fn session_permission_mode(state: State<AppState>, id: Option<i64>, project: Option<String>, mode: String) -> CmdResult<String> {
    let parsed = Mode::parse(&mode).ok_or("nivel de permisos no válido")?;
    match (id, project) {
        (Some(id), maybe_project) => {
            state.permissions.set(Scope::Session(id), parsed)?;
            // Una subsesión ya creada nunca queda con más permisos que su padre.
            for child in descendants(&*state.db.lock().map_err(err)?, id)? {
                state.permissions.cap(child, parsed)?;
            }
            // Si es el PM de Claude del proyecto, sincroniza también el ámbito de proyecto
            // para que las delegaciones y cambios de motor PM hereden exactamente este modo.
            let is_pm_project = {
                let conn = state.db.lock().map_err(err)?;
                if crate::chat::is_pm(&conn, id).map_err(err)? {
                    crate::db::session(&conn, id).map_err(err)?.map(|s| s.project)
                } else {
                    None
                }
            };
            if let Some(pm_proj) = is_pm_project {
                state.permissions.set(Scope::Project(pm_proj), parsed)?;
            }
            let _ = maybe_project;
        }
        (None, Some(project)) => {
            let path = crate::workspace::project_path(&*state.db.lock().map_err(err)?, &project)?;
            state.permissions.set(Scope::Project(path.clone()), parsed)?;
            // Si existe PM Claude para este proyecto, sincroniza su sesión también.
            let pm_claude_id = {
                let conn = state.db.lock().map_err(err)?;
                crate::chat::pm_id(&conn, &path).map_err(err)?
            };
            if let Some(pm_id) = pm_claude_id {
                state.permissions.set(Scope::Session(pm_id), parsed)?;
            }
        }
        (None, None) => return Err("falta la sesión o el proyecto".into()),
    }
    Ok(parsed.as_str().to_string())
}

#[tauri::command]
pub fn session_get_permission_mode(state: State<AppState>, id: Option<i64>, project: Option<String>) -> CmdResult<String> {
    let mode = match (id, project) {
        (Some(id), Some(project)) => {
            if state.permissions.has_session(id) {
                state.permissions.get(id)
            } else {
                let path = crate::workspace::project_path(&*state.db.lock().map_err(err)?, &project)?;
                state.permissions.get_project(&path)
            }
        }
        (Some(id), None) => state.permissions.get(id),
        (None, Some(project)) => {
            let path = crate::workspace::project_path(&*state.db.lock().map_err(err)?, &project)?;
            state.permissions.get_project(&path)
        }
        (None, None) => Mode::Ask,
    };
    Ok(mode.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fili-auto-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        dir
    }

    #[test]
    fn four_modes_enforce_distinct_policies() {
        let dir = tmp();
        let inside_file = dir.join("src/new.rs").to_string_lossy().into_owned();

        // Solo lectura: permite lecturas y consultas sin Git (Git ejecuta su configuración local).
        assert_eq!(evaluate(Mode::ReadOnly, &dir, Kind::Read, std::slice::from_ref(&inside_file), None), PolicyDecision::Allow);
        assert_eq!(evaluate(Mode::ReadOnly, &dir, Kind::Exec, &[], Some("ls src")), PolicyDecision::Allow);
        assert!(matches!(evaluate(Mode::ReadOnly, &dir, Kind::Exec, &[], Some("git status")), PolicyDecision::DenyPolicy { .. }));
        assert!(matches!(evaluate(Mode::ReadOnly, &dir, Kind::Edit, std::slice::from_ref(&inside_file), None), PolicyDecision::DenyPolicy { .. }));
        assert!(matches!(evaluate(Mode::ReadOnly, &dir, Kind::Exec, &[], Some("touch a.txt")), PolicyDecision::DenyPolicy { .. }));

        // Con autorización: siempre pregunta salvo operación catastrófica.
        assert!(matches!(evaluate(Mode::Ask, &dir, Kind::Read, std::slice::from_ref(&inside_file), None), PolicyDecision::Ask { .. }));
        assert!(matches!(evaluate(Mode::Ask, &dir, Kind::Edit, std::slice::from_ref(&inside_file), None), PolicyDecision::Ask { .. }));

        // Automático: aprueba lecturas/ediciones dentro del proyecto y tests/build locales seguros.
        assert_eq!(evaluate(Mode::Auto, &dir, Kind::Edit, std::slice::from_ref(&inside_file), None), PolicyDecision::Allow);
        assert_eq!(evaluate(Mode::Auto, &dir, Kind::Exec, &[], Some("cargo test")), PolicyDecision::Allow);
        assert_eq!(evaluate(Mode::Auto, &dir, Kind::Exec, &[], Some("pnpm build")), PolicyDecision::Allow);
        assert!(matches!(evaluate(Mode::Auto, &dir, Kind::Edit, &["../fuera.txt".into()], None), PolicyDecision::Ask { .. }));
        assert!(matches!(evaluate(Mode::Auto, &dir, Kind::Exec, &[], Some("curl https://example.com")), PolicyDecision::Ask { .. }));

        // Full Control: aprueba operaciones normales sin preguntar, pero protege push/merge/destructivos.
        assert_eq!(evaluate(Mode::Full, &dir, Kind::Edit, &[inside_file], None), PolicyDecision::Allow);
        assert_eq!(evaluate(Mode::Full, &dir, Kind::Exec, &[], Some("npm install")), PolicyDecision::Allow);
        assert_eq!(evaluate(Mode::Full, &dir, Kind::Exec, &[], Some("git add src")), PolicyDecision::Allow);
        assert!(matches!(evaluate(Mode::Full, &dir, Kind::Exec, &[], Some("npm install && pnpm test")), PolicyDecision::Ask { .. }));
        assert!(matches!(evaluate(Mode::Full, &dir, Kind::Exec, &[], Some("git push origin main")), PolicyDecision::Ask { .. }));
        assert!(matches!(evaluate(Mode::Full, &dir, Kind::Exec, &[], Some("git merge feat/x")), PolicyDecision::Ask { .. }));
        assert!(matches!(evaluate(Mode::Full, &dir, Kind::Exec, &[], Some("git reset --hard HEAD~1")), PolicyDecision::Ask { .. }));
        assert!(matches!(evaluate(Mode::Full, &dir, Kind::Exec, &[], Some("rm -rf /")), PolicyDecision::DenyPolicy { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn auto_follows_symlinks_out_of_the_folder() {
        let dir = tmp();
        let outside = tmp();
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        assert!(!approves(Mode::Auto, &dir, Kind::Edit, &["link/x.txt".into()]));
    }

    #[test]
    fn requests_are_classified_across_providers() {
        let (k, p, c) = claude_request(&json!({ "tool_name": "Edit", "input": { "file_path": "/a/b" } }));
        assert_eq!((k, p, c), (Kind::Edit, vec!["/a/b".to_string()], None));
        let (k, _, c) = claude_request(&json!({ "tool_name": "Bash", "input": { "command": "cargo test" } }));
        assert_eq!((k, c.as_deref()), (Kind::Exec, Some("cargo test")));

        let (k, _, c) = codex_request("item/commandExecution/requestApproval", &json!({ "command": "git status" }));
        assert_eq!((k, c.as_deref()), (Kind::Exec, Some("git status")));
        let (k, p, _) = codex_request("item/fileChange/requestApproval", &json!({ "grantRoot": "/repo" }));
        assert_eq!((k, p), (Kind::Edit, vec!["/repo".to_string()]));

        assert_eq!(acp_request(&json!({ "kind": "edit" })).0, Kind::Other);
        assert_eq!(acp_request(&json!({ "kind": "read", "locations": [{ "path": "x" }] })), (Kind::Read, vec!["x".to_string()], None));
    }

    #[test]
    fn project_and_session_scopes_and_inheritance() {
        let modes = Modes::default();
        assert_eq!(modes.get(1), Mode::Ask);
        modes.set(Scope::Project("/repo".into()), Mode::Full).unwrap();
        modes.inherit_project("/repo", 42);
        assert_eq!(modes.get(42), Mode::Full);
        modes.set(Scope::Session(42), Mode::ReadOnly).unwrap();
        modes.inherit(42, 43);
        assert_eq!(modes.get(43), Mode::ReadOnly);
        modes.set(Scope::Session(44), Mode::Full).unwrap();
        modes.cap(44, Mode::ReadOnly).unwrap();
        assert_eq!(modes.get(44), Mode::ReadOnly);
        modes.cap(43, Mode::Full).unwrap();
        assert_eq!(modes.get(43), Mode::ReadOnly, "cap nunca amplía");
        let conn = crate::db::open(Path::new(":memory:")).unwrap();
        let p = crate::db::create_session(&conn, "/r", "claude", "a", &["p"]).unwrap();
        let c = crate::db::create_session(&conn, "/r", "codex", "b", &["c"]).unwrap();
        let g = crate::db::create_session(&conn, "/r", "claude", "c", &["g"]).unwrap();
        crate::db::set_session_parent(&conn, c.id, p.id, None).unwrap();
        crate::db::set_session_parent(&conn, g.id, c.id, None).unwrap();
        assert_eq!(descendants(&conn, p.id).unwrap().len(), 2);
    }

    #[test]
    fn full_and_auto_never_approve_rewritten_or_out_of_scope_commands() {
        let dir = tmp();
        for cmd in ["true\ngit push origin main", "(git push origin main)", "echo $(git push origin main)", "true & git push origin main",
            "if true; then git push; fi", "git -c alias.p=push p origin main", "git send-pack origin main", "gh -R o/r pr merge 1",
            "gh api -X PUT repos/o/r/pulls/1/merge", "\\rm -rf src", "git branch -d --force main", "cd .. && touch escaped.txt",
            "echo x >~/.zshrc", "cp secret $HOME/x", "git commit -m x", "git checkout main", "rm src", "curl https://example.com",
            "python3 -c print", "awk BEGIN", "make", "npx something", "cp a /etc/x", "mv a ../b", "git status --output=/tmp/x"] {
            for mode in [Mode::Full, Mode::Auto] {
                assert!(matches!(evaluate(mode, &dir, Kind::Exec, &[], Some(cmd)), PolicyDecision::Ask { .. } | PolicyDecision::DenyPolicy { .. }), "{mode:?} aprobó {cmd:?}");
            }
        }
        for cmd in ["/bin/zsh -lc 'rm -rf /'", "rm -rf $HOME", "rm -rf ~", "sh -c \"rm -fr /*\""] {
            assert!(matches!(evaluate(Mode::Full, &dir, Kind::Exec, &[], Some(cmd)), PolicyDecision::DenyPolicy { .. }), "{cmd:?}");
        }
        // Lo que sí aprueba Control total: comandos simples dentro del proyecto.
        for cmd in ["cargo test -p x", "pnpm build", "mkdir src/nuevo", "cp src/a.rs src/b.rs", "git diff", "gh pr view 3"] {
            assert_eq!(evaluate(Mode::Full, &dir, Kind::Exec, &[], Some(cmd)), PolicyDecision::Allow, "{cmd}");
        }
    }

    #[test]
    fn edits_that_change_future_execution_need_confirmation() {
        let dir = tmp();
        let p = |rel: &str| dir.join(rel).to_string_lossy().into_owned();
        for rel in [".git/config", ".claude/settings.json", ".codex/config.toml", ".mcp.json", ".git/hooks/pre-push"] {
            for mode in [Mode::Auto, Mode::Full] {
                assert!(matches!(evaluate(mode, &dir, Kind::Edit, &[p(rel)], None), PolicyDecision::Ask { .. }), "{mode:?} {rel}");
            }
        }
        // Automático tampoco cambia manifiestos ni scripts que ejecutan sus tests y builds.
        for rel in ["package.json", "src-tauri/build.rs", "Cargo.toml", "vite.config.ts", ".github/workflows/ci.yml", ".env"] {
            assert!(matches!(evaluate(Mode::Auto, &dir, Kind::Edit, &[p(rel)], None), PolicyDecision::Ask { .. }), "{rel}");
            assert_eq!(evaluate(Mode::Full, &dir, Kind::Edit, &[p(rel)], None), PolicyDecision::Allow, "{rel}");
        }
        assert_eq!(evaluate(Mode::Auto, &dir, Kind::Edit, &[p("src/main.rs")], None), PolicyDecision::Allow);
    }

    #[test]
    fn codex_requests_without_a_plain_command_always_reach_the_user() {
        let dir = tmp();
        for params in [json!({ "command": null }), json!({ "kind": "humanCommand", "command": "ls" }), json!({ "kind": "writeStdin" })] {
            let (kind, _, cmd) = codex_request("item/commandExecution/requestApproval", &params);
            assert!(cmd.is_none());
            assert!(matches!(evaluate(Mode::Full, &dir, kind, &[], cmd.as_deref()), PolicyDecision::Ask { .. }));
        }
        let (_, _, cmd) = codex_request("item/commandExecution/requestApproval", &json!({ "command": ["cargo", "test"] }));
        assert_eq!(cmd.as_deref(), Some("cargo test"));
    }

    #[cfg(unix)]
    #[test]
    fn parent_segments_are_resolved_after_following_links() {
        let dir = tmp();
        let outside = tmp();
        std::fs::create_dir_all(outside.join("deep")).unwrap();
        std::os::unix::fs::symlink(outside.join("deep"), dir.join("link")).unwrap();
        assert!(!inside(&dir, "link/../x.txt"));
        assert!(inside(&dir, "src/../x.txt"));
    }
}
