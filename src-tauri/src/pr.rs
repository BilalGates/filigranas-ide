use std::path::Path;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::codex::login_path;
use crate::git::git;
use crate::{err, AppState, CmdResult};

// Publicar la rama y abrir la pull request en GitHub con la CLI `gh` y su
// autenticación local (PLAN.md §4). Es siempre una acción explícita del
// usuario, separada de Larry. El merge queda en sus manos.

fn run(repo: &Path, program: &str, args: &[&str]) -> CmdResult<String> {
    let mut cmd = Command::new(crate::codex::program(program));
    cmd.args(args).current_dir(repo).env("GIT_TERMINAL_PROMPT", "0").env("GH_PROMPT_DISABLED", "1");
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("no se pudo ejecutar {program}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn text(out: CmdResult<Vec<u8>>) -> String {
    out.map(|o| String::from_utf8_lossy(&o).trim().to_string()).unwrap_or_default()
}

/// Título y descripción a partir de los commits que lleva la rama. El
/// usuario los revisa antes de publicar.
fn compose(branch: &str, subjects: &[String]) -> (String, String) {
    let title = match subjects {
        [only] => only.clone(),
        _ => branch.rsplit('/').next().unwrap_or(branch).replace(['-', '_'], " "),
    };
    let mut body = String::from("## Cambios\n\n");
    for s in subjects {
        body.push_str(&format!("- {s}\n"));
    }
    body.push_str("\n## Pruebas\n\n- [ ] (describe cómo se ha comprobado)\n");
    (title, body)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    url: String,
    state: String,
    is_draft: bool,
    /// Resumen de checks: éxito, fallo y pendientes.
    checks: (u32, u32, u32),
}

fn pr_info(repo: &Path) -> Option<PrInfo> {
    let out = run(repo, "gh", &["pr", "view", "--json", "url,state,isDraft,statusCheckRollup"]).ok()?;
    let v: Value = serde_json::from_str(&out).ok()?;
    let mut checks = (0, 0, 0);
    for c in v["statusCheckRollup"].as_array().into_iter().flatten() {
        let verdict = c["conclusion"].as_str().or(c["state"].as_str()).unwrap_or("").to_uppercase();
        match verdict.as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => checks.0 += 1,
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" => checks.1 += 1,
            _ => checks.2 += 1,
        }
    }
    Some(PrInfo { url: v["url"].as_str()?.to_string(), state: v["state"].as_str().unwrap_or("").to_string(), is_draft: v["isDraft"] == Value::Bool(true), checks })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    branch: String,
    bases: Vec<String>,
    base: String,
    title: String,
    body: String,
    /// Commits que lleva la rama frente a la base elegida.
    commits: Vec<String>,
    /// Cambios sin commit (no viajan en la PR).
    dirty: bool,
    existing: Option<PrInfo>,
    /// Motivo por el que no se puede publicar, si lo hay.
    blocked: Option<String>,
}

fn draft(repo: &Path, base: Option<String>) -> CmdResult<Draft> {
    let branch = text(git(repo, &["branch", "--show-current"]));
    if branch.is_empty() {
        return Err("HEAD suelto: cambia a una rama para publicar".into());
    }
    let bases: Vec<String> = text(git(repo, &["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]))
        .lines()
        .filter(|b| *b != "origin/HEAD" && *b != "origin")
        .map(|b| b.trim_start_matches("origin/").to_string())
        .filter(|b| *b != branch)
        .collect();
    let default = text(git(repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim_start_matches("origin/").to_string();
    let base = base.filter(|b| bases.contains(b)).or_else(|| (!default.is_empty() && default != branch).then_some(default)).or_else(|| bases.first().cloned()).unwrap_or_default();
    let commits: Vec<String> = if base.is_empty() {
        Vec::new()
    } else {
        text(git(repo, &["log", "--reverse", "--format=%s", &format!("origin/{base}..HEAD")])).lines().map(str::to_string).collect()
    };
    let (title, body) = compose(&branch, &commits);
    let dirty = !text(git(repo, &["status", "--porcelain"])).is_empty();
    let blocked = if text(git(repo, &["remote"])).lines().all(|r| r != "origin") {
        Some("el repositorio no tiene remoto origin".to_string())
    } else if base.is_empty() {
        Some("no hay ramas remotas a las que proponer la PR".into())
    } else if commits.is_empty() {
        Some(format!("{branch} no tiene commits nuevos frente a {base}"))
    } else {
        None
    };
    Ok(Draft { branch, bases, base, title, body, commits, dirty, existing: pr_info(repo), blocked })
}

#[tauri::command]
pub async fn pr_draft(app: AppHandle, project: String, session: Option<i64>, base: Option<String>) -> CmdResult<Draft> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::isolate::work_dir(&app.state::<AppState>(), &project, session)?;
        draft(&dir, base)
    })
    .await
    .map_err(err)?
}

/// Publica la rama en origin y abre la PR. Devuelve su estado.
#[tauri::command]
pub async fn pr_publish(app: AppHandle, project: String, session: Option<i64>, base: String, title: String, body: String, draft_pr: bool) -> CmdResult<PrInfo> {
    if title.trim().is_empty() {
        return Err("la PR necesita título".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::isolate::work_dir(&app.state::<AppState>(), &project, session)?;
        let repo = dir.as_path();
        let d = draft(repo, Some(base.clone()))?;
        if let Some(why) = d.blocked {
            return Err(why);
        }
        if d.base != base {
            return Err(format!("la base «{base}» no existe en origin"));
        }
        run(repo, "git", &["push", "-u", "origin", &d.branch]).map_err(|e| format!("git push falló: {e}"))?;
        if d.existing.is_none() {
            let mut args = vec!["pr", "create", "--base", &base, "--head", &d.branch, "--title", &title, "--body", &body];
            if draft_pr {
                args.push("--draft");
            }
            run(repo, "gh", &args).map_err(|e| format!("gh pr create falló: {e}"))?;
        }
        let _ = app.emit("project-changed", ());
        pr_info(repo).ok_or_else(|| "la rama está publicada, pero gh no devuelve la PR".into())
    })
    .await
    .map_err(err)?
}

/// Estado actual de la PR de la rama (para refrescar los checks).
#[tauri::command]
pub async fn pr_status(app: AppHandle, project: String, session: Option<i64>) -> CmdResult<Option<PrInfo>> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::isolate::work_dir(&app.state::<AppState>(), &project, session)?;
        Ok(pr_info(&dir))
    })
    .await
    .map_err(err)?
}

/// Abre la PR en el navegador. Solo URLs de GitHub.
#[tauri::command]
pub fn open_pr_url(url: String) -> CmdResult<()> {
    if !url.starts_with("https://github.com/") || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err("solo se abren enlaces de GitHub".into());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(&url).status();
    #[cfg(windows)]
    let status = Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).status();
    #[cfg(not(any(target_os = "macos", windows)))]
    let status = Command::new("xdg-open").arg(&url).status();
    status.map(|_| ()).map_err(|e| format!("no se pudo abrir el navegador: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_and_body_from_commits() {
        let one = vec!["fix(cola): valida antes de encolar".to_string()];
        assert_eq!(compose("ide/xavi-3", &one).0, "fix(cola): valida antes de encolar");
        let many = vec!["feat: a".to_string(), "test: b".to_string()];
        let (title, body) = compose("feat/git-local", &many);
        assert_eq!(title, "git local");
        assert!(body.contains("- feat: a\n- test: b") && body.contains("## Pruebas"));
    }

    #[test]
    fn draft_blocks_without_remote() {
        let dir = std::env::temp_dir().join(format!("filigranas-pr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@t"], &["config", "user.name", "t"], &["commit", "-q", "--allow-empty", "-m", "i"]] {
            git(&dir, args).unwrap();
        }
        let d = draft(&dir, None).unwrap();
        assert_eq!(d.blocked.as_deref(), Some("el repositorio no tiene remoto origin"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Solo lectura sobre este repositorio (tiene origin): `cargo test -- --ignored real_draft`.
    #[test]
    #[ignore]
    fn real_draft_on_this_repo() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let d = draft(repo, None).unwrap();
        println!("{} → {} · {} commits · bloqueo: {:?} · PR: {:?}", d.branch, d.base, d.commits.len(), d.blocked, d.existing.as_ref().map(|p| &p.url));
        assert!(d.bases.contains(&"main".to_string()));
    }
}
