//! Local selection for PM executors. Catalogs establish availability, never price.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use crate::{db, err, AppState, CmdResult};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Level { Barato, #[default] Medio, Fuerte, Maximo }

#[derive(Default, Deserialize, Serialize)]
pub struct Request {
    pub nivel: Level,
    pub modelo: Option<String>,
}

impl Request {
    pub fn from_args(args: &Value) -> CmdResult<Self> {
        let level = args.get("nivel").cloned().map(serde_json::from_value).transpose().map_err(err)?;
        let model = args.get("modelo").map(|v| v.as_str().filter(|s| !s.trim().is_empty() && s.len() <= 128)
            .map(str::to_owned).ok_or("modelo no válido")).transpose()?;
        let inferred = match args["tipo"].as_str() {
            Some("arquitectura" | "threat_model" | "planificacion" | "estadistica") => Level::Maximo,
            Some("revision" | "revision_independiente" | "auditoria_visual" | "diseno" | "logo" | "efectos") => Level::Fuerte,
            Some("investigacion") => Level::Barato,
            _ => match args["rol"].as_str() {
                Some("architect" | "security" | "data") => Level::Maximo,
                Some("researcher") => Level::Barato,
                Some("auditor" | "auditor2" | "designer" | "graphic") => Level::Fuerte,
                _ => Level::Medio,
            },
        };
        Ok(Self { nivel: level.unwrap_or(inferred), modelo: model })
    }
}

pub struct Model {
    pub id: String,
    pub efforts: Vec<String>,
    pub current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub model: String,
    pub effort: Option<String>,
    pub reason: String,
}

pub fn select(engine: &str, request: &Request, pinned: Option<&str>, effort: Option<&str>, models: &[Model]) -> CmdResult<Selection> {
    let explicit = pinned.or(request.modelo.as_deref());
    let preferred: &[&str] = match (engine, request.nivel) {
        ("codex", Level::Barato) => &["gpt-6-luna", "gpt-6.2-sol", "gpt-6.1-sol"],
        ("codex", Level::Maximo) => &["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-sol"],
        ("codex", _) => &["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-sol"],
        ("claude", Level::Barato) => &["haiku", "sonnet"],
        ("claude", Level::Medio) => &["sonnet", "opus"],
        ("claude", Level::Fuerte) => &["opus", "sonnet"],
        ("claude", Level::Maximo) => &["fable", "opus", "sonnet"],
        _ => &[],
    };
    let matched = |candidate: &&str| models.iter().find(|m| m.id.as_str() == *candidate
        || (engine == "claude" && m.id.split('-').any(|part| part == *candidate)));
    let (model, origin) = if let Some(id) = explicit {
        (models.iter().find(|m| m.id == id).ok_or_else(|| format!("el modelo {id} no está disponible en {engine}"))?,
            if pinned.is_some() { "modelo fijado en la sesión" } else { "modelo solicitado por el PM" })
    } else if let Some(model) = preferred.iter().find_map(matched) {
        (model, "preferencia local por nivel; sin estimación de precio ni cuota")
    } else {
        (models.iter().find(|m| m.current).ok_or("el catálogo no ofrece un modelo conocido ni uno predeterminado; indica modelo explícitamente")?,
            "nivel sin correspondencia conocida; se conserva el modelo predeterminado del proveedor")
    };
    let requested = effort.filter(|e| *e != "auto");
    if requested.is_some_and(|e| !model.efforts.iter().any(|v| v == e)) {
        return Err(format!("el esfuerzo {} no está disponible para {}", requested.unwrap(), model.id));
    }
    let target = match request.nivel {
        Level::Barato => "low", Level::Medio => "medium", Level::Fuerte => "high",
        Level::Maximo if engine == "codex" && model.id.contains("astra") => "low",
        Level::Maximo => "high",
    };
    // Do not silently raise effort when a provider does not offer the target.
    let selected_effort = requested.or_else(|| model.efforts.iter().find(|e| e.as_str() == target).map(String::as_str));
    Ok(Selection { model: model.id.clone(), effort: selected_effort.map(str::to_owned),
        reason: format!("{origin}; nivel {:?}; esfuerzo {}", request.nivel, selected_effort.unwrap_or("predeterminado del proveedor")) })
}

/// Runs after claiming the durable queue: failures retain the original prompt.
pub fn prepare(app: &AppHandle, session: &db::Session, run: i64, effort: Option<String>) -> CmdResult<Option<String>> {
    let state = app.state::<AppState>();
    let options = db::session_options(&*state.db.lock().map_err(err)?, session.id).map_err(err)?;
    let Some(raw) = options.get("pm-routing").and_then(Value::as_str) else { return Ok(effort) };
    let request: Request = serde_json::from_str(raw).map_err(err)?;
    let (key, models) = match session.engine.as_str() {
        "codex" => ("model".into(), state.codex.delegation_models(app)?),
        "claude" => ("model".into(), state.claude.delegation_models(app, session)?),
        "agy" => state.acp.delegation_models(app, &state, session)?,
        _ => return Err("proveedor de delegación no válido".into()),
    };
    let pinned = options.get(&key).and_then(Value::as_str);
    let mut selection = select(&session.engine, &request, pinned, if session.engine == "agy" { None } else { effort.as_deref() }, &models)?;
    if session.engine == "agy" {
        state.acp.apply_delegation_model(app, &state, session, &key, &selection.model)?;
        let (_, refreshed) = state.acp.delegation_models(app, &state, session)?;
        selection = select(&session.engine, &request, Some(&selection.model), effort.as_deref(), &refreshed)?;
    } else {
        db::update_session_option(&*state.db.lock().map_err(err)?, session.id, &key, Some(&selection.model)).map_err(err)?;
    }
    record(&*state.db.lock().map_err(err)?,session.id,run,&request,&selection)?;
    Ok(selection.effort)
}

fn record(conn: &rusqlite::Connection, session: i64, run: i64, request: &Request, selection: &Selection) -> CmdResult<()> {
    let mut trace: Value = conn.query_row("SELECT trace FROM provider_assignments WHERE session_id=?1", [session], |r| r.get::<_,String>(0))
        .map_err(err).and_then(|s| serde_json::from_str(&s).map_err(err))?;
    let provider_reason = trace["reason"].as_str().unwrap_or("").to_owned();
    trace["executionModel"] = serde_json::json!(selection.model);
    trace["effort"] = serde_json::json!(selection.effort);
    trace["complexity"] = serde_json::json!(request.nivel);
    trace["reason"] = serde_json::json!(format!("{provider_reason}. Modelo: {}", selection.reason));
    let data = serde_json::to_string(&trace).map_err(err)?;
    conn.execute("INSERT INTO jev_routes(run_id,data) VALUES(?1,?2) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data", rusqlite::params![run,data]).map_err(err)?;
    conn.execute("UPDATE task_runs SET queue_effort=?2 WHERE id=?1", rusqlite::params![run,selection.effort]).map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn model(id: &str, efforts: &[&str]) -> Model { Model { id: id.into(), efforts: efforts.iter().map(|s|s.to_string()).collect(), current: false } }

    #[test]
    fn routes_by_level_and_available_models_without_overriding_pins() {
        let models = vec![model("gpt-6-luna", &["low"]), model("gpt-6.1-sol", &["low","medium","high"]), model("gpt-6.2-sol", &["medium","high"]), model("gpt-6.2-astra", &["low","high"])];
        for (level, expected, effort) in [(Level::Barato,"gpt-6-luna","low"),(Level::Medio,"gpt-6.2-sol","medium"),(Level::Fuerte,"gpt-6.2-sol","high"),(Level::Maximo,"gpt-6.2-astra","low")] {
            let request = Request { nivel: level, modelo: None };
            let selected = select("codex",&request,None,None,&models).unwrap();
            assert_eq!(selected.model,expected); assert_eq!(selected.effort.as_deref(),Some(effort));
            assert_eq!(select("codex",&request,Some("gpt-6.1-sol"),None,&models).unwrap().model,"gpt-6.1-sol");
        }
        let request = Request::default();
        assert_eq!(select("codex",&request,None,None,&models[..2]).unwrap().model,"gpt-6.1-sol");
        assert!(select("codex",&request,Some("missing"),None,&models).is_err());
        assert!(select("codex",&request,None,Some("max"),&models).is_err());
        assert!(select("codex",&request,None,None,&[]).is_err());
    }

    #[test]
    fn explicit_requests_and_unknown_catalogs_remain_honest() {
        assert!(Request::from_args(&json!({"nivel":"inventado"})).is_err());
        assert!(Request::from_args(&json!({"modelo":42})).is_err());
        assert_eq!(Request::from_args(&json!({"rol":"security"})).unwrap().nivel,Level::Maximo);
        assert_eq!(Request::from_args(&json!({"rol":"senior","tipo":"revision"})).unwrap().nivel,Level::Fuerte);
        assert_eq!(Request::from_args(&json!({"rol":"researcher","nivel":"medio"})).unwrap().nivel,Level::Medio);
        let request = Request { nivel: Level::Barato, modelo: Some("gpt-6.1-sol".into()) };
        let models = vec![model("gpt-6.1-sol", &["medium"])];
        let selected=select("codex",&request,None,None,&models).unwrap();
        assert_eq!(selected.effort,None);
        let mut unknown=model("future", &[]); unknown.current=true;
        assert_eq!(select("agy",&Request::default(),None,None,&[unknown]).unwrap().model,"future");
        assert_eq!(select("claude",&Request::default(),None,None,&[model("claude-sonnet-5-5", &["medium"])]).unwrap().model,"claude-sonnet-5-5");
    }

    #[test]
    fn selection_and_failed_prompt_survive_reopening_without_changing_provider_evidence() {
        let temp=std::env::temp_dir().join(format!("filigranas-routing-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let path=temp.join("routing.sqlite");
        let conn=db::open(&path).unwrap();
        let session=db::create_session(&conn,"/a","codex","",&["one"]).unwrap();
        conn.execute("INSERT INTO provider_assignments(session_id,parent_scope,trace) VALUES(?1,'pm:/a',?2)",
            rusqlite::params![session.id,json!({"source":"jev","reason":"provider choice","selectedProvider":"codex","confidence":0.9}).to_string()]).unwrap();
        let request=Request { nivel:Level::Medio, modelo:Some("gpt-6.1-sol".into()) };
        db::set_session_option(&conn,session.id,"pm-routing",&serde_json::to_string(&request).unwrap()).unwrap();
        let run=crate::runs::prepare(&conn,"/a",&crate::runs::session_scope(session.id),"codex",Some(session.id),None,"  exact prompt  ",false).unwrap();
        let selected=select("codex",&request,None,None,&[model("gpt-6.1-sol", &["medium"])]).unwrap();
        record(&conn,session.id,run,&request,&selected).unwrap();
        crate::runs::fail_start(&conn,run,"provider offline").unwrap();
        drop(conn);
        let reopened=db::open(&path).unwrap();
        let raw:String=reopened.query_row("SELECT data FROM jev_routes WHERE run_id=?1",[run],|r|r.get(0)).unwrap();
        let trace:Value=serde_json::from_str(&raw).unwrap();
        assert_eq!(trace["source"],"jev"); assert_eq!(trace["confidence"],0.9);
        assert_eq!(trace["executionModel"],"gpt-6.1-sol"); assert_eq!(trace["effort"],"medium");
        let persisted:(String,String,String)=reopened.query_row("SELECT prompt,outcome,queue_effort FROM task_runs WHERE id=?1",[run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(persisted,("  exact prompt  ".into(),"failed".into(),"medium".into()));
        let options=db::session_options(&reopened,session.id).unwrap();
        assert_eq!(serde_json::from_str::<Request>(options["pm-routing"].as_str().unwrap()).unwrap().modelo,request.modelo);
        drop(reopened);
        std::fs::remove_dir_all(temp).unwrap();
    }
}
