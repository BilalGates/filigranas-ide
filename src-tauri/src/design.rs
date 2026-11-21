use std::{io::Cursor, path::PathBuf, process::{Command, Stdio}};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager, State, Url};

use crate::{err, p5_process, workspace::project_path, AppState, CmdResult};

const MAX_IMAGE: usize = 4 * 1024 * 1024;

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS design_screens (
           id INTEGER PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
           constraints TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
           approved INTEGER REFERENCES design_shots(id), UNIQUE(project,name)
         );
         CREATE TABLE IF NOT EXISTS design_shots (
           id INTEGER PRIMARY KEY, screen INTEGER NOT NULL REFERENCES design_screens(id),
           png BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, source TEXT NOT NULL,
           url TEXT, note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate',
           observed INTEGER NOT NULL DEFAULT(unixepoch()), approved_constraints TEXT
         );
         CREATE INDEX IF NOT EXISTS design_shots_screen ON design_shots(screen,id);",
    )
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    id: Option<i64>,
    name: String,
    url: String,
    constraints: String,
    revision: Option<i64>,
    approved: Option<i64>,
}

#[derive(Serialize)]
pub struct Shot {
    id: i64,
    width: u32,
    height: u32,
    source: String,
    url: Option<String>,
    note: String,
    status: String,
    observed: i64,
}

#[derive(Deserialize)]
pub struct Region {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl Region {
    fn valid(&self) -> bool {
        self.width > 0 && self.height > 0 && self.x.saturating_add(self.width) <= 100
            && self.y.saturating_add(self.height) <= 100
    }
}

fn preview_url(value: &str) -> CmdResult<Url> {
    let u = Url::parse(value).map_err(|_| "URL de vista previa inválida")?;
    if u.scheme() != "http" || !matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        || !u.username().is_empty() || u.password().is_some() || u.query().is_some() || value.len() > 500 {
        return Err("usa una URL HTTP local, sin credenciales ni consulta".into());
    }
    Ok(u)
}

fn read_screen(conn: &Connection, project: &str, id: i64) -> CmdResult<Screen> {
    conn.query_row("SELECT id,name,url,constraints,revision,approved FROM design_screens WHERE project=?1 AND id=?2",
        params![project,id], screen_row).optional().map_err(err)?.ok_or_else(|| "pantalla fuera del proyecto".into())
}

fn screen_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Screen> {
    Ok(Screen { id: row.get(0)?, name: row.get(1)?, url: row.get(2)?, constraints: row.get(3)?,
        revision: row.get(4)?, approved: row.get(5)? })
}

#[tauri::command]
pub fn design_list(state: State<AppState>, project: String) -> CmdResult<Vec<Screen>> {
    let conn = state.db.lock().map_err(err)?;
    let project = project_path(&conn, &project)?;
    let mut q = conn.prepare("SELECT id,name,url,constraints,revision,approved FROM design_screens WHERE project=?1 ORDER BY name").map_err(err)?;
    let rows = q.query_map([project], screen_row).map_err(err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(err)
}

#[tauri::command]
pub fn design_save(state: State<AppState>, project: String, screen: Screen) -> CmdResult<i64> {
    let conn = state.db.lock().map_err(err)?;
    let project = project_path(&conn, &project)?;
    let url = if screen.url.trim().is_empty() { String::new() } else { preview_url(screen.url.trim())?.to_string() };
    let name = screen.name.trim();
    if name.is_empty() || name.len() > 100 || screen.constraints.len() > 8000 {
        return Err("indica el nombre de pantalla y hasta 8000 bytes de restricciones".into());
    }
    if let Some(id) = screen.id {
        let n = conn.execute("UPDATE design_screens SET name=?3,url=?4,constraints=?5,revision=revision+1
                              WHERE project=?1 AND id=?2 AND revision=?6",
            params![project,id,name,url,screen.constraints.trim(),screen.revision]).map_err(err)?;
        if n != 1 { return Err("la pantalla cambió, vuelve a abrirla".into()); }
        Ok(id)
    } else {
        conn.execute("INSERT INTO design_screens(project,name,url,constraints) VALUES(?1,?2,?3,?4)",
            params![project,name,url,screen.constraints.trim()]).map_err(err)?;
        Ok(conn.last_insert_rowid())
    }
}

#[tauri::command]
pub fn design_shots(state: State<AppState>, project: String, screen: i64) -> CmdResult<Vec<Shot>> {
    let conn = state.db.lock().map_err(err)?;
    read_screen(&conn, &project, screen)?;
    let mut q = conn.prepare("SELECT id,width,height,source,url,note,status,observed FROM design_shots
        WHERE screen=?1 ORDER BY id DESC").map_err(err)?;
    let rows = q.query_map([screen], |r| Ok(Shot { id:r.get(0)?,width:r.get(1)?,height:r.get(2)?,source:r.get(3)?,
        url:r.get(4)?,note:r.get(5)?,status:r.get(6)?,observed:r.get(7)? })).map_err(err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(err)
}

fn image(conn: &Connection, screen: i64, shot: i64) -> CmdResult<Vec<u8>> {
    conn.query_row("SELECT png FROM design_shots WHERE screen=?1 AND id=?2", params![screen,shot], |r| r.get(0))
        .optional().map_err(err)?.ok_or_else(|| "captura fuera de la pantalla".into())
}

#[tauri::command]
pub async fn design_image(app: AppHandle, project: String, screen: i64, shot: i64) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(err)?;
        read_screen(&conn, &project, screen)?;
        let bytes = image(&conn, screen, shot)?;
        drop(conn);
        Ok(STANDARD.encode(bytes))
    }).await.map_err(err)?
}

fn valid_size(w: u32, h: u32) -> bool {
    (64..=4096).contains(&w) && (64..=4096).contains(&h) && u64::from(w) * u64::from(h) <= 8_400_000
}

fn dimensions(bytes: &[u8]) -> CmdResult<(u32, u32)> {
    if bytes.len() > MAX_IMAGE { return Err("la captura PNG supera 4 MiB".into()); }
    let mut reader = png::Decoder::new(Cursor::new(bytes)).read_info().map_err(|_| "captura PNG inválida")?;
    let info = reader.info();
    let size = (info.width, info.height);
    if !valid_size(size.0, size.1) || info.animation_control.is_some() {
        return Err("usa un PNG estático de entre 64 y 4096 píxeles por lado y hasta 8,4 megapíxeles".into());
    }
    let len = reader.output_buffer_size().filter(|len| *len <= 68 * 1024 * 1024).ok_or("captura demasiado grande")?;
    reader.next_frame(&mut vec![0; len]).map_err(|_| "la captura PNG está incompleta")?;
    Ok(size)
}

fn save_image(conn: &Connection, screen: i64, image: &[u8], size: (u32,u32), source: &str, url: Option<&str>, note: &str) -> CmdResult<i64> {
    if note.len() > 1000 { return Err("la nota de la captura supera 1000 bytes".into()); }
    conn.execute("INSERT INTO design_shots(screen,png,width,height,source,url,note) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![screen,image,size.0,size.1,source,url,note.trim()]).map_err(err)?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub async fn design_import(app: AppHandle, project: String, screen: i64, png: String, note: String) -> CmdResult<i64> {
    tauri::async_runtime::spawn_blocking(move || {
        if png.len() > MAX_IMAGE.div_ceil(3)*4 { return Err("la captura PNG supera 4 MiB".into()); }
        let image = STANDARD.decode(png).map_err(|_| "captura PNG inválida")?;
        let size = dimensions(&image)?;
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(err)?;
        read_screen(&conn, &project, screen)?;
        save_image(&conn, screen, &image, size, "PNG importado", None, &note)
    }).await.map_err(err)?
}

#[tauri::command]
pub fn design_preview(state: State<AppState>, project: String, screen: i64) -> CmdResult<()> {
    let url = preview_url(&read_screen(&*state.db.lock().map_err(err)?, &project, screen)?.url)?;
    crate::pr::open_browser(url.as_str())
}

fn chrome() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let candidates = [PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")];
    #[cfg(windows)]
    let candidates = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"].into_iter()
        .filter_map(std::env::var_os).map(|root| PathBuf::from(root).join(r"Google\Chrome\Application\chrome.exe"));
    #[cfg(not(any(target_os = "macos", windows)))]
    let candidates = ["/usr/bin/google-chrome","/usr/bin/chromium"].map(PathBuf::from);
    candidates.into_iter().find(|path| path.is_file())
}

struct Scratch(PathBuf);

impl Scratch {
    fn create(prefix: &str) -> CmdResult<Self> {
        let path = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        #[cfg_attr(not(unix), allow(unused_mut))] // `mode` solo existe en Unix.
        let mut directory = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory.create(&path).map_err(err)?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

fn check_preview(url: &Url) -> CmdResult<()> {
    use std::{io::{BufRead, BufReader, Read, Write}, net::{IpAddr, SocketAddr, TcpStream}, time::Duration};
    let host = url.host_str().ok_or("falta el servidor de vista previa")?;
    let ip: IpAddr = match host {
        "localhost" => std::net::Ipv4Addr::LOCALHOST.into(),
        _ => host.trim_matches(['[',']']).parse().map_err(|_| "servidor no local")?,
    };
    let port = url.port_or_known_default().unwrap_or(80);
    let connect = |address| TcpStream::connect_timeout(&SocketAddr::new(address,port), Duration::from_secs(2));
    let mut stream = connect(ip).or_else(|error| {
        if host == "localhost" { connect(std::net::Ipv6Addr::LOCALHOST.into()) } else { Err(error) }
    }).map_err(|_| "el servidor de vista previa no responde")?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(err)?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(err)?;
    write!(stream,"GET {} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n",url.path()).map_err(err)?;
    let mut line = Vec::new();
    BufReader::new(stream.take(1024)).read_until(b'\n', &mut line).map_err(err)?;
    let mut parts = std::str::from_utf8(&line).unwrap_or_default().split_whitespace();
    let protocol = parts.next().unwrap_or_default();
    let status = parts.next().unwrap_or_default();
    if !protocol.starts_with("HTTP/") { return Err("respuesta HTTP inválida".into()); }
    if status.len() != 3 || !status.starts_with('2') { return Err("la vista previa debe responder con HTTP 2xx".into()); }
    Ok(())
}

fn capture(url: &Url, width: u32, height: u32) -> CmdResult<Vec<u8>> {
    if !valid_size(width, height) { return Err("tamaño de captura fuera de rango".into()); }
    let binary = chrome().ok_or("Chrome no está disponible. Puedes importar un PNG")?;
    check_preview(url)?;
    let root = Scratch::create("filigranas-preview")?;
    let mut command = Command::new(binary);
    command.current_dir(&root.0).args(["--headless","--no-first-run","--disable-extensions",
        "--disable-sync","--disable-background-networking","--no-proxy-server","--force-device-scale-factor=1",
        "--user-data-dir=profile","--screenshot=preview.png"])
        .arg(format!("--window-size={width},{height}")).arg(url.as_str());
    let result = p5_process::run(command, 25)?;
    if !result.success { return Err("Chrome no pudo capturar la vista previa".into()); }
    let path = root.0.join("preview.png");
    if path.metadata().map_err(|_| "Chrome no devolvió una captura")?.len() > MAX_IMAGE as u64 {
        return Err("la captura de Chrome supera 4 MiB".into());
    }
    let bytes = std::fs::read(path).map_err(err)?;
    if dimensions(&bytes)? != (width,height) { return Err("Chrome devolvió un tamaño distinto al solicitado".into()); }
    Ok(bytes)
}

#[tauri::command]
pub async fn design_generate(app: AppHandle, project: String, prompt: String, engine: CanvasEngine) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        if prompt.trim().is_empty() || prompt.len() > 64 * 1024 {
            return Err("el encargo de diseño está vacío o supera 64 KiB".into());
        }
        let state = app.state::<AppState>();
        {
            let conn = state.db.lock().map_err(err)?;
            project_path(&conn, &project)?;
        }
        let scratch = Scratch::create("filigranas-design")?;
        match engine {
            CanvasEngine::Claude => generate_with_claude(&scratch, &prompt),
            CanvasEngine::Codex => state.codex.run_structured(
                &app, &scratch.0.to_string_lossy(), CANVAS_INSTRUCTIONS, &prompt,
                canvas_schema(), "low", std::time::Duration::from_secs(180),
            ).map_err(|error| {
                if crate::handoff::quota_reason(&error).is_some() {
                    "Codex ha agotado su cuota. Puedes seguir editando las variantes que ya tienes.".into()
                } else {
                    format!("Codex no pudo generar las variantes: {error}")
                }
            }),
        }
    }).await.map_err(err)?
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasEngine { Claude, Codex }

const CANVAS_INSTRUCTIONS: &str = "Genera variantes de diseño para Filigranas IDE. Toda la información necesaria está en el encargo. Responde directamente con el JSON pedido, sin usar herramientas ni consultar archivos.";

fn canvas_schema() -> serde_json::Value {
    let row = json!({
        "type": "object", "additionalProperties": false, "required": ["id", "indent"],
        "properties": { "id": { "type": "string" }, "indent": { "type": "integer" } }
    });
    let group = json!({
        "type": "object", "additionalProperties": false, "required": ["title", "rows"],
        "properties": { "title": { "type": "string" }, "rows": { "type": "array", "items": row } }
    });
    let frame = json!({
        "type": "object", "additionalProperties": false,
        "required": ["title", "width", "height", "spacing", "groups"],
        "properties": {
            "title": { "type": "string" },
            "width": { "type": "integer" }, "height": { "type": "integer" }, "spacing": { "type": "integer" },
            "groups": { "type": "array", "items": group }
        }
    });
    json!({
        "type": "object", "additionalProperties": false, "required": ["variants"],
        "properties": { "variants": { "type": "array", "items": frame } }
    })
}

fn generate_with_claude(scratch: &Scratch, prompt: &str) -> CmdResult<String> {
    let path = scratch.0.join("prompt.txt");
    std::fs::write(&path, prompt).map_err(err)?;
    let input = std::fs::File::open(path).map_err(err)?;
    let mut command = Command::new(crate::cli::program("claude"));
    command.current_dir(&scratch.0).args([
        "--print", "--output-format", "json", "--no-session-persistence",
        "--tools", "", "--setting-sources", "", "--strict-mcp-config",
        "--mcp-config", r#"{"mcpServers":{}}"#,
        "--system-prompt", CANVAS_INSTRUCTIONS,
    ]);
    if let Some(path) = crate::cli::login_path() {
        command.env("PATH", path);
    }
    let output = p5_process::run_with_stdin(command, Stdio::from(input), 180).map_err(|error| {
        if error == p5_process::TIMEOUT {
            "Claude tardó demasiado en responder. Puedes volver a intentarlo."
        } else {
            "No se pudo iniciar Claude Code. Comprueba que está instalado."
        }
    })?;
    design_result(output)
}

fn design_result(output: p5_process::Output) -> CmdResult<String> {
    if output.truncated {
        return Err("La respuesta de Claude es demasiado larga.".into());
    }
    let reply: serde_json::Value = serde_json::from_slice(&output.bytes)
        .map_err(|_| "Claude no devolvió un resultado válido. Comprueba la conexión y tu sesión de Claude Code.")?;
    let result = reply["result"].as_str().filter(|text| !text.trim().is_empty());
    if !output.success || reply["is_error"] == true || reply["subtype"] != "success" {
        if crate::handoff::quota_reason(&reply.to_string()).is_some()
            || result.is_some_and(|text| text.to_ascii_lowercase().contains("weekly limit")) {
            return Err("Claude Code ha agotado su cuota. Puedes seguir editando las variantes que ya tienes.".into());
        }
        return Err(result.unwrap_or("Claude no pudo generar las variantes.").to_owned());
    }
    result.map(str::to_owned).ok_or("Claude devolvió una respuesta vacía.".into())
}

#[tauri::command]
pub async fn design_capture(app: AppHandle, project: String, screen: i64, width: u32, height: u32, note: String) -> CmdResult<i64> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let saved = read_screen(&*state.db.lock().map_err(err)?, &project, screen)?;
        let url = preview_url(&saved.url)?;
        let png = capture(&url, width, height)?;
        let conn = state.db.lock().map_err(err)?;
        save_image(&conn, screen, &png, (width,height), "Chrome", Some(url.as_str()), &note)
    }).await.map_err(err)?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    shot: i64,
    baseline: Option<i64>,
    revision: i64,
    approve: bool,
    confirmed: bool,
}

fn review_shot(conn: &Connection, project: &str, screen: i64, review: Review) -> CmdResult<()> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let saved = read_screen(&tx, project, screen)?;
    if saved.revision != Some(review.revision) || saved.approved != review.baseline {
        return Err("la referencia o las restricciones cambiaron. Compara de nuevo".into());
    }
    let (w,h): (u32,u32) = tx.query_row("SELECT width,height FROM design_shots WHERE id=?1 AND screen=?2 AND status='candidate'",
        params![review.shot,screen], |row| Ok((row.get(0)?,row.get(1)?)))
        .optional().map_err(err)?.ok_or("la captura ya no es una candidata")?;
    if review.approve {
        if !review.confirmed { return Err("confirma la revisión de restricciones y capturas".into()); }
        if let Some(before) = saved.approved {
            let size: (u32,u32) = tx.query_row("SELECT width,height FROM design_shots WHERE id=?1", [before],
                |r| Ok((r.get(0)?,r.get(1)?))).map_err(err)?;
            if size != (w,h) { return Err("la candidata debe tener el mismo tamaño que la referencia".into()); }
        }
        tx.execute("UPDATE design_shots SET status='approved',approved_constraints=?2 WHERE id=?1",
            params![review.shot,saved.constraints]).map_err(err)?;
        tx.execute("UPDATE design_screens SET approved=?2 WHERE id=?1", params![screen,review.shot]).map_err(err)?;
    } else {
        tx.execute("UPDATE design_shots SET status='discarded' WHERE id=?1", [review.shot]).map_err(err)?;
    }
    tx.commit().map_err(err)
}

#[tauri::command]
pub fn design_review(state: State<AppState>, project: String, screen: i64, review: Review) -> CmdResult<()> {
    review_shot(&*state.db.lock().map_err(err)?, &project, screen, review)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    session: i64,
    screen: i64,
    shot: i64,
    region: Region,
    request: String,
    compare: bool,
    confirmed: bool,
}

#[tauri::command]
pub async fn design_send(app: AppHandle, project: String, brief: Brief) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if !brief.confirmed || !brief.region.valid() || !(1..=4000).contains(&brief.request.trim().len()) {
            return Err("confirma el envío e indica una región y un encargo válido".into());
        }
        let state = app.state::<AppState>();
        let (screen, pngs) = {
            let conn = state.db.lock().map_err(err)?;
            let screen = read_screen(&conn, &project, brief.screen)?;
            crate::db::session(&conn, brief.session).map_err(err)?
                .filter(|s| s.project == project && s.engine == "claude" && s.worktree.is_some())
                .ok_or("elige una sesión Claude en un worktree de este proyecto")?;
            let mut images = vec![image(&conn, brief.screen, brief.shot)?];
            if brief.compare {
                let before = screen.approved.filter(|id| *id != brief.shot).ok_or("elige una candidata y una referencia aprobada")?;
                images.insert(0, image(&conn, brief.screen, before)?);
            }
            (screen, images)
        };
        if brief.compare && dimensions(&pngs[0])? != dimensions(&pngs[1])? {
            return Err("las capturas deben tener el mismo tamaño para compararlas".into());
        }
        let action = if brief.compare {
            "Compara visualmente la primera imagen (referencia) con la segunda (candidata). Señala diferencias observables y restricciones afectadas. No edites archivos."
        } else {
            "Implementa el cambio pedido en el worktree. Conserva todos los elementos bloqueados; si un requisito entra en conflicto, consulta al usuario."
        };
        let region = brief.region;
        let text = format!(
            "{action}\nPantalla: {}\nRegión como porcentaje del ancho y alto: x={}, y={}, ancho={}, alto={}\nRestricciones de diseño bloqueadas:\n{}\nEncargo:\n{}",
            screen.name,region.x,region.y,region.width,region.height,screen.constraints,brief.request.trim());
        let images = pngs.into_iter().map(|png| json!({"type":"image","source":{
            "type":"base64","media_type":"image/png","data":STANDARD.encode(png)}})).collect();
        crate::claude::send_with_images(&app, brief.session, &text, images)
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn png() -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, 64,64);
        encoder.set_color(png::ColorType::Rgb);
        encoder.write_header().unwrap().write_image_data(&[0;64*64*3]).unwrap();
        bytes
    }

    #[test]
    fn canvas_generation_reads_only_successful_claude_results() {
        let output = |success, truncated, reply: &str| p5_process::Output {
            success, truncated, bytes: reply.as_bytes().to_vec(),
        };
        let reply = r#"{"subtype":"success","is_error":false,"result":"{\"variants\":[]}"}"#;
        assert_eq!(design_result(output(true, false, reply)).unwrap(), r#"{"variants":[]}"#);
        assert!(design_result(output(true, true, reply)).is_err());
        let quota = r#"{"subtype":"error_during_execution","is_error":true,"result":"cuota agotada"}"#;
        assert_eq!(design_result(output(false, false, quota)).unwrap_err(), "cuota agotada");
        let weekly = r#"{"subtype":"success","is_error":true,"result":"You've hit your weekly limit"}"#;
        assert!(design_result(output(true, false, weekly)).unwrap_err().contains("ha agotado su cuota"));
        assert!(design_result(output(false, false, "not JSON")).is_err());
    }

    #[test]
    fn rejects_non_local_urls_and_malformed_images() {
        for url in ["https://example.invalid","http://localhost@evil.invalid","file:///tmp/main.html","http://127.0.0.1/?token=secret"] {
            assert!(preview_url(url).is_err());
        }
        assert!(preview_url("http://127.0.0.1:3000/page#board").is_ok());
        assert_eq!(dimensions(&png()).unwrap(), (64,64));
        assert!(dimensions(&png()[..25]).is_err());
    }

    #[test]
    fn approval_preserves_constraints_and_rejects_stale_or_mismatched_reviews() {
        let conn = crate::db::open(Path::new(":memory:")).unwrap();
        conn.execute("INSERT INTO design_screens(id,project,name,url,constraints) VALUES(1,'p','Home','','Locked header')", []).unwrap();
        let first = save_image(&conn,1,&png(),(64,64),"fixture",None,"before").unwrap();
        let approval = |shot, baseline, revision, confirmed| Review { shot,baseline,revision,confirmed,approve:true };
        assert!(review_shot(&conn,"p",1,approval(first,None,1,false)).is_err());
        assert!(review_shot(&conn,"another",1,approval(first,None,1,true)).is_err());
        review_shot(&conn,"p",1,approval(first,None,1,true)).unwrap();
        let second = save_image(&conn,1,&png(),(128,64),"fixture",None,"after").unwrap();
        assert!(review_shot(&conn,"p",1,approval(second,Some(first),1,true)).is_err());
        let third = save_image(&conn,1,&png(),(64,64),"fixture",None,"after").unwrap();
        assert!(review_shot(&conn,"p",1,approval(third,None,1,true)).is_err());
        assert!(review_shot(&conn,"p",1,approval(third,Some(first),2,true)).is_err());
        review_shot(&conn,"p",1,approval(third,Some(first),1,true)).unwrap();
        assert_eq!(read_screen(&conn,"p",1).unwrap().approved, Some(third));
        let locked: String = conn.query_row("SELECT approved_constraints FROM design_shots WHERE id=?1", [first], |r| r.get(0)).unwrap();
        assert_eq!(locked, "Locked header");
    }

    #[test]
    #[ignore = "requires an installed Chrome and loopback"]
    fn captures_real_local_page_at_the_requested_size() {
        use std::{io::{Read,Write},net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = preview_url(&format!("http://{}/",listener.local_addr().unwrap())).unwrap();
        std::thread::spawn(move || {
            for mut socket in listener.incoming().flatten() {
                let _ = socket.read(&mut [0;2048]);
                let body = b"<!doctype html><style>body{background:#1c4f9a}</style><p>Design fixture</p>";
                let _ = write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
                let _ = socket.write_all(body);
            }
        });
        let image = capture(&url, 800, 600).unwrap();
        assert_eq!(dimensions(&image).unwrap(), (800,600));
        let mut reader = png::Decoder::new(Cursor::new(image)).read_info().unwrap();
        let mut buffer = vec![0;reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut buffer).unwrap();
        assert_eq!(&buffer[..3], &[0x1c,0x4f,0x9a]);
    }
}
