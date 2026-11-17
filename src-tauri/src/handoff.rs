use std::path::Path;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::claude::{open_session, send_message, NAMES};
use crate::git::git;
use crate::{db, err, AppState, CmdResult};

// Continuidad de las tareas (PLAN.md §4): pausa por cuota o manual,
// reanudación de la sesión nativa y relevo a otro motor en la misma rama y
// worktree. El relevo lo redacta el IDE con datos comprobables, no el
// agente anterior, que puede haberse quedado sin cuota.

const QUOTA_HINTS: [&str; 9] =
    ["rate limit", "rate_limit", "usage limit", "quota", "limit reached", "out of credits", "credit balance", "too many requests", "429"];

/// Motivo de pausa si un error del motor indica falta de cuota.
pub fn quota_reason(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    QUOTA_HINTS.iter().any(|h| lower.contains(h)).then(|| format!("cuota agotada: {}", clip(text.trim(), 200)))
}

fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

/// Marca la sesión como pausada y avisa a la interfaz.
pub fn pause(app: &AppHandle, id: i64, reason: &str) {
    let state = app.state::<AppState>();
    if let Ok(conn) = state.db.lock() {
        let _ = db::set_session_paused(&conn, id, Some(reason));
    }
    let _ = app.emit("session", json!({ "id": id, "msg": { "type": "paused", "reason": reason } }));
}

/// Texto del relevo para el agente que continúa.
pub fn relevo(from: &db::Session, from_engine: &str, stat: &str, log: &str, last: &str) -> String {
    let mut out = format!("Relevo de la sesión «{}» ({from_engine}). Continúas su tarea en la misma carpeta de trabajo.\n\n", from.name);
    out.push_str(&format!("## Objetivo\n{}\n\n", from.task.as_deref().unwrap_or("(sin encargo registrado; pregunta al usuario si no queda claro por el estado del código)")));
    match (&from.branch, &from.worktree, &from.base) {
        (Some(b), Some(w), Some(base)) => out.push_str(&format!("## Rama\n{b} (parte de {base}), en {w}\n\n")),
        _ => out.push_str("## Carpeta\nLa carpeta del proyecto (sin rama propia).\n\n"),
    }
    out.push_str(&format!("## Cambios hasta ahora\n{}\n\n", if stat.trim().is_empty() { "Ninguno." } else { stat.trim() }));
    if !log.trim().is_empty() {
        out.push_str(&format!("## Commits de la sesión\n{}\n\n", log.trim()));
    }
    if !last.trim().is_empty() {
        out.push_str(&format!("## Último informe del agente anterior\n{}\n\n", clip(last.trim(), 3000)));
    }
    if let Some(p) = &from.paused {
        out.push_str(&format!("## Motivo del relevo\n{p}\n\n"));
    }
    out.push_str(
        "## Próximos pasos\n1. Revisa el estado real (git status y git diff) antes de cambiar nada: el informe anterior puede estar incompleto.\n\
2. Ejecuta las pruebas pertinentes para saber de dónde partes.\n3. Continúa con el objetivo sin repetir lo que ya está hecho y resume al final qué cambiaste y cómo lo comprobaste.",
    );
    out
}

/// Diff resumido y commits de la sesión desde su punto de partida.
fn progress(s: &db::Session) -> (String, String) {
    let cwd = Path::new(s.cwd());
    let Some(base) = &s.base_commit else {
        let stat = git(cwd, &["diff", "HEAD", "--stat"]).map(|o| String::from_utf8_lossy(&o).into_owned()).unwrap_or_default();
        return (stat, String::new());
    };
    let _ = git(cwd, &["add", "-A", "-N"]);
    let stat = git(cwd, &["diff", base, "--stat"]).map(|o| String::from_utf8_lossy(&o).into_owned()).unwrap_or_default();
    let log = git(cwd, &["log", "--oneline", &format!("{base}..HEAD")]).map(|o| String::from_utf8_lossy(&o).into_owned()).unwrap_or_default();
    (stat, log)
}

fn engine_label(engine: &str) -> &str {
    match engine {
        "claude" => "claude code",
        "agy" => "antigravity",
        other => other,
    }
}

/// Detiene el turno (si lo hay) y deja la sesión en pausa.
fn stop(state: &AppState, s: &db::Session) {
    let _ = if s.engine == "claude" { state.claude.interrupt(s.id) } else { state.acp.interrupt(s.id) };
}

// ── comandos ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn session_pause(app: AppHandle, id: i64) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let s = open_session(&state, id)?;
    stop(&state, &s);
    pause(&app, id, "pausa manual");
    Ok(())
}

/// Reanuda la sesión nativa y le pide continuar.
#[tauri::command]
pub async fn session_resume(app: AppHandle, id: i64) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        db::set_session_paused(&*state.db.lock().map_err(err)?, id, None).map_err(err)?;
        send_message(
            &app,
            id,
            "Retoma la tarea donde la dejaste. Revisa primero el estado de la carpeta de trabajo (git status y git diff) y continúa con el objetivo.".into(),
            None,
        )
    })
    .await
    .map_err(err)?
}

/// Pasa la tarea a otro motor en la misma rama y worktree.
#[tauri::command]
pub async fn session_handoff(app: AppHandle, id: i64, engine: String) -> CmdResult<db::Session> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let from = open_session(&state, id)?;
        if engine != "claude" && !crate::acp::ENGINES.contains(&engine.as_str()) {
            return Err(format!("motor desconocido: {engine}"));
        }
        let (stat, log) = progress(&from);
        let text = relevo(&from, engine_label(&from.engine), &stat, &log, &state.tracker.get(id).last);
        // Un solo agente por carpeta: el anterior termina antes de empezar.
        stop(&state, &from);
        state.claude.forget(id);
        state.acp.close(id)?;
        let provider = if engine == "claude" { uuid::Uuid::new_v4().to_string() } else { String::new() };
        let to = {
            let conn = state.db.lock().map_err(err)?;
            let to = db::create_handoff(&conn, &from, &engine, &provider, &NAMES).map_err(err)?;
            db::close_session(&conn, id).map_err(err)?;
            to
        };
        let _ = app.emit("sessions-changed", json!({ "project": from.project, "focus": to.id }));
        send_message(&app, to.id, text, None)?;
        Ok(to)
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_quota_errors() {
        assert!(quota_reason("Claude AI usage limit reached|1794868878").is_some());
        assert!(quota_reason("429 Too Many Requests").is_some());
        assert!(quota_reason("error de sintaxis en a.ts").is_none());
    }

    #[test]
    fn relevo_contains_verifiable_context() {
        let from = db::Session {
            id: 3,
            project: "/r/p".into(),
            engine: "claude".into(),
            name: "xavi".into(),
            provider_session: String::new(),
            effort: None,
            worktree: Some("/w/xavi-3".into()),
            branch: Some("ide/xavi-3".into()),
            base: Some("main".into()),
            base_commit: Some("abc".into()),
            integrated: None,
            task: Some("Valida la política antes de encolar".into()),
            handoff_from: None,
            paused: Some("cuota agotada: usage limit".into()),
        };
        let text = relevo(&from, "claude code", " src/a.ts | 3 ++-\n", "1234567 test de la cola\n", "Falta el caso deshabilitado.");
        for part in ["«xavi» (claude code)", "Valida la política", "ide/xavi-3 (parte de main)", "src/a.ts | 3", "1234567 test", "Falta el caso", "cuota agotada", "git status"] {
            assert!(text.contains(part), "falta «{part}» en:\n{text}");
        }
    }
}
