use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{err, CmdResult};

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS larry_commits (
           project TEXT NOT NULL, branch TEXT NOT NULL, oid TEXT NOT NULL, subject TEXT NOT NULL,
           PRIMARY KEY(project,branch,oid)
         );
         CREATE TABLE IF NOT EXISTS github_pulls (
           project TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL, number INTEGER NOT NULL,
           snapshot TEXT NOT NULL, observed_at INTEGER NOT NULL DEFAULT (unixepoch()),
           PRIMARY KEY(project,repository,number)
         );
         CREATE INDEX IF NOT EXISTS github_pulls_branch ON github_pulls(project,branch,observed_at);
         CREATE TABLE IF NOT EXISTS github_publications (
           project TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, oid TEXT NOT NULL,
           pending_create INTEGER NOT NULL, PRIMARY KEY(project,repository,branch,base,oid)
         );
         COMMIT;",
    )
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pull {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub branch: String,
    pub base: String,
    pub head: String,
    pub checks: (u32, u32, u32),
    pub checks_state: String,
    pub checks_known: bool,
    pub review: Option<String>,
    pub merge_state: String,
    pub observed_at: i64,
}

impl Pull {
    pub fn merge_ready(&self) -> bool {
        self.state == "OPEN" && !self.is_draft && self.merge_state == "CLEAN"
            && matches!(self.review.as_deref(), None | Some("APPROVED"))
            && self.checks_known && self.checks.0 > 0 && self.checks.1 == 0 && self.checks.2 == 0
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub oid: String,
    pub subject: String,
}

pub fn record_commit(conn: &Connection, project: &str, branch: &str, oid: &str, subject: &str) -> CmdResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO larry_commits(project,branch,oid,subject) VALUES(?1,?2,?3,?4)",
        params![project,branch,oid,subject],
    ).map_err(err)?;
    Ok(())
}

pub fn remember(conn: &Connection, project: &str, repository: &str, pull: &Pull) -> CmdResult<()> {
    let snapshot = serde_json::to_string(pull).map_err(err)?;
    let number = i64::try_from(pull.number).map_err(err)?;
    conn.execute(
        "INSERT INTO github_pulls(project,repository,branch,number,snapshot) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(project,repository,number) DO UPDATE SET branch=excluded.branch,snapshot=excluded.snapshot,observed_at=unixepoch()",
        params![project,repository,pull.branch,number,snapshot],
    ).map_err(err)?;
    Ok(())
}

pub fn pulls(conn: &Connection, project: &str, repository: Option<&str>, branch: &str) -> CmdResult<Vec<Pull>> {
    let mut query = conn.prepare(
        "SELECT snapshot FROM github_pulls WHERE project=?1 AND (?2 IS NULL OR repository=?2) AND branch=?3
         ORDER BY observed_at DESC, number DESC",
    ).map_err(err)?;
    let rows = query.query_map(params![project,repository,branch], |row| row.get::<_, String>(0)).map_err(err)?;
    rows.map(|row| serde_json::from_str(&row.map_err(err)?).map_err(err)).collect()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub commits: Vec<Commit>,
    pub pulls: Vec<Pull>,
}

pub fn branch(conn: &Connection, project: &str, branch: &str) -> CmdResult<Branch> {
    let mut query = conn.prepare("SELECT oid,subject FROM larry_commits WHERE project=?1 AND branch=?2 ORDER BY rowid DESC").map_err(err)?;
    let rows = query.query_map([project,branch], |row| Ok(Commit { oid: row.get(0)?, subject: row.get(1)? })).map_err(err)?;
    let commits = rows.collect::<rusqlite::Result<_>>().map_err(err)?;
    Ok(Branch { commits, pulls: pulls(conn, project, None, branch)? })
}

pub struct Publication<'a> {
    pub project: &'a str,
    pub repository: &'a str,
    pub branch: &'a str,
    pub base: &'a str,
    pub oid: &'a str,
}

impl Publication<'_> {
    pub fn pending(&self, conn: &Connection) -> CmdResult<bool> {
        conn.query_row(
            "SELECT pending_create FROM github_publications WHERE project=?1 AND repository=?2 AND branch=?3 AND base=?4 AND oid=?5",
            params![self.project,self.repository,self.branch,self.base,self.oid], |row| row.get(0),
        ).optional().map(|v| v.unwrap_or(false)).map_err(err)
    }

    pub fn set_pending(&self, conn: &Connection, pending: bool) -> CmdResult<()> {
        if pending {
            conn.execute(
                "INSERT OR IGNORE INTO github_publications(project,repository,branch,base,oid,pending_create) VALUES(?1,?2,?3,?4,?5,1)",
                params![self.project,self.repository,self.branch,self.base,self.oid],
            ).map_err(err)?;
        } else {
            conn.execute(
                "DELETE FROM github_publications WHERE project=?1 AND repository=?2 AND branch=?3 AND base=?4 AND oid=?5",
                params![self.project,self.repository,self.branch,self.base,self.oid],
            ).map_err(err)?;
        }
        Ok(())
    }
}
