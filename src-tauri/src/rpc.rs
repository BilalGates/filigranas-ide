use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::{err, CmdResult};

// Transporte por líneas para Codex y los agentes ACP.
pub enum Incoming {
    Notification { method: String, params: Value },
    /// Petición del servidor (p. ej. una aprobación) que espera respuesta.
    Request { id: Value, method: String, params: Value },
    Closed,
}

pub struct Rpc {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    next: AtomicU64,
    alive: AtomicBool,
    /// Añadir `"jsonrpc": "2.0"` (ACP lo exige; Codex no lo usa).
    jsonrpc: bool,
}

const CLOSED: &str = "el proceso del proveedor se ha cerrado";

impl Rpc {
    /// Arranca el hilo lector. `on` recibe notificaciones y peticiones del
    /// servidor, y `Closed` cuando termina la salida.
    pub fn start(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
        on: impl FnMut(&Rpc, Incoming) + Send + 'static,
    ) -> Arc<Rpc> {
        Self::start_with(reader, writer, on, false)
    }

    /// Igual que `start`, pero con mensajes JSON-RPC 2.0 completos (ACP).
    pub fn start_with(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
        mut on: impl FnMut(&Rpc, Incoming) + Send + 'static,
        jsonrpc: bool,
    ) -> Arc<Rpc> {
        let rpc = Arc::new(Rpc {
            writer: Mutex::new(Some(Box::new(writer))),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            jsonrpc,
        });
        let r = rpc.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    r.dispatch(msg, &mut on);
                }
            }
            r.alive.store(false, Ordering::SeqCst);
            for (_, tx) in r.pending.lock().unwrap_or_else(|p| p.into_inner()).drain() {
                let _ = tx.send(Err(CLOSED.into()));
            }
            on(&r, Incoming::Closed);
        });
        rpc
    }

    fn dispatch(&self, mut msg: Value, on: &mut impl FnMut(&Rpc, Incoming)) {
        let params = msg.get_mut("params").map(Value::take).unwrap_or(Value::Null);
        match (msg.get("method").and_then(Value::as_str), msg.get("id")) {
            (Some(method), Some(id)) => on(self, Incoming::Request { id: id.clone(), method: method.into(), params }),
            (Some(method), None) => on(self, Incoming::Notification { method: method.into(), params }),
            (None, Some(id)) => {
                let Some(tx) = id.as_u64().and_then(|id| self.pending.lock().ok()?.remove(&id)) else { return };
                let res = match msg.get("error") {
                    Some(e) => Err(format!("{}{}", e.get("code").and_then(Value::as_i64).map(|code| format!("[{code}] ")).unwrap_or_default(), e.get("message").and_then(Value::as_str).unwrap_or("error del proveedor"))),
                    None => Ok(msg.get_mut("result").map(Value::take).unwrap_or(Value::Null)),
                };
                let _ = tx.send(res);
            }
            _ => {}
        }
    }

    /// Close stdin so ACP can save its conversation before the process exits.
    pub fn close_input(&self) {
        if let Ok(mut writer) = self.writer.lock() { writer.take(); }
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn send(&self, msg: &Value) -> CmdResult<()> {
        let mut msg = msg.clone();
        if self.jsonrpc {
            msg["jsonrpc"] = json!("2.0");
        }
        let mut line = serde_json::to_string(&msg).map_err(err)?;
        line.push('\n');
        let mut w = self.writer.lock().map_err(err)?;
        let w = w.as_mut().ok_or(CLOSED)?;
        w.write_all(line.as_bytes()).and_then(|_| w.flush()).map_err(|e| format!("{CLOSED}: {e}"))
    }

    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> CmdResult<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        self.pending.lock().map_err(err)?.insert(id, tx);
        // Comprobar después de registrar: si el lector ya terminó, nadie
        // contestaría y solo quedaría esperar al timeout.
        if !self.alive() {
            self.pending.lock().map_err(err)?.remove(&id);
            return Err(CLOSED.into());
        }
        if let Err(e) = self.send(&json!({ "id": id, "method": method, "params": params })) {
            self.pending.lock().map_err(err)?.remove(&id);
            return Err(e);
        }
        rx.recv_timeout(timeout).unwrap_or_else(|_| {
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&id);
            }
            Err(format!("el proveedor no respondió a {method}"))
        })
    }

    pub fn notify(&self, method: &str) -> CmdResult<()> {
        self.send(&json!({ "method": method }))
    }

    pub fn notify_with(&self, method: &str, params: Value) -> CmdResult<()> {
        self.send(&json!({ "method": method, "params": params }))
    }

    pub fn respond(&self, id: Value, result: Value) -> CmdResult<()> {
        self.send(&json!({ "id": id, "result": result }))
    }

    pub fn respond_error(&self, id: Value, message: &str) -> CmdResult<()> {
        self.send(&json!({ "id": id, "error": { "code": -32601, "message": message } }))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{pipe, PipeReader, PipeWriter};

    const SHORT: Duration = Duration::from_secs(30);

    /// Servidor falso: lee peticiones y las contesta con `reply`.
    pub(crate) fn fake(reply: impl Fn(&Value, &mut PipeWriter) + Send + 'static) -> (PipeReader, PipeWriter) {
        let (client_rx, mut server_tx) = pipe().unwrap();
        let (server_rx, client_tx) = pipe().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(server_rx).lines() {
                let msg: Value = serde_json::from_str(&line.unwrap()).unwrap();
                reply(&msg, &mut server_tx);
            }
        });
        (client_rx, client_tx)
    }

    pub(crate) fn write(w: &mut PipeWriter, v: Value) {
        writeln!(w, "{v}").unwrap();
    }

    #[test]
    fn requests_notifications_and_server_requests() {
        let (rx, tx) = fake(|msg, w| match msg["method"].as_str() {
            Some("lenta") => {
                // Responde después de la siguiente: el orden no importa.
                std::thread::sleep(Duration::from_millis(50));
                write(w, json!({ "id": msg["id"], "result": "lenta" }));
            }
            Some("rapida") => {
                write(w, json!({ "method": "aviso", "params": { "n": 1 } }));
                write(w, json!({ "id": 99, "method": "item/fileChange/requestApproval", "params": {} }));
                write(w, json!({ "id": msg["id"], "result": "rapida" }));
            }
            Some("falla") => write(w, json!({ "id": msg["id"], "error": { "code": 1, "message": "no" } })),
            // Respuesta a la aprobación: se devuelve como notificación para verla.
            None => write(w, json!({ "method": "respuesta", "params": msg })),
            _ => {}
        });
        let (seen_tx, seen_rx) = channel();
        let rpc = Rpc::start(rx, tx, move |rpc, msg| match msg {
            Incoming::Notification { method, params } => seen_tx.send(format!("{method} {params}")).unwrap(),
            Incoming::Request { id, method, .. } => {
                seen_tx.send(format!("pide {method}")).unwrap();
                rpc.respond(id, json!({ "decision": "decline" })).unwrap();
            }
            Incoming::Closed => {}
        });

        let slow = {
            let rpc = rpc.clone();
            std::thread::spawn(move || rpc.request("lenta", Value::Null, SHORT))
        };
        std::thread::sleep(Duration::from_millis(10));
        assert_eq!(rpc.request("rapida", Value::Null, SHORT).unwrap(), json!("rapida"));
        assert_eq!(slow.join().unwrap().unwrap(), json!("lenta"));
        assert_eq!(rpc.request("falla", Value::Null, SHORT).unwrap_err(), "[1] no");

        let seen: Vec<String> = (0..3).map(|_| seen_rx.recv_timeout(SHORT).unwrap()).collect();
        assert_eq!(seen[0], r#"aviso {"n":1}"#);
        assert_eq!(seen[1], "pide item/fileChange/requestApproval");
        assert_eq!(seen[2], r#"respuesta {"id":99,"result":{"decision":"decline"}}"#);
    }

    #[test]
    fn closing_fails_pending_and_new_requests() {
        let (client_rx, server_tx) = pipe().unwrap();
        let (_server_rx, client_tx) = pipe().unwrap(); // nadie contesta
        let (closed_tx, closed_rx) = channel();
        let rpc = Rpc::start(client_rx, client_tx, move |_, msg| {
            if matches!(msg, Incoming::Closed) {
                closed_tx.send(()).unwrap();
            }
        });
        assert_eq!(rpc.request("x", Value::Null, Duration::from_millis(30)).unwrap_err(), "el proveedor no respondió a x");
        let waiting = {
            let rpc = rpc.clone();
            std::thread::spawn(move || rpc.request("y", Value::Null, SHORT))
        };
        std::thread::sleep(Duration::from_millis(30));
        drop(server_tx); // el proceso termina
        assert_eq!(waiting.join().unwrap().unwrap_err(), CLOSED);
        closed_rx.recv_timeout(SHORT).unwrap();
        assert!(!rpc.alive());
        assert_eq!(rpc.request("z", Value::Null, SHORT).unwrap_err(), CLOSED);
    }

    #[test]
    fn timeout_discards_late_response_and_auth_errors_are_delivered() {
        let (rx, tx) = fake(|msg, w| {
            if msg["method"] == "slow" {
                std::thread::sleep(Duration::from_millis(40));
                write(w, json!({ "id": msg["id"], "result": "late" }));
            } else {
                write(w, json!({ "id": msg["id"], "error": { "code": 401, "message": "credentials expired" } }));
            }
        });
        let rpc = Rpc::start(rx, tx, |_, _| {});
        assert!(rpc.request("slow", Value::Null, Duration::from_millis(5)).unwrap_err().contains("no respondió"));
        assert!(rpc.pending.lock().unwrap().is_empty());
        assert_eq!(rpc.request("next", Value::Null, Duration::from_secs(1)).unwrap_err(), "[401] credentials expired");
        assert!(rpc.pending.lock().unwrap().is_empty());
    }
}
