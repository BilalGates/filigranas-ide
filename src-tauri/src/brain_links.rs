//! Relaciones tipadas entre recuerdos de Brain.
//!
//! Migración aditiva: crea una tabla nueva y no toca `brain_entries`. Solo
//! existen las relaciones que el usuario crea y confirma; nunca se deducen
//! de recuerdos antiguos. Al borrar un recuerdo se borran sus relaciones.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{err, workspace::project_path, AppState, CmdResult};

pub const KINDS: [&str; 5] = ["depende", "refina", "sustituye", "contradice", "relacionado"];

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS brain_links (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           project TEXT NOT NULL,
           from_entry INTEGER NOT NULL REFERENCES brain_entries(id) ON DELETE CASCADE,
           to_entry INTEGER NOT NULL REFERENCES brain_entries(id) ON DELETE CASCADE,
           kind TEXT NOT NULL CHECK(kind IN ('depende','refina','sustituye','contradice','relacionado')),
           note TEXT NOT NULL DEFAULT '',
           created INTEGER NOT NULL DEFAULT(unixepoch()),
           CHECK(from_entry <> to_entry),
           UNIQUE(from_entry, to_entry, kind)
         );
         CREATE INDEX IF NOT EXISTS brain_links_scope ON brain_links(project);",
    )
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: Option<i64>,
    pub from: i64,
    pub to: i64,
    pub kind: String,
    pub note: String,
    #[serde(default)]
    pub created: i64,
}

fn visible(conn: &Connection, project: &str, id: i64) -> CmdResult<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM brain_entries WHERE id=?1 AND (project=?2 OR project IS NULL))",
        params![id, project], |r| r.get(0)).map_err(err)
}

pub(crate) fn list(conn: &Connection, project: &str) -> CmdResult<Vec<Link>> {
    let mut stmt = conn.prepare(
        "SELECT id,from_entry,to_entry,kind,note,created FROM brain_links WHERE project=?1 ORDER BY id").map_err(err)?;
    let rows = stmt.query_map([project], |r| Ok(Link {
        id: r.get(0)?, from: r.get(1)?, to: r.get(2)?, kind: r.get(3)?, note: r.get(4)?, created: r.get(5)?,
    })).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub(crate) fn save(conn: &Connection, project: &str, link: &Link) -> CmdResult<i64> {
    if project.is_empty() { return Err("elige un proyecto para relacionar recuerdos".into()); }
    if !KINDS.contains(&link.kind.as_str()) { return Err("tipo de relación desconocido".into()); }
    if link.from == link.to { return Err("un recuerdo no puede relacionarse consigo mismo".into()); }
    if link.note.chars().count() > 400 { return Err("la nota de la relación es demasiado larga".into()); }
    if !visible(conn, project, link.from)? || !visible(conn, project, link.to)? {
        return Err("los dos recuerdos deben estar disponibles en este proyecto".into());
    }
    let existing: Option<i64> = conn.query_row(
        "SELECT id FROM brain_links WHERE from_entry=?1 AND to_entry=?2 AND kind=?3",
        params![link.from, link.to, link.kind], |r| r.get(0)).optional().map_err(err)?;
    if let Some(id) = existing {
        conn.execute("UPDATE brain_links SET note=?2 WHERE id=?1", params![id, link.note.trim()]).map_err(err)?;
        return Ok(id);
    }
    conn.execute("INSERT INTO brain_links(project,from_entry,to_entry,kind,note) VALUES(?1,?2,?3,?4,?5)",
        params![project, link.from, link.to, link.kind, link.note.trim()]).map_err(err)?;
    Ok(conn.last_insert_rowid())
}

pub(crate) fn remove(conn: &Connection, project: &str, id: i64) -> CmdResult<()> {
    let n = conn.execute("DELETE FROM brain_links WHERE id=?1 AND project=?2", params![id, project]).map_err(err)?;
    if n != 1 { return Err("la relación ya no existe en este proyecto".into()); }
    Ok(())
}

#[tauri::command]
pub fn brain_links(state: State<AppState>, project: String) -> CmdResult<Vec<Link>> {
    let conn = state.db.lock().map_err(err)?;
    list(&conn, &project_path(&conn, &project)?)
}

#[tauri::command]
pub fn brain_link_save(state: State<AppState>, project: String, link: Link, confirmed: bool) -> CmdResult<i64> {
    if !confirmed { return Err("confirma la relación antes de guardarla".into()); }
    let conn = state.db.lock().map_err(err)?;
    save(&conn, &project_path(&conn, &project)?, &link)
}

#[tauri::command]
pub fn brain_link_remove(state: State<AppState>, project: String, id: i64) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    remove(&conn, &project_path(&conn, &project)?, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(conn: &Connection, project: Option<&str>, title: &str) -> i64 {
        conn.execute("INSERT INTO brain_entries(project,kind,title,body,source,share) VALUES(?1,'decision',?2,'cuerpo','acta',1)",
            params![project, title]).unwrap();
        conn.last_insert_rowid()
    }
    fn link(from: i64, to: i64, kind: &str) -> Link {
        Link { id: None, from, to, kind: kind.into(), note: String::new(), created: 0 }
    }
    fn open() -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("filigranas-links-{}.db", uuid::Uuid::new_v4()));
        (crate::db::open(&path).unwrap(), path)
    }

    #[test]
    fn la_migracion_es_aditiva_e_idempotente() {
        let (conn, path) = open();
        let a = entry(&conn, Some("web"), "Antes de la migración");
        drop(conn);
        let conn = crate::db::open(&path).unwrap();
        migrate(&conn).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM brain_entries", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
        let title: String = conn.query_row("SELECT title FROM brain_entries WHERE id=?1", [a], |r| r.get(0)).unwrap();
        assert_eq!(title, "Antes de la migración");
        assert!(list(&conn, "web").unwrap().is_empty(), "no se infiere ninguna relación");
    }

    #[test]
    fn guarda_lista_y_borra_relaciones_del_proyecto() {
        let (conn, _) = open();
        let a = entry(&conn, Some("web"), "A");
        let b = entry(&conn, Some("web"), "B");
        let g = entry(&conn, None, "Global");
        let id = save(&conn, "web", &link(a, b, "sustituye")).unwrap();
        save(&conn, "web", &link(b, g, "refina")).unwrap();
        assert_eq!(save(&conn, "web", &Link { note: "nota".into(), ..link(a, b, "sustituye") }).unwrap(), id, "no duplica");
        let all = list(&conn, "web").unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].note, "nota");
        assert!(list(&conn, "other").unwrap().is_empty());
        assert!(remove(&conn, "other", id).is_err());
        remove(&conn, "web", id).unwrap();
        assert_eq!(list(&conn, "web").unwrap().len(), 1);
    }

    #[test]
    fn rechaza_relaciones_invalidas() {
        let (conn, _) = open();
        let a = entry(&conn, Some("web"), "A");
        let b = entry(&conn, Some("web"), "B");
        let other = entry(&conn, Some("other"), "Ajeno");
        assert!(save(&conn, "web", &link(a, a, "depende")).is_err());
        assert!(save(&conn, "web", &link(a, b, "inventada")).is_err());
        assert!(save(&conn, "web", &link(a, other, "depende")).is_err());
        assert!(save(&conn, "", &link(a, b, "depende")).is_err());
    }

    #[test]
    fn olvidar_un_recuerdo_borra_sus_relaciones() {
        let (conn, _) = open();
        let a = entry(&conn, Some("web"), "A");
        let b = entry(&conn, Some("web"), "B");
        save(&conn, "web", &link(a, b, "contradice")).unwrap();
        conn.execute("DELETE FROM brain_entries WHERE id=?1", [b]).unwrap();
        assert!(list(&conn, "web").unwrap().is_empty());
    }
}
