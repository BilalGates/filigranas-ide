use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::cli::{login_path, program};
use crate::{db, err, workspace::project_path, AppState, CmdResult};

// Contenedores Docker del proyecto (PLAN.md §2), solo lectura con la CLI
// del usuario: nunca arranca el daemon ni instala nada. Los servicios de
// Compose se asocian por las rutas canónicas de su carpeta de trabajo o de
// sus archivos; un contenedor suelto solo por asociación manual explícita.
// No se leen ni muestran variables de entorno ni logs.

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    /// running, exited, paused, restarting…
    pub state: String,
    pub health: Option<String>,
    pub ports: Vec<String>,
    /// Servicio de Compose, si lo es.
    pub service: Option<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// ok, absent (sin Docker), stopped (daemon parado), denied, error.
    pub status: String,
    pub message: Option<String>,
    pub compose: Vec<Container>,
    /// Sueltos asociados a mano a este proyecto.
    pub linked: Vec<Container>,
    /// Sueltos sin asociar a ningún proyecto (se pueden asociar aquí).
    pub unlinked: Vec<Container>,
}

#[derive(Debug, PartialEq)]
enum Belongs {
    Compose,
    Linked,
    Unlinked,
    Elsewhere,
}

fn canonical(p: &Path) -> PathBuf {
    crate::paths::canonical(p).unwrap_or_else(|_| p.to_path_buf())
}

/// A qué corresponde un contenedor respecto al proyecto `project` (ruta
/// canónica). `link`: proyecto al que se asoció a mano, si alguno.
fn belongs(c: &Value, project: &Path, link: Option<&str>) -> Belongs {
    let labels = &c["Config"]["Labels"];
    let inside = |raw: &str| !raw.is_empty() && canonical(Path::new(raw)).starts_with(project);
    let working = labels["com.docker.compose.project.working_dir"].as_str();
    let files = labels["com.docker.compose.project.config_files"].as_str();
    if working.is_some() || files.is_some() {
        let mine = working.is_some_and(inside) || files.is_some_and(|f| f.split(',').any(|p| inside(p.trim())));
        return if mine { Belongs::Compose } else { Belongs::Elsewhere };
    }
    match link {
        Some(p) if canonical(Path::new(p)) == project => Belongs::Linked,
        Some(_) => Belongs::Elsewhere,
        None => Belongs::Unlinked,
    }
}

/// Puertos publicados: `127.0.0.1:5433→5432/tcp`. Los solo expuestos no salen.
fn ports(c: &Value) -> Vec<String> {
    let mut out: Vec<String> = c["NetworkSettings"]["Ports"]
        .as_object()
        .into_iter()
        .flatten()
        .flat_map(|(inner, binds)| {
            binds.as_array().into_iter().flatten().map(move |b| {
                let ip = b["HostIp"].as_str().unwrap_or("");
                let host = b["HostPort"].as_str().unwrap_or("");
                format!("{}{host}→{inner}", if ip.is_empty() || ip == "0.0.0.0" || ip == "::" { String::new() } else { format!("{ip}:") })
            })
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

fn container(c: &Value) -> Container {
    let labels = &c["Config"]["Labels"];
    Container {
        id: c["Id"].as_str().unwrap_or("").chars().take(12).collect(),
        name: c["Name"].as_str().unwrap_or("").trim_start_matches('/').to_string(),
        image: c["Config"]["Image"].as_str().unwrap_or("").to_string(),
        state: c["State"]["Status"].as_str().unwrap_or("").to_string(),
        health: c["State"]["Health"]["Status"].as_str().map(str::to_string),
        ports: ports(c),
        service: labels["com.docker.compose.service"].as_str().map(str::to_string),
    }
}

/// Clasifica la salida de `docker inspect` para un proyecto.
fn classify(inspect: &[Value], project: &Path, links: &HashMap<String, String>) -> View {
    let mut view = View { status: "ok".into(), ..Default::default() };
    for c in inspect {
        let item = container(c);
        match belongs(c, project, links.get(&item.id).map(String::as_str)) {
            Belongs::Compose => view.compose.push(item),
            Belongs::Linked => view.linked.push(item),
            Belongs::Unlinked => view.unlinked.push(item),
            Belongs::Elsewhere => {}
        }
    }
    let order = |a: &Container, b: &Container| (a.state != "running").cmp(&(b.state != "running")).then(a.name.cmp(&b.name));
    view.compose.sort_by(order);
    view.linked.sort_by(order);
    view.unlinked.sort_by(order);
    view
}

/// Error de la CLI de Docker traducido a un estado de la vista.
fn failure(stderr: &str) -> (String, String) {
    let lower = stderr.to_lowercase();
    if lower.contains("cannot connect to the docker daemon") || lower.contains("is the docker daemon running") || lower.contains("docker desktop is not running") {
        ("stopped".into(), "El daemon de Docker no está en marcha. Arráncalo (Docker Desktop u otro) y actualiza.".into())
    } else if lower.contains("permission denied") {
        ("denied".into(), "Sin permiso para hablar con Docker. Revisa el acceso al socket de Docker.".into())
    } else {
        ("error".into(), stderr.trim().lines().next().unwrap_or("error de Docker").to_string())
    }
}

fn docker(args: &[&str]) -> Result<Vec<u8>, (String, String)> {
    let mut cmd = Command::new(program("docker"));
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|_| ("absent".to_string(), "Docker no está instalado o no está en el PATH. El resto del IDE funciona igual.".to_string()))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(failure(&String::from_utf8_lossy(&out.stderr)))
    }
}

fn list(project: &Path, links: &HashMap<String, String>) -> View {
    let fail = |(status, message): (String, String)| View { status, message: Some(message), ..Default::default() };
    let ids = match docker(&["ps", "-a", "-q", "--no-trunc"]) {
        Ok(out) => String::from_utf8_lossy(&out).split_whitespace().map(str::to_string).collect::<Vec<_>>(),
        Err(e) => return fail(e),
    };
    if ids.is_empty() {
        return View { status: "ok".into(), ..Default::default() };
    }
    let mut args = vec!["inspect"];
    args.extend(ids.iter().map(String::as_str));
    match docker(&args) {
        Ok(out) => match serde_json::from_slice::<Vec<Value>>(&out) {
            Ok(inspect) => classify(&inspect, project, links),
            Err(e) => fail(("error".into(), format!("salida de docker inspect no válida: {e}"))),
        },
        Err(e) => fail(e),
    }
}

// ── comandos ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn containers_list(app: AppHandle, project: String) -> CmdResult<View> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(err)?;
        let path = project_path(&conn, &project)?;
        let links = db::container_links(&conn).map_err(err)?;
        drop(conn);
        Ok(list(&canonical(Path::new(&path)), &links))
    })
    .await
    .map_err(err)?
}

/// Asocia un contenedor suelto al proyecto (decisión explícita del usuario).
#[tauri::command]
pub fn container_link(state: State<AppState>, project: String, id: String, name: String) -> CmdResult<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("id de contenedor no válido".into());
    }
    let conn = state.db.lock().map_err(err)?;
    let path = project_path(&conn, &project)?;
    db::link_container(&conn, &id, &path, &name).map_err(err)
}

#[tauri::command]
pub fn container_unlink(state: State<AppState>, id: String) -> CmdResult<()> {
    db::unlink_container(&*state.db.lock().map_err(err)?, &id).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inspect() -> Vec<Value> {
        let root = canonical(&std::env::temp_dir());
        let p = |s: &str| root.join(s).to_string_lossy().into_owned();
        vec![
            json!({ "Id": "aaaaaaaaaaaa1111", "Name": "/bitacola-db-1", "Config": { "Image": "pgvector/pgvector:pg16", "Env": ["POSTGRES_PASSWORD=secreto"], "Labels": {
                "com.docker.compose.project.working_dir": p("Bitacola"), "com.docker.compose.service": "db" } },
                "State": { "Status": "running", "Health": { "Status": "healthy" } },
                "NetworkSettings": { "Ports": { "5432/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "5433" }], "9000/tcp": null } } }),
            // Nombre parecido, otro proyecto: no se mezcla.
            json!({ "Id": "bbbbbbbbbbbb2222", "Name": "/bitacola2-db-1", "Config": { "Image": "postgres", "Labels": {
                "com.docker.compose.project.working_dir": p("Bitacola2"), "com.docker.compose.service": "db" } },
                "State": { "Status": "exited" }, "NetworkSettings": { "Ports": {} } }),
            // Solo los archivos de Compose dentro del proyecto.
            json!({ "Id": "cccccccccccc3333", "Name": "/redis", "Config": { "Image": "redis", "Labels": {
                "com.docker.compose.project.config_files": format!("{},{}", p("otro/compose.yml"), p("Bitacola/infra/compose.yml")) } },
                "State": { "Status": "exited" }, "NetworkSettings": { "Ports": { "6379/tcp": [{ "HostIp": "0.0.0.0", "HostPort": "6379" }, { "HostIp": "::", "HostPort": "6379" }] } } }),
            json!({ "Id": "dddddddddddd4444", "Name": "/vantia-local", "Config": { "Image": "postgis", "Labels": {} }, "State": { "Status": "exited" }, "NetworkSettings": { "Ports": {} } }),
            json!({ "Id": "eeeeeeeeeeee5555", "Name": "/suelto", "Config": { "Image": "nginx", "Labels": null }, "State": { "Status": "running" }, "NetworkSettings": { "Ports": {} } }),
        ]
    }

    #[test]
    fn classifies_by_compose_paths_and_manual_links() {
        let root = std::env::temp_dir();
        let project = canonical(&root).join("Bitacola");
        let mut links = HashMap::new();
        links.insert("dddddddddddd".to_string(), project.to_string_lossy().into_owned());
        let view = classify(&inspect(), &project, &links);
        let names = |l: &[Container]| l.iter().map(|c| c.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&view.compose), ["bitacola-db-1", "redis"]);
        assert_eq!(names(&view.linked), ["vantia-local"]);
        assert_eq!(names(&view.unlinked), ["suelto"]);
        let db = &view.compose[0];
        assert_eq!((db.health.as_deref(), db.service.as_deref(), db.ports.clone()), (Some("healthy"), Some("db"), vec!["127.0.0.1:5433→5432/tcp".to_string()]));
        assert_eq!(view.compose[1].ports, ["6379→6379/tcp"]);
        // Nada de variables de entorno en lo que se envía a la interfaz.
        assert!(!serde_json::to_string(&view).unwrap().contains("secreto"));

        // Asociado a otro proyecto: no aparece aquí ni como suelto.
        links.insert("eeeeeeeeeeee".to_string(), "/otro".into());
        let view = classify(&inspect(), &project, &links);
        assert!(view.unlinked.is_empty());
    }

    #[test]
    fn docker_failures_are_told_apart() {
        assert_eq!(failure("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?").0, "stopped");
        assert_eq!(failure("permission denied while trying to connect to the Docker daemon socket").0, "denied");
        assert_eq!(failure("algo raro").0, "error");
    }

    /// Contra el Docker local: `cargo test -- --ignored real_containers --nocapture`.
    #[test]
    #[ignore]
    fn real_containers() {
        let project = canonical(Path::new(&format!("{}/repositorios/Bitacola", std::env::var("HOME").unwrap())));
        let view = list(&project, &HashMap::new());
        println!("{} · compose {:?} · sueltos sin asociar {}", view.status, view.compose.iter().map(|c| format!("{} {} {:?} {:?}", c.name, c.state, c.health, c.ports)).collect::<Vec<_>>(), view.unlinked.len());
        assert_eq!(view.status, "ok");
    }
}
