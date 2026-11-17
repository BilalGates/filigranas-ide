//! Acciones de git que cambian el repositorio o hablan con el remoto:
//! fetch, pull, push, stash y deshacer el último commit. Cada una ejecuta
//! git en un hilo aparte (el remoto puede tardar) y devuelve lo que git
//! imprime, para que la interfaz lo muestre tal cual.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

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

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[tauri::command]
pub async fn git_fetch(project: String) -> Result<String, String> {
    spawn(project, args(&["fetch", "--all", "--prune"])).await
}

/// Solo avance rápido: si las ramas han divergido, git lo dice y no mezcla.
#[tauri::command]
pub async fn git_pull(project: String) -> Result<String, String> {
    spawn(project, args(&["pull", "--ff-only"])).await
}

#[tauri::command]
pub async fn git_push(project: String, set_upstream: bool) -> Result<String, String> {
    let list: &[&str] = if set_upstream { &["push", "--set-upstream", "origin", "HEAD"] } else { &["push"] };
    spawn(project, args(list)).await
}

#[tauri::command]
pub async fn git_stash(project: String, message: Option<String>) -> Result<String, String> {
    let mut list = args(&["stash", "push", "--include-untracked"]);
    if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
        list.push("-m".into());
        list.push(m);
    }
    spawn(project, list).await
}

#[tauri::command]
pub async fn git_stash_pop(project: String) -> Result<String, String> {
    spawn(project, args(&["stash", "pop"])).await
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
pub async fn git_undo_commit(project: String) -> Result<String, String> {
    let p = project.clone();
    let published = tauri::async_runtime::spawn_blocking(move || run(&p, &["branch", "-r", "--contains", "HEAD"]))
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if !published.trim().is_empty() {
        return Err("el último commit ya está en el remoto: deshacerlo reescribiría la historia publicada".into());
    }
    spawn(project, args(&["reset", "--soft", "HEAD~1"])).await
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
}
