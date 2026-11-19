import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, git, sessions, tools as toolsApi, type DiffTarget, type Session, type Tool, type Workspace } from './ipc';
import Onboarding from './Onboarding';
import Sidebar from './Sidebar';
import Editor from './Editor';
import Diff from './Diff';
import GitPanel, { Icon, RightHeader } from './GitPanel';
import Terminal from './Terminal';
import Coordinator from './Coordinator';
import SessionView, { ENGINE_LABEL } from './Session';
import Tasks from './Tasks';
import CodeHealth from './CodeHealth';
import DesignLoop from './DesignLoop';
import Larry from './Larry';
import Publish from './Publish';
import Pending from './Pending';
import Tools, { toolState } from './Tools';
import UsagePanel, { UsageSummary } from './Usage';
import { Cheatsheet, Palette, type Command } from './Palette';
import { emit, toggleMute, useUi } from './ui';
import Conflicts from './Conflicts';
import Containers from './Containers';
import Splitter, { SIZES } from './Splitter';

// Motores de sesión. Uno no disponible se muestra desactivado con el motivo.
const ENGINES: [string, string, string | null][] = [
  ['codex', 'chat directo · codex', null],
  ['claude', 'chat directo · claude code', null],
  ['opencode', 'opencode', null],
  ['agy', 'antigravity', null],
  ['devin', 'devin', null],
];

// `session`: terminal en el worktree de una sesión aislada (su nombre como etiqueta).
type TerminalTab = { id: number; project: string; number: number; session?: number; label?: string; initial?: string };

export default function App() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  // Sesión a la que pertenece el archivo abierto (su worktree), si alguna.
  const [fileSession, setFileSession] = useState<number | null>(null);
  // Cada pestaña tiene su propio PTY. Siguen vivos al cambiar de proyecto.
  const [terms, setTerms] = useState<TerminalTab[]>([]);
  const [selectedTerm, setSelectedTerm] = useState<Record<string, number>>({});
  const nextTermId = useRef(1);
  const [termOpen, setTermOpen] = useState(false);
  // Pestaña activa: el coordinador o el archivo/diff abierto.
  // Un número es el id de una sesión de agente.
  const [view, setView] = useState<'coach' | 'file' | 'larry' | 'publish' | 'pending' | 'tools' | 'conflicts' | 'tasks' | 'health' | 'design' | number>('coach');
  const [coachTask, setCoachTask] = useState<{ id: number; title: string } | null>(null);
  const [publishKey, setPublishKey] = useState<number | null>(null);
  // Larry y Publicar trabajan en el proyecto o en la rama de una sesión.
  const [publishFor, setPublishFor] = useState<Session | null>(null);
  const [larryFor, setLarryFor] = useState<Session | null>(null);
  // Ramas de sesiones cerradas sin integrar: cuántas hay y su vista.
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingKey, setPendingKey] = useState<number | null>(null);
  // CLI externas: se comprueban al arrancar y desde su vista.
  const [toolList, setToolList] = useState<Tool[] | null>(null);
  const [checkingTools, setCheckingTools] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  // Archivos con marcas de conflicto tras una integración.
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);
  // Columna derecha: Git o contenedores Docker del proyecto.
  const [rightView, setRightView] = useState<'git' | 'containers'>('git');
  const [, setContainerCount] = useState<number | null>(null);
  // Larry abierto (su pestaña) y una clave para relanzarlo.
  const [larryKey, setLarryKey] = useState<number | null>(null);
  const [coach, setCoach] = useState('hansi');
  const [agentSessions, setAgentSessions] = useState<Session[]>([]);
  // Proyecto cuya lista de sesiones ya está cargada (mientras carga, vacía).
  const [sessionsOf, setSessionsOf] = useState<string | null>(null);
  const [engineMenu, setEngineMenu] = useState(false);
  // Rama del proyecto abierto (la informa el panel Git) y capas flotantes.
  const [branch, setBranch] = useState<string | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [overlay, setOverlay] = useState<'palette' | 'cheat' | null>(null);
  const [noSide, setNoSide] = useState(false);
  const [noRight, setNoRight] = useState(false);
  const { activity, muted } = useUi();

  const openTerminal = useCallback((path: string, newTab = false, initial?: string) => {
    const existing = terms.filter((t) => t.project === path && t.session == null);
    if (!newTab && !initial && existing.length) {
      setSelectedTerm((current) => ({ ...current, [path]: current[path] ?? existing[0].id }));
    } else {
      const id = nextTermId.current++;
      const number = Math.max(0, ...existing.map((t) => t.number)) + 1;
      setTerms((current) => [...current, { id, project: path, number, initial, label: initial?.split(' ')[0] }]);
      setSelectedTerm((current) => ({ ...current, [path]: id }));
    }
    setTermOpen(true);
  }, [terms]);

  const openSessionTerminal = (s: Session) => {
    const existing = terms.find((t) => t.session === s.id);
    if (existing) {
      setSelectedTerm((current) => ({ ...current, [s.project]: existing.id }));
    } else {
      const id = nextTermId.current++;
      setTerms((current) => [...current, { id, project: s.project, number: 0, session: s.id, label: s.name }]);
      setSelectedTerm((current) => ({ ...current, [s.project]: id }));
    }
    setTermOpen(true);
  };

  const closeTerminal = (id: number) => {
    const tab = terms.find((t) => t.id === id);
    if (!tab) return;
    const remaining = terms.filter((t) => t.project === tab.project && t.id !== id);
    setTerms((current) => current.filter((t) => t.id !== id));
    if (selectedTerm[tab.project] === id) {
      if (remaining.length) setSelectedTerm((current) => ({ ...current, [tab.project]: remaining[remaining.length - 1].id }));
      else {
        setSelectedTerm((current) => {
          const next = { ...current };
          delete next[tab.project];
          return next;
        });
        setTermOpen(false);
      }
    }
  };

  const refresh = useCallback(() => {
    api.workspace().then(setWs, (e) => setError(String(e)));
  }, []);

  // Recargar cuando el núcleo detecta cambios en la raíz o al volver a la ventana.
  useEffect(() => {
    refresh();
    let timer: number | undefined;
    const unlisten = listen('workspace-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 250);
    });
    window.addEventListener('focus', refresh);
    return () => {
      window.clearTimeout(timer);
      unlisten.then((off) => off());
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  // Si el proyecto abierto desaparece o se archiva, cerrarlo.
  useEffect(() => {
    if (project && ws && !ws.projects.some((p) => p.path === project && !p.archived)) {
      setProject(null);
      setFile(null);
    }
  }, [ws, project]);

  // Sesiones de agentes del proyecto abierto.
  useEffect(() => {
    setAgentSessions([]);
    setSessionsOf(null);
    if (project)
      sessions.list(project).then(
        (list) => {
          setAgentSessions(list);
          setSessionsOf(project);
        },
        (e) => setError(String(e)),
      );
  }, [project]);

  // El coordinador también crea sesiones al delegar.
  useEffect(() => {
    const unlisten = listen<{ project: string; focus?: number | null }>('sessions-changed', ({ payload }) => {
      if (payload.project !== project) return;
      sessions.list(payload.project).then(
        (list) => {
          setAgentSessions(list);
          // Un relevo lleva a la sesión que continúa la tarea.
          if (payload.focus != null && list.some((s) => s.id === payload.focus)) setView(payload.focus);
        },
        (e) => setError(String(e)),
      );
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [project]);

  const newSession = (engine: string, task: number | null = null) => {
    setEngineMenu(false);
    if (!project) return;
    sessions.create(project, engine, task).then(
      ({ notice, ...s }) => {
        setAgentSessions((list) => [...list, s]);
        setView(s.id);
        if (notice) setError(notice);
      },
      (e) => setError(String(e)),
    );
  };

  const checkTools = useCallback(() => {
    setCheckingTools(true);
    toolsApi
      .status()
      .then(setToolList, (e) => setError(String(e)))
      .finally(() => setCheckingTools(false));
  }, []);
  useEffect(checkTools, [checkTools]);

  const countPending = useCallback(() => {
    if (project) sessions.orphans(project).then((list) => setPendingCount(list.length), () => setPendingCount(0));
  }, [project]);
  useEffect(() => {
    setPendingCount(0);
    countPending();
  }, [countPending, agentSessions]);

  const closeSession = (id: number) => {
    const closing = agentSessions.find((s) => s.id === id);
    sessions.close(id).then(
      () => {
        setAgentSessions((list) => list.filter((s) => s.id !== id));
        setView((v) => (v === id ? 'coach' : v));
        if (closing?.worktree)
          setError(`La rama ${closing.branch} de ${closing.name} se conserva: está en «ramas sin integrar» del panel Git.`);
      },
      (e) => setError(String(e)),
    );
  };

  useEffect(() => {
    setDiff(null);
  }, [project]);

  // Mantener el observador del proyecto y seguir la copia de trabajo visible.
  const worktreeId = typeof view === 'number' ? view
    : view === 'file' ? fileSession
    : view === 'larry' ? larryFor?.id
    : view === 'publish' ? publishFor?.id
    : null;
  const watchedSession = agentSessions.find((s) => s.id === worktreeId && s.project === project && s.worktree)?.id ?? null;
  useEffect(() => {
    git.watch(project, watchedSession).catch((e) => setError(String(e)));
  }, [project, watchedSession]);

  // Si la sesión abierta desaparece (cerrada o limpiada), volver al coordinador.
  useEffect(() => {
    if (typeof view === 'number' && !agentSessions.some((s) => s.id === view)) setView('coach');
  }, [agentSessions, view]);

  // Sus terminales tampoco sobreviven: su carpeta puede haberse borrado.
  useEffect(() => {
    if (sessionsOf !== project) return;
    setTerms((current) => {
      const kept = current.filter((t) => t.session == null || t.project !== project || agentSessions.some((s) => s.id === t.session));
      return kept.length === current.length ? current : kept;
    });
  }, [agentSessions, project, sessionsOf]);

  const openLarry = (s: Session | null = null) => {
    setLarryFor(s);
    setLarryKey(Date.now()); // cada apertura propone de nuevo
    setView('larry');
  };
  const openPublish = (s: Session | null = null) => {
    setPublishFor(s);
    setPublishKey(Date.now());
    setView('publish');
  };
  const closeLarry = () => {
    setLarryKey(null);
    setView((v) => (v === 'larry' ? 'coach' : v));
  };

  const containersHeader = (
    <RightHeader view="containers" branch={branch} onBranch={() => setRightView('git')} onContainers={() => setRightView('containers')} />
  );

  const showConflicts = (files: string[]) => {
    setConflictFiles(files);
    setView('conflicts');
  };

  const showDiff = (c: DiffTarget) => {
    setDiff(c);
    setView('file');
  };

  const update = (p: Promise<Workspace>) => p.then(setWs, (e) => setError(String(e)));

  // Atajos globales: el manejador se rehace en cada render (ve el estado actual).
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // Indicador azul de la pestaña activa, que se desliza entre pestañas.
  const tabsRef = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>('.tab.is-active');
    const next = el ? { x: el.offsetLeft, w: el.offsetWidth } : null;
    setInd((prev) => (prev?.x === next?.x && prev?.w === next?.w ? prev : next));
  });

  const closeFile = () => {
    setFile(null);
    setDiff(null);
    setFileSession(null);
    setView((v) => (v === 'file' ? 'coach' : v));
  };

  if (!ws) return <div className="app" />;
  if (!ws.root) return <Onboarding onDone={setWs} />;

  const current = ws.projects.find((p) => p.path === project);
  const projectTerms = terms.filter((t) => t.project === project);
  const activeTerm = project ? selectedTerm[project] ?? projectTerms[0]?.id : undefined;
  const toggleTerminal = () => {
    if (!current) return;
    if (termOpen) setTermOpen(false);
    else openTerminal(current.path);
  };
  const toolsBad = (toolList ?? []).filter((t) => ['falta', 'sin sesión'].includes(toolState(t))).length;
  const closeActive = () => {
    if (view === 'file') closeFile();
    else if (typeof view === 'number') closeSession(view);
    else if (view === 'larry') closeLarry();
    else if (view === 'publish') {
      setPublishKey(null);
      setView('coach');
    } else if (view === 'pending') {
      setPendingKey(null);
      setView('coach');
    } else if (view === 'conflicts') {
      setConflictFiles(null);
      setView('coach');
    }
  };

  const commands: Command[] = [
    { id: 'palette', label: 'órdenes', keys: '⌘K', run: () => setOverlay('palette') },
    { id: 'cheat', label: 'atajos de teclado', keys: '⌘/', run: () => setOverlay('cheat') },
    { id: 'new', label: 'nueva sesión', keys: '⌘T', run: () => current && setEngineMenu(true) },
    { id: 'close', label: 'cerrar pestaña', keys: '⌘W', run: closeActive },
    { id: 'pm', label: 'project manager', keys: '⌘1', run: () => current && setView('coach') },
    ...agentSessions.slice(0, 8).map((s, i) => ({ id: `s${s.id}`, label: `sesión ${s.name}`, keys: `⌘${i + 2}`, run: () => setView(s.id) })),
    { id: 'term', label: termOpen ? 'ocultar terminal' : 'abrir terminal', keys: '⌘J', run: toggleTerminal },
    { id: 'side', label: noSide ? 'mostrar barra lateral' : 'ocultar barra lateral', keys: '⌘B', run: () => setNoSide((v) => !v) },
    { id: 'right', label: noRight ? 'mostrar columna derecha' : 'ocultar columna derecha', keys: '⌘I', run: () => setNoRight((v) => !v) },
    { id: 'git', label: 'git', keys: '⌘G', run: () => (setNoRight(false), setRightView('git')) },
    { id: 'containers', label: 'contenedores', keys: '⌘⇧O', run: () => (setNoRight(false), setRightView('containers')) },
    { id: 'commit', label: 'commit', keys: '⌘⇧C', run: () => emit('commit') },
    { id: 'commit-push', label: 'commit y push', keys: '⌘⇧P', run: () => emit('commit-push') },
    { id: 'larry', label: 'larry propone de nuevo', keys: '⌘⇧G', run: () => emit('larry') },
    { id: 'send', label: 'enviar mensaje', keys: '⌘↩', run: () => {} },
    { id: 'stop', label: 'interrumpir', keys: '⌘.', run: () => {} },
    { id: 'model', label: 'modelo', keys: '⌘M', run: () => {} },
    { id: 'effort', label: 'esfuerzo', keys: '⌘⇧E', run: () => {} },
    { id: 'allow', label: 'aprobar permiso', keys: '⌘Y', run: () => {} },
    { id: 'deny', label: 'rechazar permiso', keys: '⌘N', run: () => {} },
    { id: 'usage', label: 'uso de los modelos', keys: '⌘U', run: () => setUsageOpen((v) => !v) },
    { id: 'mute', label: muted ? 'activar sonido' : 'silenciar', keys: '⌘⇧M', run: () => toggleMute() },
    { id: 'theme', label: 'cambiar tema', keys: '⌘⇧L', run: () => document.documentElement.classList.toggle('is-light') },
  ];
  // Atajos que resuelve la vista visible (conversación, editor).
  const LOCAL = new Set(['send', 'stop', 'model', 'effort', 'allow', 'deny']);
  const KEY: Record<string, string> = { Enter: '↩', Period: '.', Slash: '/', Backquote: '`' };
  keys.current = (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) {
      if (e.ctrlKey && e.code === 'Backquote') toggleTerminal();
      return;
    }
    const k = KEY[e.code] ?? e.code.replace(/^Key|^Digit/, '');
    const combo = `⌘${e.shiftKey ? '⇧' : ''}${k}`;
    if (combo === '⌘`') return;
    const c = commands.find((x) => x.keys === combo && !LOCAL.has(x.id));
    if (!c) return;
    // ⌘P lo usa el editor (abrir archivo); ⌘W cierra la pestaña y no la ventana.
    e.preventDefault();
    e.stopPropagation();
    if (overlay && c.id !== overlay) setOverlay(null);
    if (c.id === overlay) return setOverlay(null);
    c.run();
  };

  return (
    <div className={`app${current && !noRight ? ' has-git' : ''}${noSide ? ' no-side' : ''}`}>
      <Sidebar
        ws={ws}
        project={project}
        file={file}
        onProject={(p) => {
          setProject(p);
          setCoachTask(null);
          setFile(null);
          setView('coach');
          setLarryKey(null);
          setPublishKey(null);
          setPendingKey(null);
          setConflictFiles(null);
          setContainerCount(null);
        }}
        onFile={(f) => {
          setFile(f);
          setFileSession(null);
          setDiff(null);
          setView('file');
        }}
        onUpdate={update}
      />
      <Splitter size={SIZES.side} axis="x" label="Ancho de la barra lateral" className="is-side" />
      <div className="tabs" data-tauri-drag-region ref={tabsRef}>
        {ind && <span className="tab-ind" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} aria-hidden="true" />}
        {current && (
          <div className={`tab${view === 'coach' ? ' is-active' : ''}${activity.coach ? ` is-${activity.coach}` : ''}`}>
            <button onClick={() => setView('coach')} title="modo automático · project manager · ⌘1">
              {coach.replace('-', ' ')}
            </button>
            <span className="tag">pm</span>
            {activity.coach === 'permiso' && <span className="ask-dot" aria-label="pide permiso" />}
          </div>
        )}
        {current && <div className={`tab${view === 'tasks' ? ' is-active' : ''}`}>
          <button onClick={() => setView('tasks')}>tareas</button>
        </div>}
        {current && <div className={`tab${view === 'health' ? ' is-active' : ''}`}>
          <button onClick={() => setView('health')}>Code Health</button>
        </div>}
        {current && <div className={`tab${view === 'design' ? ' is-active' : ''}`}>
          <button onClick={() => setView('design')}>Design Loop</button>
        </div>}
        {current &&
          agentSessions.map((s) => (
            <div className={`tab${view === s.id ? ' is-active' : ''}${activity[String(s.id)] ? ` is-${activity[String(s.id)]}` : ''}`} key={s.id}>
              <button onClick={() => setView(s.id)} title={`${ENGINE_LABEL[s.engine] ?? s.engine}`}>
                {s.name}
              </button>
              {activity[String(s.id)] === 'permiso' && <span className="ask-dot" aria-label="pide permiso" />}
              <button className="tab-close" aria-label={`Cerrar la sesión ${s.name}`} title="cerrar sesión" onClick={() => closeSession(s.id)}>
                ×
              </button>
            </div>
          ))}
        {current && (
          <div className="tab-new">
            <button aria-label="Nueva sesión de agente" aria-expanded={engineMenu} title="nueva sesión · ⌘T" onClick={() => setEngineMenu((o) => !o)}>
              <Icon name="plus" size={12} />
            </button>
            {engineMenu && (
              <div className="menu engine-menu" role="menu" onMouseLeave={() => setEngineMenu(false)}>
                {ENGINES.map(([id, label, reason]) => (
                  <button key={id} role="menuitem" disabled={!!reason} title={reason ?? undefined} onClick={() => newSession(id)}>
                    {label}
                    {reason && <span className="muted"> · {reason}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {current && larryKey != null && (
          <div className={`tab${view === 'larry' ? ' is-active' : ''}`}>
            <button onClick={() => setView('larry')}>larry{larryFor ? ` · ${larryFor.name}` : ''}</button>
            <button className="tab-close" aria-label="Cerrar Larry" title="cerrar" onClick={() => closeLarry()}>
              ×
            </button>
          </div>
        )}
        {current && conflictFiles && (
          <div className={`tab${view === 'conflicts' ? ' is-active' : ''}`}>
            <button onClick={() => setView('conflicts')}>conflictos</button>
            <button
              className="tab-close"
              aria-label="Cerrar conflictos"
              title="cerrar"
              onClick={() => {
                setConflictFiles(null);
                setView((v) => (v === 'conflicts' ? 'coach' : v));
              }}
            >
              ×
            </button>
          </div>
        )}
        {toolsOpen && (
          <div className={`tab${view === 'tools' ? ' is-active' : ''}`}>
            <button onClick={() => setView('tools')}>herramientas</button>
            <button
              className="tab-close"
              aria-label="Cerrar herramientas"
              title="cerrar"
              onClick={() => {
                setToolsOpen(false);
                setView((v) => (v === 'tools' ? 'coach' : v));
              }}
            >
              ×
            </button>
          </div>
        )}
        {current && pendingKey != null && (
          <div className={`tab${view === 'pending' ? ' is-active' : ''}`}>
            <button onClick={() => setView('pending')}>ramas sin integrar</button>
            <button
              className="tab-close"
              aria-label="Cerrar ramas sin integrar"
              title="cerrar"
              onClick={() => {
                setPendingKey(null);
                setView((v) => (v === 'pending' ? 'coach' : v));
              }}
            >
              ×
            </button>
          </div>
        )}
        {current && publishKey != null && (
          <div className={`tab${view === 'publish' ? ' is-active' : ''}`}>
            <button onClick={() => setView('publish')}>publicar{publishFor ? ` · ${publishFor.name}` : ''}</button>
            <button
              className="tab-close"
              aria-label="Cerrar publicar"
              title="cerrar"
              onClick={() => {
                setPublishKey(null);
                setView((v) => (v === 'publish' ? 'coach' : v));
              }}
            >
              ×
            </button>
          </div>
        )}
        {current && (diff || file) && (
          <div className={`tab${view === 'file' ? ' is-active' : ''}`}>
            <button onClick={() => setView('file')} title={diff?.path ?? file ?? ''}>
              {(diff?.path ?? file ?? '').split(/[\\/]/).pop()}
              {diff && <span className="muted">diff</span>}
            </button>
            <button className="tab-close" aria-label="Cerrar el archivo" title="cerrar · ⌘W" onClick={closeFile}>
              ×
            </button>
          </div>
        )}
      </div>
      <main className="main">
        <div className="main-view">
          {current && <Coordinator key={current.path} project={current.path} onDiff={showDiff} onProfile={setCoach} hidden={view !== 'coach'} task={coachTask} onClearTask={() => setCoachTask(null)} />}
          {current && <Tasks key={current.path} project={current.path} hidden={view !== 'tasks'} sessions={agentSessions}
            onAuto={(task) => { setCoachTask(task); setView('coach'); }}
            onDirect={newSession} onSession={setView} onPublish={openPublish} />}
          {current && view === 'health' && <CodeHealth key={current.path} project={current.path} sessions={agentSessions}
            onFile={(path, id) => {
              setFile(path);
              setFileSession(id);
              setDiff(null);
              setView('file');
            }} />}
          {current && <DesignLoop key={current.path} project={current.path} sessions={agentSessions} hidden={view !== 'design'}
            onNew={() => newSession('claude')} onSession={setView} />}
          {current && conflictFiles && (
            <Conflicts
              project={current.path}
              files={conflictFiles}
              hidden={view !== 'conflicts'}
              onOpenFile={(path) => {
                setFile(path);
                setFileSession(null);
                setDiff(null);
                setView('file');
              }}
            />
          )}
          {toolsOpen && (
            <Tools
              tools={toolList}
              checking={checkingTools}
              hidden={view !== 'tools'}
              onRefresh={checkTools}
              onLogin={current ? (command) => openTerminal(current.path, true, command) : null}
            />
          )}
          {current && pendingKey != null && (
            <Pending key={pendingKey} project={current.path} hidden={view !== 'pending'} onDiff={showDiff} onChanged={countPending} onConflicts={showConflicts} />
          )}
          {current && publishKey != null && <Publish key={publishKey} project={current.path} session={publishFor?.id ?? null} hidden={view !== 'publish'} />}
          {current && larryKey != null && (
            <Larry key={larryKey} project={current.path} session={larryFor} hidden={view !== 'larry'} onDiff={showDiff} onDone={() => closeLarry()} />
          )}
          {current &&
            agentSessions.map((s) => (
              <SessionView key={s.id} session={s} project={current.path} hidden={view !== s.id} onDiff={showDiff} onTerminal={() => openSessionTerminal(s)} onCommits={() => openLarry(s)} onPublish={() => openPublish(s)} onOpenFile={(path) => {
                setFile(path);
                setFileSession(s.id);
                setDiff(null);
                setView('file');
              }} onConflicts={showConflicts} />
            ))}
          {view === 'file' && current && diff ? (
            <Diff project={current.path} change={diff} />
          ) : view === 'file' && file ? (
            <Editor
              path={file}
              root={agentSessions.find((s) => s.id === fileSession)?.worktree ?? current?.path ?? ''}
              session={fileSession}
              onError={setError}
            />
          ) : (
            !current && !(toolsOpen && view === 'tools') && <div className="empty" />
          )}
        </div>
        <section className="terminal" aria-label="Terminal" hidden={!(current && termOpen)}>
          <Splitter size={SIZES.term} axis="y" invert label="Altura del terminal" className="is-term" />
          <div className="terminal-head">
            <span>terminal</span>
            <div className="terminal-tabs" role="tablist" aria-label="Terminales del proyecto">
              {projectTerms.map((tab) => (
                <div className={`terminal-tab${tab.id === activeTerm ? ' is-active' : ''}`} key={tab.id}>
                  <button
                    role="tab"
                    aria-selected={tab.id === activeTerm}
                    onClick={() => setSelectedTerm((s) => ({ ...s, [tab.project]: tab.id }))}
                  >
                    {tab.label ?? tab.number}
                  </button>
                  <button className="terminal-close" aria-label={`Cerrar terminal ${tab.label ?? tab.number}`} title="cerrar terminal" onClick={() => closeTerminal(tab.id)}>×</button>
                </div>
              ))}
              <button className="terminal-new" aria-label="Nuevo terminal" title="nuevo terminal" onClick={() => current && openTerminal(current.path, true)}>+</button>
            </div>
            <button className="push status-ic" onClick={() => setTermOpen(false)} aria-label="Ocultar el terminal" title="ocultar · ⌘J">
              <Icon name="close" size={12} />
            </button>
          </div>
          {terms
            .filter((t) => ws.projects.some((w) => w.path === t.project))
            .map((t) => (
              <Terminal key={t.id} project={t.project} agentSession={t.session ?? null} initial={t.initial} hidden={!termOpen || t.project !== project || t.id !== activeTerm} />
            ))}
        </section>
      </main>
      {current &&
        !noRight &&
        (rightView === 'git' ? (
          <GitPanel onContainers={() => setRightView('containers')} onBranch={setBranch} project={current.path} selected={diff?.session == null ? diff : null} onDiff={showDiff} pending={pendingCount} onPending={() => {
            setPendingKey(Date.now());
            setView('pending');
          }} onPublish={() => openPublish()} />
        ) : (
          <Containers key={current.path} project={current.path} header={containersHeader} onCount={setContainerCount} />
        ))}
      <footer className="status">
        <span className="status-path" title={current?.path ?? ws.root}>
          {(() => {
            const full = (current?.path ?? ws.root).replace(/^\/Users\/[^/]+/, '~');
            const cut = full.lastIndexOf('/');
            return current ? (
              <>
                <span>{full.slice(0, cut + 1)}</span>
                <b>{full.slice(cut + 1)}</b>
              </>
            ) : (
              full
            );
          })()}
        </span>
        {current && (
          <button className={`status-ic${termOpen ? ' is-on' : ''}`} onClick={toggleTerminal} aria-label={termOpen ? 'Ocultar el terminal' : 'Abrir el terminal'} title={`${termOpen ? 'ocultar' : 'abrir'} terminal · ⌘J`}>
            <Icon name="terminal" size={13} />
          </button>
        )}
        {error && (
          <button className="status-error" onClick={() => setError(null)} title="cerrar">
            {error}
          </button>
        )}
        <span className="push" />
        {muted && (
          <button className="status-ic" onClick={() => toggleMute()} aria-label="Activar el sonido" title="silenciado · ⌘⇧M">
            <Icon name="mute" size={13} />
          </button>
        )}
        <button className={`status-usage${usageOpen ? ' is-on' : ''}${toolsBad ? ' is-warn' : ''}`} onClick={() => setUsageOpen((v) => !v)} title={toolsBad ? `${toolsBad} herramienta${toolsBad === 1 ? '' : 's'} por revisar · ⌘U` : 'uso · ⌘U'}>
          <UsageSummary />
          {toolsBad > 0 && <span className="ask-dot" aria-hidden="true" />}
        </button>
        {usageOpen && (
          <UsagePanel
            tools={toolList}
            checking={checkingTools}
            onRefresh={checkTools}
            onLogin={current ? (command) => (setUsageOpen(false), openTerminal(current.path, true, command)) : null}
            onClose={() => setUsageOpen(false)}
          />
        )}
      </footer>
      {overlay === 'palette' && <Palette commands={commands.filter((c) => c.id !== 'palette' && !LOCAL.has(c.id))} onClose={() => setOverlay(null)} />}
      {overlay === 'cheat' && <Cheatsheet commands={commands} onClose={() => setOverlay(null)} />}
    </div>
  );
}
