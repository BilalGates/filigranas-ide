use std::{fs, path::{Path, PathBuf}};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Url;

use crate::{err, CmdResult};

const MAX_ATTACHMENTS: usize = 8;
const MAX_FILE: usize = 10 * 1024 * 1024;
const MAX_TOTAL: usize = 20 * 1024 * 1024;
const MAX_IMAGE: usize = 5_000_000;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Attachment {
    File { name: String, data: String },
    Link { url: String },
}

struct Staging {
    path: PathBuf,
    retained: bool,
}

impl Drop for Staging {
    fn drop(&mut self) {
        if !self.retained {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

struct Image {
    path: PathBuf,
    mime: &'static str,
    data: String,
}

pub struct Message {
    pub text: String,
    images: Vec<Image>,
    staging: Option<Staging>,
}

impl Message {
    pub fn text(text: String) -> Self {
        Self { text, images: Vec::new(), staging: None }
    }

    pub fn prepare(root: &Path, text: String, attachments: Vec<Attachment>) -> CmdResult<Self> {
        if attachments.is_empty() {
            return Ok(Self::text(text));
        }
        if attachments.len() > MAX_ATTACHMENTS {
            return Err("Puedes enviar hasta 8 adjuntos por mensaje.".into());
        }
        let mut message = Self::text(if text.trim().is_empty() { "Revisa los adjuntos.".into() } else { text });
        let mut total = 0;
        let mut entries = Vec::with_capacity(attachments.len());
        for (index, attachment) in attachments.into_iter().enumerate() {
            match attachment {
                Attachment::Link { url } => {
                    let url = link(&url)?;
                    entries.push(format!("- Enlace: {url}"));
                }
                Attachment::File { name, data } => {
                    let name = name.trim();
                    if name.is_empty() || name.len() > 1024 || name.chars().any(char::is_control) {
                        return Err("El nombre de un adjunto no es válido.".into());
                    }
                    if data.len() > MAX_FILE.div_ceil(3) * 4 {
                        return Err(format!("«{name}» supera los 10 MiB."));
                    }
                    let bytes = STANDARD.decode(&data).map_err(|_| format!("No se pudo leer «{name}»."))?;
                    total += bytes.len();
                    if bytes.len() > MAX_FILE || total > MAX_TOTAL {
                        return Err("Los archivos admiten 10 MiB cada uno y 20 MiB en total.".into());
                    }
                    let image = image_format(&bytes);
                    if image.is_some() && bytes.len() > MAX_IMAGE {
                        return Err(format!("La imagen «{name}» supera los 5 MB."));
                    }
                    if message.staging.is_none() {
                        message.staging = Some(staging(root)?);
                    }
                    let dir = &message.staging.as_ref().expect("directorio creado para el mensaje").path;
                    let extension = image.map(|(_, extension)| extension).or_else(|| {
                        Path::new(name).extension().and_then(|ext| ext.to_str())
                            .filter(|ext| ext.len() <= 16 && ext.bytes().all(|c| c.is_ascii_alphanumeric()))
                    });
                    let filename = match extension {
                        Some(ext) => format!("adjunto-{}.{ext}", index + 1),
                        None => format!("adjunto-{}", index + 1),
                    };
                    let path = dir.join(filename);
                    fs::write(&path, bytes).map_err(err)?;
                    entries.push(format!("- {} {} · ruta local: {}", if image.is_some() { "Imagen" } else { "Archivo" },
                        json!(name), json!(crate::paths::to_string(&path))));
                    if let Some((mime, _)) = image {
                        message.images.push(Image { path, mime, data });
                    }
                }
            }
        }
        message.text.push_str("\n\nAdjuntos del mensaje:\n");
        message.text.push_str(&entries.join("\n"));
        Ok(message)
    }

    pub fn has_images(&self) -> bool {
        !self.images.is_empty()
    }

    pub fn codex_images(&self) -> impl Iterator<Item = Value> + '_ {
        self.images.iter().map(|image| json!({
            "type": "localImage", "path": crate::paths::to_string(&image.path)
        }))
    }

    pub fn take_claude_images(&mut self) -> impl Iterator<Item = Value> {
        std::mem::take(&mut self.images).into_iter().map(|image| json!({
            "type": "image", "source": { "type": "base64", "media_type": image.mime, "data": image.data }
        }))
    }

    pub fn retain_files(&mut self) {
        if let Some(staging) = &mut self.staging {
            staging.retained = true;
        }
    }
}

fn staging(root: &Path) -> CmdResult<Staging> {
    let dir = root.join("chat-attachments");
    fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join(uuid::Uuid::new_v4().to_string());
    #[cfg(unix)]
    let result = {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(&path)
    };
    #[cfg(not(unix))]
    let result = fs::create_dir(&path);
    result.map_err(err)?;
    Ok(Staging { path, retained: false })
}

fn link(value: &str) -> CmdResult<Url> {
    if value.len() <= 4096 {
        if let Ok(url) = Url::parse(value.trim()) {
            if matches!(url.scheme(), "http" | "https") && url.host().is_some() && url.username().is_empty() && url.password().is_none() {
                return Ok(url);
            }
        }
    }
    Err("Introduce un enlace HTTP o HTTPS válido.".into())
}

fn image_format(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(("image/webp", "webp"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("filigranas-attachments-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn stages_real_bytes_and_builds_the_two_image_protocols() {
        let root = Temp::new();
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVE0AAAAASUVORK5CYII=";
        let mut message = Message::prepare(&root.0, String::new(), vec![
            Attachment::File { name: "Captura.png".into(), data: png.into() },
            Attachment::File { name: "informe.bin".into(), data: STANDARD.encode([0, 1, 255]) },
            Attachment::Link { url: "https://example.com/docs#guia".into() },
        ]).unwrap();

        assert!(message.text.starts_with("Revisa los adjuntos."));
        assert!(message.text.contains("informe.bin") && message.text.contains("https://example.com/docs#guia"));
        let image = message.codex_images().next().unwrap();
        assert_eq!(image["type"], "localImage");
        let path = PathBuf::from(image["path"].as_str().unwrap());
        assert_eq!(fs::read(&path).unwrap(), STANDARD.decode(png).unwrap());
        assert_eq!(fs::read(path.with_file_name("adjunto-2.bin")).unwrap(), [0, 1, 255]);
        let image = message.take_claude_images().next().unwrap();
        assert_eq!(image["source"], json!({"type":"base64","media_type":"image/png","data":png}));

        message.retain_files();
        drop(message);
        assert!(path.is_file());
    }

    #[test]
    fn rejects_unsafe_links_and_cleans_a_partially_staged_message() {
        let root = Temp::new();
        let result = Message::prepare(&root.0, "prueba".into(), vec![
            Attachment::File { name: "nota.txt".into(), data: STANDARD.encode("una nota") },
            Attachment::Link { url: "file:///etc/hosts".into() },
        ]);
        assert!(result.is_err());
        assert_eq!(fs::read_dir(root.0.join("chat-attachments")).unwrap().count(), 0);
    }
}
