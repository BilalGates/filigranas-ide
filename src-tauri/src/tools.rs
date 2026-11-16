use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;

use crate::codex::{login_path, program};
use crate::{err, CmdResult};

// Estado de las CLI que usa el IDE: si están instaladas y si tienen la
// sesión iniciada. El IDE no inicia sesión por el usuario: le abre un
// terminal con el comando adecuado para que lo complete él.

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
}

struct Spec {
    id: &'static str,
    name: &'static str,
    role: &'static str,
    /// Orden que informa de la sesión (código 0 = comprobable).
    status: Option<&'static [&'static str]>,
    login: Option<&'static str>,
}

const SPECS: [Spec; 7] = [
    Spec { id: "codex", name: "Codex", role: "coordinador y Larry", status: Some(&["login", "status"]), login: Some("codex login") },
    Spec { id: "claude", name: "Claude Code", role: "agente ejecutor", status: Some(&["auth", "status"]), login: Some("claude auth login") },
    Spec { id: "opencode", name: "OpenCode", role: "agente ejecutor", status: Some(&["auth", "list"]), login: Some("opencode auth login") },
    Spec { id: "agy", name: "Antigravity", role: "agente ejecutor", status: None, login: Some("agy") },
    Spec { id: "devin", name: "Devin", role: "agente ejecutor", status: Some(&["auth", "status"]), login: Some("devin auth login") },
    Spec { id: "gh", name: "GitHub CLI", role: "publicar ramas y PR", status: Some(&["auth", "status"]), login: Some("gh auth login") },
    Spec { id: "node", name: "Node.js", role: "agrupar commits (Larry)", status: None, login: None },
];

/// Ejecuta una orden corta; `None` si no se pudo lanzar (no instalada).
fn run(name: &str, args: &[&str]) -> Option<(bool, String)> {
    let mut cmd = Command::new(program(name));
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().ok()?;
    // Una CLI colgada no debe bloquear la comprobación.
    let deadline = std::time::Instant::now() + Duration::from_secs(25);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Some((false, "no respondió a tiempo".into()));
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    Some((out.status.success(), strip_ansi(&text)))
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
            }
        }
    }
    tool
}

/// Comprueba todas las CLI en paralelo (algunas tardan segundos en arrancar).
#[tauri::command]
pub async fn tools_status() -> CmdResult<Vec<Tool>> {
    tauri::async_runtime::spawn_blocking(|| {
        let handles: Vec<_> = SPECS.iter().map(|s| std::thread::spawn(move || check(s))).collect();
        handles.into_iter().map(|h| h.join().map_err(|_| "falló una comprobación".to_string())).collect()
    })
    .await
    .map_err(err)?
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
