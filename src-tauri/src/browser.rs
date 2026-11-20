use serde::Deserialize;
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl,
};

use crate::{err, CmdResult};

const LABEL: &str = "integrated-browser";

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
        webview.navigate(url).map_err(err)?;
        return position(&webview, Some(bounds));
    }

    let window = app.get_window("main").ok_or("no se encuentra la ventana principal")?;
    let handle = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
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
    Ok(())
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
pub fn browser_location(app: AppHandle) -> Option<String> {
    app.get_webview(LABEL)
        .and_then(|view| view.url().ok())
        .map(|url| url.to_string())
}
