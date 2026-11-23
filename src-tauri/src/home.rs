use std::collections::HashMap;
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use tauri::AppHandle;

use crate::{db, err, git, github, pr, work, workspace::project_path, CmdResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HomeTask {
    id: i64,
    title: String,
    status: String,
    updated_at: i64,
}

#[derive(Serialize)]
pub struct Summary {
    path: String,
    tasks: Vec<HomeTask>,
    sessions: Vec<db::Session>,
    work: Option<work::Work>,
    branch: Option<String>,
    dates: Option<Vec<String>>,
    ci: Option<github::Pull>,
    #[serde(skip)]
    observations: Vec<github::Pull>,
}

fn read_summaries(conn: &Connection, paths: &[String], focus: Option<&str>) -> CmdResult<Vec<Summary>> {
    let mut summaries = Vec::new();
    for path in paths {
        let Ok(canonical) = project_path(conn, path) else { continue };
        if canonical != *path {
            continue;
        }
        summaries.push(Summary {
            path: canonical,
            tasks: Vec::new(),
            sessions: if focus == Some(path) { db::sessions(conn, path).map_err(err)? } else { Vec::new() },
            work: work::current(conn, path)?,
            branch: None,
            dates: None,
            ci: None,
            observations: Vec::new(),
        });
    }
    let indexes: HashMap<_, _> = summaries.iter().enumerate().map(|(i, item)| (item.path.clone(), i)).collect();
    let scope = serde_json::to_string(paths).map_err(err)?;
    let mut query = conn.prepare(
        "SELECT project,id,title,status,updated_at FROM tasks
         WHERE project IN (SELECT value FROM json_each(?1)) AND status NOT IN ('done','cancelled') ORDER BY id"
    ).map_err(err)?;
    let mut rows = query.query([&scope]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let path: String = row.get(0).map_err(err)?;
        if let Some(&i) = indexes.get(&path) {
            summaries[i].tasks.push(HomeTask {
                id: row.get(1).map_err(err)?, title: row.get(2).map_err(err)?,
                status: row.get(3).map_err(err)?, updated_at: row.get(4).map_err(err)?,
            });
        }
    }
    let mut ci = conn.prepare(
        "SELECT project,snapshot FROM (
             SELECT project,snapshot,ROW_NUMBER() OVER (
                PARTITION BY project ORDER BY observed_at DESC, number DESC
             ) AS rank
             FROM github_pulls WHERE project IN (SELECT value FROM json_each(?1))
               AND CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.state') END='OPEN'
         ) WHERE rank<=8 ORDER BY project,rank",
    ).map_err(err)?;
    let mut rows = ci.query([scope]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let path: String = row.get(0).map_err(err)?;
        if let Some(&i) = indexes.get(&path) {
            let snapshot: String = row.get(1).map_err(err)?;
            if let Ok(pull) = serde_json::from_str(&snapshot) {
                summaries[i].observations.push(pull);
            }
        }
    }
    Ok(summaries)
}

#[tauri::command]
pub async fn home_summary(app: AppHandle, paths: Vec<String>, focus: Option<String>) -> CmdResult<Vec<Summary>> {
    if paths.len() > 31 {
        return Err("máximo de 31 resúmenes de proyecto por consulta".into());
    }
    crate::background_read(app, move |state| {
        let mut summaries = {
            let conn = state.db.lock().map_err(err)?;
            read_summaries(&conn, &paths, focus.as_deref())?
        };
        // Ejecutar Git después de soltar SQLite, con un máximo de cuatro procesos a la vez.
        std::thread::scope(|scope| {
            for batch in summaries.chunks_mut(8) {
                scope.spawn(move || {
                    for item in batch {
                        let repo = Path::new(&item.path);
                        item.branch = git::head_at(repo).ok();
                        item.dates = git::commit_dates(repo).ok();
                        let observed = std::mem::take(&mut item.observations);
                        let branch = item.branch.as_deref();
                        if observed.iter().any(|pull| Some(pull.branch.as_str()) == branch) {
                            let head = pr::value(repo, &["rev-parse", "--verify", "HEAD"]).ok();
                            item.ci = observed.into_iter().find(|pull|
                                Some(pull.branch.as_str()) == branch && Some(pull.head.as_str()) == head.as_deref());
                        }
                    }
                });
            }
        });
        Ok(summaries)
    }).await
}
