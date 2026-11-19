//! Read-only projection of the existing memory, task and GitHub relations.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{err, workspace::project_path, AppState, CmdResult};

const ANCHORS: i64 = 40;
const NEIGHBORS: i64 = 32;
const EDGES: i64 = 180;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    project: Option<String>,
    kind: Option<String>,
    from: Option<i64>,
    until: Option<i64>,
}

#[derive(Serialize)]
struct Node {
    key: String,
    kind: String,
    title: String,
    date: i64,
    id: i64,
    url: Option<String>,
    matched: bool,
}

#[derive(Serialize)]
struct Edge {
    from: String,
    to: String,
    kind: String,
}

#[derive(Serialize)]
pub struct Graph {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    limited: bool,
}

// Each edge follows an existing foreign key or the task/session/branch
// association already used by the task board. Text and dates never infer links.
const GRAPH_SQL: &str = "
WITH scoped_tasks AS (
    SELECT id,parent_id,title,updated_at FROM tasks WHERE project=?1
), scoped_memories AS (
    SELECT id,task,source_task,source_run,kind,title,updated FROM brain_entries WHERE project IS ?1
), scoped_pulls AS (
    SELECT 'p:'||repository||'#'||number AS key,number,branch,observed_at,
           json_extract(snapshot,'$.url') AS url,repository
    FROM github_pulls WHERE project=?1
), nodes AS (
    SELECT 'm:'||id AS key,kind,title,updated AS date,id,NULL AS url FROM scoped_memories
    UNION ALL
    SELECT 't:'||id,'task',title,updated_at,id,NULL FROM scoped_tasks
    UNION ALL
    SELECT key,'pr','PR #'||number||' · '||repository,observed_at,number,url FROM scoped_pulls
), links AS (
    SELECT 'm:'||m.id AS origin, 't:'||t.id AS target, 'scope' AS kind
    FROM scoped_memories m JOIN scoped_tasks t ON t.id=m.task
    UNION ALL
    SELECT 'm:'||m.id, 't:'||t.id, 'task_source'
    FROM scoped_memories m JOIN scoped_tasks t ON t.id=m.source_task
    UNION ALL
    SELECT 'm:'||m.id, 't:'||t.id, 'run_source'
    FROM scoped_memories m JOIN task_runs r ON r.id=m.source_run AND r.project=?1
    JOIN scoped_tasks t ON t.id=r.task_id
    UNION ALL
    SELECT 't:'||t.id,'t:'||p.id,'parent'
    FROM scoped_tasks t JOIN scoped_tasks p ON p.id=t.parent_id
    UNION ALL
    SELECT 't:'||t.id,'t:'||r.id,'dependency'
    FROM task_dependencies d JOIN scoped_tasks t ON t.id=d.task_id
    JOIN scoped_tasks r ON r.id=d.requires_id
    UNION ALL
    SELECT 'm:'||m.id,p.key,'pull_source'
    FROM scoped_memories m JOIN brain_entries b ON b.id=m.id JOIN scoped_pulls p ON p.url=b.source
    UNION ALL
    SELECT DISTINCT 't:'||t.id,p.key,'pull'
    FROM scoped_tasks t JOIN task_sessions j ON j.task_id=t.id
    JOIN sessions s ON s.id=j.session_id AND s.project=?1
    JOIN scoped_pulls p ON p.branch=s.branch
), candidates AS (
    SELECT key,date FROM nodes
    WHERE (?2 IS NULL OR kind=?2) AND (?3 IS NULL OR date>=?3) AND (?4 IS NULL OR date<?4)
    ORDER BY date DESC,key LIMIT (?5+1)
), anchors AS (
    SELECT key FROM candidates ORDER BY date DESC,key LIMIT ?5
), adjacent AS (
    SELECT target AS key FROM links JOIN anchors ON anchors.key=links.origin
    UNION
    SELECT origin FROM links JOIN anchors ON anchors.key=links.target
), neighbors AS (
    SELECT n.key,n.date FROM nodes n JOIN adjacent a ON a.key=n.key
    WHERE n.key NOT IN (SELECT key FROM anchors)
    ORDER BY n.date DESC,n.key LIMIT (?6+1)
), visible AS (
    SELECT key,1 AS matched FROM anchors
    UNION ALL
    SELECT key,0 FROM (SELECT key FROM neighbors ORDER BY date DESC,key LIMIT ?6)
)
";

fn read(conn: &Connection, filter: &Filter) -> CmdResult<Graph> {
    if filter.from.zip(filter.until).is_some_and(|(from,until)| from >= until) {
        return Err("la fecha final debe ser posterior al inicio".into());
    }
    if filter.kind.as_deref().is_some_and(|kind| !matches!(kind,
        "task" | "pr" | "fact" | "decision" | "preference" | "constraint" | "evidence" | "outcome")) {
        return Err("tipo de nodo desconocido".into());
    }
    let bindings = params![filter.project,filter.kind,filter.from,filter.until,ANCHORS,NEIGHBORS];
    let mut q = conn.prepare(&format!("{GRAPH_SQL}
        SELECT n.key,n.kind,n.title,n.date,n.id,n.url,v.matched,
               (SELECT count(*) FROM candidates)>?5 OR (SELECT count(*) FROM neighbors)>?6
        FROM visible v JOIN nodes n ON n.key=v.key ORDER BY v.matched DESC,n.date DESC,n.key")).map_err(err)?;
    let mut rows = q.query(bindings).map_err(err)?;
    let mut graph = Graph { nodes: Vec::new(), edges: Vec::new(), limited: false };
    while let Some(row) = rows.next().map_err(err)? {
        let node = (|| -> rusqlite::Result<Node> {
            Ok(Node { key:row.get(0)?,kind:row.get(1)?,title:row.get(2)?,date:row.get(3)?,id:row.get(4)?,
                url:row.get(5)?,matched:row.get(6)? })
        })().map_err(err)?;
        graph.limited |= row.get::<_,bool>(7).map_err(err)?;
        graph.nodes.push(node);
    }
    if graph.nodes.len() < 2 { return Ok(graph); }
    let mut q = conn.prepare(&format!("{GRAPH_SQL}
        SELECT l.origin,l.target,l.kind FROM links l
        JOIN visible a ON a.key=l.origin JOIN visible b ON b.key=l.target
        ORDER BY a.matched+b.matched DESC,l.origin,l.target,l.kind LIMIT {}", EDGES + 1)).map_err(err)?;
    graph.edges = q.query_map(bindings, |r| Ok(Edge { from:r.get(0)?,to:r.get(1)?,kind:r.get(2)? }))
        .map_err(err)?.collect::<rusqlite::Result<_>>().map_err(err)?;
    graph.limited |= graph.edges.len() > EDGES as usize;
    graph.edges.truncate(EDGES as usize);
    Ok(graph)
}

#[tauri::command]
pub async fn brain_graph(app: AppHandle, mut filter: Filter) -> CmdResult<Graph> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(err)?;
        filter.project = filter.project.as_deref().map(|path| project_path(&conn,path)).transpose()?;
        read(&conn,&filter)
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let conn = crate::db::open(std::path::Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "INSERT INTO tasks(id,project,parent_id,title,goal,criteria,priority,risk,status,updated_at) VALUES
             (1,'web',NULL,'Catálogo','g','c','normal','normal','ready',100),
             (2,'web',1,'Paginación','g','c','normal','normal','ready',101),
             (3,'other',NULL,'Catálogo','g','c','normal','normal','ready',101),
             (4,'web',NULL,'Catálogo sin vínculo','g','c','normal','normal','ready',100);
             INSERT INTO task_dependencies(task_id,requires_id) VALUES(2,1);
             INSERT INTO sessions(id,project,engine,name,provider_session,branch) VALUES
             (1,'web','codex','web','one','catalogo'),(2,'web','claude','reviewer','two','catalogo'),
             (3,'other','codex','other','three','catalogo');
             INSERT INTO task_sessions(session_id,task_id) VALUES(1,2),(2,2),(3,3);
             INSERT INTO task_runs(id,task_id,scope,project,provider,started_ms,ended_ms,retry)
             VALUES(1,1,'fixture','web','codex',1,2,0);
             INSERT INTO brain_entries(id,project,task,kind,title,body,source,source_task,source_run,share,updated) VALUES
             (1,'web',2,'decision','ADR','d','acta',2,NULL,1,120),
             (2,'web',NULL,'fact','Hecho','d','acta',NULL,1,0,119),
             (3,'web',NULL,'evidence','PR fuente','d','https://github.com/demo/web/pull/7',NULL,NULL,0,130),
             (4,NULL,NULL,'preference','Global','d','acta',NULL,NULL,0,120),
             (5,'other',3,'decision','No visible','d','acta',3,NULL,0,120);
             INSERT INTO github_pulls(project,repository,branch,number,snapshot,observed_at) VALUES
             ('web','demo/web','catalogo',7,'{\"url\":\"https://github.com/demo/web/pull/7\"}',114),
             ('other','demo/other','catalogo',7,'{\"url\":\"https://github.com/demo/other/pull/7\"}',114);"
        ).unwrap();
        conn
    }

    fn filter(kind: Option<&str>) -> Filter {
        Filter { project: Some("web".into()), kind: kind.map(str::to_owned), from: None, until: None }
    }

    #[test]
    fn edges_follow_the_saved_links_and_never_join_projects_or_titles() {
        let conn = fixture();
        let graph = read(&conn,&filter(None)).unwrap();
        let edges: Vec<_> = graph.edges.iter().map(|e|(e.from.as_str(),e.to.as_str(),e.kind.as_str())).collect();
        assert_eq!(edges.len(),7);
        for expected in [("m:1","t:2","scope"),("m:1","t:2","task_source"),("m:2","t:1","run_source"),
            ("m:3","p:demo/web#7","pull_source"),("t:2","p:demo/web#7","pull"),("t:2","t:1","dependency"),("t:2","t:1","parent")] {
            assert!(edges.contains(&expected),"{expected:?}");
        }
        assert!(graph.nodes.iter().any(|n| n.key=="t:4"));
        assert!(!edges.iter().any(|(a,b,_)| *a=="t:4" || *b=="t:4"));
        assert!(!graph.nodes.iter().any(|node| matches!(node.key.as_str(),"m:4"|"m:5"|"t:3"|"p:demo/other#7")));
        assert_eq!(graph.nodes.iter().find(|node| node.kind=="pr").unwrap().url.as_deref(),Some("https://github.com/demo/web/pull/7"));
    }

    #[test]
    fn typed_and_dated_matches_keep_only_their_direct_neighborhood() {
        let conn = fixture();
        let graph = read(&conn,&Filter { from:Some(120), until:Some(121), ..filter(Some("decision")) }).unwrap();
        assert_eq!(graph.nodes.iter().map(|n| (n.key.as_str(),n.matched)).collect::<Vec<_>>(),[("m:1",true),("t:2",false)]);
        assert_eq!(graph.edges.len(),2);
        assert!(read(&conn,&Filter { from:Some(121),..filter(Some("decision")) }).unwrap().nodes.is_empty());
        assert!(read(&conn,&Filter { from:Some(5),until:Some(5),..filter(None) }).is_err());
        let global = read(&conn,&Filter { project:None, ..filter(None) }).unwrap();
        assert_eq!(global.nodes.len(),1);
        assert_eq!(global.nodes[0].key,"m:4");
        assert!(global.edges.is_empty());
    }

    #[test]
    fn reports_when_a_view_is_limited() {
        let conn = fixture();
        conn.execute_batch(
            "WITH RECURSIVE ids(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM ids WHERE i<45)
             INSERT INTO brain_entries(project,kind,title,body,source,share,updated)
             SELECT 'web','decision','nota '||i,'d','s',0,i FROM ids;",
        ).unwrap();
        let graph = read(&conn,&filter(Some("decision"))).unwrap();
        assert!(graph.limited);
        assert_eq!(graph.nodes.iter().filter(|n|n.matched).count(),ANCHORS as usize);
    }
}
