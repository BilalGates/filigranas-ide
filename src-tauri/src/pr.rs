use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::approval::{Proof, Review};
use crate::codex::login_path;
use crate::git::git;
use crate::github::{self, Publication, Pull};
use crate::{err, AppState, CmdResult};

type Exec<'a> = dyn Fn(&str, &[&str]) -> CmdResult<String> + 'a;

pub fn run(repo: &Path, program: &str, args: &[&str]) -> CmdResult<String> {
    let mut cmd = Command::new(crate::codex::program(program));
    cmd.args(args).current_dir(repo).env("GIT_TERMINAL_PROMPT", "0").env("GH_PROMPT_DISABLED", "1");
    if let Some(path) = login_path() { cmd.env("PATH", path); }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("no se pudo ejecutar {program}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let message = String::from_utf8_lossy(&out.stderr);
        if message.trim().is_empty() {
            return Err(format!("{program} terminó con {}", out.status));
        }
        Err(message.trim().to_string())
    }
}

pub fn value(repo: &Path, args: &[&str]) -> CmdResult<String> {
    git(repo, args).map(|o| String::from_utf8_lossy(&o).trim().to_string())
}

pub fn push_url(repo: &Path, remote: &str) -> CmdResult<String> {
    let urls = value(repo, &["remote", "get-url", "--push", "--all", "--", remote])?;
    if urls.is_empty() || urls.lines().count() != 1 {
        return Err("la publicación requiere un único destino de push".into());
    }
    Ok(urls)
}

pub fn push_exact(exec: &Exec<'_>, url: &str, head: &str, branch: &str) -> CmdResult<String> {
    // El SHA aprobado es inmutable. El remoto recibe una sola referencia y nunca un push forzado.
    exec("git", &["push", "--no-follow-tags", "--recurse-submodules=no", "--", url, &format!("{head}:refs/heads/{branch}")])
}

pub fn configure_tracking(repo: &Path, branch: &str, remote: &str, dest: &str, head: &str) -> CmdResult<()> {
    value(repo, &["config", "--local", &format!("branch.{branch}.remote"), remote])?;
    value(repo, &["config", "--local", &format!("branch.{branch}.merge"), &format!("refs/heads/{dest}")])?;
    let tracking = format!("refs/remotes/{remote}/{dest}");
    // Un push por URL no instala por sí mismo la referencia remota local.
    if value(repo, &["show-ref", "--verify", "--hash", &tracking]).is_err() {
        value(repo, &["update-ref", &tracking, head, ""])?;
    }
    Ok(())
}

pub fn repository(url: &str) -> Option<String> {
    let path = ["https://github.com/", "git@github.com:", "ssh://git@github.com/", "ssh://git@ssh.github.com:443/"]
        .into_iter().find_map(|prefix| url.strip_prefix(prefix))?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    let valid = |value: &str| !matches!(value, "" | "." | "..") &&
        value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    (valid(owner) && valid(name)).then(|| path.to_ascii_lowercase())
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct Target {
    branch: String,
    head: String,
    url: String,
    repository: String,
}

impl Target {
    fn read(repo: &Path) -> CmdResult<Self> {
        let branch = value(repo, &["branch", "--show-current"])?;
        if branch.is_empty() { return Err("HEAD suelto: cambia a una rama para publicar".into()); }
        let head = value(repo, &["rev-parse", "HEAD"])?;
        let fetch = value(repo, &["remote", "get-url", "origin"]).map_err(|_| "el repositorio no tiene remoto origin")?;
        let url = push_url(repo, "origin")?;
        let slug = repository(&fetch).ok_or("origin no apunta a un repositorio de github.com")?;
        if repository(&url).as_deref() != Some(slug.as_str()) {
            return Err("origin usa repositorios distintos para lectura y publicación".into());
        }
        Ok(Self { branch, head, url, repository: slug })
    }

    fn confirm_unchanged(&self, repo: &Path) -> CmdResult<()> {
        if &Self::read(repo)? != self {
            return Err("la rama, el commit o el remoto cambió. Revisa de nuevo antes de continuar".into());
        }
        Ok(())
    }
}

fn timestamp() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

fn text_field<'a>(v: &'a Value, key: &str) -> CmdResult<&'a str> {
    v[key].as_str().filter(|s| !s.is_empty()).ok_or_else(|| format!("GitHub no devolvió {key}"))
}

fn pull_number(v: &Value) -> CmdResult<u64> {
    v["number"].as_u64().filter(|n| *n > 0).ok_or_else(|| "GitHub no devolvió el número de PR".into())
}

fn check_counts(v: &Value) -> (u32, u32, u32) {
    let mut checks = (0, 0, 0);
    for c in v.as_array().into_iter().flatten() {
        let verdict = c["conclusion"].as_str().filter(|s| !s.is_empty()).or(c["state"].as_str()).unwrap_or("");
        match verdict {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => checks.0 += 1,
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STALE" | "STARTUP_FAILURE" => checks.1 += 1,
            _ => checks.2 += 1,
        }
    }
    checks
}

fn details(v: &Value) -> CmdResult<Pull> {
    let checks = check_counts(&v["statusCheckRollup"]);
    let checks_state = if checks.1 > 0 { "failure" } else if checks.2 > 0 { "pending" }
        else if checks.0 > 0 { "success" } else { "unknown" };
    Ok(Pull {
        number: pull_number(v)?, url: text_field(v, "url")?.into(), state: text_field(v, "state")?.into(),
        is_draft: v["isDraft"].as_bool().ok_or("GitHub no informó si la PR es borrador")?,
        branch: text_field(v, "headRefName")?.into(), base: text_field(v, "baseRefName")?.into(),
        head: text_field(v, "headRefOid")?.into(), checks, checks_state: checks_state.into(),
        checks_known: v["statusCheckRollup"].is_array(),
        review: v["reviewDecision"].as_str().filter(|s| !s.is_empty()).map(str::to_owned),
        merge_state: v["mergeStateStatus"].as_str().unwrap_or("UNKNOWN").into(), observed_at: timestamp(),
    })
}

fn from_rest(v: &Value) -> CmdResult<Pull> {
    let state = match text_field(v, "state")? {
        "open" => "OPEN",
        "closed" if v["merged_at"].is_string() => "MERGED",
        "closed" => "CLOSED",
        _ => return Err("GitHub devolvió un estado de PR desconocido".into()),
    };
    Ok(Pull {
        number: pull_number(v)?, url: text_field(v, "html_url")?.into(), state: state.into(),
        is_draft: v["draft"].as_bool().unwrap_or(true), branch: text_field(&v["head"], "ref")?.into(),
        base: text_field(&v["base"], "ref")?.into(), head: text_field(&v["head"], "sha")?.into(),
        checks: (0, 0, 0), checks_state: "unknown".into(), checks_known: false, review: None, merge_state: "UNKNOWN".into(),
        observed_at: timestamp(),
    })
}

struct Github<'a> {
    target: &'a Target,
    project: &'a str,
    db: &'a Mutex<Connection>,
    exec: &'a Exec<'a>,
}

impl Github<'_> {
    fn endpoint(&self, path: &str) -> String { format!("repos/{}/{}", self.target.repository, path) }

    fn list(&self) -> CmdResult<Vec<Pull>> {
        let owner = self.target.repository.split_once('/').ok_or("repositorio GitHub no válido")?.0;
        let stdout = (self.exec)("gh", &["api", "--hostname", "github.com", "--method", "GET", "--paginate", "--slurp",
            &self.endpoint("pulls"), "-f", "state=all", "-f", "per_page=100", "-f", &format!("head={owner}:{}", self.target.branch)])?;
        let pages: Vec<Vec<Value>> = serde_json::from_str(&stdout).map_err(err)?;
        let mut pulls = Vec::new();
        for item in pages.into_iter().flatten() {
            let same_repo = item.pointer("/head/repo/full_name").and_then(Value::as_str)
                .is_some_and(|name| name.eq_ignore_ascii_case(&self.target.repository));
            if same_repo && item.pointer("/head/ref").and_then(Value::as_str) == Some(self.target.branch.as_str()) {
                pulls.push(from_rest(&item)?);
            }
        }
        Ok(pulls)
    }

    fn detail(&self, known: &Pull) -> CmdResult<Pull> {
        const FIELDS: &str = "number,url,state,isDraft,headRefName,baseRefName,headRefOid,statusCheckRollup,reviewDecision,mergeStateStatus,isCrossRepository";
        let stdout = (self.exec)("gh", &["pr", "view", &known.number.to_string(), "--repo", &format!("github.com/{}", self.target.repository),
            "--json", FIELDS])?;
        let data: Value = serde_json::from_str(&stdout).map_err(err)?;
        let pull = details(&data)?;
        if pull.number != known.number || pull.branch != self.target.branch || data["isCrossRepository"] != false {
            return Err("la PR devuelta no corresponde a la rama y repositorio consultados".into());
        }
        Ok(pull)
    }

    fn save(&self, pull: &Pull) -> CmdResult<()> {
        let conn = self.db.lock().map_err(err)?;
        if !pull.checks_known && github::pulls(&conn, self.project, Some(&self.target.repository), &pull.branch)?.iter().any(|old|
            old.number == pull.number && old.state == pull.state && old.head == pull.head && old.base == pull.base && old.checks_known
        ) { return Ok(()); }
        github::remember(&conn, self.project, &self.target.repository, pull)
    }

    fn observe(&self, pull: &Pull) -> CmdResult<Pull> {
        let detailed = self.detail(pull)?;
        self.save(&detailed)?;
        Ok(detailed)
    }

    fn create(&self, edit: &Publish) -> CmdResult<Pull> {
        let out = (self.exec)("gh", &["api", "--hostname", "github.com", "--method", "POST",
            &self.endpoint("pulls"), "-f", &format!("title={}", edit.title), "-f", &format!("body={}", edit.body),
            "-f", &format!("base={}", edit.base), "-f", &format!("head={}", self.target.branch),
            "-F", &format!("draft={}", edit.draft_pr)])?;
        let data: Value = serde_json::from_str(&out).map_err(err)?;
        from_rest(&data)
    }

    fn remote_head(&self) -> CmdResult<String> {
        let dst = format!("refs/heads/{}", self.target.branch);
        let out = (self.exec)("git", &["ls-remote", "--refs", "--", &self.target.url, &dst])?;
        Ok(out.lines().find_map(|line| {
            let (oid, name) = line.split_once('\t')?;
            (name == dst).then(|| oid.to_string())
        }).unwrap_or_default())
    }
}

fn compose(branch: &str, subjects: &[String]) -> (String, String) {
    let title = match subjects {
        [only] => only.clone(),
        _ => branch.rsplit('/').next().unwrap_or(branch).replace(['-', '_'], " "),
    };
    let mut body = String::from("## Cambios\n\n");
    for s in subjects { body.push_str(&format!("- {s}\n")); }
    (title, body)
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    branch: String,
    head: String,
    repository: Option<String>,
    bases: Vec<String>,
    base: String,
    title: String,
    body: String,
    commits: Vec<String>,
    dirty: bool,
    existing: Option<Pull>,
    previous: Option<Pull>,
    blocked: Option<String>,
    remote_error: Option<String>,
    task_id: Option<i64>,
    larry_checked: bool,
}

fn local_draft(repo: &Path, wanted: Option<String>) -> CmdResult<Draft> {
    let branch = value(repo, &["branch", "--show-current"])?;
    if branch.is_empty() { return Err("HEAD suelto: cambia a una rama para publicar".into()); }
    let head = value(repo, &["rev-parse", "HEAD"])?;
    let bases: Vec<String> = value(repo, &["for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin"])?
        .lines().filter(|b| *b != "HEAD" && *b != branch).map(str::to_owned).collect();
    let default = value(repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).unwrap_or_default();
    let default = default.strip_prefix("origin/").unwrap_or(&default);
    let base = wanted.filter(|b| bases.contains(b)).or_else(|| bases.iter().find(|b| *b == default).cloned())
        .or_else(|| ["main", "master"].iter().find_map(|name| bases.iter().find(|branch| branch.as_str() == *name).cloned()))
        .or_else(|| bases.first().cloned()).unwrap_or_default();
    let commits = if base.is_empty() { Vec::new() } else {
        value(repo, &["log", "--reverse", "--format=%s", &format!("refs/remotes/origin/{base}..{head}")])?
            .lines().map(str::to_owned).collect()
    };
    let (title, body) = compose(&branch, &commits);
    let dirty = !value(repo, &["status", "--porcelain"])?.is_empty();
    let blocked = if base.is_empty() { Some("no hay ramas de origin conocidas. Actualiza las referencias primero".into()) }
        else if commits.is_empty() { Some(format!("{branch} no tiene commits nuevos frente a {base}")) } else { None };
    Ok(Draft { branch, head, bases, base, title, body, commits, dirty, blocked, ..Default::default() })
}

fn project(state: &AppState, path: &str) -> CmdResult<String> {
    let conn = state.db.lock().map_err(err)?;
    crate::workspace::project_path(&conn, path)
}

fn append_task(state: &AppState, project: &str, session: Option<i64>, draft: &mut Draft) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    draft.larry_checked = github::branch(&conn, project, &draft.branch)?.commits.iter().any(|c| c.oid == draft.head);
    let task = session.map(|id| crate::tasks::linked(&conn, id)).transpose().map_err(err)?.flatten();
    if let Some(id) = task {
        let (title,criteria,risk,tests): (String,String,String,Option<String>) = conn.query_row(
            "SELECT title,criteria,risk,tests FROM tasks WHERE project=?1 AND id=?2", rusqlite::params![project,id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).map_err(err)?;
        draft.task_id = Some(id);
        draft.body.push_str(&format!("\n## Tarea #{id}\n\n{title}\n\n## Criterios\n\n{criteria}\n\nRiesgo: {risk}\n"));
        use rusqlite::OptionalExtension;
        let model: Option<(String,Option<String>)> = conn.query_row(
            "SELECT provider,model FROM task_runs WHERE task_id=?1 AND session_id=?2 ORDER BY id DESC LIMIT 1",
            rusqlite::params![id,session], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional().map_err(err)?;
        if let Some((provider,model)) = model {
            draft.body.push_str(&format!("Agente: {provider} · {}\n", model.as_deref().unwrap_or("modelo desconocido")));
        }
        let tested = match tests.as_deref() {
            Some("passed") => "correctas según la tarea",
            Some("failed") => "fallidas según la tarea",
            Some("not_applicable") => "no aplican según la tarea",
            _ => "pendiente de registrar",
        };
        draft.body.push_str(&format!("\n## Pruebas locales\n\n- {tested}\n"));
    } else {
        draft.body.push_str("\n## Pruebas locales\n\n- Pendiente de registrar\n");
    }
    if draft.larry_checked {
        draft.body.push_str("- Larry comprobó el diff preparado antes del commit de cabecera.\n");
    }
    Ok(())
}

#[tauri::command]
pub async fn pr_draft(app: AppHandle, path: String, session: Option<i64>, base: Option<String>) -> CmdResult<Draft> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let project = project(&state, &path)?;
        let dir = crate::isolate::work_dir(&state, &project, session)?;
        let mut draft = local_draft(&dir, base)?;
        append_task(&state, &project, session, &mut draft)?;
        let target = match Target::read(&dir) {
            Ok(target) => target,
            Err(e) => { draft.blocked = Some(e); return Ok(draft); }
        };
        draft.repository = Some(target.repository.clone());
        let exec = |program: &str, args: &[&str]| run(&dir, program, args);
        let remote = Github { target: &target, project: &project, db: &state.db, exec: &exec };
        match remote.list() {
            Ok(pulls) => {
                let open = pulls.iter().find(|p| p.state == "OPEN" && p.base == draft.base)
                    .or_else(|| pulls.iter().find(|p| p.state == "OPEN"));
                if let Some(open) = open {
                    match remote.observe(open) {
                        Ok(info) => draft.existing = Some(info),
                        Err(e) => {
                            remote.save(open)?;
                            draft.existing = Some(open.clone());
                            draft.remote_error = Some(e);
                        }
                    }
                    if open.base != draft.base {
                        draft.blocked = Some(format!("la PR abierta apunta a {}. Selecciona esa base", open.base));
                    }
                }
                if let Some(previous) = pulls.iter().find(|p| p.state != "OPEN" && p.base == draft.base) {
                    draft.previous = Some(remote.observe(previous).unwrap_or_else(|_| previous.clone()));
                }
            }
            Err(e) => {
                let conn = state.db.lock().map_err(err)?;
                let snapshots = github::pulls(&conn, &project, Some(&target.repository), &draft.branch)?;
                draft.existing = snapshots.iter().find(|p| p.state == "OPEN" && p.base == draft.base).cloned();
                draft.previous = snapshots.into_iter().find(|p| p.state != "OPEN" && p.base == draft.base);
                draft.remote_error = Some(e);
            }
        }
        crate::tasks::changed(&app);
        Ok(draft)
    }).await.map_err(err)?
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Publish {
    expected_branch: String,
    expected_head: String,
    expected_repository: String,
    base: String,
    title: String,
    body: String,
    draft_pr: bool,
}

fn existing(pulls: &[Pull], base: &str, head: &str) -> CmdResult<Option<Pull>> {
    if let Some(open) = pulls.iter().find(|p| p.state == "OPEN" && p.base == base) {
        return Ok(Some(open.clone()));
    }
    if let Some(open) = pulls.iter().find(|p| p.state == "OPEN") {
        return Err(format!("la rama ya tiene la PR #{} hacia {}", open.number, open.base));
    }
    Ok(pulls.iter().find(|p| p.base == base && p.head == head).cloned())
}

fn publish(repo: &Path, remote: &Github<'_>, edit: &Publish, confirm: impl FnOnce(String) -> bool) -> CmdResult<Pull> {
    let target = remote.target;
    let d = local_draft(repo, Some(edit.base.clone()))?;
    if d.base != edit.base || d.head != edit.expected_head || d.branch != edit.expected_branch || target.repository != edit.expected_repository {
        return Err("la base, el commit o el repositorio cambió. Vuelve a revisar el borrador".into());
    }
    let journal = Publication { project: remote.project, repository: &target.repository, branch: &target.branch, base: &edit.base, oid: &target.head };
    let query = || existing(&remote.list()?, &edit.base, &target.head);
    let known = query()?;
    if let Some(pull) = &known {
        if pull.head == target.head {
            let result = remote.observe(pull).unwrap_or_else(|_| pull.clone());
            remote.save(&result)?;
            journal.set_pending(&*remote.db.lock().map_err(err)?, false)?;
            return Ok(result);
        }
    }
    if let Some(why) = d.blocked { return Err(why); }
    if known.is_none() && journal.pending(&*remote.db.lock().map_err(err)?)? {
        return Err("GitHub todavía no confirma el intento anterior. Actualiza el estado antes de volver a publicar este commit".into());
    }
    if edit.title.trim().is_empty() && known.is_none() { return Err("la PR necesita título".into()); }
    let intent = if let Some(pull) = &known { format!("Actualizar PR #{}", pull.number) }
        else { format!("Abrir PR «{}»{}", edit.title, if edit.draft_pr { " como borrador" } else { "" }) };
    if !confirm(format!("{intent}\n\n{}\n{} → {}\nCommit {}", target.repository, target.branch, edit.base, target.head)) {
        return Err("publicación cancelada".into());
    }
    target.confirm_unchanged(repo)?;
    let fresh = query()?;
    if known.as_ref().map(|p| (&p.state,p.number)) != fresh.as_ref().map(|p| (&p.state,p.number)) {
        return Err("la PR cambió durante la confirmación. Revisa el estado antes de continuar".into());
    }
    if remote.remote_head()? != target.head {
        push_exact(remote.exec, &target.url, &target.head, &target.branch).map_err(|e| format!("git push falló: {e}"))?;
    }
    if remote.remote_head()? != target.head {
        return Err("GitHub aún no confirma el commit remoto aprobado".into());
    }
    if value(repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_err() {
        configure_tracking(repo, &target.branch, "origin", &target.branch, &target.head)?;
    }
    if let Some(pull) = fresh {
        return remote.observe(&pull);
    }
    if let Some(pull) = query()? {
        return remote.observe(&pull);
    }
    journal.set_pending(&*remote.db.lock().map_err(err)?, true)?;
    let pull = match remote.create(edit) {
        Ok(pull) => pull,
        Err(error) => match query() {
            Ok(Some(pull)) => pull,
            Ok(None) if [400, 401, 403, 404, 422].iter().any(|code| error.ends_with(&format!("(HTTP {code})"))) => {
                journal.set_pending(&*remote.db.lock().map_err(err)?, false)?;
                return Err(error);
            }
            _ => return Err("la rama está publicada, pero GitHub no confirmó la creación de la PR. Se consultará el estado al reintentar".into()),
        },
    };
    remote.save(&pull)?;
    journal.set_pending(&*remote.db.lock().map_err(err)?, false)?;
    if pull.head != target.head || pull.branch != target.branch || pull.base != edit.base {
        return Err("el destino o el commit informado por GitHub cambió durante la publicación. Revisa la PR".into());
    }
    Ok(remote.observe(&pull).unwrap_or(pull))
}

#[tauri::command]
pub fn pr_review_publish(state: tauri::State<AppState>, path: String, session: Option<i64>, edit: Publish) -> CmdResult<Review> {
    let project = project(&state, &path)?;
    let dir = crate::isolate::work_dir(&state, &project, session)?;
    let target = Target::read(&dir)?;
    if target.branch != edit.expected_branch || target.head != edit.expected_head || target.repository != edit.expected_repository {
        return Err("la rama, el commit o el repositorio cambió. Vuelve a revisar el borrador".into());
    }
    state.approvals.prepare(("pr_publish", &project, session, &target, &edit),
        format!("Publicar en {} · {} → {} · {}", target.repository, target.branch, edit.base, target.head), &target.head)
}

#[tauri::command]
pub async fn pr_publish(app: AppHandle, path: String, session: Option<i64>, edit: Publish, proof: Proof) -> CmdResult<Pull> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.publication.try_lock().map_err(|_| "ya hay una operación de publicación en curso")?;
        let project = project(&state, &path)?;
        let dir = crate::isolate::work_dir(&state, &project, session)?;
        let target = Target::read(&dir)?;
        let exec = |program: &str, args: &[&str]| run(&dir, program, args);
        let remote = Github { target: &target, project: &project, db: &state.db, exec: &exec };
        state.approvals.consume(("pr_publish", &project, session, &target, &edit), &proof)?;
        let result = publish(&dir, &remote, &edit, |_| true);
        let _ = app.emit("project-changed", ());
        crate::tasks::changed(&app);
        result
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn pr_status(app: AppHandle, path: String, session: Option<i64>, number: u64) -> CmdResult<Pull> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let project = project(&state, &path)?;
        let dir = crate::isolate::work_dir(&state, &project, session)?;
        let target = Target::read(&dir)?;
        let exec = |program: &str, args: &[&str]| run(&dir, program, args);
        let remote = Github { target: &target, project: &project, db: &state.db, exec: &exec };
        // El número debe haber sido observado para esta rama y repositorio.
        let known = known_pull(&remote, number)?;
        let result = remote.observe(&known);
        if result.as_ref().is_ok_and(|pull| {
            let mut previous = known.clone();
            previous.observed_at = pull.observed_at;
            previous != *pull
        }) {
            crate::tasks::changed(&app);
        }
        result
    }).await.map_err(err)?
}

fn known_pull(remote: &Github<'_>, number: u64) -> CmdResult<Pull> {
    let conn = remote.db.lock().map_err(err)?;
    github::pulls(&conn, remote.project, Some(&remote.target.repository), &remote.target.branch)?
        .into_iter().find(|p| p.number == number).ok_or_else(|| "la PR todavía no está vinculada a esta rama".into())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merge {
    number: u64,
    head: String,
    base: String,
    method: String,
}

fn merge(repo: &Path, remote: &Github<'_>, edit: &Merge, confirm: impl FnOnce(String) -> bool) -> CmdResult<Pull> {
    if !["merge", "squash", "rebase"].contains(&edit.method.as_str()) { return Err("método de merge no válido".into()); }
    if remote.target.head != edit.head { return Err("el commit local difiere del de la PR. Revisa la rama antes de fusionar".into()); }
    let known = known_pull(remote, edit.number)?;
    let validate = |p: &Pull| -> CmdResult<()> {
        if p.head != edit.head || p.base != edit.base {
            return Err("la base o el commit de la PR cambió. Revisa el estado actualizado".into());
        }
        if !p.merge_ready() {
            return Err("GitHub no confirma que la PR pueda fusionarse. Revisa checks, revisiones y reglas de la rama".into());
        }
        Ok(())
    };
    let current = remote.observe(&known)?;
    if current.state == "MERGED" && current.head == edit.head && current.base == edit.base {
        return Ok(current);
    }
    validate(&current)?;
    if !confirm(format!("{}/#{} → {}\nCommit {}\nMétodo {}", remote.target.repository, edit.number, edit.base, edit.head, edit.method)) {
        return Err("merge cancelado".into());
    }
    remote.target.confirm_unchanged(repo)?;
    validate(&remote.observe(&known)?)?;
    let merge_endpoint = remote.endpoint(&format!("pulls/{}/merge", edit.number));
    let result = (remote.exec)("gh", &["api", "--hostname", "github.com", "--method", "PUT", &merge_endpoint,
        "-f", &format!("sha={}", edit.head), "-f", &format!("merge_method={}", edit.method)]);
    let updated = remote.observe(&known);
    if let Ok(pull) = &updated {
        if pull.state == "MERGED" && pull.head == edit.head { return Ok(pull.clone()); }
    }
    result?;
    Err("GitHub todavía no confirma el merge. Actualiza el estado".into())
}

pub fn merged_worktree(conn: &Connection, session: &crate::db::Session) -> CmdResult<bool> {
    let Some(path) = session.worktree.as_deref().map(Path::new).filter(|path| path.is_dir()) else { return Ok(false); };
    let Ok(target) = Target::read(path) else { return Ok(false); };
    if session.branch.as_deref() != Some(&target.branch) || !value(path, &["status", "--porcelain"])?.is_empty() {
        return Ok(false);
    }
    let pulls = github::pulls(conn, &session.project, Some(&target.repository), &target.branch)?;
    Ok(pulls.iter().any(|pull| pull.state == "MERGED" && pull.head == target.head))
}

#[tauri::command]
pub fn pr_review_merge(state: tauri::State<AppState>, path: String, session: Option<i64>, edit: Merge) -> CmdResult<Review> {
    let project = project(&state, &path)?;
    let dir = crate::isolate::work_dir(&state, &project, session)?;
    let target = Target::read(&dir)?;
    let conn = state.db.lock().map_err(err)?;
    let known = github::pulls(&conn, &project, Some(&target.repository), &target.branch)?
        .into_iter().find(|pull| pull.number == edit.number && pull.head == edit.head && pull.base == edit.base && pull.merge_ready())
        .ok_or("actualiza el estado de la PR antes de revisar el merge")?;
    state.approvals.prepare(("pr_merge", &project, session, &target, &edit),
        format!("Fusionar {}/#{} hacia {} · {} · {}", target.repository, known.number, edit.base, edit.head, edit.method), &edit.head)
}

#[tauri::command]
pub async fn pr_merge(app: AppHandle, path: String, session: Option<i64>, edit: Merge, proof: Proof) -> CmdResult<Pull> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _gate = state.publication.try_lock().map_err(|_| "ya hay una operación de publicación en curso")?;
        let project = project(&state, &path)?;
        let dir = crate::isolate::work_dir(&state, &project, session)?;
        let target = Target::read(&dir)?;
        let exec = |program: &str, args: &[&str]| run(&dir, program, args);
        let remote = Github { target: &target, project: &project, db: &state.db, exec: &exec };
        state.approvals.consume(("pr_merge", &project, session, &target, &edit), &proof)?;
        let result = merge(&dir, &remote, &edit, |_| true);
        let _ = app.emit("project-changed", ());
        crate::tasks::changed(&app);
        result
    }).await.map_err(err)?
}

/// Abre una PR de GitHub en el navegador.
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
    use std::cell::RefCell;
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("filigranas-pr-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            for args in [
                &["init", "-q", "-b", "main"][..],
                &["config", "user.email", "test@example.invalid"],
                &["config", "user.name", "Test"],
                &["config", "commit.gpgsign", "false"],
                &["commit", "-qm", "base", "--allow-empty"],
                &["update-ref", "refs/remotes/origin/main", "HEAD"],
                &["switch", "-qc", "ide/task"],
                &["commit", "-qm", "feature", "--allow-empty"],
                &["remote", "add", "origin", "https://github.com/owner/repo.git"],
            ] {
                value(&path, args).unwrap();
            }
            Self(path)
        }

        fn edit(&self) -> Publish {
            let target = Target::read(&self.0).unwrap();
            Publish { expected_branch: target.branch, expected_head: target.head, expected_repository: target.repository,
                base: "main".into(), title: "Feature".into(), body: "Proof".into(), draft_pr: false }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Default)]
    struct Server {
        pushes: usize,
        creates: usize,
        merges: usize,
        head: String,
        pull_head: Option<String>,
        offline: bool,
        lost_create: bool,
        merge_state: &'static str,
        review: Option<&'static str>,
        merged: bool,
    }

    impl Server {
        fn rest(&self) -> Value {
            json!({
                "number": 7, "html_url": "https://github.com/owner/repo/pull/7",
                "state": if self.merged { "closed" } else { "open" },
                "merged_at": self.merged.then_some("2026-11-18T00:00:00Z"),
                "draft": false, "head": {"ref":"ide/task","sha":self.pull_head,"repo":{"full_name":"Owner/Repo"}},
                "base": {"ref":"main"}
            })
        }

        fn exec(&mut self, program: &str, args: &[&str]) -> CmdResult<String> {
            match (program, args.first().copied()) {
                ("git", Some("ls-remote")) => Ok(if self.head.is_empty() { String::new() } else {
                    format!("{}\trefs/heads/ide/task\n", self.head)
                }),
                ("git", Some("push")) => {
                    self.pushes += 1;
                    assert!(!args.iter().any(|arg| arg.starts_with("--force")));
                    assert_eq!(args[4], "https://github.com/owner/repo.git");
                    let (head,dest) = args[5].split_once(':').unwrap();
                    assert_eq!(dest, "refs/heads/ide/task");
                    self.head = head.into();
                    if self.pull_head.is_some() { self.pull_head = Some(self.head.clone()); }
                    Ok(String::new())
                }
                ("gh", _) if self.offline => Err("offline".into()),
                ("gh", _) if args.contains(&"GET") => Ok(if self.pull_head.is_some() { json!([[self.rest()]]).to_string() } else { "[]".into() }),
                ("gh", _) if args.contains(&"POST") => {
                    self.creates += 1;
                    assert!(self.pull_head.is_none(), "se intentó duplicar la PR");
                    self.pull_head = Some(self.head.clone());
                    if self.lost_create {
                        self.offline = true;
                        return Err("se perdió la respuesta".into());
                    }
                    Ok(self.rest().to_string())
                }
                ("gh", _) if args.contains(&"PUT") => {
                    self.merges += 1;
                    assert!(args.contains(&format!("sha={}",self.pull_head.as_deref().unwrap()).as_str()));
                    assert!(!args.contains(&"--admin"));
                    self.merged = true;
                    Ok(json!({"merged":true}).to_string())
                }
                ("gh", Some("pr")) => Ok(json!({
                    "number":7,"url":"https://github.com/owner/repo/pull/7","state":if self.merged {"MERGED"} else {"OPEN"},
                    "headRefName":"ide/task","headRefOid":self.pull_head,"baseRefName":"main","isDraft":false,"isCrossRepository":false,
                    "mergeStateStatus":self.merge_state,"reviewDecision":self.review,
                    "statusCheckRollup":[{"conclusion":"SUCCESS"}],
                }).to_string()),
                _ => panic!("orden no prevista: {program} {args:?}"),
            }
        }
    }

    #[test]
    fn retries_reconcile_after_lost_response_and_restart_without_creating_twice() {
        let fixture = Fixture::new();
        let target = Target::read(&fixture.0).unwrap();
        let edit = fixture.edit();
        let server = RefCell::new(Server { lost_create: true, ..Default::default() });
        let exec = |program: &str, args: &[&str]| server.borrow_mut().exec(program, args);
        let path = fixture.0.join("test.sqlite");
        let db = Mutex::new(crate::db::open(&path).unwrap());
        let remote = Github { target: &target, project: "repo", db: &db, exec: &exec };
        assert!(publish(&fixture.0, &remote, &edit, |_| true).unwrap_err().contains("no confirmó"));
        assert_eq!((server.borrow().pushes,server.borrow().creates), (1,1));
        drop(db);

        let db = Mutex::new(crate::db::open(&path).unwrap());
        let remote = Github { target: &target, project: "repo", db: &db, exec: &exec };
        assert!(publish(&fixture.0, &remote, &edit, |_| panic!("no se consulta aprobación offline")).is_err());
        server.borrow_mut().offline = false;
        let pull = publish(&fixture.0, &remote, &edit, |_| panic!("una lectura no necesita aprobación")).unwrap();
        assert_eq!(pull.number, 7);
        assert_eq!((server.borrow().pushes,server.borrow().creates), (1,1));
        let stored = github::pulls(&db.lock().unwrap(), "repo", Some("owner/repo"), "ide/task").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].checks_state, "success");
    }

    #[test]
    fn unknown_create_is_not_repeated_while_github_cannot_reconcile_it() {
        let fixture = Fixture::new();
        let target = Target::read(&fixture.0).unwrap();
        let edit = fixture.edit();
        let db = Mutex::new(crate::db::open(Path::new(":memory:")).unwrap());
        let journal = Publication { project: "repo", repository: &target.repository, branch: &target.branch, base: &edit.base, oid: &target.head };
        journal.set_pending(&db.lock().unwrap(), true).unwrap();
        let server = RefCell::new(Server::default());
        let exec = |program: &str, args: &[&str]| server.borrow_mut().exec(program, args);
        let remote = Github { target: &target, project: "repo", db: &db, exec: &exec };
        assert!(publish(&fixture.0, &remote, &edit, |_| panic!("estado incierto")).unwrap_err().contains("intento anterior"));
        assert_eq!((server.borrow().pushes,server.borrow().creates), (0,0));
    }

    #[test]
    fn a_declined_approval_or_changed_head_cannot_push_or_create() {
        let fixture = Fixture::new();
        let target = Target::read(&fixture.0).unwrap();
        let edit = fixture.edit();
        let db = Mutex::new(crate::db::open(Path::new(":memory:")).unwrap());
        let server = RefCell::new(Server::default());
        let exec = |program: &str, args: &[&str]| server.borrow_mut().exec(program, args);
        let remote = Github { target: &target, project: "repo", db: &db, exec: &exec };
        assert_eq!(publish(&fixture.0, &remote, &edit, |_| false).unwrap_err(), "publicación cancelada");
        let changed = publish(&fixture.0, &remote, &edit, |_| {
            value(&fixture.0, &["commit", "-qm", "concurrente", "--allow-empty"]).unwrap();
            true
        });
        assert!(changed.unwrap_err().contains("cambió"));
        assert_eq!((server.borrow().pushes,server.borrow().creates), (0,0));
    }

    #[test]
    fn merge_requires_fresh_branch_requirements_and_separate_approval() {
        let fixture = Fixture::new();
        let target = Target::read(&fixture.0).unwrap();
        let db = Mutex::new(crate::db::open(Path::new(":memory:")).unwrap());
        let server = RefCell::new(Server { pull_head: Some(target.head.clone()), merge_state: "BLOCKED", review: Some("REVIEW_REQUIRED"), ..Default::default() });
        let exec = |program: &str, args: &[&str]| server.borrow_mut().exec(program, args);
        let remote = Github { target: &target, project: "repo", db: &db, exec: &exec };
        remote.save(&from_rest(&server.borrow().rest()).unwrap()).unwrap();
        let edit = Merge { number: 7, head: target.head.clone(), base: "main".into(), method: "merge".into() };
        assert!(merge(&fixture.0, &remote, &edit, |_| panic!("la rama está bloqueada")).is_err());
        server.borrow_mut().merge_state = "CLEAN";
        server.borrow_mut().review = Some("APPROVED");
        assert_eq!(merge(&fixture.0, &remote, &edit, |_| false).unwrap_err(), "merge cancelado");
        assert!(merge(&fixture.0, &remote, &edit, |_| {
            server.borrow_mut().merge_state = "BLOCKED";
            true
        }).is_err());
        assert_eq!(server.borrow().merges, 0);
        server.borrow_mut().merge_state = "CLEAN";
        assert_eq!(merge(&fixture.0, &remote, &edit, |_| true).unwrap().state, "MERGED");
        assert_eq!(merge(&fixture.0, &remote, &edit, |_| panic!("ya está fusionada")).unwrap().state, "MERGED");
        assert_eq!(server.borrow().merges, 1);
    }

    #[test]
    fn remote_identity_and_missing_checks_fail_closed() {
        assert_eq!(repository("git@github.com:Owner/Repo.git").as_deref(), Some("owner/repo"));
        assert_eq!(repository("https://github.com.evil.test/Owner/Repo.git"), None);
        assert_eq!(repository("https://github.com/../../Owner/Repo.git"), None);
        let missing = details(&json!({
            "number":7,"url":"https://github.com/owner/repo/pull/7","state":"OPEN",
            "headRefName":"ide/task","headRefOid":"oid","baseRefName":"main","isDraft":false,"mergeStateStatus":"CLEAN"
        })).unwrap();
        assert_eq!(missing.checks_state, "unknown");
        assert!(!missing.merge_ready());
    }

    #[test]
    fn title_and_body_from_commits() {
        assert_eq!(compose("ide/task", &["fix: cambio".into()]).0, "fix: cambio");
        let (title, body) = compose("feat/git-local", &["feat: a".into(), "test: b".into()]);
        assert_eq!(title, "git local");
        assert!(body.contains("- feat: a\n- test: b"));
    }

    #[test]
    fn draft_blocks_without_remote() {
        let fixture = Fixture::new();
        value(&fixture.0, &["remote", "remove", "origin"]).unwrap();
        assert_eq!(Target::read(&fixture.0).unwrap_err(), "el repositorio no tiene remoto origin");
    }

    #[test]
    #[ignore]
    fn real_draft_on_this_repo() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        assert!(local_draft(repo, None).unwrap().bases.contains(&"main".to_string()));
    }

    /// Consulta GitHub en modo de solo lectura.
    #[test]
    #[ignore]
    fn real_github_pull() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let exec = |program: &str, args: &[&str]| run(repo, program, args);
        let target = Target { branch: "codex/integrar-main".into(), head: String::new(),
            url: "https://github.com/BilalGates/filigranas-ide.git".into(), repository: "bilalgates/filigranas-ide".into() };
        let db = Mutex::new(crate::db::open(Path::new(":memory:")).unwrap());
        let remote = Github { target: &target, project: "repo", db: &db, exec: &exec };
        let known = remote.list().unwrap().into_iter().find(|pull| pull.number == 6).unwrap();
        let info = remote.observe(&known).unwrap();
        assert_eq!(info.state, "MERGED");
        assert_eq!(info.base, "main");
    }
}
