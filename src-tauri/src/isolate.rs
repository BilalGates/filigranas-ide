use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::git::git;
use crate::{db, CmdResult};

// Aislamiento de sesiones (PLAN.md §4): cada sesión que escribe trabaja en
// su propia rama `ide/<nombre>-<id>` y en un worktree fuera de la carpeta
// de proyectos. Integrar aplica su diff al checkout principal como cambios
// sin commit, para revisarlos y que Larry los agrupe; si algo choca no se
// aplica nada y la rama y el worktree se conservan.

#[cfg(test)]
pub struct Isolation {
    pub worktree: String,
    pub branch: String,
    pub base: String,
    pub base_commit: String,
    /// El checkout principal tenía cambios sin commit (no se incluyen).
    pub main_dirty: bool,
}

/// Carpeta de worktrees de un proyecto dentro del directorio de datos.
#[cfg(test)]
fn worktree_dir(data_dir: &Path, project: &Path, name: &str, id: i64) -> PathBuf {
    let project_name = project.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "proyecto".into());
    data_dir.join("worktrees").join(project_name).join(format!("{name}-{id}"))
}

/// Crea rama y worktree para una sesión. `None` si el proyecto no tiene
/// commits todavía (no hay de dónde partir): la sesión usa el proyecto.
#[cfg(test)]
pub fn create(data_dir: &Path, project: &Path, name: &str, id: i64) -> CmdResult<Option<Isolation>> {
    let Ok(head) = git(project, &["rev-parse", "--verify", "--quiet", "HEAD"]) else { return Ok(None) };
    let base_commit = String::from_utf8_lossy(&head).trim().to_string();
    let base = git(project, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .unwrap_or_else(|_| base_commit.chars().take(7).collect());
    let main_dirty = !git(project, &["status", "--porcelain"])?.is_empty();
    let dir = worktree_dir(data_dir, project, name, id);
    if dir.exists() {
        return Err(format!("ya existe la carpeta {}", dir.display()));
    }
    std::fs::create_dir_all(dir.parent().ok_or("ruta de worktree no válida")?).map_err(|e| e.to_string())?;
    // Nombres como «sesión 1»: la rama solo lleva letras ASCII, números y guiones.
    let slug: String = name
        .chars()
        .map(|c| match c {
            'á' | 'à' => 'a',
            'é' | 'è' => 'e',
            'í' => 'i',
            'ó' => 'o',
            'ú' | 'ü' => 'u',
            'ñ' => 'n',
            c if c.is_ascii_alphanumeric() => c.to_ascii_lowercase(),
            _ => '-',
        })
        .collect();
    let branch = format!("ide/{slug}-{id}");
    let dir_str = dir.to_string_lossy().into_owned();
    git(project, &["worktree", "add", "-b", &branch, &dir_str, &base_commit])?;
    Ok(Some(Isolation { worktree: dir_str, branch, base, base_commit, main_dirty }))
}

fn git_stdin(repo: &Path, args: &[&str], input: &[u8]) -> CmdResult<String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("no se pudo ejecutar git: {e}"))?;
    child.stdin.take().ok_or("sin entrada de git")?.write_all(input).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Diff completo de la sesión frente a su commit base: commits del agente,
/// cambios sin commit y archivos nuevos (marcados con intent-to-add, que
/// solo toca el índice del worktree).
fn session_patch(session: &db::Session) -> CmdResult<(PathBuf, String, Vec<u8>)> {
    let (Some(wt), Some(base)) = (&session.worktree, &session.base_commit) else {
        return Err("esta sesión no está aislada en su propia rama".into());
    };
    let wt = PathBuf::from(wt);
    if !wt.is_dir() {
        return Err(format!("no se encuentra el worktree {}", wt.display()));
    }
    git(&wt, &["add", "-A", "-N"])?;
    let patch = git(&wt, &["diff", "--binary", base])?;
    Ok((wt, base.clone(), patch))
}

fn fingerprint(patch: &[u8]) -> String {
    let mut h = DefaultHasher::new();
    patch.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Comprueba la huella guardada sin preparar archivos ni modificar el índice.
pub fn integration_verified(s: &db::Session) -> CmdResult<bool> {
    let (Some(worktree), Some(base)) = (&s.worktree, &s.base_commit) else { return Ok(true) };
    let worktree = Path::new(worktree);
    if !worktree.is_dir() {
        return Ok(s.integrated.as_deref().is_some_and(|value| !value.starts_with("conflicts:")));
    }
    if !git(worktree, &["ls-files", "--others", "--exclude-standard", "-z"])?.is_empty() {
        return Ok(false);
    }
    let patch = git(worktree, &["diff", "--binary", base])?;
    Ok(patch.is_empty() || s.integrated.as_deref() == Some(fingerprint(&patch).as_str()))
}

fn integration_target(session: &db::Session) -> CmdResult<()> {
    let project = Path::new(&session.project);
    let expected = session.base.as_deref().ok_or("la sesión no tiene destino de integración")?;
    let current = match crate::pr::value(project, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        Ok(branch) => branch,
        Err(_) => {
            let head = crate::pr::value(project, &["rev-parse", "HEAD"])?;
            if session.base_commit.as_deref() == Some(&head) && head.get(..7) == Some(expected) {
                return Ok(());
            }
            head
        }
    };
    if current != expected {
        return Err(format!("Abre {expected} en el checkout del proyecto antes de integrar. Ahora está en {current}."));
    }
    Ok(())
}

/// Aplica el trabajo de la sesión al checkout principal. Devuelve los
/// archivos afectados y la huella del diff integrado.
pub fn integrate(session: &db::Session) -> CmdResult<(Vec<String>, String)> {
    integration_target(session)?;
    let (_, _, patch) = session_patch(session)?;
    if patch.is_empty() {
        return Err("la sesión no tiene cambios que integrar".into());
    }
    let fp = fingerprint(&patch);
    if session.integrated.as_deref() == Some(fp.as_str()) {
        return Err("estos cambios ya están integrados".into());
    }
    let project = Path::new(&session.project);
    let branch = session.branch.as_deref().unwrap_or("la rama de la sesión");
    if let Err(e) = git_stdin(project, &["apply", "--check", "--whitespace=nowarn", "-"], &patch) {
        return Err(format!(
            "no se puede integrar sin conflictos ({e}). No se ha aplicado nada: {branch} y su worktree se conservan. \
Integra antes los cambios pendientes del checkout principal o resuelve a mano."
        ));
    }
    let stat = git_stdin(project, &["apply", "--numstat", "-"], &patch)?;
    git_stdin(project, &["apply", "--whitespace=nowarn", "-"], &patch)?;
    let files = stat.lines().filter_map(|l| l.splitn(3, '\t').nth(2)).map(str::to_string).collect();
    Ok((files, fp))
}

/// Resultado de integrar con conflictos.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Merged {
    pub files: Vec<String>,
    /// Archivos con marcas de conflicto (o que no se pudieron fusionar).
    pub conflicts: Vec<String>,
}

// No seguir enlaces ni permitir rutas especiales durante la fusión manual.
// git apply ya comprueba las rutas; las operaciones std::fs necesitan la
// misma protección, tanto en el proyecto como en la copia de la sesión.
fn merge_path_safe(root: &Path, relative: &str) -> bool {
    let mut current = root.to_path_buf();
    for part in Path::new(relative).components() {
        let std::path::Component::Normal(name) = part else { return false };
        current.push(name);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => return false,
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return false,
            _ => {}
        }
    }
    !current.is_dir()
}

/// Integración a tres bandas, archivo por archivo, con `git merge-file`:
/// versión base, la del proyecto y la de la sesión. Lo que no choca se
/// aplica; lo que choca queda con marcas de conflicto para resolverlo en el
/// editor. No toca el índice del proyecto. Rama y worktree se conservan.
pub fn integrate_merging(session: &db::Session) -> CmdResult<(Merged, String)> {
    integration_target(session)?;
    let (wt, base, patch) = session_patch(session)?;
    if patch.is_empty() {
        return Err("la sesión no tiene cambios que integrar".into());
    }
    let project = Path::new(&session.project);
    let out = git(&wt, &["diff", "--name-status", "--no-renames", "-z", &base])?;
    let out = String::from_utf8_lossy(&out).into_owned();
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    let tmp = std::env::temp_dir().join(format!("filigranas-merge-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let (mut files, mut conflicts) = (Vec::new(), Vec::new());

    while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
        let (ours, theirs) = (project.join(path), wt.join(path));
        let base_text = git(&wt, &["show", &format!("{base}:{path}")]).ok();
        files.push(path.to_string());
        if !merge_path_safe(project, path) || !merge_path_safe(&wt, path) {
            conflicts.push(path.to_string());
            continue;
        }
        match status {
            "D" => {
                // Borrar solo si el proyecto no lo ha cambiado desde la base.
                match (std::fs::read(&ours).ok(), &base_text) {
                    (None, _) => {}
                    (Some(now), Some(b)) if now == *b => std::fs::remove_file(&ours).map_err(|e| e.to_string())?,
                    _ => conflicts.push(path.to_string()),
                }
            }
            _ => {
                let Ok(new) = std::fs::read(&theirs) else {
                    conflicts.push(path.to_string());
                    continue;
                };
                let Ok(now) = std::fs::read(&ours) else {
                    // Una eliminación local frente a una modificación es
                    // un conflicto: no resucitar ni sobrescribir el archivo.
                    if base_text.is_some() || ours.exists() {
                        conflicts.push(path.to_string());
                        continue;
                    }
                    if let Some(dir) = ours.parent() {
                        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                    }
                    std::fs::write(&ours, &new).map_err(|e| e.to_string())?;
                    continue;
                };
                if now == new || base_text.as_deref() == Some(new.as_slice()) {
                    continue; // ya igual, o la sesión no lo cambió de verdad
                }
                if base_text.as_deref() == Some(now.as_slice()) {
                    std::fs::write(&ours, &new).map_err(|e| e.to_string())?; // solo cambió en la sesión
                    continue;
                }
                let base_file = tmp.join("base");
                std::fs::write(&base_file, base_text.unwrap_or_default()).map_err(|e| e.to_string())?;
                let merged = Command::new("git")
                    .args(["merge-file", "-p", "-L", "proyecto", "-L", "base", "-L"])
                    .arg(session.branch.as_deref().unwrap_or("sesión"))
                    .arg(&ours)
                    .arg(&base_file)
                    .arg(&theirs)
                    .output()
                    .map_err(|e| format!("no se pudo ejecutar git: {e}"))?;
                match merged.status.code() {
                    Some(0) => std::fs::write(&ours, &merged.stdout).map_err(|e| e.to_string())?,
                    // merge-file usa 1..=127 para conflictos de texto;
                    // los errores (p. ej. binarios) llegan como 255.
                    Some(n) if (1..=127).contains(&n) => {
                        std::fs::write(&ours, &merged.stdout).map_err(|e| e.to_string())?;
                        conflicts.push(path.to_string());
                    }
                    _ => conflicts.push(path.to_string()), // binario u otro error: sin tocar
                }
            }
        }
    }
    // Conservar el bit ejecutable cuando lo cambió la sesión. Si la
    // sesión no lo cambió, respetar los permisos locales del proyecto.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in &files {
            if conflicts.contains(path) { continue; }
            let (ours, theirs) = (project.join(path), wt.join(path));
            if !ours.is_file() || !theirs.is_file() { continue; }
            let entry = git(&wt, &["ls-tree", &base, "--", path])?;
            let base_mode = String::from_utf8_lossy(&entry).split_whitespace().next().unwrap_or("").to_string();
            let mode = std::fs::metadata(&theirs).map_err(|e| e.to_string())?.permissions().mode();
            let executable = mode & 0o111 != 0;
            if base_mode.is_empty() || executable != (base_mode == "100755") {
                let mut permissions = std::fs::metadata(&ours).map_err(|e| e.to_string())?.permissions();
                permissions.set_mode((permissions.mode() & !0o111) | (mode & 0o111));
                std::fs::set_permissions(&ours, permissions).map_err(|e| e.to_string())?;
            }
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    // No autorizar la eliminación del worktree mientras haya trabajo
    // que no se pudo aplicar. Un reintento sin conflictos lo confirmará.
    let fp = if conflicts.is_empty() { fingerprint(&patch) } else { format!("conflicts:{}", fingerprint(&patch)) };
    Ok((Merged { files, conflicts }, fp))
}

/// Borra worktree y rama, solo si todo lo que contienen ya está integrado.
pub fn cleanup(session: &db::Session) -> CmdResult<()> {
    let (wt, _, patch) = session_patch(session)?;
    match &session.integrated {
        Some(fp) if *fp == fingerprint(&patch) => {}
        Some(fp) if fp.starts_with("conflicts:") => return Err("la integración dejó conflictos: confirma una integración sin conflictos antes de limpiar; se conserva la rama".into()),
        Some(_) => return Err("la sesión tiene cambios posteriores a la integración: intégralos antes de limpiar".into()),
        None if patch.is_empty() => {}
        None => return Err("la sesión tiene cambios sin integrar".into()),
    }
    let project = Path::new(&session.project);
    git(project, &["worktree", "remove", "--force", &wt.to_string_lossy()])?;
    if let Some(branch) = &session.branch {
        git(project, &["branch", "-D", branch])?;
    }
    Ok(())
}

// ── comandos ────────────────────────────────────────────────────────────

use tauri::{AppHandle, Emitter, State};

use crate::git::{diff_texts_at, status_since, DiffTexts, Status};
use crate::{err, AppState};

/// Sesión abierta o cerrada: las ramas pendientes son de sesiones cerradas.
fn any_session(state: &AppState, id: i64) -> CmdResult<db::Session> {
    db::session_any(&*state.db.lock().map_err(err)?, id).map_err(err)?.ok_or_else(|| "la sesión no existe".into())
}

fn isolated(state: &AppState, id: i64) -> CmdResult<(db::Session, PathBuf, String)> {
    let s = any_session(state, id)?;
    match (s.worktree.clone(), s.base_commit.clone()) {
        (Some(wt), Some(base)) => Ok((s, PathBuf::from(wt), base)),
        _ => Err("esta sesión no está aislada en su propia rama".into()),
    }
}

/// Cambios de la sesión frente al commit del que partió.
#[tauri::command]
pub fn session_changes(state: State<AppState>, id: i64) -> CmdResult<Status> {
    let (_, wt, base) = isolated(&state, id)?;
    status_since(&wt, &base)
}

#[tauri::command]
pub fn session_diff_texts(state: State<AppState>, id: i64, path: String, orig: Option<String>) -> CmdResult<DiffTexts> {
    let (_, wt, base) = isolated(&state, id)?;
    diff_texts_at(&wt, &base, &path, orig.as_deref())
}

/// Integra el trabajo de la sesión en el checkout principal.
#[tauri::command]
pub fn session_integrate(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<Vec<String>> {
    let _git = state.publication.try_lock().map_err(|_| "hay una operación Git en curso")?;
    let session = any_session(&state, id)?;
    let conn = state.db.lock().map_err(err)?;
    crate::work::git_idle(&conn, &session.project)?;
    if crate::runs::session_active(&conn, id).map_err(err)? {
        return Err("espera a que termine el turno antes de integrar la rama".into());
    }
    let (files, fp) = integrate(&session)?;
    db::set_session_integrated(&conn, id, Some(&fp)).map_err(err)?;
    drop(conn);
    let _ = app.emit("project-changed", ());
    Ok(files)
}

/// Integra fusionando a tres bandas; lo que choca queda marcado.
#[tauri::command]
pub fn session_integrate_merging(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<Merged> {
    let _git = state.publication.try_lock().map_err(|_| "hay una operación Git en curso")?;
    let session = any_session(&state, id)?;
    let conn = state.db.lock().map_err(err)?;
    crate::work::git_idle(&conn, &session.project)?;
    if crate::runs::session_active(&conn, id).map_err(err)? {
        return Err("espera a que termine el turno antes de integrar la rama".into());
    }
    let (merged, fp) = integrate_merging(&session)?;
    db::set_session_integrated(&conn, id, Some(&fp)).map_err(err)?;
    drop(conn);
    let _ = app.emit("project-changed", ());
    Ok(merged)
}

/// Borra rama y worktree ya integrados y cierra la sesión.
#[tauri::command]
pub fn session_cleanup(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    let session = any_session(&state, id)?;
    if crate::runs::session_active(&*state.db.lock().map_err(err)?, id).map_err(err)? {
        return Err("espera a que termine el turno antes de limpiar la rama".into());
    }
    cleanup(&session)?;
    state.claude.forget(id);
    state.acp.close(id)?;
    let conn = state.db.lock().map_err(err)?;
    if session.integrated.is_none() {
        db::set_session_integrated(&conn, id, Some("cleaned")).map_err(err)?;
    }
    db::close_session(&conn, id).map_err(err)?;
    drop(conn);
    let _ = app.emit("sessions-changed", serde_json::json!({ "project": session.project }));
    let _ = app.emit("project-changed", ());
    crate::tasks::changed(&app);
    Ok(())
}

/// Carpeta de trabajo para Larry o para publicar: el proyecto, o el
/// worktree de una de sus sesiones aisladas.
pub fn work_dir(state: &AppState, project: &str, session: Option<i64>) -> CmdResult<PathBuf> {
    let path = crate::workspace::project_path(&*state.db.lock().map_err(err)?, project)?;
    let Some(id) = session else { return Ok(PathBuf::from(path)) };
    let s = any_session(state, id)?;
    if s.project != path {
        return Err("la sesión no es de este proyecto".into());
    }
    let wt = PathBuf::from(s.cwd());
    if s.worktree.is_none() {
        let branch = crate::pr::value(&wt, &["branch", "--show-current"])?;
        if s.branch.as_deref().is_some_and(|expected| expected != branch) {
            return Err("este chat conserva una rama de trabajo anterior; abre su PR guardada o inicia otro chat para el trabajo actual".into());
        }
        if let Some(work) = crate::work::current(&*state.db.lock().map_err(err)?, &path)?.filter(|w| w.state != "finished") {
            if crate::pr::value(&wt, &["branch", "--show-current"])? != work.branch {
                return Err(format!("recupera la rama {} antes de continuar", work.branch));
            }
        }
    }
    if !wt.is_dir() {
        return Err(format!("no se encuentra el worktree {}", wt.display()));
    }
    Ok(wt)
}

/// Sesiones cerradas cuya rama y worktree siguen en disco.
#[tauri::command]
pub fn session_orphans(state: State<AppState>, project: String) -> CmdResult<Vec<db::Session>> {
    let conn = state.db.lock().map_err(err)?;
    let path = crate::workspace::project_path(&conn, &project)?;
    let list = db::orphans(&conn, &path).map_err(err)?;
    Ok(list.into_iter().filter(|s| s.worktree.as_deref().is_some_and(|w| Path::new(w).is_dir())).collect())
}

/// Reabre una sesión cerrada como pestaña; su conversación se reanuda.
#[tauri::command]
pub fn session_reopen(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<db::Session> {
    let s = db::reopen_session(&*state.db.lock().map_err(err)?, id, &crate::claude::NAMES).map_err(err)?.ok_or("la sesión no existe")?;
    let _ = app.emit("sessions-changed", serde_json::json!({ "project": s.project, "focus": s.id }));
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(project: &Path, iso: &Isolation) -> db::Session {
        db::Session {
            id: 7,
            project: project.to_string_lossy().into_owned(),
            engine: "claude".into(),
            name: "xavi".into(),
            provider_session: String::new(),
            effort: None,
            worktree: Some(iso.worktree.clone()),
            branch: Some(iso.branch.clone()),
            base: Some(iso.base.clone()),
            base_commit: Some(iso.base_commit.clone()),
            integrated: None,
            task: None,
            handoff_from: None,
            paused: None,
        }
    }

    #[test]
    fn isolate_integrate_and_cleanup() {
        let root = std::env::temp_dir().join(format!("filigranas-iso-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (project, data) = (root.join("proyecto"), root.join("datos"));
        std::fs::create_dir_all(&project).unwrap();
        let run = |args: &[&str]| git(&project, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        // Sin conversión de finales de línea: el resultado no depende de la configuración global (Windows).
        run(&["config", "core.autocrlf", "false"]);
        std::fs::write(project.join("a.txt"), "uno\n").unwrap();
        std::fs::write(project.join("b.txt"), "b\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "inicio"]);
        // Cambio sin commit en el principal: no viaja a la sesión.
        std::fs::write(project.join("b.txt"), "b local\n").unwrap();

        let iso = create(&data, &project, "sesión 1", 7).unwrap().unwrap();
        assert!(iso.main_dirty);
        assert_eq!((iso.branch.as_str(), iso.base.as_str()), ("ide/sesion-1-7", "main"));
        let wt = PathBuf::from(&iso.worktree);
        assert!(wt.starts_with(&data) && wt.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(wt.join("b.txt")).unwrap(), "b\n");

        // El agente cambia un archivo, crea otro y hace un commit.
        let mut s = session(&project, &iso);
        std::fs::write(wt.join("a.txt"), "uno\ndos\n").unwrap();
        git(&wt, &["commit", "-qam", "agente"]).unwrap();
        std::fs::write(wt.join("nuevo.txt"), "nuevo\n").unwrap();
        assert!(cleanup(&s).is_err(), "limpiar con cambios sin integrar");

        run(&["switch", "-qc", "otro-destino"]);
        assert!(integrate(&s).unwrap_err().contains("Abre main"));
        assert!(integrate_merging(&s).unwrap_err().contains("Abre main"));
        assert_eq!(std::fs::read_to_string(project.join("a.txt")).unwrap(), "uno\n");
        assert!(!project.join("nuevo.txt").exists());
        run(&["switch", "-q", "main"]);

        let (files, fp) = integrate(&s).unwrap();
        assert_eq!(files, vec!["a.txt", "nuevo.txt"]);
        assert_eq!(std::fs::read_to_string(project.join("a.txt")).unwrap(), "uno\ndos\n");
        assert_eq!(std::fs::read_to_string(project.join("nuevo.txt")).unwrap(), "nuevo\n");
        assert_eq!(std::fs::read_to_string(project.join("b.txt")).unwrap(), "b local\n", "respeta lo local");
        s.integrated = Some(fp);
        assert!(integrate(&s).is_err(), "integrar dos veces");

        // Un cambio posterior bloquea la limpieza hasta integrarlo.
        std::fs::write(wt.join("nuevo.txt"), "nuevo\nmás\n").unwrap();
        assert!(cleanup(&s).is_err());
        std::fs::write(wt.join("nuevo.txt"), "nuevo\n").unwrap();
        cleanup(&s).unwrap();
        assert!(!wt.exists());
        assert!(git(&project, &["rev-parse", "--verify", "--quiet", &iso.branch]).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn conflicts_apply_nothing() {
        let root = std::env::temp_dir().join(format!("filigranas-iso-c-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (project, data) = (root.join("p"), root.join("d"));
        std::fs::create_dir_all(&project).unwrap();
        let run = |args: &[&str]| git(&project, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(project.join("a.txt"), "uno\n").unwrap();
        std::fs::write(project.join("c.txt"), "c\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "inicio"]);
        let iso = create(&data, &project, "iniesta", 8).unwrap().unwrap();
        let wt = PathBuf::from(&iso.worktree);
        std::fs::write(wt.join("a.txt"), "agente\n").unwrap();
        std::fs::write(wt.join("c.txt"), "c agente\n").unwrap();
        // El usuario cambió la misma línea en el principal.
        std::fs::write(project.join("a.txt"), "usuario\n").unwrap();

        let err = integrate(&session(&project, &iso)).unwrap_err();
        assert!(err.contains("No se ha aplicado nada"), "{err}");
        assert_eq!(std::fs::read_to_string(project.join("a.txt")).unwrap(), "usuario\n");
        assert_eq!(std::fs::read_to_string(project.join("c.txt")).unwrap(), "c\n", "ni siquiera lo que no chocaba");
        assert!(wt.join("a.txt").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn merging_leaves_markers_only_where_it_clashes() {
        let root = std::env::temp_dir().join(format!("filigranas-iso-m-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (project, data) = (root.join("p"), root.join("d"));
        std::fs::create_dir_all(&project).unwrap();
        let run = |args: &[&str]| git(&project, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(project.join("a.txt"), "uno\ndos\ntres\n").unwrap();
        std::fs::write(project.join("c.txt"), "c\n").unwrap();
        std::fs::write(project.join("d.txt"), "d\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "inicio"]);
        let iso = create(&data, &project, "messi", 9).unwrap().unwrap();
        let wt = PathBuf::from(&iso.worktree);
        std::fs::write(wt.join("a.txt"), "uno\nDOS agente\ntres\n").unwrap();
        std::fs::write(wt.join("c.txt"), "c agente\n").unwrap();
        std::fs::remove_file(wt.join("d.txt")).unwrap();
        std::fs::write(wt.join("nuevo.txt"), "nuevo\n").unwrap();
        // El usuario cambió la misma línea de a.txt, sin hacer `git add`.
        std::fs::write(project.join("a.txt"), "uno\nDOS usuario\ntres\n").unwrap();

        let (m, _) = integrate_merging(&session(&project, &iso)).unwrap();
        assert_eq!(m.conflicts, vec!["a.txt"]);
        let a = std::fs::read_to_string(project.join("a.txt")).unwrap();
        assert!(a.contains("<<<<<<< proyecto") && a.contains("DOS usuario") && a.contains("DOS agente") && a.contains(">>>>>>> ide/messi-9"), "{a}");
        assert_eq!(std::fs::read_to_string(project.join("c.txt")).unwrap(), "c agente\n");
        assert_eq!(std::fs::read_to_string(project.join("nuevo.txt")).unwrap(), "nuevo\n");
        assert!(!project.join("d.txt").exists());
        // El índice del proyecto no se toca y el worktree sigue ahí.
        assert!(git(&project, &["diff", "--cached", "--name-only"]).unwrap().is_empty());
        assert!(wt.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn binary_merge_preserves_both_versions() {
        let root = std::env::temp_dir().join(format!("filigranas-iso-binary-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (project, data) = (root.join("p"), root.join("d"));
        std::fs::create_dir_all(&project).unwrap();
        for args in [vec!["init", "-q", "-b", "main"], vec!["config", "user.email", "t@t"], vec!["config", "user.name", "t"]] {
            git(&project, &args).unwrap();
        }
        std::fs::write(project.join("image.bin"), b"base\0data").unwrap();
        git(&project, &["add", "."]).unwrap();
        git(&project, &["commit", "-qm", "inicio"]).unwrap();
        let iso = create(&data, &project, "binary", 10).unwrap().unwrap();
        let wt = PathBuf::from(&iso.worktree);
        std::fs::write(wt.join("image.bin"), b"session\0data").unwrap();
        std::fs::write(project.join("image.bin"), b"project\0data").unwrap();
        let (merged, _) = integrate_merging(&session(&project, &iso)).unwrap();
        assert_eq!(merged.conflicts, vec!["image.bin"]);
        assert_eq!(std::fs::read(project.join("image.bin")).unwrap(), b"project\0data");
        assert_eq!(std::fs::read(wt.join("image.bin")).unwrap(), b"session\0data");
        std::fs::remove_dir_all(root).unwrap();
    }

    fn edge_fixture() -> (PathBuf, PathBuf, db::Session) {
        let root = std::env::temp_dir().join(format!("filigranas-edge-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        for args in [vec!["init", "-q", "-b", "main"], vec!["config", "user.email", "t@t"], vec!["config", "user.name", "t"]] {
            git(&project, &args).unwrap();
        }
        std::fs::write(project.join("a.txt"), "base\n").unwrap();
        git(&project, &["add", "."]).unwrap();
        git(&project, &["commit", "-qm", "base"]).unwrap();
        let iso = create(&root.join("data"), &project, "edge", 42).unwrap().unwrap();
        (root, PathBuf::from(&iso.worktree), session(&project, &iso))
    }

    #[test]
    fn merging_delete_modify_preserves_project_changes() {
        let (root, wt, s) = edge_fixture();
        let project = Path::new(&s.project);
        std::fs::remove_file(wt.join("a.txt")).unwrap();
        std::fs::write(project.join("a.txt"), "local\n").unwrap();
        let (merged, _) = integrate_merging(&s).unwrap();
        assert_eq!(merged.conflicts, vec!["a.txt"]);
        assert_eq!(std::fs::read_to_string(project.join("a.txt")).unwrap(), "local\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merging_modify_delete_preserves_project_deletion() {
        let (root, wt, s) = edge_fixture();
        let file = Path::new(&s.project).join("a.txt");
        std::fs::remove_file(&file).unwrap();
        std::fs::write(wt.join("a.txt"), "session\n").unwrap();
        let (merged, _) = integrate_merging(&s).unwrap();
        assert_eq!(merged.conflicts, vec!["a.txt"]);
        assert!(!file.exists(), "una integración conflictiva no debe deshacer el borrado local");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn merging_never_follows_project_symlinks() {
        let (root, wt, s) = edge_fixture();
        let outside = root.join("outside.txt");
        std::fs::write(&outside, "base\n").unwrap();
        let file = Path::new(&s.project).join("a.txt");
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&outside, &file).unwrap();
        std::fs::write(wt.join("a.txt"), "session\n").unwrap();
        let (merged, _) = integrate_merging(&s).unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "base\n", "no escribe fuera del proyecto");
        assert_eq!(merged.conflicts, vec!["a.txt"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn merging_rename_preserves_executable_mode() {
        use std::os::unix::fs::PermissionsExt;
        let (root, wt, s) = edge_fixture();
        std::fs::rename(wt.join("a.txt"), wt.join("run.sh")).unwrap();
        std::fs::set_permissions(wt.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let (merged, _) = integrate_merging(&s).unwrap();
        let project = Path::new(&s.project);
        assert!(merged.conflicts.is_empty());
        assert!(!project.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(project.join("run.sh")).unwrap(), "base\n");
        assert_ne!(std::fs::metadata(project.join("run.sh")).unwrap().permissions().mode() & 0o111, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unresolved_conflict_blocks_cleanup_until_retry_succeeds() {
        let (root, wt, mut s) = edge_fixture();
        let file = Path::new(&s.project).join("a.txt");
        std::fs::write(&file, "project\n").unwrap();
        std::fs::write(wt.join("a.txt"), "session\n").unwrap();
        let (merged, fp) = integrate_merging(&s).unwrap();
        assert_eq!(merged.conflicts, vec!["a.txt"]);
        s.integrated = Some(fp);
        assert!(cleanup(&s).is_err());
        assert!(wt.exists());
        std::fs::write(&file, "session\n").unwrap();
        let (merged, fp) = integrate_merging(&s).unwrap();
        assert!(merged.conflicts.is_empty());
        s.integrated = Some(fp);
        cleanup(&s).unwrap();
        assert!(!wt.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn merging_rejects_symlink_ancestors_and_session_links() {
        let (root, wt, s) = edge_fixture();
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let project = Path::new(&s.project);
        std::os::unix::fs::symlink(&outside, project.join("nested")).unwrap();
        std::fs::create_dir_all(wt.join("nested")).unwrap();
        std::fs::write(wt.join("nested/new.txt"), "session\n").unwrap();
        std::os::unix::fs::symlink(root.join("missing"), wt.join("link.txt")).unwrap();
        let (merged, _) = integrate_merging(&s).unwrap();
        assert!(merged.conflicts.contains(&"nested/new.txt".into()));
        assert!(merged.conflicts.contains(&"link.txt".into()));
        assert!(!outside.join("new.txt").exists());
        assert!(std::fs::symlink_metadata(project.join("link.txt")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repo_without_commits_is_not_isolated() {
        let root = std::env::temp_dir().join(format!("filigranas-iso-e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q"]).unwrap();
        assert!(create(&root.join("d"), &root, "puyol", 1).unwrap().is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn session_changes_include_committed_work() {
        let root = std::env::temp_dir().join(format!("filigranas-iso-s-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (project, data) = (root.join("p"), root.join("d"));
        std::fs::create_dir_all(&project).unwrap();
        let run = |args: &[&str]| git(&project, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(project.join("a.txt"), "a\n").unwrap();
        std::fs::write(project.join("b.txt"), "b\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "inicio"]);
        let iso = create(&data, &project, "pedri", 4).unwrap().unwrap();
        let wt = PathBuf::from(&iso.worktree);
        std::fs::write(wt.join("a.txt"), "a\nmás\n").unwrap();
        git(&wt, &["commit", "-qam", "commit de Larry"]).unwrap();
        std::fs::remove_file(wt.join("b.txt")).unwrap();
        std::fs::write(wt.join("c.txt"), "c\n").unwrap();
        let before = git(&wt, &["status", "--porcelain"]).unwrap();
        let st = status_since(&wt, &iso.base_commit).unwrap();
        let v = serde_json::to_value(&st).unwrap();
        let got: Vec<String> = v["changes"].as_array().unwrap().iter().map(|c| format!("{} {}", c["status"].as_str().unwrap(), c["path"].as_str().unwrap())).collect();
        assert_eq!(got, vec!["M a.txt", "D b.txt", "A c.txt"]);
        assert_eq!(git(&wt, &["status", "--porcelain"]).unwrap(), before);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
