use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::cli::login_path;
use crate::git::git;
use crate::{err, AppState, CmdResult};

// Larry: propone commits por unidad funcional y, tras la revisión del
// usuario, los crea en local con rutas explícitas. El script de Filigranas
// agrupa de forma determinista; Codex solo ajusta los dudosos y redacta los
// mensajes. Nunca hace push, amend, rebase ni `--no-verify`.

const SCRIPT: &str = include_str!("../resources/larry/agrupar-commits.mjs");
const COMMIT_RULES: &str = include_str!("../resources/skills/github-flow/references/larry.md");
/// Límite de diff que se le enseña al modelo (caracteres).
const DIFF_BUDGET: usize = 24_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Commit {
    pub message: String,
    pub files: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct Plan {
    pub branch: String,
    pub commits: Vec<Commit>,
    /// Aviso de Larry (p. ej. por qué separó algo o qué revisar).
    pub notes: Option<String>,
    /// El modelo no dio un plan válido: son los grupos del script.
    pub fallback: bool,
}

/// Grupo del script `agrupar-commits.mjs --json`.
#[derive(Deserialize, Debug)]
struct ScriptGroup {
    tipo: String,
    alcance: String,
    ficheros: Vec<ScriptFile>,
}

#[derive(Deserialize, Debug)]
struct ScriptFile {
    ruta: String,
}

#[derive(Deserialize, Debug)]
struct ScriptOut {
    grupos: Vec<ScriptGroup>,
}

/// El script imprime una cabecera legible antes del JSON.
fn parse_script(out: &str) -> CmdResult<Vec<ScriptGroup>> {
    let start = out.find('{').ok_or("el script de agrupación no devolvió JSON")?;
    serde_json::from_str::<ScriptOut>(&out[start..]).map(|o| o.grupos).map_err(|e| format!("salida del script no válida: {e}"))
}

fn run_script(repo: &Path) -> CmdResult<String> {
    let mut cmd = crate::cli::command(crate::cli::program("node"));
    cmd.args(["--input-type=module", "-", "--json"]).current_dir(repo).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    let mut child = cmd.spawn().map_err(|e| format!("no se pudo ejecutar node ({e}); Larry lo necesita para agrupar"))?;
    child.stdin.take().ok_or("sin entrada de node")?.write_all(SCRIPT.as_bytes()).map_err(err)?;
    let out = child.wait_with_output().map_err(err)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Plan de respaldo: un commit por grupo del script, con un mensaje que el
/// usuario debe completar.
fn fallback(groups: &[ScriptGroup]) -> Vec<Commit> {
    groups
        .iter()
        .map(|g| {
            let tipo = if g.tipo.contains('|') { "feat" } else { g.tipo.as_str() };
            let scope = if g.alcance.is_empty() { String::new() } else { format!("({})", g.alcance) };
            Commit { message: format!("{tipo}{scope}: describe el cambio"), files: g.ficheros.iter().map(|f| f.ruta.clone()).collect() }
        })
        .collect()
}

/// Comprueba que el plan reparte exactamente los archivos cambiados, cada uno
/// en un solo commit, y que los mensajes no están vacíos.
fn validate(commits: &[Commit], changed: &BTreeSet<String>) -> CmdResult<()> {
    let mut seen = BTreeSet::new();
    for c in commits {
        let subject = c.message.lines().next().unwrap_or("").trim();
        if subject.is_empty() {
            return Err("hay un commit sin mensaje".into());
        }
        if subject.chars().count() > 100 {
            return Err(format!("mensaje demasiado largo: {subject}"));
        }
        if c.files.is_empty() {
            return Err(format!("el commit «{subject}» no tiene archivos"));
        }
        for f in &c.files {
            if !changed.contains(f) {
                return Err(format!("{f} no está entre los archivos cambiados"));
            }
            if !seen.insert(f.clone()) {
                return Err(format!("{f} aparece en más de un commit"));
            }
        }
    }
    if let Some(missing) = changed.iter().find(|f| !seen.contains(*f)) {
        return Err(format!("{missing} no está en ningún commit"));
    }
    Ok(())
}

fn changed_files(groups: &[ScriptGroup]) -> BTreeSet<String> {
    groups.iter().flat_map(|g| g.ficheros.iter().map(|f| f.ruta.clone())).collect()
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "commits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "message": { "type": "string" },
                        "files": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["message", "files"],
                    "additionalProperties": false
                }
            },
            "notes": { "type": ["string", "null"] }
        },
        "required": ["commits", "notes"],
        "additionalProperties": false
    })
}

/// Diffs de los archivos modificados cuyo tipo decide el contenido.
fn doubtful_diffs(repo: &Path, groups: &[ScriptGroup]) -> String {
    let mut out = String::new();
    for g in groups.iter().filter(|g| g.tipo.contains('|')) {
        for f in &g.ficheros {
            if out.len() >= DIFF_BUDGET {
                out.push_str("\n(diff recortado)\n");
                return out;
            }
            if let Ok(d) = git(repo, &["diff", "HEAD", "--", &f.ruta]) {
                let d = String::from_utf8_lossy(&d);
                let room = DIFF_BUDGET.saturating_sub(out.len());
                out.push_str(&d.chars().take(room).collect::<String>());
            }
        }
    }
    out
}

fn ensure_index_empty(repo: &Path) -> CmdResult<()> {
    if !git(repo, &["diff", "--cached", "--name-only"])?.is_empty() {
        return Err("hay cambios ya preparados (git add) en el proyecto: Larry no los mezcla. Haz commit de ellos o sácalos del índice antes.".into());
    }
    Ok(())
}

fn branch(repo: &Path) -> String {
    git(repo, &["branch", "--show-current"]).map(|b| String::from_utf8_lossy(&b).trim().to_string()).ok().filter(|b| !b.is_empty()).unwrap_or_else(|| "HEAD suelto".into())
}

/// Plazo para que Codex proponga; después se usan los grupos del script.
const PROPOSE_LIMIT: std::time::Duration = std::time::Duration::from_secs(90);

fn script_groups(repo: &Path) -> CmdResult<Vec<ScriptGroup>> {
    ensure_index_empty(repo)?;
    let groups = parse_script(&run_script(repo)?)?;
    if groups.is_empty() {
        return Err("árbol limpio: no hay nada que commitear".into());
    }
    Ok(groups)
}

/// Plan sin modelo: los grupos del script, con mensajes por completar.
pub fn script_plan(repo: &Path) -> CmdResult<Plan> {
    let groups = script_groups(repo)?;
    Ok(Plan {
        branch: branch(repo),
        commits: fallback(&groups),
        notes: Some("Grupos del script de Filigranas: completa los mensajes.".into()),
        fallback: true,
    })
}

/// Propone los commits del árbol de trabajo del proyecto.
pub fn propose(app: &AppHandle, repo: &Path) -> CmdResult<Plan> {
    let groups = script_groups(repo)?;
    let changed = changed_files(&groups);
    let summary: Vec<Value> = groups
        .iter()
        .map(|g| json!({ "tipo": g.tipo, "alcance": g.alcance, "ficheros": g.ficheros.iter().map(|f| &f.ruta).collect::<Vec<_>>() }))
        .collect();
    let log = git(repo, &["log", "-8", "--format=%s"]).map(|l| String::from_utf8_lossy(&l).into_owned()).unwrap_or_default();
    let prompt = format!(
        "Propón los commits para los cambios de este repositorio, siguiendo las reglas de la skill.\n\n\
Grupos deterministas del script (ajústalos solo si un archivo pertenece claramente a otra unidad funcional):\n{}\n\n\
Últimos mensajes del repositorio, para imitar su estilo e idioma:\n{log}\n\
Diffs de los archivos modificados cuyo tipo (feat, fix o refactor) hay que decidir:\n{}\n\n\
Responde con exactamente esos archivos, cada uno en un solo commit, en orden de dependencia. Mensajes en el idioma del repositorio. \
`notes`: una o dos frases si algo merece revisión del usuario; si no, null.\n\n\
Toda la información necesaria está en este mensaje: no leas archivos, no ejecutes comandos ni consultes otras fuentes; responde directamente.",
        serde_json::to_string_pretty(&summary).map_err(err)?,
        doubtful_diffs(repo, &groups)
    );
    let instructions = format!("Eres Larry, el responsable de los commits. Solo propones; el usuario revisa y el IDE crea los commits.\n\n{COMMIT_RULES}");
    let state = app.state::<AppState>();
    let answer = state.codex.run_structured(app, &repo.to_string_lossy(), &instructions, &prompt, schema(), "low", PROPOSE_LIMIT);
    let parsed = answer.and_then(|text| {
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("respuesta no válida: {e}"))?;
        let commits: Vec<Commit> = serde_json::from_value(v["commits"].clone()).map_err(|e| e.to_string())?;
        validate(&commits, &changed)?;
        Ok((commits, v["notes"].as_str().map(str::to_string)))
    });
    let branch = branch(repo);
    Ok(match parsed {
        Ok((commits, notes)) => Plan { branch, commits, notes, fallback: false },
        Err(e) => Plan {
            branch,
            commits: fallback(&groups),
            notes: Some(format!("Larry no pudo redactar el plan ({e}). Estos son los grupos del script: completa los mensajes.")),
            fallback: true,
        },
    })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Outcome {
    /// Commits creados (hash corto y asunto).
    pub created: Vec<String>,
    /// Motivo de la parada, si no se crearon todos.
    pub stopped: Option<String>,
}

fn git_env(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = crate::cli::command("git");
    cmd.arg("-C").arg(repo).args(args).env("GIT_TERMINAL_PROMPT", "0");
    // Los hooks (husky, lint-staged…) necesitan el PATH del usuario.
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    let out = cmd.output().map_err(|e| format!("no se pudo ejecutar git: {e}"))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(text)
    } else {
        Err(text.trim().to_string())
    }
}

/// Crea los commits en orden. Se detiene en el primer problema y deja el
/// repositorio en un estado visible: nunca deshace ni fuerza nada.
fn commit_recording(repo: &Path, commits: &[Commit], mut record: impl FnMut(&str, &str) -> CmdResult<()>) -> CmdResult<Outcome> {
    ensure_index_empty(repo)?;
    let changed = changed_files(&parse_script(&run_script(repo)?)?);
    validate(commits, &changed).map_err(|e| format!("el plan ya no coincide con los cambios ({e}): vuelve a pedirle a Larry"))?;
    let mut created = Vec::new();
    for c in commits {
        let subject = c.message.lines().next().unwrap_or("").trim().to_string();
        let mut add = vec!["add", "--"];
        add.extend(c.files.iter().map(String::as_str));
        if let Err(e) = git_env(repo, &add) {
            return Ok(Outcome { created, stopped: Some(format!("git add falló en «{subject}»: {e}")) });
        }
        let staged: BTreeSet<String> = String::from_utf8_lossy(&git(repo, &["diff", "--cached", "--name-only", "-z"])?).split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect();
        let wanted: BTreeSet<String> = c.files.iter().cloned().collect();
        if staged != wanted {
            return Ok(Outcome { created, stopped: Some(format!("lo preparado para «{subject}» no coincide con el plan; revisa el índice antes de seguir")) });
        }
        if let Err(e) = git_env(repo, &["diff", "--cached", "--check"]) {
            return Ok(Outcome { created, stopped: Some(format!("falló la comprobación local de «{subject}»: {e}")) });
        }
        if let Err(e) = git_env(repo, &["commit", "-m", &c.message]) {
            return Ok(Outcome { created, stopped: Some(format!("el commit «{subject}» no se creó (¿un hook?): {e}")) });
        }
        let hash = git(repo, &["rev-parse", "--short", "HEAD"]).map(|h| String::from_utf8_lossy(&h).trim().to_string()).unwrap_or_default();
        created.push(format!("{hash} {subject}"));
        let oid = crate::pr::value(repo, &["rev-parse", "HEAD"]);
        if let Err(e) = oid.and_then(|oid| record(&oid, &subject)) {
            return Ok(Outcome { created, stopped: Some(format!("el commit quedó en Git, pero no se pudo registrar en el tablero: {e}")) });
        }
        // Un hook que reescribe archivos del commit los deja cambiados.
        let mut status = vec!["status", "--porcelain", "-z", "--"];
        status.extend(c.files.iter().map(String::as_str));
        let after = String::from_utf8_lossy(&git(repo, &status).unwrap_or_default()).into_owned();
        let touched: Vec<&String> = c.files.iter().filter(|f| after.split('\0').any(|l| l.get(3..) == Some(f.as_str()))).collect();
        if !touched.is_empty() {
            return Ok(Outcome { created, stopped: Some(format!("un hook modificó {} tras «{subject}»: revísalo antes de seguir", touched.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "))) });
        }
    }
    Ok(Outcome { created, stopped: None })
}

#[cfg(test)]
fn commit(repo: &Path, commits: &[Commit]) -> CmdResult<Outcome> {
    commit_recording(repo, commits, |_, _| Ok(()))
}

// ── comandos ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn larry_propose(app: AppHandle, project: String, session: Option<i64>) -> CmdResult<Plan> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::isolate::work_dir(&app.state::<AppState>(), &project, session)?;
        propose(&app, &dir)
    })
    .await
    .map_err(err)?
}

/// Grupos del script al instante, sin esperar al modelo.
#[tauri::command]
pub async fn larry_groups(app: AppHandle, project: String, session: Option<i64>) -> CmdResult<Plan> {
    tauri::async_runtime::spawn_blocking(move || script_plan(&crate::isolate::work_dir(&app.state::<AppState>(), &project, session)?)).await.map_err(err)?
}

#[tauri::command]
pub async fn larry_commit(app: AppHandle, project: String, session: Option<i64>, commits: Vec<Commit>) -> CmdResult<Outcome> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let project = crate::workspace::project_path(&*state.db.lock().map_err(err)?, &project)?;
        let dir = crate::isolate::work_dir(&state, &project, session)?;
        let _git = state.publication.try_lock().map_err(|_| "ya hay una operación Git en curso")?;
        crate::work::git_idle(&*state.db.lock().map_err(err)?, &project)?;
        let outcome = commit_recording(&dir, &commits, |oid, subject| {
            let branch = crate::pr::value(&dir, &["branch", "--show-current"])?;
            let conn = state.db.lock().map_err(err)?;
            crate::github::record_commit(&conn, &project, &branch, oid, subject)
        });
        let _ = app.emit("project-changed", ());
        crate::tasks::changed(&app);
        outcome
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(message: &str, files: &[&str]) -> Commit {
        Commit { message: message.into(), files: files.iter().map(|f| f.to_string()).collect() }
    }

    #[test]
    fn validation_requires_exact_partition() {
        let changed: BTreeSet<String> = ["a.rs", "b.rs", "c.md"].iter().map(|s| s.to_string()).collect();
        assert!(validate(&[c("feat: x", &["a.rs", "b.rs"]), c("docs: y", &["c.md"])], &changed).is_ok());
        assert!(validate(&[c("feat: x", &["a.rs", "b.rs"])], &changed).unwrap_err().contains("c.md"));
        assert!(validate(&[c("feat: x", &["a.rs", "b.rs", "c.md"]), c("docs: y", &["c.md"])], &changed).unwrap_err().contains("más de un"));
        assert!(validate(&[c("feat: x", &["a.rs", "b.rs", "c.md", "z.rs"])], &changed).unwrap_err().contains("z.rs"));
        assert!(validate(&[c("  ", &["a.rs", "b.rs", "c.md"])], &changed).is_err());
    }

    #[test]
    fn parses_script_output_after_its_header() {
        let out = "Rama main\nUltimos commits:\n  abc i\n\n{\"grupos\":[{\"tipo\":\"feat|fix|refactor\",\"alcance\":\"lib\",\"ficheros\":[{\"ruta\":\"src/lib/a.ts\",\"nuevo\":false}]},{\"tipo\":\"docs\",\"alcance\":\"\",\"ficheros\":[{\"ruta\":\"x.md\"}]}],\"planes\":[]}";
        let groups = parse_script(out).unwrap();
        let plan = fallback(&groups);
        assert_eq!(plan, vec![c("feat(lib): describe el cambio", &["src/lib/a.ts"]), c("docs: describe el cambio", &["x.md"])]);
    }

    fn repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("filigranas-larry-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@t"], &["config", "user.name", "t"]] {
            git(&dir, args).unwrap();
        }
        std::fs::write(dir.join("a.rs"), "a\n").unwrap();
        git(&dir, &["add", "."]).unwrap();
        git(&dir, &["commit", "-qm", "inicio"]).unwrap();
        dir
    }

    #[test]
    fn commits_with_explicit_paths_in_order() {
        let dir = repo("ok");
        std::fs::write(dir.join("a.rs"), "a\nb\n").unwrap();
        std::fs::write(dir.join("notas.md"), "n\n").unwrap();
        std::fs::write(dir.join("ajeno.txt"), "no es de nadie\n").unwrap();
        // Un archivo fuera del plan impide empezar.
        let err = commit(&dir, &[c("fix: corrige a", &["a.rs"]), c("docs: añade notas", &["notas.md"])]).unwrap_err();
        assert!(err.contains("ajeno.txt"), "{err}");
        std::fs::remove_file(dir.join("ajeno.txt")).unwrap();

        let conn = crate::db::open(Path::new(":memory:")).unwrap();
        let out = commit_recording(&dir, &[c("fix: corrige a", &["a.rs"]), c("docs: añade notas", &["notas.md"])], |oid, subject| {
            crate::github::record_commit(&conn, "proyecto", "main", oid, subject)
        }).unwrap();
        assert_eq!(out.stopped, None);
        let links = crate::github::branch(&conn, "proyecto", "main").unwrap();
        assert_eq!(links.commits.len(), 2);
        assert_eq!(links.commits[0].oid, crate::pr::value(&dir, &["rev-parse", "HEAD"]).unwrap());
        let log = String::from_utf8(git(&dir, &["log", "--format=%s", "-3"]).unwrap()).unwrap();
        assert_eq!(log, "docs: añade notas\nfix: corrige a\ninicio\n");
        assert!(git(&dir, &["status", "--porcelain"]).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stops_before_commit_when_the_local_diff_check_fails() {
        let dir = repo("diff-check");
        std::fs::write(dir.join("a.rs"), "a\nb \n").unwrap();
        let out = commit(&dir, &[c("fix: corrige a", &["a.rs"])]).unwrap();
        assert!(out.created.is_empty());
        assert!(out.stopped.unwrap().contains("comprobación local"));
        assert_eq!(git(&dir, &["log", "-1", "--format=%s"]).unwrap(), b"inicio\n");
        assert_eq!(git(&dir, &["diff", "--cached", "--name-only"]).unwrap(), b"a.rs\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stops_when_a_hook_rewrites_files() {
        let dir = repo("fmt");
        // Hook que «formatea» a.rs después de preparar: queda cambiado.
        let hook = dir.join(".git/hooks/post-commit");
        std::fs::write(&hook, "#!/bin/sh
echo formateado >> a.rs
").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("a.rs"), "a\nb\n").unwrap();
        std::fs::write(dir.join("b.md"), "b\n").unwrap();
        let out = commit(&dir, &[c("fix: corrige a", &["a.rs"]), c("docs: b", &["b.md"])]).unwrap();
        assert_eq!(out.created.len(), 1);
        assert!(out.stopped.as_deref().unwrap().contains("modificó a.rs"), "{:?}", out.stopped);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stops_when_a_hook_fails_and_never_skips_it() {
        let dir = repo("hook");
        let hook = dir.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\necho 'lint falla' >&2\nexit 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("a.rs"), "a\nb\n").unwrap();
        let out = commit(&dir, &[c("fix: corrige a", &["a.rs"])]).unwrap();
        assert!(out.created.is_empty());
        assert!(out.stopped.as_deref().unwrap().contains("lint falla"), "{:?}", out.stopped);
        // Queda preparado y visible, sin deshacer nada.
        assert_eq!(git(&dir, &["diff", "--cached", "--name-only"]).unwrap(), b"a.rs\n");
        // Con algo ya preparado, Larry no empieza.
        assert!(commit(&dir, &[c("fix: corrige a", &["a.rs"])]).unwrap_err().contains("preparados"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
