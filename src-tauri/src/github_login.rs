use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{codex::{login_path, program}, err, AppState, CmdResult};

const DEVICE_URL: &str = "https://github.com/login/device";

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub(crate) enum LoginStatus {
    Waiting { code: Option<String> },
    Complete,
    Cancelled,
    Error { message: &'static str },
}

struct Login {
    child: Option<Child>,
    status: LoginStatus,
}

impl Login {
    fn stop(&mut self, status: LoginStatus) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.status = status;
    }
}

#[derive(Default)]
pub(crate) struct GithubLogin(Mutex<Option<Arc<Mutex<Login>>>>);

impl Drop for GithubLogin {
    fn drop(&mut self) {
        if let Ok(Some(login)) = self.0.get_mut() {
            if let Ok(mut login) = login.lock() {
                login.stop(LoginStatus::Cancelled);
            }
        }
    }
}

fn device_code(line: &str) -> Option<String> {
    if !line.contains("one-time code") && !line.contains("One-time code (") {
        return None;
    }
    line.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-')
        .find(|word| {
            let bytes = word.as_bytes();
            bytes.len() == 9 && bytes[4] == b'-'
                && bytes[..4].iter().chain(&bytes[5..]).all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        })
        .map(str::to_owned)
}

fn monitor(login: Arc<Mutex<Login>>, stderr: impl std::io::Read + Send + 'static) {
    let output = login.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(code) = device_code(&line) {
                if let Ok(mut login) = output.lock() {
                    if matches!(login.status, LoginStatus::Waiting { .. }) {
                        login.status = LoginStatus::Waiting { code: Some(code) };
                    }
                }
            }
        }
    });
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(15 * 60);
        loop {
            {
                let Ok(mut login) = login.lock() else { break };
                let Some(child) = &mut login.child else { break };
                match child.try_wait() {
                    Ok(Some(status)) => {
                        login.child = None;
                        login.status = if status.success() {
                            LoginStatus::Complete
                        } else {
                            LoginStatus::Error { message: "GitHub no completó la autorización. Comprueba la conexión y vuelve a intentarlo." }
                        };
                        break;
                    }
                    Ok(None) if Instant::now() < deadline => {}
                    _ => {
                        login.stop(LoginStatus::Error { message: "La autorización de GitHub ha caducado. Vuelve a intentarlo." });
                        break;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}

#[tauri::command]
pub(crate) async fn github_login_start(app: AppHandle) -> CmdResult<LoginStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut attempt = state.github_login.0.lock().map_err(err)?;
        if let Some(login) = attempt.as_ref() {
            let login = login.lock().map_err(err)?;
            if matches!(login.status, LoginStatus::Waiting { .. }) {
                return Ok(login.status.clone());
            }
        }
        if ["GH_TOKEN", "GITHUB_TOKEN"].iter()
            .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty())) {
            return Err("GitHub CLI está usando credenciales del entorno. Abre Filigranas sin esas credenciales para iniciar sesión desde aquí.".into());
        }
        let mut cmd = Command::new(program("gh"));
        cmd.args(["auth", "login", "--hostname", "github.com", "--web", "--skip-ssh-key", "--clipboard=false"])
            .env("GH_PROMPT_DISABLED", "1")
            .env("NO_COLOR", "1")
            .env_remove("GH_FORCE_TTY")
            .env_remove("GH_DEBUG")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(path) = login_path() {
            cmd.env("PATH", path);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().map_err(|_| "no se pudo abrir GitHub CLI")?;
        let stderr = child.stderr.take().ok_or("no se pudo leer el código de GitHub")?;
        let status = LoginStatus::Waiting { code: None };
        let login = Arc::new(Mutex::new(Login { child: Some(child), status: status.clone() }));
        *attempt = Some(login.clone());
        monitor(login, stderr);
        Ok(status)
    }).await.map_err(err)?
}

#[tauri::command]
pub(crate) fn github_login_status(state: State<AppState>) -> CmdResult<Option<LoginStatus>> {
    let attempt = state.github_login.0.lock().map_err(err)?;
    attempt.as_ref().map(|login| login.lock().map(|login| login.status.clone()).map_err(err)).transpose()
}

#[tauri::command]
pub(crate) fn github_login_cancel(state: State<AppState>) -> CmdResult<()> {
    let attempt = state.github_login.0.lock().map_err(err)?;
    if let Some(login) = attempt.as_ref() {
        let mut login = login.lock().map_err(err)?;
        if login.child.is_some() {
            login.stop(LoginStatus::Cancelled);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn github_login_open(app: AppHandle) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if !matches!(github_login_status(state)?, Some(LoginStatus::Waiting { code: Some(_) })) {
            return Err("inicia primero la autorización de GitHub".into());
        }
        crate::pr::open_browser(DEVICE_URL)
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_only_the_oauth_code() {
        assert_eq!(device_code("! First copy your one-time code: ABCD-EFGH").as_deref(), Some("ABCD-EFGH"));
        assert_eq!(device_code("! One-time code (0123-4567) copied to clipboard").as_deref(), Some("0123-4567"));
        assert_eq!(device_code("Token: ghp_example CDEF-1234"), None);
    }

    #[cfg(unix)]
    #[test]
    fn tracks_a_login_process_and_clears_its_code_on_completion() {
        let mut child = Command::new("sh").args(["-c", "echo 'First copy your one-time code: ABCD-EFGH' >&2; sleep 1"])
            .stderr(Stdio::piped()).spawn().unwrap();
        let stderr = child.stderr.take().unwrap();
        let login = Arc::new(Mutex::new(Login { child: Some(child), status: LoginStatus::Waiting { code: None } }));
        monitor(login.clone(), stderr);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut saw_code = false;
        loop {
            match &login.lock().unwrap().status {
                LoginStatus::Waiting { code: Some(code) } => {
                    assert_eq!(code, "ABCD-EFGH");
                    saw_code = true;
                }
                LoginStatus::Complete => break,
                LoginStatus::Waiting { code: None } => {}
                _ => panic!("el inicio de sesión de prueba no terminó"),
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(saw_code);
    }
}
