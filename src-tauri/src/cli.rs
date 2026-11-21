use std::collections::HashSet;
#[cfg(unix)]
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

/// Plazo de una actualización (descarga incluida).
pub(crate) const UPDATE_LIMIT: Duration = Duration::from_secs(300);

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
            let out = Command::new(shell).args(["-ilc", "printf '\\n<<%s>>' \"$PATH\""]).stdin(Stdio::null()).output().ok()?;
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
}
