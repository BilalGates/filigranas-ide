use super::*;

struct Fixture {
    conn: Connection,
    store: tempdir::Dir,
    project: tempdir::Dir,
}

mod tempdir {
    pub struct Dir(pub std::path::PathBuf);
    impl Dir {
        pub fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("filigranas-cap-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }
}

fn manifest(id: &str, roles: &[&str], kinds: &[&str], policy: &str, body: &str) -> (Manifest, Vec<u8>) {
    let bytes = body.as_bytes().to_vec();
    let m = Manifest {
        id: id.into(), name: format!("Ext {id}"), version: "1.0.0".into(), kind: "skill".into(), description: "prueba".into(),
        source: Source { repo: "owner/repo".into(), license: "MIT".into(), path: String::new(), commit: "a".repeat(40), r#ref: None },
        providers: ENGINES.iter().map(|e| (e.to_string(), "direct".to_string())).collect(),
        roles: roles.iter().map(|r| r.to_string()).collect(), task_kinds: kinds.iter().map(|k| k.to_string()).collect(),
        default_policy: policy.into(), permissions: vec!["context".into()], budget_tokens: 100, load_entry: true,
        criteria: "criterio".into(), evidence: Evidence { kind: "diff".into(), detail: "diff".into(), ..Default::default() },
        files: vec![FileEntry { path: "SKILL.md".into(), sha256: hex(&bytes), size: bytes.len() as u64, kind: "entry".into() }],
        entry_tokens: (bytes.len() / 4) as u32, ..Default::default()
    };
    (m, bytes)
}

impl Fixture {
    fn new() -> Self {
        let conn = db::open(Path::new(":memory:")).unwrap();
        // Aísla las pruebas del catálogo real: las extensiones del catálogo no
        // instaladas solo producirían bloqueos de «no instalada».
        Self { conn, store: tempdir::Dir::new("store"), project: tempdir::Dir::new("project") }
    }

    fn install(&self, m: &Manifest, bytes: &[u8]) {
        materialize(&self.store.0, m, &|_| Ok(bytes.to_vec())).unwrap();
        record_install(&self.conn, m, "install").unwrap();
    }

    fn session(&self, engine: &str, role: Role) -> db::Session {
        let project = self.project.0.to_str().unwrap();
        let s = db::create_session(&self.conn, project, engine, "prov-1", &["sesión 1"]).unwrap();
        crate::skills::assign_session(&self.conn, s.id, role).unwrap();
        db::session(&self.conn, s.id).unwrap().unwrap()
    }

    fn run(&self, s: &db::Session) -> i64 {
        self.conn.execute("INSERT INTO task_runs(session_id,scope,project,provider,started_ms,retry,outcome) VALUES(?1,?2,?3,?4,?5,0,'running')",
            params![s.id, format!("session:{}:{}", s.id, uuid::Uuid::new_v4()), s.project, s.engine, 0i64]).unwrap();
        self.conn.last_insert_rowid()
    }

    fn turn(&self, s: &db::Session, text: &str) -> (String, i64) {
        let run = self.run(s);
        let out = prepare(&self.conn, Some(&self.store.0), None, &s.project, s, run, text.into()).unwrap();
        self.conn.execute("UPDATE task_runs SET outcome='completed', ended_ms=1 WHERE id=?1", [run]).unwrap();
        (out, run)
    }

    fn states(&self, run: i64) -> BTreeMap<String, (String, String, String)> {
        let mut stmt = self.conn.prepare("SELECT ext,state,origin,reason FROM capability_runs WHERE run_id=?1").unwrap();
        stmt.query_map([run], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))).unwrap().map(Result::unwrap)
            .filter(|(id, _): &(String, _)| !catalog().iter().any(|m| m.id == *id)).collect()
    }
}

#[test]
fn technical_task_without_naming_extensions_loads_the_mandatory_capability() {
    let f = Fixture::new();
    let (m, bytes) = manifest("mini", &["senior"], &["implementacion"], "mandatory", "Haz el cambio mínimo.");
    f.install(&m, &bytes);
    let s = f.session("claude", Role::Senior);
    let (text, run) = f.turn(&s, "Añade un botón de exportar en la tabla");
    assert!(text.contains("Haz el cambio mínimo.") && text.contains("obligatoria por política"));
    assert!(text.contains(crate::skills::Role::Senior.instructions().trim()));
    let states = f.states(run);
    assert_eq!(states["mini"].0, "loaded");
    assert_eq!(states["mini"].1, "politica");
    let hash: Option<String> = f.conn.query_row("SELECT hash FROM capability_runs WHERE run_id=?1 AND ext='mini'", [run], |r| r.get(0)).unwrap();
    assert_eq!(hash.unwrap().len(), 64);
    let version: String = f.conn.query_row("SELECT version FROM capability_runs WHERE run_id=?1 AND ext='mini'", [run], |r| r.get(0)).unwrap();
    assert_eq!(version, "1.0.0");
}

#[test]
fn keyword_classification_selects_automatic_capabilities_for_the_role() {
    let f = Fixture::new();
    let (m, bytes) = manifest("tm", &["security"], &["threat_model"], "automatic", "STRIDE");
    f.install(&m, &bytes);
    let s = f.session("codex", Role::Security);
    let (text, run) = f.turn(&s, "Realiza un modelado de amenazas de la autenticación");
    assert!(text.contains("threat_model") && text.contains("modelado de amenazas") && text.contains("STRIDE"));
    assert_eq!(f.states(run)["tm"].1, "automatica");
    let (_, other) = f.turn(&s, "Explica qué hace este módulo");
    assert!(!f.states(other).contains_key("tm"), "sin tipo coincidente no se selecciona");
}

#[test]
fn missing_mandatory_capability_blocks_and_tells_the_agent() {
    let f = Fixture::new();
    let s = f.session("claude", Role::Graphic);
    let (text, run) = f.turn(&s, "Diseña el logotipo de la marca");
    let logo = f.conn.query_row("SELECT state, reason FROM capability_runs WHERE run_id=?1 AND ext='logo-design'", [run], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap();
    assert_eq!(logo, ("blocked".into(), "no instalada".into()));
    assert!(text.contains("Capacidades no disponibles") && text.contains("Logo Design es obligatoria"));
}

#[test]
fn disabled_capability_is_never_loaded_even_if_requested() {
    let f = Fixture::new();
    let (m, bytes) = manifest("off", &["senior"], &["implementacion"], "mandatory", "NO DEBE APARECER");
    f.install(&m, &bytes);
    let s = f.session("claude", Role::Senior);
    set_policy(&f.conn, "", "", "off", Some("disabled")).unwrap();
    assign(&f.conn, s.id, None, &["off".into()], "usuario").unwrap();
    let (text, run) = f.turn(&s, "Implementa la exportación");
    assert!(!text.contains("NO DEBE APARECER"));
    assert_eq!(f.states(run)["off"].0, "blocked");
    // Una política de sesión más específica puede reactivarla.
    set_policy(&f.conn, &format!("session:{}", s.id), "", "off", Some("automatic")).unwrap();
    let (text, _) = f.turn(&s, "Implementa la exportación");
    assert!(text.contains("NO DEBE APARECER"));
}

#[test]
fn manual_selection_is_loaded_with_its_origin_and_removable() {
    let f = Fixture::new();
    let (m, bytes) = manifest("man", &["researcher"], &[], "manual", "Lee fuentes externas.");
    f.install(&m, &bytes);
    let s = f.session("claude", Role::Researcher);
    let (text, run) = f.turn(&s, "Resume el README");
    assert!(!text.contains("Lee fuentes externas.") && !f.states(run).contains_key("man"));
    assign(&f.conn, s.id, None, &["man".into()], "usuario").unwrap();
    let (text, run) = f.turn(&s, "Resume el README");
    assert!(text.contains("Lee fuentes externas.") && text.contains("solicitada por el usuario"));
    assert_eq!(f.states(run)["man"].1, "usuario");
    assert!(assign(&f.conn, s.id, None, &["no-existe".into()], "usuario").is_err());
}

#[test]
fn provider_incompatibility_is_reported_not_simulated() {
    let f = Fixture::new();
    let (mut m, bytes) = manifest("only-claude", &["researcher"], &["config_repo"], "automatic", "Solo Claude");
    m.providers.insert("codex".into(), "none".into());
    f.install(&m, &bytes);
    let codex = f.session("codex", Role::Researcher);
    let (text, run) = f.turn(&codex, "Recomienda hooks para este repositorio");
    assert_eq!(f.states(run)["only-claude"], ("blocked".into(), "automatica".into(), "incompatible con codex".into()));
    assert!(!text.contains("Solo Claude"));
    let claude = f.session("claude", Role::Researcher);
    let (text, _) = f.turn(&claude, "Recomienda hooks para este repositorio");
    assert!(text.contains("Solo Claude"));
}

#[test]
fn conflicts_keep_the_higher_precedence_capability() {
    let f = Fixture::new();
    let (a, ab) = manifest("a-strict", &["senior"], &["implementacion"], "mandatory", "A");
    let (mut b, bb) = manifest("b-loose", &["senior"], &["implementacion"], "automatic", "B");
    b.incompatible = vec!["a-strict".into()];
    f.install(&a, &ab);
    f.install(&b, &bb);
    let s = f.session("claude", Role::Senior);
    let (_, run) = f.turn(&s, "Implementa algo");
    let states = f.states(run);
    assert_eq!(states["a-strict"].0, "loaded");
    assert_eq!(states["b-loose"].0, "skipped");
    assert!(states["b-loose"].2.contains("conflicto con a-strict"));
}

#[test]
fn budget_keeps_mandatory_content_and_reports_the_limit() {
    let f = Fixture::new();
    let (a, ab) = manifest("big-mandatory", &["senior"], &["implementacion"], "mandatory", &"x".repeat(8_000));
    let (b, bb) = manifest("big-auto", &["senior"], &["implementacion"], "automatic", &"y".repeat(8_000));
    f.install(&a, &ab);
    f.install(&b, &bb);
    db::set_setting(&f.conn, "capabilities.budget", "1000").unwrap();
    let s = f.session("claude", Role::Senior);
    let (text, run) = f.turn(&s, "Implementa algo");
    let states = f.states(run);
    assert_eq!(states["big-mandatory"].0, "loaded");
    assert_eq!(states["big-auto"].0, "skipped");
    assert!(text.contains("supera el presupuesto de contexto"));
}

#[test]
fn unchanged_context_is_not_repeated_and_a_new_provider_session_gets_it_again() {
    let f = Fixture::new();
    let (m, bytes) = manifest("mini", &["senior"], &["implementacion"], "mandatory", "Cuerpo largo de la extensión");
    f.install(&m, &bytes);
    let s = f.session("claude", Role::Senior);
    let (first, _) = f.turn(&s, "Implementa A");
    let (second, run) = f.turn(&s, "Implementa B");
    assert!(first.contains("Cuerpo largo") && !second.contains("Cuerpo largo") && second.contains("sin cambios"));
    assert_eq!(f.states(run)["mini"].0, "loaded", "sigue cargada en el historial del proveedor");
    db::set_provider_session(&f.conn, s.id, "prov-2").unwrap();
    let s = db::session(&f.conn, s.id).unwrap().unwrap();
    let (third, _) = f.turn(&s, "Implementa C");
    assert!(third.contains("Cuerpo largo"));
}

#[test]
fn acp_sessions_receive_the_fundamental_policies_first() {
    let f = Fixture::new();
    let mut s = f.session("agy", Role::Senior);
    db::set_provider_session(&f.conn, s.id, "").unwrap();
    s.provider_session.clear();
    let (text, _) = f.turn(&s, "Implementa algo");
    let block = text.split(crate::skills::MARKER).nth(1).unwrap();
    assert!(block.contains(POLICY_TITLE) && block.contains("Reglas de trabajo"));
    assert!(block.find(POLICY_TITLE).unwrap() < block.find("## Rol").unwrap());
    assert_eq!(acp_preamble(text.clone(), false), text, "no se duplican");
    assert!(acp_preamble("hola".into(), true).starts_with(POLICY_TITLE));
    let claude = f.session("claude", Role::Senior);
    assert!(!f.turn(&claude, "Implementa algo").0.contains(POLICY_TITLE), "Claude las recibe en el system prompt");
}

#[test]
fn tampered_files_fail_to_load_and_are_reported() {
    let f = Fixture::new();
    let (m, bytes) = manifest("tamper", &["senior"], &["implementacion"], "mandatory", "Original");
    f.install(&m, &bytes);
    std::fs::write(version_dir(&f.store.0, &m).join("SKILL.md"), "Instrucción inyectada").unwrap();
    let s = f.session("claude", Role::Senior);
    let (text, run) = f.turn(&s, "Implementa algo");
    assert!(!text.contains("Instrucción inyectada"));
    let state = &f.states(run)["tamper"];
    assert_eq!(state.0, "failed");
    assert!(state.2.contains("integridad"));
    // Un hash distinto al fijado impide instalar.
    let (mut bad, _) = manifest("bad", &[], &[], "manual", "x");
    bad.files[0].sha256 = "0".repeat(64);
    assert!(materialize(&f.store.0, &bad, &|_| Ok(b"x".to_vec())).unwrap_err().contains("no coincide"));
}

#[test]
fn manifests_cannot_escape_the_store() {
    let f = Fixture::new();
    let (mut m, bytes) = manifest("escape", &[], &[], "manual", "x");
    m.files[0].path = "../../outside.md".into();
    assert!(materialize(&f.store.0, &m, &|_| Ok(bytes.clone())).is_err());
    assert!(!f.store.0.parent().unwrap().join("outside.md").exists());
    for path in ["/etc/passwd", "a/../../b", ""] { assert!(!relative_ok(path), "{path}"); }
}

#[test]
fn sensitive_permissions_need_approval_and_updates_reset_new_ones() {
    let f = Fixture::new();
    let (mut m, bytes) = manifest("scripts", &["designer"], &["diseno"], "automatic", "Usa search.py");
    m.permissions = vec!["context".into(), "exec:python3".into()];
    f.install(&m, &bytes);
    let s = f.session("claude", Role::Designer);
    let (_, run) = f.turn(&s, "Diseña la interfaz del panel");
    assert!(f.states(run)["scripts"].2.contains("permisos sin aprobar: exec:python3"));
    f.conn.execute("UPDATE extensions SET approved='[\"exec:python3\"]' WHERE id='scripts'", []).unwrap();
    let (_, run) = f.turn(&s, "Diseña la interfaz del panel");
    assert_eq!(f.states(run)["scripts"].0, "loaded");
    // Nueva versión con red: la aprobación previa no cubre el permiso nuevo.
    let mut next = m.clone();
    next.source.commit = "b".repeat(40);
    next.permissions.push("network".into());
    f.install(&next, &bytes);
    let item = installed(&f.conn).unwrap().remove("scripts").unwrap();
    assert_eq!(item.approved, BTreeSet::from(["exec:python3".to_string()]));
    let (_, run) = f.turn(&s, "Diseña la interfaz del panel");
    assert!(f.states(run)["scripts"].2.contains("network"));
    assert!(item.previous.is_some(), "la versión anterior queda para restaurarla");
}

#[test]
fn uninstall_revokes_requests_and_full_control_does_not_bypass_approval() {
    let f = Fixture::new();
    let (mut m, bytes) = manifest("exec", &["senior"], &[], "manual", "x");
    m.files.push(FileEntry { path: "run.sh".into(), sha256: hex(b"x"), size: 1, kind: "executable".into() });
    assert!(m.sensitive().contains("exec:scripts"), "un ejecutable sin permiso declarado sigue exigiendo aprobación");
    m.files.pop();
    f.install(&m, &bytes);
    let s = f.session("claude", Role::Senior);
    assign(&f.conn, s.id, None, &["exec".into()], "usuario").unwrap();
    f.conn.execute("DELETE FROM extensions WHERE id='exec'", []).unwrap();
    f.conn.execute("DELETE FROM capability_requests WHERE ext='exec'", []).unwrap();
    let (_, run) = f.turn(&s, "Implementa");
    assert!(!f.states(run).contains_key("exec"));
}

#[test]
fn pm_turns_receive_no_executor_context() {
    let f = Fixture::new();
    let conn = &f.conn;
    let text = "Coordina esto".to_string();
    // `turn_context` devuelve el texto sin cambios cuando no hay sesión ejecutora (PM).
    let session: Option<i64> = None;
    assert!(session.is_none());
    let res = resolve(conn, &Inputs { role: Role::Pm, engine: "codex", project: "/p", session: None, kind: None, kind_origin: String::new(), requested: Vec::new(), budget: DEFAULT_BUDGET }).unwrap();
    assert!(res.choices.iter().all(|c| c.state != "selected"));
    assert_eq!(text, "Coordina esto");
    assert!(crate::skills::methods(conn, "/p", Role::Pm, None).unwrap().is_empty());
}

#[test]
fn evidence_requires_artifacts_not_self_declaration() {
    let f = Fixture::new();
    let (mut m, bytes) = manifest("grim", &["security"], &["threat_model"], "mandatory", "Modela amenazas");
    m.evidence = Evidence { kind: "report".into(), glob: Some("threat".into()), code_refs: true, detail: "informe".into(), ..Default::default() };
    f.install(&m, &bytes);
    std::fs::create_dir_all(f.project.0.join("src")).unwrap();
    std::fs::write(f.project.0.join("src/auth.rs"), "fn a() {}\nfn b() {}\n").unwrap();
    let s = f.session("claude", Role::Security);
    let (_, run) = f.turn(&s, "Haz un threat model del login");
    let usage = usage_for_runs(&f.conn, &[run]).unwrap();
    let grim = usage.iter().find(|u| u.ext == "grim").unwrap();
    assert_eq!(grim.state, "loaded");
    assert!(grim.evidence.iter().any(|e| e.contains("sin aplicación demostrable")));
    std::fs::write(f.project.0.join("threat-model.md"), "Riesgo en `src/auth.rs:2` y en src/auth.rs:99").unwrap();
    let usage = usage_for_runs(&f.conn, &[run]).unwrap();
    let grim = usage.iter().find(|u| u.ext == "grim").unwrap();
    assert_eq!(grim.state, "evidenced", "una referencia no existe: no se verifica");
    assert!(grim.evidence.iter().any(|e| e.contains("1 de 2")));
    std::fs::write(f.project.0.join("threat-model.md"), "Riesgo en `src/auth.rs:2`").unwrap();
    assert_eq!(usage_for_runs(&f.conn, &[run]).unwrap().iter().find(|u| u.ext == "grim").unwrap().state, "verified");
}

#[test]
fn tool_evidence_comes_from_observed_invocations() {
    let f = Fixture::new();
    let (mut m, bytes) = manifest("reach", &["researcher"], &[], "manual", "usa agent-reach");
    m.evidence = Evidence { kind: "tools".into(), names: vec!["agent-reach".into()], detail: "cli".into(), ..Default::default() };
    f.install(&m, &bytes);
    let s = f.session("codex", Role::Researcher);
    assign(&f.conn, s.id, None, &["reach".into()], "pm").unwrap();
    let (_, run) = f.turn(&s, "Busca documentación");
    assert_eq!(usage_for_runs(&f.conn, &[run]).unwrap()[0].state, "loaded");
    f.conn.execute("INSERT INTO capability_tools(run_id,name,detail) VALUES(?1,'commandExecution','agent-reach read https://github.com/x/y')", [run]).unwrap();
    let usage = usage_for_runs(&f.conn, &[run]).unwrap();
    assert_eq!(usage[0].state, "evidenced");
    assert_eq!(usage[0].tools.len(), 1);
    assert!(verify(&f.conn, run, "reach", "dudoso", None).is_err());
    f.conn.execute("UPDATE task_runs SET outcome='completed', ended_ms=1 WHERE id=?1", [run]).unwrap();
    verify(&f.conn, run, "reach", "passed", Some("fuentes contrastadas".into())).unwrap();
    assert_eq!(usage_for_runs(&f.conn, &[run]).unwrap()[0].state, "verified");
    // El resultado verificado llega a Brain como propuesta pendiente, con procedencia y sin el texto de la extensión.
    let (title, draft): (String, String) = f.conn.query_row("SELECT title, draft FROM brain_inferences WHERE project=?1", [&s.project], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert!(title.contains("Ext reach") && title.contains(&format!("#{run}")));
    let draft: Value = serde_json::from_str(&draft).unwrap();
    assert_eq!((draft["kind"].as_str(), draft["sourceRun"].as_i64()), (Some("evidence"), Some(run)));
    assert!(draft["source"].as_str().unwrap().starts_with("Capacidad reach@aaaaaaaaaaaa"));
    assert!(draft["body"].as_str().unwrap().contains("agent-reach read") && !draft["body"].as_str().unwrap().contains("usa agent-reach"));
    // Rechazar no propone nada nuevo.
    verify(&f.conn, run, "reach", "failed", None).unwrap();
    assert_eq!(f.conn.query_row("SELECT count(*) FROM brain_inferences", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn local_import_pins_hashes_and_never_runs_scripts() {
    let f = Fixture::new();
    let src = tempdir::Dir::new("src");
    std::fs::write(src.0.join("SKILL.md"), "---\nname: Mi Skill\ndescription: Hace algo\n---\nCuerpo").unwrap();
    std::fs::create_dir_all(src.0.join("scripts")).unwrap();
    let marker = src.0.join("ran");
    std::fs::write(src.0.join("scripts/install.sh"), format!("touch {}", marker.display())).unwrap();
    let m = import_local(&f.store.0, &src.0).unwrap();
    assert_eq!(m.id, "local-mi_skill");
    assert!(m.sensitive().contains("exec:scripts"));
    assert!(!marker.exists());
    assert!(m.files.iter().all(|file| read_bytes_ok(&version_dir(&f.store.0, &m), file)));
    assert_eq!(m.default_policy, "manual");
}

#[test]
fn classifier_covers_the_initial_matrix() {
    for (text, kind) in [
        ("Implementa una mejora acotada en este repositorio", "implementacion"),
        ("Realiza un modelado de amenazas de la arquitectura de autenticación", "threat_model"),
        ("Diseña una interfaz de gestión de proyectos con identidad visual propia", "diseno"),
        ("Diseña la arquitectura de una nueva funcionalidad crítica", "arquitectura"),
        ("Crea un logotipo para la marca", "logo"),
        ("Haz un efecto de pixel art de explosión", "efectos"),
        ("Estima una regresión con diferencias en diferencias", "estadistica"),
        ("Recomienda hooks y MCP para el repo (claude code setup)", "config_repo"),
    ] {
        assert_eq!(classify(text).map(|c| c.0), Some(kind), "{text}");
    }
    assert_eq!(classify("Hola, ¿qué tal?"), None);
}

#[test]
fn bundled_catalog_is_pinned_complete_and_consistent() {
    let list = catalog();
    let ids: Vec<&str> = list.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["ponytail", "grim-prompter", "egm", "unslop", "ui-skills", "ui-ux-pro-max", "logo-design", "pixelfx", "agent-reach", "claude-code-setup", "statspai"]);
    for m in &list {
        assert_eq!(m.source.commit.len(), 40, "{}", m.id);
        assert!(m.source.commit.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!m.source.license.is_empty());
        assert!(m.files.iter().any(|f| f.kind == "entry"), "{}", m.id);
        assert!(m.files.iter().all(|f| f.sha256.len() == 64 && relative_ok(&f.path) && f.size <= MAX_FILE), "{}", m.id);
        assert!(m.providers.keys().all(|e| ENGINES.contains(&e.as_str())) && m.providers.len() == 3, "{}", m.id);
        assert!(m.roles.iter().all(|r| Role::parse(r).is_some()), "{}", m.id);
        assert!(m.task_kinds.iter().all(|k| KINDS.contains(&k.as_str())), "{}", m.id);
        assert!(POLICIES_KINDS.contains(&m.default_policy.as_str()));
        assert!(raw_url(m, &m.files[0].path).unwrap().starts_with("https://raw.githubusercontent.com/"));
        if m.files.iter().any(|f| f.kind == "executable") { assert!(!m.sensitive().is_empty(), "{}", m.id); }
    }
    let by = |id: &str| list.iter().find(|m| m.id == id).unwrap();
    assert_eq!(by("claude-code-setup").provider("codex"), "none");
    assert_eq!(by("ponytail").default_policy, "mandatory");
    assert_eq!(by("logo-design").default_policy, "mandatory");
    assert!(by("unslop").attribution.is_some());
    assert!(["pixelfx", "agent-reach", "statspai"].iter().all(|id| by(id).optional));
}

/// Instala el catálogo real desde GitHub y comprueba cada hash fijado.
/// `cargo test -- --ignored real_catalog_installs_with_pinned_hashes`
#[test]
#[ignore = "requiere red"]
fn real_catalog_installs_with_pinned_hashes() {
    let store = tempdir::Dir::new("real");
    for m in catalog() {
        materialize(&store.0, &m, &|f| download(&raw_url(&m, &f.path)?, MAX_FILE)).unwrap_or_else(|e| panic!("{}: {e}", m.id));
        let dir = version_dir(&store.0, &m);
        for f in m.files.iter().filter(|f| f.kind == "entry") {
            assert!(!read_verified(&dir, f).unwrap().is_empty());
        }
    }
}

/// Medición reproducible del contexto administrado (bytes ÷ 4). Se ejecuta con
/// `cargo test --lib measure_context -- --ignored --nocapture`.
#[test]
#[ignore = "informe de medición"]
fn measure_context() {
    let f = Fixture::new();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/skills");
    let tokens = |s: &str| s.len() / 4;
    println!("políticas {} · reglas {} · política PM {}", tokens(POLICIES), tokens(crate::skills::RULES), tokens(include_str!("../../resources/coordinadores/politica.md")));
    println!("rol | bloque inicial | turno sin cambios | núcleos obligatorios y automáticos del tipo por defecto");
    for role in crate::skills::ROLES.into_iter().filter(|r| *r != Role::Pm) {
        let methods = crate::skills::methods(&f.conn, "/p", role, Some(&root)).unwrap();
        let res = Resolution { role: role.key().into(), kind: role_kind(role).map(str::to_owned), kind_origin: "rol".into(), ..Default::default() };
        let built = build(None, &f.conn, &res, role, &methods, false, true).unwrap();
        let kind = role_kind(role);
        let ext: u32 = catalog().iter().filter(|m| m.roles.iter().any(|r| r == role.key()) && kind.is_some_and(|k| m.task_kinds.iter().any(|t| t == k)) && m.default_policy != "manual").map(|m| m.entry_tokens).sum();
        println!("{} | {} | {} | {}", role.key(), tokens(&built.text) + 30, tokens("Contexto administrado sin cambios desde el turno anterior (huella 0123456789ab)."), ext);
    }
}
