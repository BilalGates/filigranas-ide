import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, git, sessions, tools as toolsApi, type DiffTarget, type Session, type Tool, type Workspace } from './ipc';
import Onboarding from './Onboarding';
import Sidebar from './Sidebar';
import Editor from './Editor';
import Diff from './Diff';
import GitPanel, { Icon } from './GitPanel';
import Right, { RIGHT_TABS, type RightTab } from './Right';
import FileTree from './FileTree';
import Terminal from './Terminal';
import Coordinator from './Coordinator';
import SessionView, { ENGINE_LABEL } from './Session';
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
  ['claude', 'claude code', null],
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
  const [view, setView] = useState<'coach' | 'file' | 'larry' | 'publish' | 'pending' | 'tools' | 'conflicts' | number>('coach');
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
  // Columna derecha: git, pull requests, contenedores o uso.
  const [rightView, setRightView] = useState<RightTab>('git');
  const [containerCount, setContainerCount] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  // Larry abierto (su pestaña) y una clave para relanzarlo.
  const [larryKey, setLarryKey] = useState<number | null>(null);
  const [coach, setCoach] = useState('hansi');
  const [agentSessions, setAgentSessions] = useState<Session[]>([]);
  // Proyecto cuya lista de sesiones ya está cargada (mientras carga, vacía).
  const [sessionsOf, setSessionsOf] = useState<string | null>(null);
  const [engineMenu, setEngineMenu] = useState(false);
  // Rama del proyecto abierto (la informa el panel Git) y capas flotantes.
  const [branch, setBranch] = useState<string | null>(null);
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

  const newSession = (engine: string) => {
    setEngineMenu(false);
    if (!project) return;
    sessions.create(project, engine).then(
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

  // Observar solo el proyecto abierto.
  useEffect(() => {
    setDiff(null);
    git.watch(project).catch((e) => setError(String(e)));
  }, [project]);

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

  // El archivo o diff abierto es una pestaña más del panel derecho.
  const openEditor = () => {
    setRightView('editor');
    setNoRight(false);
  };
  // Desde el riel: abre ese panel, o lo oculta si ya estaba a la vista.
  const showRight = (tab: RightTab) => {
    if (tab === rightView && !noRight) setNoRight(true);
    else {
      setRightView(tab);
      setNoRight(false);
    }
  };

  const showConflicts = (files: string[]) => {
    setConflictFiles(files);
    setView('conflicts');
  };

  const showDiff = (c: DiffTarget) => {
    setDiff(c);
    openEditor();
  };

  const update = (p: Promise<Workspace>) => p.then(setWs, (e) => setError(String(e)));

  // Atajos globales: el manejador se rehace en cada render (ve el estado actual).
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const closeFile = () => {
    setFile(null);
    setDiff(null);
    setFileSession(null);
    setRightView((v) => (v === 'editor' ? 'git' : v));
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
  const editorOpen = !!(current && (diff || file));
  const closeActive = () => {
    if (editorOpen && rightView === 'editor' && !noRight) closeFile();
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
    { id: 'editor', label: 'editor', keys: '⌘E', run: () => editorOpen && (rightView === 'editor' ? setRightView('git') : openEditor()) },
    { id: 'files', label: 'archivos', keys: '⌘P', run: () => showRight('files') },
    { id: 'term', label: termOpen ? 'ocultar terminal' : 'abrir terminal', keys: '⌘J', run: toggleTerminal },
    { id: 'side', label: noSide ? 'mostrar barra lateral' : 'ocultar barra lateral', keys: '⌘B', run: () => setNoSide((v) => !v) },
    { id: 'right', label: noRight ? 'mostrar columna derecha' : 'ocultar columna derecha', keys: '⌘I', run: () => setNoRight((v) => !v) },
    { id: 'git', label: 'git', keys: '⌘G', run: () => showRight('git') },
    { id: 'pr', label: 'pull request', run: () => openPublish() },
    { id: 'containers', label: 'contenedores', keys: '⌘⇧O', run: () => showRight('containers') },
    { id: 'commit', label: 'commit', keys: '⌘⇧C', run: () => emit('commit') },
    { id: 'commit-push', label: 'commit y push', keys: '⌘⇧P', run: () => emit('commit-push') },
    { id: 'larry', label: 'larry propone de nuevo', keys: '⌘⇧G', run: () => emit('larry') },
    { id: 'send', label: 'enviar mensaje', keys: '⌘↩', run: () => {} },
    { id: 'stop', label: 'interrumpir', keys: '⌘.', run: () => {} },
    { id: 'model', label: 'modelo', keys: '⌘M', run: () => {} },
    { id: 'effort', label: 'esfuerzo', keys: '⌘⇧E', run: () => {} },
    { id: 'allow', label: 'aprobar permiso', keys: '⌘Y', run: () => {} },
    { id: 'deny', label: 'rechazar permiso', keys: '⌘N', run: () => {} },
    { id: 'usage', label: 'uso de los modelos', keys: '⌘U', run: () => showRight('uso') },
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

  const sessionState = (key: string) => activity[key] ?? null;
  const centerTitle = (() => {
    if (!current) return null;
    if (view === 'coach') return { name: coach.replace('-', ' '), meta: 'project manager', tag: 'pm', state: sessionState('coach') };
    if (typeof view === 'number') {
      const s = agentSessions.find((x) => x.id === view);
      return s ? { name: s.name, meta: ENGINE_LABEL[s.engine] ?? s.engine, tag: null, state: sessionState(String(s.id)) } : null;
    }
    const names: Record<string, string> = { larry: larryFor ? `larry · ${larryFor.name}` : 'larry', publish: publishFor ? `publicar · ${publishFor.name}` : 'publicar', pending: 'ramas sin integrar', conflicts: 'conflictos', tools: 'herramientas' };
    return { name: names[view] ?? '', meta: view === 'larry' ? 'commits' : null, tag: null, state: null };
  })();
  const transient = view === 'larry' || view === 'publish' || view === 'pending' || view === 'conflicts' || view === 'tools' || typeof view === 'number';

  const row = (key: string, active: boolean, name: string, meta: string | null, state: string | null, onClick: () => void, onClose?: () => void, tag?: string) => (
    <div key={key} className={`srow${active ? ' is-on' : ''}`}>
      <button className="srow-main" onClick={onClick}>
        <span className={`dot${state ? ` is-${state}` : ''}`} aria-label={state ?? undefined} />
        <span className="srow-name">{name}</span>
        {tag && <span className="tag">{tag}</span>}
        {meta && <span className="srow-meta">{meta}</span>}
      </button>
      {onClose && (
        <button className="srow-x" aria-label={`Cerrar ${name}`} title="cerrar" onClick={onClose}>
          <Icon name="close" size={9} />
        </button>
      )}
    </div>
  );

  const sessionList = current && (
    <div className="sessions" role="list">
      {row('coach', view === 'coach', coach.replace('-', ' '), null, sessionState('coach'), () => setView('coach'), undefined, 'pm')}
      {agentSessions.map((s) => row(`s${s.id}`, view === s.id, s.name, ENGINE_LABEL[s.engine] ?? s.engine, sessionState(String(s.id)), () => setView(s.id), () => closeSession(s.id)))}
      {larryKey != null && row('larry', view === 'larry', larryFor ? `larry · ${larryFor.name}` : 'larry', 'commits', null, () => setView('larry'), closeLarry)}
      {publishKey != null &&
        row('publish', view === 'publish', 'publicar', publishFor?.name ?? null, null, () => setView('publish'), () => {
          setPublishKey(null);
          setView((v) => (v === 'publish' ? 'coach' : v));
        })}
      {pendingKey != null &&
        row('pending', view === 'pending', 'ramas sin integrar', null, null, () => setView('pending'), () => {
          setPendingKey(null);
          setView((v) => (v === 'pending' ? 'coach' : v));
        })}
      {conflictFiles &&
        row('conflicts', view === 'conflicts', 'conflictos', String(conflictFiles.length), null, () => setView('conflicts'), () => {
          setConflictFiles(null);
          setView((v) => (v === 'conflicts' ? 'coach' : v));
        })}
    </div>
  );

  const sideFooter = (
    <>
      {toolsOpen && row('tools', view === 'tools', 'herramientas', null, null, () => setView('tools'), () => {
        setToolsOpen(false);
        setView((v) => (v === 'tools' ? 'coach' : v));
      })}
      <button className={`side-usage${current && !noRight && rightView === 'uso' ? ' is-on' : ''}`} onClick={() => (current ? showRight('uso') : (setToolsOpen(true), setView('tools')))} title={toolsBad ? `${toolsBad} herramienta${toolsBad === 1 ? '' : 's'} por revisar · ⌘U` : 'uso de los modelos · ⌘U'}>
        <Icon name="gauge" size={13} />
        <UsageSummary />
        {toolsBad > 0 && <span className="dot is-permiso" aria-hidden="true" />}
      </button>
      {muted && (
        <button className="side-usage" onClick={() => toggleMute()} title="silenciado · ⌘⇧M">
          <Icon name="mute" size={13} />
          <span>silenciado</span>
        </button>
      )}
    </>
  );

  const editorTab = current && (diff || file) ? { name: (diff?.path ?? file ?? '').split(/[\\/]/).pop() ?? '', path: diff?.path ?? file ?? '', diff: !!diff } : null;
  const panelOpen = !!current && !noRight;

  return (
    <div className={`app${panelOpen ? ' has-panel' : ''}${noSide ? ' no-side' : ''}${panelOpen && rightView === 'editor' ? ' is-wide' : ''}`}>
      <header className="titlebar" data-tauri-drag-region>
        <div className="tb-left" data-tauri-drag-region>
          <button className={`tb-btn${noSide ? '' : ' is-on'}`} onClick={() => setNoSide((v) => !v)} aria-label="Barra lateral" title="barra lateral · ⌘B">
            <Icon name="sidebar" size={15} />
          </button>
        </div>
        <button className="tb-pill" onClick={() => setOverlay('palette')} title="órdenes, sesiones y vistas · ⌘K">
          <Icon name="folder" size={13} />
          <span className="tb-name">{current?.name ?? 'filigranas'}</span>
          {current && branch && (
            <>
              <span className="tb-sep" />
              <Icon name="branch" size={12} />
              <span>{branch}</span>
              {dirty && <span className="dot is-dirty" aria-label="cambios sin commit" />}
            </>
          )}
          <span className="grow" />
          <kbd>⌘K</kbd>
        </button>
        <div className="tb-right" data-tauri-drag-region>
          {current && (
            <button className={`tb-btn${termOpen ? ' is-on' : ''}`} onClick={toggleTerminal} aria-label="Terminal" title="terminal · ⌘J">
              <Icon name="terminal" size={15} />
            </button>
          )}
          {current && (
            <button className={`tb-btn${noRight ? '' : ' is-on'}`} onClick={() => setNoRight((v) => !v)} aria-label="Panel derecho" title="panel derecho · ⌘I">
              <Icon name="panel" size={15} />
            </button>
          )}
        </div>
      </header>

      <Sidebar
        ws={ws}
        project={project}
        onProject={(p) => {
          setProject(p);
          setFile(null);
          setView('coach');
          setLarryKey(null);
          setPublishKey(null);
          setPendingKey(null);
          setConflictFiles(null);
          setContainerCount(null);
        }}
        onUpdate={update}
        onNewSession={() => current && setEngineMenu((v) => !v)}
        sessions={sessionList}
        footer={sideFooter}
      />
      {engineMenu && current && (
        <div className="menu engine-menu" role="menu" onMouseLeave={() => setEngineMenu(false)}>
          <div className="menu-label">nueva sesión con</div>
          {ENGINES.map(([id, label, reason]) => (
            <button key={id} role="menuitem" className="menu-item" disabled={!!reason} title={reason ?? undefined} onClick={() => newSession(id)}>
              {label}
              {reason && <span className="muted"> · {reason}</span>}
            </button>
          ))}
        </div>
      )}
      <Splitter size={SIZES.side} axis="x" label="Ancho de la barra lateral" className="is-side" />

      <main className="panel center">
        {centerTitle && (
          <div className="center-head">
            <span className={`dot${centerTitle.state ? ` is-${centerTitle.state}` : ''}`} />
            <span className="ch-name">{centerTitle.name}</span>
            {centerTitle.tag && <span className="tag">{centerTitle.tag}</span>}
            {centerTitle.meta && <span className="ch-meta">{centerTitle.meta}</span>}
            {centerTitle.state && <span className={`ch-state is-${centerTitle.state}`}>{centerTitle.state === 'permiso' ? 'espera tu permiso' : 'trabajando'}</span>}
            <span className="grow" />
            {transient && (
              <button className="tb-btn" onClick={closeActive} aria-label="Cerrar" title={typeof view === 'number' ? 'cerrar sesión · ⌘W' : 'cerrar · ⌘W'}>
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
        )}
        <div className="main-view">
          {current && <Coordinator key={current.path} project={current.path} onDiff={showDiff} onProfile={setCoach} hidden={view !== 'coach'} />}
          {current && conflictFiles && (
            <Conflicts
              project={current.path}
              files={conflictFiles}
              hidden={view !== 'conflicts'}
              onOpenFile={(path) => {
                setFile(path);
                setFileSession(null);
                setDiff(null);
                openEditor();
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
              <SessionView
                key={s.id}
                session={s}
                project={current.path}
                hidden={view !== s.id}
                onDiff={showDiff}
                onTerminal={() => openSessionTerminal(s)}
                onCommits={() => openLarry(s)}
                onPublish={() => openPublish(s)}
                onOpenFile={(path) => {
                  setFile(path);
                  setFileSession(s.id);
                  setDiff(null);
                  openEditor();
                }}
                onConflicts={showConflicts}
              />
            ))}
          {!current && !(toolsOpen && view === 'tools') && (
            <div className="welcome">
              <h1>¿Qué hacemos hoy?</h1>
              <p>Elige un proyecto a la izquierda.</p>
            </div>
          )}
        </div>
        <section className="terminal" aria-label="Terminal" hidden={!(current && termOpen)}>
          <Splitter size={SIZES.term} axis="y" invert label="Altura del terminal" className="is-term" />
          <div className="terminal-head">
            <div className="terminal-tabs" role="tablist" aria-label="Terminales del proyecto">
              {projectTerms.map((tab) => (
                <div className={`terminal-tab${tab.id === activeTerm ? ' is-active' : ''}`} key={tab.id}>
                  <button role="tab" aria-selected={tab.id === activeTerm} onClick={() => setSelectedTerm((s) => ({ ...s, [tab.project]: tab.id }))}>
                    <Icon name="terminal" size={12} />
                    {tab.label ?? `zsh ${tab.number}`}
                  </button>
                  <button className="terminal-close" aria-label={`Cerrar terminal ${tab.label ?? tab.number}`} title="cerrar terminal" onClick={() => closeTerminal(tab.id)}>
                    <Icon name="close" size={8} />
                  </button>
                </div>
              ))}
              <button className="terminal-new" aria-label="Nuevo terminal" title="nuevo terminal" onClick={() => current && openTerminal(current.path, true)}>
                <Icon name="plus" size={11} />
              </button>
            </div>
            <span className="grow" />
            <button className="tb-btn" onClick={() => setTermOpen(false)} aria-label="Ocultar el terminal" title="ocultar · ⌘J">
              <Icon name="down" size={12} />
            </button>
          </div>
          {terms
            .filter((t) => ws.projects.some((w) => w.path === t.project))
            .map((t) => (
              <Terminal key={t.id} project={t.project} agentSession={t.session ?? null} initial={t.initial} hidden={!termOpen || t.project !== project || t.id !== activeTerm} />
            ))}
        </section>
        {error && (
          <button className="toast" onClick={() => setError(null)} title="cerrar">
            <Icon name="warn" size={13} />
            <span>{error}</span>
          </button>
        )}
      </main>

      {current && (
        <nav className="rail" aria-label="Paneles">
          {RIGHT_TABS.map(([id, label, icon, keys]) => (
            <button key={id} className={`rail-btn${panelOpen && rightView === id ? ' is-on' : ''}`} onClick={() => showRight(id)} aria-label={label} title={`${label.toLowerCase()} · ${keys}`}>
              <Icon name={icon} size={15} />
              {id === 'git' && dirty && <span className="dot is-dirty" />}
            </button>
          ))}
          <span className="rail-sep" />
          <button className={`rail-btn${termOpen ? ' is-on' : ''}`} onClick={toggleTerminal} aria-label="Terminal" title="terminal · ⌘J">
            <Icon name="terminal" size={15} />
          </button>
        </nav>
      )}

      {panelOpen && current && (
        <Right tab={rightView} onTab={(t) => setRightView(t)} dirty={dirty} containers={containerCount} editor={editorTab} onCloseEditor={closeFile}>
          {rightView === 'git' && (
            <GitPanel
              project={current.path}
              selected={diff?.session == null ? diff : null}
              onDiff={showDiff}
              onBranch={setBranch}
              onDirty={setDirty}
              pending={pendingCount}
              onPending={() => {
                setPendingKey(Date.now());
                setView('pending');
              }}
              onPublish={() => openPublish()}
            />
          )}
          {rightView === 'files' && (
            <FileTree
              root={current.path}
              selected={file}
              onOpen={(f) => {
                setFile(f);
                setFileSession(null);
                setDiff(null);
                openEditor();
              }}
            />
          )}
          {rightView === 'containers' && <Containers key={current.path} project={current.path} onCount={setContainerCount} />}
          {rightView === 'uso' && <UsagePanel tools={toolList} checking={checkingTools} onRefresh={checkTools} onLogin={(command) => openTerminal(current.path, true, command)} />}
          {rightView === 'editor' &&
            editorTab &&
            (diff ? (
              <Diff project={current.path} change={diff} />
            ) : (
              <Editor path={file ?? ''} root={agentSessions.find((s) => s.id === fileSession)?.worktree ?? current.path} session={fileSession} onError={setError} />
            ))}
        </Right>
      )}
      {overlay === 'palette' && <Palette commands={commands.filter((c) => c.id !== 'palette' && !LOCAL.has(c.id))} onClose={() => setOverlay(null)} />}
      {overlay === 'cheat' && <Cheatsheet commands={commands} onClose={() => setOverlay(null)} />}
    </div>
  );
}
