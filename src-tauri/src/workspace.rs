use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{db, err, paths, watch, AppState, CmdResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    id: i64,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    name: String,
    path: String,
    group_id: Option<i64>,
    archived: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    root: Option<String>,
    groups: Vec<Group>,
    projects: Vec<Project>,
}

/// Repositorios Git que son hijos directos de `root`, ordenados por nombre.
/// Nunca escribe nada en las carpetas detectadas.
fn scan(root: &Path) -> std::io::Result<Vec<(String, PathBuf)>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) && path.join(".git").exists() {
            found.push((name, path));
        }
    }
    found.sort_by_key(|(name, _)| name.to_lowercase());
    Ok(found)
}

pub(crate) fn root_of(conn: &Connection) -> CmdResult<PathBuf> {
    db::get_setting(conn, "root")
        .map_err(err)?
        .map(PathBuf::from)
        .ok_or_else(|| "no hay carpeta de proyectos".to_string())
}

fn load(conn: &Connection) -> CmdResult<Workspace> {
    let root = db::get_setting(conn, "root").map_err(err)?;

    let mut stmt = conn
        .prepare("SELECT id, name FROM groups ORDER BY position, name COLLATE NOCASE")
        .map_err(err)?;
    let groups = stmt
        .query_map([], |r| Ok(Group { id: r.get(0)?, name: r.get(1)? }))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;

    let mut stmt = conn
        .prepare("SELECT path, group_id, archived FROM projects")
        .map_err(err)?;
    let meta: HashMap<String, (Option<i64>, bool)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get::<_, i64>(2)? != 0))))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;

    let projects = match &root {
        Some(root) => scan(Path::new(root))
            .map_err(|e| format!("no se puede leer {root}: {e}"))?
            .into_iter()
            .map(|(name, path)| {
                let path = paths::to_string(&path);
                let (group_id, archived) = meta.get(&path).copied().unwrap_or((None, false));
                Project { name, path, group_id, archived }
            })
            .collect(),
        None => Vec::new(),
    };

    Ok(Workspace { root, groups, projects })
}

pub(crate) fn project_names(conn: &Connection) -> CmdResult<std::collections::BTreeMap<String, String>> {
    let workspace = load(conn)?;
    Ok(workspace.projects.into_iter().map(|project| (project.path, project.name)).collect())
}

/// Valida que `path` sea un proyecto de la raíz y devuelve su ruta canónica.
pub(crate) fn project_path(conn: &Connection, path: &str) -> CmdResult<String> {
    let root = root_of(conn)?;
    let p = paths::direct_child(&root, Path::new(path))?;
    // Guardamos la ruta tal como la produce `scan` (raíz + nombre).
    let name = p.file_name().ok_or("ruta sin nombre")?;
    Ok(paths::to_string(&root.join(name)))
}

#[tauri::command]
pub async fn get_workspace(app: AppHandle) -> CmdResult<Workspace> {
    crate::background_read(app, |state| load(&*state.db.lock().map_err(err)?)).await
}

#[tauri::command]
pub fn default_root(app: AppHandle) -> CmdResult<String> {
    let home = app.path().home_dir().map_err(err)?;
    Ok(paths::to_string(&home.join("repositorios")))
}

#[tauri::command]
pub fn set_root(app: AppHandle, state: State<AppState>, path: String) -> CmdResult<Workspace> {
    let root = paths::canonical(Path::new(&path)).map_err(|e| format!("{path}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{path} no es una carpeta"));
    }
    let root_s = paths::to_string(&root);
    {
        let conn = state.db.lock().map_err(err)?;
        db::set_setting(&conn, "root", &root_s).map_err(err)?;
    }
    watch::start(&app, &root).map_err(err)?;
    let conn = state.db.lock().map_err(err)?;
    load(&conn)
}

#[tauri::command]
pub fn create_group(state: State<AppState>, name: String) -> CmdResult<Workspace> {
    let name = name.trim();
    if name.is_empty() {
        return Err("el grupo necesita un nombre".into());
    }
    let conn = state.db.lock().map_err(err)?;
    conn.execute(
        "INSERT INTO groups (name, position)
         VALUES (?1, (SELECT COALESCE(MAX(position), 0) + 1 FROM groups))",
        [name],
    )
    .map_err(|e| match e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            format!("ya existe el grupo «{name}»")
        }
        e => err(e),
    })?;
    load(&conn)
}

#[tauri::command]
pub fn rename_group(state: State<AppState>, id: i64, name: String) -> CmdResult<Workspace> {
    let name = name.trim();
    if name.is_empty() {
        return Err("el grupo necesita un nombre".into());
    }
    let conn = state.db.lock().map_err(err)?;
    conn.execute("UPDATE groups SET name = ?1 WHERE id = ?2", params![name, id])
        .map_err(err)?;
    load(&conn)
}

/// Borra el grupo; sus proyectos pasan a «sin clasificar». Las carpetas no se tocan.
#[tauri::command]
pub fn delete_group(state: State<AppState>, id: i64) -> CmdResult<Workspace> {
    let conn = state.db.lock().map_err(err)?;
    conn.execute("DELETE FROM groups WHERE id = ?1", [id]).map_err(err)?;
    load(&conn)
}

#[tauri::command]
pub fn move_project(state: State<AppState>, path: String, group_id: Option<i64>) -> CmdResult<Workspace> {
    let conn = state.db.lock().map_err(err)?;
    let path = project_path(&conn, &path)?;
    conn.execute(
        "INSERT INTO projects (path, group_id) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET group_id = excluded.group_id",
        params![path, group_id],
    )
    .map_err(err)?;
    load(&conn)
}

/// Archivar solo oculta el proyecto de la lista activa; nunca mueve ni borra la carpeta.
#[tauri::command]
pub fn set_archived(state: State<AppState>, path: String, archived: bool) -> CmdResult<Workspace> {
    let conn = state.db.lock().map_err(err)?;
    let path = project_path(&conn, &path)?;
    conn.execute(
        "INSERT INTO projects (path, archived) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET archived = excluded.archived",
        params![path, archived as i64],
    )
    .map_err(err)?;
    load(&conn)
}

/// Crea un proyecto nuevo en la raíz: carpeta vacía con `git init`.
#[tauri::command]
pub fn create_project(state: State<AppState>, name: String) -> CmdResult<Workspace> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\']) || !matches!(Path::new(name).components().next(), Some(std::path::Component::Normal(_))) {
        return Err(format!("«{name}» no vale como nombre de carpeta"));
    }
    let conn = state.db.lock().map_err(err)?;
    let root = root_of(&conn)?;
    let dir = root.join(name);
    if dir.exists() {
        return Err(format!("ya existe {}", paths::to_string(&dir)));
    }
    std::fs::create_dir(&dir).map_err(|e| format!("no se puede crear {name}: {e}"))?;
    let out = std::process::Command::new("git").arg("init").arg("-q").current_dir(&dir).output().map_err(|e| format!("git init: {e}"))?;
    if !out.status.success() {
        return Err(format!("git init: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    load(&conn)
}

#[tauri::command]
pub fn reveal_project(state: State<AppState>, path: String) -> CmdResult<()> {
    let path = project_path(&*state.db.lock().map_err(err)?, &path)?;
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(windows)]
    let program = "explorer.exe";
    #[cfg(not(any(target_os = "macos", windows)))]
    let program = "xdg-open";
    let mut child = std::process::Command::new(program).arg(path).spawn().map_err(err)?;
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_detects_only_git_children() {
        let tmp = std::env::temp_dir().join(format!("filigranas-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("beta/.git")).unwrap();
        std::fs::create_dir_all(tmp.join("Alpha/.git")).unwrap();
        std::fs::create_dir_all(tmp.join("sin-git")).unwrap();
        std::fs::create_dir_all(tmp.join(".oculto/.git")).unwrap();
        std::fs::write(tmp.join("archivo.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(tmp.join("beta"), tmp.join("alias")).unwrap();

        let names: Vec<_> = scan(&tmp).unwrap().into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, vec!["Alpha", "beta"]);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn groups_and_archive_roundtrip() {
        let conn = db::open(Path::new(":memory:")).unwrap();
        conn.execute("INSERT INTO groups (name) VALUES ('webs')", []).unwrap();
        conn.execute("INSERT INTO projects (path, group_id, archived) VALUES ('/r/a', 1, 1)", [])
            .unwrap();
        conn.execute("DELETE FROM groups WHERE id = 1", []).unwrap();
        let (group, archived): (Option<i64>, i64) = conn
            .query_row("SELECT group_id, archived FROM projects WHERE path = '/r/a'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(group, None, "borrar un grupo deja el proyecto sin clasificar");
        assert_eq!(archived, 1);
    }
}
