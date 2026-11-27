mod acp;
mod approval;
mod attachments;
mod autoapprove;
mod brain;
mod brain_graph;
mod brain_links;
mod browser;
mod chat;
mod claude;
mod cli;
mod codex;
mod containers;
mod db;
mod delegate;
mod design;
mod design_components;
mod files;
mod git;
mod github;
mod github_login;
mod handoff;
mod health;
mod home;
mod isolate;
mod jev;
mod larry;
mod p5_process;
mod paths;
mod pr;
mod pty;
mod rpc;
mod runs;
mod services;
mod system_curl;
mod skills;
mod sysmon;
mod tasks;
mod tools;
mod tracker;
mod watch;
mod git_ops;
mod window;
mod workspace;
mod work;

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
    pub github_login: github_login::GithubLogin,
    pub codex: codex::Codex,
    pub claude: claude::Claude,
    pub acp: acp::Acp,
    pub tracker: tracker::Tracker,
    pub publication: Mutex<()>,
    pub approvals: approval::Approvals,
    /// Nivel de permisos elegido para cada sesión (pedir, automático o total).
    pub permissions: autoapprove::Modes,
    pub sysmon: sysmon::Monitor,
    pub jev_gate: Mutex<()>,
    pub chat_gate: Mutex<()>,
    // Se libera después de destruir los recursos del perfil.
    _profile_lock: std::fs::File,
}

/// Los comandos devuelven errores como texto legible para la interfaz.
pub(crate) type CmdResult<T> = Result<T, String>;

pub(crate) fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Run local I/O and SQLite reads without occupying the webview event loop.
pub(crate) async fn background_read<T: Send + 'static>(
    app: tauri::AppHandle,
    read: impl FnOnce(&AppState) -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || read(&app.state::<AppState>())).await.map_err(err)?
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

fn lock_profile(dir: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::fs::{OpenOptions, TryLockError};
    use std::io::{Error, ErrorKind};

    let lock = OpenOptions::new().create(true).truncate(false).write(true)
        .open(dir.join("filigranas.lock"))?;
    match lock.try_lock() {
        Ok(()) => Ok(lock),
        Err(TryLockError::WouldBlock) => Err(Error::new(ErrorKind::WouldBlock, "Filigranas ya está abierto con este perfil")),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(browser::Browsers::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let profile_lock = match lock_profile(&data_dir) {
                Ok(lock) => lock,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    eprintln!("{error}");
                    app.handle().exit(0);
                    return Ok(());
                }
                Err(error) => return Err(error.into()),
            };
            let conn = db::open(&data_dir.join("filigranas.db"))?;
            runs::recovery(&conn)?;
            let root = db::get_setting(&conn, "root")?;
            app.manage(AppState {
                _profile_lock: profile_lock,
                db: Mutex::new(conn),
                watcher: Mutex::new(None),
                project_watcher: Mutex::new(None),
                ptys: Default::default(),
                services: Default::default(),
                github_login: Default::default(),
                codex: Default::default(),
                claude: Default::default(),
                acp: Default::default(),
                tracker: Default::default(),
                publication: Default::default(),
                approvals: Default::default(),
                permissions: Default::default(),
                sysmon: Default::default(),
                jev_gate: Default::default(),
                chat_gate: Default::default(),
            });
            tools::start_auto(app.handle().clone());
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
            brain::brain_propose,
            brain::brain_inferences,
            brain::brain_correct_inference,
            brain::brain_decide_inference,
            brain_links::brain_links,
            brain_links::brain_link_save,
            brain_links::brain_link_remove,
            skills::skills_list,
            skills::skills_rule_status,
            skills::skills_assignments,
            skills::skills_set_assignment,
            skills::skills_set_session_role,
            health::health_list,
            health::health_file,
            health::health_import,
            health::health_run,
            health::health_resolve,
            health::health_ci,
            design::design_list,
            design::design_save,
            design::design_shots,
            design::design_components,
            design::design_references,
            design::design_reference_add,
            design::design_reference_remove,
            design::design_image,
            design::design_import,
            design::design_preview,
            design::design_capture,
            design::design_generate,
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
            home::home_summary,
            home::recent_sessions,
            home::home_activity,
            workspace::default_root,
            workspace::set_root,
            workspace::create_group,
            workspace::rename_group,
            workspace::delete_group,
            workspace::move_project,
            workspace::set_archived,
            workspace::create_project,
            workspace::reveal_project,
            workspace::open_worktree,
            browser::browser_open,
            browser::browser_place,
            browser::browser_action,
            browser::browser_status,
            browser::browser_external,
            browser::browser_history,
            browser::browser_bookmarks,
            browser::browser_bookmark,
            browser::browser_bookmark_remove,
            browser::browser_history_clear,
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
            work::work_current,
            work::work_start,
            work::work_assign,
            work::work_prepare,
            work::work_resume,
            tasks::tasks_list,
            tasks::task_flow,
            tasks::task_save,
            tasks::task_link,
            tasks::task_runs,
            tasks::task_parallel_limit,
            chat::chat_pm,
            chat::chat_history,
            chat::chat_switch,
            claude::session_catalog,
            claude::session_list,
            claude::session_create,
            claude::session_create_subsession,
            claude::session_history,
            claude::session_send,
            claude::session_interrupt,
            claude::session_respond,
            autoapprove::session_permission_mode,
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
            tools::tools_update,
            tools::tools_auto_update,
            github_login::github_login_start,
            github_login::github_login_status,
            github_login::github_login_cancel,
            github_login::github_login_open,
            jev::jev_status,
            jev::jev_statusbar,
            jev::jev_usage,
            jev::jev_euro_rate,
            jev::jev_configure,
            services::services_list,
            services::service_save,
            services::service_action,
            containers::containers_list,
            containers::container_link,
            containers::container_unlink,
            containers::container_action,
            containers::container_logs,
            sysmon::system_metrics,
            window::window_backdrop,
        ]))
        .build(tauri::generate_context!())
        .expect("error al iniciar Filigranas")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<AppState>() {
                    state.services.shutdown();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_open_profile_cannot_be_recovered_by_another_instance() {
        let dir = std::env::temp_dir().join(format!("filigranas-profile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let first = lock_profile(&dir).unwrap();
        assert_eq!(lock_profile(&dir).unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
        drop(first);
        assert!(lock_profile(&dir).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
