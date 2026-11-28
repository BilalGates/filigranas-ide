//! Routing called by both PM adapters before creating the real child session.
use super::*;
use crate::tools::routing_candidates;

pub struct Route { pub engine: String, pub effort: Option<String>, pub trace: Trace }

pub fn select(state: &AppState, args: &Value, task: &str) -> CmdResult<Route> {
    let requested = args["agente"].as_str().filter(|s| !s.is_empty() && *s != "auto");
    let fixed_effort = args["esfuerzo"].as_str().filter(|s| *s != "auto");
    // An explicit caller selection needs no intelligent provider decision.
    if let Some(engine) = requested {
        if !["claude", "codex", "opencode", "agy", "devin"].contains(&engine) { return Err("proveedor desconocido".into()); }
        return Ok(Route { engine: engine.into(), effort: fixed_effort.map(str::to_owned),
            trace: Trace { source: "manual".into(), reason: Some("caller_selection".into()), execution_provider: Some(engine.into()), ..Default::default() } });
    }
    let candidates = routing_candidates();
    let engine = candidates.first().ok_or("No hay proveedores autenticados disponibles para delegar. Configura un proveedor en Ajustes.")?.clone();
    let saved = settings(&*state.db.lock().map_err(err)?).map_err(err)?;
    let mut trace = Trace { source: if saved.model.is_none() { "unconfigured" } else { "local" }.into(),
        execution_provider: Some(engine.clone()), effort: fixed_effort.or(Some("medium")).map(str::to_owned), ..Default::default() };
    if saved.mode == Mode::Local || saved.model.is_none() || candidates.len() < 2 { return Ok(Route { engine, effort: trace.effort.clone(), trace }); }
    let criteria: serde_json::Map<String,Value> = candidates.iter().map(|id| (id.clone(), json!(match id.as_str() {
        "claude" => "Claude Code: implementation, investigation, review, visual work; authenticated CLI.",
        "codex" => "Codex: implementation, debugging, testing and review; authenticated CLI.",
        _ => "Available authenticated executor through the shared Filigranas session adapter.",
    }))).collect();
    let mut body = json!({ "model": saved.model, "state": {
        "role": args["rol"].as_str().filter(|r| ["researcher","designer","senior","junior","auditor","auditor2"].contains(r)).unwrap_or("senior"),
        "scope": if task.len() < 400 { "small" } else if task.len() < 1500 { "medium" } else { "large" },
        "policy": saved.policy, "available_providers": candidates,
        "costs": "unknown; do not assume relative prices", "task_content": "not disclosed"
    }, "questions": { "provider": { "type":"choice", "instructions":"Select the available executor best suited to the role and scope. Optimize consumption according to policy. Never select an unavailable provider or invent cost data.", "criteria":criteria } } });
    if fixed_effort.is_none() {
        body["questions"]["effort"] = json!({"type":"choice", "instructions":"Choose reasoning effort for the role and approximate task scope. Prefer sufficient quality; economy favors low for small routine work.", "criteria":{"low":"Small straightforward low risk work", "medium":"Routine implementation or review", "high":"Complex work or independent audit"}});
    }
    let started = std::time::Instant::now();
    let mut api_attempted = false;
    let mut http_status = None;
    let result = (|| {
        let _gate = state.jev_gate.try_lock().map_err(|_| "busy")?;
        let key = credential::read(false).ok_or("credential")?;
        if !reserve(&state.db).map_err(|_| "budget")? { return Err("budget"); }
        api_attempted = true;
        let result = typesafe::evaluate(&key, saved.timeout_secs, &body);
        http_status = match &result { Ok(_) => Some(200), Err(failure) => failure.status() };
        result.map_err(Failure::code)
    })();
    trace.duration_ms = Some(started.elapsed().as_millis() as u64);
    trace.api_attempted = api_attempted;
    trace.http_status = http_status;
    trace.endpoint = api_attempted.then(|| "POST /v1/systemone".into());
    let answer = match result {
        Ok(value) => value,
        Err(reason) => { trace.source = "api_error".into(); trace.reason = Some(reason.into()); return Ok(Route { engine, effort: trace.effort.clone(), trace }); }
    };
    trace.model = answer["model"].as_str().filter(|m| valid_model(m)).map(str::to_owned);
    trace.input_tokens = answer["usage"]["input_tokens"].as_u64();
    trace.output_tokens = answer["usage"]["output_tokens"].as_u64();
    trace.cost_estimate_usd = trace.model.as_deref().zip(trace.input_tokens).and_then(|(m,t)| estimate_usd(m,t));
    trace.confidence = answer.pointer("/answers/provider/confidence").and_then(Value::as_f64);
    let allowed: Vec<&str> = candidates.iter().map(String::as_str).collect();
    let choice = advice(&answer, "provider", &allowed).filter(|_| trace.model.is_some());
    if let Some(choice) = choice {
        if saved.mode == Mode::Shadow { trace.source = "shadow".into(); }
        else {
            trace.source = "jev".into();
            trace.execution_provider = Some(choice);
            if fixed_effort.is_none() { trace.effort = advice(&answer,"effort",&["low","medium","high"]).or(trace.effort); }
        }
    } else { trace.source = "local".into(); trace.reason = Some("invalid_or_low_confidence".into()); }
    Ok(Route { engine: trace.execution_provider.clone().unwrap_or(engine), effort: trace.effort.clone(), trace })
}

pub fn stage(conn: &Connection, session: i64, trace: &Trace) -> CmdResult<()> {
    conn.execute("INSERT OR REPLACE INTO jev_delegations(session_id,data) VALUES(?1,?2)", params![session,serde_json::to_string(trace).map_err(err)?]).map_err(err)?;
    Ok(())
}
