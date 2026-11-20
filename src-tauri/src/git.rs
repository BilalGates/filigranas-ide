use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::State;

use crate::{err, files, workspace::project_path, AppState, CmdResult};

// Lectura de Git con la CLI `git` del sistema: ya está instalada, conoce la
// configuración del usuario y ya resuelve el orden del historial; los
// carriles del gráfico se calculan en la interfaz a partir de los padres. Ninguno de estos comandos escribe en el repositorio:
// `--no-optional-locks` evita incluso refrescar el índice, para no chocar
// con un agente que esté trabajando a la vez.

pub(crate) fn git(repo: &Path, args: &[&str]) -> CmdResult<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(["--no-optional-locks", "-c", "core.quotepath=off", "-c", "color.ui=never"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("no se pudo ejecutar git: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn repo(state: &State<AppState>, project: &str) -> CmdResult<PathBuf> {
    Ok(PathBuf::from(project_path(&*state.db.lock().map_err(err)?, project)?))
}

/// Ruta relativa al repositorio tal como la da `git status`. Rechaza rutas
/// absolutas y `..` para que nunca se salga del proyecto.
fn relative(path: &str) -> CmdResult<&str> {
    let ok = !path.is_empty() && Path::new(path).components().all(|c| matches!(c, Component::Normal(_)));
    if ok {
        Ok(path)
    } else {
        Err(format!("ruta no válida: {path}"))
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    path: String,
    /// Ruta anterior en un renombrado.
    orig: Option<String>,
    /// M, A, D, R, U (sin seguimiento) o ! (conflicto).
    status: char,
    adds: Option<u32>,
    dels: Option<u32>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `None` con la cabeza separada; entonces `head` es el commit.
    branch: Option<String>,
    head: Option<String>,
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
                    "branch.oid" if value != "(initial)" => s.head = Some(value.chars().take(7).collect()),
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
                let status = match kind { "u" => '!', "2" => 'R', _ => letter(cols[0]) };
                s.changes.push(Change { path, orig, status, adds: None, dels: None });
            }
            "?" => s.changes.push(Change { path: rest.into(), orig: None, status: 'U', adds: None, dels: None }),
            _ => {}
        }
    }
    s
}

/// Añade líneas añadidas/eliminadas desde `git diff HEAD --numstat -z`.
/// Los binarios («-») quedan sin contar.
fn apply_numstat(changes: &mut [Change], out: &str) {
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
        if let Some(c) = changes.iter_mut().find(|c| c.path == path) {
            c.adds = adds;
            c.dels = dels;
        }
    }
}

#[tauri::command]
pub fn git_status(state: State<AppState>, project: String) -> CmdResult<Status> {
    status_at(&repo(&state, &project)?, "HEAD")
}

#[tauri::command]
pub fn git_head(state: State<AppState>, project: String) -> CmdResult<String> {
    let repo = repo(&state, &project)?;
    match git(&repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        Ok(branch) => Ok(String::from_utf8_lossy(&branch).trim().to_owned()),
        Err(_) => git(&repo, &["rev-parse", "--short", "HEAD"])
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
        changes.push(Change { path: path.to_string(), orig: None, status, adds: None, dels: None });
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
pub fn git_diff_texts(state: State<AppState>, project: String, path: String, orig: Option<String>) -> CmdResult<DiffTexts> {
    diff_texts_at(&repo(&state, &project)?, "HEAD", &path, orig.as_deref())
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
pub fn git_log(state: State<AppState>, project: String) -> CmdResult<Vec<LogRow>> {
    let repo = repo(&state, &project)?;
    let out = git(&repo, &["log", "--branches", "--remotes", "--tags", "HEAD", "--topo-order", LOG_LIMIT, "--format=%h%x1f%p%x1f%D%x1f%aN%x1f%aI%x1f%s"])?;
    Ok(parse_log(&String::from_utf8_lossy(&out)))
}

/// Ramas locales, por nombre.
#[tauri::command]
pub fn git_branches(state: State<AppState>, project: String) -> CmdResult<Vec<String>> {
    let repo = repo(&state, &project)?;
    let out = git(&repo, &["for-each-ref", "--format=%(refname:short)", "--sort=refname", "refs/heads"])?;
    Ok(String::from_utf8_lossy(&out).lines().map(str::to_string).collect())
}

/// Cambia a una rama local existente. Es la única escritura de este módulo:
/// sin `--force`, así que Git se niega si se perderían cambios sin commit y
/// el error llega tal cual a la interfaz. `--no-guess` evita crear ramas a
/// partir de una remota con el mismo nombre.
#[tauri::command]
pub fn git_switch(state: State<AppState>, project: String, branch: String) -> CmdResult<()> {
    switch(&repo(&state, &project)?, &branch)
}

fn switch(repo: &Path, branch: &str) -> CmdResult<()> {
    if branch.starts_with('-') || git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_err() {
        return Err(format!("no existe la rama local «{branch}»"));
    }
    git(repo, &["switch", "--no-guess", branch]).map(|_| ())
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
}
