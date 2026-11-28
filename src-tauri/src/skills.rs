use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{db, err, workspace::project_path, AppState, CmdResult};

pub const RULES: &str = include_str!("../resources/reglas.md");

const SKILLS: [&str; 6] = [
    include_str!("../resources/skills/implement/SKILL.md"),
    include_str!("../resources/skills/debug/SKILL.md"),
    include_str!("../resources/skills/design-loop/SKILL.md"),
    include_str!("../resources/skills/code-review/SKILL.md"),
    include_str!("../resources/skills/github-flow/SKILL.md"),
    include_str!("../resources/skills/research/SKILL.md"),
];

fn metadata(skill: &str) -> Option<(&str, &str)> {
    let mut lines = skill.lines();
    if lines.next()? != "---" {
        return None;
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        if line == "---" {
            return Some((name?, description?));
        }
        if let Some(value) = line.strip_prefix("name: ") {
            name = Some(value);
        }
        if let Some(value) = line.strip_prefix("description: ") {
            description = Some(value);
        }
    }
    None
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Pm,
    Researcher,
    Designer,
    #[default]
    Senior,
    Junior,
    Auditor,
    Auditor2,
    Architect,
    Graphic,
    Security,
    Verifier,
    Data,
}

pub const ROLES: [Role; 12] = [Role::Pm, Role::Researcher, Role::Designer, Role::Senior,
    Role::Junior, Role::Auditor, Role::Auditor2, Role::Architect, Role::Graphic,
    Role::Security, Role::Verifier, Role::Data];
pub const MARKER: &str = "\n\n[Filigranas IDE: skills administradas del turno]\n";

impl Role {
    pub fn from_key(key: Option<&str>) -> Self {
        ROLES.into_iter().find(|role| Some(role.key()) == key).unwrap_or_default()
    }

    pub fn parse(key: &str) -> Option<Self> {
        ROLES.into_iter().find(|role| role.key() == key)
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Pm => "pm", Self::Researcher => "researcher", Self::Designer => "designer",
            Self::Senior => "senior", Self::Junior => "junior", Self::Auditor => "auditor",
            Self::Auditor2 => "auditor2", Self::Architect => "architect", Self::Graphic => "graphic",
            Self::Security => "security", Self::Verifier => "verifier", Self::Data => "data",
        }
    }

    /// Skill interna de rol (nivel 2). El PM recibe la política del coordinador.
    pub fn instructions(self) -> &'static str {
        match self {
            Self::Pm => "",
            Self::Researcher => include_str!("../resources/roles/researcher.md"),
            Self::Designer => include_str!("../resources/roles/designer.md"),
            Self::Senior => include_str!("../resources/roles/senior.md"),
            Self::Junior => include_str!("../resources/roles/junior.md"),
            Self::Auditor => include_str!("../resources/roles/auditor.md"),
            Self::Auditor2 => include_str!("../resources/roles/auditor2.md"),
            Self::Architect => include_str!("../resources/roles/architect.md"),
            Self::Graphic => include_str!("../resources/roles/graphic.md"),
            Self::Security => include_str!("../resources/roles/security.md"),
            Self::Verifier => include_str!("../resources/roles/verifier.md"),
            Self::Data => include_str!("../resources/roles/data.md"),
        }
    }
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS skill_assignments (
            scope TEXT NOT NULL, role TEXT NOT NULL, skill TEXT NOT NULL, enabled INTEGER NOT NULL,
            PRIMARY KEY(scope, role, skill)
         );",
    )
}

fn body(skill: &str) -> &str {
    let normalized = skill.strip_prefix("---").and_then(|rest| rest.split_once("\n---").map(|(_, body)| body));
    normalized.unwrap_or(skill).trim()
}

// Matriz base. Los valores guardados prevalecen sobre estos. El PM no recibe
// métodos técnicos: coordina y delega. Git queda en Larry.
fn default_assignment(role: Role, skill: &str) -> bool {
    match skill {
        "implement" => matches!(role, Role::Senior | Role::Junior),
        "debug" => matches!(role, Role::Senior | Role::Junior | Role::Verifier),
        "research" => role == Role::Researcher,
        "design-loop" => matches!(role, Role::Designer | Role::Graphic),
        "code-review" => matches!(role, Role::Auditor | Role::Auditor2 | Role::Security),
        _ => false,
    }
}

fn assignment(conn: &Connection, scope: &str, role: Role, skill: &str) -> rusqlite::Result<Option<bool>> {
    conn.query_row(
        "SELECT enabled FROM skill_assignments WHERE scope=?1 AND role=?2 AND skill=?3",
        params![scope, role.key(), skill], |row| row.get(0),
    ).optional()
}

pub fn session_role(conn: &Connection, id: i64) -> rusqlite::Result<Role> {
    let key: Option<String> = conn.query_row("SELECT skill_role FROM sessions WHERE id=?1", [id], |row| row.get(0))?;
    Ok(Role::from_key(key.as_deref()))
}

pub fn assign_session(conn: &Connection, id: i64, role: Role) -> CmdResult<()> {
    if role == Role::Pm {
        return Err("el rol PM se reserva al coordinador del proyecto".into());
    }
    conn.execute("UPDATE sessions SET skill_role=?2 WHERE id=?1", params![id, role.key()]).map_err(err)?;
    Ok(())
}

/// Carpeta de recursos de las skills internas (empaquetada o del repositorio en desarrollo).
pub fn resource_root(app: &AppHandle) -> Option<std::path::PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|dir| dir.join("src-tauri/resources/skills"));
    bundled.filter(|dir| dir.is_dir()).or_else(|| {
        cfg!(dev).then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/skills"))
    })
}

/// Métodos internos habilitados para el rol, con su texto completo y las
/// referencias relativas resueltas a rutas reales.
pub fn methods(conn: &Connection, project: &str, role: Role, root: Option<&Path>) -> CmdResult<Vec<(&'static str, String)>> {
    let mut result = Vec::new();
    for skill in SKILLS {
        let Some((name, _)) = metadata(skill) else { continue };
        let enabled = assignment(conn, project, role, name).map_err(err)?
            .or(assignment(conn, "", role, name).map_err(err)?).unwrap_or_else(|| default_assignment(role, name));
        if enabled {
            let mut text = body(skill).to_owned();
            if let Some(root) = root {
                text = text.replace("](references/", &format!("]({}/", root.join(name).join("references").display()));
            }
            result.push((name, text));
        }
    }
    Ok(result)
}

const MAC_TRAFFIC_REFERENCE: &str = include_str!("../resources/skills/design-loop/references/semaforo-macos.md");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleStatus {
    agents_file: bool,
    copied_traffic_rule: bool,
    links_traffic_reference: bool,
}

fn rule_status(text: Option<&str>) -> RuleStatus {
    let agents_file = text.is_some();
    let text = text.unwrap_or("");
    let canonical = MAC_TRAFFIC_REFERENCE.lines().find(|line| line.starts_with("- Usa 16 puntos"))
        .unwrap_or("").trim_start_matches("- ");
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    RuleStatus {
        agents_file,
        copied_traffic_rule: !canonical.is_empty() && normalized.contains(canonical),
        links_traffic_reference: text.contains("semaforo-macos.md"),
    }
}

#[tauri::command]
pub async fn skills_rule_status(app: AppHandle, project: String) -> CmdResult<RuleStatus> {
    crate::background_read(app, move |state| {
        let project = {
            let conn = state.db.lock().map_err(err)?;
            project_path(&conn, &project)?
        };
        let root = Path::new(&project);
        let file = root.join("AGENTS.md");
        match std::fs::symlink_metadata(&file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(rule_status(None)),
            Err(error) => Err(err(error)),
            Ok(_) => {
                let file = crate::paths::inside(root, &file)?;
                let text = crate::files::read_file(&file)?;
                Ok(rule_status(Some(&text)))
            }
        }
    }).await
}

#[derive(Serialize)]
pub struct SkillInfo {
    name: String,
    description: String,
}

#[tauri::command]
pub fn skills_list() -> Vec<SkillInfo> {
    SKILLS.iter().filter_map(|skill| metadata(skill))
        .map(|(name, description)| SkillInfo { name: name.into(), description: description.into() }).collect()
}

#[derive(Serialize)]
pub struct Assignment {
    skill: String,
    role: Role,
    enabled: bool,
    inherited: bool,
}

#[tauri::command]
pub fn skills_assignments(state: State<AppState>, project: Option<String>) -> CmdResult<Vec<Assignment>> {
    let conn = state.db.lock().map_err(err)?;
    let scope = project.map(|path| project_path(&conn, &path)).transpose()?;
    let mut result = Vec::new();
    for (skill, _) in SKILLS.iter().filter_map(|skill| metadata(skill)) {
        for role in ROLES {
            let global = assignment(&conn, "", role, skill).map_err(err)?.unwrap_or_else(|| default_assignment(role, skill));
            let local = scope.as_ref().map(|path| assignment(&conn, path, role, skill)).transpose().map_err(err)?.flatten();
            result.push(Assignment { skill: skill.into(), role, enabled: local.unwrap_or(global), inherited: scope.is_some() && local.is_none() });
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn skills_set_assignment(state: State<AppState>, project: Option<String>, role: Role, skill: String, enabled: Option<bool>) -> CmdResult<()> {
    if !SKILLS.iter().filter_map(|skill| metadata(skill)).any(|(name, _)| name == skill) {
        return Err("skill de Filigranas desconocida".into());
    }
    let conn = state.db.lock().map_err(err)?;
    let scope = project.map(|path| project_path(&conn, &path)).transpose()?.unwrap_or_default();
    set_assignment(&conn, &scope, role, &skill, enabled)
}

fn set_assignment(conn: &Connection, scope: &str, role: Role, skill: &str, enabled: Option<bool>) -> CmdResult<()> {
    if let Some(enabled) = enabled {
        conn.execute("INSERT INTO skill_assignments(scope,role,skill,enabled) VALUES(?1,?2,?3,?4)
          ON CONFLICT(scope,role,skill) DO UPDATE SET enabled=excluded.enabled",
            params![scope,role.key(),skill,enabled]).map_err(err)?;
    } else {
        conn.execute("DELETE FROM skill_assignments WHERE scope=?1 AND role=?2 AND skill=?3",
            params![scope,role.key(),skill]).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn skills_set_session_role(app: AppHandle, project: String, session: i64, role: Role) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let conn = state.db.lock().map_err(err)?;
    let project = project_path(&conn, &project)?;
    db::session(&conn, session).map_err(err)?.filter(|s| s.project == project)
        .ok_or("la sesión no pertenece al proyecto")?;
    if crate::chat::is_pm(&conn, session).map_err(err)? {
        return Err("el rol del PM viene del coordinador".into());
    }
    assign_session(&conn, session, role)?;
    drop(conn);
    let _ = app.emit("sessions-changed", serde_json::json!({"project":project}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traffic_rules_report_distinguishes_a_reference_from_a_repeated_rule() {
        assert!(!rule_status(None).agents_file);
        let linked = rule_status(Some("Aplica [la norma](references/semaforo-macos.md)."));
        assert!(linked.agents_file && linked.links_traffic_reference && !linked.copied_traffic_rule);
        let repeated = rule_status(Some(MAC_TRAFFIC_REFERENCE));
        assert!(repeated.agents_file && repeated.copied_traffic_rule);
    }

    #[test]
    fn methods_inline_skill_bodies_with_resolved_references() {
        let db = crate::db::open(Path::new(":memory:")).unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/skills");
        let mut names = std::collections::BTreeSet::new();
        for skill in SKILLS {
            let (name, _) = metadata(skill).unwrap();
            assert!(names.insert(name));
            assert_eq!(std::fs::read_to_string(root.join(name).join("SKILL.md")).unwrap(), skill);
        }
        assert_eq!(names, ["code-review", "debug", "design-loop", "github-flow", "implement", "research"].into());
        assert_eq!(metadata("---\r\nname: debug\r\ndescription: Diagnóstico\r\n---\r\n"), Some(("debug", "Diagnóstico")));
        let designer = methods(&db, "p", Role::Designer, Some(&root)).unwrap();
        let (_, text) = designer.iter().find(|(n, _)| *n == "design-loop").unwrap();
        assert!(!text.starts_with("---") && !text.contains("description:"));
        let reference = root.join("design-loop/references/semaforo-macos.md");
        assert!(text.contains(reference.to_str().unwrap()) && reference.is_file());
    }

    #[test]
    fn default_matrix_keeps_technical_methods_away_from_the_pm() {
        let db = crate::db::open(Path::new(":memory:")).unwrap();
        let names = |role| methods(&db, "p", role, None).unwrap().into_iter().map(|(n, _)| n).collect::<Vec<_>>();
        assert!(names(Role::Pm).is_empty());
        assert_eq!(names(Role::Senior), ["implement", "debug"]);
        assert_eq!(names(Role::Researcher), ["research"]);
        assert_eq!(names(Role::Designer), ["design-loop"]);
        assert_eq!(names(Role::Security), ["code-review"]);
        assert_eq!(names(Role::Verifier), ["debug"]);
        assert!(ROLES.iter().all(|role| names(*role).iter().all(|n| *n != "github-flow")));
        assert!(ROLES.iter().filter(|r| **r != Role::Pm).all(|r| !r.instructions().trim().is_empty()));
    }

    #[test]
    fn methods_apply_role_and_project_overrides_without_changing_global_rules() {
        let db = crate::db::open(Path::new(":memory:")).unwrap();
        let has = |p, role| methods(&db, p, role, None).unwrap().iter().any(|(n, _)| *n == "design-loop");
        assert!(has("a", Role::Designer));
        set_assignment(&db, "", Role::Designer, "design-loop", Some(false)).unwrap();
        assert!(!has("a", Role::Designer));
        assert!(has("a", Role::Graphic));
        set_assignment(&db, "", Role::Researcher, "design-loop", Some(true)).unwrap();
        assert!(has("a", Role::Researcher));
        set_assignment(&db, "a", Role::Designer, "design-loop", Some(true)).unwrap();
        assert!(has("a", Role::Designer) && !has("b", Role::Designer));
        set_assignment(&db, "a", Role::Designer, "design-loop", None).unwrap();
        assert!(!has("a", Role::Designer));
    }
}
