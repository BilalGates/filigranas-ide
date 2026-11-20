mod acp;
mod approval;
mod attachments;
mod brain;
mod brain_graph;
mod browser;
mod chat;
mod claude;
mod codex;
mod containers;
mod db;
mod delegate;
mod design;
mod files;
mod git;
mod github;
mod github_login;
mod handoff;
mod health;
mod isolate;
mod jev;
mod larry;
mod p5_process;
mod paths;
mod pr;
mod pty;
mod runs;
mod services;
mod sharing;
mod system_curl;
mod skills;
mod tasks;
mod tools;
mod tracker;
mod watch;
mod git_ops;
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
    pub services: services::ServiceProcesses,
    pub sharing: sharing::Sharing,
    pub github_login: github_login::GithubLogin,
    pub codex: codex::Codex,
    pub claude: claude::Claude,
    pub acp: acp::Acp,
    pub tracker: tracker::Tracker,
    pub publication: Mutex<()>,
    pub approvals: approval::Approvals,
    pub jev_gate: Mutex<()>,
    pub chat_gate: Mutex<()>,
}

/// Los comandos devuelven errores como texto legible para la interfaz.
pub(crate) type CmdResult<T> = Result<T, String>;

pub(crate) fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn main_webview_only(
    handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool,
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool {
    move |request| {
        if request.message.webview().label() != "main" {
            request.resolver.reject("vista sin acceso a los comandos del IDE");
            return true;
        }
        handler(request)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::open(&data_dir.join("filigranas.db"))?;
            runs::recovery(&conn)?;
            let root = db::get_setting(&conn, "root")?;
            app.manage(AppState {
                db: Mutex::new(conn),
                watcher: Mutex::new(None),
                project_watcher: Mutex::new(None),
                ptys: Default::default(),
                services: Default::default(),
                sharing: Default::default(),
                github_login: Default::default(),
                codex: Default::default(),
                claude: Default::default(),
                acp: Default::default(),
                tracker: Default::default(),
                publication: Default::default(),
                approvals: Default::default(),
                jev_gate: Default::default(),
                chat_gate: Default::default(),
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
        .invoke_handler(main_webview_only(tauri::generate_handler![
            brain::brain_search,
            brain::brain_entry,
            brain_graph::brain_graph,
            brain::brain_preview,
            brain::brain_save,
            brain::brain_forget,
            health::health_list,
            health::health_file,
            health::health_import,
            health::health_run,
            health::health_resolve,
            health::health_ci,
            design::design_list,
            design::design_save,
            design::design_shots,
            design::design_image,
            design::design_import,
            design::design_preview,
            design::design_capture,
            design::design_review,
            design::design_send,
            git_ops::git_fetch,
            git_ops::git_pull,
            git_ops::git_push,
            git_ops::git_review_push,
            approval::cancel_review,
            git_ops::git_stash,
            git_ops::git_stash_pop,
            git_ops::git_stash_list,
            git_ops::git_undo_commit,
            git_ops::git_commit_detail,
            workspace::get_workspace,
            workspace::default_root,
            workspace::set_root,
            workspace::create_group,
            workspace::rename_group,
            workspace::delete_group,
            workspace::move_project,
            workspace::set_archived,
            workspace::create_project,
            workspace::reveal_project,
            browser::browser_open,
            browser::browser_place,
            browser::browser_action,
            browser::browser_location,
            sharing::share_start,
            sharing::share_current,
            sharing::share_stop,
            sharing::share_access,
            sharing::share_join,
            sharing::share_status,
            sharing::share_list,
            sharing::share_read,
            sharing::share_write,
            sharing::share_leave,
            files::list_dir,
            files::read_text,
            files::write_text,
            git::git_status,
            git::git_head,
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
            codex::codex_rate_limits,
            codex::codex_pin_model,
            tasks::tasks_list,
            tasks::task_save,
            tasks::task_link,
            tasks::task_runs,
            tasks::task_parallel_limit,
            chat::chat_pm,
            chat::chat_history,
            chat::chat_switch,
            claude::session_list,
            claude::session_create,
            claude::session_history,
            claude::session_send,
            claude::session_interrupt,
            claude::session_respond,
            claude::session_close,
            claude::session_set_option,
            claude::claude_chat_options,
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
            pr::pr_review_publish,
            pr::pr_merge,
            pr::pr_review_merge,
            pr::open_pr_url,
            pr::pr_status,
            tools::tools_status,
            github_login::github_login_start,
            github_login::github_login_status,
            github_login::github_login_cancel,
            github_login::github_login_open,
            jev::jev_status,
            jev::jev_usage,
            jev::jev_euro_rate,
            jev::jev_configure,
            services::services_list,
            services::service_save,
            services::service_action,
            containers::containers_list,
            containers::container_link,
            containers::container_unlink,
            window::window_backdrop,
        ]))
        .build(tauri::generate_context!())
        .expect("error al iniciar Filigranas")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<AppState>().services.shutdown();
            }
        });
}
