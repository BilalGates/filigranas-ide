use std::path::Path;

use notify::{event::ModifyKind, EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

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
