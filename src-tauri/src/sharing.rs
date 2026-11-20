mod project;

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Url};

use crate::{err, isolate, paths, system_curl, AppState, CmdResult};

const MAX_WIRE: u64 = 16 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct Sharing {
    host: Mutex<Option<Host>>,
    guest: Mutex<Option<Connection>>,
    operations: Mutex<()>,
}

#[derive(Clone)]
struct Connection {
    relay: Url,
    id: String,
    key: String,
}

struct Host {
    connection: Connection,
    info: HostInfo,
    cancelled: Arc<AtomicBool>,
    editable: Arc<Mutex<bool>>,
}

impl Host {
    fn set_access(&mut self, editable: bool) -> CmdResult<HostInfo> {
        let mut permission = self.editable.lock().map_err(err)?;
        if !editable {
            *permission = false;
            self.info.editable = false;
        }
        let result: Value = self.connection.post("access", Some(json!({ "editable": editable })))
            .map_err(|e| if e.code == 404 { "actualiza el servicio de colaboración para cambiar permisos".into() } else { e.message })?;
        if result["editable"].as_bool() != Some(editable) {
            return Err(RelayError::invalid().message);
        }
        *permission = editable;
        self.info.editable = editable;
        Ok(self.info.clone())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostInfo {
    name: String,
    invitation: String,
    expires_at: u64,
    editable: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    id: String,
    host: String,
    invite: String,
    expires_at: u64,
    #[serde(default)]
    editable: bool,
}

#[derive(Deserialize)]
struct Joined {
    name: String,
    guest: String,
    #[serde(default)]
    editable: bool,
}

#[derive(Serialize)]
pub(crate) struct GuestInfo {
    name: String,
    editable: bool,
}

#[derive(Serialize)]
pub(crate) struct FileVersion {
    text: String,
    revision: String,
}

#[derive(Deserialize)]
struct Operation {
    id: String,
    action: Action,
    path: String,
    content: Option<String>,
    revision: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    List,
    Read,
    Write,
}

impl Action {
    fn endpoint(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Status {
    online: bool,
    #[serde(default)]
    editable: bool,
    // Solo el cliente añade este campo cuando el acceso fue revocado.
    #[serde(default)]
    closed: bool,
}

struct RelayError {
    code: u16,
    message: String,
}

impl RelayError {
    fn unavailable() -> Self {
        Self { code: 0, message: "no se pudo conectar con el servicio de colaboración".into() }
    }

    fn invalid() -> Self {
        Self { code: 0, message: "el servicio envió una respuesta no válida".into() }
    }
}

fn valid_key(value: &str) -> bool {
    value.len() == 43 && value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

fn relay_url(input: &str) -> CmdResult<Url> {
    if input.len() > 2048 {
        return Err("dirección del servicio no válida".into());
    }
    let mut url = Url::parse(input.trim()).map_err(|_| "dirección del servicio no válida")?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("usa la dirección HTTPS del servicio, sin ruta ni parámetros".into());
    }
    url.set_path("/");
    Ok(url)
}

fn invitation(input: &str) -> CmdResult<Connection> {
    if input.len() > 2200 {
        return Err("invitación no válida".into());
    }
    let (origin, payload) = input.trim().split_once("#filigranas-v1.").ok_or("invitación no válida")?;
    let (id, key) = payload.split_once('.').filter(|(id, key)| valid_key(id) && valid_key(key))
        .ok_or("invitación no válida")?;
    Ok(Connection { relay: relay_url(origin)?, id: id.into(), key: key.into() })
}

fn post<T: DeserializeOwned>(relay: &Url, endpoint: &str, body: &Value) -> Result<T, RelayError> {
    let url = relay.join(&format!("v1/{endpoint}")).map_err(|_| RelayError::invalid())?;
    let protocol = if relay.scheme() == "https" { "=https" } else { "=http" };
    let mut child = system_curl::command()
        .args(["--disable", "--noproxy", "*", "--proto", protocol, "--silent", "--connect-timeout", "5",
            "--max-time", "24", "--max-filesize", &MAX_WIRE.to_string(), "--write-out", "\n%{http_code}",
            "--header", "Content-Type: application/json", "--data-binary", "@-", "--url", url.as_str()])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
        .map_err(|_| RelayError::unavailable())?;

    // Las credenciales y datos viajan por stdin y nunca en los argumentos.
    let written = child.stdin.take().ok_or_else(RelayError::unavailable)
        .and_then(|mut input| input.write_all(body.to_string().as_bytes()).map_err(|_| RelayError::unavailable()));
    let mut bytes = Vec::new();
    let read = child.stdout.take().ok_or_else(RelayError::unavailable).and_then(|stdout| {
        stdout.take(MAX_WIRE + 5).read_to_end(&mut bytes).map_err(|_| RelayError::unavailable())
    });
    if written.is_err() || read.is_err() || bytes.len() as u64 > MAX_WIRE + 4 {
        let _ = child.kill();
        let _ = child.wait();
        return Err(RelayError::unavailable());
    }
    let status = child.wait().map_err(|_| RelayError::unavailable())?;
    if !status.success() {
        return Err(RelayError::unavailable());
    }
    let separator = bytes.iter().rposition(|byte| *byte == b'\n').ok_or_else(RelayError::invalid)?;
    let (body, code) = (&bytes[..separator], &bytes[separator + 1..]);
    let code = std::str::from_utf8(code).ok().and_then(|s| s.parse::<u16>().ok()).ok_or_else(RelayError::invalid)?;
    if code != 200 {
        let message = serde_json::from_slice::<Value>(body).ok()
            .and_then(|value| value["error"].as_str().filter(|s| s.len() <= 250).map(str::to_owned))
            .unwrap_or_else(|| format!("el servicio de colaboración devolvió HTTP {code}"));
        return Err(RelayError { code, message });
    }
    serde_json::from_slice(body).map_err(|_| RelayError::invalid())
}

impl Connection {
    fn post<T: DeserializeOwned>(&self, endpoint: &str, extra: Option<Value>) -> Result<T, RelayError> {
        let mut body = extra.unwrap_or_else(|| json!({}));
        body["id"] = json!(self.id);
        body["key"] = json!(self.key);
        post(&self.relay, endpoint, &body)
    }
}

fn serve(connection: Connection, project: project::Project, cancelled: Arc<AtomicBool>, editable: Arc<Mutex<bool>>, on_write: impl Fn()) {
    while !cancelled.load(Ordering::Acquire) {
        match connection.post::<Option<Operation>>("next", None) {
            Ok(Some(op)) if !cancelled.load(Ordering::Acquire) => {
                let data = match op.action {
                    Action::List => project.list(&op.path).map(|entries| json!(entries)),
                    Action::Read => project.read(&op.path).map(|text| {
                        if op.revision.is_some_and(|known| known == project::revision(text.as_bytes())) {
                            Value::Null
                        } else {
                            json!(text)
                        }
                    }),
                    Action::Write => (|| {
                        let permission = editable.lock().map_err(err)?;
                        if !*permission || cancelled.load(Ordering::Acquire) {
                            return Err("el proyecto es de solo lectura".into());
                        }
                        project.write(&op.path, op.content.as_deref().ok_or("edición incompleta")?,
                            op.revision.as_deref().ok_or("falta la versión del archivo")?)?;
                        on_write();
                        Ok(Value::Null)
                    })(),
                };
                let result = match data {
                    Ok(data) => json!({ "data": data }),
                    Err(error) => json!({ "error": error }),
                };
                if !cancelled.load(Ordering::Acquire) {
                    let _ = connection.post::<Value>("reply", Some(json!({ "request": op.id, "result": result })));
                }
            }
            Ok(_) => {}
            Err(e) if matches!(e.code, 403 | 410) => {
                cancelled.store(true, Ordering::Release);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_secs(2)),
        }
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(err)?
}

#[tauri::command]
pub(crate) async fn share_start(
    app: AppHandle, project: String, session: Option<i64>, relay: String, key: String, editable: Option<bool>,
) -> CmdResult<HostInfo> {
    blocking(move || {
        let state = app.state::<AppState>();
        let root = paths::canonical(&isolate::work_dir(&state, &project, session)?).map_err(err)?;
        let scope = project::Project::open(root)?;
        let name = PathBuf::from(project).file_name().ok_or("proyecto sin nombre")?.to_string_lossy().into_owned();
        let relay = relay_url(&relay)?;
        let key = key.trim();
        if !valid_key(key) {
            return Err("clave del servicio no válida".into());
        }
        let mut host = state.sharing.host.lock().map_err(err)?;
        if host.as_ref().is_some_and(|active| active.cancelled.load(Ordering::Acquire)) {
            *host = None;
        }
        if host.is_some() {
            return Err("cierra primero la sesión compartida anterior".into());
        }
        let editable = editable.unwrap_or(false);
        let created: Created = post(&relay, "create", &json!({ "key": key, "name": name, "editable": editable })).map_err(|e| e.message)?;
        if ![&created.id, &created.host, &created.invite].into_iter().all(|key| valid_key(key)) {
            return Err("el servicio devolvió una invitación no válida".into());
        }
        let connection = Connection { relay: relay.clone(), id: created.id.clone(), key: created.host };
        if created.editable != editable {
            let _ = connection.post::<Value>("close", None);
            return Err("actualiza el servicio de colaboración para habilitar la edición".into());
        }
        let info = HostInfo {
            name,
            editable,
            invitation: format!("{relay}#filigranas-v1.{}.{}", created.id, created.invite),
            expires_at: created.expires_at,
        };
        let editable = Arc::new(Mutex::new(editable));
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let connection = connection.clone();
            let cancelled = cancelled.clone();
            let editable = editable.clone();
            let app = app.clone();
            std::thread::spawn(move || serve(connection, scope, cancelled, editable, || {
                let _ = app.emit("project-changed", ());
            }));
        }
        *host = Some(Host { connection, info: info.clone(), cancelled, editable });
        Ok(info)
    }).await
}

#[tauri::command]
pub(crate) async fn share_current(app: AppHandle) -> CmdResult<Option<HostInfo>> {
    blocking(move || {
        let state = app.state::<AppState>();
        let host = state.sharing.host.lock().map_err(err)?;
        Ok(host.as_ref()
            .filter(|active| !active.cancelled.load(Ordering::Acquire))
            .map(|active| active.info.clone()))
    }).await
}

#[tauri::command]
pub(crate) async fn share_access(app: AppHandle, editable: bool) -> CmdResult<HostInfo> {
    blocking(move || {
        let state = app.state::<AppState>();
        let mut host = state.sharing.host.lock().map_err(err)?;
        let host = host.as_mut().filter(|host| !host.cancelled.load(Ordering::Acquire))
            .ok_or("la sesión compartida ha terminado")?;
        host.set_access(editable)
    }).await
}

#[tauri::command]
pub(crate) async fn share_stop(app: AppHandle) -> CmdResult<()> {
    blocking(move || {
        let state = app.state::<AppState>();
        let mut host = state.sharing.host.lock().map_err(err)?;
        if let Some(active) = host.take() {
            active.cancelled.store(true, Ordering::Release);
            *active.editable.lock().map_err(err)? = false;
            match active.connection.post::<Value>("close", None) {
                Ok(_) => {}
                Err(e) if e.code == 410 => {}
                Err(e) => return Err(e.message),
            }
        }
        Ok(())
    }).await
}

#[tauri::command]
pub(crate) async fn share_join(app: AppHandle, code: String) -> CmdResult<GuestInfo> {
    blocking(move || {
        let state = app.state::<AppState>();
        let mut guest = state.sharing.guest.lock().map_err(err)?;
        if guest.is_some() {
            return Err("sal primero del proyecto compartido anterior".into());
        }
        let mut connection = invitation(&code)?;
        let joined: Joined = connection.post("join", None).map_err(|e| e.message)?;
        if !valid_key(&joined.guest) {
            return Err("el servicio devolvió un acceso no válido".into());
        }
        connection.key = joined.guest;
        *guest = Some(connection);
        Ok(GuestInfo { name: joined.name, editable: joined.editable })
    }).await
}

fn guest(state: &AppState) -> CmdResult<Connection> {
    state.sharing.guest.lock().map_err(err)?.clone().ok_or_else(|| "la sesión compartida ha terminado".into())
}

#[tauri::command]
pub(crate) async fn share_status(app: AppHandle) -> CmdResult<Status> {
    blocking(move || {
        let connection = guest(&app.state::<AppState>())?;
        match connection.post("status", None) {
            Ok(status) => Ok(status),
            Err(e) if matches!(e.code, 403 | 410) => Ok(Status { online: false, closed: true, editable: false }),
            Err(e) => Err(e.message),
        }
    }).await
}

async fn remote<T: DeserializeOwned + Send + 'static>(app: AppHandle, action: Action, input: Value) -> CmdResult<T> {
    blocking(move || {
        let state = app.state::<AppState>();
        let connection = guest(&state)?;
        let _operation = state.sharing.operations.lock().map_err(err)?;
        let mut response: Value = connection.post(action.endpoint(), Some(input)).map_err(|e| e.message)?;
        if let Some(error) = response["error"].as_str() {
            return Err(error.into());
        }
        serde_json::from_value(response["data"].take()).map_err(|_| RelayError::invalid().message)
    }).await
}

#[tauri::command]
pub(crate) async fn share_list(app: AppHandle, path: String) -> CmdResult<Vec<project::Entry>> {
    remote(app, Action::List, json!({ "path": path })).await
}

#[tauri::command]
pub(crate) async fn share_read(app: AppHandle, path: String, revision: Option<String>) -> CmdResult<Option<FileVersion>> {
    let text: Option<String> = remote(app, Action::Read, json!({ "path": path, "revision": revision })).await?;
    Ok(text.map(|text| FileVersion { revision: project::revision(text.as_bytes()), text }))
}

#[tauri::command]
pub(crate) async fn share_write(app: AppHandle, path: String, previous: String, content: String) -> CmdResult<()> {
    if previous.len() as u64 > crate::files::MAX_TEXT || content.len() as u64 > crate::files::MAX_TEXT {
        return Err("archivo demasiado grande".into());
    }
    remote(app, Action::Write, json!({
        "path": path, "revision": project::revision(previous.as_bytes()), "content": content
    })).await
}

#[tauri::command]
pub(crate) async fn share_leave(app: AppHandle) -> CmdResult<()> {
    blocking(move || {
        let state = app.state::<AppState>();
        let connection = state.sharing.guest.lock().map_err(err)?.take();
        if let Some(connection) = connection {
            std::thread::spawn(move || {
                let _ = connection.post::<Value>("leave", None);
            });
        }
        Ok(())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::path::Path;
    use std::process::{Child, Command};

    const HOST_KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct Fixture {
        relay: Child,
        root: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.relay.kill();
            let _ = self.relay.wait();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn accepts_only_https_origins_and_local_test_relays() {
        assert!(relay_url("https://relay.example.org:8443").is_ok());
        assert!(relay_url("http://127.0.0.1:8787").is_ok());
        for invalid in [
            "http://relay.example.org",
            "https://user@relay.example.org",
            "https://relay.example.org/subdir",
            "https://relay.example.org?token=foo",
            "file:///etc/passwd",
        ] {
            assert!(relay_url(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    #[ignore = "requires loopback TCP, Git, Node.js and system curl"]
    fn share_edit_and_revoke_over_relay() {
        let script = format!(r#"
            import {{ createRelay }} from './relay/server.mjs';
            const relay = createRelay({{ hostKey: '{HOST_KEY}' }});
            relay.listen(0, '127.0.0.1', () => console.log(relay.address().port));
        "#);
        let root = std::env::temp_dir().join(format!("filigranas-share-{}", uuid::Uuid::new_v4()));
        let relay = Command::new("node")
            .args(["--input-type=module", "-e", &script])
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join(".."))
            .stdout(Stdio::piped())
            .spawn().unwrap();
        let mut fixture = Fixture { relay, root };
        let mut port = String::new();
        BufReader::new(fixture.relay.stdout.take().unwrap()).read_line(&mut port).unwrap();
        let relay = relay_url(&format!("http://127.0.0.1:{}", port.trim())).unwrap();
        let repo = fixture.root.join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let repo = paths::canonical(&repo).unwrap();
        std::fs::write(repo.join("src/visible.txt"), "index").unwrap();
        std::fs::write(repo.join("src/redirect.txt"), "normal").unwrap();
        std::fs::write(repo.join(".env"), "local only").unwrap();
        std::fs::write(fixture.root.join("outside.txt"), "outside").unwrap();
        crate::git::git(&repo, &["init"]).unwrap();
        crate::git::git(&repo, &["add", "--", "src"]).unwrap();
        std::fs::write(repo.join("src/visible.txt"), "edición local sin publicar").unwrap();
        #[cfg(unix)]
        {
            std::fs::remove_file(repo.join("src/redirect.txt")).unwrap();
            std::os::unix::fs::symlink(fixture.root.join("outside.txt"), repo.join("src/redirect.txt")).unwrap();
        }

        let created = post::<Created>(&relay, "create", &json!({ "key": HOST_KEY, "name": "demo" }))
            .unwrap_or_else(|error| panic!("{}", error.message));
        let host = Connection { relay: relay.clone(), id: created.id.clone(), key: created.host };
        let invite = invitation(&format!("{relay}#filigranas-v1.{}.{}", created.id, created.invite)).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        assert!(!created.editable);
        let editable = Arc::new(Mutex::new(false));
        let host_worker = {
            let host = host.clone();
            let cancelled = cancelled.clone();
            let editable = editable.clone();
            let scope = project::Project::open(repo.clone()).unwrap();
            std::thread::spawn(move || serve(host, scope, cancelled, editable, || {}))
        };
        let mut owner = Host {
            connection: host.clone(),
            info: HostInfo { name: "demo".into(), invitation: String::new(), expires_at: created.expires_at, editable: false },
            cancelled: cancelled.clone(),
            editable,
        };
        let joined = invite.post::<Joined>("join", None).unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(joined.name, "demo");
        assert_eq!(invite.post::<Joined>("join", None).err().unwrap().code, 403);

        let guest = Connection { key: joined.guest, ..invite };
        let request = |action, path| guest.post::<Value>(action, Some(json!({ "path": path })))
            .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(request("list", "")["data"], json!([{ "name": "src", "path": "src", "dir": true }]));
        assert_eq!(request("read", "src/visible.txt")["data"], "edición local sin publicar");
        let read_since = |previous: &str| guest.post::<Value>("read", Some(json!({
            "path": "src/visible.txt", "revision": project::revision(previous.as_bytes())
        }))).unwrap_or_else(|e| panic!("{}", e.message));
        assert_eq!(read_since("edición local sin publicar"), json!({ "data": null }));
        assert_eq!(guest.post::<Value>("read", Some(json!({
            "path": "src/visible.txt", "revision": "incorrecta"
        }))).err().unwrap().code, 400);
        for path in [".env", ".git/config", "../outside.txt"] {
            assert!(request("read", path)["error"].is_string(), "{path}");
        }
        #[cfg(unix)]
        assert!(request("read", "src/redirect.txt")["error"].is_string());
        assert_eq!(guest.post::<Value>("close", None).err().unwrap().code, 403);
        assert_eq!(guest.post::<Value>("write", Some(json!({"path": "src/visible.txt"}))).err().unwrap().code, 403);
        assert_eq!(guest.post::<Value>("access", Some(json!({ "editable": true }))).err().unwrap().code, 403);

        let file = repo.join("src/visible.txt");
        let change = |path, previous: &str, content| json!({
            "path": path, "revision": project::revision(previous.as_bytes()), "content": content
        });
        let first = change("src/visible.txt", "edición local sin publicar", "edición compartida");
        assert!(owner.set_access(true).unwrap().editable);
        assert!(guest.post::<Status>("status", None).unwrap_or_else(|e| panic!("{}", e.message)).editable);
        for input in [first.clone(), first.clone()] {
            let response = guest.post::<Value>("write", Some(input)).unwrap_or_else(|e| panic!("{}", e.message));
            assert_eq!(response, json!({ "data": null }));
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "edición compartida");
        assert_eq!(read_since("edición local sin publicar"), json!({ "data": "edición compartida" }));

        std::fs::write(&file, "edición anfitrión").unwrap();
        assert_eq!(read_since("edición compartida"), json!({ "data": "edición anfitrión" }));
        let conflict = guest.post::<Value>("write", Some(change("src/visible.txt", "edición compartida", "edición obsoleta")))
            .unwrap_or_else(|e| panic!("{}", e.message));
        assert!(conflict["error"].as_str().unwrap().contains("cambió"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "edición anfitrión");
        for path in [".env", ".git/config", "../outside.txt", "src/nuevo.txt"] {
            let response = guest.post::<Value>("write", Some(change(path, "", "rechazada"))).unwrap_or_else(|e| panic!("{}", e.message));
            assert!(response["error"].is_string(), "{path}");
        }
        #[cfg(unix)]
        {
            let response = guest.post::<Value>("write", Some(change("src/redirect.txt", "outside", "rechazada")))
                .unwrap_or_else(|e| panic!("{}", e.message));
            assert!(response["error"].is_string());
            assert_eq!(std::fs::read_to_string(fixture.root.join("outside.txt")).unwrap(), "outside");
        }

        assert!(!owner.set_access(false).unwrap().editable);
        assert!(!guest.post::<Status>("status", None).unwrap_or_else(|e| panic!("{}", e.message)).editable);
        assert_eq!(guest.post::<Value>("write", Some(first.clone())).err().unwrap().code, 403);
        // Un permiso anunciado únicamente por el servicio no habilita al anfitrión.
        assert!(host.post::<Value>("access", Some(json!({ "editable": true }))).is_ok());
        let denied = guest.post::<Value>("write", Some(first)).unwrap_or_else(|e| panic!("{}", e.message));
        assert!(denied["error"].as_str().unwrap().contains("solo lectura"));
        assert!(host.post::<Value>("close", None).is_ok());
        assert_eq!(guest.post::<Value>("status", None).err().unwrap().code, 410);
        assert_eq!(guest.post::<Value>("read", Some(json!({ "path": "src/visible.txt" }))).err().unwrap().code, 410);
        cancelled.store(true, Ordering::Release);
        host_worker.join().unwrap();
    }
}
