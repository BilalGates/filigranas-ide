//! Gestión completa de Pull Requests, revisiones, hilos inline, checks y logs
//! de GitHub sin acoplamiento a la rama en checkout (`HEAD`).

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::approval::{Proof, Review};
use crate::git::git;
use crate::github::Publication;
use crate::pr;
use crate::{err, workspace::project_path, AppState, CmdResult};

fn now_ts() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

pub(crate) fn repo_slug(repo: &Path) -> CmdResult<String> {
    let fetch = pr::value(repo, &["remote", "get-url", "origin"])
        .map_err(|_| "el repositorio no tiene remoto origin")?;
    let slug = pr::repository(&fetch).ok_or("origin no apunta a un repositorio de github.com")?;
    if let Ok(push) = pr::push_url(repo, "origin") {
        if pr::repository(&push).as_deref() != Some(slug.as_str()) {
            return Err("origin usa repositorios distintos para lectura y publicación".into());
        }
    }
    Ok(slug)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckRunItem {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub workflow: Option<String>,
    pub url: Option<String>,
    pub job_id: Option<u64>,
    pub run_id: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullSummary {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub branch: String,
    pub base: String,
    pub head_oid: String,
    pub author: String,
    pub updated_at: String,
    pub merged_at: Option<String>,
    pub merge_commit_oid: Option<String>,
    pub review_decision: Option<String>,
    pub merge_state: String,
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_pending: u32,
    pub checks_state: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoPulls {
    pub repository: Option<String>,
    pub authenticated: bool,
    pub error: Option<String>,
    pub fetched_at: i64,
    pub pulls: Vec<PullSummary>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullCommit {
    pub oid: String,
    pub short_oid: String,
    pub headline: String,
    pub author: String,
    pub committed_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullComment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub kind: String,
    pub state: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadComment {
    pub id: String,
    pub database_id: Option<u64>,
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    pub line: Option<u32>,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub comments: Vec<ReviewThreadComment>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergeSettings {
    pub allow_merge: bool,
    pub allow_squash: bool,
    pub allow_rebase: bool,
    pub delete_branch_on_merge: bool,
    pub default_branch: String,
    pub can_push: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullDetail {
    pub repository: String,
    pub number: u64,
    pub title: String,
    pub body: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub branch: String,
    pub base: String,
    pub head_oid: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub merged_at: Option<String>,
    pub merge_commit_oid: Option<String>,
    pub mergeable: String,
    pub merge_state: String,
    pub review_decision: Option<String>,
    pub requested_reviewers: Vec<String>,
    pub checks: Vec<CheckRunItem>,
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_pending: u32,
    pub checks_state: String,
    pub files: Vec<PullFile>,
    pub commits: Vec<PullCommit>,
    pub comments: Vec<PullComment>,
    pub review_threads: Vec<ReviewThread>,
    pub merge_settings: MergeSettings,
    /// Indica si hacer merge sobre esta rama destino dispara un workflow de release.
    pub triggers_release: bool,
    /// Relación de la rama local homónima respecto al `headRefOid` de la PR.
    pub local_ahead: u32,
    pub local_behind: u32,
    pub local_exists: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckLog {
    pub content: String,
    pub truncated: bool,
    pub untrusted: bool,
}

/// Extrae `run_id` y `job_id` desde una URL de GitHub Actions
/// (`https://github.com/o/r/actions/runs/12345/job/67890`).
pub(crate) fn parse_actions_ids(url: &str) -> (Option<u64>, Option<u64>) {
    let mut run_id = None;
    let mut job_id = None;
    let parts: Vec<&str> = url.split('/').collect();
    for win in parts.windows(2) {
        if win[0] == "runs" && run_id.is_none() {
            run_id = win[1].split(['?', '#']).next().and_then(|s| s.parse().ok());
        } else if (win[0] == "job" || win[0] == "jobs") && job_id.is_none() {
            job_id = win[1].split(['?', '#']).next().and_then(|s| s.parse().ok());
        }
    }
    (run_id, job_id)
}

pub(crate) fn parse_checks(rollup: &Value) -> (Vec<CheckRunItem>, u32, u32, u32, String) {
    let mut items = Vec::new();
    let (mut passed, mut failed, mut pending) = (0u32, 0u32, 0u32);
    for c in rollup.as_array().into_iter().flatten() {
        let name = c["name"]
            .as_str()
            .or_else(|| c["context"].as_str())
            .unwrap_or("comprobación")
            .to_string();
        let status = c["status"]
            .as_str()
            .or_else(|| c["state"].as_str())
            .unwrap_or("UNKNOWN")
            .to_string();
        let conclusion = c["conclusion"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| c["state"].as_str().filter(|s| matches!(*s, "SUCCESS" | "FAILURE" | "ERROR")))
            .map(str::to_string);
        let workflow = c["workflowName"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
        let url = c["detailsUrl"]
            .as_str()
            .or_else(|| c["targetUrl"].as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let (run_id, job_id) = url.as_deref().map(parse_actions_ids).unwrap_or((None, None));
        let verdict = conclusion.as_deref().unwrap_or(status.as_str());
        match verdict {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => passed += 1,
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STALE" | "STARTUP_FAILURE" => failed += 1,
            _ => pending += 1,
        }
        items.push(CheckRunItem { name, status, conclusion, workflow, url, job_id, run_id });
    }
    let state = if failed > 0 {
        "failure"
    } else if pending > 0 {
        "pending"
    } else if passed > 0 {
        "success"
    } else {
        "unknown"
    }
    .to_string();
    (items, passed, failed, pending, state)
}

pub(crate) fn parse_pull_summary(v: &Value) -> Option<PullSummary> {
    let number = v["number"].as_u64().filter(|n| *n > 0)?;
    let (_, passed, failed, pending, checks_state) = parse_checks(&v["statusCheckRollup"]);
    Some(PullSummary {
        number,
        title: v["title"].as_str().unwrap_or("").to_string(),
        url: v["url"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("OPEN").to_string(),
        is_draft: v["isDraft"].as_bool().unwrap_or(false),
        branch: v["headRefName"].as_str().unwrap_or("").to_string(),
        base: v["baseRefName"].as_str().unwrap_or("").to_string(),
        head_oid: v["headRefOid"].as_str().unwrap_or("").to_string(),
        author: v["author"]["login"].as_str().unwrap_or("").to_string(),
        updated_at: v["updatedAt"].as_str().unwrap_or("").to_string(),
        merged_at: v["mergedAt"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        merge_commit_oid: v["mergeCommit"]["oid"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        review_decision: v["reviewDecision"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        merge_state: v["mergeStateStatus"].as_str().unwrap_or("UNKNOWN").to_string(),
        checks_passed: passed,
        checks_failed: failed,
        checks_pending: pending,
        checks_state,
    })
}

/// Redacta patrones obvios de credenciales/tokens en logs externos de CI.
pub(crate) fn redact_log(input: &str, max_bytes: usize) -> (String, bool) {
    let truncated = input.len() > max_bytes;
    let slice = if truncated {
        // Conserva el final del log donde suele estar el error real.
        let mut start = input.len().saturating_sub(max_bytes);
        while !input.is_char_boundary(start) && start < input.len() {
            start += 1;
        }
        &input[start..]
    } else {
        input
    };
    let mut out = String::with_capacity(slice.len());
    for line in slice.lines() {
        let lower = line.to_ascii_lowercase();
        let has_token = line.contains("ghp_")
            || line.contains("gho_")
            || line.contains("ghs_")
            || line.contains("github_pat_")
            || line.contains("AKIA")
            || line.contains("-----BEGIN ")
            || (lower.contains("authorization:") && lower.contains("bearer "));
        if has_token {
            out.push_str("[línea redactada por seguridad]\n");
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    (out, truncated)
}

fn fetch_review_threads(repo: &Path, slug: &str, number: u64) -> Vec<ReviewThread> {
    let Some((owner, name)) = slug.split_once('/') else { return Vec::new() };
    let query = r#"query($owner:String!,$name:String!,$num:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$num){
          reviewThreads(first:50){
            nodes{
              id path line isResolved isOutdated
              comments(first:20){
                nodes{ id databaseId body createdAt author{ login } }
              }
            }
          }
        }
      }
    }"#;
    let num_str = number.to_string();
    let Ok(raw) = pr::run(
        repo,
        "gh",
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={query}"),
            "-f",
            &format!("owner={owner}"),
            "-f",
            &format!("name={name}"),
            "-F",
            &format!("num={num_str}"),
        ],
    ) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return Vec::new() };
    let nodes = v["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"].as_array();
    let mut out = Vec::new();
    for node in nodes.into_iter().flatten() {
        let comments = node["comments"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| ReviewThreadComment {
                id: c["id"].as_str().unwrap_or("").to_string(),
                database_id: c["databaseId"].as_u64(),
                author: c["author"]["login"].as_str().unwrap_or("desconocido").to_string(),
                body: c["body"].as_str().unwrap_or("").to_string(),
                created_at: c["createdAt"].as_str().unwrap_or("").to_string(),
            })
            .collect();
        out.push(ReviewThread {
            id: node["id"].as_str().unwrap_or("").to_string(),
            path: node["path"].as_str().unwrap_or("").to_string(),
            line: node["line"].as_u64().and_then(|n| u32::try_from(n).ok()),
            is_resolved: node["isResolved"].as_bool().unwrap_or(false),
            is_outdated: node["isOutdated"].as_bool().unwrap_or(false),
            comments,
        });
    }
    out
}

fn fetch_merge_settings(repo: &Path, slug: &str) -> MergeSettings {
    let fallback_default = crate::git::default_branch_info(repo).0;
    let Ok(raw) = pr::run(repo, "gh", &["api", &format!("repos/{slug}")]) else {
        return MergeSettings {
            allow_merge: true,
            allow_squash: true,
            allow_rebase: true,
            delete_branch_on_merge: false,
            default_branch: fallback_default,
            can_push: true,
        };
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return MergeSettings {
            allow_merge: true,
            allow_squash: true,
            allow_rebase: true,
            delete_branch_on_merge: false,
            default_branch: fallback_default,
            can_push: true,
        };
    };
    MergeSettings {
        allow_merge: v["allow_merge_commit"].as_bool().unwrap_or(true),
        allow_squash: v["allow_squash_merge"].as_bool().unwrap_or(true),
        allow_rebase: v["allow_rebase_merge"].as_bool().unwrap_or(true),
        delete_branch_on_merge: v["delete_branch_on_merge"].as_bool().unwrap_or(false),
        default_branch: v["default_branch"].as_str().unwrap_or(&fallback_default).to_string(),
        can_push: v["permissions"]["push"].as_bool().unwrap_or(true)
            || v["permissions"]["admin"].as_bool().unwrap_or(false)
            || v["permissions"]["maintain"].as_bool().unwrap_or(false),
    }
}

fn has_release_workflow(repo: &Path) -> bool {
    repo.join(".github/workflows/release.yml").exists() || repo.join(".github/workflows/release.yaml").exists()
}

/// Lista las PRs del repositorio en una sola llamada a `gh` para alimentar el
/// explorador de ramas y el resumen de Entrega.
#[tauri::command]
pub async fn pr_list_repo(app: AppHandle, project: String) -> CmdResult<RepoPulls> {
    crate::background_read(app, move |state| {
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = match repo_slug(dir) {
            Ok(s) => s,
            Err(e) => {
                return Ok(RepoPulls {
                    repository: None,
                    authenticated: false,
                    error: Some(e),
                    fetched_at: now_ts(),
                    pulls: Vec::new(),
                });
            }
        };
        let fields = "number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeStateStatus,reviewDecision,author,updatedAt,mergedAt,mergeCommit,statusCheckRollup";
        match pr::run(dir, "gh", &["pr", "list", "--repo", &slug, "--state", "all", "--limit", "40", "--json", fields]) {
            Ok(raw) => {
                let arr: Value = serde_json::from_str(&raw).map_err(|_| "GitHub devolvió un listado de PRs no válido")?;
                let pulls: Vec<PullSummary> = arr.as_array().into_iter().flatten().filter_map(parse_pull_summary).collect();
                if let Ok(conn) = state.db.lock() {
                    for p in &pulls {
                        let cached = crate::github::Pull {
                            number: p.number,
                            url: p.url.clone(),
                            state: p.state.clone(),
                            is_draft: p.is_draft,
                            branch: p.branch.clone(),
                            base: p.base.clone(),
                            head: p.head_oid.clone(),
                            checks: (p.checks_passed, p.checks_failed, p.checks_pending),
                            checks_state: p.checks_state.clone(),
                            checks_known: true,
                            review: p.review_decision.clone(),
                            merge_state: p.merge_state.clone(),
                            observed_at: now_ts(),
                        };
                        let _ = crate::github::remember(&conn, &dir_str, &slug, &cached);
                    }
                }
                Ok(RepoPulls {
                    repository: Some(slug),
                    authenticated: true,
                    error: None,
                    fetched_at: now_ts(),
                    pulls,
                })
            }
            Err(e) => {
                let auth_err = e.contains("gh auth login") || e.contains("not logged into");
                Ok(RepoPulls {
                    repository: Some(slug),
                    authenticated: !auth_err,
                    error: Some(e),
                    fetched_at: now_ts(),
                    pulls: Vec::new(),
                })
            }
        }
    })
    .await
}

/// Detalle completo de una PR concreta, independientemente de qué rama esté en checkout.
#[tauri::command]
pub async fn pr_detail(app: AppHandle, project: String, number: u64) -> CmdResult<PullDetail> {
    crate::background_read(app, move |state| {
        if number == 0 {
            return Err("número de Pull Request no válido".into());
        }
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = repo_slug(dir)?;
        let num_str = number.to_string();
        let fields = "number,title,body,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,author,createdAt,updatedAt,mergedAt,mergeCommit,commits,files,comments,reviews,reviewRequests,statusCheckRollup";
        let raw = pr::run(dir, "gh", &["pr", "view", &num_str, "--repo", &slug, "--json", fields])?;
        let v: Value = serde_json::from_str(&raw).map_err(|_| "GitHub devolvió un detalle de PR no válido")?;

        let (checks, passed, failed, pending, checks_state) = parse_checks(&v["statusCheckRollup"]);
        let files = v["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| {
                Some(PullFile {
                    path: f["path"].as_str()?.to_string(),
                    additions: f["additions"].as_u64().unwrap_or(0) as u32,
                    deletions: f["deletions"].as_u64().unwrap_or(0) as u32,
                })
            })
            .collect();
        let commits = v["commits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| {
                let oid = c["oid"].as_str()?.to_string();
                let short_oid: String = oid.chars().take(7).collect();
                let author = c["authors"]
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(|a| a["login"].as_str().or_else(|| a["name"].as_str()))
                    .unwrap_or("")
                    .to_string();
                Some(PullCommit {
                    oid,
                    short_oid,
                    headline: c["messageHeadline"].as_str().unwrap_or("").to_string(),
                    author,
                    committed_at: c["committedDate"].as_str().unwrap_or("").to_string(),
                })
            })
            .collect();

        let mut comments = Vec::new();
        for c in v["comments"].as_array().into_iter().flatten() {
            comments.push(PullComment {
                id: c["id"].as_str().unwrap_or("").to_string(),
                author: c["author"]["login"].as_str().unwrap_or("").to_string(),
                body: c["body"].as_str().unwrap_or("").to_string(),
                created_at: c["createdAt"].as_str().unwrap_or("").to_string(),
                kind: "comment".into(),
                state: None,
            });
        }
        for r in v["reviews"].as_array().into_iter().flatten() {
            let body = r["body"].as_str().unwrap_or("").trim();
            let state = r["state"].as_str().map(str::to_string);
            if body.is_empty() && state.as_deref() == Some("COMMENTED") {
                continue;
            }
            comments.push(PullComment {
                id: r["id"].as_str().unwrap_or("").to_string(),
                author: r["author"]["login"].as_str().unwrap_or("").to_string(),
                body: body.to_string(),
                created_at: r["submittedAt"].as_str().unwrap_or("").to_string(),
                kind: "review".into(),
                state,
            });
        }
        comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));

        let requested_reviewers = v["reviewRequests"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| r["login"].as_str().or_else(|| r["name"].as_str()).map(str::to_string))
            .collect();

        let branch = v["headRefName"].as_str().unwrap_or("").to_string();
        let base = v["baseRefName"].as_str().unwrap_or("").to_string();
        let head_oid = v["headRefOid"].as_str().unwrap_or("").to_string();

        let (local_exists, local_ahead, local_behind) = if !branch.is_empty()
            && git(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
        {
            if !head_oid.is_empty() && git(dir, &["cat-file", "-e", &format!("{head_oid}^{{commit}}")]).is_ok() {
                let out = git(dir, &["rev-list", "--left-right", "--count", &format!("{head_oid}...refs/heads/{branch}")])
                    .map(|b| String::from_utf8_lossy(&b).trim().to_string())
                    .unwrap_or_default();
                let mut parts = out.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
                let behind = parts.next().unwrap_or(0);
                let ahead = parts.next().unwrap_or(0);
                (true, ahead, behind)
            } else {
                (true, 0, 0)
            }
        } else {
            (false, 0, 0)
        };

        let review_threads = fetch_review_threads(dir, &slug, number);
        let merge_settings = fetch_merge_settings(dir, &slug);
        let triggers_release = base == merge_settings.default_branch && has_release_workflow(dir);

        Ok(PullDetail {
            repository: slug,
            number,
            title: v["title"].as_str().unwrap_or("").to_string(),
            body: v["body"].as_str().unwrap_or("").to_string(),
            url: v["url"].as_str().unwrap_or("").to_string(),
            state: v["state"].as_str().unwrap_or("OPEN").to_string(),
            is_draft: v["isDraft"].as_bool().unwrap_or(false),
            branch,
            base,
            head_oid,
            author: v["author"]["login"].as_str().unwrap_or("").to_string(),
            created_at: v["createdAt"].as_str().unwrap_or("").to_string(),
            updated_at: v["updatedAt"].as_str().unwrap_or("").to_string(),
            merged_at: v["mergedAt"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            merge_commit_oid: v["mergeCommit"]["oid"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            mergeable: v["mergeable"].as_str().unwrap_or("UNKNOWN").to_string(),
            merge_state: v["mergeStateStatus"].as_str().unwrap_or("UNKNOWN").to_string(),
            review_decision: v["reviewDecision"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            requested_reviewers,
            checks,
            checks_passed: passed,
            checks_failed: failed,
            checks_pending: pending,
            checks_state,
            files,
            commits,
            comments,
            review_threads,
            merge_settings,
            triggers_release,
            local_ahead,
            local_behind,
            local_exists,
        })
    })
    .await
}

#[derive(Serialize)]
struct BranchPrPlan {
    repository: String,
    branch: String,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: bool,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pr_review_create_for_branch(
    app: AppHandle,
    project: String,
    branch: String,
    base: String,
    title: String,
    body: String,
    draft: bool,
) -> CmdResult<Review> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let branch = crate::git::valid_ref(&branch)?.to_string();
        let base = crate::git::valid_ref(&base)?.to_string();
        if branch == base {
            return Err("la rama de origen y la rama base no pueden ser la misma".into());
        }
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("el título de la Pull Request no puede estar vacío".into());
        }
        let slug = repo_slug(dir)?;
        let head = pr::value(dir, &["rev-parse", "--verify", &format!("refs/heads/{branch}")])
            .or_else(|_| pr::value(dir, &["rev-parse", "--verify", &format!("refs/remotes/origin/{branch}")]))
            .map_err(|_| format!("no se encontró la rama «{branch}»"))?;
        let plan = BranchPrPlan { repository: slug.clone(), branch: branch.clone(), base: base.clone(), head: head.clone(), title, body, draft };
        state.approvals.prepare(
            ("pr_create_for_branch", &dir_str, &plan),
            format!("Crear PR en {slug}: {branch} → {base} · {}", &head[..head.len().min(7)]),
            &head,
        )
    })
    .await
    .map_err(err)?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pr_create_for_branch(
    app: AppHandle,
    project: String,
    branch: String,
    base: String,
    title: String,
    body: String,
    draft: bool,
    proof: Proof,
) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.publication.try_lock().map_err(|_| "ya hay una operación de publicación en curso")?;
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let branch = crate::git::valid_ref(&branch)?.to_string();
        let base = crate::git::valid_ref(&base)?.to_string();
        let title = title.trim().to_string();
        let slug = repo_slug(dir)?;
        let has_local = pr::value(dir, &["rev-parse", "--verify", &format!("refs/heads/{branch}")]).ok();
        let head = has_local
            .clone()
            .or_else(|| pr::value(dir, &["rev-parse", "--verify", &format!("refs/remotes/origin/{branch}")]).ok())
            .ok_or_else(|| format!("no se encontró la rama «{branch}»"))?;
        let plan = BranchPrPlan {
            repository: slug.clone(),
            branch: branch.clone(),
            base: base.clone(),
            head: head.clone(),
            title: title.clone(),
            body: body.clone(),
            draft,
        };
        state.approvals.consume(("pr_create_for_branch", &dir_str, &plan), &proof)?;

        if has_local.is_some() {
            let push_url = pr::push_url(dir, "origin")?;
            let exec = |program: &str, args: &[&str]| pr::run(dir, program, args);
            pr::push_exact(&exec, &push_url, &head, &branch)?;
            let _ = pr::configure_tracking(dir, &branch, "origin", &branch, &head);
        }

        let journal = Publication { project: &dir_str, repository: &slug, branch: &branch, base: &base, oid: &head };
        if let Ok(conn) = state.db.lock() {
            let _ = journal.set_pending(&conn, true);
        }

        let mut args = vec!["pr", "create", "--repo", &slug, "--head", &branch, "--base", &base, "--title", &title, "--body", &body];
        if draft {
            args.push("--draft");
        }
        let created_url = pr::run(dir, "gh", &args)?;
        if let Ok(conn) = state.db.lock() {
            let _ = journal.set_pending(&conn, false);
        }
        let _ = app.emit("project-changed", ());
        Ok(created_url.trim().to_string())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pr_update(app: AppHandle, project: String, number: u64, title: Option<String>, body: Option<String>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = repo_slug(dir)?;
        let num = number.to_string();
        let mut args: Vec<String> = vec!["pr".into(), "edit".into(), num, "--repo".into(), slug];
        if let Some(t) = title.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            args.push("--title".into());
            args.push(t);
        }
        if let Some(b) = body {
            args.push("--body".into());
            args.push(b);
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        pr::run(dir, "gh", &refs)?;
        let _ = app.emit("project-changed", ());
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pr_set_draft(app: AppHandle, project: String, number: u64, draft: bool) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = repo_slug(dir)?;
        let num = number.to_string();
        let mut args = vec!["pr", "ready", &num, "--repo", &slug];
        if draft {
            args.push("--undo");
        }
        pr::run(dir, "gh", &args)?;
        let _ = app.emit("project-changed", ());
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pr_comment(app: AppHandle, project: String, number: u64, body: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let body = body.trim().to_string();
        if body.is_empty() {
            return Err("el comentario no puede estar vacío".into());
        }
        let state = app.state::<AppState>();
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = repo_slug(dir)?;
        let num = number.to_string();
        pr::run(dir, "gh", &["pr", "comment", &num, "--repo", &slug, "--body", &body])?;
        let _ = app.emit("project-changed", ());
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pr_reply_thread(app: AppHandle, project: String, number: u64, comment_id: u64, body: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let body = body.trim().to_string();
        if body.is_empty() {
            return Err("la respuesta no puede estar vacía".into());
        }
        let state = app.state::<AppState>();
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = repo_slug(dir)?;
        let endpoint = format!("repos/{slug}/pulls/{number}/comments/{comment_id}/replies");
        pr::run(dir, "gh", &["api", "-X", "POST", &endpoint, "-f", &format!("body={body}")])?;
        let _ = app.emit("project-changed", ());
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pr_request_reviewers(app: AppHandle, project: String, number: u64, reviewers: Vec<String>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean: Vec<String> = reviewers.into_iter().map(|r| r.trim().trim_start_matches('@').to_string()).filter(|r| !r.is_empty()).collect();
        if clean.is_empty() {
            return Err("indica al menos un revisor".into());
        }
        let state = app.state::<AppState>();
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = repo_slug(dir)?;
        let num = number.to_string();
        let joined = clean.join(",");
        pr::run(dir, "gh", &["pr", "edit", &num, "--repo", &slug, "--add-reviewer", &joined])?;
        let _ = app.emit("project-changed", ());
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pr_set_state(app: AppHandle, project: String, number: u64, action: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let cmd = match action.as_str() {
            "close" => "close",
            "reopen" => "reopen",
            _ => return Err("acción no válida (usa close o reopen)".into()),
        };
        let state = app.state::<AppState>();
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = repo_slug(dir)?;
        let num = number.to_string();
        pr::run(dir, "gh", &["pr", cmd, &num, "--repo", &slug])?;
        let _ = app.emit("project-changed", ());
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pr_rerun_checks(app: AppHandle, project: String, run_id: u64, failed_only: bool) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = repo_slug(dir)?;
        let rid = run_id.to_string();
        let mut args = vec!["run", "rerun", &rid, "--repo", &slug];
        if failed_only {
            args.push("--failed");
        }
        let out = pr::run(dir, "gh", &args)?;
        let _ = app.emit("project-changed", ());
        Ok(out.trim().to_string())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pr_check_log(app: AppHandle, project: String, job_id: Option<u64>, run_id: Option<u64>) -> CmdResult<CheckLog> {
    crate::background_read(app, move |state| {
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = repo_slug(dir)?;
        let raw = if let Some(jid) = job_id {
            pr::run(dir, "gh", &["api", &format!("repos/{slug}/actions/jobs/{jid}/logs")])?
        } else if let Some(rid) = run_id {
            let rid_s = rid.to_string();
            pr::run(dir, "gh", &["run", "view", &rid_s, "--repo", &slug, "--log-failed"])?
        } else {
            return Err("se necesita jobId o runId para consultar el log de CI".into());
        };
        let (content, truncated) = redact_log(&raw, 120 * 1024);
        Ok(CheckLog { content, truncated, untrusted: true })
    })
    .await
}

#[derive(Serialize)]
struct MergeByNumberPlan {
    repository: String,
    number: u64,
    head_oid: String,
    base: String,
    method: String,
}

fn validate_merge_method(method: &str) -> CmdResult<&'static str> {
    match method {
        "merge" => Ok("merge"),
        "squash" => Ok("squash"),
        "rebase" => Ok("rebase"),
        _ => Err("método de integración no válido (usa merge, squash o rebase)".into()),
    }
}

#[tauri::command]
pub async fn pr_review_merge_number(app: AppHandle, project: String, number: u64, method: String) -> CmdResult<Review> {
    tauri::async_runtime::spawn_blocking(move || {
        let method = validate_merge_method(&method)?;
        let state = app.state::<AppState>();
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = repo_slug(dir)?;
        let num_s = number.to_string();
        let raw = pr::run(dir, "gh", &["pr", "view", &num_s, "--repo", &slug, "--json", "state,isDraft,headRefOid,baseRefName,mergeStateStatus"])?;
        let v: Value = serde_json::from_str(&raw).map_err(|_| "GitHub no devolvió el estado de la PR")?;
        if v["state"].as_str() != Some("OPEN") {
            return Err("la Pull Request no está abierta".into());
        }
        if v["isDraft"].as_bool().unwrap_or(false) {
            return Err("marca la PR como lista para revisión antes de integrarla".into());
        }
        let head_oid = v["headRefOid"].as_str().filter(|s| !s.is_empty()).ok_or("falta headRefOid")?.to_string();
        let base = v["baseRefName"].as_str().unwrap_or("main").to_string();
        let release_note = if base == crate::git::default_branch_info(dir).0 && has_release_workflow(dir) {
            " · Atención: integrará en rama de publicación automática"
        } else {
            ""
        };
        let plan = MergeByNumberPlan { repository: slug.clone(), number, head_oid: head_oid.clone(), base: base.clone(), method: method.into() };
        state.approvals.prepare(
            ("pr_merge_number", &dir_str, &plan),
            format!("Integrar PR #{number} ({method}) → {base} · {}{release_note}", &head_oid[..head_oid.len().min(7)]),
            &head_oid,
        )
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pr_merge_number(app: AppHandle, project: String, number: u64, method: String, proof: Proof) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let method = validate_merge_method(&method)?;
        let state = app.state::<AppState>();
        let _gate = state.publication.try_lock().map_err(|_| "ya hay una operación de publicación en curso")?;
        let dir_str = project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = Path::new(&dir_str);
        let slug = repo_slug(dir)?;
        let num_s = number.to_string();
        let raw = pr::run(dir, "gh", &["pr", "view", &num_s, "--repo", &slug, "--json", "state,isDraft,headRefOid,baseRefName"])?;
        let v: Value = serde_json::from_str(&raw).map_err(|_| "GitHub no devolvió el estado de la PR")?;
        let head_oid = v["headRefOid"].as_str().filter(|s| !s.is_empty()).ok_or("falta headRefOid")?.to_string();
        let base = v["baseRefName"].as_str().unwrap_or("main").to_string();
        let plan = MergeByNumberPlan { repository: slug.clone(), number, head_oid: head_oid.clone(), base, method: method.into() };
        state.approvals.consume(("pr_merge_number", &dir_str, &plan), &proof)?;

        let endpoint = format!("repos/{slug}/pulls/{number}/merge");
        let resp = pr::run(
            dir,
            "gh",
            &[
                "api",
                "-X",
                "PUT",
                &endpoint,
                "-f",
                &format!("sha={head_oid}"),
                "-f",
                &format!("merge_method={method}"),
            ],
        )?;
        let parsed: Value = serde_json::from_str(&resp).unwrap_or_else(|_| json!({ "merged": true }));
        let _ = app.emit("project-changed", ());
        crate::tasks::changed(&app);
        Ok(parsed)
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_actions_run_and_job_ids() {
        let (r, j) = parse_actions_ids("https://github.com/BilalGates/filigranas-ide/actions/runs/987654/job/123456?pr=12");
        assert_eq!((r, j), (Some(987654), Some(123456)));
        assert_eq!(parse_actions_ids("https://example.com/status"), (None, None));
    }

    #[test]
    fn redacts_tokens_and_truncates_from_tail() {
        let log = "ok line\nAuthorization: Bearer secret123\nghp_abcdefgh123456\nerror: test failed\n";
        let (redacted, trunc) = redact_log(log, 1024);
        assert!(!trunc);
        assert!(!redacted.contains("secret123"));
        assert!(!redacted.contains("ghp_"));
        assert!(redacted.contains("error: test failed"));

        let big = format!("{}FINAL_ERROR\n", "x\n".repeat(200));
        let (tail, trunc2) = redact_log(&big, 64);
        assert!(trunc2);
        assert!(tail.contains("FINAL_ERROR"));
    }

    #[test]
    fn parses_pull_summary_and_check_counts() {
        let v = json!({
            "number": 42,
            "title": "feat: entrega",
            "url": "https://github.com/o/r/pull/42",
            "state": "OPEN",
            "isDraft": false,
            "headRefName": "feat/entrega",
            "baseRefName": "main",
            "headRefOid": "abcdef1234567890",
            "mergeStateStatus": "CLEAN",
            "reviewDecision": "APPROVED",
            "author": { "login": "bilal" },
            "updatedAt": "2026-11-27T10:00:00Z",
            "statusCheckRollup": [
                { "name": "macOS", "status": "COMPLETED", "conclusion": "SUCCESS" },
                { "name": "Windows", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://github.com/o/r/actions/runs/10/job/20" }
            ]
        });
        let p = parse_pull_summary(&v).unwrap();
        assert_eq!(p.number, 42);
        assert_eq!((p.checks_passed, p.checks_failed, p.checks_pending), (1, 1, 0));
        assert_eq!(p.checks_state, "failure");
    }
}
