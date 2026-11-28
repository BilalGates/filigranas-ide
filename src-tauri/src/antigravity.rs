//! Official Antigravity CLI configuration. No credential files are read or copied.
use std::path::{Path, PathBuf};
use std::process::Command;
use serde_json::json;
use tauri::Manager;
use crate::{db, err, CmdResult};

const EXECUTOR: &str = "---\nname: filigranas-executor\ndescription: Filigranas controlled executor\ntools:\n  - read_file\n  - write_file\n  - run_command\nmainAgent: true\nsubagent: false\ncommandExecutionPolicy: sandbox\n---\nExecute only the assigned task in this workspace. Never create internal agents, scheduled tasks, browser agents or workflows. Git commits, push, merge and rebase belong to Larry and the user. Respect project instructions and the supplied Filigranas skill catalogue.\n";
const READER: &str = "---\nname: filigranas-reader\ndescription: Filigranas read only researcher\ntools:\n  - read_file\n  - run_command\nmainAgent: true\nsubagent: false\ncommandExecutionPolicy: sandbox\n---\nResearch only. Never write, delegate or create internal agents. Use reviewed sandboxed commands only to inspect this workspace. Read the supplied Filigranas skills and project instructions. Explain unavailable capabilities honestly.\n";

fn private_dir(path: &Path) -> CmdResult<()> {
    if std::fs::symlink_metadata(path).is_ok_and(|m|m.file_type().is_symlink()) {
        return Err("el directorio del perfil de Antigravity no puede ser un enlace simbólico".into());
    }
    std::fs::create_dir_all(path).map_err(err)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    Ok(())
}

fn write_private(path: &Path, text: &str) -> CmdResult<()> {
    // The profile belongs to Filigranas, never to the repository or user's CLI.
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("el perfil de Antigravity no puede ser un enlace simbólico".into());
    }
    std::fs::write(path, text).map_err(err)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(err)?;
    }
    Ok(())
}

pub fn profile(root: &Path) -> CmdResult<PathBuf> {
    private_dir(root)?;
    let runtime = root.join("runtime");
    let agents = root.join("config/agents");
    private_dir(&runtime)?;
    private_dir(&agents)?;
    let settings = json!({
        "agentMode": "", "toolPermission": "strict", "enableTerminalSandbox": true,
        "allowNonWorkspaceAccess": false, "useG1Credits": false,
        "permissions": { "allow": [],
            "ask": ["read_file(*)", "write_file(*)", "command(*)", "read_url(*)", "execute_url(*)"],
            "deny": ["mcp(*)", "execute_url(*)"] }
    });
    write_private(&runtime.join("settings.json"), &settings.to_string())?;
    write_private(&agents.join("filigranas-executor.md"), EXECUTOR)?;
    write_private(&agents.join("filigranas-reader.md"), READER)?;
    Ok(root.to_path_buf())
}

pub fn configure(cmd: &mut Command, root: &Path, read_only: bool) -> CmdResult<()> {
    profile(root)?;
    cmd.args(["--gemini-dir"]).arg(root).args(["--app-data-dir", "runtime", "--sandbox", "--disable-telemetry", "--include-default-customizations=false", "--agent",
        if read_only { "filigranas-reader" } else { "filigranas-executor" }]);
    // Authentication is owned by the CLI's OS credential store. Do not silently
    // switch an account session to a key inherited from the IDE's environment.
    cmd.env_remove("GEMINI_API_KEY").env_remove("GOOGLE_API_KEY");
    Ok(())
}

pub fn root(app: &tauri::AppHandle, session: &db::Session) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("antigravity").join(session.id.to_string()))
}

pub fn reader(session: &db::Session) -> bool {
    matches!(session.skill_role, crate::skills::Role::Researcher | crate::skills::Role::Auditor | crate::skills::Role::Auditor2)
}

/// Native file requests are never permitted to cross the execution workspace.
/// Tool names and locations are untrusted; use the same canonical path checks
/// as common auto approvals, also for explicit approvals and full mode.
pub fn permits(cwd: &Path, tool: &serde_json::Value, read_only: bool) -> bool {
    let (kind, paths, _) = crate::autoapprove::acp_request(tool);
    match kind {
        crate::autoapprove::Kind::Read | crate::autoapprove::Kind::Edit => {
            !(read_only && kind == crate::autoapprove::Kind::Edit) && !paths.is_empty()
                && paths.iter().all(|p| crate::autoapprove::inside(cwd, p))
        }
        crate::autoapprove::Kind::Exec | crate::autoapprove::Kind::Other => tool["name"] == "run_command",
    }
}

#[cfg(target_os = "macos")]
fn policy_path(path: &Path) -> CmdResult<String> {
    // Seatbelt matches resolved filesystem paths. /var and /tmp aliases must
    // also be resolved for future profile files, not only existing projects.
    let mut existing = path.to_path_buf();
    let mut remaining = Vec::new();
    while !existing.exists() {
        remaining.push(existing.file_name().ok_or("ruta de política no válida")?.to_owned());
        if !existing.pop() { return Err("ruta de política no válida".into()); }
    }
    let mut real = crate::paths::canonical(&existing).map_err(err)?;
    for name in remaining.into_iter().rev() { real.push(name); }
    serde_json::to_string(&real.to_string_lossy()).map_err(err)
}

#[cfg(target_os = "macos")]
fn protected_policy(root: &Path, git_dirs: &[PathBuf], workspace: &Path, read_only: bool) -> CmdResult<String> {
    let quoted = policy_path;
    let mut policy = format!("(version 1)(allow default)(deny file-write* (literal {}) (subpath {}))", quoted(&root.join("runtime/settings.json"))?, quoted(&root.join("config"))?);
    for dir in git_dirs { policy.push_str(&format!("(deny file-write* (subpath {}))",quoted(dir)?)); }
    // Workspace-native plugins/hooks/MCP servers are not Filigranas tools.
    // Denying reads also prevents later external edits from activating them.
    for relative in [".agents/hooks.json",".agents/mcp_config.json",".agents/agents",".agents/plugins",".gemini"] {
        policy.push_str(&format!("(deny file-read* file-write* (subpath {}))",quoted(&workspace.join(relative))?));
    }
    if read_only { policy.push_str(&format!("(deny file-write* (subpath {}))",quoted(workspace)?)); }
    Ok(policy)
}

/// The provider's terminal sandbox is complemented by a process-wide macOS
/// boundary: native tools and children cannot alter Git metadata or managed
/// policy, or read/write the other registered execution roots.
#[cfg(target_os = "macos")]
pub fn command(app: &tauri::AppHandle, session: &db::Session, root: &Path) -> CmdResult<Command> {
    use tauri::Manager;
    let cwd = crate::paths::canonical(Path::new(session.cwd())).map_err(err)?;
    let quoted = policy_path;
    let git = crate::git::git(&cwd, &["rev-parse", "--absolute-git-dir"]).ok()
        .map(|bytes| PathBuf::from(String::from_utf8_lossy(&bytes).trim()));
    let common = crate::git::git(&cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok()
        .map(|bytes| PathBuf::from(String::from_utf8_lossy(&bytes).trim()));
    let mut policy = protected_policy(root,&git.into_iter().chain(common.clone()).collect::<Vec<_>>(),&cwd,reader(session))?;
    let state = app.state::<crate::AppState>();
    let conn = state.db.lock().map_err(err)?;
    let mut query = conn.prepare("SELECT path FROM projects UNION SELECT worktree FROM sessions WHERE worktree IS NOT NULL").map_err(err)?;
    for path in query.query_map([], |row| row.get::<_,String>(0)).map_err(err)? {
        let path = PathBuf::from(path.map_err(err)?);
        let Ok(path) = crate::paths::canonical(&path) else { continue };
        if path == cwd || cwd.starts_with(&path) { continue; }
        if crate::paths::canonical(Path::new(&session.project)).ok().as_ref() == Some(&path) {
            policy.push_str(&format!("(deny file-write* (subpath {}))",quoted(&path)?));
            if let Some(common) = &common {
                policy.push_str(&format!("(deny file-read* (require-all (subpath {}) (require-not (subpath {}))))",quoted(&path)?,quoted(common)?));
            }
        } else { policy.push_str(&format!("(deny file-read* file-write* (subpath {}))", quoted(&path)?)); }
    }
    let mut command = crate::cli::command("/usr/bin/sandbox-exec");
    command.args(["-p", &policy]).arg(crate::cli::program("agy"));
    Ok(command)
}

/// Studio policy: the model only receives the prompt. It cannot write the
/// scratch workspace, alter its profile or read/write any registered project.
#[cfg(target_os = "macos")]
fn studio_policy(root: &Path, scratch: &Path, registered: &[PathBuf]) -> CmdResult<String> {
    let mut policy = protected_policy(root, &[], scratch, true)?;
    for path in registered {
        policy.push_str(&format!("(deny file-read* file-write* (subpath {}))", policy_path(path)?));
    }
    Ok(policy)
}

/// One Studio turn over ACP, with the same managed profile, reader agent and
/// macOS boundary as native sessions. Print mode (`agy --print`) cannot use a
/// managed profile, so it would inherit the user's global CLI configuration.
#[cfg(target_os = "macos")]
pub fn structured(app: &tauri::AppHandle, scratch: &Path, instructions: &str, prompt: &str, schema: &serde_json::Value, seconds: u64) -> CmdResult<String> {
    let root = app.path().app_data_dir().map_err(err)?.join("antigravity").join("studio");
    let registered: Vec<PathBuf> = {
        let state = app.state::<crate::AppState>();
        let conn = state.db.lock().map_err(err)?;
        let mut query = conn.prepare("SELECT path FROM projects UNION SELECT worktree FROM sessions WHERE worktree IS NOT NULL").map_err(err)?;
        let paths = query.query_map([], |row| row.get::<_, String>(0)).map_err(err)?
            .filter_map(Result::ok).filter_map(|p| crate::paths::canonical(Path::new(&p)).ok()).collect();
        paths
    };
    studio_turn(&root, scratch, &registered, &studio_prompt(instructions, prompt, schema), schema, seconds)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn studio_prompt(instructions: &str, prompt: &str, schema: &serde_json::Value) -> String {
    format!("{instructions}\n\nResponde únicamente con un objeto JSON válido que cumpla este esquema, sin texto adicional ni bloques de código:\n{schema}\n\n{prompt}")
}

#[cfg(target_os = "macos")]
fn studio_turn(root: &Path, scratch: &Path, registered: &[PathBuf], prompt: &str, schema: &serde_json::Value, seconds: u64) -> CmdResult<String> {
    use std::process::Stdio;
    use std::time::Duration;
    let _execution = crate::updates::Execution::enter()?;
    profile(root)?;
    let policy = studio_policy(root, scratch, registered)?;
    let mut command = crate::cli::command("/usr/bin/sandbox-exec");
    command.args(["-p", &policy]).arg(crate::cli::program("agy")).arg("acp");
    configure(&mut command, root, true)?;
    if let Some(path) = crate::cli::login_path() { command.env("PATH", path); }
    { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child = crate::cli::ChildProcess(command.current_dir(scratch).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "No se pudo iniciar Antigravity. Comprueba que la CLI está instalada.")?);
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let rpc = crate::rpc::Rpc::start_with(child.stdout.take().ok_or("sin salida")?, child.stdin.take().ok_or("sin entrada")?, move |rpc, msg| match msg {
        crate::rpc::Incoming::Notification { params, .. } if params.pointer("/update/sessionUpdate") == Some(&json!("agent_message_chunk")) => {
            if let Some(text) = params.pointer("/update/content/text").and_then(serde_json::Value::as_str) { let _ = tx.send(text.to_string()); }
        }
        // Studio only needs text: every tool permission is refused.
        crate::rpc::Incoming::Request { id, .. } => { let _ = rpc.respond(id, json!({ "outcome": { "outcome": "cancelled" } })); }
        _ => {}
    }, true);
    let limit = Duration::from_secs(seconds);
    let quota = |e: String| if crate::handoff::quota_reason(&e).is_some() {
        "Antigravity ha agotado su cuota. Puedes seguir editando las variantes que ya tienes.".to_string()
    } else { format!("Antigravity no pudo generar las variantes: {e}") };
    rpc.request("initialize", json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}), Duration::from_secs(30)).map_err(quota)?;
    let session = rpc.request("session/new", json!({"cwd": scratch, "mcpServers": []}), Duration::from_secs(30)).map_err(quota)?;
    let sid = session["sessionId"].as_str().ok_or("Antigravity no devolvió la sesión")?.to_string();
    let done = rpc.request("session/prompt", json!({"sessionId": sid, "prompt": [{"type":"text","text": prompt}]}), limit).map_err(quota)?;
    rpc.close_input();
    drop(child);
    let text: String = rx.try_iter().collect();
    if done["stopReason"] != "end_turn" {
        return Err(quota(format!("turno terminado con {}", done["stopReason"])));
    }
    structured_result(&text, schema)
}

/// Extracts the JSON object of the reply and checks the schema's required keys.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn structured_result(text: &str, schema: &serde_json::Value) -> CmdResult<String> {
    if crate::handoff::quota_reason(text).is_some() {
        return Err("Antigravity ha agotado su cuota. Puedes seguir editando las variantes que ya tienes.".into());
    }
    let (start, end) = (text.find('{'), text.rfind('}'));
    let value: serde_json::Value = match (start, end) {
        (Some(s), Some(e)) if s < e => serde_json::from_str(&text[s..=e]).map_err(|_| "Antigravity no devolvió un JSON válido.")?,
        _ => return Err("Antigravity no devolvió un JSON válido.".into()),
    };
    let required = schema["required"].as_array().into_iter().flatten().filter_map(serde_json::Value::as_str);
    let missing: Vec<&str> = required.filter(|k| value.get(*k).is_none()).collect();
    if !value.is_object() || !missing.is_empty() {
        return Err(format!("La respuesta de Antigravity no cumple el formato pedido (falta {}).", missing.join(", ")));
    }
    Ok(value.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn structured(_app: &tauri::AppHandle, _scratch: &Path, _instructions: &str, _prompt: &str, _schema: &serde_json::Value, _seconds: u64) -> CmdResult<String> {
    Err("Antigravity requiere validar el aislamiento nativo de esta plataforma antes de habilitar su ejecución".into())
}

#[cfg(not(target_os = "macos"))]
pub fn command(_app: &tauri::AppHandle, _session: &db::Session, _root: &Path) -> CmdResult<Command> {
    Err("Antigravity requiere validar el aislamiento nativo de esta plataforma antes de habilitar su ejecución".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires the real macOS sandbox-exec; run separately"]
    fn macos_policy_is_effective_for_native_operations_and_descendants() {
        let root = std::env::temp_dir().join(format!("filigranas-agy-boundary-{}",uuid::Uuid::new_v4()));
        profile(&root).unwrap();
        let git = root.join("workspace/.git"); std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"),"original").unwrap();
        let policy = protected_policy(&root,std::slice::from_ref(&git),&root.join("workspace"),false).unwrap();
        let write = |path: &Path| {
            crate::cli::command("/usr/bin/sandbox-exec").args(["-p",&policy,"/bin/sh","-c","printf forbidden > \"$1\"","probe"])
                .arg(path).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().unwrap()
        };
        assert!(!write(&git.join("HEAD")).success());
        assert_eq!(std::fs::read_to_string(git.join("HEAD")).unwrap(),"original");
        assert!(!write(&root.join("runtime/settings.json")).success());
        assert!(write(&root.join("workspace/allowed.txt")).success());
        let research = protected_policy(&root,std::slice::from_ref(&git),&root.join("workspace"),true).unwrap();
        let readonly = crate::cli::command("/usr/bin/sandbox-exec").args(["-p",&research,"/bin/sh","-c","printf forbidden > \"$1\"","probe"]).arg(root.join("workspace/reader.txt")).stderr(std::process::Stdio::null()).status().unwrap();
        assert!(!readonly.success());assert!(!root.join("workspace/reader.txt").exists());
        let foreign = root.join("foreign");std::fs::create_dir(&foreign).unwrap();
        std::fs::write(foreign.join("secret.txt"),"synthetic-secret").unwrap();
        let isolated = format!("{policy}(deny file-read* file-write* (subpath {}))",policy_path(&foreign).unwrap());
        let denied = crate::cli::command("/usr/bin/sandbox-exec").args(["-p",&isolated,"/bin/cat"]).arg(foreign.join("secret.txt")).output().unwrap();
        assert!(!denied.status.success());assert!(denied.stdout.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires authenticated agy and real macOS sandbox; sends no model prompt"]
    fn real_antigravity_does_not_autostart_workspace_mcp() {
        use std::process::Stdio;
        use std::time::Duration;
        let dir = std::env::temp_dir().join(format!("filigranas-agy-mcp-{}",uuid::Uuid::new_v4()));
        let workspace = dir.join("workspace");
        std::fs::create_dir_all(workspace.join(".agents")).unwrap();
        let canary = workspace.join("must-not-start.txt");
        std::fs::write(workspace.join(".agents/mcp_config.json"),json!({"mcpServers":{"unmanaged":{"command":"/usr/bin/touch","args":[canary]}}}).to_string()).unwrap();
        let root = dir.join("managed");
        let policy = protected_policy(&root,&[],&workspace,false).unwrap();
        let mut command = crate::cli::command("/usr/bin/sandbox-exec");
        command.args(["-p",&policy]).arg(crate::cli::program("agy")).arg("acp");
        configure(&mut command,&root,false).unwrap();
        if let Some(path)=crate::cli::login_path() { command.env("PATH",path); }
        #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
        let mut child = crate::cli::ChildProcess(command.current_dir(&workspace).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap());
        let rpc=crate::rpc::Rpc::start_with(child.stdout.take().unwrap(),child.stdin.take().unwrap(),|rpc,msg| {
            if let crate::rpc::Incoming::Request{id,..}=msg {let _=rpc.respond(id,json!({"outcome":{"outcome":"cancelled"}}));}
        },true);
        rpc.request("initialize",json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}),Duration::from_secs(30)).unwrap();
        let session=rpc.request("session/new",json!({"cwd":workspace,"mcpServers":[]}),Duration::from_secs(30)).unwrap();
        assert!(session["sessionId"].is_string());
        assert!(!canary.exists(),"unmanaged MCP executed without Filigranas authorization");
        rpc.close_input();drop(child);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires the real macOS sandbox-exec; run separately"]
    fn studio_policy_contains_descendants_without_a_model() {
        let dir = std::env::temp_dir().join(format!("filigranas-agy-studio-{}", uuid::Uuid::new_v4()));
        let (root, scratch, project) = (dir.join("managed"), dir.join("scratch"), dir.join("project"));
        profile(&root).unwrap();
        std::fs::create_dir_all(&scratch).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("secret.txt"), "synthetic-secret").unwrap();
        let policy = studio_policy(&root, &scratch, std::slice::from_ref(&project)).unwrap();
        let sh = |script: &str, arg: &Path| crate::cli::command("/usr/bin/sandbox-exec").args(["-p", &policy, "/bin/sh", "-c", script, "probe"])
            .arg(arg).stderr(std::process::Stdio::null()).output().unwrap();
        // A grandchild tries to exfiltrate and to write: every path is denied.
        let read = sh("/bin/sh -c 'cat \"$0\"' \"$1\"", &project.join("secret.txt"));
        assert!(!read.status.success() && read.stdout.is_empty());
        assert!(!sh("printf x > \"$1\"", &project.join("new.txt")).status.success());
        assert!(!sh("printf x > \"$1\"", &scratch.join("new.txt")).status.success());
        assert!(!sh("printf x > \"$1\"", &root.join("runtime/settings.json")).status.success());
        assert!(!project.join("new.txt").exists() && !scratch.join("new.txt").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires authenticated agy with quota; sends one tiny model prompt"]
    fn real_studio_structured_turn() {
        let dir = std::env::temp_dir().join(format!("filigranas-agy-studio-real-{}", uuid::Uuid::new_v4()));
        let scratch = dir.join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        let schema = json!({"type":"object","additionalProperties":false,"required":["status"],"properties":{"status":{"type":"string","enum":["STUDIO-OK"]}}});
        let prompt = studio_prompt("Prueba de Studio. No uses herramientas.", "Devuelve status STUDIO-OK.", &schema);
        let result = studio_turn(&dir.join("managed"), &scratch, &[], &prompt, &schema, 90);
        eprintln!("agy studio: {result:?}");
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(result.unwrap(), r#"{"status":"STUDIO-OK"}"#);
    }

    #[test]
    fn structured_result_accepts_only_schema_output() {
        let schema = json!({"type":"object","required":["variants"]});
        assert_eq!(structured_result("```json\n{\"variants\":[]}\n```", &schema).unwrap(), r#"{"variants":[]}"#);
        assert!(structured_result(r#"{"other":1}"#, &schema).unwrap_err().contains("variants"));
        assert!(structured_result("hola", &schema).is_err());
        assert!(structured_result("Individual quota reached. Resets in 130h", &schema).unwrap_err().contains("cuota"));
    }

    #[test]
    fn managed_profile_does_not_inherit_global_permissions() {
        let root = std::env::temp_dir().join(format!("filigranas-agy-profile-{}", uuid::Uuid::new_v4()));
        profile(&root).unwrap();
        let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("runtime/settings.json")).unwrap()).unwrap();
        assert_eq!(value["toolPermission"], "strict");
        assert_eq!(value["permissions"]["allow"], json!([]));
        assert_eq!(value["useG1Credits"], false);
        assert!(!EXECUTOR.contains("invoke_subagent"));
        assert!(READER.contains("  - run_command"));
        assert!(!READER.contains("  - write_file"));
        assert!(!permits(&root, &json!({"kind":"edit","locations":[]}), false));
        assert!(!permits(&root, &json!({"kind":"read","locations":[{"path":"/etc/passwd"}]}), false));
        assert!(permits(&root, &json!({"kind":"execute","name":"run_command"}), true));
        std::fs::remove_dir_all(root).unwrap();
    }
}
