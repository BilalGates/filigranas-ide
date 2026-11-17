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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_traversal_and_nested_projects() {
        let dir = std::env::temp_dir().join(format!("filigranas-paths-{}", uuid::Uuid::new_v4()));
        let root = dir.join("projects");
        let child = root.join("repo");
        std::fs::create_dir_all(child.join("nested")).unwrap();
        std::fs::write(dir.join("outside.txt"), "outside").unwrap();
        assert!(inside(&root, &root.join("../outside.txt")).is_err());
        assert!(direct_child(&root, &child).is_ok());
        assert!(direct_child(&root, &child.join("nested")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_outside_root() {
        let dir = std::env::temp_dir().join(format!("filigranas-path-link-{}", uuid::Uuid::new_v4()));
        let root = dir.join("projects");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(dir.join("private.txt"), "outside").unwrap();
        std::os::unix::fs::symlink(dir.join("private.txt"), root.join("link.txt")).unwrap();
        assert!(inside(&root, &root.join("link.txt")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
