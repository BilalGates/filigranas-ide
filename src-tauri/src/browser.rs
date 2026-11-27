use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
use sha2::{Digest, Sha256};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, State, Url, Webview, WebviewUrl,
};

use crate::{err, AppState, CmdResult};

const PREFIX: &str = "integrated-browser-";

#[derive(Default)]
pub struct Browsers(Mutex<HashMap<String, Navigation>>);

#[derive(Default)]
struct Navigation {
    url: String,
    title: String,
    loading: bool,
    loaded: bool,
    started: Option<Instant>,
    error: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    exists: bool,
    url: String,
    title: String,
    loading: bool,
    loaded: bool,
    error: Option<String>,
    can_go_back: Option<bool>,
    can_go_forward: Option<bool>,
    width: Option<f64>,
    height: Option<f64>,
}

fn label(project: Option<&str>) -> String {
    let digest = Sha256::digest(project.unwrap_or("").as_bytes());
    format!("{PREFIX}{:x}", digest)
}

fn begin(app: &AppHandle, key: &str, url: &Url) {
    if let Ok(mut views) = app.state::<Browsers>().0.lock() {
        let state = views.entry(key.to_owned()).or_default();
        state.url = url.to_string();
        state.loading = true;
        state.loaded = false;
        state.error = None;
        state.started = Some(Instant::now());
    }
}


pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS browser_sessions (
             scope TEXT PRIMARY KEY, url TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS browser_history (
             url TEXT PRIMARY KEY,
             title TEXT NOT NULL,
             visited_at INTEGER NOT NULL DEFAULT (unixepoch()),
             visits INTEGER NOT NULL DEFAULT 1
         );
         CREATE TABLE IF NOT EXISTS browser_bookmarks (
             url TEXT PRIMARY KEY,
             title TEXT NOT NULL,
             created_at INTEGER NOT NULL DEFAULT (unixepoch())
         );",
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEntry {
    pub url: String,
    pub title: String,
    pub timestamp: i64,
}

fn history_address(url: &Url) -> String {
    let mut url = url.clone();
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn record_visit(conn: &Connection, url: &Url) -> CmdResult<()> {
    let safe_url = history_address(url);
    let title = url.host_str().unwrap_or_default();
    conn.execute(
        "INSERT INTO browser_history(url, title) VALUES (?1, ?2)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title,
           visits = CASE WHEN browser_history.visited_at < unixepoch() - 15
                         THEN browser_history.visits + 1 ELSE browser_history.visits END,
           visited_at = CASE WHEN browser_history.visited_at < unixepoch() - 15
                             THEN unixepoch() ELSE browser_history.visited_at END",
        params![safe_url, title],
    ).map_err(err)?;
    conn.execute(
        "DELETE FROM browser_history WHERE url IN (
             SELECT url FROM browser_history ORDER BY visited_at DESC LIMIT -1 OFFSET 1000
         )",
        [],
    ).map_err(err)?;
    Ok(())
}

fn entries(conn: &Connection, table: &str) -> CmdResult<Vec<BrowserEntry>> {
    let query = match table {
        "browser_history" => "SELECT url, title, visited_at FROM browser_history ORDER BY visited_at DESC LIMIT 200",
        "browser_bookmarks" => "SELECT url, title, created_at FROM browser_bookmarks ORDER BY title COLLATE NOCASE",
        _ => return Err("tipo de listado del navegador no válido".into()),
    };
    let mut statement = conn.prepare(query).map_err(err)?;
    let rows = statement.query_map([], |row| {
        Ok(BrowserEntry {
            url: row.get(0)?,
            title: row.get(1)?,
            timestamp: row.get(2)?,
        })
    }).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

#[derive(Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn validate(&self) -> CmdResult<()> {
        if [self.x, self.y, self.width, self.height].iter().any(|n| !n.is_finite())
            || self.x < 0.0 || self.y < 0.0 || self.width < 64.0 || self.height < 64.0 {
            return Err("Browser no dispone de un área visible válida. Amplía el panel o vuelve a abrirlo.".into());
        }
        Ok(())
    }

    fn rect(&self) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width, self.height).into(),
        }
    }
}

fn permitted(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host().is_some()
        && url.host_str() != Some("tauri.localhost")
        && url.host_str() != Some("ipc.localhost")
        && url.username().is_empty()
        && url.password().is_none()
}

fn position(webview: &Webview, bounds: Option<Bounds>) -> CmdResult<()> {
    match bounds {
        Some(bounds) => {
            bounds.validate()?;
            webview.set_bounds(bounds.rect()).map_err(err)?;
            webview.show().map_err(err)
        }
        None => webview.hide().map_err(err),
    }
}

// Hide sibling browser views rather than destroying their document/history.
fn hide_others(app: &AppHandle, active: &str) -> CmdResult<()> {
    for (key, view) in app.webviews() {
        if key.starts_with(PREFIX) && key != active { view.hide().map_err(err)?; }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, url: String, bounds: Bounds, project: Option<String>) -> CmdResult<()> {
    let url = Url::parse(&url).map_err(err)?;
    if !permitted(&url) { return Err("Introduce una dirección HTTP o HTTPS válida.".into()); }
    bounds.validate()?;
    let key = label(project.as_deref());
    hide_others(&app, &key)?;
    begin(&app, &key, &url);
    if let Some(webview) = app.get_webview(&key) {
        webview.navigate(url).map_err(err)?;
        position(&webview, Some(bounds))?;
    } else {
        let window = app.get_window("main").ok_or("no se encuentra la ventana principal")?;
        let handle = app.clone();
        let nav_app = app.clone();
        let nav_key = key.clone();
        let builder = WebviewBuilder::new(&key, WebviewUrl::External(url))
            .incognito(true)
            .devtools(false)
            .focused(false)
            .on_navigation(move |url| {
                if permitted(url) { return true; }
                if let Ok(mut views) = nav_app.state::<Browsers>().0.lock() {
                    if let Some(state) = views.get_mut(&nav_key) {
                        state.error = Some(format!("Navegación bloqueada: el esquema {} no está permitido en Browser.", url.scheme()));
                        state.loading = false;
                    }
                }
                false
            })
            .on_page_load(|view, payload| {
                let app = view.app_handle();
                let key = view.label();
                match payload.event() {
                    PageLoadEvent::Started => begin(app, key, payload.url()),
                    PageLoadEvent::Finished => {
                        if let Ok(mut views) = app.state::<Browsers>().0.lock() {
                            let state = views.entry(key.to_owned()).or_default();
                            state.url = payload.url().to_string();
                            state.loading = false;
                            state.loaded = true;
                            state.error = None;
                        }
                        if permitted(payload.url()) {
                            let state = app.state::<AppState>();
                            if let Ok(conn) = state.db.lock() {
                                if let Err(e) = record_visit(&conn, payload.url()).and_then(|_| save_session(&conn, key, payload.url())) {
                                    eprintln!("persistencia de Browser: {e}");
                                }
                            };
                        }
                    }
                }
            })
            .on_document_title_changed(|view, title| {
                if let Ok(mut views) = view.app_handle().state::<Browsers>().0.lock() {
                    views.entry(view.label().to_owned()).or_default().title = title;
                }
            })
            .on_new_window(move |url, _| {
                if permitted(&url) {
                    if let Some(webview) = handle.get_webview(&key) {
                        begin(&handle, &key, &url);
                        if let Err(e) = webview.navigate(url) { eprintln!("Browser: {e}"); }
                    }
                }
                NewWindowResponse::Deny
            });
        let rect = bounds.rect();
        window.add_child(builder, rect.position, rect.size).map_err(err)?;
    }
    Ok(())
}

fn save_session(conn: &Connection, scope: &str, url: &Url) -> CmdResult<()> {
    conn.execute("INSERT INTO browser_sessions(scope, url) VALUES (?1, ?2)
        ON CONFLICT(scope) DO UPDATE SET url = excluded.url", params![scope, url.as_str()]).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn browser_place(app: AppHandle, bounds: Option<Bounds>, project: Option<String>) -> CmdResult<()> {
    let key = label(project.as_deref());
    if bounds.is_some() { hide_others(&app, &key)?; }
    if let Some(webview) = app.get_webview(&key) { position(&webview, bounds)?; }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action { Back, Forward, Reload }

#[tauri::command]
pub async fn browser_action(app: AppHandle, action: Action, project: Option<String>) -> CmdResult<()> {
    let key = label(project.as_deref());
    let webview = app.get_webview(&key).ok_or("abre una página primero")?;
    if let Ok(url) = webview.url() { begin(&app, &key, &url); }
    match action {
        Action::Back => webview.eval("history.back()"),
        Action::Forward => webview.eval("history.forward()"),
        Action::Reload => webview.reload(),
    }.map_err(err)
}

// WKWebView has no failure callback in Tauri's public page-load API. Observe
// its real loading state too: a stopped load without didFinish is NOT success.
#[cfg(target_os = "macos")]
fn native_state(view: &Webview) -> CmdResult<(bool, bool, bool, f64, f64)> {
    let (tx, rx) = std::sync::mpsc::channel();
    view.with_webview(move |platform| {
        use objc2::{msg_send, runtime::{AnyObject, Bool}};
        // SAFETY: with_webview runs on the main thread and owns a live WKWebView.
        // Read only documented WKWebView properties; no delegate replacement.
        let state = unsafe {
            let object: &AnyObject = &*platform.inner().cast();
            let loading: Bool = msg_send![object, isLoading];
            let back: Bool = msg_send![object, canGoBack];
            let forward: Bool = msg_send![object, canGoForward];
            let view: &objc2_app_kit::NSView = &*platform.inner().cast();
            let size = view.bounds().size;
            (loading.as_bool(), back.as_bool(), forward.as_bool(), size.width, size.height)
        };
        let _ = tx.send(state);
    }).map_err(err)?;
    rx.recv_timeout(Duration::from_secs(2)).map_err(err)
}

#[tauri::command]
pub async fn browser_status(app: AppHandle, project: Option<String>) -> CmdResult<BrowserStatus> {
    let key = label(project.as_deref());
    let Some(view) = app.get_webview(&key) else {
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(err)?;
        let url = conn.query_row("SELECT url FROM browser_sessions WHERE scope = ?1", [&key], |r| r.get(0))
            .optional().map_err(err)?.unwrap_or_default();
        return Ok(BrowserStatus { url, ..Default::default() });
    };
    #[cfg(target_os = "macos")]
    let (loading, back, forward, width, height) = native_state(&view)?;
    let state = app.state::<Browsers>();
    let mut views = state.0.lock().map_err(err)?;
    let state = views.entry(key.clone()).or_default();
    #[cfg(target_os = "macos")]
    if loading && !state.loading { state.loading = true; state.loaded = false; state.started = Some(Instant::now()); state.error = None; }
    let elapsed = state.started.map(|t| t.elapsed()).unwrap_or_default();
    #[cfg(target_os = "macos")]
    if state.loading && !loading && !state.loaded && elapsed > Duration::from_millis(1200) {
        state.loading = false;
        state.error = Some("WKWebView detuvo la navegación sin confirmar la carga. Comprueba la conexión y la dirección; también puede tratarse de un fallo TLS o una página incompatible. El motor no proporciona el diagnóstico concreto a través de Tauri.".into());
    }
    if state.loading && elapsed > Duration::from_secs(30) {
        state.error = Some("La página no ha confirmado la carga tras 30 segundos. Puedes esperar, reintentar o abrirla en el navegador del sistema.".into());
    }
    // Only adopt the committed URL after a successful load, preserving the failed target.
    if state.loaded && !state.loading {
        if let Ok(url) = view.url() {
            if permitted(&url) && state.url != url.as_str() {
                let database = app.state::<AppState>();
                let conn = database.db.lock().map_err(err)?;
                record_visit(&conn, &url)?;
                save_session(&conn, &key, &url)?;
                state.url = url.to_string();
            }
        }
    }
    #[cfg(target_os = "macos")]
    let capabilities = (Some(back), Some(forward), Some(width), Some(height));
    #[cfg(not(target_os = "macos"))]
    let capabilities = (None, None, None, None);
    Ok(BrowserStatus {
        exists: true, url: state.url.clone(), title: state.title.clone(), loading: state.loading,
        loaded: state.loaded, error: state.error.clone(),
        can_go_back: capabilities.0, can_go_forward: capabilities.1,
        width: capabilities.2, height: capabilities.3,
    })
}

#[tauri::command]
pub fn browser_external(url: String) -> CmdResult<()> {
    let url = Url::parse(&url).map_err(err)?;
    if !permitted(&url) { return Err("Solo se pueden abrir direcciones HTTP o HTTPS.".into()); }
    crate::pr::open_browser(url.as_str())
}

#[tauri::command]
pub fn browser_history(state: State<'_, AppState>) -> CmdResult<Vec<BrowserEntry>> {
    let conn = state.db.lock().map_err(err)?;
    entries(&conn, "browser_history")
}

#[tauri::command]
pub fn browser_bookmarks(state: State<'_, AppState>) -> CmdResult<Vec<BrowserEntry>> {
    let conn = state.db.lock().map_err(err)?;
    entries(&conn, "browser_bookmarks")
}

fn validate_bookmark(url: &str, title: &str) -> CmdResult<Url> {
    let url = Url::parse(url).map_err(err)?;
    if !permitted(&url) || title.trim().is_empty() || title.len() > 200 {
        return Err("el marcador no es válido".into());
    }
    Ok(url)
}

#[tauri::command]
pub fn browser_bookmark(state: State<'_, AppState>, url: String, title: String) -> CmdResult<()> {
    let url = validate_bookmark(&url, &title)?;
    state.db.lock().map_err(err)?.execute(
        "INSERT INTO browser_bookmarks(url, title) VALUES (?1, ?2)
         ON CONFLICT(url) DO UPDATE SET title = excluded.title",
        params![url.as_str(), title.trim()],
    ).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn browser_bookmark_remove(state: State<'_, AppState>, url: String) -> CmdResult<()> {
    let url = Url::parse(&url).map_err(err)?;
    if !permitted(&url) {
        return Err("el marcador no es válido".into());
    }
    state.db.lock().map_err(err)?.execute("DELETE FROM browser_bookmarks WHERE url = ?1", [url.as_str()]).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn browser_history_clear(state: State<'_, AppState>) -> CmdResult<()> {
    state.db.lock().map_err(err)?.execute("DELETE FROM browser_history", []).map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn refuses_collapsed_and_invalid_native_surfaces() {
        for (width, height) in [(800.0, 0.0), (0.0, 600.0), (800.0, 32.0), (f64::NAN, 600.0)] {
            assert!(Bounds { x: 0.0, y: 48.0, width, height }.validate().is_err());
        }
        assert!(Bounds { x: 544.0, y: 134.0, width: 887.0, height: 733.0 }.validate().is_ok());
    }

    #[test]
    fn project_views_and_persisted_sessions_are_independent() {
        let conn = db();
        let a = label(Some("/projects/a"));
        let b = label(Some("/projects/b"));
        assert_ne!(a, b);
        assert_ne!(a, label(None));
        assert_eq!(a, label(Some("/projects/a")));
        save_session(&conn, &a, &Url::parse("http://localhost:3000/one").unwrap()).unwrap();
        save_session(&conn, &b, &Url::parse("https://example.com/").unwrap()).unwrap();
        save_session(&conn, &a, &Url::parse("http://localhost:3000/two").unwrap()).unwrap();
        assert_eq!(conn.query_row("SELECT url FROM browser_sessions WHERE scope = ?1", [a], |r| r.get::<_, String>(0)).unwrap(), "http://localhost:3000/two");
        assert_eq!(conn.query_row("SELECT count(*) FROM browser_sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        conn.execute("DELETE FROM browser_history", []).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM browser_sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    }

    #[test]
    fn remote_content_cannot_navigate_to_ipc_or_local_files() {
        for url in ["tauri://localhost", "http://ipc.localhost/", "http://tauri.localhost/", "file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com"] {
            assert!(!permitted(&Url::parse(url).unwrap()), "{url}");
        }
        for url in ["https://www.google.com/", "http://localhost:3000", "http://[::1]:3000"] {
            assert!(permitted(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn browser_history_strips_query_and_fragment() {
        let conn = db();
        let url = Url::parse("https://example.com/path?token=private#section").unwrap();
        record_visit(&conn, &url).unwrap();
        let rows = entries(&conn, "browser_history").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].url, "https://example.com/path");
        assert!(!rows[0].url.contains("private"));
    }

    #[test]
    fn bookmarks_reject_non_web_urls() {
        assert!(validate_bookmark("file:///private/secret", "private").is_err());
    }
}
