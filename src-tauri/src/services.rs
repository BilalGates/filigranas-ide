use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{db, err, workspace::project_path, AppState, CmdResult};

const LOG_LIMIT: usize = 64 * 1024;

#[derive(Clone, Deserialize, Serialize)]
pub struct Service {
    id: String,
    name: String,
    command: String,
    port: Option<u16>,
}

#[derive(Deserialize)]
pub struct ServiceForm {
    id: Option<String>,
    name: String,
    command: String,
    port: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    #[serde(flatten)]
    service: Service,
    state: &'static str,
    pid: Option<u32>,
    exit_code: Option<i32>,
    logs: Option<String>,
}

type Log = Arc<Mutex<VecDeque<u8>>>;
type ProcessRef = Arc<Mutex<Process>>;

struct Process {
    child: Option<Child>,
    state: &'static str,
    exit_code: Option<i32>,
    logs: Log,
}

impl Process {
    fn refresh(&mut self) -> CmdResult<()> {
        let Some(child) = &mut self.child else {
            return Ok(());
        };
        if let Some(status) = child.try_wait().map_err(err)? {
            #[cfg(unix)]
            kill_tree(child.id());
            self.exit_code = status.code();
            self.state = if status.success() { "exited" } else { "failed" };
            self.child = None;
        }
        Ok(())
    }

    fn stop(&mut self) -> CmdResult<()> {
        let Some(child) = &mut self.child else {
            return Ok(());
        };
        kill_tree(child.id());
        if let Err(e) = child.kill() {
            if child.try_wait().map_err(err)?.is_none() {
                return Err(err(e));
            }
        }
        self.exit_code = child.wait().map_err(err)?.code();
        self.child = None;
        self.state = "stopped";
        Ok(())
    }
}

fn kill_tree(id: u32) {
    #[cfg(unix)]
    let _ = Command::new("/bin/kill")
        .args(["-KILL", "--", &format!("-{id}")])
        .stderr(Stdio::null())
        .status();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &id.to_string()])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn collect(mut reader: impl Read + Send + 'static, log: Log) {
    thread::spawn(move || {
        let mut bytes = [0; 4096];
        while let Ok(count @ 1..) = reader.read(&mut bytes) {
            let Ok(mut log) = log.lock() else { break };
            let discard = (log.len() + count).saturating_sub(LOG_LIMIT);
            log.drain(..discard);
            log.extend(&bytes[..count]);
        }
    });
}

fn start(project: &str, service: &Service) -> CmdResult<ProcessRef> {
    #[cfg(unix)]
    let mut command = {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new("/bin/sh");
        command.args(["-c", &service.command]).process_group(0);
        command
    };
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C"])
            .raw_arg(format!("\"{}\"", service.command))
            .creation_flags(0x0800_0000);
        command
    };
    if let Some(path) = crate::cli::login_path() {
        command.env("PATH", path);
    }
    if let Some(port) = service.port {
        command.env("PORT", port.to_string());
    }
    let mut child = command
        .current_dir(project)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(err)?;
    let logs = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(stdout) = child.stdout.take() {
        collect(stdout, logs.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        collect(stderr, logs.clone());
    }
    let process = Arc::new(Mutex::new(Process {
        child: Some(child),
        state: "running",
        exit_code: None,
        logs,
    }));
    let observer = process.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));
        let Ok(mut process) = observer.lock() else { break };
        if process.refresh().is_err() || process.child.is_none() {
            break;
        }
    });
    Ok(process)
}

#[derive(Default)]
pub struct ServiceProcesses {
    projects: Mutex<HashMap<String, HashMap<String, ProcessRef>>>,
}

impl ServiceProcesses {
    pub fn shutdown(&self) {
        if let Ok(projects) = self.projects.lock() {
            for process in projects.values().flat_map(HashMap::values) {
                if let Ok(mut process) = process.lock() {
                    let _ = process.stop();
                }
            }
        }
    }
}

fn setting(project: &str) -> String {
    format!("local-services:{project}")
}

fn read(conn: &rusqlite::Connection, project: &str) -> CmdResult<Vec<Service>> {
    match db::get_setting(conn, &setting(project)).map_err(err)? {
        Some(value) => serde_json::from_str(&value).map_err(err),
        None => Ok(Vec::new()),
    }
}

fn write(conn: &rusqlite::Connection, project: &str, services: &[Service]) -> CmdResult<()> {
    db::set_setting(conn, &setting(project), &serde_json::to_string(services).map_err(err)?)
        .map_err(err)
}

#[tauri::command]
pub fn services_list(state: State<AppState>, project: String, logs_for: Option<String>) -> CmdResult<Vec<ServiceView>> {
    let (project, services) = {
        let conn = state.db.lock().map_err(err)?;
        let project = project_path(&conn, &project)?;
        let services = read(&conn, &project)?;
        (project, services)
    };
    let registry = state.services.projects.lock().map_err(err)?;
    let processes = registry.get(&project);
    services.into_iter().map(|service| {
        let show_logs = logs_for.as_deref() == Some(&service.id);
        let mut view = ServiceView { service, state: "stopped", pid: None, exit_code: None, logs: None };
        if let Some(process) = processes.and_then(|p| p.get(&view.service.id)) {
            let process = process.lock().map_err(err)?;
            view.state = process.state;
            view.pid = process.child.as_ref().map(Child::id);
            view.exit_code = process.exit_code;
            if show_logs {
                let mut logs = process.logs.lock().map_err(err)?;
                view.logs = Some(String::from_utf8_lossy(logs.make_contiguous()).into_owned());
            }
        }
        Ok(view)
    }).collect()
}

#[tauri::command]
pub fn service_save(state: State<AppState>, project: String, form: ServiceForm) -> CmdResult<String> {
    let conn = state.db.lock().map_err(err)?;
    let project = project_path(&conn, &project)?;
    let mut services = read(&conn, &project)?;
    let name = form.name.trim();
    let command = form.command.trim();
    if name.is_empty() || name.len() > 120 || command.is_empty() || command.len() > 8192 || form.port == Some(0) {
        return Err("Comprueba el nombre, el comando y el puerto.".into());
    }
    if services.iter().any(|s| Some(&s.id) != form.id.as_ref() && s.name.to_lowercase() == name.to_lowercase()) {
        return Err("Ya existe un servicio con ese nombre.".into());
    }
    let registry = state.services.projects.lock().map_err(err)?;
    let id = form.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let service = Service { id: id.clone(), name: name.into(), command: command.into(), port: form.port };
    if form.id.is_some() {
        let existing = services.iter_mut().find(|s| s.id == id).ok_or("Servicio desconocido")?;
        require_stopped(registry.get(&project), &id)?;
        *existing = service;
    } else {
        services.push(service);
    }
    write(&conn, &project, &services)?;
    Ok(id)
}

fn require_stopped(processes: Option<&HashMap<String, ProcessRef>>, id: &str) -> CmdResult<()> {
    if let Some(process) = processes.and_then(|p| p.get(id)) {
        let mut process = process.lock().map_err(err)?;
        process.refresh()?;
        if process.child.is_some() {
            return Err("Detén el servicio primero.".into());
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceAction { Start, Stop, Restart, Remove }

#[tauri::command]
pub fn service_action(state: State<AppState>, project: String, id: String, action: ServiceAction) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    let project = project_path(&conn, &project)?;
    let mut services = read(&conn, &project)?;
    let index = services.iter().position(|s| s.id == id).ok_or("Servicio desconocido")?;
    let mut registry = state.services.projects.lock().map_err(err)?;
    let processes = registry.entry(project.clone()).or_default();
    if matches!(action, ServiceAction::Remove) {
        require_stopped(Some(processes), &id)?;
        services.remove(index);
        write(&conn, &project, &services)?;
        processes.remove(&id);
        return Ok(());
    }
    if let Some(process) = processes.get(&id) {
        let mut process = process.lock().map_err(err)?;
        process.refresh()?;
        match action {
            ServiceAction::Start if process.child.is_some() => return Ok(()),
            ServiceAction::Stop | ServiceAction::Restart => process.stop()?,
            _ => {}
        }
    }
    if matches!(action, ServiceAction::Start | ServiceAction::Restart) {
        processes.insert(id, start(&project, &services[index])?);
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn service_captures_output_and_stops() {
        let dir = std::env::temp_dir();
        let service = Service {
            id: "test".into(),
            name: "test".into(),
            command: "printf 'service:%s\\n' \"$PORT\"; sleep 30".into(),
            port: Some(4321),
        };
        let process = start(dir.to_str().unwrap(), &service).unwrap();
        let logs = process.lock().unwrap().logs.clone();
        let mut output = String::new();
        for _ in 0..100 {
            output = String::from_utf8_lossy(logs.lock().unwrap().make_contiguous()).into_owned();
            if output.contains("service:4321") { break; }
            thread::sleep(Duration::from_millis(10));
        }
        let mut process = process.lock().unwrap();
        process.stop().unwrap();
        assert!(output.contains("service:4321"));
        assert!(process.child.is_none());
        assert_eq!(process.state, "stopped");
    }
}
