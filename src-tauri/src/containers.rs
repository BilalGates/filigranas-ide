use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::cli::{login_path, program};
use crate::{db, err, workspace::project_path, AppState, CmdResult};

// Contenedores Docker del proyecto usando la CLI real del usuario: nunca
// instala nada ni arranca el daemon por su cuenta. Los servicios de Compose
// se asocian por las rutas canónicas de su carpeta de trabajo o de sus
// archivos; un contenedor suelto solo por asociación manual explícita.
// No se exponen variables de entorno ni secretos en las respuestas.

const MAX_IMAGES: usize = 40;
const MAX_LOG_BYTES: usize = 64 * 1024;
const COMPOSE_CANDIDATES: &[&str] = &[
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
    "infra/compose.yaml",
    "infra/compose.yml",
    "docker/compose.yaml",
    "docker/compose.yml",
];

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

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created_since: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStats {
    pub cpu_percent: String,
    pub mem_usage: String,
    pub mem_percent: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// ok, absent (sin Docker), stopped (daemon parado), denied, error.
    pub status: String,
    pub message: Option<String>,
    /// Versión detectada del motor Docker (y Compose si está disponible).
    pub engine: Option<String>,
    /// Archivos de Compose detectados dentro del proyecto activo.
    pub compose_files: Vec<String>,
    pub compose: Vec<Container>,
    /// Sueltos asociados a mano a este proyecto.
    pub linked: Vec<Container>,
    /// Sueltos sin asociar a ningún proyecto (se pueden asociar aquí).
    pub unlinked: Vec<Container>,
    /// Imágenes locales disponibles en el motor.
    pub images: Vec<DockerImage>,
    /// Consumo puntual (CPU/RAM) de los contenedores en marcha del proyecto.
    pub stats: HashMap<String, ContainerStats>,
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

fn valid_id(id: &str) -> bool {
    (12..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit())
}

fn short_id(raw: &str) -> String {
    raw.trim().chars().take(12).collect()
}

fn detect_compose_files(project: &Path) -> Vec<String> {
    COMPOSE_CANDIDATES
        .iter()
        .filter(|rel| project.join(rel).is_file())
        .map(|rel| (*rel).to_string())
        .collect()
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
        id: short_id(c["Id"].as_str().unwrap_or("")),
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
    let mut view = View {
        status: "ok".into(),
        compose_files: detect_compose_files(project),
        ..Default::default()
    };
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

fn parse_images(raw: &[u8]) -> Vec<DockerImage> {
    let mut seen = HashMap::<String, ()>::new();
    let mut out = Vec::new();
    for line in String::from_utf8_lossy(raw).lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let repo = v["Repository"].as_str().unwrap_or("").trim().to_string();
        let tag = v["Tag"].as_str().unwrap_or("").trim().to_string();
        let id = short_id(v["ID"].as_str().unwrap_or(""));
        if repo.is_empty() && id.is_empty() {
            continue;
        }
        let key = format!("{repo}:{tag}:{id}");
        if seen.insert(key, ()).is_some() {
            continue;
        }
        out.push(DockerImage {
            id,
            repository: if repo.is_empty() { "<none>".into() } else { repo },
            tag: if tag.is_empty() { "<none>".into() } else { tag },
            size: v["Size"].as_str().unwrap_or("").trim().to_string(),
            created_since: v["CreatedSince"].as_str().unwrap_or("").trim().to_string(),
        });
        if out.len() >= MAX_IMAGES {
            break;
        }
    }
    out.sort_by(|a, b| a.repository.cmp(&b.repository).then(a.tag.cmp(&b.tag)));
    out
}

fn parse_stats(raw: &[u8]) -> HashMap<String, ContainerStats> {
    let mut out = HashMap::new();
    for line in String::from_utf8_lossy(raw).lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let id = short_id(v["ID"].as_str().unwrap_or(""));
        if id.is_empty() {
            continue;
        }
        out.insert(
            id,
            ContainerStats {
                cpu_percent: v["CPUPerc"].as_str().unwrap_or("").trim().to_string(),
                mem_usage: v["MemUsage"].as_str().unwrap_or("").trim().to_string(),
                mem_percent: v["MemPerc"].as_str().unwrap_or("").trim().to_string(),
            },
        );
    }
    out
}

fn truncate_tail_utf8(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut start = text.len() - max_bytes;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    if let Some(nl) = text[start..].find('\n') {
        start += nl + 1;
    }
    format!("… (salida recortada a los últimos 64 KiB)\n{}", &text[start..])
}

/// Error de la CLI de Docker traducido a un estado de la vista.
fn failure(stderr: &str) -> (String, String) {
    let lower = stderr.to_lowercase();
    if lower.contains("cannot connect to the docker daemon") || lower.contains("is the docker daemon running") || lower.contains("docker desktop is not running") {
        ("stopped".into(), "El daemon de Docker no está en marcha. Arráncalo (Docker Desktop, OrbStack o Colima) y actualiza.".into())
    } else if lower.contains("permission denied") {
        ("denied".into(), "Sin permiso para hablar con Docker. Revisa el acceso al socket de Docker.".into())
    } else {
        ("error".into(), stderr.trim().lines().next().unwrap_or("error de Docker").to_string())
    }
}

fn run_docker_raw(args: &[&str]) -> Result<std::process::Output, (String, String)> {
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
    cmd.output().map_err(|_| {
        (
            "absent".to_string(),
            "Docker no está instalado o no está en el PATH. Puedes seguir usando Servicios locales y el resto del IDE con normalidad.".to_string(),
        )
    })
}

fn docker(args: &[&str]) -> Result<Vec<u8>, (String, String)> {
    let out = run_docker_raw(args)?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(failure(&String::from_utf8_lossy(&out.stderr)))
    }
}

fn detect_engine() -> Option<String> {
    let server = docker(&["version", "--format", "{{.Server.Version}}"])
        .ok()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| !s.is_empty());
    let compose = docker(&["compose", "version", "--short"])
        .ok()
        .map(|b| String::from_utf8_lossy(&b).trim().trim_start_matches('v').to_string())
        .filter(|s| !s.is_empty());
    match (server, compose) {
        (Some(s), Some(c)) => Some(format!("Docker {s} · Compose {c}")),
        (Some(s), None) => Some(format!("Docker {s}")),
        _ => None,
    }
}

fn list(project: &Path, links: &HashMap<String, String>) -> View {
    let compose_files = detect_compose_files(project);
    let fail = |(status, message): (String, String)| View {
        status,
        message: Some(message),
        compose_files: compose_files.clone(),
        ..Default::default()
    };

    let ids = match docker(&["ps", "-a", "-q", "--no-trunc"]) {
        Ok(out) => String::from_utf8_lossy(&out).split_whitespace().map(str::to_string).collect::<Vec<_>>(),
        Err(e) => return fail(e),
    };

    let mut view = if ids.is_empty() {
        View { status: "ok".into(), compose_files, ..Default::default() }
    } else {
        let mut args = vec!["inspect"];
        args.extend(ids.iter().map(String::as_str));
        match docker(&args) {
            Ok(out) => match serde_json::from_slice::<Vec<Value>>(&out) {
                Ok(inspect) => classify(&inspect, project, links),
                Err(e) => return fail(("error".into(), format!("salida de docker inspect no válida: {e}"))),
            },
            Err(e) => return fail(e),
        }
    };

    view.engine = detect_engine();

    if let Ok(out) = docker(&["images", "--format", "{{json .}}"]) {
        view.images = parse_images(&out);
    }

    let running_ids: Vec<String> = view
        .compose
        .iter()
        .chain(view.linked.iter())
        .filter(|c| c.state == "running")
        .map(|c| c.id.clone())
        .collect();
    if !running_ids.is_empty() {
        let mut args = vec!["stats", "--no-stream", "--format", "{{json .}}"];
        args.extend(running_ids.iter().map(String::as_str));
        if let Ok(out) = docker(&args) {
            view.stats = parse_stats(&out);
        }
    }

    view
}

/// Comprueba que el contenedor pertenece al proyecto (Compose o vinculado manualmente).
fn ensure_project_owns(id: &str, project: &Path, links: &HashMap<String, String>) -> CmdResult<()> {
    let out = docker(&["inspect", id]).map_err(|(_, msg)| msg)?;
    let list: Vec<Value> = serde_json::from_slice(&out).map_err(|e| format!("respuesta de Docker no válida: {e}"))?;
    let Some(first) = list.first() else {
        return Err("No se encontró el contenedor en Docker.".into());
    };
    let short = short_id(first["Id"].as_str().unwrap_or(id));
    match belongs(first, project, links.get(&short).map(String::as_str)) {
        Belongs::Compose | Belongs::Linked => Ok(()),
        Belongs::Unlinked | Belongs::Elsewhere => {
            Err("Ese contenedor no pertenece al proyecto activo. Vincúlalo primero para gestionarlo desde aquí.".into())
        }
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
    if !valid_id(&id) {
        return Err("id de contenedor no válido".into());
    }
    let conn = state.db.lock().map_err(err)?;
    let path = project_path(&conn, &project)?;
    db::link_container(&conn, &short_id(&id), &path, &name).map_err(err)
}

#[tauri::command]
pub fn container_unlink(state: State<AppState>, id: String) -> CmdResult<()> {
    if !valid_id(&id) {
        return Err("id de contenedor no válido".into());
    }
    db::unlink_container(&*state.db.lock().map_err(err)?, &short_id(&id)).map_err(err)
}

/// Arranca, detiene o reinicia un contenedor perteneciente al proyecto activo.
#[tauri::command]
pub async fn container_action(app: AppHandle, project: String, id: String, action: String) -> CmdResult<()> {
    if !valid_id(&id) {
        return Err("id de contenedor no válido".into());
    }
    let verb = match action.as_str() {
        "start" => "start",
        "stop" => "stop",
        "restart" => "restart",
        _ => return Err("acción de contenedor no permitida".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(err)?;
        let path = project_path(&conn, &project)?;
        let links = db::container_links(&conn).map_err(err)?;
        drop(conn);
        let project_canon = canonical(Path::new(&path));
        ensure_project_owns(&id, &project_canon, &links)?;
        docker(&[verb, &id]).map_err(|(_, msg)| msg)?;
        Ok(())
    })
    .await
    .map_err(err)?
}

/// Lee las últimas líneas de registro de un contenedor del proyecto activo.
#[tauri::command]
pub async fn container_logs(app: AppHandle, project: String, id: String, tail: Option<u32>) -> CmdResult<String> {
    if !valid_id(&id) {
        return Err("id de contenedor no válido".into());
    }
    let lines = tail.unwrap_or(150).clamp(1, 400).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(err)?;
        let path = project_path(&conn, &project)?;
        let links = db::container_links(&conn).map_err(err)?;
        drop(conn);
        let project_canon = canonical(Path::new(&path));
        ensure_project_owns(&id, &project_canon, &links)?;
        let out = run_docker_raw(&["logs", "--tail", &lines, "--timestamps", &id]).map_err(|(_, msg)| msg)?;
        if !out.status.success() {
            let (_, msg) = failure(&String::from_utf8_lossy(&out.stderr));
            return Err(msg);
        }
        let mut combined = String::new();
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !stdout.is_empty() {
            combined.push_str(&stdout);
        }
        if !stderr.is_empty() {
            if !combined.is_empty() && !combined.ends_with('\n') {
                combined.push('\n');
            }
            combined.push_str(&stderr);
        }
        Ok(truncate_tail_utf8(&combined, MAX_LOG_BYTES))
    })
    .await
    .map_err(err)?
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

    #[test]
    fn validates_container_ids_strictly() {
        assert!(valid_id("aaaaaaaaaaaa"));
        assert!(valid_id("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
        assert!(!valid_id(""));
        assert!(!valid_id("abc"));
        assert!(!valid_id("aaaaaaaaaaa;rm"));
        assert!(!valid_id("--all-containers"));
    }

    #[test]
    fn parses_images_and_stats_ndjson() {
        let imgs = parse_images(
            br#"{"ID":"1111222233334444","Repository":"postgres","Tag":"16-alpine","Size":"242MB","CreatedSince":"2 weeks ago"}
{"ID":"aaaa555566667777","Repository":"node","Tag":"22","Size":"1.1GB","CreatedSince":"5 days ago"}
invalid json line
"#,
        );
        assert_eq!(imgs.len(), 2);
        assert_eq!(imgs[0].repository, "node");
        assert_eq!(imgs[1].repository, "postgres");
        assert_eq!(imgs[1].id, "111122223333");

        let stats = parse_stats(
            br#"{"ID":"aaaaaaaaaaaa1111","CPUPerc":"1.42%","MemUsage":"48.2MiB / 7.65GiB","MemPerc":"0.62%"}"#,
        );
        let db = stats.get("aaaaaaaaaaaa").expect("stats keyed by 12-char id");
        assert_eq!(db.cpu_percent, "1.42%");
        assert_eq!(db.mem_usage, "48.2MiB / 7.65GiB");
        assert_eq!(db.mem_percent, "0.62%");
    }

    #[test]
    fn truncates_logs_cleanly() {
        let sample = "linea1\nlinea2\nlinea3\n";
        assert_eq!(truncate_tail_utf8(sample, 100), sample);
        let cut = truncate_tail_utf8(sample, 10);
        assert!(cut.contains("linea3"));
        assert!(cut.starts_with("… (salida recortada"));
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
