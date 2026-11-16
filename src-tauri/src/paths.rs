use std::path::{Path, PathBuf};

/// Ruta canónica sin el prefijo `\\?\` de Windows.
pub fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// Comprueba que `path` está dentro de `root` (ambas canónicas) y devuelve
/// la ruta canónica. Evita que la interfaz lea fuera de la carpeta elegida.
pub fn inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = canonical(root).map_err(|e| format!("carpeta raíz no válida: {e}"))?;
    let path = canonical(path).map_err(|e| format!("ruta no válida: {e}"))?;
    if path.starts_with(&root) {
        Ok(path)
    } else {
        Err("ruta fuera de la carpeta de proyectos".into())
    }
}

/// Como `inside`, pero además exige que sea un hijo directo de la raíz.
pub fn direct_child(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root_c = canonical(root).map_err(|e| format!("carpeta raíz no válida: {e}"))?;
    let path = inside(&root_c, path)?;
    if path.parent() == Some(root_c.as_path()) {
        Ok(path)
    } else {
        Err("no es un proyecto de la carpeta raíz".into())
    }
}

pub fn to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
