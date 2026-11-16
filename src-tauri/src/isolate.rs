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

pub struct Isolation {
    pub worktree: String,
    pub branch: String,
    pub base: String,
    pub base_commit: String,
    /// El checkout principal tenía cambios sin commit (no se incluyen).
    pub main_dirty: bool,
}

/// Carpeta de worktrees de un proyecto dentro del directorio de datos.
fn worktree_dir(data_dir: &Path, project: &Path, name: &str, id: i64) -> PathBuf {
    let project_name = project.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "proyecto".into());
    data_dir.join("worktrees").join(project_name).join(format!("{name}-{id}"))
}

/// Crea rama y worktree para una sesión. `None` si el proyecto no tiene
/// commits todavía (no hay de dónde partir): la sesión usa el proyecto.
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
    let branch = format!("ide/{name}-{id}");
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

/// Aplica el trabajo de la sesión al checkout principal. Devuelve los
/// archivos afectados y la huella del diff integrado.
pub fn integrate(session: &db::Session) -> CmdResult<(Vec<String>, String)> {
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

/// Integración a tres bandas, archivo por archivo, con `git merge-file`:
/// versión base, la del proyecto y la de la sesión. Lo que no choca se
/// aplica; lo que choca queda con marcas de conflicto para resolverlo en el
/// editor. No toca el índice del proyecto. Rama y worktree se conservan.
pub fn integrate_merging(session: &db::Session) -> CmdResult<(Merged, String)> {
    let (wt, base, patch) = session_patch(session)?;
    if patch.is_empty() {
        return Err("la sesión no tiene cambios que integrar".into());
    }
    let project = Path::new(&session.project);
    let out = git(&wt, &["diff", "--name-status", "--no-renames", "-z", &base])?;
    let out = String::from_utf8_lossy(&out).into_owned();
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    let tmp = std::env::temp_dir().join(format!("filigranas-merge-{}-{}", std::process::id(), session.id));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let (mut files, mut conflicts) = (Vec::new(), Vec::new());

    while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
        let (ours, theirs) = (project.join(path), wt.join(path));
        let base_text = git(&wt, &["show", &format!("{base}:{path}")]).ok();
        files.push(path.to_string());
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
                    // No existe en el proyecto: se crea (o se recrea).
                    if let Some(dir) = ours.parent() {
                        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                    }
                    std::fs::write(&ours, &new).map_err(|e| e.to_string())?;
                    if base_text.is_some() {
                        conflicts.push(path.to_string()); // el proyecto lo había borrado
                    }
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
                    Some(n) if n > 0 => {
                        std::fs::write(&ours, &merged.stdout).map_err(|e| e.to_string())?;
                        conflicts.push(path.to_string());
                    }
                    _ => conflicts.push(path.to_string()), // binario u otro error: sin tocar
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    Ok((Merged { files, conflicts }, fingerprint(&patch)))
}

/// Borra worktree y rama, solo si todo lo que contienen ya está integrado.
pub fn cleanup(session: &db::Session) -> CmdResult<()> {
    let (wt, _, patch) = session_patch(session)?;
    match &session.integrated {
        Some(fp) if *fp == fingerprint(&patch) => {}
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
    // Archivos nuevos visibles en el recuento (solo toca el índice del worktree).
    git(&wt, &["add", "-A", "-N"])?;
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
    let session = any_session(&state, id)?;
    let (files, fp) = integrate(&session)?;
    db::set_session_integrated(&*state.db.lock().map_err(err)?, id, Some(&fp)).map_err(err)?;
    let _ = app.emit("project-changed", ());
    Ok(files)
}

/// Integra fusionando a tres bandas; lo que choca queda marcado.
#[tauri::command]
pub fn session_integrate_merging(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<Merged> {
    let session = any_session(&state, id)?;
    let (merged, fp) = integrate_merging(&session)?;
    db::set_session_integrated(&*state.db.lock().map_err(err)?, id, Some(&fp)).map_err(err)?;
    let _ = app.emit("project-changed", ());
    Ok(merged)
}

/// Borra rama y worktree ya integrados y cierra la sesión.
#[tauri::command]
pub fn session_cleanup(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    let session = any_session(&state, id)?;
    cleanup(&session)?;
    state.claude.forget(id);
    state.acp.close(id)?;
    db::close_session(&*state.db.lock().map_err(err)?, id).map_err(err)?;
    let _ = app.emit("sessions-changed", serde_json::json!({ "project": session.project }));
    let _ = app.emit("project-changed", ());
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
    let wt = PathBuf::from(s.worktree.ok_or("la sesión no tiene rama propia")?);
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
        std::fs::write(project.join("a.txt"), "uno\n").unwrap();
        std::fs::write(project.join("b.txt"), "b\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "inicio"]);
        // Cambio sin commit en el principal: no viaja a la sesión.
        std::fs::write(project.join("b.txt"), "b local\n").unwrap();

        let iso = create(&data, &project, "xavi", 7).unwrap().unwrap();
        assert!(iso.main_dirty);
        assert_eq!((iso.branch.as_str(), iso.base.as_str()), ("ide/xavi-7", "main"));
        let wt = PathBuf::from(&iso.worktree);
        assert!(wt.starts_with(&data) && wt.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(wt.join("b.txt")).unwrap(), "b\n");

        // El agente cambia un archivo, crea otro y hace un commit.
        let mut s = session(&project, &iso);
        std::fs::write(wt.join("a.txt"), "uno\ndos\n").unwrap();
        git(&wt, &["commit", "-qam", "agente"]).unwrap();
        std::fs::write(wt.join("nuevo.txt"), "nuevo\n").unwrap();
        assert!(cleanup(&s).is_err(), "limpiar con cambios sin integrar");

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
        assert!(git(&project, &["rev-parse", "--verify", "--quiet", "ide/xavi-7"]).is_err());
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
        git(&wt, &["add", "-A", "-N"]).unwrap();
        let st = status_since(&wt, &iso.base_commit).unwrap();
        let v = serde_json::to_value(&st).unwrap();
        let got: Vec<String> = v["changes"].as_array().unwrap().iter().map(|c| format!("{} {}", c["status"].as_str().unwrap(), c["path"].as_str().unwrap())).collect();
        assert_eq!(got, vec!["M a.txt", "D b.txt", "A c.txt"]);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
