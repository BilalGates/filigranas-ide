use std::{path::{Component, Path}, process::Command};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::{err, p5_process, workspace::project_path, AppState, CmdResult};

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS health_runs (
            id INTEGER PRIMARY KEY, project TEXT NOT NULL, session INTEGER REFERENCES sessions(id),
            task INTEGER REFERENCES tasks(id), tool TEXT NOT NULL, version TEXT, source TEXT NOT NULL,
            revision TEXT, digest TEXT, outcome TEXT NOT NULL, observed INTEGER NOT NULL DEFAULT(unixepoch())
         );
         CREATE INDEX IF NOT EXISTS health_scope ON health_runs(project,session,id);
         CREATE UNIQUE INDEX IF NOT EXISTS health_import ON health_runs(project,ifnull(session,0),digest) WHERE digest IS NOT NULL;
         CREATE TABLE IF NOT EXISTS health_findings (
            run INTEGER NOT NULL REFERENCES health_runs(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL,
            path TEXT, line INTEGER, rule TEXT NOT NULL, severity TEXT NOT NULL,
            PRIMARY KEY(run,fingerprint)
         );
         CREATE TABLE IF NOT EXISTS health_resolution (
            project TEXT NOT NULL, scope INTEGER NOT NULL, fingerprint TEXT NOT NULL,
            status TEXT NOT NULL, resolution TEXT NOT NULL, PRIMARY KEY(project,scope,fingerprint)
         );",
    )?;
    // Título de la regla en el catálogo de la herramienta (aditivo).
    let has_title: i64 = conn.query_row("SELECT count(*) FROM pragma_table_info('health_findings') WHERE name='title'", [], |r| r.get(0))?;
    if has_title == 0 {
        conn.execute_batch("ALTER TABLE health_findings ADD COLUMN title TEXT")?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Finding {
    fingerprint: String,
    path: Option<String>,
    line: Option<u32>,
    rule: String,
    title: Option<String>,
    severity: String,
    previous: bool,
    status: String,
    resolution: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    id: i64,
    task: Option<i64>,
    tool: String,
    version: Option<String>,
    source: String,
    revision: Option<String>,
    digest: Option<String>,
    outcome: String,
    observed: i64,
    findings: Vec<Finding>,
}

struct Evidence {
    tool: String,
    version: Option<String>,
    source: String,
    revision: Option<String>,
    digest: Option<String>,
    outcome: &'static str,
    findings: Vec<Finding>,
}

fn relative(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    let path = path.strip_prefix("./").unwrap_or(&path);
    if path.is_empty() || path.len() > 1024 || path.contains([':', '%']) || path.chars().any(char::is_control)
        || !Path::new(path).components().all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    Some(path.into())
}

fn report_path(uri: &str, base: Option<&str>, cwd: &Path) -> Option<String> {
    let absolute = tauri::Url::parse(uri).ok().or_else(|| base.and_then(|base| tauri::Url::parse(base).ok()?.join(uri).ok()));
    if let Some(url) = absolute {
        let path = url.to_file_path().ok()?;
        return relative(path.strip_prefix(cwd).ok()?.to_str()?);
    }
    let decoded = percent_encoding::percent_decode_str(uri).decode_utf8().ok()?;
    let path = Path::new(decoded.as_ref());
    if path.is_absolute() {
        return relative(path.strip_prefix(cwd).ok()?.to_str()?);
    }
    relative(&decoded)
}

fn finding(tool: &str, path: Option<String>, line: Option<u32>, rule: &str, severity: &str) -> Finding {
    let fingerprint = format!("{:x}", Sha256::digest(json!([tool, path, line, rule]).to_string()));
    Finding { fingerprint, path, line, rule: rule.into(), title: None, severity: severity.into(), previous: false,
        status: "open".into(), resolution: String::new() }
}

fn revision(value: &str) -> Option<String> {
    (matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())).then(|| value.into())
}

fn identifier(value: &str) -> Option<&str> {
    (!value.is_empty() && value.len() <= 180 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b" -_.:/@#".contains(&b)))
        .then_some(value)
}

/// Descripción corta de la regla en el catálogo de la herramienta. Es texto
/// estático de la regla, no del resultado: una línea, sin controles, acotada.
fn rule_title(rule: Option<&Value>) -> Option<String> {
    let text = rule?["shortDescription"]["text"].as_str()?.trim();
    (!text.is_empty() && text.chars().count() <= 160 && !text.chars().any(char::is_control)).then(|| text.into())
}

fn parse_sarif(report: &str, cwd: &Path) -> CmdResult<Vec<Evidence>> {
    let doc: Value = serde_json::from_str(report).map_err(|_| "informe SARIF JSON inválido")?;
    if doc["version"] != "2.1.0" {
        return Err("se requiere SARIF 2.1.0".into());
    }
    let runs = doc["runs"].as_array().filter(|r| !r.is_empty() && r.len() <= 32).ok_or("el informe debe contener entre 1 y 32 ejecuciones")?;
    let hash = format!("{:x}", Sha256::digest(report));
    let mut evidence = Vec::new();
    for (index, run) in runs.iter().enumerate() {
        let driver = &run["tool"]["driver"];
        let tool = driver["name"].as_str().and_then(identifier).ok_or("falta el nombre válido de la herramienta")?;
        let version = driver["semanticVersion"].as_str().or(driver["version"].as_str()).and_then(identifier).map(str::to_owned);
        let mut findings = Vec::new();
        if !run["results"].is_null() && !run["results"].is_array() {
            return Err("resultados SARIF inválidos".into());
        }
        for result in run["results"].as_array().into_iter().flatten() {
            if findings.len() >= 5000 {
                return Err("el informe supera 5000 hallazgos por ejecución".into());
            }
            if matches!(result["kind"].as_str(), Some("pass" | "notApplicable")) { continue; }
            let referenced = result["ruleIndex"].as_u64().and_then(|index| usize::try_from(index).ok())
                .and_then(|index| driver["rules"].get(index)).or_else(|| {
                    let id = result["ruleId"].as_str()?;
                    driver["rules"].as_array()?.iter().find(|rule| rule["id"] == id)
                });
            let rule = result["ruleId"].as_str().or_else(|| referenced?["id"].as_str())
                .and_then(identifier).unwrap_or("regla sin identificador");
            let location = &result["locations"][0]["physicalLocation"];
            let artifact = &location["artifactLocation"];
            let uri = artifact["uri"].as_str().or_else(|| {
                let index = usize::try_from(artifact["index"].as_u64()?).ok()?;
                run["artifacts"].get(index)?["location"]["uri"].as_str()
            });
            let base = artifact["uriBaseId"].as_str().and_then(|id| run["originalUriBaseIds"][id]["uri"].as_str());
            let path = uri.and_then(|uri| report_path(uri, base, cwd));
            let line = location["region"]["startLine"].as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0);
            let severity = match result["level"].as_str().or_else(|| referenced?["defaultConfiguration"]["level"].as_str()) {
                Some("error") => "error",
                Some("warning") | None => "warning",
                Some("note") => "note",
                _ => "unknown",
            };
            // Keep machine evidence and the report digest. Raw SARIF messages
            // and snippets can contain secret values and are never retained.
            let mut item = finding(tool, path, line, rule, severity);
            item.title = rule_title(referenced);
            findings.push(item);
        }
        let rev = run["versionControlProvenance"][0]["revisionId"].as_str().and_then(revision);
        let success = run["invocations"].as_array().filter(|items| !items.is_empty())
            .map(|items| items.iter().all(|item| item["executionSuccessful"] == true));
        let outcome = if success == Some(false) { "incomplete" } else if !findings.is_empty() { "findings" }
            else if success == Some(true) { "passed" } else { "unknown" };
        evidence.push(Evidence { tool: tool.into(), version, source: "SARIF 2.1.0".into(), revision: rev,
            digest: Some(format!("{hash}:{index}")), outcome, findings });
    }
    Ok(evidence)
}

fn save(conn: &Connection, project: &str, session: Option<i64>, task: Option<i64>, items: Vec<Evidence>) -> CmdResult<()> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    for item in items {
        let inserted = tx.execute(
            "INSERT INTO health_runs(project,session,task,tool,version,source,revision,digest,outcome)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT DO NOTHING",
            params![project,session,task,item.tool,item.version,item.source,item.revision,item.digest,item.outcome],
        ).map_err(err)?;
        if inserted == 0 { continue; }
        let id = tx.last_insert_rowid();
        for row in item.findings {
            tx.execute("INSERT INTO health_findings(run,fingerprint,path,line,rule,severity,title) VALUES(?1,?2,?3,?4,?5,?6,?7)
                        ON CONFLICT(run,fingerprint) DO UPDATE SET severity=excluded.severity WHERE excluded.severity='error'",
                params![id,row.fingerprint,row.path,row.line,row.rule,row.severity,row.title]).map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}

fn scope(state: &AppState, project: &str, session: Option<i64>) -> CmdResult<(String, String, Option<i64>)> {
    let conn = state.db.lock().map_err(err)?;
    let project = project_path(&conn, project)?;
    if let Some(id) = session {
        let item = crate::db::session(&conn, id).map_err(err)?.filter(|item| item.project == project)
            .ok_or("la sesión no pertenece al proyecto")?;
        let cwd = item.cwd().to_owned();
        let task = crate::tasks::linked(&conn, id).map_err(err)?;
        Ok((project, cwd, task))
    } else {
        Ok((project.clone(), project, None))
    }
}

fn stored_scope(conn: &Connection, project: &str, session: Option<i64>) -> CmdResult<(String, Option<crate::db::Session>)> {
    let project = project_path(conn, project)?;
    let item = session.map(|id| {
        crate::db::session_any(conn, id).map_err(err)?.filter(|item| item.project == project)
            .ok_or_else(|| "la sesión no pertenece al proyecto".to_string())
    }).transpose()?;
    Ok((project, item))
}

fn list(conn: &Connection, project: &str, session: Option<i64>) -> CmdResult<Vec<Run>> {
    let mut runs = conn.prepare(
        "SELECT id,task,tool,version,source,revision,digest,outcome,observed
         FROM health_runs WHERE project=?1 AND session IS ?2 ORDER BY id DESC LIMIT 15",
    ).map_err(err)?;
    let mut finding_query = conn.prepare(
        "SELECT f.fingerprint,f.path,f.line,f.rule,f.severity,COALESCE(s.status,'open'),COALESCE(s.resolution,''),
         EXISTS(SELECT 1 FROM health_findings p JOIN health_runs r ON r.id=p.run
                WHERE r.project=?1 AND r.session IS ?2 AND r.id<f.run AND p.fingerprint=f.fingerprint),f.title
         FROM health_findings f LEFT JOIN health_resolution s
           ON s.fingerprint=f.fingerprint AND s.project=?1 AND s.scope=ifnull(?2,0)
         WHERE f.run=?3 ORDER BY CASE f.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,f.path,f.line",
    ).map_err(err)?;
    let rows = runs.query_map(params![project,session], |r| Ok(Run {
        id: r.get(0)?, task: r.get(1)?, tool: r.get(2)?, version: r.get(3)?, source: r.get(4)?,
        revision: r.get(5)?, digest: r.get(6)?, outcome: r.get(7)?, observed: r.get(8)?, findings: Vec::new(),
    })).map_err(err)?;
    let mut result = Vec::new();
    for run in rows {
        let mut run = run.map_err(err)?;
        run.findings = finding_query.query_map(params![project,session,run.id], |r| Ok(Finding {
            fingerprint:r.get(0)?, path:r.get(1)?, line:r.get(2)?, rule:r.get(3)?, severity:r.get(4)?,
            status:r.get(5)?, resolution:r.get(6)?, previous:r.get(7)?, title:r.get(8)?,
        })).map_err(err)?.collect::<rusqlite::Result<_>>().map_err(err)?;
        result.push(run);
    }
    Ok(result)
}

#[tauri::command]
pub async fn health_list(app: AppHandle, project: String, session: Option<i64>) -> CmdResult<Vec<Run>> {
    crate::background_read(app, move |state| {
        let conn = state.db.lock().map_err(err)?;
        let (project, _) = stored_scope(&conn, &project, session)?;
        list(&conn, &project, session)
    }).await
}

#[tauri::command]
pub async fn health_file(app: AppHandle, project: String, session: Option<i64>, path: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(err)?;
        let (project, item) = stored_scope(&conn, &project, session)?;
        let cwd = item.as_ref().map_or(project.as_str(), |item| item.cwd());
        drop(conn);
        let path = relative(&path).ok_or("ruta del hallazgo inválida")?;
        let root = Path::new(&cwd);
        let target = crate::paths::inside(root, &root.join(path))?;
        Ok(crate::paths::to_string(&target))
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn health_import(app: AppHandle, project: String, session: Option<i64>, report: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if report.len() > 8 * 1024 * 1024 { return Err("el informe supera 8 MiB".into()); }
        let state = app.state::<AppState>();
        let (project, cwd, task) = scope(&state, &project, session)?;
        let evidence = parse_sarif(&report, Path::new(&cwd))?;
        let conn = state.db.lock().map_err(err)?;
        save(&conn, &project, session, task, evidence)
    }).await.map_err(err)?
}

fn git_evidence(cwd: &Path) -> CmdResult<Evidence> {
    // No external diff/textconv drivers. Only the diagnostic header escapes
    // the process; added lines may contain secrets.
    let head = crate::pr::value(cwd, &["rev-parse", "--verify", "HEAD"]).ok();
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd).args(["--no-optional-locks", "-c", "color.ui=never", "-c", "core.quotepath=off",
        "diff", "--no-ext-diff", "--no-textconv", "--check"]);
    if head.is_some() { cmd.arg("HEAD"); } else { cmd.arg("--cached"); }
    let output = p5_process::run(cmd, 30)?;
    let text = String::from_utf8_lossy(&output.bytes);
    let findings: Vec<_> = text.lines().filter_map(|row| {
        if row.starts_with('+') { return None; }
        let (location, message) = row.rsplit_once(": ")?;
        if !matches!(message, "trailing whitespace." | "new blank line at EOF." | "leftover conflict marker." |
            "space before tab in indent." | "indent with spaces." | "tab in indent.") { return None; }
        let (path, line) = location.rsplit_once(':')?;
        Some(finding("git", Some(relative(path)?), Some(line.parse().ok()?), message, "warning"))
    }).collect();
    let version = crate::pr::run(cwd, "git", &["--version"]).ok().and_then(|s| identifier(s.trim()).map(str::to_owned));
    let outcome = if output.truncated { "incomplete" } else if !findings.is_empty() { "findings" }
        else if output.success { "passed" } else { "failed" };
    Ok(Evidence { tool: "git".into(), version, source: "diff --check · árbol de trabajo".into(),
        revision: head.as_deref().and_then(revision), digest: None, outcome, findings })
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCheck { Diff, Build, Typecheck, Lint, Test, CargoCheck, CargoTest, CargoClippy }

fn package_manager(manifest: &Value, pnpm_lock: bool) -> &'static str {
    match manifest["packageManager"].as_str().and_then(|value| value.split_once('@')) {
        Some(("pnpm", _)) => "pnpm",
        Some(("npm", _)) => "npm",
        _ if pnpm_lock => "pnpm",
        _ => "npm",
    }
}

fn run_check(cwd: &Path, check: LocalCheck) -> CmdResult<Evidence> {
    let (program, args, source) = match check {
        LocalCheck::Diff => return git_evidence(cwd),
        LocalCheck::CargoCheck | LocalCheck::CargoTest | LocalCheck::CargoClippy => {
            let manifest = ["Cargo.toml", "src-tauri/Cargo.toml"].into_iter()
                .find(|name| cwd.join(name).is_file()).ok_or("no se encontró Cargo.toml")?;
            let subcommand = match check {
                LocalCheck::CargoCheck => "check",
                LocalCheck::CargoTest => "test",
                _ => "clippy",
            };
            ("cargo", vec![subcommand, "--locked", "--offline", "--manifest-path", manifest],
                format!("cargo {subcommand}"))
        }
        check => {
            let script = match check {
                LocalCheck::Build => "build",
                LocalCheck::Typecheck => "typecheck",
                LocalCheck::Lint => "lint",
                _ => "test",
            };
            let manifest = std::fs::read(cwd.join("package.json")).map_err(|_| "no se encontró package.json")?;
            let data: Value = serde_json::from_slice(&manifest).map_err(|_| "package.json inválido")?;
            if data["scripts"][script].as_str().is_none() {
                return Err(format!("el proyecto no declara el script {script}"));
            }
            let program = package_manager(&data, cwd.join("pnpm-lock.yaml").is_file());
            (program, vec!["run", script], format!("{program} run {script}"))
        }
    };
    let command = |args: &[&str]| {
        let mut cmd = Command::new(crate::cli::program(program));
        cmd.current_dir(cwd).args(args).env("CI", "true");
        if let Some(path) = crate::cli::login_path() { cmd.env("PATH", path); }
        cmd
    };
    let head = crate::pr::value(cwd, &["rev-parse", "--verify", "HEAD"]).ok();
    let version = p5_process::run(command(&["--version"]), 10).ok().filter(|out| out.success && !out.truncated)
        .and_then(|out| std::str::from_utf8(&out.bytes).ok().and_then(|s| identifier(s.trim())).map(str::to_owned));
    let outcome = match p5_process::run(command(&args), 180) {
        Ok(result) if result.success => "passed",
        Ok(_) => "failed",
        Err(p5_process::TIMEOUT) => "incomplete",
        Err(error) => return Err(error.into()),
    };
    Ok(Evidence { tool: program.into(), version, source, revision: head.as_deref().and_then(revision),
        digest: None, outcome, findings: Vec::new() })
}

#[tauri::command]
pub async fn health_run(app: AppHandle, project: String, session: Option<i64>, check: LocalCheck) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (project, cwd, task) = scope(&state, &project, session)?;
        let evidence = run_check(Path::new(&cwd), check)?;
        let conn = state.db.lock().map_err(err)?;
        save(&conn, &project, session, task, vec![evidence])
    }).await.map_err(err)?
}

#[tauri::command]
pub fn health_resolve(state: State<AppState>, project: String, session: Option<i64>, run: i64, fingerprint: String,
    status: String, resolution: String) -> CmdResult<()> {
    if !matches!(status.as_str(), "open" | "resolved" | "accepted") || resolution.trim().len() > 1200
        || (status != "open" && resolution.trim().is_empty()) {
        return Err("indica una resolución breve para cerrar o aceptar el hallazgo".into());
    }
    let conn = state.db.lock().map_err(err)?;
    let (project, _) = stored_scope(&conn, &project, session)?;
    let changed = conn.execute(
        "INSERT INTO health_resolution(project,scope,fingerprint,status,resolution)
         SELECT r.project,ifnull(r.session,0),f.fingerprint,?5,?6 FROM health_runs r
         JOIN health_findings f ON f.run=r.id WHERE r.project=?1 AND r.session IS ?2 AND r.id=?3 AND f.fingerprint=?4
         ON CONFLICT(project,scope,fingerprint) DO UPDATE SET status=excluded.status,resolution=excluded.resolution",
        params![project,session,run,fingerprint,status,resolution.trim()],
    ).map_err(err)?;
    if changed == 0 { return Err("el hallazgo no pertenece a esta revisión".into()); }
    Ok(())
}

#[tauri::command]
pub async fn health_ci(app: AppHandle, project: String, session: Option<i64>) -> CmdResult<Vec<crate::github::Pull>> {
    crate::background_read(app, move |state| {
        let (project, item) = {
            let conn = state.db.lock().map_err(err)?;
            stored_scope(&conn, &project, session)?
        };
        let cwd = item.as_ref().map_or(project.as_str(), |item| item.cwd());
        let branch = crate::pr::value(Path::new(cwd), &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok()
            .or_else(|| item.as_ref().and_then(|item| item.branch.clone()));
        let Some(branch) = branch else { return Ok(Vec::new()); };
        let conn = state.db.lock().map_err(err)?;
        crate::github::pulls(&conn, &project, None, &branch)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_pnpm_with_a_pin_or_lock_and_preserves_npm_projects() {
        assert_eq!(package_manager(&json!({"packageManager":"pnpm@11.13.1"}), false), "pnpm");
        assert_eq!(package_manager(&json!({}), true), "pnpm");
        assert_eq!(package_manager(&json!({"packageManager":"npm@11.0.0"}), true), "npm");
        assert_eq!(package_manager(&json!({}), false), "npm");
    }

    #[test]
    fn imports_traceable_sarif_and_deduplicates_without_saving_secret_content() {
        let report = json!({"version":"2.1.0","runs":[{"tool":{"driver":{"name":"Semgrep","version":"1.2.3",
            "rules":[{"id":"example.rule","shortDescription":{"text":"Regla de ejemplo"}}]}},
            "results":[{"ruleId":"example.rule","level":"error","message":{"text":"SECRET SAMPLE"},
            "locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/main.rs"},"region":{"startLine":7}}}]}]}]}).to_string();
        let conn = crate::db::open(Path::new(":memory:")).unwrap();
        for _ in 0..2 {
            save(&conn, "fixture", None, None, parse_sarif(&report, Path::new("/tmp/project")).unwrap()).unwrap();
        }
        let rows = list(&conn, "fixture", None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].findings[0].path.as_deref(), Some("src/main.rs"));
        assert_eq!(rows[0].findings[0].line, Some(7));
        assert_eq!(rows[0].version.as_deref(), Some("1.2.3"));
        assert_eq!(rows[0].findings[0].title.as_deref(), Some("Regla de ejemplo"));
        assert_eq!(rule_title(Some(&json!({"shortDescription":{"text":"dos\nlíneas"}}))), None);
        assert!(!serde_json::to_string(&rows).unwrap().contains("SECRET SAMPLE"));
        assert!(relative("../outside").is_none());
        assert!(report_path("%2e%2e/outside", None, Path::new("/tmp/project")).is_none());
    }

    #[test]
    fn reads_closed_evidence_only_within_the_owning_project() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let project = root.join("one");
        let other = root.join("two");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir(&other).unwrap();
        let conn = crate::db::open(Path::new(":memory:")).unwrap();
        crate::db::set_setting(&conn, "root", &crate::paths::to_string(&root)).unwrap();
        let project = project.to_str().unwrap();
        let id = crate::db::create_session(&conn, project, "claude", "", &["xavi"]).unwrap().id;
        let (canonical, _) = stored_scope(&conn, project, Some(id)).unwrap();
        save(&conn, &canonical, Some(id), None, vec![Evidence {
            tool: "git".into(), version: None, source: "local".into(), revision: None,
            digest: None, outcome: "passed", findings: vec![],
        }]).unwrap();
        crate::db::close_session(&conn, id).unwrap();

        assert!(crate::db::session(&conn, id).unwrap().is_none());
        let (canonical, item) = stored_scope(&conn, project, Some(id)).unwrap();
        assert_eq!(item.unwrap().id, id);
        assert_eq!(list(&conn, &canonical, Some(id)).unwrap().len(), 1);
        assert!(list(&conn, &canonical, None).unwrap().is_empty());
        assert!(stored_scope(&conn, other.to_str().unwrap(), Some(id)).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn real_git_check_reports_location_without_worktree_content() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).unwrap();
        crate::pr::run(&root,"git",&["init","-q"]).unwrap();
        std::fs::write(root.join("known.txt"), "base\n").unwrap();
        crate::pr::run(&root,"git",&["add","known.txt"]).unwrap();
        crate::pr::run(&root,"git",&["-c","user.name=Fixture","-c","user.email=fixture@example.invalid",
            "-c","commit.gpgsign=false","commit","-qm","base"]).unwrap();
        std::fs::write(root.join("known.txt"), "base\nsensitive content   \n").unwrap();
        let result = git_evidence(&root).unwrap();
        assert_eq!(result.outcome, "findings");
        assert_eq!(result.findings[0].line, Some(2));
        assert!(!serde_json::to_string(&result.findings).unwrap().contains("sensitive content"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
