mod db;
mod files;
mod paths;
mod watch;
mod window;
mod workspace;

use std::sync::Mutex;

use tauri::Manager;

/// Estado compartido del núcleo. La interfaz nunca toca disco ni procesos:
/// todo pasa por los comandos de este crate.
pub(crate) struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

/// Los comandos devuelven errores como texto legible para la interfaz.
pub(crate) type CmdResult<T> = Result<T, String>;

pub(crate) fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::open(&data_dir.join("filigranas.db"))?;
            let root = db::get_setting(&conn, "root")?;
            app.manage(AppState {
                db: Mutex::new(conn),
                watcher: Mutex::new(None),
            });
            if let Some(root) = root {
                if let Err(e) = watch::start(app.handle(), std::path::Path::new(&root)) {
                    eprintln!("no se pudo observar {root}: {e}");
                }
            }
            if let Some(main) = app.get_webview_window("main") {
                window::apply_effects(&main);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::get_workspace,
            workspace::default_root,
            workspace::set_root,
            workspace::create_group,
            workspace::rename_group,
            workspace::delete_group,
            workspace::move_project,
            workspace::set_archived,
            files::list_dir,
            files::read_text,
            files::write_text,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Filigranas");
}
