use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, State, Url, Webview, WebviewUrl,
};

use crate::{err, AppState, CmdResult};

const LABEL: &str = "integrated-browser";

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS browser_history (
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
            webview.set_bounds(bounds.rect()).map_err(err)?;
            webview.show().map_err(err)
        }
        None => webview.hide().map_err(err),
    }
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, url: String, bounds: Bounds) -> CmdResult<()> {
    let url = Url::parse(&url).map_err(err)?;
    if !permitted(&url) {
        return Err("Introduce una dirección HTTP o HTTPS válida.".into());
    }
    if let Some(webview) = app.get_webview(LABEL) {
        webview.navigate(url.clone()).map_err(err)?;
        position(&webview, Some(bounds))?;
    } else {
        let window = app.get_window("main").ok_or("no se encuentra la ventana principal")?;
        let handle = app.clone();
        let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url.clone()))
            .incognito(true)
            .devtools(false)
            .focused(false)
            .on_navigation(permitted)
            .on_new_window(move |url, _| {
                if permitted(&url) {
                    if let Some(webview) = handle.get_webview(LABEL) {
                        let _ = webview.navigate(url);
                    }
                }
                NewWindowResponse::Deny
            });
        let rect = bounds.rect();
        window.add_child(builder, rect.position, rect.size).map_err(err)?;
    }
    let state = app.state::<AppState>();
    let conn = state.db.lock().map_err(err)?;
    record_visit(&conn, &url)
}

#[tauri::command]
pub fn browser_place(app: AppHandle, bounds: Option<Bounds>) -> CmdResult<()> {
    if let Some(webview) = app.get_webview(LABEL) {
        position(&webview, bounds)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Back,
    Forward,
    Reload,
}

#[tauri::command]
pub fn browser_action(app: AppHandle, action: Action) -> CmdResult<()> {
    let webview = app.get_webview(LABEL).ok_or("abre una página primero")?;
    match action {
        Action::Back => webview.eval("history.back()"),
        Action::Forward => webview.eval("history.forward()"),
        Action::Reload => webview.reload(),
    }.map_err(err)
}

#[tauri::command]
pub fn browser_location(app: AppHandle) -> CmdResult<Option<String>> {
    let url = app.get_webview(LABEL).and_then(|view| view.url().ok());
    if let Some(url) = &url {
        if permitted(url) {
            let state = app.state::<AppState>();
            let conn = state.db.lock().map_err(err)?;
            record_visit(&conn, url)?;
        }
    }
    Ok(url.map(|url| url.to_string()))
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
