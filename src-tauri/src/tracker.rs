use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

// Estado observable de cada sesión de agente, alimentado por los
// adaptadores (Claude Code y ACP). Lo usa el coordinador para seguir las
// tareas que delega y esperar sus resultados.

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Track {
    pub running: bool,
    /// Turnos terminados desde que se creó la sesión.
    pub turns: u32,
    /// Última respuesta completa del agente.
    pub last: String,
    /// Texto del turno en curso (ACP lo envía por fragmentos).
    current: String,
    /// El proceso terminó sin cerrar el turno.
    pub exited: bool,
}

#[derive(Default)]
pub struct Tracker {
    inner: Mutex<HashMap<i64, Track>>,
    changed: Condvar,
}

impl Tracker {
    fn update(&self, id: i64, f: impl FnOnce(&mut Track)) {
        if let Ok(mut map) = self.inner.lock() {
            f(map.entry(id).or_default());
            self.changed.notify_all();
        }
    }

    pub fn started(&self, id: i64) {
        self.update(id, |t| {
            if !t.running {
                t.running = true;
                t.exited = false;
                t.current.clear();
            }
        });
    }

    pub fn chunk(&self, id: i64, text: &str) {
        self.update(id, |t| t.current.push_str(text));
    }

    /// Fin de turno. Sin texto final se usa lo acumulado por fragmentos.
    pub fn finished(&self, id: i64, text: Option<&str>) {
        self.update(id, |t| {
            if !t.running {
                return;
            }
            t.running = false;
            t.turns += 1;
            let text = text.map(str::to_string).unwrap_or_else(|| std::mem::take(&mut t.current));
            if !text.trim().is_empty() {
                t.last = text;
            }
        });
    }

    pub fn exited(&self, id: i64) {
        self.update(id, |t| {
            if t.running {
                t.running = false;
                t.exited = true;
            }
        });
    }

    pub fn get(&self, id: i64) -> Track {
        self.inner.lock().map(|m| m.get(&id).cloned().unwrap_or_default()).unwrap_or_default()
    }

    /// Espera a que la sesión no esté en marcha, como mucho `timeout`.
    pub fn wait_idle(&self, id: i64, timeout: Duration) -> Track {
        let deadline = Instant::now() + timeout;
        let Ok(mut map) = self.inner.lock() else { return Track::default() };
        loop {
            let track = map.get(&id).cloned().unwrap_or_default();
            let left = deadline.saturating_duration_since(Instant::now());
            if !track.running || left.is_zero() {
                return track;
            }
            map = match self.changed.wait_timeout(map, left) {
                Ok((m, _)) => m,
                Err(_) => return track,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn turn_lifecycle_and_waiting() {
        let t = Arc::new(Tracker::default());
        t.started(1);
        t.chunk(1, "ho");
        t.chunk(1, "la");
        assert!(t.get(1).running);
        // Sin terminar: la espera vence el plazo y devuelve «en marcha».
        assert!(t.wait_idle(1, Duration::from_millis(20)).running);

        let waiter = {
            let t = t.clone();
            std::thread::spawn(move || t.wait_idle(1, Duration::from_secs(5)))
        };
        std::thread::sleep(Duration::from_millis(20));
        t.finished(1, None);
        let done = waiter.join().unwrap();
        assert_eq!((done.running, done.turns, done.last.as_str()), (false, 1, "hola"));

        t.started(1);
        t.finished(1, Some("final"));
        t.finished(1, Some("repetido")); // un segundo fin no cuenta
        assert_eq!((t.get(1).turns, t.get(1).last.as_str()), (2, "final"));

        t.started(2);
        t.exited(2);
        assert!(t.get(2).exited && !t.get(2).running);
    }
}
