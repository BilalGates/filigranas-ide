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
    /// Carpeta relativa a la raíz que contiene el repositorio, si no es la raíz.
    folder: Option<String>,
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

/// Profundidad máxima a la que se buscan repositorios bajo la raíz
/// (p. ej. `raíz/Trabajo/cliente/repo`).
const MAX_DEPTH: usize = 3;
/// Carpetas que nunca contienen repositorios propios y son caras de recorrer.
const SKIP_DIRS: [&str; 4] = ["node_modules", "target", "vendor", "dist"];

type Found = (String, PathBuf, Option<String>);

/// Un repositorio principal tiene `.git` como carpeta; los worktrees
/// enlazados lo tienen como archivo y no se listan como proyectos.
fn is_main_repo(path: &Path) -> bool {
    path.join(".git").is_dir()
}

fn is_linked_worktree(path: &Path) -> bool {
    path.join(".git").is_file()
}

fn skipped(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

/// Repositorios Git bajo `root`, hasta `MAX_DEPTH` niveles. Las carpetas
/// intermedias sin Git (p. ej. «Trabajo», «Personal») se recorren como
/// categorías; nunca se entra dentro de un repositorio ni de un worktree.
/// Devuelve (nombre, ruta, carpeta contenedora relativa a la raíz).
/// Nunca escribe nada en las carpetas detectadas.
fn scan(root: &Path) -> std::io::Result<Vec<Found>> {
    let mut found = Vec::new();
    walk(root, root, 1, &mut found, true)?;
    found.sort_by_key(|(name, _, folder)| (folder.clone().unwrap_or_default().to_lowercase(), name.to_lowercase()));
    Ok(found)
}

fn walk(root: &Path, dir: &Path, depth: usize, found: &mut Vec<Found>, strict: bool) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // La raíz debe poder leerse; una subcarpeta sin permisos se ignora.
        Err(e) if strict => return Err(e),
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if skipped(&name) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let path = entry.path();
        if is_main_repo(&path) {
            let folder = dir
                .strip_prefix(root)
                .ok()
                .filter(|rel| !rel.as_os_str().is_empty())
                .map(|rel| paths::to_string(rel).replace('\\', "/"));
            found.push((name, path, folder));
        } else if !is_linked_worktree(&path) && depth < MAX_DEPTH {
            walk(root, &path, depth + 1, found, false)?;
        }
    }
    Ok(())
}

/// Carpetas intermedias (categorías) que hay que vigilar para detectar
/// repositorios nuevos dentro de ellas.
pub(crate) fn category_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 1)];
    while let Some((dir, depth)) = stack.pop() {
        if depth >= MAX_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if skipped(&name) || !entry.file_type().is_ok_and(|k| k.is_dir()) || is_main_repo(&path) || is_linked_worktree(&path) {
                continue;
            }
            dirs.push(path.clone());
            stack.push((path, depth + 1));
        }
    }
    dirs
}

/// Clasifica una sola vez cada proyecto nuevo en un grupo con el nombre de
/// su carpeta contenedora. Si el usuario lo mueve después, se respeta.
fn auto_group(conn: &Connection, found: &[Found], known: &HashMap<String, (Option<i64>, bool)>) -> CmdResult<bool> {
    let mut changed = false;
    for (_, path, folder) in found {
        let path = paths::to_string(path);
        let Some(folder) = folder else { continue };
        if known.contains_key(&path) {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO groups (name, position)
             VALUES (?1, (SELECT COALESCE(MAX(position), 0) + 1 FROM groups))",
            [folder],
        )
        .map_err(err)?;
        let group_id: i64 = conn.query_row("SELECT id FROM groups WHERE name = ?1", [folder], |r| r.get(0)).map_err(err)?;
        conn.execute("INSERT OR IGNORE INTO projects (path, group_id) VALUES (?1, ?2)", params![path, group_id]).map_err(err)?;
        changed = true;
    }
    Ok(changed)
}

fn read_meta(conn: &Connection) -> CmdResult<HashMap<String, (Option<i64>, bool)>> {
    let mut stmt = conn.prepare("SELECT path, group_id, archived FROM projects").map_err(err)?;
    let meta = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get::<_, i64>(2)? != 0))))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    Ok(meta)
}

pub(crate) fn root_of(conn: &Connection) -> CmdResult<PathBuf> {
    db::get_setting(conn, "root")
        .map_err(err)?
        .map(PathBuf::from)
        .ok_or_else(|| "no hay carpeta de proyectos".to_string())
}

fn load(conn: &Connection) -> CmdResult<Workspace> {
    let root = db::get_setting(conn, "root").map_err(err)?;
    let found = match &root {
        Some(root) => scan(Path::new(root)).map_err(|e| format!("no se puede leer {root}: {e}"))?,
        None => Vec::new(),
    };
    let mut meta = read_meta(conn)?;
    if auto_group(conn, &found, &meta)? {
        meta = read_meta(conn)?;
    }

    let mut stmt = conn
        .prepare("SELECT id, name FROM groups ORDER BY position, name COLLATE NOCASE")
        .map_err(err)?;
    let groups = stmt
        .query_map([], |r| Ok(Group { id: r.get(0)?, name: r.get(1)? }))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;

    let projects = found
        .into_iter()
        .map(|(name, path, folder)| {
            let path = paths::to_string(&path);
            let (group_id, archived) = meta.get(&path).copied().unwrap_or((None, false));
            Project { name, path, folder, group_id, archived }
        })
        .collect();

    Ok(Workspace { root, groups, projects })
}

pub(crate) fn project_names(conn: &Connection) -> CmdResult<std::collections::BTreeMap<String, String>> {
    let workspace = load(conn)?;
    Ok(workspace.projects.into_iter().map(|project| (project.path, project.name)).collect())
}

/// Valida que `path` sea un repositorio detectable bajo la raíz y devuelve
/// su ruta tal como la produce `scan` (raíz + ruta relativa).
pub(crate) fn project_path(conn: &Connection, path: &str) -> CmdResult<String> {
    let root = root_of(conn)?;
    let p = paths::inside(&root, Path::new(path))?;
    let root_c = paths::canonical(&root).map_err(err)?;
    let rel = p.strip_prefix(&root_c).map_err(|_| "ruta fuera de la carpeta de proyectos".to_string())?.to_path_buf();
    let depth = rel.components().count();
    let not_project = || "no es un proyecto de la carpeta raíz".to_string();
    if depth == 0 || depth > MAX_DEPTH || !is_main_repo(&p) {
        return Err(not_project());
    }
    // Ninguna carpeta intermedia puede ser oculta, un repositorio o un worktree.
    let mut cur = root_c.clone();
    for comp in rel.components().take(depth - 1) {
        cur.push(comp);
        if skipped(&comp.as_os_str().to_string_lossy()) || is_main_repo(&cur) || is_linked_worktree(&cur) {
            return Err(not_project());
        }
    }
    Ok(paths::to_string(&root.join(rel)))
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
    reveal(&path)
}

/// Abre en el explorador o en VS Code el worktree de una sesión aislada.
/// Solo acepta rutas registradas como worktree de alguna sesión.
#[tauri::command]
pub fn open_worktree(state: State<AppState>, path: String, editor: bool) -> CmdResult<()> {
    let known: bool = state
        .db
        .lock()
        .map_err(err)?
        .query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE worktree = ?1)", [&path], |r| r.get(0))
        .map_err(err)?;
    if !known {
        return Err("no es el worktree de ninguna sesión".into());
    }
    if !Path::new(&path).is_dir() {
        return Err(format!("ya no existe la carpeta {path}"));
    }
    if editor {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "code"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = std::process::Command::new("code");
        let mut child = cmd.arg(&path).spawn().map_err(|e| format!("no se pudo abrir VS Code: {e}"))?;
        std::thread::spawn(move || { let _ = child.wait(); });
        return Ok(());
    }
    reveal(&path)
}

fn reveal(path: &str) -> CmdResult<()> {
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

        let names: Vec<_> = scan(&tmp).unwrap().into_iter().map(|(n, _, _)| n).collect();
        assert_eq!(names, vec!["Alpha", "beta"]);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn scan_finds_repos_inside_category_folders_and_skips_worktrees() {
        let tmp = std::env::temp_dir().join(format!("filigranas-scan-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("Trabajo/dash/.git")).unwrap();
        std::fs::create_dir_all(tmp.join("Trabajo/dash/sub/.git")).unwrap();
        std::fs::create_dir_all(tmp.join("Personal/app/.git")).unwrap();
        std::fs::create_dir_all(tmp.join("Personal/app-worktrees/feat")).unwrap();
        std::fs::write(tmp.join("Personal/app-worktrees/feat/.git"), "gitdir: x").unwrap();
        std::fs::create_dir_all(tmp.join("suelto/.git")).unwrap();

        let found: Vec<_> = scan(&tmp).unwrap().into_iter().map(|(n, _, f)| (n, f)).collect();
        assert_eq!(found, vec![
            ("suelto".to_string(), None),
            ("app".to_string(), Some("Personal".to_string())),
            ("dash".to_string(), Some("Trabajo".to_string())),
        ]);

        let conn = db::open(Path::new(":memory:")).unwrap();
        db::set_setting(&conn, "root", &paths::to_string(&paths::canonical(&tmp).unwrap())).unwrap();
        assert!(project_path(&conn, &paths::to_string(&tmp.join("Trabajo/dash"))).is_ok());
        assert!(project_path(&conn, &paths::to_string(&tmp.join("Trabajo/dash/sub"))).is_err());
        assert!(project_path(&conn, &paths::to_string(&tmp.join("Trabajo"))).is_err());

        let ws = load(&conn).unwrap();
        let names: Vec<_> = ws.groups.iter().map(|g| g.name.clone()).collect();
        assert!(names.contains(&"Personal".to_string()) && names.contains(&"Trabajo".to_string()));
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
