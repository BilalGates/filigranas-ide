use std::io::Read;
use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::{err, paths, workspace::root_of, AppState, CmdResult};

/// Tamaño máximo que el visor carga de una vez.
const MAX_TEXT: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    dir: bool,
}

/// Contenido de una carpeta dentro de la raíz: carpetas primero, sin `.git`.
#[tauri::command]
pub fn list_dir(state: State<AppState>, path: String) -> CmdResult<Vec<Entry>> {
    let root = root_of(&state.db.lock().map_err(err)?)?;
    let dir = paths::inside(&root, Path::new(&path))?;
    let mut entries: Vec<Entry> = std::fs::read_dir(&dir)
        .map_err(err)?
        .filter_map(Result::ok)
        .filter(|e| e.file_name() != ".git")
        .map(|e| {
            let dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            Entry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: paths::to_string(&e.path()),
                dir,
            }
        })
        .collect();
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

/// Guarda un archivo de texto existente dentro de la raíz. No crea archivos
/// nuevos: eso llegará con acciones explícitas del árbol. Escribe primero en
/// un temporal junto al archivo y lo renombra, para no dejarlo a medias.
#[tauri::command]
pub fn write_text(state: State<AppState>, path: String, content: String) -> CmdResult<()> {
    let root = root_of(&state.db.lock().map_err(err)?)?;
    let file = paths::inside(&root, Path::new(&path))?;
    if !file.is_file() {
        return Err("solo se pueden guardar archivos existentes".into());
    }
    let name = file.file_name().ok_or("ruta sin nombre")?.to_string_lossy();
    let tmp = file.with_file_name(format!(".{name}.filigranas-tmp"));
    std::fs::write(&tmp, content.as_bytes()).map_err(err)?;
    std::fs::rename(&tmp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        err(e)
    })
}

/// Lee un archivo de texto dentro de la raíz. Rechaza binarios y archivos grandes.
#[tauri::command]
pub fn read_text(state: State<AppState>, path: String) -> CmdResult<String> {
    let root = root_of(&state.db.lock().map_err(err)?)?;
    let file = paths::inside(&root, Path::new(&path))?;
    let meta = std::fs::metadata(&file).map_err(err)?;
    if meta.len() > MAX_TEXT {
        return Err(format!("archivo demasiado grande ({} KB)", meta.len() / 1024));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    std::fs::File::open(&file).map_err(err)?.read_to_end(&mut bytes).map_err(err)?;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err("archivo binario".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
