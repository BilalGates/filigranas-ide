//! Read-only projection of the existing memory, task and GitHub relations.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{err, workspace::project_path, AppState, CmdResult};

const ANCHORS: i64 = 240;
const NEIGHBORS: i64 = 160;
const EDGES: i64 = 1200;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    project: Option<String>,
    kind: Option<String>,
    query: Option<String>,
    #[serde(skip)]
    workspace: Option<String>,
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
    project: Option<String>,
    body: Option<String>,
    source: Option<String>,
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
WITH workspace_projects AS (SELECT key AS path,value AS name FROM json_each(?8)), scoped_tasks AS (
    SELECT id,parent_id,title,updated_at,project FROM tasks WHERE (?1 IS NULL OR project=?1) AND (?8 IS NULL OR project IN (SELECT path FROM workspace_projects))
), scoped_memories AS (
    SELECT id,task,source_task,source_run,kind,title,updated,project,body,source FROM brain_entries WHERE (?1 IS NULL OR project=?1) AND (project IS NULL OR ?8 IS NULL OR project IN (SELECT path FROM workspace_projects))
), scoped_pulls AS (
    SELECT 'p:'||project||':'||repository||'#'||number AS key,number,branch,observed_at,project,
           json_extract(snapshot,'$.url') AS url,repository
    FROM github_pulls WHERE (?1 IS NULL OR project=?1) AND (?8 IS NULL OR project IN (SELECT path FROM workspace_projects))
), nodes AS (
    SELECT 'm:'||id AS key,kind,title,updated AS date,id,NULL AS url,project,body,source FROM scoped_memories
    UNION ALL
    SELECT 't:'||id,'task',title,updated_at,id,NULL,project,NULL,NULL FROM scoped_tasks
    UNION ALL
    SELECT key,'pr','PR #'||number||' · '||repository,observed_at,number,url,project,NULL,url FROM scoped_pulls
    UNION ALL
    SELECT 'project:'||project,'project',coalesce(max(w.name),project),max(date),0,NULL,project,NULL,NULL
    FROM (SELECT project,updated_at AS date FROM scoped_tasks UNION ALL SELECT project,updated FROM scoped_memories UNION ALL SELECT project,observed_at FROM scoped_pulls UNION ALL SELECT path,0 FROM workspace_projects WHERE (?1 IS NULL OR path=?1) UNION ALL SELECT path,0 FROM projects WHERE ?8 IS NULL AND (?1 IS NULL OR path=?1)) p
    LEFT JOIN workspace_projects w ON w.path=p.project
    WHERE project IS NOT NULL GROUP BY project
), links AS (
    SELECT 'm:'||m.id AS origin, 't:'||t.id AS target, 'scope' AS kind
    FROM scoped_memories m JOIN scoped_tasks t ON t.id=m.task AND t.project=m.project
    UNION ALL
    SELECT 'm:'||m.id, 't:'||t.id, 'task_source'
    FROM scoped_memories m JOIN scoped_tasks t ON t.id=m.source_task AND t.project=m.project
    UNION ALL
    SELECT 'm:'||m.id, 't:'||t.id, 'run_source'
    FROM scoped_memories m JOIN task_runs r ON r.id=m.source_run AND r.project=m.project
    JOIN scoped_tasks t ON t.id=r.task_id AND t.project=r.project
    UNION ALL
    SELECT 't:'||t.id,'t:'||p.id,'parent'
    FROM scoped_tasks t JOIN scoped_tasks p ON p.id=t.parent_id AND p.project=t.project
    UNION ALL
    SELECT 't:'||t.id,'t:'||r.id,'dependency'
    FROM task_dependencies d JOIN scoped_tasks t ON t.id=d.task_id
    JOIN scoped_tasks r ON r.id=d.requires_id AND r.project=t.project
    UNION ALL
    SELECT 'm:'||m.id,p.key,'pull_source'
    FROM scoped_memories m JOIN scoped_pulls p ON p.url=m.source AND (m.project IS NULL OR p.project=m.project)
    UNION ALL
    SELECT DISTINCT 't:'||t.id,p.key,'pull'
    FROM scoped_tasks t JOIN task_sessions j ON j.task_id=t.id
    JOIN sessions s ON s.id=j.session_id AND s.project=t.project
    JOIN scoped_pulls p ON p.branch=s.branch AND p.project=s.project
    UNION ALL
    SELECT key,'project:'||project,'project_member' FROM nodes WHERE project IS NOT NULL AND kind!='project'
), candidates AS (
    SELECT key,date FROM nodes
    WHERE (?7 IS NULL OR instr(lower(title),lower(?7))>0 OR instr(lower(coalesce(body,'')),lower(?7))>0 OR id IN (SELECT rowid FROM brain_search WHERE brain_search MATCH NULLIF(?9,'')) AND kind NOT IN ('task','pr','project')) AND (?2 IS NULL OR kind=?2) AND (?3 IS NULL OR date>=?3) AND (?4 IS NULL OR date<?4)
    ORDER BY kind='project' DESC,date DESC,key LIMIT (?5+1)
), anchors AS (
    SELECT key FROM candidates ORDER BY key LIKE 'project:%' DESC,date DESC,key LIMIT ?5
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
        "project" | "task" | "pr" | "fact" | "decision" | "preference" | "constraint" | "evidence" | "outcome")) {
        return Err("tipo de nodo desconocido".into());
    }
    let query = filter.query.as_deref().map(str::trim).filter(|q| !q.is_empty());
    if query.is_some_and(|q| q.chars().count() > 300) {
        return Err("la búsqueda admite hasta 300 caracteres".into());
    }
    let terms = query.map(|q| crate::brain::keywords(q, true)).unwrap_or_default();
    let terms = if terms.is_empty() { "\"\"" } else { &terms };
    let bindings = params![filter.project,filter.kind,filter.from,filter.until,ANCHORS,NEIGHBORS,query,filter.workspace,terms];
    let mut q = conn.prepare(&format!("{GRAPH_SQL}
        SELECT n.key,n.kind,n.title,n.date,n.id,n.url,v.matched,
               (SELECT count(*) FROM candidates)>?5 OR (SELECT count(*) FROM neighbors)>?6,
               n.project,n.body,n.source
        FROM visible v JOIN nodes n ON n.key=v.key ORDER BY v.matched DESC,n.date DESC,n.key")).map_err(err)?;
    let mut rows = q.query(bindings).map_err(err)?;
    let mut graph = Graph { nodes: Vec::new(), edges: Vec::new(), limited: false };
    while let Some(row) = rows.next().map_err(err)? {
        let node = (|| -> rusqlite::Result<Node> {
            Ok(Node { key:row.get(0)?,kind:row.get(1)?,title:row.get(2)?,date:row.get(3)?,id:row.get(4)?,
                url:row.get(5)?,matched:row.get(6)?,project:row.get(8)?,body:row.get(9)?,source:row.get(10)? })
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
        let projects = crate::workspace::project_names(&conn)?;
        filter.workspace = Some(serde_json::to_string(&projects).map_err(err)?);
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
        Filter { project: Some("web".into()), kind: kind.map(str::to_owned), query: None, workspace: None, from: None, until: None }
    }

    #[test]
    fn edges_follow_the_saved_links_and_never_join_projects_or_titles() {
        let conn = fixture();
        let graph = read(&conn,&filter(None)).unwrap();
        let edges: Vec<_> = graph.edges.iter().map(|e|(e.from.as_str(),e.to.as_str(),e.kind.as_str())).collect();
        assert_eq!(edges.len(),14);
        for expected in [("m:1","t:2","scope"),("m:1","t:2","task_source"),("m:2","t:1","run_source"),
            ("m:3","p:web:demo/web#7","pull_source"),("t:2","p:web:demo/web#7","pull"),("t:2","t:1","dependency"),("t:2","t:1","parent")] {
            assert!(edges.contains(&expected),"{expected:?}");
        }
        assert!(graph.nodes.iter().any(|n| n.key=="t:4"));
        assert!(!edges.iter().any(|(a,b,kind)| (*a=="t:4" || *b=="t:4") && *kind!="project_member"));
        assert!(!graph.nodes.iter().any(|node| matches!(node.key.as_str(),"m:5"|"t:3"|"p:other:demo/other#7")));
        assert_eq!(graph.nodes.iter().find(|node| node.kind=="pr").unwrap().url.as_deref(),Some("https://github.com/demo/web/pull/7"));
    }

    #[test]
    fn typed_and_dated_matches_keep_only_their_direct_neighborhood() {
        let conn = fixture();
        let graph = read(&conn,&Filter { from:Some(120), until:Some(121), ..filter(Some("decision")) }).unwrap();
        assert_eq!(graph.nodes.iter().map(|n| (n.key.as_str(),n.matched)).collect::<Vec<_>>(),[("m:1",true),("project:web",false),("t:2",false)]);
        assert_eq!(graph.edges.len(),4);
        assert!(read(&conn,&Filter { from:Some(121),..filter(Some("decision")) }).unwrap().nodes.is_empty());
        assert!(read(&conn,&Filter { from:Some(5),until:Some(5),..filter(None) }).is_err());
        let global = read(&conn,&Filter { project:None, ..filter(None) }).unwrap();
        assert!(global.nodes.iter().any(|n| n.key=="m:4" && n.project.is_none()));
        assert!(global.nodes.iter().any(|n| n.key=="t:3" && n.project.as_deref()==Some("other")));
        assert!(global.nodes.iter().any(|n| n.key=="project:web"));
        assert!(!global.edges.iter().any(|e| e.from=="t:2" && e.to=="p:other:demo/other#7"));
    }

    #[test]
    fn reports_when_a_view_is_limited() {
        let conn = fixture();
        conn.execute_batch(
            "WITH RECURSIVE ids(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM ids WHERE i<245)
             INSERT INTO brain_entries(project,kind,title,body,source,share,updated)
             SELECT 'web','decision','nota '||i,'d','s',0,i FROM ids;",
        ).unwrap();
        let graph = read(&conn,&filter(Some("decision"))).unwrap();
        assert!(graph.limited);
        assert_eq!(graph.nodes.iter().filter(|n|n.matched).count(),ANCHORS as usize);
    }
}

#[cfg(test)]
mod general_tests {
    use super::*;
    #[test]
    fn global_search_keeps_project_provenance_and_separates_same_repository_pulls() {
        let conn = crate::db::open(std::path::Path::new(":memory:")).unwrap();
        conn.execute_batch("INSERT INTO brain_entries(project,kind,title,body,source,share) VALUES
            ('alpha','decision','ADR alpha','criterio válido','acta alpha',0),
            ('beta','decision','ADR beta','otro criterio','acta beta',0);
            INSERT INTO github_pulls(project,repository,branch,number,snapshot,observed_at) VALUES
            ('alpha','demo/shared','main',1,'{}',100),('beta','demo/shared','main',1,'{}',100);").unwrap();
        let filter = Filter { project: None, kind: None, query: None, workspace: None, from: None, until: None };
        let all = read(&conn,&filter).unwrap();
        assert_eq!(all.nodes.iter().filter(|n|n.kind=="pr").count(),2);
        let found = read(&conn,&Filter { query:Some("valido".into()),..filter }).unwrap();
        let matched: Vec<_> = found.nodes.iter().filter(|n|n.matched).collect();
        assert_eq!(matched.len(),1);
        assert_eq!(matched[0].project.as_deref(),Some("alpha"));
        assert_eq!(matched[0].source.as_deref(),Some("acta alpha"));
        assert!(found.nodes.iter().any(|n|n.key=="project:alpha"));
        assert!(!found.nodes.iter().any(|n|n.project.as_deref()==Some("beta")));
        for query in ["x", "#", "\""] {
            read(&conn, &Filter { query:Some(query.into()),project:None,kind:None,workspace:None,from:None,until:None }).unwrap();
        }
        let workspace = read(&conn, &Filter {
            workspace: Some(r#"{"alpha":"Alpha","empty":"Vacío"}"#.into()),
            query: None, project: None, kind: None, from: None, until: None,
        }).unwrap();
        assert!(workspace.nodes.iter().any(|n| n.key == "project:empty" && n.title == "Vacío"));
        assert!(!workspace.nodes.iter().any(|n| n.project.as_deref() == Some("beta")));
    }
}
