use std::collections::HashMap;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::cli::{login_path, resolve, UpdateGate, UPDATE_LIMIT};
use crate::{db, err, AppState, CmdResult};

// Estado de las CLI que usa el IDE: si están instaladas y si tienen la
// sesión iniciada. GitHub utiliza la autorización web de GitHub CLI.

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub id: &'static str,
    pub name: &'static str,
    /// Para qué la usa el IDE.
    pub role: &'static str,
    pub installed: bool,
    /// `None`: la CLI no permite comprobarlo.
    pub logged_in: Option<bool>,
    pub detail: String,
    /// Comando para iniciar sesión en un terminal.
    pub login: Option<&'static str>,
    pub account: Option<String>,
}

struct Spec {
    id: &'static str,
    name: &'static str,
    role: &'static str,
    /// Orden que informa de la sesión (código 0 = comprobable).
    status: Option<&'static [&'static str]>,
    login: Option<&'static str>,
    /// Orden de la propia CLI que busca e instala su última versión; conoce
    /// el método de instalación (npm, instalador nativo, Homebrew…).
    update: Option<&'static [&'static str]>,
}

const SPECS: [Spec; 6] = [
    Spec { id: "codex", name: "Codex", role: "coordinador y Larry", status: Some(&["login", "status"]), login: Some("codex login"), update: Some(&["update"]) },
    Spec { id: "claude", name: "Claude Code", role: "agente ejecutor", status: Some(&["auth", "status"]), login: Some("claude auth login"), update: Some(&["update"]) },
    Spec { id: "opencode", name: "OpenCode", role: "agente ejecutor", status: Some(&["auth", "list"]), login: Some("opencode auth login"), update: Some(&["upgrade"]) },
    Spec { id: "agy", name: "Antigravity", role: "agente ejecutor", status: None, login: Some("agy"), update: Some(&["update"]) },
    // Sin orden de actualización confirmada.
    Spec { id: "devin", name: "Devin", role: "agente ejecutor", status: Some(&["auth", "status"]), login: Some("devin auth login"), update: None },
    Spec { id: "gh", name: "GitHub", role: "publicar ramas y PR", status: Some(&["auth", "status", "--hostname", "github.com", "--active"]), login: None, update: None },
];

/// Ejecuta una orden corta; `None` si no se pudo lanzar (no instalada).
fn run(name: &str, args: &[&str]) -> Option<(bool, String)> {
    run_for(name, args, Duration::from_secs(25))
}

fn run_for(name: &str, args: &[&str], limit: Duration) -> Option<(bool, String)> {
    let mut cmd = crate::cli::command(resolve(name));
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if name == "gh" {
        cmd.env_remove("GH_DEBUG");
    }
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    let mut child = cmd.spawn().ok()?;
    // La salida se lee mientras corre: una actualización puede escribir más
    // de lo que cabe en el búfer del pipe y quedarse bloqueada.
    let (tx, rx) = std::sync::mpsc::channel();
    let readers: Vec<Box<dyn std::io::Read + Send>> = [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ].into_iter().flatten().collect();
    let pipes = readers.len();
    for (i, mut pipe) in readers.into_iter().enumerate() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            let _ = tx.send((i, buf));
        });
    }
    // Una CLI colgada no debe bloquear la comprobación.
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Some((false, "no respondió a tiempo".into()));
            }
        }
    };
    // Un proceso hijo que siga vivo puede retener el pipe: no se le espera.
    let mut parts: Vec<(usize, Vec<u8>)> = (0..pipes).filter_map(|_| rx.recv_timeout(Duration::from_secs(2)).ok()).collect();
    parts.sort_by_key(|(i, _)| *i);
    let text: String = parts.iter().map(|(_, b)| String::from_utf8_lossy(b)).collect();
    Some((status.success(), strip_ansi(&text)))
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // Secuencia CSI: ESC [ … letra final.
            if chars.peek() == Some(&'[') {
                chars.next();
                for d in chars.by_ref() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Interpreta la salida de la orden de estado de cada CLI.
fn logged_in(id: &str, ok: bool, text: &str) -> bool {
    let lower = text.to_lowercase();
    match id {
        "claude" => ok && serde_json::from_str::<serde_json::Value>(text.trim()).map(|v| v["loggedIn"] == true).unwrap_or(lower.contains("\"loggedin\": true")),
        "codex" | "devin" => ok && lower.contains("logged in") && !lower.contains("not logged in"),
        // Sin credenciales, `auth list` no muestra ningún proveedor (●).
        "opencode" => ok && text.contains('●'),
        _ => ok,
    }
}

fn first_line(text: &str) -> String {
    strip_ansi(text)
        .lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with(['┌', '│', '{'])).unwrap_or("").chars().take(120).collect()
}

fn github_account(text: &str) -> Option<String> {
    text.lines().filter_map(|line| line.split_once("Logged in to github.com account "))
        .filter_map(|(_, rest)| rest.split_whitespace().next())
        .find(|name| !name.is_empty() && name.len() <= 100
            && name.bytes().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'-' | b'_')))
        .map(str::to_owned)
}

fn check(spec: &Spec) -> Tool {
    let version = run(spec.id, &["--version"]);
    let installed = version.is_some();
    let mut tool = Tool {
        id: spec.id,
        name: spec.name,
        role: spec.role,
        installed,
        logged_in: None,
        detail: version.map(|(_, t)| first_line(&t)).unwrap_or_else(|| "no está instalada o no está en el PATH".into()),
        login: spec.login,
        account: None,
    };
    if !installed {
        return tool;
    }
    if let Some(args) = spec.status {
        if let Some((ok, text)) = run(spec.id, args) {
            let yes = logged_in(spec.id, ok, &text);
            tool.logged_in = Some(yes);
            if !yes {
                tool.detail = first_line(&text);
            } else if spec.id == "gh" {
                tool.account = github_account(&text);
            }
        }
    }
    tool
}

/// Comprueba en paralelo las CLI del panel Herramientas.
#[tauri::command]
pub async fn tools_status() -> CmdResult<Vec<Tool>> {
    tauri::async_runtime::spawn_blocking(|| {
        let handles: Vec<_> = SPECS.iter()
            .filter(|s| matches!(s.id, "codex" | "claude" | "gh"))
            .map(|s| std::thread::spawn(move || check(s)))
            .collect();
        handles.into_iter().map(|h| h.join().map_err(|_| "falló una comprobación".to_string())).collect()
    })
    .await
    .map_err(err)?
}

// Actualización de las CLI de los proveedores de IA. Cada CLI se actualiza
// con su propia orden y se compara `--version` antes y después. No se toca
// una CLI que el IDE tenga abierta: en Windows su ejecutable está bloqueado.

/// Cada cuánto se vuelve a buscar una versión nueva de cada CLI.
const RECHECK: Duration = Duration::from_secs(6 * 3600);
/// Cada cuánto despierta el bucle para reintentar las CLI que estaban en uso.
const TICK: Duration = Duration::from_secs(30 * 60);
const AUTO_KEY: &str = "cli_auto_update";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub id: &'static str,
    pub name: &'static str,
    /// `updated`, `current`, `busy` o `failed`.
    pub outcome: &'static str,
    pub from: String,
    pub to: Option<String>,
    pub detail: String,
}

/// Si el IDE tiene abierto un proceso de esa CLI.
fn in_use(app: &AppHandle, id: &str) -> bool {
    let state = app.state::<AppState>();
    match id {
        "codex" => state.codex.running(),
        "claude" => state.claude.running(),
        engine => state.acp.running(engine),
    }
}

fn last_line(text: &str) -> String {
    text.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("sin salida").chars().take(160).collect()
}

/// Resultado de una actualización a partir de las versiones y la salida.
fn outcome(spec: &Spec, from: String, ok: bool, text: &str, to: Option<String>) -> Update {
    let (outcome, detail) = match &to {
        _ if !ok => ("failed", last_line(text)),
        Some(to) if *to != from => ("updated", format!("{from} → {to}")),
        _ => ("current", from.clone()),
    };
    Update { id: spec.id, name: spec.name, outcome, from, to, detail }
}

/// Actualiza una CLI. `None` si no tiene orden de actualización o no está instalada.
fn update_one(app: &AppHandle, spec: &'static Spec) -> Option<Update> {
    let args = spec.update?;
    let busy = |detail: &str| Update { id: spec.id, name: spec.name, outcome: "busy", from: String::new(), to: None, detail: detail.into() };
    // La marca va antes de mirar si está en uso: un arranque posterior espera.
    let Some(gate) = UpdateGate::take(spec.id) else { return Some(busy("ya se está actualizando")) };
    if in_use(app, spec.id) {
        return Some(busy("se actualizará cuando quede libre"));
    }
    let from = first_line(&run(spec.id, &["--version"])?.1);
    let (ok, text) = run_for(spec.id, args, UPDATE_LIMIT).unwrap_or((false, "no se pudo lanzar la actualización".into()));
    let to = run(spec.id, &["--version"]).map(|(_, t)| first_line(&t));
    drop(gate);
    Some(outcome(spec, from, ok, &text, to))
}

/// Actualiza en paralelo las CLI indicadas.
fn update_all(app: &AppHandle, specs: Vec<&'static Spec>) -> Vec<(&'static str, Option<Update>)> {
    let handles: Vec<_> = specs.into_iter()
        .map(|s| { let app = app.clone(); (s.id, std::thread::spawn(move || update_one(&app, s))) })
        .collect();
    handles.into_iter().map(|(id, h)| (id, h.join().ok().flatten())).collect()
}

fn auto_enabled(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let value = state.db.lock().ok().and_then(|conn| db::get_setting(&conn, AUTO_KEY).ok().flatten());
    value.as_deref() != Some("0")
}

/// Bucle en segundo plano: al arrancar y cada [`RECHECK`] actualiza las CLI
/// de IA instaladas; las que estaban en uso se reintentan cada [`TICK`].
/// Avisa con `cli-updates` de las actualizadas y de los fallos nuevos.
pub fn start_auto(app: AppHandle) {
    std::thread::spawn(move || {
        let mut checked: HashMap<&'static str, Instant> = HashMap::new();
        let mut failures: HashMap<&'static str, String> = HashMap::new();
        loop {
            if auto_enabled(&app) {
                let due = SPECS.iter()
                    .filter(|s| s.update.is_some() && checked.get(s.id).is_none_or(|t| t.elapsed() >= RECHECK))
                    .collect();
                let mut notable = Vec::new();
                for (id, result) in update_all(&app, due) {
                    if result.as_ref().is_some_and(|u| u.outcome == "busy") {
                        continue;
                    }
                    checked.insert(id, Instant::now());
                    match result {
                        Some(u) if u.outcome == "failed" => {
                            if failures.insert(id, u.detail.clone()).as_ref() != Some(&u.detail) {
                                notable.push(u);
                            }
                        }
                        Some(u) => {
                            failures.remove(id);
                            if u.outcome == "updated" {
                                notable.push(u);
                            }
                        }
                        None => {}
                    }
                }
                if !notable.is_empty() {
                    let _ = app.emit("cli-updates", &notable);
                }
            }
            std::thread::sleep(TICK);
        }
    });
}

/// Busca e instala ahora las versiones nuevas de las CLI de IA instaladas.
#[tauri::command]
pub async fn tools_update(app: AppHandle) -> CmdResult<Vec<Update>> {
    tauri::async_runtime::spawn_blocking(move || {
        update_all(&app, SPECS.iter().filter(|s| s.update.is_some()).collect()).into_iter().filter_map(|(_, u)| u).collect()
    })
    .await
    .map_err(err)
}

/// Lee (sin `enabled`) o cambia la actualización automática de las CLI.
#[tauri::command]
pub fn tools_auto_update(state: tauri::State<AppState>, enabled: Option<bool>) -> CmdResult<bool> {
    let conn = state.db.lock().map_err(err)?;
    if let Some(on) = enabled {
        db::set_setting(&conn, AUTO_KEY, if on { "1" } else { "0" }).map_err(err)?;
    }
    Ok(db::get_setting(&conn, AUTO_KEY).map_err(err)?.as_deref() != Some("0"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_cli_status() {
        assert!(logged_in("claude", true, "{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\"\n}"));
        assert!(!logged_in("claude", true, "{ \"loggedIn\": false }"));
        assert!(logged_in("codex", true, "Logged in using ChatGPT"));
        assert!(!logged_in("codex", false, "Not logged in"));
        assert!(logged_in("devin", true, "Logged in (via Devin)."));
        assert!(logged_in("opencode", true, "┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  OpenCode api\n"));
        assert!(!logged_in("opencode", true, "┌  Credentials\n│\n└  0 credentials\n"));
        assert!(logged_in("gh", true, "github.com\n  ✓ Logged in"));
        assert!(!logged_in("gh", false, "You are not logged into any GitHub hosts"));
    }

    #[test]
    fn classifies_each_update() {
        let codex = &SPECS[0];
        let v = |s: &str| Some(s.to_string());
        let up = outcome(codex, "codex-cli 0.169.0".into(), true, "Updated", v("codex-cli 0.170.0"));
        assert_eq!((up.outcome, up.detail.as_str()), ("updated", "codex-cli 0.169.0 → codex-cli 0.170.0"));
        assert_eq!(outcome(codex, "codex-cli 0.170.0".into(), true, "up to date", v("codex-cli 0.170.0")).outcome, "current");
        let failed = outcome(codex, "codex-cli 0.170.0".into(), false, "Checking…\nEBUSY: resource busy\n\n", v("codex-cli 0.170.0"));
        assert_eq!((failed.outcome, failed.detail.as_str()), ("failed", "EBUSY: resource busy"));
        assert!(SPECS.iter().filter(|s| s.update.is_some()).all(|s| matches!(s.id, "codex" | "claude" | "opencode" | "agy")));
    }



    #[test]
    fn strips_terminal_colors() {
        assert_eq!(strip_ansi("\u{1b}[0m●  OpenCode \u{1b}[90mapi"), "●  OpenCode api");
        assert_eq!(first_line("\u{1b}[0m\n┌  Credentials\n│\n●  OpenCode"), "●  OpenCode");
    }

    /// Contra las CLI instaladas: `cargo test -- --ignored real_tools --nocapture`.
    #[test]
    #[ignore]
    fn real_tools() {
        for s in &SPECS {
            let t = check(s);
            println!("{:10} instalada={} sesión={:?} · {}", t.id, t.installed, t.logged_in, t.detail);
        }
    }
}
