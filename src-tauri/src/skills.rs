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
}

const ROLES: [Role; 7] = [Role::Pm, Role::Researcher, Role::Designer, Role::Senior,
    Role::Junior, Role::Auditor, Role::Auditor2];
pub const MARKER: &str = "\n\n[Filigranas IDE: skills administradas del turno]\n";

impl Role {
    pub fn from_key(key: Option<&str>) -> Self {
        ROLES.into_iter().find(|role| Some(role.key()) == key).unwrap_or_default()
    }

    fn key(self) -> &'static str {
        match self {
            Self::Pm => "pm", Self::Researcher => "researcher", Self::Designer => "designer",
            Self::Senior => "senior", Self::Junior => "junior", Self::Auditor => "auditor",
            Self::Auditor2 => "auditor2",
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

fn catalog(root: &Path, enabled: impl Fn(&str) -> bool) -> String {
    let mut text = String::new();
    for (name, description) in SKILLS.iter().filter_map(|skill| metadata(skill)) {
        if enabled(name) {
            let path = root.join(name).join("SKILL.md");
            text.push_str(&format!("- ${name} — {description} Ruta: `{}`\n", path.display()));
        }
    }
    text
}

fn assignment(conn: &Connection, scope: &str, role: Role, skill: &str) -> rusqlite::Result<Option<bool>> {
    conn.query_row(
        "SELECT enabled FROM skill_assignments WHERE scope=?1 AND role=?2 AND skill=?3",
        params![scope, role.key(), skill], |row| row.get(0),
    ).optional()
}

fn session_role(conn: &Connection, id: i64) -> rusqlite::Result<Role> {
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

pub fn with_catalog(app: &AppHandle, conn: &Connection, project: &str, session: Option<i64>, text: String) -> CmdResult<String> {
    let role = session.map(|id| session_role(conn, id)).transpose().map_err(err)?.unwrap_or(Role::Pm);
    let bundled = app.path().resource_dir().ok().map(|dir| dir.join("src-tauri/resources/skills"));
    let root = bundled.filter(|dir| dir.is_dir()).or_else(|| {
        cfg!(dev).then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/skills"))
    });
    let Some(root) = root else { return Ok(text) };
    turn_catalog(conn, project, role, &root, text)
}

fn turn_catalog(conn: &Connection, project: &str, role: Role, root: &Path, text: String) -> CmdResult<String> {
    let mut enabled = Vec::new();
    let mut disabled = Vec::new();
    for (name, _) in SKILLS.iter().filter_map(|skill| metadata(skill)) {
        if assignment(conn, project, role, name).map_err(err)?
            .or(assignment(conn, "", role, name).map_err(err)?).unwrap_or(true) {
            enabled.push(name);
        } else {
            disabled.push(format!("${name}"));
        }
    }
    let mut result = format!("{text}{MARKER}Rol: {}. Este catálogo sustituye a catálogos administrados de turnos previos. Lee únicamente la skill habilitada que corresponda al encargo. Las reglas del proyecto y los permisos siguen vigentes.\n{}",
        role.key(), catalog(root, |name| enabled.contains(&name)));
    if !disabled.is_empty() {
        result.push_str(&format!("Skills de Filigranas desactivadas para este turno: {}. No las abras como skills de Filigranas.\n", disabled.join(", ")));
    }
    Ok(result)
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
            let global = assignment(&conn, "", role, skill).map_err(err)?.unwrap_or(true);
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
    fn catalog_uses_real_paths_and_only_exposes_skill_metadata() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/skills");
        let listing = catalog(&root, |_| true);
        let mut names = std::collections::BTreeSet::new();
        for skill in SKILLS {
            let (name, description) = metadata(skill).unwrap();
            assert!(names.insert(name));
            let file = root.join(name).join("SKILL.md");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), skill);
            assert!(listing.contains(description) && listing.contains(file.to_str().unwrap()));
            let normalized = skill.replace("\r\n", "\n");
            assert!(!listing.contains(normalized.split("\n---\n").nth(1).unwrap().trim()));
        }
        assert_eq!(names, ["code-review", "debug", "design-loop", "github-flow", "implement", "research"].into());
        assert_eq!(metadata("---\r\nname: debug\r\ndescription: Diagnóstico\r\n---\r\n"), Some(("debug", "Diagnóstico")));
    }

    #[test]
    fn turn_catalog_applies_role_and_project_overrides_without_changing_global_rules() {
        let db = crate::db::open(Path::new(":memory:")).unwrap();
        let root = Path::new("/bundle/skills");
        let listing = |p, role| turn_catalog(&db, p, role, root, "Encargo".into()).unwrap();
        let skill_path = root.join("design-loop").join("SKILL.md");
        let skill_path = skill_path.to_str().unwrap();
        assert!(listing("a", Role::Designer).contains(skill_path));
        set_assignment(&db, "", Role::Designer, "design-loop", Some(false)).unwrap();
        assert!(!listing("a", Role::Designer).contains(skill_path));
        assert!(listing("a", Role::Senior).contains(skill_path));
        set_assignment(&db, "a", Role::Designer, "design-loop", Some(true)).unwrap();
        assert!(listing("a", Role::Designer).contains(skill_path));
        assert!(!listing("b", Role::Designer).contains(skill_path));
        set_assignment(&db, "a", Role::Designer, "design-loop", None).unwrap();
        assert!(!listing("a", Role::Designer).contains(skill_path));
    }
}
