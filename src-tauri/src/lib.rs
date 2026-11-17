mod acp;
mod claude;
mod codex;
mod containers;
mod db;
mod delegate;
mod files;
mod git;
mod handoff;
mod isolate;
mod larry;
mod paths;
mod pr;
mod pty;
mod tools;
mod tracker;
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
    /// Observa el proyecto abierto (recursivo) para refrescar Git y archivos.
    pub project_watcher: Mutex<Option<notify::RecommendedWatcher>>,
    pub ptys: pty::Ptys,
    pub codex: codex::Codex,
    pub claude: claude::Claude,
    pub acp: acp::Acp,
    pub tracker: tracker::Tracker,
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
                project_watcher: Mutex::new(None),
                ptys: Default::default(),
                codex: Default::default(),
                claude: Default::default(),
                acp: Default::default(),
                tracker: Default::default(),
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
            git::git_status,
            git::git_diff_texts,
            git::git_log,
            git::git_branches,
            git::git_switch,
            watch::watch_project,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            codex::coordinator_open,
            codex::coordinator_send,
            codex::coordinator_interrupt,
            codex::coordinator_respond,
            codex::coordinator_set_profile,
            claude::session_list,
            claude::session_create,
            claude::session_history,
            claude::session_send,
            claude::session_interrupt,
            claude::session_respond,
            claude::session_close,
            claude::session_set_option,
            isolate::session_changes,
            isolate::session_diff_texts,
            isolate::session_integrate,
            isolate::session_integrate_merging,
            isolate::session_cleanup,
            isolate::session_orphans,
            isolate::session_reopen,
            handoff::session_pause,
            handoff::session_resume,
            handoff::session_handoff,
            larry::larry_propose,
            larry::larry_commit,
            larry::larry_groups,
            pr::pr_draft,
            pr::pr_publish,
            pr::open_pr_url,
            pr::pr_status,
            tools::tools_status,
            containers::containers_list,
            containers::container_link,
            containers::container_unlink,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Filigranas");
}
