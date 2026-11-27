//! Limpieza automática segura post-merge (Fase F4).
//!
//! Reglas innegociables:
//! 1. Confirmar `state == MERGED` real en GitHub (nunca limpiar PRs `CLOSED` sin merge).
//! 2. Hacer `fetch --all --prune` antes de decidir.
//! 3. Verificar integración exacta (soportando merge normal, squash y rebase).
//! 4. Bloquear si hay commits locales nuevos, árbol sucio, worktree con cambios,
//!    sesiones/agentes activos o rama protegida (`main`, `master`, rama por defecto).
//! 5. Actualizar la rama base solo con `merge --ff-only`.
//! 6. Borrado remoto idempotente (sin error si GitHub ya borró la rama automáticamente).
//! 7. Nunca ejecutar `reset --hard`, `clean -fd` ni borrado forzado a ciegas.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::git::git;
use crate::pr;
use crate::{err, workspace::project_path, AppState, CmdResult};

#[derive(Clone, Debug)]
pub struct MergedPrSnapshot {
    pub number: u64,
    pub state: String,
    pub branch: String,
    pub base: String,
    pub head_oid: String,
    pub merged_at: Option<String>,
    pub merge_commit_oid: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCheck {
    pub ok: bool,
    pub code: String,
    pub label: String,
    pub detail: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreview {
    pub can_execute: bool,
    pub pr_number: u64,
    pub pr_state: String,
    pub branch: String,
    pub base: String,
    pub head_oid: String,
    pub merge_commit_oid: Option<String>,
    pub remote_branch_exists: bool,
    pub local_branch_exists: bool,
    pub worktree_path: Option<String>,
    pub checks: Vec<CleanupCheck>,
    pub planned_steps: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOutcome {
    pub executed_steps: Vec<String>,
    pub warnings: Vec<String>,
    pub archived_id: i64,
}

fn is_protected(branch: &str, base: &str, default_branch: &str, extra: &[String]) -> bool {
    matches!(branch, "main" | "master" | "HEAD")
        || branch == base
        || branch == default_branch
        || extra.iter().any(|p| p == branch)
}

fn worktree_for_branch(repo: &Path, branch: &str) -> Option<String> {
    let raw = git(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let target = format!("branch refs/heads/{branch}");
    let main_canon = std::fs::canonicalize(repo).ok();
    let mut cur_path: Option<String> = None;
    for line in String::from_utf8_lossy(&raw).lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur_path = Some(p.trim().to_string());
        } else if line.trim() == target {
            if let Some(p) = cur_path.clone() {
                let is_main = main_canon.as_ref().is_some_and(|m| std::fs::canonicalize(&p).ok().as_ref() == Some(m));
                if !is_main {
                    return Some(p);
                }
            }
        } else if line.trim().is_empty() {
            cur_path = None;
        }
    }
    None
}

fn dir_is_clean(dir: &Path) -> CmdResult<bool> {
    let out = git(dir, &["status", "--porcelain", "--untracked-files=all"])?;
    Ok(String::from_utf8_lossy(&out).trim().is_empty())
}

fn is_ancestor(repo: &Path, ancestor: &str, descendant: &str) -> bool {
    crate::git::git_output(repo, &["merge-base", "--is-ancestor", ancestor, descendant])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn evaluate_cleanup_plan(
    repo: &Path,
    snap: &MergedPrSnapshot,
    active_sessions: &[String],
    protected_extra: &[String],
) -> CmdResult<CleanupPreview> {
    let (default_branch, _) = crate::git::default_branch_info(repo);
    let mut checks = Vec::new();

    // 1. Estado MERGED confirmado por GitHub
    let is_merged = snap.state == "MERGED" && snap.merged_at.as_deref().is_some_and(|s| !s.is_empty());
    checks.push(CleanupCheck {
        ok: is_merged,
        code: "pr_merged".into(),
        label: "PR integrada en GitHub".into(),
        detail: if is_merged {
            format!("PR #{} confirmada como MERGED.", snap.number)
        } else {
            format!("La PR #{} está en estado {} (solo se limpian PRs realmente integradas).", snap.number, snap.state)
        },
    });

    // 2. Rama no protegida
    let protected = is_protected(&snap.branch, &snap.base, &default_branch, protected_extra);
    checks.push(CleanupCheck {
        ok: !protected,
        code: "not_protected".into(),
        label: "Rama no protegida".into(),
        detail: if !protected {
            format!("«{}» es una rama de trabajo eliminable.", snap.branch)
        } else {
            format!("«{}» es una rama protegida o base y nunca se eliminará.", snap.branch)
        },
    });

    // 3. Sin agentes / sesiones activas usando la rama
    let no_agents = active_sessions.is_empty();
    checks.push(CleanupCheck {
        ok: no_agents,
        code: "no_active_agents".into(),
        label: "Sin agentes activos en la rama".into(),
        detail: if no_agents {
            "Ninguna sesión de agente utiliza esta rama.".into()
        } else {
            format!("Sesiones activas en esta rama: {}.", active_sessions.join(", "))
        },
    });

    let local_ref = format!("refs/heads/{}", snap.branch);
    let remote_ref = format!("refs/remotes/origin/{}", snap.branch);
    let base_remote_ref = format!("refs/remotes/origin/{}", snap.base);
    let local_oid = pr::value(repo, &["rev-parse", "--verify", "--quiet", &local_ref]).ok().filter(|s| !s.is_empty());
    let remote_exists = pr::value(repo, &["rev-parse", "--verify", "--quiet", &remote_ref]).is_ok();
    let active_branch = pr::value(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().filter(|s| !s.is_empty());
    let worktree_path = worktree_for_branch(repo, &snap.branch);

    // 4. Verificación de integración exacta (merge normal, squash o rebase) y ausencia de commits locales posteriores
    let mut integration_ok = true;
    let mut integration_detail = "La rama local ya no existe.".to_string();
    if let Some(ref loid) = local_oid {
        let base_target = if pr::value(repo, &["rev-parse", "--verify", "--quiet", &base_remote_ref]).is_ok() {
            base_remote_ref.as_str()
        } else {
            snap.base.as_str()
        };
        let ancestor_of_base = is_ancestor(repo, loid, base_target);
        if ancestor_of_base {
            integration_detail = format!("El commit local {} es ancestro de {}.", &loid[..loid.len().min(7)], snap.base);
        } else {
            // Caso squash/rebase merge: la rama local NO debe tener commits posteriores al headRefOid integrado.
            let same_or_behind_pr_head = !snap.head_oid.is_empty()
                && (loid == &snap.head_oid || is_ancestor(repo, loid, &snap.head_oid));
            let merge_commit_present = snap
                .merge_commit_oid
                .as_deref()
                .map(|m| is_ancestor(repo, m, base_target))
                .unwrap_or(false);
            if is_merged && same_or_behind_pr_head && merge_commit_present {
                integration_detail = format!(
                    "Commit local {} coincide con el SHA integrado (squash/rebase en {}).",
                    &loid[..loid.len().min(7)],
                    snap.base
                );
            } else if !same_or_behind_pr_head {
                integration_ok = false;
                integration_detail = format!(
                    "La rama local ({}) tiene commits más nuevos que el SHA integrado ({}): limpieza bloqueada.",
                    &loid[..loid.len().min(7)],
                    &snap.head_oid[..snap.head_oid.len().min(7)]
                );
            } else {
                integration_ok = false;
                integration_detail = format!(
                    "No se pudo confirmar el commit de integración en origin/{}. Ejecuta fetch y vuelve a comprobar.",
                    snap.base
                );
            }
        }
    }
    checks.push(CleanupCheck {
        ok: integration_ok,
        code: "integration_verified".into(),
        label: "Integración verificada sin commits pendientes".into(),
        detail: integration_detail,
    });

    // 5. Árbol de trabajo limpio (tanto si la rama está activa en el repo como en un worktree)
    let mut tree_ok = true;
    let mut tree_detail = "Sin cambios sin commit en la rama.".to_string();
    if active_branch.as_deref() == Some(snap.branch.as_str()) && !dir_is_clean(repo)? {
        tree_ok = false;
        tree_detail = "Hay cambios sin commit o archivos sin seguimiento en el repositorio activo.".into();
    }
    if let Some(ref wt) = worktree_path {
        if Path::new(wt).exists() && !dir_is_clean(Path::new(wt))? {
            tree_ok = false;
            tree_detail = format!("El worktree {wt} tiene cambios sin commit.");
        }
    }
    checks.push(CleanupCheck {
        ok: tree_ok,
        code: "clean_worktree".into(),
        label: "Sin trabajo pendiente en disco".into(),
        detail: tree_detail,
    });

    let can_execute = checks.iter().all(|c| c.ok);
    let mut planned_steps = Vec::new();
    if active_branch.as_deref() == Some(snap.branch.as_str()) {
        planned_steps.push(format!("Cambiar a la rama base «{}» sin forzar", snap.base));
    }
    planned_steps.push(format!("Actualizar «{}» con avance rápido (--ff-only) desde origin/{}", snap.base, snap.base));
    if remote_exists {
        planned_steps.push(format!("Eliminar rama remota origin/{} (idempotente)", snap.branch));
    } else {
        planned_steps.push(format!("Rama remota origin/{} ya eliminada por GitHub", snap.branch));
    }
    if let Some(ref wt) = worktree_path {
        planned_steps.push(format!("Liberar worktree limpio {wt}"));
    }
    if local_oid.is_some() {
        planned_steps.push(format!("Eliminar rama local «{}» tras verificación", snap.branch));
    }
    planned_steps.push("Archivar entrega en el historial local".into());

    Ok(CleanupPreview {
        can_execute,
        pr_number: snap.number,
        pr_state: snap.state.clone(),
        branch: snap.branch.clone(),
        base: snap.base.clone(),
        head_oid: snap.head_oid.clone(),
        merge_commit_oid: snap.merge_commit_oid.clone(),
        remote_branch_exists: remote_exists,
        local_branch_exists: local_oid.is_some(),
        worktree_path,
        checks,
        planned_steps,
    })
}

pub fn execute_cleanup_plan(
    repo: &Path,
    snap: &MergedPrSnapshot,
    active_sessions: &[String],
    protected_extra: &[String],
) -> CmdResult<(Vec<String>, Vec<String>)> {
    let preview = evaluate_cleanup_plan(repo, snap, active_sessions, protected_extra)?;
    if !preview.can_execute {
        let reasons: Vec<String> = preview
            .checks
            .iter()
            .filter(|c| !c.ok)
            .map(|c| c.detail.clone())
            .collect();
        return Err(format!("limpieza post-merge bloqueada: {}", reasons.join(" · ")));
    }

    let mut steps = Vec::new();
    let mut warnings = Vec::new();

    // 1. Cambiar a rama base si la rama integrada está en checkout
    let active_branch = pr::value(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().filter(|s| !s.is_empty());
    if active_branch.as_deref() == Some(snap.branch.as_str()) {
        if pr::value(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", snap.base)]).is_ok() {
            pr::run(repo, "git", &["switch", "--no-guess", &snap.base])?;
            steps.push(format!("Cambiado a rama base «{}»", snap.base));
        } else {
            return Err(format!("la rama base local «{}» no existe", snap.base));
        }
    }

    // 2. Actualizar rama base local SOLO con --ff-only si es la rama activa y está limpia
    let now_active = pr::value(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().filter(|s| !s.is_empty());
    let base_remote = format!("origin/{}", snap.base);
    if pr::value(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{base_remote}")]).is_ok() {
        if now_active.as_deref() == Some(snap.base.as_str()) {
            if dir_is_clean(repo)? {
                match pr::run(repo, "git", &["merge", "--ff-only", &base_remote]) {
                    Ok(_) => steps.push(format!("Rama «{}» actualizada con --ff-only", snap.base)),
                    Err(e) => warnings.push(format!("No se pudo avanzar «{}» con --ff-only (sin forzar): {e}", snap.base)),
                }
            } else {
                warnings.push(format!("No se actualizó «{}» porque el árbol actual tiene cambios sin commit", snap.base));
            }
        } else {
            // Fast-forward sin checkout si base es ancestro de origin/base
            let local_base = format!("refs/heads/{}", snap.base);
            if is_ancestor(repo, &local_base, &format!("refs/remotes/{base_remote}")) {
                if let Ok(remote_oid) = pr::value(repo, &["rev-parse", &format!("refs/remotes/{base_remote}")]) {
                    if pr::run(repo, "git", &["update-ref", &local_base, &remote_oid]).is_ok() {
                        steps.push(format!("Referencia local «{}» avanzada a {base_remote}", snap.base));
                    }
                }
            } else {
                warnings.push(format!("La rama local «{}» diverge de {base_remote}; no se modificó.", snap.base));
            }
        }
    }

    // 3. Borrar rama remota de forma idempotente (ignora si GitHub ya la eliminó)
    if preview.remote_branch_exists {
        match pr::run(repo, "git", &["push", "origin", "--delete", "--", &snap.branch]) {
            Ok(_) => steps.push(format!("Rama remota origin/{} eliminada", snap.branch)),
            Err(e) => {
                // Si el remoto ya la había borrado, limpiamos la ref remota local tras verificar con ls-remote.
                let still_there = pr::run(repo, "git", &["ls-remote", "--heads", "origin", &snap.branch])
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(true);
                if !still_there {
                    let _ = pr::run(repo, "git", &["fetch", "--prune", "origin"]);
                    steps.push(format!("Rama remota origin/{} ya había sido eliminada en GitHub", snap.branch));
                } else {
                    warnings.push(format!("No se pudo borrar origin/{}: {e}", snap.branch));
                }
            }
        }
    } else {
        steps.push(format!("Rama remota origin/{} ya no existía", snap.branch));
    }

    // 4. Liberar worktree asociado (solo limpio, sin --force)
    if let Some(ref wt) = preview.worktree_path {
        pr::run(repo, "git", &["worktree", "remove", wt])?;
        steps.push(format!("Worktree {wt} liberado"));
    }

    // 5. Borrar rama local verificada
    if preview.local_branch_exists {
        match pr::run(repo, "git", &["branch", "-d", "--", &snap.branch]) {
            Ok(_) => steps.push(format!("Rama local «{}» eliminada", snap.branch)),
            Err(_) => {
                // En squash/rebase merge `git branch -d` no ve la ancestría directa, pero
                // `evaluate_cleanup_plan` ya verificó `MERGED` + `local_oid == head_oid` + `merge_commit`.
                pr::run(repo, "git", &["branch", "-D", "--", &snap.branch])?;
                steps.push(format!("Rama local «{}» eliminada (squash/rebase verificado)", snap.branch));
            }
        }
    }

    Ok((steps, warnings))
}

fn fetch_pr_snapshot(repo: &Path, number: u64) -> CmdResult<MergedPrSnapshot> {
    let slug = crate::github_pr::repo_slug(repo)?;
    let num_s = number.to_string();
    let raw = pr::run(
        repo,
        "gh",
        &["pr", "view", &num_s, "--repo", &slug, "--json", "number,state,headRefName,baseRefName,headRefOid,mergedAt,mergeCommit"],
    )?;
    let v: Value = serde_json::from_str(&raw).map_err(|_| "GitHub no devolvió los datos de la PR")?;
    Ok(MergedPrSnapshot {
        number,
        state: v["state"].as_str().unwrap_or("UNKNOWN").to_string(),
        branch: v["headRefName"].as_str().unwrap_or("").to_string(),
        base: v["baseRefName"].as_str().unwrap_or("main").to_string(),
        head_oid: v["headRefOid"].as_str().unwrap_or("").to_string(),
        merged_at: v["mergedAt"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        merge_commit_oid: v["mergeCommit"]["oid"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
    })
}

fn active_sessions_on_branch(state: &AppState, project: &str, branch: &str) -> CmdResult<Vec<String>> {
    let conn = state.db.lock().map_err(err)?;
    let sessions = crate::db::sessions(&conn, project).map_err(err)?;
    Ok(sessions
        .into_iter()
        .filter(|s| s.branch.as_deref() == Some(branch))
        .map(|s| s.name)
        .collect())
}

#[tauri::command]
pub async fn delivery_cleanup_preview(app: AppHandle, project: String, pr_number: u64) -> CmdResult<CleanupPreview> {
    crate::background_read(app, move |state| {
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        // Fetch seguro antes de evaluar el estado remoto.
        let _ = pr::run(dir, "git", &["fetch", "--all", "--prune"]);
        let snap = fetch_pr_snapshot(dir, pr_number)?;
        let active = active_sessions_on_branch(state, &dir_str, &snap.branch)?;
        evaluate_cleanup_plan(dir, &snap, &active, &[])
    })
    .await
}

#[tauri::command]
pub async fn delivery_cleanup_execute(app: AppHandle, project: String, pr_number: u64) -> CmdResult<CleanupOutcome> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.publication.try_lock().map_err(|_| "ya hay una operación Git en curso")?;
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        pr::run(dir, "git", &["fetch", "--all", "--prune"])?;
        let snap = fetch_pr_snapshot(dir, pr_number)?;
        let active = active_sessions_on_branch(&state, &dir_str, &snap.branch)?;
        let (executed_steps, warnings) = execute_cleanup_plan(dir, &snap, &active, &[])?;
        let notes = if warnings.is_empty() {
            Some(executed_steps.join(" · "))
        } else {
            Some(format!("{} · Avisos: {}", executed_steps.join(" · "), warnings.join(" · ")))
        };
        let archived_id = {
            let conn = state.db.lock().map_err(err)?;
            crate::delivery_auto::record_archive(
                &conn,
                &dir_str,
                Some(snap.number),
                &snap.branch,
                &snap.base,
                &snap.head_oid,
                snap.merge_commit_oid.as_deref(),
                notes.as_deref(),
            )?
        };
        let _ = app.emit("project-changed", ());
        crate::tasks::changed(&app);
        Ok(CleanupOutcome { executed_steps, warnings, archived_id })
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_repo_with_remote() -> (std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!("filigranas-postmerge-{}", uuid::Uuid::new_v4()));
        let remote = base.join("origin.git");
        let repo = base.join("repo");
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        let run = |d: &Path, args: &[&str]| git(d, args).unwrap();
        run(&remote, &["init", "--bare", "-q", "-b", "main"]);
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "user.email", "t@t"]);
        run(&repo, &["config", "user.name", "t"]);
        run(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
        std::fs::write(repo.join("base.txt"), "base\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-qm", "init"]);
        run(&repo, &["push", "-u", "origin", "main"]);
        (base, repo)
    }

    #[test]
    fn rejects_closed_unmerged_pr_and_protected_branch() {
        let (base, repo) = setup_repo_with_remote();
        let head = pr::value(&repo, &["rev-parse", "HEAD"]).unwrap();
        let closed = MergedPrSnapshot {
            number: 1,
            state: "CLOSED".into(),
            branch: "main".into(),
            base: "main".into(),
            head_oid: head,
            merged_at: None,
            merge_commit_oid: None,
        };
        let preview = evaluate_cleanup_plan(&repo, &closed, &[], &[]).unwrap();
        assert!(!preview.can_execute);
        assert!(preview.checks.iter().any(|c| c.code == "pr_merged" && !c.ok));
        assert!(preview.checks.iter().any(|c| c.code == "not_protected" && !c.ok));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn cleans_squash_merged_branch_and_fast_forwards_main_idempotently() {
        let (base, repo) = setup_repo_with_remote();
        let run = |args: &[&str]| git(&repo, args).unwrap();
        run(&["switch", "-c", "feat/squash"]);
        std::fs::write(repo.join("f.txt"), "uno\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "c1"]);
        std::fs::write(repo.join("f.txt"), "uno\ndos\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "c2"]);
        run(&["push", "-u", "origin", "feat/squash"]);
        let pr_head = pr::value(&repo, &["rev-parse", "HEAD"]).unwrap();

        // Simula squash merge en GitHub mediante otro clone temporal.
        let other = base.join("github-sim");
        git(&base, &["clone", "-q", base.join("origin.git").to_str().unwrap(), other.to_str().unwrap()]).unwrap();
        git(&other, &["config", "user.email", "gh@t"]).unwrap();
        git(&other, &["config", "user.name", "gh"]).unwrap();
        git(&other, &["merge", "--squash", "origin/feat/squash"]).unwrap();
        git(&other, &["commit", "-qm", "feat: squash (#12)"]).unwrap();
        let merge_oid = pr::value(&other, &["rev-parse", "HEAD"]).unwrap();
        git(&other, &["push", "origin", "main"]).unwrap();
        // Simula que GitHub ya borró la rama remota automáticamente.
        git(&other, &["push", "origin", "--delete", "feat/squash"]).unwrap();

        // Fetch en el repo local del usuario (que sigue en feat/squash).
        run(&["fetch", "--all", "--prune"]);

        let snap = MergedPrSnapshot {
            number: 12,
            state: "MERGED".into(),
            branch: "feat/squash".into(),
            base: "main".into(),
            head_oid: pr_head,
            merged_at: Some("2026-11-27T12:00:00Z".into()),
            merge_commit_oid: Some(merge_oid.clone()),
        };

        // Si el árbol está sucio, se bloquea sin borrar nada.
        std::fs::write(repo.join("dirty.txt"), "x").unwrap();
        assert!(!evaluate_cleanup_plan(&repo, &snap, &[], &[]).unwrap().can_execute);
        std::fs::remove_file(repo.join("dirty.txt")).unwrap();

        // Si hay un agente activo, se bloquea.
        assert!(!evaluate_cleanup_plan(&repo, &snap, &["Agente 1".into()], &[]).unwrap().can_execute);

        // Limpio y sin agentes: ejecuta correctamente.
        let (steps, warnings) = execute_cleanup_plan(&repo, &snap, &[], &[]).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(!steps.is_empty());
        assert_eq!(pr::value(&repo, &["branch", "--show-current"]).unwrap(), "main");
        assert_eq!(pr::value(&repo, &["rev-parse", "HEAD"]).unwrap(), merge_oid);
        assert!(pr::value(&repo, &["rev-parse", "--verify", "--quiet", "refs/heads/feat/squash"]).is_err());

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn blocks_cleanup_when_local_branch_has_newer_commits() {
        let (base, repo) = setup_repo_with_remote();
        let run = |args: &[&str]| git(&repo, args).unwrap();
        run(&["switch", "-c", "feat/extra"]);
        std::fs::write(repo.join("x.txt"), "1\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "c1"]);
        let merged_head = pr::value(&repo, &["rev-parse", "HEAD"]).unwrap();
        run(&["push", "-u", "origin", "feat/extra"]);

        // Commit local posterior que NO se subió ni se integró.
        std::fs::write(repo.join("x.txt"), "2\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "c2 local nuevo"]);

        let snap = MergedPrSnapshot {
            number: 99,
            state: "MERGED".into(),
            branch: "feat/extra".into(),
            base: "main".into(),
            head_oid: merged_head,
            merged_at: Some("2026-11-27T12:00:00Z".into()),
            merge_commit_oid: None,
        };
        let preview = evaluate_cleanup_plan(&repo, &snap, &[], &[]).unwrap();
        assert!(!preview.can_execute);
        assert!(preview.checks.iter().any(|c| c.code == "integration_verified" && !c.ok));
        std::fs::remove_dir_all(base).unwrap();
    }
}
