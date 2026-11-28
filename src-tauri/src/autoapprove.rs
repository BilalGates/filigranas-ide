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

    fn set(&self, scope: Scope, mode: Mode) -> CmdResult<()> {
        let mut modes = self.0.lock().map_err(err)?;
        modes.insert(scope, mode);
        Ok(())
    }
}

/// Comandos catastróficos bloqueados en todos los modos por política superior.
pub fn is_catastrophic_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    let compact = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    let targets_root_or_home = compact.contains("rm -rf / ")
        || compact.ends_with("rm -rf /")
        || compact.contains("rm -rf /*")
        || compact.contains("rm -rf ~")
        || compact.contains("rm -fr / ")
        || compact.ends_with("rm -fr /")
        || compact.contains("rm -fr /*")
        || compact.contains("rm -fr ~");
    targets_root_or_home
        || compact.contains("mkfs.")
        || compact.contains("diskutil erase")
        || compact.contains("dd if=") && compact.contains("of=/dev/")
        || compact.contains(":(){")
        || compact.starts_with("shutdown ")
        || compact == "shutdown"
        || compact == "reboot"
}

/// Operaciones reservadas al flujo explícito de Entrega o destructivas sobre Git.
/// Requieren confirmación explícita incluso en Full Control.
pub fn protected_operation_reason(cmd: &str) -> Option<&'static str> {
    let compact = cmd.split_whitespace().collect::<Vec<_>>().join(" ");
    // Tokeniza segmentos separados por &&, ||, ; o | para detectar subcomandos reales.
    for seg in compact.split([';', '|']).flat_map(|s| s.split("&&")) {
        let s = seg.trim();
        let tokens: Vec<&str> = s.split_whitespace().map(|t| t.trim_matches(['\'', '"'])).collect();
        if tokens.is_empty() {
            continue;
        }
        // Ignora prefijos de entorno o `env` / `cd`.
        let mut i = 0;
        while i < tokens.len() && (tokens[i].contains('=') || tokens[i] == "env") {
            i += 1;
        }
        let rest = &tokens[i..];
        if rest.is_empty() {
            continue;
        }
        let program = Path::new(rest[0]).file_name().and_then(|p| p.to_str()).unwrap_or(rest[0]);
        if matches!(program, "command" | "builtin" | "env" | "nohup" | "time" | "nice" | "rm" | "rmdir" | "unlink" | "sudo" | "sh" | "bash" | "zsh" | "python" | "python3" | "node" | "eval" | "exec" | "find" | "xargs" | "perl" | "ruby" | "osascript" | "powershell" | "pwsh" | "cmd") {
            return Some("Borrado, privilegios o ejecución indirecta requieren autorización específica.");
        }
        if program == "git" {
            // Salta flags globales como `-C <dir>`.
            let mut j = 1;
            while j < rest.len() {
                if rest[j] == "-c" || rest[j] == "-C" || rest[j] == "--git-dir" || rest[j] == "--work-tree" {
                    j += 2;
                } else if rest[j].starts_with('-') {
                    j += 1;
                } else {
                    break;
                }
            }
            if let Some(&sub) = rest.get(j) {
                match sub {
                    "push" => return Some("git push requiere autorización explícita (usa Entrega para publicar con confirmación de SHA)."),
                    "merge" | "rebase" | "restore" | "checkout" | "switch" | "config" => return Some("Esta operación Git requiere autorización específica para conservar ramas, cambios y configuración."),
                    "reset" if rest[j + 1..].contains(&"--hard") => {
                        return Some("git reset --hard es destructivo y requiere confirmación explícita.");
                    }
                    "clean" if rest[j + 1..].iter().any(|t| t.starts_with('-') && t.contains('f')) => {
                        return Some("git clean -f elimina archivos sin seguimiento y requiere confirmación explícita.");
                    }
                    "branch" if rest[j + 1..].contains(&"-D") => {
                        return Some("git branch -D fuerza el borrado de una rama y requiere confirmación explícita.");
                    }
                    _ => {}
                }
            }
        }
        if program == "gh" && rest.get(1) == Some(&"pr") && matches!(rest.get(2), Some(&"merge" | &"close")) {
            return Some("Integrar o cerrar una Pull Request en GitHub requiere aprobación humana explícita.");
        }
    }
    None
}

/// Lista conservadora. No interpreta shell ni ejecuta código para clasificarlo.
/// Scripts de proyecto (test/build) son autorización de ejecución, no solo lectura.
pub fn is_readonly_command(cmd: &str) -> bool {
    if cmd.is_empty() || cmd.chars().any(|c| "\n\r;|&><`$(){}\\\"'".contains(c)) { return false; }
    let t: Vec<_> = cmd.split_whitespace().collect();
    let Some(bin) = t.first() else { return false };
    match *bin {
        "pwd" => t.len() == 1,
        "ls" | "cat" | "head" | "tail" | "wc" | "rg" | "grep" | "file" | "stat" =>
            !t.iter().skip(1).any(|v| v.starts_with('-') &&
                (v.contains("pre") || v.contains("hostname") || v.contains("files-with") || v.contains("follow"))),
        "git" => t.len() >= 2 && matches!(t[1], "status" | "rev-parse" | "ls-files" | "merge-base")
            && !t.iter().any(|v| v.starts_with("--output") || v.starts_with("--config")),
        _ => false,
    }
}

pub fn is_auto_safe_command(cmd: &str) -> bool {
    if is_readonly_command(cmd) { return true; }
    // Estos scripts pueden escribir dentro del proyecto: Auto los autoriza como
    // política de ejecución local, y nunca como consultas de Solo lectura.
    if cmd.chars().any(|c| "\n\r;|&><`$(){}\\\"'".contains(c)) { return false; }
    let t: Vec<_> = cmd.split_whitespace().collect();
    matches!(t.as_slice(), ["pnpm" | "npm", "test" | "build" | "typecheck" | "lint" | "check"]
        | ["cargo", "test" | "check" | "clippy" | "build"])
}

/// Evalúa la decisión de permisos efectiva para cualquier proveedor (Claude, Codex, ACP).
pub fn evaluate(mode: Mode, cwd: &Path, kind: Kind, paths: &[String], command: Option<&str>) -> PolicyDecision {
    if let Some(cmd) = command {
        if is_catastrophic_command(cmd) {
            return PolicyDecision::DenyPolicy {
                origin: "política de seguridad",
                reason: "Operación destructiva bloqueada por política superior de Filigranas.".into(),
            };
        }
        if let Some(reason) = protected_operation_reason(cmd) {
            if mode == Mode::ReadOnly {
                return PolicyDecision::DenyPolicy {
                    origin: "modo Solo lectura",
                    reason: format!("Bloqueado en Solo lectura: {reason}"),
                };
            }
            return PolicyDecision::Ask {
                origin: "protección de proyecto",
                reason: Some(reason.into()),
            };
        }
    }

    if !paths.iter().all(|p| inside(cwd, p)) && mode != Mode::ReadOnly {
        return PolicyDecision::Ask { origin: "alcance del proyecto", reason: Some("La ruta sale de la carpeta autorizada.".into()) };
    }
    if matches!(mode, Mode::Auto | Mode::Full) && kind == Kind::Exec {
        if let Some(command) = command {
            let outside = command.split_whitespace().skip(1).map(|t| t.trim_matches(['\"', '\'']))
                .any(|t| (t.starts_with('/') || t.starts_with("../") || t.starts_with('~')) && !inside(cwd,t));
            if outside { return PolicyDecision::Ask { origin:"alcance del proyecto", reason:Some("El comando incluye una ruta fuera del alcance autorizado.".into()) }; }
        }
    }
    match mode {
        Mode::ReadOnly => match kind {
            Kind::Read => PolicyDecision::Allow,
            Kind::Exec if command.is_some_and(is_readonly_command) => PolicyDecision::Allow,
            Kind::Edit => PolicyDecision::DenyPolicy {
                origin: "modo Solo lectura",
                reason: "La sesión está en modo Solo lectura: no se permiten modificaciones de archivos.".into(),
            },
            Kind::Exec | Kind::Other => PolicyDecision::DenyPolicy {
                origin: "modo Solo lectura",
                reason: "La sesión está en modo Solo lectura: solo se permiten consultas e investigación sin escritura.".into(),
            },
        },
        Mode::Ask => PolicyDecision::Ask {
            origin: "Filigranas (Con autorización)",
            reason: None,
        },
        Mode::Auto => match kind {
            Kind::Read if paths.iter().all(|p| inside(cwd, p)) => PolicyDecision::Allow,
            Kind::Edit if !paths.is_empty() && paths.iter().all(|p| inside(cwd, p)) => PolicyDecision::Allow,
            Kind::Exec if paths.iter().all(|p| inside(cwd, p)) && command.is_some_and(is_auto_safe_command) => PolicyDecision::Allow,
            Kind::Edit => PolicyDecision::Ask {
                origin: "política Automático",
                reason: Some("La ruta sale de la carpeta autorizada del proyecto.".into()),
            },
            Kind::Exec => PolicyDecision::Ask {
                origin: "política Automático",
                reason: Some("Comando fuera de la política automática segura (lectura, build, lint y tests locales).".into()),
            },
            _ => PolicyDecision::Ask {
                origin: "política Automático",
                reason: Some("Requiere confirmación según la política Automático.".into()),
            },
        },
        Mode::Full if kind == Kind::Edit && paths.is_empty() => PolicyDecision::Ask {
            origin: "alcance del proyecto", reason:Some("El proveedor no ha informado las rutas del cambio; no se puede autorizar su alcance.".into())
        },
        Mode::Full => PolicyDecision::Allow,
    }
}

/// Compatibilidad booleana simple para callers/tests existentes.
#[cfg(test)]
pub fn approves(mode: Mode, cwd: &Path, kind: Kind, paths: &[String]) -> bool {
    matches!(evaluate(mode, cwd, kind, paths, None), PolicyDecision::Allow)
}

/// `path` (absoluta o relativa a `cwd`) queda dentro de `cwd`, siguiendo
/// enlaces simbólicos de la parte que ya existe.
pub fn inside(cwd: &Path, path: &str) -> bool {
    let Ok(root) = std::fs::canonicalize(cwd) else { return false };
    let raw = Path::new(path);
    let joined = if raw.is_absolute() { raw.to_path_buf() } else { cwd.join(raw) };
    let mut clean = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::ParentDir => { if !clean.pop() { return false; } }
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
            let cmd = params["command"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    params["parsedCmd"].as_array().map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                });
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

#[tauri::command]
pub fn session_permission_mode(state: State<AppState>, id: Option<i64>, project: Option<String>, mode: String) -> CmdResult<String> {
    let parsed = Mode::parse(&mode).ok_or("nivel de permisos no válido")?;
    match (id, project) {
        (Some(id), maybe_project) => {
            state.permissions.set(Scope::Session(id), parsed)?;
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

        // Solo lectura: permite lectura y git status, deniega escritura/comandos mutantes por política.
        assert_eq!(evaluate(Mode::ReadOnly, &dir, Kind::Read, std::slice::from_ref(&inside_file), None), PolicyDecision::Allow);
        assert_eq!(evaluate(Mode::ReadOnly, &dir, Kind::Exec, &[], Some("git status")), PolicyDecision::Allow);
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
        assert_eq!(evaluate(Mode::Full, &dir, Kind::Exec, &[], Some("npm install && pnpm test")), PolicyDecision::Allow);
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
    }
}
