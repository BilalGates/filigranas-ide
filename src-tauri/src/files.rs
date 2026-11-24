use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::{err, paths, workspace::root_of, AppState, CmdResult};

/// Tamaño máximo que el visor carga de una vez.
pub(crate) const MAX_TEXT: u64 = 2 * 1024 * 1024;
pub(crate) static SAVE_GATE: Mutex<()> = Mutex::new(());

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
    let root = root_of(&*state.db.lock().map_err(err)?)?;
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
pub fn write_text(state: State<AppState>, path: String, content: String, session: Option<i64>, previous: Option<String>) -> CmdResult<()> {
    let root = root_for(&state, session)?;
    let file = paths::inside(&root, Path::new(&path))?;
    let _save = SAVE_GATE.lock().map_err(err)?;
    if let Some(previous) = previous {
        write_file_checked(&file, &content, || {
            let current = read_file(&file)?;
            if current != previous && current != content {
                return Err("El archivo cambió en disco. Conserva tu borrador antes de abrir la versión actual.".into());
            }
            Ok(())
        })
    } else {
        write_file(&file, &content)
    }
}

/// Sustituye un archivo completo sin compartir temporales entre guardados.
fn write_file(file: &Path, content: &str) -> CmdResult<()> {
    write_file_checked(file, content, || Ok(()))
}

pub(crate) fn write_file_checked(file: &Path, content: &str, check: impl FnOnce() -> CmdResult<()>) -> CmdResult<()> {
    if content.len() as u64 > MAX_TEXT {
        return Err(format!("archivo demasiado grande ({} KB)", content.len() / 1024));
    }
    let meta = std::fs::metadata(file).map_err(err)?;
    if !meta.is_file() {
        return Err("solo se pueden guardar archivos existentes".into());
    }
    let name = file.file_name().ok_or("ruta sin nombre")?.to_string_lossy();
    let tmp = file.with_file_name(format!(".{name}.filigranas-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> CmdResult<()> {
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(err)?;
        output.write_all(content.as_bytes()).map_err(err)?;
        output.set_permissions(meta.permissions()).map_err(err)?;
        drop(output);
        check()?;
        std::fs::rename(&tmp, file).map_err(err)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Lee un archivo de texto dentro de la raíz. Rechaza binarios y archivos grandes.
#[tauri::command]
pub fn read_text(state: State<AppState>, path: String, session: Option<i64>) -> CmdResult<String> {
    read_file(&paths::inside(&root_for(&state, session)?, Path::new(&path))?)
}

/// Carpeta dentro de la que se puede leer o escribir: la de proyectos o, para
/// los archivos de una sesión aislada, su worktree (registrado por el IDE).
fn root_for(state: &AppState, session: Option<i64>) -> CmdResult<std::path::PathBuf> {
    let conn = state.db.lock().map_err(err)?;
    match session {
        None => root_of(&conn),
        Some(id) => {
            let s = crate::db::session_any(&conn, id).map_err(err)?.ok_or("la sesión no existe")?;
            Ok(std::path::PathBuf::from(s.worktree.ok_or("la sesión no tiene rama propia")?))
        }
    }
}

/// Lee un archivo ya validado. Rechaza binarios y archivos grandes.
pub(crate) fn read_file(file: &Path) -> CmdResult<String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    // Comprobar el objeto abierto y acotar la lectura aunque cambie su tamaño.
    let file = options.open(file).map_err(err)?;
    let meta = file.metadata().map_err(err)?;
    if !meta.is_file() {
        return Err("solo se pueden leer archivos normales".into());
    }
    if meta.len() > MAX_TEXT {
        return Err(format!("archivo demasiado grande ({} KB)", meta.len() / 1024));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_TEXT + 1).read_to_end(&mut bytes).map_err(err)?;
    text(bytes)
}

/// Convierte bytes en texto con los mismos límites que el visor.
pub(crate) fn text(bytes: Vec<u8>) -> CmdResult<String> {
    if bytes.len() as u64 > MAX_TEXT {
        return Err(format!("archivo demasiado grande ({} KB)", bytes.len() / 1024));
    }
    if bytes.contains(&0) {
        return Err("archivo binario".into());
    }
    String::from_utf8(bytes).map_err(|_| "el archivo no está codificado en UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("filigranas-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn editor_reads_only_regular_utf8_files_under_the_size_limit() {
        let dir = temp_dir();
        let file = dir.join("note.txt");
        std::fs::write(&file, "nota de prueba").unwrap();
        assert_eq!(read_file(&file).unwrap(), "nota de prueba");
        assert!(read_file(&dir).is_err());

        std::fs::write(&file, "x".repeat(MAX_TEXT as usize + 1)).unwrap();
        assert!(read_file(&file).unwrap_err().contains("demasiado grande"));
        std::fs::write(&file, [b'a', 0xe9, b'z']).unwrap();
        assert!(read_file(&file).unwrap_err().contains("UTF-8"));
        let mut content = vec![b'x'; 9000];
        content.push(0);
        std::fs::write(&file, content).unwrap();
        assert_eq!(read_file(&file).unwrap_err(), "archivo binario");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_a_save_that_cannot_be_read_back() {
        let dir = temp_dir();
        let file = dir.join("note.txt");
        std::fs::write(&file, "original").unwrap();

        assert!(write_file(&file, &"x".repeat(MAX_TEXT as usize + 1)).unwrap_err().contains("demasiado grande"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn uses_a_private_temporary_file() {
        let dir = temp_dir();
        let file = dir.join("note.txt");
        let old_temp = dir.join(".note.txt.filigranas-tmp");
        std::fs::write(&file, "original").unwrap();
        std::fs::write(&old_temp, "unrelated").unwrap();

        write_file(&file, "saved").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "saved");
        assert_eq!(std::fs::read_to_string(&old_temp).unwrap(), "unrelated");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_revision_check_leaves_the_current_file_and_cleans_up() {
        let dir = temp_dir();
        let file = dir.join("note.txt");
        std::fs::write(&file, "versión actual").unwrap();

        let result = write_file_checked(&file, "borrador antiguo", || Err("cambió en disco".into()));
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "versión actual");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn preserves_executable_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir();
        let file = dir.join("run.sh");
        std::fs::write(&file, "old").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();

        write_file(&file, "new").unwrap();
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o755);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
