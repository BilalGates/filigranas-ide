use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{err, CmdResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    id: String,
    message: String,
    code: String,
}

#[derive(Deserialize)]
pub struct Proof {
    id: String,
    typed: String,
}

struct Pending {
    id: String,
    intent: Value,
    code: String,
    since: Instant,
}

#[derive(Default)]
pub struct Approvals(Mutex<Option<Pending>>);

impl Approvals {
    pub fn prepare(&self, intent: impl Serialize, message: String, head: &str) -> CmdResult<Review> {
        let code = head.get(..12).filter(|v| v.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("el commit no es válido para una aprobación")?.to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let intent = serde_json::to_value(intent).map_err(err)?;
        *self.0.lock().map_err(err)? = Some(Pending { id: id.clone(), intent, code: code.clone(), since: Instant::now() });
        Ok(Review { id, message, code })
    }

    pub fn consume(&self, intent: impl Serialize, proof: &Proof) -> CmdResult<()> {
        let intent = serde_json::to_value(intent).map_err(err)?;
        let mut slot = self.0.lock().map_err(err)?;
        let entry = slot.as_ref().filter(|entry| entry.id == proof.id)
            .ok_or("revisa la operación antes de confirmarla")?;
        if entry.since.elapsed() > Duration::from_secs(300) || entry.intent != intent {
            *slot = None;
            return Err("la operación cambió o caducó. Revísala de nuevo".into());
        }
        if entry.code != proof.typed.trim() {
            return Err("escribe el SHA que se muestra en la revisión".into());
        }
        *slot = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_review_is_bound_to_the_intent_and_consumed_once() {
        let approvals = Approvals::default();
        let head = "123456789abc0000";
        let review = approvals.prepare(("publish","main",head), String::new(), head).unwrap();
        let mut proof = Proof { id: review.id, typed: String::new() };
        assert!(approvals.consume(("publish","main",head), &proof).is_err());
        proof.typed = review.code;
        assert!(approvals.consume(("merge","main",head), &proof).is_err());
        assert!(approvals.consume(("publish","main",head), &proof).is_err());
        let review = approvals.prepare(("publish","main",head), String::new(), head).unwrap();
        let proof = Proof { id: review.id, typed: review.code };
        assert!(approvals.consume(("publish","main",head), &proof).is_ok());
        assert!(approvals.consume(("publish","main",head), &proof).is_err());
    }
}

#[tauri::command]
pub fn cancel_review(state: tauri::State<crate::AppState>, id: String) -> CmdResult<()> {
    let mut slot = state.approvals.0.lock().map_err(err)?;
    if slot.as_ref().is_some_and(|entry| entry.id == id) {
        *slot = None;
    }
    Ok(())
}
