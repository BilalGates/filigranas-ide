//! Acciones de git que cambian el repositorio o hablan con el remoto:
//! fetch, pull, push, stash y deshacer el último commit. Cada una ejecuta
//! git en un hilo aparte (el remoto puede tardar) y devuelve lo que git
//! imprime, para que la interfaz lo muestre tal cual.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::approval::{Proof, Review};

use crate::{err, pr, AppState};

fn run(project: &str, args: &[&str]) -> Result<String, String> {
    if !Path::new(project).join(".git").exists() {
        return Err(format!("{project} no es un repositorio git"));
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(project)
        .args(args)
        // Sin credenciales en caché, git no debe quedarse esperando en un
        // terminal que no existe: falla y se muestra el error.
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("no se pudo ejecutar git: {e}"))?;
    let text = |b: &[u8]| String::from_utf8_lossy(b).trim().to_string();
    let (stdout, stderr) = (text(&out.stdout), text(&out.stderr));
    if out.status.success() {
        Ok(match (stdout.is_empty(), stderr.is_empty()) {
            (false, false) => format!("{stdout}\n{stderr}"),
            (false, true) => stdout,
            _ => stderr,
        })
    } else if stderr.is_empty() {
        Err(format!("git {} ha fallado", args.join(" ")))
    } else {
        Err(stderr)
    }
}

async fn spawn(project: String, args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run(&project, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Las mutaciones del checkout se serializan con Larry y la publicación.
async fn mutate(app: AppHandle, project: String, args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _git = state.publication.try_lock().map_err(|_| "hay una operación Git en curso")?;
        let conn = state.db.lock().map_err(err)?;
        let project = crate::workspace::project_path(&conn, &project)?;
        crate::work::git_idle(&conn, &project)?;
        drop(conn);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run(&project, &args)
    }).await.map_err(err)?
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[tauri::command]
pub async fn git_fetch(project: String) -> Result<String, String> {
    spawn(project, args(&["fetch", "--all", "--prune"])).await
}

/// Solo avance rápido: si las ramas han divergido, git lo dice y no mezcla.
#[tauri::command]
pub async fn git_pull(app: AppHandle, project: String) -> Result<String, String> {
    mutate(app, project, args(&["pull", "--ff-only"])).await
}

#[derive(Serialize)]
struct PushPlan {
    branch: String,
    head: String,
    remote: String,
    dest: String,
    url: String,
    set_upstream: bool,
}

impl PushPlan {
    fn read(path: &Path, set_upstream: bool) -> Result<Self, String> {
        let branch = pr::value(path, &["branch", "--show-current"])?;
        if branch.is_empty() { return Err("cambia a una rama antes de publicar".into()); }
        let head = pr::value(path, &["rev-parse", "HEAD"])?;
        let (remote, dest) = if set_upstream { ("origin".to_string(), branch.clone()) } else {
            let tracking = pr::value(path, &["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", &format!("refs/heads/{branch}")])?;
            let (remote, reference) = tracking.split_once('\0').ok_or("la rama carece de remoto de seguimiento")?;
            let dest = reference.strip_prefix("refs/heads/").filter(|s| !s.is_empty()).ok_or("la rama carece de destino de seguimiento")?;
            (remote.to_string(), dest.to_string())
        };
        let url = pr::push_url(path, &remote)?;
        Ok(Self { branch, head, remote, dest, url, set_upstream })
    }

    fn label(&self) -> String {
        pr::repository(&self.url).unwrap_or_else(|| self.remote.clone())
    }
}

#[tauri::command]
pub fn git_review_push(state: State<AppState>, project: String, set_upstream: bool) -> Result<Review, String> {
    let path = crate::isolate::work_dir(&state, &project, None)?;
    let plan = PushPlan::read(&path, set_upstream)?;
    state.approvals.prepare(("git_push", &path, &plan),
        format!("Publicar {} → {}/{} · {}", plan.branch, plan.label(), plan.dest, plan.head), &plan.head)
}

#[tauri::command]
pub async fn git_push(app: AppHandle, project: String, set_upstream: bool, proof: Proof) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.publication.try_lock().map_err(|_| "ya hay una operación de publicación en curso")?;
        let path = crate::isolate::work_dir(&state, &project, None)?;
        crate::work::git_idle(&*state.db.lock().map_err(err)?, &project)?;
        let plan = PushPlan::read(&path, set_upstream)?;
        if let Some(work) = crate::work::current(&*state.db.lock().map_err(err)?, &project)?.filter(|w| w.state != "finished") {
            if plan.dest != work.branch { return Err("publica la rama de trabajo; la entrega a main se realiza mediante PR".into()); }
        }
        state.approvals.consume(("git_push", &path, &plan), &proof)?;
        let exec = |program: &str, args: &[&str]| pr::run(&path, program, args);
        pr::push_exact(&exec, &plan.url, &plan.head, &plan.dest)?;
        if set_upstream {
            pr::configure_tracking(&path, &plan.branch, &plan.remote, &plan.dest, &plan.head)?;
        }
        Ok(format!("rama publicada en {}/{}", plan.label(), plan.dest))
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn git_stash(app: AppHandle, project: String, message: Option<String>) -> Result<String, String> {
    let mut list = args(&["stash", "push", "--include-untracked"]);
    if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
        list.push("-m".into());
        list.push(m);
    }
    mutate(app, project, list).await
}

#[tauri::command]
pub async fn git_stash_pop(app: AppHandle, project: String) -> Result<String, String> {
    mutate(app, project, args(&["stash", "pop"])).await
}

#[derive(Serialize)]
pub struct Stash {
    name: String,
    subject: String,
}

#[tauri::command]
pub async fn git_stash_list(project: String) -> Result<Vec<Stash>, String> {
    let out = spawn(project, args(&["stash", "list", "--format=%gd%x09%s"])).await?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(name, subject)| Stash { name: name.into(), subject: subject.into() })
        .collect())
}

/// Deshace el último commit sin tocar los archivos (`reset --soft HEAD~1`):
/// los cambios vuelven al índice. Se niega si el commit ya está publicado.
#[tauri::command]
pub async fn git_undo_commit(app: AppHandle, project: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _git = state.publication.try_lock().map_err(|_| "hay una operación Git en curso")?;
        let conn = state.db.lock().map_err(err)?;
        let project = crate::workspace::project_path(&conn, &project)?;
        crate::work::git_idle(&conn, &project)?;
        drop(conn);
        let published = run(&project, &["branch", "-r", "--contains", "HEAD"])?;
        if !published.trim().is_empty() {
            return Err("el último commit ya está en el remoto: deshacerlo reescribiría la historia publicada".into());
        }
        run(&project, &["reset", "--soft", "HEAD~1"])
    }).await.map_err(err)?
}

#[derive(Serialize)]
pub struct CommitFile {
    status: String,
    path: String,
    adds: Option<u32>,
    dels: Option<u32>,
}

#[derive(Serialize)]
pub struct CommitDetail {
    hash: String,
    author: String,
    date: String,
    body: String,
    files: Vec<CommitFile>,
}

fn commit_detail(project: &str, hash: &str) -> Result<CommitDetail, String> {
    if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("{hash} no es un commit"));
    }
    let head = run(project, &["show", "-s", "--no-color", "--format=%H%x1f%an%x1f%ar%x1f%B", hash])?;
    let mut parts = head.splitn(4, '\x1f');
    let mut next = || parts.next().unwrap_or("").trim().to_string();
    let (full, author, date, body) = (next(), next(), next(), next());
    // Mismo orden en ambas salidas: se emparejan por posición.
    let names = run(project, &["show", "--no-color", "--format=", "-M", "--name-status", hash])?;
    let nums = run(project, &["show", "--no-color", "--format=", "-M", "--numstat", hash])?;
    let mut nums = nums.lines().filter(|l| !l.trim().is_empty());
    let files = names
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            let mut counts = nums.next().unwrap_or("").split('\t');
            let mut count = || counts.next().and_then(|n| n.parse().ok());
            let (adds, dels) = (count(), count());
            CommitFile {
                status: fields[0].chars().next().map(String::from).unwrap_or_default(),
                path: fields.last().copied().unwrap_or("").to_string(),
                adds,
                dels,
            }
        })
        .collect();
    Ok(CommitDetail { hash: full, author, date, body, files })
}

/// Autor, fecha, mensaje completo y archivos de un commit del historial.
#[tauri::command]
pub async fn git_commit_detail(project: String, hash: String) -> Result<CommitDetail, String> {
    tauri::async_runtime::spawn_blocking(move || commit_detail(&project, &hash))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("filigranas-git-ops-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_str().unwrap();
        assert!(Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(&dir).status().unwrap().success());
        for args in [vec!["config", "user.email", "t@t"], vec!["config", "user.name", "t"]] {
            run(p, &args).unwrap();
        }
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        run(p, &["add", "."]).unwrap();
        run(p, &["commit", "-qm", "base"]).unwrap();
        dir
    }

    #[test]
    fn unavailable_remote_returns_error_and_preserves_work() {
        let dir = fixture();
        let p = dir.to_str().unwrap();
        run(p, &["remote", "add", "origin", dir.join("unavailable.git").to_str().unwrap()]).unwrap();
        let before = run(p, &["rev-parse", "HEAD"]).unwrap();
        std::fs::write(dir.join("a.txt"), "local\n").unwrap();
        assert!(run(p, &["fetch", "--all", "--prune"]).is_err());
        assert!(run(p, &["push", "--set-upstream", "origin", "HEAD"]).is_err());
        assert_eq!(run(p, &["rev-parse", "HEAD"]).unwrap(), before);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "local\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stash_roundtrip_includes_untracked_files() {
        let dir = fixture();
        let p = dir.to_str().unwrap();
        std::fs::write(dir.join("a.txt"), "local\n").unwrap();
        std::fs::write(dir.join("new.txt"), "new\n").unwrap();
        run(p, &["stash", "push", "--include-untracked", "-m", "qa"]).unwrap();
        assert!(run(p, &["status", "--porcelain"]).unwrap().is_empty());
        run(p, &["stash", "pop"]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "local\n");
        assert_eq!(std::fs::read_to_string(dir.join("new.txt")).unwrap(), "new\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn commit_detail_lists_files_and_counts() {
        let dir = fixture();
        let p = dir.to_str().unwrap();
        std::fs::write(dir.join("a.txt"), "base\nmore\n").unwrap();
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        run(p, &["add", "."]).unwrap();
        run(p, &["commit", "-qm", "segundo\n\ncuerpo"]).unwrap();
        let hash = run(p, &["rev-parse", "HEAD"]).unwrap();
        let d = commit_detail(p, &hash).unwrap();
        assert_eq!(d.hash, hash);
        assert!(d.body.starts_with("segundo"));
        let a = d.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((a.status.as_str(), a.adds, a.dels), ("M", Some(1), Some(0)));
        assert!(d.files.iter().any(|f| f.path == "b.txt" && f.status == "A"));
        assert!(commit_detail(p, "HEAD; rm").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
