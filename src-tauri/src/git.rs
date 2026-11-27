use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{err, files, workspace::project_path, AppState, CmdResult};

// Lectura de Git con la CLI `git` del sistema: ya está instalada, conoce la
// configuración del usuario y ya resuelve el orden del historial; los
// carriles del gráfico se calculan en la interfaz a partir de los padres. Ninguno de estos comandos escribe en el repositorio:
// `--no-optional-locks` evita incluso refrescar el índice, para no chocar
// con un agente que esté trabajando a la vez.

pub(crate) fn git(repo: &Path, args: &[&str]) -> CmdResult<Vec<u8>> {
    let out = git_output(repo, args)?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub(crate) fn git_output(repo: &Path, args: &[&str]) -> CmdResult<std::process::Output> {
    let mut cmd = crate::cli::command("git");
    cmd.arg("-C")
        .arg(repo)
        .args(["--no-optional-locks", "-c", "core.quotepath=off", "-c", "color.ui=never"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    cmd.output().map_err(|e| format!("no se pudo ejecutar git: {e}"))
}

fn repo(state: &AppState, project: &str) -> CmdResult<PathBuf> {
    Ok(PathBuf::from(project_path(&*state.db.lock().map_err(err)?, project)?))
}

/// Ruta relativa al repositorio tal como la da `git status`. Rechaza rutas
/// absolutas y `..` para que nunca se salga del proyecto.
pub(crate) fn relative(path: &str) -> CmdResult<&str> {
    let ok = !path.is_empty() && Path::new(path).components().all(|c| matches!(c, Component::Normal(_)));
    if ok {
        Ok(path)
    } else {
        Err(format!("ruta no válida: {path}"))
    }
}

pub(crate) fn valid_ref(reference: &str) -> CmdResult<&str> {
    let r = reference.trim();
    if r.is_empty()
        || r.starts_with('-')
        || r.contains("..")
        || r.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return Err(format!("referencia Git no válida: {reference}"));
    }
    Ok(r)
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    /// Ruta anterior en un renombrado.
    pub orig: Option<String>,
    /// M, A, D, R, U (sin seguimiento) o ! (conflicto).
    pub status: char,
    /// Estado en el índice (staged), si existe.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged: Option<char>,
    /// Estado en el árbol de trabajo (unstaged), si existe.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unstaged: Option<char>,
    pub adds: Option<u32>,
    pub dels: Option<u32>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `None` con la cabeza separada; entonces `head` es el commit.
    branch: Option<String>,
    head: Option<String>,
    head_sha: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    changes: Vec<Change>,
}

/// Interpreta `git status --porcelain=v2 --branch -z`.
fn parse_status(out: &str) -> Status {
    let mut s = Status::default();
    let mut fields = out.split('\0');
    while let Some(entry) = fields.next() {
        let mut parts = entry.splitn(2, ' ');
        let (kind, rest) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let letter = |xy: &str| {
            let mut c = xy.chars();
            let (x, y) = (c.next().unwrap_or('.'), c.next().unwrap_or('.'));
            if y != '.' { y } else { x }
        };
        match kind {
            "#" => {
                let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
                match key {
                    "branch.oid" if value != "(initial)" => {
                        s.head = Some(value.chars().take(7).collect());
                        s.head_sha = Some(value.into());
                    }
                    "branch.head" if value != "(detached)" => s.branch = Some(value.into()),
                    "branch.upstream" => s.upstream = Some(value.into()),
                    "branch.ab" => {
                        let mut ab = value.split(' ').map(|n| n.trim_start_matches(['+', '-']).parse().unwrap_or(0));
                        s.ahead = ab.next().unwrap_or(0);
                        s.behind = ab.next().unwrap_or(0);
                    }
                    _ => {}
                }
            }
            "1" | "2" | "u" => {
                // Campos fijos antes de la ruta: 7 en «1», 8 en «2», 9 en «u».
                let skip = match kind { "1" => 7, "2" => 8, _ => 9 };
                let cols: Vec<&str> = rest.splitn(skip + 1, ' ').collect();
                let path = cols.get(skip).unwrap_or(&"").to_string();
                let orig = (kind == "2").then(|| fields.next().unwrap_or("").to_string());
                let (staged, unstaged) = if kind == "u" {
                    (Some('!'), Some('!'))
                } else {
                    let mut xy = cols[0].chars();
                    let x = xy.next().unwrap_or('.');
                    let y = xy.next().unwrap_or('.');
                    ((x != '.').then_some(x), (y != '.').then_some(y))
                };
                let status = match kind { "u" => '!', "2" => 'R', _ => letter(cols[0]) };
                s.changes.push(Change { path, orig, status, staged, unstaged, adds: None, dels: None });
            }
            "?" => s.changes.push(Change { path: rest.into(), orig: None, status: 'U', staged: None, unstaged: Some('U'), adds: None, dels: None }),
            _ => {}
        }
    }
    s
}

/// Añade líneas añadidas/eliminadas desde `git diff HEAD --numstat -z`.
/// Los binarios («-») quedan sin contar.
fn apply_numstat(changes: &mut [Change], out: &str) {
    let mut by_path: std::collections::HashMap<_, _> = changes.iter_mut()
        .map(|change| (change.path.clone(), change)).collect();
    let mut fields = out.split('\0');
    while let Some(entry) = fields.next() {
        let mut cols = entry.splitn(3, '\t');
        let (adds, dels) = (cols.next().unwrap_or("").parse().ok(), cols.next().unwrap_or("").parse().ok());
        let mut path = cols.next().unwrap_or("").to_string();
        if path.is_empty() {
            // Renombrado: siguen la ruta anterior y la nueva.
            fields.next();
            path = fields.next().unwrap_or("").to_string();
        }
        if let Some(c) = by_path.get_mut(&path) {
            c.adds = adds;
            c.dels = dels;
        }
    }
}

#[tauri::command]
pub async fn git_status(app: tauri::AppHandle, project: String) -> CmdResult<Status> {
    crate::background_read(app, move |state| status_at(&repo(state, &project)?, "HEAD")).await
}

#[tauri::command]
pub async fn git_head(app: tauri::AppHandle, project: String) -> CmdResult<String> {
    crate::background_read(app, move |state| head_at(&repo(state, &project)?)).await
}

pub(crate) fn head_at(repo: &Path) -> CmdResult<String> {
    match git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        Ok(branch) => Ok(String::from_utf8_lossy(&branch).trim().to_owned()),
        Err(_) => git(repo, &["rev-parse", "--short", "HEAD"])
            .map(|head| format!("HEAD · {}", String::from_utf8_lossy(&head).trim())),
    }
}

/// Estado de una rama de sesión: archivos que difieren del commit del que
/// partió, estén o no en commits (`git diff <base>` sobre el árbol de
/// trabajo). Añade los archivos sin seguimiento del estado de Git.
pub(crate) fn status_since(repo: &Path, base: &str) -> CmdResult<Status> {
    let out = git(repo, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
    let mut status = parse_status(&String::from_utf8_lossy(&out));
    let out = git(repo, &["diff", "--name-status", "--no-renames", "-z", base])?;
    let out = String::from_utf8_lossy(&out).into_owned();
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    let mut changes = Vec::new();
    while let (Some(code), Some(path)) = (parts.next(), parts.next()) {
        let status = match code.chars().next() {
            Some('A') => 'A',
            Some('D') => 'D',
            Some('U') => '!',
            _ => 'M',
        };
        changes.push(Change { path: path.to_string(), orig: None, status, staged: None, unstaged: None, adds: None, dels: None });
    }
    let out = git(repo, &["diff", base, "--numstat", "-z"])?;
    apply_numstat(&mut changes, &String::from_utf8_lossy(&out));
    for mut untracked in status.changes.into_iter().filter(|c| c.status == 'U') {
        if !changes.iter().any(|c| c.path == untracked.path) {
            untracked.status = 'A';
            changes.push(untracked);
        }
    }
    status.changes = changes;
    Ok(status)
}

/// Estado de un árbol de trabajo. Los contadores se calculan frente a
/// `against` (HEAD, o el commit del que partió una sesión aislada).
pub(crate) fn status_at(repo: &Path, against: &str) -> CmdResult<Status> {
    let out = git(repo, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
    let mut status = parse_status(&String::from_utf8_lossy(&out));
    if status.head.is_some() {
        let out = git(repo, &["diff", against, "--numstat", "-z"])?;
        apply_numstat(&mut status.changes, &String::from_utf8_lossy(&out));
    }
    Ok(status)
}

#[derive(Serialize)]
pub struct DiffTexts {
    old: String,
    new: String,
}

/// Versión en HEAD y versión en disco de un archivo cambiado, para el diff.
/// Un archivo nuevo no tiene versión antigua; uno borrado, nueva.
#[tauri::command]
pub async fn git_diff_texts(app: tauri::AppHandle, project: String, path: String, orig: Option<String>) -> CmdResult<DiffTexts> {
    crate::background_read(app, move |state| diff_texts_at(&repo(state, &project)?, "HEAD", &path, orig.as_deref())).await
}

/// Versión en `against` y versión en disco de un archivo de `repo`.
pub(crate) fn diff_texts_at(repo: &Path, against: &str, path: &str, orig: Option<&str>) -> CmdResult<DiffTexts> {
    let repo = repo.to_path_buf();
    let path = relative(path)?;
    let before = relative(orig.unwrap_or(path))?;
    let old = match git(&repo, &["cat-file", "blob", &format!("{against}:{before}")]) {
        Ok(bytes) => files::text(bytes)?,
        Err(_) => String::new(),
    };
    let file = repo.join(path);
    let new = if file.exists() { files::read_file(&crate::paths::inside(&repo, &file)?)? } else { String::new() };
    Ok(DiffTexts { old, new })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct LogRow {
    hash: String,
    /// Padres abreviados; el primero es la línea principal.
    parents: Vec<String>,
    refs: String,
    author: String,
    date: String,
    subject: String,
}

const LOG_LIMIT: &str = "-n200";

fn parse_log(out: &str) -> Vec<LogRow> {
    out.lines()
        .map(|line| {
            let mut cols = line.splitn(6, '\x1f');
            let mut col = || cols.next().unwrap_or("").to_string();
            let hash = col();
            let parents = col().split_whitespace().map(str::to_string).collect();
            LogRow { hash, parents, refs: col(), author: col(), date: col(), subject: col() }
        })
        .collect()
}

/// Historial de todas las ramas locales y remotas conocidas, el más
/// reciente primero. Un repositorio sin commits devuelve una lista vacía.
#[tauri::command]
pub async fn git_log(app: tauri::AppHandle, project: String) -> CmdResult<Vec<LogRow>> {
    crate::background_read(app, move |state| {
        let out = log_at(&repo(state, &project)?, "--format=%h%x1f%p%x1f%D%x1f%aN%x1f%aI%x1f%s")?;
        Ok(parse_log(&String::from_utf8_lossy(&out)))
    }).await
}

fn log_at(repo: &Path, format: &str) -> CmdResult<Vec<u8>> {
    git(repo, &["log", "--branches", "--remotes", "--tags", "HEAD", "--topo-order", LOG_LIMIT, format])
}

pub(crate) fn commit_dates(repo: &Path) -> CmdResult<Vec<String>> {
    let out = log_at(repo, "--format=%aI")?;
    Ok(String::from_utf8_lossy(&out).lines().map(str::to_owned).collect())
}

/// Ramas locales, por nombre.
#[tauri::command]
pub async fn git_branches(app: tauri::AppHandle, project: String) -> CmdResult<Vec<String>> {
    crate::background_read(app, move |state| {
        let out = git(&repo(state, &project)?, &["for-each-ref", "--format=%(refname:short)", "--sort=refname", "refs/heads"])?;
        Ok(String::from_utf8_lossy(&out).lines().map(str::to_string).collect())
    }).await
}

/// Cambia a una rama local existente. Es la única escritura de este módulo:
/// sin `--force`, así que Git se niega si se perderían cambios sin commit y
/// el error llega tal cual a la interfaz. `--no-guess` evita crear ramas a
/// partir de una remota con el mismo nombre.
#[tauri::command]
pub async fn git_switch(app: AppHandle, project: String, branch: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _git = state.publication.try_lock().map_err(|_| "hay una operación Git en curso")?;
        let conn = state.db.lock().map_err(err)?;
        let project = project_path(&conn, &project)?;
        crate::work::idle(&conn, &project)?;
        if let Some(work) = crate::work::current(&conn, &project)?.filter(|w| w.state != "finished") {
            if branch != work.branch { return Err(format!("finaliza la sesión de trabajo antes de cambiar la rama {}", work.branch)); }
        }
        drop(conn);
        switch(Path::new(&project), &branch)
    }).await.map_err(err)?
}

fn switch(repo: &Path, branch: &str) -> CmdResult<()> {
    if branch.starts_with('-') || git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_err() {
        return Err(format!("no existe la rama local «{branch}»"));
    }
    git(repo, &["switch", "--no-guess", branch]).map(|_| ())
}

// ── Explorador de ramas y comparación sin checkout ───────────────────────

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchAgentRef {
    pub session_id: i64,
    pub name: String,
    pub engine: String,
    pub worktree: Option<String>,
    pub active: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchEntry {
    pub name: String,
    /// Referencia Git preferida para inspección sin checkout.
    pub ref_name: String,
    pub local: bool,
    pub remote: bool,
    pub remote_name: Option<String>,
    pub remote_ref: Option<String>,
    pub upstream: Option<String>,
    pub published: bool,
    pub active: bool,
    pub is_default: bool,
    pub ahead: u32,
    pub behind: u32,
    pub diverged: bool,
    pub head_oid: String,
    pub short_oid: String,
    pub subject: String,
    pub author: String,
    pub committed_at: String,
    pub merged_into_default: bool,
    pub worktree_path: Option<String>,
    pub agents: Vec<BranchAgentRef>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchInventory {
    pub active_branch: Option<String>,
    pub head_sha: Option<String>,
    pub default_branch: String,
    pub default_ref: String,
    pub has_remote: bool,
    pub repository: Option<String>,
    pub branches: Vec<BranchEntry>,
}

/// Detecta la rama por defecto real del repositorio sin asumir `main` a ciegas.
pub(crate) fn default_branch_info(repo: &Path) -> (String, String) {
    if let Ok(raw) = git(repo, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        let s = String::from_utf8_lossy(&raw).trim().to_string();
        if let Some(name) = s.strip_prefix("origin/").filter(|n| !n.is_empty()) {
            return (name.to_string(), format!("refs/remotes/origin/{name}"));
        }
    }
    for cand in ["main", "master"] {
        if git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{cand}")]).is_ok() {
            return (cand.into(), format!("refs/remotes/origin/{cand}"));
        }
        if git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{cand}")]).is_ok() {
            return (cand.into(), format!("refs/heads/{cand}"));
        }
    }
    if let Ok(raw) = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        let active = String::from_utf8_lossy(&raw).trim().to_string();
        if !active.is_empty() {
            return (active.clone(), format!("refs/heads/{active}"));
        }
    }
    ("main".into(), "refs/heads/main".into())
}

fn worktree_branches(repo: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(raw) = git(repo, &["worktree", "list", "--porcelain"]) else { return map };
    let text = String::from_utf8_lossy(&raw);
    let mut cur_path: Option<String> = None;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur_path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            if let Some(p) = cur_path.clone() {
                map.entry(b.trim().to_string()).or_insert(p);
            }
        } else if line.trim().is_empty() {
            cur_path = None;
        }
    }
    map
}

fn rev_counts(repo: &Path, left: &str, right: &str) -> (u32, u32) {
    let Ok(out) = git(repo, &["rev-list", "--left-right", "--count", &format!("{left}...{right}")]) else {
        return (0, 0);
    };
    let s = String::from_utf8_lossy(&out);
    let mut parts = s.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
    let behind = parts.next().unwrap_or(0);
    let ahead = parts.next().unwrap_or(0);
    (ahead, behind)
}

pub(crate) fn branch_inventory_at(repo: &Path, agents_by_branch: &std::collections::HashMap<String, Vec<BranchAgentRef>>) -> CmdResult<BranchInventory> {
    let active_branch = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| !s.is_empty());
    let head_sha = git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .ok()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| !s.is_empty());
    let (default_branch, default_ref) = default_branch_info(repo);
    let remote_url = git(repo, &["remote", "get-url", "origin"])
        .ok()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| !s.is_empty());
    let has_remote = remote_url.is_some();
    let repository = remote_url.as_deref().and_then(crate::pr::repository);
    let wt_map = worktree_branches(repo);
    let main_repo_canon = std::fs::canonicalize(repo).ok();

    // Ramas ya integradas en la rama por defecto en una sola llamada Git.
    let merged_refs: std::collections::HashSet<String> = git(
        repo,
        &["for-each-ref", "--format=%(refname)", &format!("--merged={default_ref}"), "refs/heads", "refs/remotes"],
    )
    .map(|raw| String::from_utf8_lossy(&raw).lines().map(str::to_string).collect())
    .unwrap_or_default();

    let fmt = "%(refname)%00%(refname:short)%00%(objectname)%00%(objectname:short)%00%(upstream:short)%00%(committerdate:iso-strict)%00%(authorname)%00%(subject)";
    let raw = git(repo, &["for-each-ref", &format!("--format={fmt}"), "--sort=-committerdate", "refs/heads", "refs/remotes"])?;
    let text = String::from_utf8_lossy(&raw);

    let mut entries: std::collections::BTreeMap<String, BranchEntry> = std::collections::BTreeMap::new();
    let mut remote_only_rows: Vec<(String, String, String, String, String, String, String, String)> = Vec::new();

    for line in text.lines().filter(|l| !l.is_empty()) {
        let cols: Vec<&str> = line.split('\0').collect();
        if cols.len() < 8 { continue; }
        let (full_ref, short, oid, short_oid, upstream, date, author, subject) =
            (cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], cols[6], cols[7]);
        if let Some(name) = full_ref.strip_prefix("refs/heads/") {
            let upstream_opt = (!upstream.is_empty()).then(|| upstream.to_string());
            let (ahead, behind) = match &upstream_opt {
                Some(up) => rev_counts(repo, up, full_ref),
                None => (0, 0),
            };
            let wt = wt_map.get(name).and_then(|p| {
                let is_main = main_repo_canon.as_ref().is_some_and(|m| std::fs::canonicalize(p).ok().as_ref() == Some(m));
                (!is_main).then(|| p.clone())
            });
            let agents = agents_by_branch.get(name).cloned().unwrap_or_default();
            let is_default = name == default_branch;
            entries.insert(
                name.to_string(),
                BranchEntry {
                    name: name.to_string(),
                    ref_name: full_ref.to_string(),
                    local: true,
                    remote: false,
                    remote_name: None,
                    remote_ref: None,
                    upstream: upstream_opt,
                    published: false,
                    active: active_branch.as_deref() == Some(name),
                    is_default,
                    ahead,
                    behind,
                    diverged: ahead > 0 && behind > 0,
                    head_oid: oid.to_string(),
                    short_oid: short_oid.to_string(),
                    subject: subject.to_string(),
                    author: author.to_string(),
                    committed_at: date.to_string(),
                    merged_into_default: !is_default && merged_refs.contains(full_ref),
                    worktree_path: wt,
                    agents,
                },
            );
        } else if let Some(rest) = full_ref.strip_prefix("refs/remotes/") {
            let Some((rem, branch)) = rest.split_once('/') else { continue };
            if branch == "HEAD" { continue; }
            remote_only_rows.push((
                rem.to_string(),
                branch.to_string(),
                short.to_string(),
                full_ref.to_string(),
                oid.to_string(),
                short_oid.to_string(),
                date.to_string(),
                format!("{author}\0{subject}"),
            ));
        }
    }

    for (rem, branch, short, full_ref, oid, short_oid, date, meta) in remote_only_rows {
        let (author, subject) = meta.split_once('\0').unwrap_or(("", ""));
        if let Some(entry) = entries.get_mut(&branch) {
            // Prioriza `origin` si existe más de un remoto.
            if entry.remote_name.is_none() || rem == "origin" {
                entry.remote = true;
                entry.published = true;
                entry.remote_name = Some(rem);
                entry.remote_ref = Some(short.clone());
                if entry.upstream.is_none() {
                    let (ahead, behind) = rev_counts(repo, &full_ref, &entry.ref_name);
                    entry.ahead = ahead;
                    entry.behind = behind;
                    entry.diverged = ahead > 0 && behind > 0;
                }
            }
        } else {
            let is_default = branch == default_branch;
            let agents = agents_by_branch.get(&branch).cloned().unwrap_or_default();
            entries.insert(
                branch.clone(),
                BranchEntry {
                    name: branch,
                    ref_name: full_ref.clone(),
                    local: false,
                    remote: true,
                    remote_name: Some(rem),
                    remote_ref: Some(short),
                    upstream: None,
                    published: true,
                    active: false,
                    is_default,
                    ahead: 0,
                    behind: 0,
                    diverged: false,
                    head_oid: oid,
                    short_oid,
                    subject: subject.to_string(),
                    author: author.to_string(),
                    committed_at: date,
                    merged_into_default: !is_default && merged_refs.contains(&full_ref),
                    worktree_path: None,
                    agents,
                },
            );
        }
    }

    let mut branches: Vec<BranchEntry> = entries.into_values().collect();
    branches.sort_by(|a, b| {
        b.active.cmp(&a.active)
            .then_with(|| b.is_default.cmp(&a.is_default))
            .then_with(|| b.local.cmp(&a.local))
            .then_with(|| b.committed_at.cmp(&a.committed_at))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(BranchInventory {
        active_branch,
        head_sha,
        default_branch,
        default_ref,
        has_remote,
        repository,
        branches,
    })
}

#[tauri::command]
pub async fn git_branch_inventory(app: AppHandle, project: String) -> CmdResult<BranchInventory> {
    crate::background_read(app, move |state| {
        let (project_dir, agents_by_branch) = {
            let conn = state.db.lock().map_err(err)?;
            let dir = project_path(&conn, &project)?;
            let sessions = crate::db::sessions(&conn, &dir).unwrap_or_default();
            let mut map: std::collections::HashMap<String, Vec<BranchAgentRef>> = std::collections::HashMap::new();
            for s in sessions {
                if let Some(branch) = s.branch.clone() {
                    let active = state.tracker.get(s.id).running;
                    map.entry(branch).or_default().push(BranchAgentRef {
                        session_id: s.id,
                        name: s.name,
                        engine: s.engine,
                        worktree: s.worktree,
                        active,
                    });
                }
            }
            (dir, map)
        };
        branch_inventory_at(Path::new(&project_dir), &agents_by_branch)
    }).await
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub base_ref: String,
    pub head_ref: String,
    pub merge_base: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<Change>,
}

pub(crate) fn compare_branch_at(repo: &Path, head_ref: &str, base_ref: Option<&str>) -> CmdResult<CompareResult> {
    let head_ref = valid_ref(head_ref)?;
    let (_, default_ref) = default_branch_info(repo);
    let base = match base_ref {
        Some(b) => valid_ref(b)?.to_string(),
        None => default_ref,
    };
    git(repo, &["rev-parse", "--verify", "--quiet", head_ref])
        .map_err(|_| format!("no se encontró la referencia «{head_ref}»"))?;
    if git(repo, &["rev-parse", "--verify", "--quiet", &base]).is_err() {
        return Ok(CompareResult {
            base_ref: base,
            head_ref: head_ref.into(),
            merge_base: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
        });
    }
    let merge_base = git(repo, &["merge-base", &base, head_ref])
        .ok()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| !s.is_empty());
    let (ahead, behind) = rev_counts(repo, &base, head_ref);
    let Some(mb) = merge_base.clone() else {
        return Ok(CompareResult {
            base_ref: base,
            head_ref: head_ref.into(),
            merge_base: None,
            ahead,
            behind,
            files: Vec::new(),
        });
    };
    let range = format!("{mb}..{head_ref}");
    let out = git(repo, &["diff", "--name-status", "-M", "-z", &range])?;
    let text = String::from_utf8_lossy(&out).into_owned();
    let mut parts = text.split('\0').filter(|p| !p.is_empty());
    let mut files = Vec::new();
    while let Some(code) = parts.next() {
        let ch = code.chars().next().unwrap_or('M');
        if ch == 'R' || ch == 'C' {
            let Some(orig) = parts.next() else { break };
            let Some(path) = parts.next() else { break };
            files.push(Change {
                path: path.to_string(),
                orig: Some(orig.to_string()),
                status: 'R',
                staged: None,
                unstaged: None,
                adds: None,
                dels: None,
            });
        } else {
            let Some(path) = parts.next() else { break };
            let status = match ch {
                'A' => 'A',
                'D' => 'D',
                'U' => '!',
                _ => 'M',
            };
            files.push(Change {
                path: path.to_string(),
                orig: None,
                status,
                staged: None,
                unstaged: None,
                adds: None,
                dels: None,
            });
        }
    }
    if !files.is_empty() {
        let numstat = git(repo, &["diff", "--numstat", "-M", "-z", &range])?;
        apply_numstat(&mut files, &String::from_utf8_lossy(&numstat));
    }
    Ok(CompareResult {
        base_ref: base,
        head_ref: head_ref.into(),
        merge_base,
        ahead,
        behind,
        files,
    })
}

#[tauri::command]
pub async fn git_compare_branch(app: AppHandle, project: String, head_ref: String, base_ref: Option<String>) -> CmdResult<CompareResult> {
    crate::background_read(app, move |state| {
        compare_branch_at(&repo(state, &project)?, &head_ref, base_ref.as_deref())
    }).await
}

fn cat_blob_optional(repo: &Path, spec: &str) -> CmdResult<String> {
    match git(repo, &["cat-file", "blob", spec]) {
        Ok(bytes) => files::text(bytes),
        Err(_) => Ok(String::new()),
    }
}

pub(crate) fn diff_ref_at(
    repo: &Path,
    mode: &str,
    path: &str,
    orig: Option<&str>,
    base_ref: Option<&str>,
    head_ref: Option<&str>,
    commit: Option<&str>,
) -> CmdResult<DiffTexts> {
    let path = relative(path)?;
    let before = relative(orig.unwrap_or(path))?;
    match mode {
        "worktree" => diff_texts_at(repo, "HEAD", path, orig),
        "staged" => {
            let old = cat_blob_optional(repo, &format!("HEAD:{before}"))?;
            let new = cat_blob_optional(repo, &format!(":0:{path}"))?;
            Ok(DiffTexts { old, new })
        }
        "unstaged" => {
            let old = match git(repo, &["cat-file", "blob", &format!(":0:{before}")]) {
                Ok(bytes) => files::text(bytes)?,
                Err(_) => cat_blob_optional(repo, &format!("HEAD:{before}"))?,
            };
            let file = repo.join(path);
            let new = if file.exists() {
                files::read_file(&crate::paths::inside(repo, &file)?)?
            } else {
                String::new()
            };
            Ok(DiffTexts { old, new })
        }
        "range" => {
            let head = valid_ref(head_ref.ok_or("falta head_ref para el diff")?)?;
            let base = valid_ref(base_ref.ok_or("falta base_ref para el diff")?)?;
            let old_ref = git(repo, &["merge-base", base, head])
                .ok()
                .map(|b| String::from_utf8_lossy(&b).trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| base.to_string());
            let old = cat_blob_optional(repo, &format!("{old_ref}:{before}"))?;
            let new = cat_blob_optional(repo, &format!("{head}:{path}"))?;
            Ok(DiffTexts { old, new })
        }
        "commit" => {
            let sha = commit.ok_or("falta commit para el diff")?;
            if sha.is_empty() || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(format!("{sha} no es un hash de commit válido"));
            }
            let parent = git(repo, &["rev-parse", "--verify", "--quiet", &format!("{sha}^")])
                .ok()
                .map(|b| String::from_utf8_lossy(&b).trim().to_string())
                .filter(|s| !s.is_empty());
            let old = match parent {
                Some(p) => cat_blob_optional(repo, &format!("{p}:{before}"))?,
                None => String::new(),
            };
            let new = cat_blob_optional(repo, &format!("{sha}:{path}"))?;
            Ok(DiffTexts { old, new })
        }
        "blob" => {
            let head = valid_ref(head_ref.ok_or("falta head_ref para leer el archivo")?)?;
            let new = cat_blob_optional(repo, &format!("{head}:{path}"))?;
            Ok(DiffTexts { old: String::new(), new })
        }
        other => Err(format!("modo de diff desconocido: {other}")),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn git_diff_ref(
    app: AppHandle,
    project: String,
    mode: String,
    path: String,
    orig: Option<String>,
    base_ref: Option<String>,
    head_ref: Option<String>,
    commit: Option<String>,
    session: Option<i64>,
) -> CmdResult<DiffTexts> {
    crate::background_read(app, move |state| {
        let dir = if session.is_some() {
            crate::isolate::work_dir(state, &project, session)?
        } else {
            repo(state, &project)?
        };
        diff_ref_at(&dir, &mode, &path, orig.as_deref(), base_ref.as_deref(), head_ref.as_deref(), commit.as_deref())
    }).await
}

/// Historial de una referencia concreta sin hacer checkout.
#[tauri::command]
pub async fn git_branch_log(app: AppHandle, project: String, ref_name: Option<String>, limit: Option<u32>) -> CmdResult<Vec<LogRow>> {
    crate::background_read(app, move |state| {
        let dir = repo(state, &project)?;
        let cap = limit.unwrap_or(80).clamp(1, 200);
        let lim = format!("-n{cap}");
        let fmt = "--format=%h%x1f%p%x1f%D%x1f%aN%x1f%aI%x1f%s";
        let out = match ref_name.as_deref() {
            Some(r) => {
                let r = valid_ref(r)?;
                git(&dir, &["log", r, "--topo-order", &lim, fmt])?
            }
            None => log_at(&dir, fmt)?,
        };
        Ok(parse_log(&String::from_utf8_lossy(&out)))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_with_rename_untracked_and_conflict() {
        let out = "# branch.oid ce227ba9844a60d13c00f803c237e86967283247\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/mi archivo.ts\0\
2 RM N... 100644 100644 100644 aaa aaa R100 b\0a\0\
u UU N... 100644 100644 100644 100644 aaa bbb ccc c.txt\0\
? nuevo.md\0";
        let mut s = parse_status(out);
        assert_eq!((s.branch.as_deref(), s.head.as_deref()), (Some("main"), Some("ce227ba")));
        assert_eq!(s.head_sha.as_deref(), Some("ce227ba9844a60d13c00f803c237e86967283247"));
        assert_eq!((s.upstream.as_deref(), s.ahead, s.behind), (Some("origin/main"), 2, 1));
        let summary: Vec<_> = s.changes.iter().map(|c| (c.status, c.path.as_str(), c.orig.as_deref())).collect();
        assert_eq!(
            summary,
            vec![('M', "src/mi archivo.ts", None), ('R', "b", Some("a")), ('!', "c.txt", None), ('U', "nuevo.md", None)]
        );

        apply_numstat(&mut s.changes, "3\t1\tsrc/mi archivo.ts\x001\t0\t\0a\0b\0-\t-\tc.txt\0");
        let counts: Vec<_> = s.changes.iter().map(|c| (c.adds, c.dels)).collect();
        assert_eq!(counts, vec![(Some(3), Some(1)), (Some(1), Some(0)), (None, None), (None, None)]);
    }

    #[test]
    fn unborn_and_detached() {
        let s = parse_status("# branch.oid (initial)\0# branch.head main\0");
        assert_eq!((s.branch.as_deref(), s.head), (Some("main"), None));
        let s = parse_status("# branch.oid 1234567890\0# branch.head (detached)\0");
        assert_eq!((s.branch, s.head.as_deref()), (None, Some("1234567")));
    }

    #[test]
    fn log_reads_parents() {
        let rows = parse_log("1b5e8ac\x1f76aece4 2c496de\x1fHEAD -> main\x1fBilal\x1f2026-11-19T22:14:00+01:00\x1fMerge\n76aece4\x1f\x1f\x1fBilal\x1f2026-11-18T12:30:00+01:00\x1fplan\n");
        assert_eq!((rows[0].hash.as_str(), rows[0].refs.as_str()), ("1b5e8ac", "HEAD -> main"));
        assert_eq!(rows[0].parents, vec!["76aece4", "2c496de"]);
        assert_eq!(rows[0].author, "Bilal");
        assert_eq!(rows[0].date, "2026-11-19T22:14:00+01:00");
        assert_eq!(rows[0].subject, "Merge");
        assert_eq!((rows[1].parents.len(), rows[1].subject.as_str()), (0, "plan"));
    }

    #[test]
    fn switch_keeps_uncommitted_work() {
        let dir = std::env::temp_dir().join(format!("filigranas-switch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| git(&dir, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "main\n").unwrap();
        run(&["add", "a.txt"]);
        run(&["commit", "-qm", "uno"]);
        run(&["branch", "otra"]);
        std::fs::write(dir.join("a.txt"), "otra\n").unwrap();
        run(&["commit", "-qam", "dos"]);
        let head = || String::from_utf8(run(&["branch", "--show-current"])).unwrap().trim().to_string();

        assert!(switch(&dir, "-f").is_err());
        assert!(switch(&dir, "no-existe").is_err());
        switch(&dir, "otra").unwrap();
        assert_eq!(head(), "otra");

        // Un cambio sin commit que chocaría con la otra rama: Git se niega y
        // el archivo queda intacto.
        std::fs::write(dir.join("a.txt"), "sin guardar\n").unwrap();
        assert!(switch(&dir, "main").is_err());
        assert_eq!((head(), std::fs::read_to_string(dir.join("a.txt")).unwrap()), ("otra".into(), "sin guardar\n".into()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn relative_rejects_escapes() {
        assert!(relative("src/a.ts").is_ok());
        for bad in ["", "../x", "/etc/passwd", "a/../../b", "./a"] {
            assert!(relative(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn status_preserves_staged_and_unstaged_separately() {
        let out = "1 MM N... 100644 100644 100644 aaa bbb src/a.ts\0\
1 A. N... 000000 100644 100644 000 aaa src/b.ts\0\
1 .D N... 100644 100644 000000 aaa 000 src/c.ts\0\
? src/new.ts\0";
        let s = parse_status(out);
        assert_eq!(s.changes[0].staged, Some('M'));
        assert_eq!(s.changes[0].unstaged, Some('M'));
        assert_eq!(s.changes[1].staged, Some('A'));
        assert_eq!(s.changes[1].unstaged, None);
        assert_eq!(s.changes[2].staged, None);
        assert_eq!(s.changes[2].unstaged, Some('D'));
        assert_eq!(s.changes[3].staged, None);
        assert_eq!(s.changes[3].unstaged, Some('U'));
    }

    #[test]
    fn branch_inventory_and_compare_without_checkout() {
        let base = std::env::temp_dir().join(format!("filigranas-inv-{}", uuid::Uuid::new_v4()));
        let remote = base.join("origin.git");
        let repo_dir = base.join("repo");
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(&repo_dir).unwrap();
        let run = |dir: &Path, args: &[&str]| git(dir, args).unwrap();
        run(&remote, &["init", "--bare", "-q", "-b", "develop"]);
        run(&repo_dir, &["init", "-q", "-b", "develop"]);
        run(&repo_dir, &["config", "user.email", "t@t"]);
        run(&repo_dir, &["config", "user.name", "t"]);
        run(&repo_dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        std::fs::write(repo_dir.join("base.txt"), "v1\n").unwrap();
        run(&repo_dir, &["add", "."]);
        run(&repo_dir, &["commit", "-qm", "init"]);
        run(&repo_dir, &["push", "-u", "origin", "develop"]);
        // Configura origin/HEAD -> develop (no main!)
        run(&repo_dir, &["remote", "set-head", "origin", "develop"]);

        // Crea rama feat/x con 1 commit publicado y 1 local extra.
        run(&repo_dir, &["switch", "-c", "feat/x"]);
        std::fs::write(repo_dir.join("feat.txt"), "uno\n").unwrap();
        run(&repo_dir, &["add", "."]);
        run(&repo_dir, &["commit", "-qm", "feat uno"]);
        run(&repo_dir, &["push", "-u", "origin", "feat/x"]);
        std::fs::write(repo_dir.join("feat.txt"), "uno\ndos\n").unwrap();
        run(&repo_dir, &["add", "."]);
        run(&repo_dir, &["commit", "-qm", "feat dos"]);

        // Crea rama solo remota (push y borra local).
        run(&repo_dir, &["switch", "-c", "remota-sola", "develop"]);
        std::fs::write(repo_dir.join("rem.txt"), "remoto\n").unwrap();
        run(&repo_dir, &["add", "."]);
        run(&repo_dir, &["commit", "-qm", "solo remoto"]);
        run(&repo_dir, &["push", "origin", "remota-sola"]);
        run(&repo_dir, &["switch", "develop"]);
        run(&repo_dir, &["branch", "-D", "remota-sola"]);

        // Cambio sucio en develop para demostrar que inspeccionar no hace checkout ni toca disco.
        std::fs::write(repo_dir.join("base.txt"), "v1-sucio\n").unwrap();

        let inv = branch_inventory_at(&repo_dir, &std::collections::HashMap::new()).unwrap();
        assert_eq!(inv.active_branch.as_deref(), Some("develop"));
        assert_eq!(inv.default_branch, "develop");
        let fx = inv.branches.iter().find(|b| b.name == "feat/x").unwrap();
        assert!(fx.local && fx.remote && fx.published && !fx.active);
        assert_eq!((fx.ahead, fx.behind, fx.diverged), (1, 0, false));
        let rs = inv.branches.iter().find(|b| b.name == "remota-sola").unwrap();
        assert!(!rs.local && rs.remote && rs.published);

        // Comparación rama vs base sin checkout (base = develop, no main).
        let cmp = compare_branch_at(&repo_dir, "refs/heads/feat/x", None).unwrap();
        assert_eq!(cmp.ahead, 2);
        assert!(cmp.files.iter().any(|f| f.path == "feat.txt" && f.status == 'A'));

        // Diff de rama remota sin checkout.
        let blob = diff_ref_at(&repo_dir, "blob", "rem.txt", None, None, Some("refs/remotes/origin/remota-sola"), None).unwrap();
        assert_eq!(blob.new, "remoto\n");

        // HEAD y el árbol sucio siguen intactos.
        assert_eq!(head_at(&repo_dir).unwrap(), "develop");
        assert_eq!(std::fs::read_to_string(repo_dir.join("base.txt")).unwrap(), "v1-sucio\n");
        std::fs::remove_dir_all(base).unwrap();
    }
}
