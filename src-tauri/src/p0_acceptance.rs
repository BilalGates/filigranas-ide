//! Explicit native acceptance fixture; absent from normal/release builds.
use std::{path::Path, sync::{Arc, Mutex}, time::Duration};
use serde_json::{json, Value};
use tauri::{AppHandle, Listener, Manager};
use crate::{autoapprove, claude, db, err, AppState, CmdResult};

pub fn start(app: AppHandle) {
    if !app.config().identifier.ends_with(".dev.p0") { return; }
    let Ok(dir) = app.path().app_data_dir() else { return };
    // File watching must never repeat billable tests automatically.
    if std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join("p0-acceptance.started")).is_err() { return; }
    if let Ok(conn) = app.state::<AppState>().db.lock() { let _ = db::set_setting(&conn,"cli_auto_update","0"); }
    std::thread::spawn(move || {
        let result = run(&app);
        match result {
            Ok(evidence) => {
                let path = std::env::temp_dir().join("filigranas-p0-native-evidence.json");
                let written = std::fs::write(&path, serde_json::to_vec_pretty(&evidence).unwrap());
                eprintln!("P0_NATIVE_ACCEPTANCE complete={} evidence={}",written.is_ok(),path.display());
            }
            Err(error) => eprintln!("P0_NATIVE_ACCEPTANCE failed={error}"),
        }
    });
}

fn require(value: bool, label: &str) -> CmdResult<()> {
    if value { Ok(()) } else { Err(label.into()) }
}
fn git(dir: &Path, args: &[&str]) -> CmdResult<()> {
    let status = crate::cli::command("git").args(args).current_dir(dir).output().map_err(err)?;
    require(status.status.success(), "fixture_git_failed")
}
fn create(app: &AppHandle, project: &str, engine: &str, mode: &str, name: &str) -> CmdResult<db::Session> {
    let state = app.state::<AppState>();
    let session = {
        let conn = state.db.lock().map_err(err)?;
        let provider_id = if engine == "claude" { uuid::Uuid::new_v4().to_string() } else { String::new() };
        db::create_session(&conn, project, engine, &provider_id, &[name]).map_err(err)?
    };
    autoapprove::session_permission_mode(app.state(),Some(session.id),None,mode.into())?;
    Ok(session)
}
fn turn(app: &AppHandle, session: &db::Session, text: &str) -> CmdResult<()> {
    claude::send_message(app,session.id,text.into(),Some("low".into()))?;
    let state = app.state::<AppState>();
    let t = state.tracker.wait_idle(session.id,Duration::from_secs(90));
    require(!t.running,"native_turn_timeout")?;
    // Verify the persisted native run, not just an idle process.
    let mut outcome = String::new();
    for _ in 0..100 {
        outcome = state.db.lock().map_err(err)?.query_row("SELECT outcome FROM task_runs WHERE session_id=?1 ORDER BY id DESC LIMIT 1",[session.id],|r|r.get(0)).map_err(err)?;
        if outcome == "completed" || outcome == "failed" || outcome == "cancelled" { break; }
        std::thread::sleep(Duration::from_millis(20));
    }
    require(outcome == "completed", &format!("native_turn_{outcome}"))
}
fn run(app: &AppHandle) -> CmdResult<Value> {
    let root = std::env::temp_dir().join(format!("filigranas-p0-native-{}",uuid::Uuid::new_v4()));
    let repo = root.join("fixture");
    std::fs::create_dir_all(&repo).map_err(err)?;
    git(&repo,&["init","-b","fixture"])?;
    std::fs::write(repo.join("README.md"),"Controlled P0 acceptance repository\n").map_err(err)?;
    git(&repo,&["add","README.md"])?;
    git(&repo,&["-c","user.name=P0 fixture","-c","user.email=p0@example.invalid","commit","-m","test: initialize fixture"])?;
    let root = root.canonicalize().map_err(err)?;
    let project = repo.canonicalize().map_err(err)?.to_string_lossy().into_owned();
    let state = app.state::<AppState>();
    {
        let conn = state.db.lock().map_err(err)?;
        db::set_setting(&conn,"root",&root.to_string_lossy()).map_err(err)?;
        conn.execute("INSERT OR IGNORE INTO projects(path) VALUES(?1)",[&project]).map_err(err)?;
        require(crate::work::current(&conn,&project)?.is_none(),"fixture_has_active_work")?;
    }
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let observed = requests.clone();
    let handle = app.clone();
    let session_listener = app.listen("session",move |event| {
        let Ok(value) = serde_json::from_str::<Value>(event.payload()) else { return };
        if value.pointer("/msg/type") == Some(&json!("control_request")) {
            if let Some(id) = value.pointer("/msg/request_id").and_then(Value::as_str) {
                observed.lock().unwrap().push(json!({"session":value["id"],"kind":"ask"}));
                let handle = handle.clone(); let id = id.to_string();
                std::thread::spawn(move || { let _ = claude::session_respond(handle.clone(),handle.state(),id,"decline".into()); });
            }
        }
    });
    let observed = requests.clone();
    let handle = app.clone();
    let codex_listener = app.listen("coordinator",move |event| {
        let Ok(value) = serde_json::from_str::<Value>(event.payload()) else { return };
        if value["requestId"].is_null() { return; }
        observed.lock().unwrap().push(json!({"thread":value.pointer("/params/threadId"),"kind":"ask"}));
        eprintln!("P0_NATIVE_CODEX_APPROVAL method={} reason={} grant_root={}",value["method"],value.pointer("/params/reason").unwrap_or(&Value::Null),value.pointer("/params/grantRoot").unwrap_or(&Value::Null));
        let handle = handle.clone(); let id = value["requestId"].clone();
        std::thread::spawn(move || { let _ = crate::codex::coordinator_respond(handle.clone(),handle.state(),id,"decline".into()); });
    });
    let mut cases = Vec::new();
    let providers = std::env::var("FILIGRANAS_P0_PROVIDERS").unwrap_or_else(|_| "claude,codex".into());
    for engine in ["claude","codex"].into_iter().filter(|e| providers.split(',').any(|p| p == *e)) {
        for mode in ["readonly","ask","auto","full"] {
            let session = create(app,&project,engine,mode,&format!("p0-{engine}-{mode}"))?;
            let count = requests.lock().map_err(err)?.len();
            let file = format!("{engine}-{mode}.txt");
            let prompt = format!("Acceptance test in a disposable repository. Create {file} with exactly P0-OK using the file editing tool. If blocked, do not retry or use another tool; simply say BLOCKED. Do not run commands, commit or delegate.");
            let outcome = turn(app,&session,&prompt);
            let exists = Path::new(&project).join(&file).exists();
            let asks = requests.lock().map_err(err)?.len()-count;
            let expected = matches!(mode,"auto"|"full");
            let passed = outcome.is_ok() && exists == expected && (mode != "full" || asks == 0) && (mode != "auto" || asks == 0);
            let case = json!({"provider":engine,"mode":mode,"passed":passed,"file_exists":exists,"user_requests":asks,"turn_error":outcome.err()});
            eprintln!("P0_NATIVE_CASE {case}"); cases.push(case);
        }
    }
    // Changing modes on the same native session must revoke write permission.
    let parent = create(app,&project,"claude","full","p0-inherit")?;
    let child = claude::create_subsession(app,parent.id,"codex",Some("inheritance"),None)?;
    require(state.permissions.get(child.id) == autoapprove::Mode::Full,"inheritance_failed")?;
    autoapprove::session_permission_mode(app.state(),Some(parent.id),None,"readonly".into())?;
    let changed = claude::create_subsession(app,parent.id,"claude",Some("readonly inheritance"),None)?;
    require(state.permissions.get(changed.id) == autoapprove::Mode::ReadOnly,"changed_inheritance_failed")?;
    turn(app,&parent,"Create forbidden-after-change.txt with Write. If denied, say BLOCKED and do not retry.")?;
    require(!Path::new(&project).join("forbidden-after-change.txt").exists(),"mode_change_wrote")?;
    crate::jev::acceptance_activate(&state)?;
    let args = json!({"agente":"auto","rol":"auditor","titulo":"P0 Jev routing","tarea":"Read README.md and return exactly P0-ROUTED. Do not modify files or run commands."});
    let response = crate::delegate::handle_claude(app,parent.id,"delegar",&args)?;
    let delegated = db::sessions(&*state.db.lock().map_err(err)?,&project).map_err(err)?.into_iter().max_by_key(|s|s.id).ok_or("no_delegated_child")?;
    let t = state.tracker.wait_idle(delegated.id,Duration::from_secs(90));
    require(!t.running,"delegation_timeout")?;
    let trace: String = state.db.lock().map_err(err)?.query_row("SELECT j.data FROM jev_routes j JOIN task_runs r ON r.id=j.run_id WHERE r.session_id=?1 ORDER BY r.id DESC LIMIT 1",[delegated.id],|r|r.get(0)).map_err(err)?;
    let trace: Value = serde_json::from_str(&trace).map_err(err)?;
    require(trace["executionProvider"]==delegated.engine,"routing_provider_not_applied")?;
    app.unlisten(session_listener); app.unlisten(codex_listener);
    Ok(json!({"fixture":project,"work_active":false,"cases":cases,"permission_inheritance":true,"mode_change_revokes_write":true,
        "delegation_created":response.contains("creada"),"delegation_provider":delegated.engine,"routing":trace}))
}
