use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, State};

use crate::{err, workspace::project_path, AppState, CmdResult};

// Terminales reales: el shell del usuario en un pseudoterminal, con la
// carpeta del proyecto como directorio de trabajo. La salida llega a la
// interfaz por un canal propio de cada terminal.

struct Pty {
    master: Box<dyn MasterPty + Send>,
    /// Bloqueo propio: escribir puede bloquear si el programa no lee, y no
    /// debe frenar a los demás terminales.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Pty>>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum PtyEvent {
    Data(String),
    Exit,
}

/// Separa la parte UTF-8 válida de un bloque leído. Un carácter partido
/// entre dos lecturas se guarda en `pending` para la siguiente; los bytes
/// que nunca serán válidos se sustituyen por «�».
fn decode(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    let mut out = String::new();
    let mut rest: &[u8] = pending;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                rest = &[];
                break;
            }
            Err(e) => {
                let (ok, bad) = rest.split_at(e.valid_up_to());
                out.push_str(std::str::from_utf8(ok).unwrap_or_default());
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{FFFD}');
                        rest = &bad[n..];
                    }
                    None => {
                        rest = bad; // incompleto: esperar más bytes
                        break;
                    }
                }
            }
        }
    }
    *pending = rest.to_vec();
    out
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { cols: cols.max(2), rows: rows.max(1), pixel_width: 0, pixel_height: 0 }
}

/// Abre un terminal en el proyecto y devuelve su identificador.
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    state: State<AppState>,
    project: String,
    session: Option<i64>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> CmdResult<u32> {
    let _update = crate::updates::PROCESS_GATE.lock().map_err(err)?;
    if crate::updates::INSTALLING.load(Ordering::SeqCst) { return Err("instalando actualización".into()); }
    let dir = project_path(&*state.db.lock().map_err(err)?, &project)?;
    // Terminal de una sesión aislada: en su worktree (registrado por el IDE).
    let dir = match session {
        Some(id) => {
            let s = crate::claude::open_session(&state, id)?;
            if s.project != dir {
                return Err("la sesión no es de este proyecto".into());
            }
            s.worktree.ok_or("la sesión no tiene worktree propio")?
        }
        None => dir,
    };
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(err)?;
    // El shell por defecto como shell de login, para que tenga el PATH del
    // perfil del usuario aunque la app se abra desde el Finder.
    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(&dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;

    let ptys = &state.ptys;
    let id = ptys.next.fetch_add(1, Ordering::Relaxed);
    ptys.open.lock().map_err(err)?.insert(id, Pty { master: pair.master, writer: Arc::new(Mutex::new(writer)), child });

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let text = decode(&mut pending, &buf[..n]);
            if !text.is_empty() && on_event.send(PtyEvent::Data(text)).is_err() {
                break;
            }
        }
        // El shell terminó (o la ventana se cerró): recoger el proceso.
        if let Some(mut pty) = app.state::<AppState>().ptys.open.lock().ok().and_then(|mut m| m.remove(&id)) {
            let _ = pty.child.wait();
        }
        let _ = on_event.send(PtyEvent::Exit);
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<AppState>, id: u32, data: String) -> CmdResult<()> {
    let writer = state.ptys.open.lock().map_err(err)?.get(&id).map(|p| p.writer.clone()).ok_or("el terminal ya no existe")?;
    let mut w = writer.lock().map_err(err)?;
    w.write_all(data.as_bytes()).and_then(|_| w.flush()).map_err(err)
}

#[tauri::command]
pub fn pty_resize(state: State<AppState>, id: u32, cols: u16, rows: u16) -> CmdResult<()> {
    let open = state.ptys.open.lock().map_err(err)?;
    match open.get(&id) {
        Some(pty) => pty.master.resize(size(cols, rows)).map_err(err),
        None => Ok(()),
    }
}

/// Termina el shell. El hilo lector ve el fin de la salida y lo recoge.
#[tauri::command]
pub fn pty_close(state: State<AppState>, id: u32) -> CmdResult<()> {
    if let Some(pty) = state.ptys.open.lock().map_err(err)?.get_mut(&id) {
        let _ = pty.child.kill();
    }
    Ok(())
}

impl Ptys {
    pub fn has_open(&self) -> CmdResult<bool> {
        Ok(!self.open.lock().map_err(err)?.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_joins_split_characters() {
        let bytes = "añ€".as_bytes(); // 1 + 2 + 3 bytes
        let mut pending = Vec::new();
        assert_eq!(decode(&mut pending, &bytes[..2]), "a");
        assert_eq!(decode(&mut pending, &bytes[2..4]), "ñ");
        assert_eq!(decode(&mut pending, &bytes[4..]), "€");
        assert!(pending.is_empty());
        assert_eq!(decode(&mut pending, b"x\xffy"), "x\u{FFFD}y");
    }

    #[cfg(unix)]
    #[test]
    fn shell_runs_in_project_dir() {
        let dir = std::env::temp_dir();
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "pwd"]);
        cmd.cwd(&dir);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (mut out, mut pending, mut buf) = (String::new(), Vec::new(), [0u8; 1024]);
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            out += &decode(&mut pending, &buf[..n]);
            if out.contains('\n') {
                break;
            }
        }
        child.wait().unwrap();
        let want = crate::paths::canonical(&dir).unwrap();
        assert_eq!(crate::paths::canonical(std::path::Path::new(out.trim())).unwrap(), want);
    }
}
