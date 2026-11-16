use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{event::ModifyKind, EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{err, workspace::project_path, AppState, CmdResult};

/// Observa la carpeta raíz (sin recursión) y avisa a la interfaz cuando
/// aparece, desaparece o se renombra un hijo. La interfaz vuelve a pedir
/// el espacio de trabajo; aquí no se hace ningún trabajo pesado.
pub fn start(app: &AppHandle, root: &Path) -> notify::Result<()> {
    let handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let relevant = matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
        );
        if relevant {
            let _ = handle.emit("workspace-changed", ());
        }
    })?;
    watcher.watch(root, RecursiveMode::NonRecursive)?;

    let state = app.state::<AppState>();
    // Sustituir el observador anterior lo detiene.
    *state.watcher.lock().unwrap_or_else(|p| p.into_inner()) = Some(watcher);
    Ok(())
}

/// Carpetas de dependencias y compilación que cambian a miles durante un
/// `npm install` o un `next dev` y nunca se versionan.
const NOISY_DIRS: [&str; 5] = ["node_modules", ".next", ".pnpm-store", "target", ".turbo"];

fn is_noisy(dir: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(dir) else { return true };
    if rel.starts_with(".git/objects") || rel.starts_with(".git/logs") {
        return true;
    }
    rel.components().any(|c| matches!(c, Component::Normal(n) if NOISY_DIRS.iter().any(|d| n == *d)))
}

/// Convierte una ráfaga de avisos en uno: espera `quiet` sin novedades, pero
/// con escrituras continuas avisa al menos cada `max`. Termina cuando se
/// cierra el emisor (al dejar de observar).
fn coalesce(rx: Receiver<()>, quiet: Duration, max: Duration, mut emit: impl FnMut()) {
    while rx.recv().is_ok() {
        let start = Instant::now();
        loop {
            match rx.recv_timeout(quiet) {
                Ok(()) if start.elapsed() < max => continue,
                Ok(()) | Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    emit();
                    return;
                }
            }
        }
        emit();
    }
}

/// Observa el proyecto abierto, con recursión, y emite `project-changed`
/// agrupando las ráfagas. Ignora `.git/objects`, `.git/logs` y las carpetas
/// de dependencias y compilación. Con `None` deja de observar.
#[tauri::command]
pub fn watch_project(app: AppHandle, state: State<AppState>, path: Option<String>) -> CmdResult<()> {
    let mut slot = state.project_watcher.lock().map_err(err)?;
    *slot = None;
    let Some(path) = path else { return Ok(()) };
    let dir = PathBuf::from(project_path(&*state.db.lock().map_err(err)?, &path)?);
    let (tx, rx) = channel();
    let handle = app.clone();
    std::thread::spawn(move || {
        coalesce(rx, Duration::from_millis(150), Duration::from_secs(1), || {
            let _ = handle.emit("project-changed", ());
        })
    });
    let root = dir.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !matches!(event.kind, EventKind::Access(_)) && event.paths.iter().any(|p| !is_noisy(&root, p)) {
            let _ = tx.send(());
        }
    })
    .map_err(err)?;
    watcher.watch(&dir, RecursiveMode::Recursive).map_err(err)?;
    *slot = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noisy_paths() {
        let dir = Path::new("/r/p");
        assert!(!is_noisy(dir, Path::new("/r/p/src/a.ts")));
        assert!(!is_noisy(dir, Path::new("/r/p/.git/index")));
        assert!(!is_noisy(dir, Path::new("/r/p/src/targets.ts")));
        for p in ["/r/p/node_modules/x/i.js", "/r/p/apps/web/.next/cache/a", "/r/p/.git/objects/ab/cd", "/otro/a"] {
            assert!(is_noisy(dir, Path::new(p)), "{p}");
        }
    }

    #[test]
    fn bursts_become_one_event() {
        let (tx, rx) = channel();
        let sender = std::thread::spawn(move || {
            for _ in 0..500 {
                tx.send(()).unwrap(); // ráfaga
            }
            std::thread::sleep(Duration::from_millis(80));
            tx.send(()).unwrap(); // segunda ráfaga, ya separada
        });
        let mut count = 0;
        coalesce(rx, Duration::from_millis(30), Duration::from_secs(5), || count += 1);
        sender.join().unwrap();
        assert_eq!(count, 2);
    }
}
