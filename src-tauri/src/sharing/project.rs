use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
#[cfg(unix)]
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{files, git, paths, CmdResult};

const MAX_ENTRIES: usize = 2_000;

#[derive(Deserialize, Serialize)]
pub(crate) struct Entry {
    name: String,
    path: String,
    dir: bool,
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains(['\\', ':'])
        && path.split('/').all(|part| {
            !part.is_empty()
                && !matches!(part, "." | "..")
                && !part.ends_with(['.', ' '])
                && !part.chars().any(char::is_control)
                && !part.eq_ignore_ascii_case(".git")
        })
}

/// El índice delimita lo que se comparte; el contenido se lee del disco.
fn tracked(root: &Path, path: Option<&str>) -> CmdResult<Vec<String>> {
    let bytes = match path {
        Some(path) => git::git(root, &["--literal-pathspecs", "ls-files", "--stage", "-z", "--full-name", "--", path]),
        None => git::git(root, &["ls-files", "--stage", "-z", "--full-name"]),
    }.map_err(|_| "no se pudo consultar el índice del proyecto")?;
    let paths = bytes
        .split(|b| *b == 0)
        .filter_map(|item| std::str::from_utf8(item).ok())
        .filter_map(|item| item.split_once('\t'))
        .filter(|(header, path)| {
            (header.starts_with("100644 ") || header.starts_with("100755 "))
                && header.ends_with(" 0")
                && valid_path(path)
        })
        .map(|(_, path)| path.to_owned())
        .collect();
    Ok(paths)
}

fn list(root: &Path, path: &str) -> CmdResult<Vec<Entry>> {
    if !path.is_empty() && !valid_path(path) {
        return Err("carpeta no compartida".into());
    }
    if !path.is_empty() {
        let folder = root.join(path);
        if !matches!(paths::canonical(&folder), Ok(actual) if actual == folder) {
            return Err("carpeta no compartida".into());
        }
    }
    let prefix = if path.is_empty() { String::new() } else { format!("{path}/") };
    let mut entries = BTreeMap::new();
    for file in tracked(root, None)? {
        let Some(relative) = file.strip_prefix(&prefix) else { continue };
        let (name, dir) = match relative.split_once('/') {
            Some((name, _)) => (name, true),
            None => (relative, false),
        };
        let child = format!("{prefix}{name}");
        let full = root.join(&child);
        if !matches!(std::fs::symlink_metadata(&full), Ok(meta) if
            !meta.file_type().is_symlink() && if dir { meta.is_dir() } else { meta.is_file() })
        {
            continue;
        }
        entries.insert((!dir, name.to_lowercase(), name.to_owned()), Entry { name: name.into(), path: child, dir });
        if entries.len() > MAX_ENTRIES {
            return Err("la carpeta contiene demasiados elementos para mostrarlos".into());
        }
    }
    Ok(entries.into_values().collect())
}

pub(super) struct Project {
    root: PathBuf,
    #[cfg(unix)]
    folder: File,
}

impl Project {
    pub(super) fn open(root: PathBuf) -> CmdResult<Self> {
        #[cfg(unix)]
        let folder = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new().read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(&root).map_err(|_| "no se pudo abrir la carpeta compartida")?
        };

        Ok(Self {
            root,
            #[cfg(unix)]
            folder,
        })
    }

    fn check_root(&self) -> CmdResult<()> {
        if !matches!(paths::canonical(&self.root), Ok(actual) if actual == self.root) {
            return Err("la carpeta compartida ya no está disponible".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let current = self.root.metadata().map_err(crate::err)?;
            let original = self.folder.metadata().map_err(crate::err)?;
            if (current.dev(), current.ino()) != (original.dev(), original.ino()) {
                return Err("la carpeta compartida se ha sustituido".into());
            }
        }
        Ok(())
    }

    pub(super) fn list(&self, path: &str) -> CmdResult<Vec<Entry>> {
        self.check_root()?;
        list(&self.root, path)
    }

    pub(super) fn read(&self, path: &str) -> CmdResult<String> {
        self.check_root()?;
        require_tracked(self, path)?;
        let file = open_inside(self, path).map_err(|_| "archivo no disponible en el proyecto compartido")?;
        files::text(read_bytes(&file)?)
    }

    pub(super) fn write(&self, path: &str, content: &str, expected: &str) -> CmdResult<()> {
        let _save = files::SAVE_GATE.lock().map_err(crate::err)?;
        self.check_root()?;
        require_tracked(self, path)?;
        if content.len() as u64 > files::MAX_TEXT || content.contains('\0') {
            return Err("solo se pueden guardar archivos de texto de hasta 2 MB".into());
        }
        replace_inside(self, path, content, expected)
    }
}

fn require_tracked(project: &Project, path: &str) -> CmdResult<()> {
    if valid_path(path) && tracked(&project.root, Some(path))?.iter().any(|file| file == path) {
        Ok(())
    } else {
        Err("archivo no compartido".into())
    }
}

fn read_bytes(file: &File) -> CmdResult<Vec<u8>> {
    let meta = file.metadata().map_err(|_| "archivo no disponible")?;
    if !meta.is_file() {
        return Err("solo se pueden abrir archivos normales".into());
    }
    if meta.len() > files::MAX_TEXT {
        return Err("archivo demasiado grande para el visor".into());
    }
    let mut bytes = Vec::new();
    file.take(files::MAX_TEXT + 1).read_to_end(&mut bytes).map_err(|_| "no se pudo leer el archivo")?;
    if bytes.len() as u64 > files::MAX_TEXT {
        return Err("archivo demasiado grande para el visor".into());
    }
    Ok(bytes)
}

pub(super) fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn check_revision(file: &File, content: &str, expected: &str) -> CmdResult<()> {
    let bytes = read_bytes(file)?;
    if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
        return Err("solo se pueden editar archivos de texto UTF-8".into());
    }
    // Si se perdió la respuesta de un guardado, repetirlo es seguro.
    if bytes != content.as_bytes() && revision(&bytes) != expected {
        return Err("El archivo cambió en el equipo anfitrión. Copia tu borrador antes de abrir la versión actual.".into());
    }
    Ok(())
}

#[cfg(unix)]
fn open_at(folder: &File, name: &std::ffi::CStr, flags: libc::c_int) -> std::io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let flags = flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    let fd = unsafe { libc::openat(folder.as_raw_fd(), name.as_ptr(), flags, 0o600 as libc::c_int) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn open_parent(project: &Project, path: &str) -> std::io::Result<(File, std::ffi::CString)> {
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    let mut folder = project.folder.try_clone()?;
    for part in parent.split('/').filter(|part| !part.is_empty()) {
        let part = std::ffi::CString::new(part)?;
        folder = open_at(&folder, &part, libc::O_RDONLY | libc::O_DIRECTORY)?;
    }
    Ok((folder, std::ffi::CString::new(name)?))
}

#[cfg(unix)]
fn open_regular(folder: &File, name: &std::ffi::CStr) -> std::io::Result<File> {
    use std::os::unix::fs::MetadataExt;
    let file = open_at(folder, name, libc::O_RDONLY)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.nlink() != 1 {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
}

#[cfg(unix)]
fn open_inside(project: &Project, path: &str) -> std::io::Result<File> {
    let (folder, name) = open_parent(project, path)?;
    open_regular(&folder, &name)
}

#[cfg(unix)]
fn replace_inside(project: &Project, path: &str, content: &str, expected: &str) -> CmdResult<()> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let unavailable = "archivo no disponible en el proyecto compartido";
    let (folder, name) = open_parent(project, path).map_err(|_| unavailable)?;
    let temporary = std::ffi::CString::new(format!(".filigranas-{}.tmp", uuid::Uuid::new_v4())).map_err(crate::err)?;
    let mut output = open_at(&folder, &temporary, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)
        .map_err(|_| "no se pudo preparar el guardado")?;
    let result = (|| {
        output.write_all(content.as_bytes()).map_err(|_| "no se pudo guardar el contenido")?;
        require_tracked(project, path)?;
        project.check_root()?;
        let (current, _) = open_parent(project, path).map_err(|_| unavailable)?;
        let before = folder.metadata().map_err(|_| unavailable)?;
        let after = current.metadata().map_err(|_| unavailable)?;
        if (before.dev(), before.ino()) != (after.dev(), after.ino()) {
            return Err(unavailable.into());
        }
        let file = open_regular(&folder, &name).map_err(|_| unavailable)?;
        let mode = file.metadata().map_err(|_| unavailable)?.permissions().mode() & 0o777;
        output.set_permissions(std::fs::Permissions::from_mode(mode)).map_err(|_| "no se pudieron conservar los permisos")?;
        check_revision(&file, content, expected)?;
        let fd = folder.as_raw_fd();
        if unsafe { libc::renameat(fd, temporary.as_ptr(), fd, name.as_ptr()) } != 0 {
            return Err("no se pudo sustituir el archivo".into());
        }
        Ok(())
    })();
    if result.is_err() {
        unsafe { libc::unlinkat(folder.as_raw_fd(), temporary.as_ptr(), 0) };
    }
    result
}

#[cfg(windows)]
fn replace_inside(project: &Project, path: &str, content: &str, expected: &str) -> CmdResult<()> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let target = project.root.join(path.replace('/', "\\"));
    let parent = target.parent().ok_or("archivo sin carpeta")?;
    // Mantener abiertos los ancestros impide que se renombren durante el guardado.
    let mut pinned = Vec::new();
    for dir in parent.ancestors().filter(|dir| dir.has_root()) {
        let handle = std::fs::OpenOptions::new().read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(dir).map_err(|_| "no se pudo abrir la carpeta compartida")?;
        let meta = handle.metadata().map_err(crate::err)?;
        if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("la carpeta compartida no está disponible".into());
        }
        pinned.push(handle);
    }
    project.check_root()?;
    let file = open_inside(project, path).map_err(|_| "archivo no disponible en el proyecto compartido")?;
    check_revision(&file, content, expected)?;
    drop(file);
    files::write_file_checked(&target, content, || {
        require_tracked(project, path)?;
        let file = open_inside(project, path).map_err(|_| "archivo no disponible en el proyecto compartido")?;
        check_revision(&file, content, expected)
    }).map_err(|error| if error.starts_with("El archivo cambió") { error } else { "no se pudo guardar el archivo compartido".into() })
}

#[cfg(windows)]
fn open_inside(project: &Project, path: &str) -> std::io::Result<File> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
    };

    let expected = project.root.join(path.replace('/', "\\"));
    let file = File::open(&expected)?;
    let handle = file.as_raw_handle().cast();
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let mut resolved = vec![0; 32768];
    // Consulta el objeto ya abierto para detectar un enlace o junction
    // aunque se haya sustituido la ruta entre la consulta y la apertura.
    let len = unsafe { GetFinalPathNameByHandleW(handle, resolved.as_mut_ptr(), resolved.len() as u32, 0) } as usize;
    if len == 0 || len >= resolved.len() {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let actual = PathBuf::from(OsString::from_wide(&resolved[..len]));
    if dunce::simplified(&actual) != expected || info.nNumberOfLinks != 1 {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
}
