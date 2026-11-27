use crate::{db, err, AppState, CmdResult};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

// Serializa el arranque de procesos locales con la instalación.
pub static PROCESS_GATE: Mutex<()> = Mutex::new(());
pub static INSTALLING: AtomicBool = AtomicBool::new(false);
static EXECUTIONS: AtomicUsize = AtomicUsize::new(0);
pub struct Execution;
impl Execution {
    pub fn enter() -> Result<Self, &'static str> {
        let _gate = PROCESS_GATE
            .lock()
            .map_err(|_| "cerrojo de actualización no disponible")?;
        if INSTALLING.load(Ordering::SeqCst) {
            return Err("instalando actualización");
        }
        EXECUTIONS.fetch_add(1, Ordering::SeqCst);
        Ok(Self)
    }
}
impl Drop for Execution {
    fn drop(&mut self) {
        EXECUTIONS.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub struct Updates(Mutex<Option<(Update, Option<Vec<u8>>)>>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    current: String,
    channel: String,
    version: Option<String>,
    notes: Option<String>,
    downloaded: bool,
}

fn channel(state: &AppState) -> CmdResult<String> {
    Ok(
        db::get_setting(&*state.db.lock().map_err(err)?, "update_channel")
            .map_err(err)?
            .unwrap_or("stable".into()),
    )
}
fn status(app: &AppHandle, state: &AppState, updates: &Updates) -> CmdResult<Status> {
    let channel = channel(state)?;
    let slot = updates.0.lock().map_err(err)?;
    Ok(Status {
        current: app.package_info().version.to_string(),
        channel,
        version: slot.as_ref().map(|s| s.0.version.clone()),
        notes: slot.as_ref().and_then(|s| s.0.body.clone()),
        downloaded: slot.as_ref().is_some_and(|s| s.1.is_some()),
    })
}
#[tauri::command]
pub fn update_status(
    app: AppHandle,
    state: State<AppState>,
    updates: State<Updates>,
) -> CmdResult<Status> {
    status(&app, &state, &updates)
}

#[tauri::command]
pub async fn update_check(app: AppHandle, selected: Option<String>) -> CmdResult<Status> {
    let state = app.state::<AppState>();
    let updates = app.state::<Updates>();
    // Una sola comprobación o descarga a la vez, incluso desde varias vistas.
    let operation = app.state::<UpdateOperation>();
    let _operation = operation.enter()?;
    let previous_channel = channel(&state)?;
    let chosen = selected.unwrap_or_else(|| previous_channel.clone());
    if !matches!(chosen.as_str(), "stable" | "development") {
        return Err("canal desconocido".into());
    }
    db::set_setting(&*state.db.lock().map_err(err)?, "update_channel", &chosen).map_err(err)?;
    if chosen != previous_channel {
        *updates.0.lock().map_err(err)? = None;
    }
    let key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|key| key.as_str())
        .filter(|key| !key.is_empty())
        .ok_or(
            "Esta compilación todavía no tiene configurada la clave pública de actualizaciones.",
        )?;
    let endpoint = format!("https://github.com/BilalGates/filigranas-ide/releases/download/channel-{chosen}/latest.json");
    let stable = chosen == "stable";
    let candidate = app
        .updater_builder()
        .pubkey(key)
        .endpoints(vec![endpoint.parse().map_err(err)?])
        .map_err(err)?
        .timeout(std::time::Duration::from_secs(30))
        .version_comparator(move |current, remote| {
            remote.version > current && (!stable || remote.version.pre.is_empty())
        })
        .build()
        .map_err(err)?
        .check()
        .await
        .map_err(err)?;
    if let Some(update) = candidate {
        if !trusted_url(update.download_url.as_str()) {
            return Err("origen de descarga no autorizado".into());
        }
        let mut slot = updates.0.lock().map_err(err)?;
        if slot.as_ref().is_none_or(|saved| {
            saved.0.version != update.version || saved.0.download_url != update.download_url
        }) {
            *slot = Some((update, None));
        }
    } else {
        *updates.0.lock().map_err(err)? = None;
    }
    status(&app, &state, &updates)
}

#[derive(Default)]
pub struct UpdateOperation(AtomicBool);
impl UpdateOperation {
    fn enter(&self) -> CmdResult<Operation<'_>> {
        self.0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "hay una operación de actualización en curso")?;
        Ok(Operation(&self.0))
    }
}
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn trusted_url(url: &str) -> bool {
    url.starts_with("https://github.com/BilalGates/filigranas-ide/releases/download/v")
        && !url.contains(['?', '#', '@'])
        && !url.contains("/../")
}
#[tauri::command]
pub async fn update_download(app: AppHandle) -> CmdResult<Status> {
    let operation = app.state::<UpdateOperation>();
    let _operation = operation.enter()?;
    let updates = app.state::<Updates>();
    let update = updates
        .0
        .lock()
        .map_err(err)?
        .as_ref()
        .map(|s| s.0.clone())
        .ok_or("busca una actualización primero")?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(err)?;
    *updates.0.lock().map_err(err)? = Some((update, Some(bytes)));
    status(&app, &app.state::<AppState>(), &updates)
}

fn blockers(state: &AppState, conn: &rusqlite::Connection) -> CmdResult<Vec<String>> {
    let mut reasons = Vec::new();
    if EXECUTIONS.load(Ordering::SeqCst) > 0 {
        reasons.push("comprobaciones o procesos externos en ejecución".into());
    }
    let runs: u32 = conn
        .query_row(
            "SELECT count(*) FROM task_runs WHERE ended_ms IS NULL",
            [],
            |r| r.get(0),
        )
        .map_err(err)?;
    if runs > 0 {
        reasons.push(format!("{runs} turnos o tareas en ejecución"));
    }
    if state.claude.running()
        || state.acp.running("opencode")
        || state.acp.running("agy")
        || state.acp.running("devin")
    {
        reasons.push("procesos de agentes abiertos".into());
    }
    if crate::cli::updates_running() {
        reasons.push("actualización de herramientas en curso".into());
    }
    if state.ptys.has_open()? {
        reasons.push("terminales abiertos".into());
    }
    if state.services.has_running()? {
        reasons.push("servicios locales en ejecución".into());
    }
    Ok(reasons)
}
#[tauri::command]
pub fn update_blockers(state: State<AppState>) -> CmdResult<Vec<String>> {
    blockers(&state, &*state.db.lock().map_err(err)?)
}
#[tauri::command]
pub async fn update_install(app: AppHandle, confirmed: bool) -> CmdResult<()> {
    if !confirmed {
        return Err("confirma la instalación y el reinicio".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let operation = app.state::<UpdateOperation>();
        let _operation = operation.enter()?;
        let _processes = PROCESS_GATE
            .try_lock()
            .map_err(|_| "espera a que termine el arranque de procesos")?;
        let state = app.state::<AppState>();
        let _publication = state
            .publication
            .try_lock()
            .map_err(|_| "hay una operación Git activa")?;
        let conn = state
            .db
            .try_lock()
            .map_err(|_| "espera a que termine la operación de datos en curso")?;
        let reasons = blockers(&state, &conn)?;
        if !reasons.is_empty() {
            return Err(format!("Instalación pospuesta. {}", reasons.join(" · ")));
        }
        // Mientras se instala, bloquea nuevas reservas de turnos y comandos.
        INSTALLING.store(true, Ordering::SeqCst);
        let result = (|| {
            conn.execute_batch("PRAGMA wal_checkpoint(FULL);")
                .map_err(err)?;
            let updates = app.state::<Updates>();
            let slot = updates.0.lock().map_err(err)?;
            let (update, bytes) = slot.as_ref().ok_or("no hay actualización")?;
            update
                .install(bytes.as_ref().ok_or("descarga primero la actualización")?)
                .map_err(err)
        })();
        if result.is_err() {
            INSTALLING.store(false, Ordering::SeqCst);
            return result;
        }
        app.restart()
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_operations_are_rejected_and_retry_is_possible() {
        let operation = UpdateOperation::default();
        let guard = operation.enter().unwrap();
        assert!(operation.enter().is_err());
        drop(guard);
        assert!(operation.enter().is_ok());
    }

    #[test]
    #[ignore = "requires signed release artifacts and the public key"]
    fn release_artifacts_verify() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use minisign_verify::{PublicKey, Signature};
        let key = std::env::var("FILIGRANAS_UPDATER_PUBLIC_KEY").unwrap();
        let key = String::from_utf8(STANDARD.decode(key.trim()).unwrap()).unwrap();
        let key = PublicKey::decode(&key).unwrap();
        let dir = std::env::var("RELEASE_ARTIFACT_DIR").unwrap();
        let mut count = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|ext| ext != "sig") {
                continue;
            }
            let encoded = std::fs::read_to_string(&path).unwrap();
            let text = String::from_utf8(STANDARD.decode(encoded.trim()).unwrap()).unwrap();
            let signature = Signature::decode(&text).unwrap();
            let artifact = path.with_extension("");
            key.verify(&std::fs::read(artifact).unwrap(), &signature, true)
                .unwrap();
            assert_eq!(
                signature
                    .trusted_comment()
                    .split('\t')
                    .find_map(|field| field.strip_prefix("version:")),
                Some(env!("CARGO_PKG_VERSION"))
            );
            count += 1;
        }
        assert_eq!(count, 1, "exactly one signed updater artifact per platform");
    }

    #[test]
    fn rejects_untrusted_release_origins() {
        assert!(trusted_url(
            "https://github.com/BilalGates/filigranas-ide/releases/download/v1.0.0/app.tar.gz"
        ));
        for url in [
            "http://github.com/BilalGates/filigranas-ide/releases/download/v1/a",
            "https://evil.test/app",
            "https://github.com/other/repo/releases/download/v1/a",
        ] {
            assert!(!trusted_url(url));
        }
    }
}
