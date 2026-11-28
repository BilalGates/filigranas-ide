//! Provider identity/capabilities and observed health, shared by routing and UI.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::{db, err, AppState, CmdResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    pub vendor: &'static str,
    pub transport: &'static str,
    pub project_manager: bool,
}

pub const PROVIDERS: [Provider; 3] = [
    Provider { id:"claude",name:"Claude Code",vendor:"Anthropic",transport:"stream-json",project_manager:true },
    Provider { id:"codex",name:"Codex",vendor:"OpenAI",transport:"app-server",project_manager:true },
    Provider { id:"agy",name:"Antigravity",vendor:"Google",transport:"acp",project_manager:false },
];

#[tauri::command]
pub fn provider_catalog() -> &'static [Provider] { &PROVIDERS }

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub id: String,
    pub connected: Option<bool>,
    pub observed_at: i64,
    pub message: String,
    pub config: Value,
    pub capabilities: Value,
    pub quota_model: Option<String>,
    #[serde(default)]
    pub quota_observed_at: Option<i64>,
}

pub fn now() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64 }

pub fn health(conn: &rusqlite::Connection, id: &str) -> Health {
    db::get_setting(conn, &format!("provider-health:{id}")).ok().flatten()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| Health {id:id.into(), ..Health::default()})
}

pub fn observe(app: &AppHandle, value: Health) -> CmdResult<()> {
    let state = app.state::<AppState>();
    db::set_setting(&*state.db.lock().map_err(err)?, &format!("provider-health:{}", value.id), &serde_json::to_string(&value).map_err(err)?).map_err(err)?;
    let _ = app.emit("provider-health", &value);
    Ok(())
}

#[tauri::command]
pub fn provider_health(state: State<AppState>) -> CmdResult<Vec<Health>> {
    let conn = state.db.lock().map_err(err)?;
    Ok(PROVIDERS.iter().map(|p| health(&conn,p.id)).collect())
}

/// Official ACP authentication check. No prompt is sent and no credential
/// material is inspected. The result is cached so status UI does not spawn CLIs.
pub fn diagnose(app: &AppHandle) -> CmdResult<Health> {
    static CHECK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _check = CHECK.lock().map_err(err)?;
    let old = health(&*app.state::<AppState>().db.lock().map_err(err)?, "agy");
    if now()-old.observed_at < 300 { return Ok(old); }
    let root = app.path().app_data_dir().map_err(err)?.join("antigravity/diagnostic");
    let scratch = root.join("workspace");
    std::fs::create_dir_all(&scratch).map_err(err)?;
    let mut command = crate::cli::command(crate::cli::program("agy"));
    command.arg("acp");
    crate::antigravity::configure(&mut command,&root,true)?;
    if let Some(path) = crate::cli::login_path() { command.env("PATH",path); }
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    command.current_dir(&scratch).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let mut child = command.spawn().map_err(err)?;
    let rpc = crate::rpc::Rpc::start_with(child.stdout.take().ok_or("sin salida ACP")?,child.stdin.take().ok_or("sin entrada ACP")?,|rpc,msg| {
        if let crate::rpc::Incoming::Request{id,..} = msg { let _ = rpc.respond(id,json!({"outcome":{"outcome":"cancelled"}})); }
    },true);
    let timeout = std::time::Duration::from_secs(30);
    let result = (|| {
        let init = rpc.request("initialize",json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"filigranas","version":env!("CARGO_PKG_VERSION")}}),timeout)?;
        let session = rpc.request("session/new",json!({"cwd":scratch,"mcpServers":[]}),timeout)?;
        if let Some(sid) = session["sessionId"].as_str() { let _ = rpc.request("session/close",json!({"sessionId":sid}),std::time::Duration::from_secs(3)); }
        Ok::<_,String>((init,session))
    })();
    rpc.close_input();
    crate::cli::finish_child(&mut child);
    let value = match result {
        Ok((init,session)) => Health {id:"agy".into(),connected:Some(true),observed_at:now(),message:"Cuenta conectada mediante ACP".into(),config:session["configOptions"].clone(),capabilities:init["agentCapabilities"].clone(),quota_model:old.quota_model,quota_observed_at:old.quota_observed_at},
        Err(e) => Health {id:"agy".into(),connected: if e.contains("Authentication required") {Some(false)} else {None},observed_at:now(),message:if e.contains("Authentication required") {"Inicia sesión con agy acp --login"} else {"No se pudo conectar mediante ACP; comprueba la CLI y la conexión"}.into(),..Health::default()},
    };
    observe(app,value.clone())?;
    Ok(value)
}

pub fn concurrency_limit(conn: &rusqlite::Connection, id: &str) -> u32 {
    db::get_setting(conn,&format!("provider-concurrency:{id}")).ok().flatten()
        .and_then(|s| s.parse::<u32>().ok()).filter(|v| (1..=16).contains(v)).unwrap_or(3)
}

/// Coordination metadata only: no credentials, task text, paths or fabricated prices.
pub fn overview(state: &AppState) -> CmdResult<String> {
    use rusqlite::OptionalExtension;
    let conn=state.db.lock().map_err(err)?;
    let mut items=Vec::new();
    for provider in &PROVIDERS {
        let health=health(&conn,provider.id);
        let active: u32=conn.query_row("SELECT count(*) FROM task_runs WHERE provider=?1 AND ended_ms IS NULL",[provider.id],|r|r.get(0)).map_err(err)?;
        let last: Option<String>=conn.query_row("SELECT outcome FROM task_runs WHERE provider=?1 ORDER BY id DESC LIMIT 1",[provider.id],|r|r.get(0)).optional().map_err(err)?;
        items.push(json!({"provider":provider,"connected":health.connected,"observedAt":health.observed_at,"stale":now()-health.observed_at>1800,
            "options":health.config,"capabilities":health.capabilities,"lastQuotaModel":health.quota_model,"quotaObservedAt":health.quota_observed_at,"lastOutcome":last,
            "activeExecutions":active,"concurrencyLimit":concurrency_limit(&conn,provider.id),"cost":null,"aggregateQuota":null}));
    }
    serde_json::to_string(&items).map_err(err)
}
