use std::collections::HashSet;
use std::ffi::OsStr;
use std::process::Command;
#[cfg(unix)]
use std::process::Stdio;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

/// Plazo de una actualización (descarga incluida).
pub(crate) const UPDATE_LIMIT: Duration = Duration::from_secs(300);

/// Punto único para crear un proceso hijo (`clippy.toml` prohíbe
/// `Command::new` fuera de aquí). La build de release de Windows no tiene
/// consola: sin `CREATE_NO_WINDOW`, cada hijo de consola abriría su ventana.
/// `creation_flags` sustituye el valor: quien lo cambie debe conservar este.
/// Los terminales integrados usan `portable-pty` y no pasan por aquí.
pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(clippy::disallowed_methods)]
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// Programa externo listo para lanzar. En Windows, `Command` solo busca
/// `.exe` en el PATH y las CLI pueden instalarse como `.cmd`: se resuelve la
/// ruta completa a mano. En macOS basta el nombre con el PATH de login.
/// Si la CLI se está actualizando, espera a que termine antes de lanzarla.
pub(crate) fn program(name: &str) -> std::path::PathBuf {
    wait_update(name);
    resolve(name)
}

/// Como [`program`], sin esperar a una actualización en curso.
pub(crate) fn resolve(name: &str) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let path = login_path().map(std::ffi::OsString::from).or_else(|| std::env::var_os("PATH")).unwrap_or_default();
        for dir in std::env::split_paths(&path) {
            for ext in ["exe", "cmd", "bat"] {
                let candidate = dir.join(format!("{name}.{ext}"));
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    std::path::PathBuf::from(name)
}

/// Una app abierta desde Finder puede heredar un PATH sin las CLI del usuario.
pub(crate) fn login_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        #[cfg(unix)]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let out = command(shell).args(["-ilc", "printf '\\n<<%s>>' \"$PATH\""]).stdin(Stdio::null()).output().ok()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let start = text.rfind("<<")? + 2;
            let end = start + text[start..].find(">>")?;
            Some(text[start..end].to_string())
        }
        #[cfg(not(unix))]
        None
    })
    .as_deref()
}

fn updating() -> &'static (Mutex<HashSet<&'static str>>, Condvar) {
    static UPDATING: OnceLock<(Mutex<HashSet<&'static str>>, Condvar)> = OnceLock::new();
    UPDATING.get_or_init(Default::default)
}

/// Bloquea hasta que termine la actualización en curso de `name`, si la hay,
/// para no lanzar la CLI mientras se reemplaza su ejecutable.
fn wait_update(name: &str) {
    let (lock, done) = updating();
    if let Ok(guard) = lock.lock() {
        let _ = done.wait_timeout_while(guard, UPDATE_LIMIT + Duration::from_secs(30), |set| set.contains(name));
    }
}

/// Marca de actualización en curso; se retira al soltarla.
pub(crate) struct UpdateGate(&'static str);

impl UpdateGate {
    pub(crate) fn take(id: &'static str) -> Option<Self> {
        // Sin `then_some`: crearía la marca aunque ya hubiera otra, y al
        // soltarla, con el cerrojo aún tomado, se bloquearía y borraría la ajena.
        let fresh = updating().0.lock().ok()?.insert(id);
        if fresh { Some(Self(id)) } else { None }
    }
}

impl Drop for UpdateGate {
    fn drop(&mut self) {
        let (lock, done) = updating();
        if let Ok(mut set) = lock.lock() {
            set.remove(self.0);
        }
        done.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn a_launch_waits_for_the_update_in_progress() {
        let gate = UpdateGate::take("fixture-cli").unwrap();
        assert!(UpdateGate::take("fixture-cli").is_none(), "dos actualizaciones a la vez");
        let start = Instant::now();
        let waiter = std::thread::spawn(|| wait_update("fixture-cli"));
        std::thread::sleep(Duration::from_millis(200));
        drop(gate);
        waiter.join().unwrap();
        assert!(start.elapsed() >= Duration::from_millis(200) && start.elapsed() < Duration::from_secs(5));
        wait_update("otra-cli"); // sin actualización en curso no espera
    }

    /// El ejecutable de pruebas se relanza dos veces: «app» no tiene consola,
    /// como la build de release, y su hijo informa de si ha recibido ventana.
    #[cfg(windows)]
    #[test]
    fn a_child_of_the_windows_app_gets_no_console_window() {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const PROBE: &str = "FILIGRANAS_CONSOLE_PROBE";
        #[link(name = "kernel32")]
        extern "system" {
            fn GetConsoleWindow() -> *mut std::ffi::c_void;
        }
        let role = std::env::var(PROBE).unwrap_or_default();
        if role == "child" {
            // SAFETY: no recibe argumentos ni tiene precondiciones.
            println!("console_window={}", !unsafe { GetConsoleWindow() }.is_null());
            return;
        }
        let mut probe = command(std::env::current_exe().unwrap());
        probe.args(["--exact", "cli::tests::a_child_of_the_windows_app_gets_no_console_window", "--nocapture"]);
        if role == "app" {
            probe.env(PROBE, "child");
        } else {
            probe.env(PROBE, "app").creation_flags(DETACHED_PROCESS);
        }
        let out = probe.output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        if role == "app" {
            print!("{text}");
        } else {
            assert!(out.status.success() && text.contains("console_window=false"), "{text}");
        }
    }
}
