use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

/// Abre (o crea) la base de datos local y aplica el esquema.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS settings (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS groups (
             id       INTEGER PRIMARY KEY,
             name     TEXT NOT NULL UNIQUE,
             position INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS projects (
             path     TEXT PRIMARY KEY,
             group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
             archived INTEGER NOT NULL DEFAULT 0
         );",
    )?;
    Ok(conn)
}

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}
