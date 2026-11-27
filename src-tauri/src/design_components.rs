use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub selector: String,
    pub name: String,
    pub kind: String,
    pub radius: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// Read the rendered viewport in the same Chrome target used for the PNG.
// Text comes from accessibility labels or short control labels, never input values.
#[cfg(unix)]
const SNAPSHOT: &str = r#"(() => {
  const observed = document.querySelectorAll(
    '[data-component], [role], header, nav, main, aside, footer, section, article, form, dialog, button, a[href], input:not([type=hidden]), select, textarea, summary, h1, h2, h3, img, canvas, svg'
  );
  const identifier = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parent = el.parentElement;
    if (!parent || el === document.body) return el.localName;
    const peers = [...parent.children].filter(peer => peer.localName === el.localName);
    return identifier(parent) + ' > ' + el.localName + ':nth-of-type(' + (peers.indexOf(el) + 1) + ')';
  };
  const compact = (text, size = 120) => [...(text || '').replace(/\s+/g, ' ').trim()].slice(0, size).join('');
  const items = [];
  for (const el of observed) {
    if (items.length === 400) break;
    const box = el.getBoundingClientRect();
    const x = Math.max(0, box.left), y = Math.max(0, box.top);
    const width = Math.min(innerWidth, box.right) - x, height = Math.min(innerHeight, box.bottom) - y;
    if (width < 4 || height < 4) continue;
    const style = getComputedStyle(el);
    if (style.visibility !== 'visible' || el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false) continue;
    const kind = compact(el.getAttribute('role') || el.localName, 50);
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
    const name = compact(el.getAttribute('data-component') || el.getAttribute('aria-label') || labelled.trim() ||
      el.getAttribute('alt') || (el.labels ? [...el.labels].map(l => l.textContent).join(' ') : '') ||
      (el.matches('button, a, summary, h1, h2, h3') ? el.textContent : '') || el.id || kind);
    const selector = identifier(el);
    if (selector.length > 512) continue;
    items.push({selector, name, kind, radius: compact(style.borderRadius, 50), x, y, width, height});
  }
  return {url: location.href, items};
})()"#;

#[cfg(unix)]
pub(super) fn capture(
    binary: &std::path::Path,
    dir: &std::path::Path,
    url: &tauri::Url,
    width: u32,
    height: u32,
) -> crate::CmdResult<(Vec<u8>, Vec<Component>)> {
    use crate::{err, CmdResult};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::{json, Value};
    use std::{
        io::{BufRead, BufReader, Read, Write},
        os::{fd::{AsRawFd, FromRawFd, OwnedFd}, unix::{net::UnixStream, process::CommandExt}},
        process::{Child, Stdio},
        time::{Duration, Instant},
    };

    struct Target {
        child: Child,
        stream: BufReader<UnixStream>,
        deadline: Instant,
        id: u32,
    }
    impl Drop for Target {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
    impl Target {
        fn call(&mut self, method: &str, params: Value, session: Option<&str>) -> CmdResult<Value> {
            self.id += 1;
            let mut message = json!({"id":self.id,"method":method,"params":params});
            if let Some(session) = session {
                message["sessionId"] = json!(session);
            }
            let socket = self.stream.get_mut();
            socket.write_all(message.to_string().as_bytes()).map_err(err)?;
            socket.write_all(&[0]).map_err(err)?;
            loop {
                let remaining = self.deadline.checked_duration_since(Instant::now())
                    .ok_or("Chrome excedió el tiempo de captura")?;
                self.stream.get_ref().set_read_timeout(Some(remaining)).map_err(err)?;
                let mut response = Vec::new();
                self.stream.by_ref().take(6 * 1024 * 1024).read_until(0, &mut response).map_err(err)?;
                if response.pop() != Some(0) {
                    return Err("respuesta incompleta o demasiado grande de Chrome".into());
                }
                let value: Value = serde_json::from_slice(&response).map_err(err)?;
                if value["id"].as_u64() == Some(self.id.into()) {
                    return value.get("result").cloned().ok_or_else(|| format!("Chrome no completó {method}"));
                }
            }
        }
    }

    let (parent, child) = UnixStream::pair().map_err(err)?;
    parent.set_write_timeout(Some(Duration::from_secs(2))).map_err(err)?;
    // Keep the source away from Chrome's well-known pipe descriptors.
    let fd = unsafe { libc::fcntl(child.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 5) };
    if fd < 0 {
        return Err(err(std::io::Error::last_os_error()));
    }
    let pipe = unsafe { OwnedFd::from_raw_fd(fd) };
    drop(child);
    let mut command = crate::cli::command(binary);
    command.current_dir(dir).args([
        "--headless", "--no-first-run", "--disable-extensions", "--disable-sync",
        "--disable-background-networking", "--no-proxy-server", "--remote-debugging-pipe",
        "--user-data-dir=profile", "--force-device-scale-factor=1",
    ]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(pipe.as_raw_fd(), 3) < 0 || libc::dup2(pipe.as_raw_fd(), 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut target = Target { child: command.spawn().map_err(err)?, stream: BufReader::new(parent),
        deadline: Instant::now() + Duration::from_secs(18), id: 0 };
    drop(command);
    let tab = target.call("Target.createTarget", json!({"url":"about:blank"}), None)?;
    let attached = target.call("Target.attachToTarget", json!({"targetId":tab["targetId"], "flatten":true}), None)?;
    let session = Some(attached["sessionId"].as_str().ok_or("Chrome no abrió la página")?);
    target.call("Emulation.setDeviceMetricsOverride", json!({
        "width":width,"height":height,"deviceScaleFactor":1,"mobile":false
    }), session)?;
    let navigation = target.call("Page.navigate", json!({"url":url.as_str()}), session)?;
    if navigation.get("errorText").is_some() {
        return Err("Chrome no abrió la vista previa".into());
    }
    let expression = format!("(async () => {{ while(document.readyState !== 'complete') await new Promise(r => setTimeout(r, 50)); await document.fonts.ready; return {SNAPSHOT}; }})()");
    let mut snapshot = target.call("Runtime.evaluate", json!({
        "expression":expression,"returnByValue":true,"awaitPromise":true
    }), session)?;
    let mut value = snapshot.pointer_mut("/result/value").ok_or("Chrome no leyó los componentes")?.take();
    let observed = value["url"].as_str().and_then(|value| tauri::Url::parse(value).ok());
    if observed.as_ref().is_none_or(|value| value.origin() != url.origin()) {
        return Err("la vista previa salió del origen local".into());
    }
    let components = serde_json::from_value(value["items"].take()).map_err(err)?;
    let shot = target.call("Page.captureScreenshot", json!({"format":"png","fromSurface":true,
        "clip":{"x":0,"y":0,"width":width,"height":height,"scale":1}}), session)?;
    let bytes = STANDARD.decode(shot["data"].as_str().ok_or("Chrome no devolvió una captura")?).map_err(err)?;
    Ok((bytes, components))
}
