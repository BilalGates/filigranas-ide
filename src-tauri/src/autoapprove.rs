//! Nivel de permisos de cada sesión, elegido por el usuario en el chat.
//!
//! - `ask` (por defecto): toda petición de permiso del agente llega al usuario.
//! - `auto`: Filigranas aprueba por su cuenta lecturas y ediciones de archivos
//!   que quedan dentro de la carpeta de la sesión. Órdenes de terminal, red,
//!   borrados y todo lo que salga de la carpeta siguen pidiendo permiso.
//! - `full`: Filigranas aprueba cualquier petición de esa sesión.
//!
//! El nivel vive en memoria: la interfaz lo vuelve a fijar al abrir la sesión,
//! así que un reinicio nunca deja una sesión en acceso total sin que se vea.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;
use tauri::State;

use crate::{err, AppState, CmdResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Ask,
    Auto,
    Full,
}

impl Mode {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "ask" => Some(Self::Ask),
            "auto" => Some(Self::Auto),
            "full" => Some(Self::Full),
            _ => None,
        }
    }
}

/// Qué pide el agente, reducido a lo que importa para decidir.
#[derive(Debug, PartialEq, Eq)]
pub enum Kind {
    Read,
    Edit,
    /// Terminal, red, borrados o cualquier otra cosa.
    Other,
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
        if mode == Mode::Ask {
            modes.remove(&scope);
        } else {
            modes.insert(scope, mode);
        }
        Ok(())
    }
}

/// ¿Aprueba Filigranas esta petición sin preguntar?
pub fn approves(mode: Mode, cwd: &Path, kind: Kind, paths: &[String]) -> bool {
    match mode {
        Mode::Ask => false,
        Mode::Full => true,
        Mode::Auto => kind != Kind::Other && paths.iter().all(|p| inside(cwd, p)),
    }
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
            Component::ParentDir => { if !clean.pop() { return false; } }
            Component::CurDir => {}
            other => clean.push(other),
        }
    }
    // Resuelve el antepasado existente más largo y añade el resto tal cual.
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
pub fn claude_request(request: &Value) -> (Kind, Vec<String>) {
    let tool = request["tool_name"].as_str().unwrap_or("");
    let input = &request["input"];
    let kind = match tool {
        "Read" | "Glob" | "Grep" | "LS" | "NotebookRead" => Kind::Read,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => Kind::Edit,
        _ => Kind::Other,
    };
    let paths = ["file_path", "notebook_path", "path"].iter()
        .filter_map(|k| input[*k].as_str().map(str::to_owned))
        .collect();
    (kind, paths)
}

/// Petición `session/request_permission` de ACP.
pub fn acp_request(tool_call: &Value) -> (Kind, Vec<String>) {
    let kind = match tool_call["kind"].as_str().unwrap_or("") {
        "read" | "search" => Kind::Read,
        "edit" => Kind::Edit,
        _ => Kind::Other,
    };
    let paths: Vec<String> = tool_call["locations"].as_array().map(|l| l.iter()
        .filter_map(|loc| loc["path"].as_str().map(str::to_owned)).collect()).unwrap_or_default();
    // Una edición sin rutas no se puede comprobar: se pregunta.
    if kind == Kind::Edit && paths.is_empty() { return (Kind::Other, paths); }
    (kind, paths)
}

#[tauri::command]
pub fn session_permission_mode(state: State<AppState>, id: Option<i64>, project: Option<String>, mode: String) -> CmdResult<String> {
    let parsed = Mode::parse(&mode).ok_or("nivel de permisos no válido")?;
    let scope = match (id, project) {
        (Some(id), _) => Scope::Session(id),
        (None, Some(project)) => {
            let path = crate::workspace::project_path(&*state.db.lock().map_err(err)?, &project)?;
            Scope::Project(path)
        }
        (None, None) => return Err("falta la sesión o el proyecto".into()),
    };
    state.permissions.set(scope, parsed)?;
    Ok(mode)
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
    fn ask_never_and_full_always() {
        let dir = tmp();
        assert!(!approves(Mode::Ask, &dir, Kind::Read, &["src".into()]));
        assert!(approves(Mode::Full, &dir, Kind::Other, &["/etc/passwd".into()]));
    }

    #[test]
    fn auto_only_reads_and_edits_inside_the_folder() {
        let dir = tmp();
        let abs = dir.join("src/new.rs").to_string_lossy().into_owned();
        assert!(approves(Mode::Auto, &dir, Kind::Edit, &[abs]));
        assert!(approves(Mode::Auto, &dir, Kind::Edit, &["src/a/b.rs".into()]));
        assert!(approves(Mode::Auto, &dir, Kind::Read, &[]));
        assert!(!approves(Mode::Auto, &dir, Kind::Edit, &["../fuera.txt".into()]));
        assert!(!approves(Mode::Auto, &dir, Kind::Edit, &["/etc/hosts".into()]));
        assert!(!approves(Mode::Auto, &dir, Kind::Other, &["src".into()]));
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
    fn requests_are_classified() {
        let (k, p) = claude_request(&json!({ "tool_name": "Edit", "input": { "file_path": "/a/b" } }));
        assert_eq!((k, p), (Kind::Edit, vec!["/a/b".to_string()]));
        assert_eq!(claude_request(&json!({ "tool_name": "Bash", "input": { "command": "ls" } })).0, Kind::Other);
        assert_eq!(acp_request(&json!({ "kind": "edit" })).0, Kind::Other);
        assert_eq!(acp_request(&json!({ "kind": "read", "locations": [{ "path": "x" }] })), (Kind::Read, vec!["x".to_string()]));
    }

    #[test]
    fn project_and_session_scopes_are_independent() {
        let modes = Modes::default();
        assert_eq!(modes.get(1), Mode::Ask);
        assert_eq!(modes.get_project("/repo"), Mode::Ask);
        modes.set(Scope::Project("/repo".into()), Mode::Full).unwrap();
        modes.set(Scope::Session(1), Mode::Auto).unwrap();
        assert_eq!(modes.get_project("/repo"), Mode::Full);
        assert_eq!(modes.get_project("/other"), Mode::Ask);
        assert_eq!(modes.get(1), Mode::Auto);
        modes.set(Scope::Project("/repo".into()), Mode::Ask).unwrap();
        assert_eq!(modes.get_project("/repo"), Mode::Ask);
        assert_eq!(modes.get(1), Mode::Auto);
    }
}
