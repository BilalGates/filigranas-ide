import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, chats, git, sessions, tools as toolsApi, type ChatEngine, type DiffTarget, type CliUpdate, type Session, type Tool, type Workspace } from './ipc';
import Onboarding from './Onboarding';
import Sidebar from './Sidebar';
import Editor from './Editor';
import Diff from './Diff';
import GitPanel, { Icon } from './GitPanel';
import Right, { RIGHT_PANELS, WIDE_RIGHT_PANELS, type RightTab } from './Right';
import FileTree from './FileTree';
import Terminal from './Terminal';
import Coordinator from './Coordinator';
import SessionView, { ENGINE_LABEL } from './Session';
import Tasks, { type WorkSection, type WorkTarget } from './Tasks';
import DesignCanvas from './DesignCanvas';
import WorkspaceChanges from './trama/WorkspaceChanges';
import { sidebarReference } from './designCanvasModel';
import Tools, { CliNotice } from './Tools';
import { useProviderQuota, useQuotaEvents } from './usageStore';
import { Cheatsheet, Palette, type Command } from './Palette';
import { emit, setLightTheme, shortcut, toggleMute, useUi } from './ui';
import Conflicts from './Conflicts';
import Containers from './Containers';
import Browser from './Browser';
import Splitter, { SIZES } from './Splitter';
import GithubProfile from './GithubProfile';
import Sharing, { type ShareTarget } from './Sharing';
import AmbientField from './trama/AmbientField';
import { DESTS, DestNav, loadDest, loadResume, saveDest, saveResume, type Dest } from './trama/nav';
import Home from './trama/Home';
import Flow from './trama/Flow';
import Studio from './trama/Studio';
import Entrega from './trama/Entrega';
import Boundary from './trama/Boundary';
import BrainView from './trama/BrainView';
import Threads from './trama/Threads';
import TitleSwitch from './trama/TitleSwitch';
import EngineUsage, { type Engine } from './trama/EngineUsage';
import JevUsage from './trama/JevUsage';
import Settings from './trama/Settings';
import JevStatusButton from './trama/StatusMeters';
import { Seg } from './trama/ui';
import { AgDot, sessionAgents } from './trama/kit';

// Proyectos con project manager: solo los que lo piden, no todos.
const PM_KEY = 'filigranas.pm';
const loadPm = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(PM_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
};

// `session`: terminal en el worktree de una sesión aislada (su nombre como etiqueta).
type TerminalTab = { id: number; project: string; number: number; session?: number; label?: string; initial?: string };

export default function App() {
  useQuotaEvents();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const currentProject = useRef(project);
  currentProject.current = project;
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  // Sesión a la que pertenece el archivo abierto (su worktree), si alguna.
  const [fileSession, setFileSession] = useState<number | null>(null);
  const [fileRoot, setFileRoot] = useState<string | null>(null);
  // Cada pestaña tiene su propio PTY. Siguen vivos al cambiar de proyecto.
  const [terms, setTerms] = useState<TerminalTab[]>([]);
  const [selectedTerm, setSelectedTerm] = useState<Record<string, number>>({});
  const nextTermId = useRef(1);
  const [termOpen, setTermOpen] = useState(false);
  const [view, setView] = useState<'coach' | 'work' | number>('coach');
  const [workTarget, setWorkTarget] = useState<WorkTarget | null>(null);
  const [worktree, setWorktree] = useState<{ project: string; id: number } | null>(null);
  const [coachTask, setCoachTask] = useState<{ id: number; title: string } | null>(null);
  const [pendingBranches, setPendingBranches] = useState<{ project: string; count: number } | null>(null);
  // CLI externas: se comprueban al arrancar y desde su vista.
  const [toolList, setToolList] = useState<Tool[] | null>(null);
  const [checkingTools, setCheckingTools] = useState(false);
  // Archivos con marcas de conflicto tras una integración.
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);
  const [rightView, setRightView] = useState<RightTab>('git');
  const [dirty, setDirty] = useState(false);
  const [agentSessions, setAgentSessions] = useState<Session[]>([]);
  // Proyecto cuya lista de sesiones ya está cargada (mientras carga, vacía).
  const [sessionsOf, setSessionsOf] = useState<string | null>(null);
  const [pmChat, setPmChat] = useState<{ project: string; session: Session | null } | null>(null);
  const [switching, setSwitching] = useState<number | string | null>(null);
  const [githubOpen, setGithubOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState<Engine | 'jev' | null>(null);
  // Aviso de las CLI de IA actualizadas (o que fallaron) en segundo plano.
  const [cliNotice, setCliNotice] = useState<CliUpdate[] | null>(null);
  // Último resultado automático, para verlo en Herramientas tras cerrar el aviso.
  const [cliLast, setCliLast] = useState<CliUpdate[] | null>(null);
  const [browserTarget, setBrowserTarget] = useState<{ url: string } | null>(null);
  const [reportedModel, setReportedModel] = useState<{ key: number | string; model: string | null } | null>(null);
  const reportModel = useCallback((key: number | string, model: string | null) => setReportedModel({ key, model }), []);
  const usageButton = useRef<HTMLButtonElement>(null);
  const statusMeters = useRef<HTMLDivElement>(null);
  const usagePopup = useRef<HTMLElement>(null);
  const centerPanel = useRef<HTMLElement>(null);
  const [pmProjects, setPmProjects] = useState(loadPm);
  const setPm = (path: string, on: boolean) =>
    setPmProjects((cur) => {
      const next = new Set(cur);
      if (on) next.add(path);
      else next.delete(path);
      try {
        localStorage.setItem(PM_KEY, JSON.stringify([...next]));
      } catch {
        /* sin almacenamiento */
      }
      return next;
    });
  const [branch, setBranch] = useState<{ project: string; label: string; ahead: number; behind: number; upstream: string | null } | null>(null);
  const [chooseBranch, setChooseBranch] = useState(false);
  const clearBranchPicker = useCallback(() => setChooseBranch(false), []);

  const [shareMode, setShareMode] = useState<ShareTarget | 'join' | null>(null);
  const [overlay, setOverlay] = useState<'palette' | 'cheat' | null>(null);
  const [noSide, setNoSide] = useState(false);
  const [noRight, setNoRight] = useState(() => { try { return (localStorage.getItem('filigranas.disposicion') ?? 'chat') === 'chat'; } catch { return true; } });
  const [dest, setDestState] = useState<Dest>(loadDest);
  const [leftMode, setLeftModeState] = useState<'threads' | 'projects'>(() => { try { return localStorage.getItem('filigranas.izquierda') === 'projects' ? 'projects' : 'threads'; } catch { return 'threads'; } });
  const setLeftMode = (m: 'threads' | 'projects') => { setLeftModeState(m); try { localStorage.setItem('filigranas.izquierda', m); } catch { /* */ } };
  const [entregaScope, setEntregaScope] = useState<number | null>(null);
  const [studioView, setStudioView] = useState<'captures' | 'canvas'>('captures');
  const [layout, setLayoutState] = useState<'chat' | 'split' | 'code'>(() => {
    try { const v = localStorage.getItem('filigranas.disposicion'); return v === 'split' || v === 'code' ? v : 'chat'; } catch { return 'chat'; }
  });
  const setDest = useCallback((d: Dest) => { if (d !== 'entrega') setEntregaScope(null); setDestState(d); saveDest(d); }, []);
  const { activity, muted, light } = useUi();
  const activeSession = agentSessions.find((session) => session.id === view && session.project === project);
  const pmReady = !!project && pmChat?.project === project;
  const pmSession = pmReady ? pmChat.session : null;
  const pmEngine = pmSession?.engine ?? 'codex';
  const usageEngine = activeSession?.engine ?? (project && pmReady && pmProjects.has(project) && view === 'coach' ? pmEngine : 'codex');
  const usageModel = reportedModel?.key === (activeSession?.id ?? project) && usageEngine ? reportedModel.model : null;
  const quota = useProviderQuota(usageEngine, usageModel, true);
  const sessionWorktree = activeSession?.worktree ? activeSession : null;

  useEffect(() => {
    if (!project) return;
    let request = 0;
    let timer: number | undefined;
    const refresh = () => {
      const id = ++request;
      const fallback = { ahead: 0, behind: 0, upstream: null };
      void git.status(project).then(async ({ branch, ahead, behind, upstream }) => ({
        label: branch ?? await git.head(project), ahead, behind, upstream,
      }), async () => ({ label: await git.head(project), ...fallback })).then(
        (status) => { if (id === request) setBranch({ project, ...status }); },
        () => { if (id === request) setBranch({ project, label: 'Rama no disponible', ...fallback }); },
      );
    };
    refresh();
    const unlisten = listen('project-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 250);
    });
    window.addEventListener('focus', refresh);
    return () => {
      request++;
      window.clearTimeout(timer);
      void unlisten.then((off) => off());
      window.removeEventListener('focus', refresh);
    };
  }, [project]);


  useEffect(() => {
    if (!usageOpen) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!statusMeters.current?.contains(target) && !usagePopup.current?.contains(target)) setUsageOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setUsageOpen(false);
      usageButton.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [usageOpen]);

  const openTerminal = useCallback((path: string, newTab = false, initial?: string) => {
    const existing = terms.filter((t) => t.project === path && t.session == null);
    if (!newTab && !initial && existing.length) {
      setSelectedTerm((current) => ({ ...current, [path]: existing.find((t) => t.id === current[path])?.id ?? existing[0].id }));
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
    api.workspace().then(
      (workspace) => { setWs(workspace); setWorkspaceError(null); },
      (e) => setWorkspaceError(String(e)),
    );
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
    let active = true;
    setAgentSessions([]);
    setSessionsOf(null);
    if (project) {
      chats.pm(project).then(
        (session) => { if (active) setPmChat({ project, session }); },
        (e) => { if (active) setError(String(e)); },
      );
      sessions.list(project).then(
        (list) => {
          if (!active) return;
          setAgentSessions(list);
          setSessionsOf(project);
        },
        (e) => { if (active) setError(String(e)); },
      );
    }
    return () => { active = false; };
  }, [project]);

  // El coordinador también crea sesiones al delegar.
  useEffect(() => {
    let active = true;
    const unlisten = listen<{ project: string; focus?: number | null }>('sessions-changed', ({ payload }) => {
      if (payload.project !== project) return;
      sessions.list(payload.project).then(
        (list) => {
          if (!active) return;
          setAgentSessions(list);
          // Un relevo lleva a la sesión que continúa la tarea.
          if (payload.focus != null && list.some((s) => s.id === payload.focus)) setView(payload.focus);
        },
        (e) => { if (active) setError(String(e)); },
      );
    });
    return () => {
      active = false;
      unlisten.then((off) => off());
    };
  }, [project]);

  const newSession = (engine = 'codex', task: number | null = null, skillRole: 'designer' | null = null) => {
    if (!project) return;
    sessions.create(project, engine, task, skillRole).then(
      ({ notice, ...s }) => {
        if (currentProject.current !== s.project) return;
        setAgentSessions((list) => list.some((item) => item.id === s.id) ? list : [...list, s]);
        setView(s.id);
        if (notice) setError(notice);
      },
      (e) => setError(String(e)),
    );
  };

  const focusConversation = () => {
    const panel = centerPanel.current;
    if (!panel) return;
    const composer = [...panel.querySelectorAll<HTMLTextAreaElement>('.co-compose textarea:not(:disabled)')]
      .find((textarea) => !textarea.closest('[hidden]'));
    (composer ?? panel).focus();
  };

  const checkTools = useCallback(() => {
    setCheckingTools(true);
    toolsApi
      .status()
      .then(setToolList, (e) => setError(String(e)))
      .finally(() => setCheckingTools(false));
  }, []);
  useEffect(checkTools, [checkTools]);
  useEffect(() => {
    const unlisten = listen<CliUpdate[]>('cli-updates', (e) => { setCliNotice(e.payload); setCliLast(e.payload); checkTools(); });
    return () => { unlisten.then((off) => off()); };
  }, [checkTools]);
  // Los avisos de éxito se retiran solos; los fallos esperan a que se lean.
  useEffect(() => {
    if (!cliNotice || cliNotice.some((u) => u.outcome === 'failed')) return;
    const timer = window.setTimeout(() => setCliNotice(null), 12000);
    return () => window.clearTimeout(timer);
  }, [cliNotice]);

  const countPending = useCallback(() => {
    if (!project) return;
    sessions.orphans(project).then(
      (list) => { if (currentProject.current === project) setPendingBranches({ project, count: list.length }); },
      () => { if (currentProject.current === project) setPendingBranches(null); },
    );
  }, [project]);
  useEffect(countPending, [countPending, agentSessions]);
  const pendingCount = pendingBranches?.project === project ? pendingBranches?.count ?? 0 : 0;

  const closeSession = (id: number) => {
    const closing = agentSessions.find((s) => s.id === id);
    sessions.close(id).then(
      () => {
        setAgentSessions((list) => list.filter((s) => s.id !== id));
        setView((v) => (v === id ? 'coach' : v));
        if (closing?.worktree)
          setError(`La rama ${closing.branch} de ${closing.name} se conserva: está en Trabajo, en la sección Ramas.`);
      },
      (e) => setError(String(e)),
    );
  };

  useEffect(() => {
    setDiff(null);
  }, [project]);

  // Mantener el observador del proyecto y seguir la copia de trabajo visible.
  const watchedSession = !noRight && rightView === 'editor' ? (diff ? diff.session : fileSession) ?? null
    : view === 'work' && worktree?.project === project ? worktree?.id ?? null
    : sessionWorktree?.id ?? null;
  useEffect(() => {
    git.watch(project, watchedSession).catch((e) => setError(String(e)));
  }, [project, watchedSession]);

  // Si la sesión abierta desaparece (cerrada o limpiada), volver al coordinador.
  useEffect(() => {
    if (project && sessionsOf === project && typeof view === 'number' && !agentSessions.some((s) => s.id === view)) setView('coach');
  }, [agentSessions, project, sessionsOf, view]);

  // Sus terminales tampoco sobreviven: su carpeta puede haberse borrado.
  useEffect(() => {
    if (sessionsOf !== project) return;
    setTerms((current) => {
      const kept = current.filter((t) => t.session == null || t.project !== project || agentSessions.some((s) => s.id === t.session));
      return kept.length === current.length ? current : kept;
    });
  }, [agentSessions, project, sessionsOf]);

  // Sin project manager, abrir el proyecto lleva a su primera sesión.
  useEffect(() => {
    if (project && sessionsOf === project && view === 'coach' && !pmProjects.has(project) && agentSessions.length) setView(agentSessions[0].id);
  }, [project, sessionsOf, view, pmProjects, agentSessions]);

  const revealRight = (tab: RightTab) => {
    setRightView(tab);
    setNoRight(false);
  };
  const showRight = (tab: RightTab) => {
    if (tab === rightView && !noRight) setNoRight(true);
    else revealRight(tab);
  };

  const openWork = (section?: WorkSection, scope?: Session | null, path = project) => {
    if (!path) return;
    if (section) setWorkTarget({ project: path, section, session: scope === undefined ? undefined : scope?.id ?? null });
    setView('work');
  };
  const openPending = () => {
    if (!project) return;
    setWorkTarget({ project, section: 'branches', session: null, allPending: true });
    setView('work');
  };
  const watchWorktree = useCallback((path: string, id: number | null) => {
    setWorktree(id == null ? null : { project: path, id });
  }, []);
  const openEditor = () => revealRight('editor');
  const showConflicts = (files: string[]) => {
    setConflictFiles(files);
    revealRight('conflicts');
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

  // «Retomar»: último punto de trabajo real (proyecto y vista del Workspace).
  useEffect(() => {
    if (project && sessionsOf === project && dest === 'workspace') saveResume({ project, view, dest, at: Date.now() });
  }, [project, sessionsOf, view, dest]);

  const closeFile = () => {
    setFile(null);
    setDiff(null);
    setFileSession(null);
    setRightView((v) => (v === 'editor' ? 'git' : v));
  };

  const shareDialog = shareMode && <Sharing target={shareMode === 'join' ? null : shareMode} onClose={() => setShareMode(null)} />;
  if (!ws && !workspaceError) return <div className="app" />;
  if (!ws?.root) return <><Onboarding onDone={(workspace) => { setWs(workspace); setWorkspaceError(null); }}
    recoveryError={workspaceError} onRetry={refresh} onJoin={() => setShareMode('join')}
    github={toolList?.find((tool) => tool.id === 'gh')} onToolsRefresh={checkTools} />{shareDialog}</>;

  const current = ws.projects.find((p) => p.path === project);
  const selectProject = (path: string | null) => {
    setChooseBranch(false);
    setDirty(false);
    currentProject.current = path;
    setProject(path);
    setCoachTask(null);
    setWorkTarget(null);
    setWorktree(null);
    closeFile();
    setConflictFiles(null);
    setRightView((tab) => (tab === 'conflicts' ? 'git' : tab));
    setView('coach');
  };
  const hasPm = !!current && pmProjects.has(current.path);
  const startPm = (path = current?.path) => {
    if (!path) return;
    if (path !== project) selectProject(path);
    setPm(path, true);
    setView('coach');
  };
  const changeEngine = (engine: ChatEngine) => {
    if (!current || switching !== null) return;
    const path = current.path;
    const id = activeSession?.id ?? null;
    setSwitching(id ?? path);
    chats.switchEngine(path, id, engine).then(
      (session) => {
        if (currentProject.current !== path) return;
        setReportedModel((model) => model?.key === (id ?? path) ? null : model);
        if (id === null) setPmChat({ project: path, session });
        else if (session) setAgentSessions((list) => list.map((item) => item.id === id ? session : item));
      },
      (e) => setError(String(e)),
    ).finally(() => setSwitching(null));
  };
  const projectTerms = terms.filter((t) => t.project === project);
  const activeTerm = project ? selectedTerm[project] ?? projectTerms[0]?.id : undefined;
  const toggleTerminal = () => {
    if (!current) return;
    const terminal = projectTerms.find((t) => t.id === activeTerm);
    if (termOpen && terminal?.session === sessionWorktree?.id) setTermOpen(false);
    else if (sessionWorktree) openSessionTerminal(sessionWorktree);
    else openTerminal(current.path);
  };
  const toggleUsage = () => {
    setUsageOpen(false);
    setGithubOpen(false);
    setEngineOpen((open) => open ? null : usageEngine === 'claude' ? 'claude' : 'codex');
  };
  const toggleSidebar = () => {
    setNoSide((v) => !v);
  };
  const openBrowser = (url: string) => {
    setBrowserTarget({ url });
    revealRight('browser');
  };
  const editorOpen = !!(current && (diff || file));
  // Disposición del Workspace. Chat: conversación con la columna derecha
  // libre. Dividida: conversación + editor ancho. Código: el editor ocupa
  // el centro (la conversación y los terminales siguen montados).
  const setLayout = (next: 'chat' | 'split' | 'code') => {
    setLayoutState(next);
    try { localStorage.setItem('filigranas.disposicion', next); } catch { /* sin almacenamiento */ }
    // Conversación: el chat ocupa el centro sin panel lateral, como en Trama.
    if (next === 'chat') { setNoRight(true); return; }
    setNoRight(false);
    setRightView(editorOpen ? 'editor' : 'files');
  };
  const closeActive = () => {
    if (editorOpen && rightView === 'editor' && !noRight) closeFile();
    else if (!noRight && document.activeElement?.closest('#workspace-right-panel, .rail')) setNoRight(true);
    else if (typeof view === 'number') closeSession(view);
  };

  const baseCommands: Command[] = [
    { id: 'palette', label: 'órdenes', keys: '⌘K', run: () => setOverlay('palette') },
    { id: 'cheat', label: 'atajos de teclado', keys: '⌘/', run: () => setOverlay('cheat') },
    { id: 'new', label: 'nueva sesión', keys: '⌘T', run: () => newSession() },
    { id: 'close', label: 'cerrar pestaña', keys: '⌘W', run: closeActive },
    { id: 'pm', label: hasPm ? 'project manager' : 'sesión con project manager', keys: '⌘1', run: () => (hasPm ? setView('coach') : startPm()) },
    ...agentSessions.slice(0, 8).map((s, i) => ({ id: `s${s.id}`, label: `sesión ${s.name}`, keys: `⌘${i + 2}`, run: () => setView(s.id) })),
    { id: 'editor', label: 'editor', keys: '⌘E', run: () => editorOpen && (rightView === 'editor' ? setRightView('git') : openEditor()) },
    { id: 'files', label: 'archivos', keys: '⌘P', run: () => showRight('files') },
    { id: 'term', label: termOpen ? 'ocultar terminal' : 'abrir terminal', keys: '⌘J', run: toggleTerminal },
    { id: 'side', label: noSide ? 'mostrar barra lateral' : 'ocultar barra lateral', keys: '⌘B', run: toggleSidebar },
    { id: 'layout-chat', label: 'disposición · chat', keys: '⌘⌥1', run: () => setLayout('chat') },
    { id: 'layout-split', label: 'disposición · dividida', keys: '⌘⌥2', run: () => setLayout('split') },
    { id: 'layout-code', label: 'disposición · código', keys: '⌘⌥3', run: () => setLayout('code') },
    { id: 'right', label: noRight ? 'mostrar columna derecha' : 'ocultar columna derecha', keys: '⌘I', run: () => setNoRight((v) => !v) },
    ...(current ? [
      { id: 'tasks', label: 'Trabajo · tareas', run: () => openWork() },
      { id: 'health', label: 'Code Health', run: () => openWork('health', view === 'work' ? undefined : activeSession ?? null) },
      { id: 'pending', label: 'Ramas sin integrar', run: openPending },
    ] : []),
    { id: 'git', label: 'git', keys: '⌘G', run: () => showRight('git') },
    { id: 'pr', label: 'pull request', run: () => openWork('pulls', view === 'work' ? undefined : activeSession ?? null) },
    { id: 'containers', label: 'contenedores', keys: '⌘⇧O', run: () => showRight('containers') },
    { id: 'browser', label: 'navegador', run: () => showRight('browser') },
    { id: 'commit', label: 'commit', keys: '⌘⇧C', run: () => emit('commit') },
    { id: 'commit-push', label: 'commit y push', keys: '⌘⇧P', run: () => emit('commit-push') },
    { id: 'larry', label: 'Larry · commits', keys: '⌘⇧G', run: () => openWork('commits', view === 'work' ? undefined : activeSession ?? null) },
    { id: 'send', label: 'enviar mensaje', keys: '⌘↩', run: () => {} },
    { id: 'stop', label: 'interrumpir', keys: '⌘.', run: () => {} },
    { id: 'model', label: 'modelo', keys: '⌘M', run: () => {} },
    { id: 'effort', label: 'esfuerzo', keys: '⌘⇧E', run: () => {} },
    { id: 'allow', label: 'aprobar permiso', keys: '⌘Y', run: () => {} },
    { id: 'deny', label: 'rechazar permiso', keys: '⌘N', run: () => {} },
    { id: 'usage', label: 'uso de los modelos', keys: '⌘U', run: toggleUsage },
    { id: 'mute', label: muted ? 'activar sonido' : 'silenciar', keys: '⌘⇧M', run: () => toggleMute() },
    { id: 'theme', label: 'cambiar tema', keys: '⌘⇧L', run: () => setLightTheme(!light) },
  ];
  // Las órdenes del Workspace llevan a él; las globales no cambian de destino.
  const GLOBAL = new Set(['palette', 'cheat', 'usage', 'mute', 'theme', 'send', 'stop', 'model', 'effort', 'allow', 'deny']);
  const commands: Command[] = [
    ...DESTS.map((d) => ({ id: `dest-${d.id}`, label: d.label, keys: d.keys, run: () => setDest(d.id) })),
    ...baseCommands.map((c) => GLOBAL.has(c.id) ? c : { ...c, run: () => { setDest('workspace'); c.run(); } }),
  ];
  // Atajos que resuelve la vista visible (conversación, editor).
  const LOCAL = new Set(['send', 'stop', 'model', 'effort', 'allow', 'deny']);
  const KEY: Record<string, string> = { Enter: '↩', Period: '.', Slash: '/', Backquote: '`', Comma: ',' };
  keys.current = (e) => {
    if (shareMode || e.defaultPrevented || (e.target instanceof Element && e.target.closest('.tr-modal'))) return;
    if (!(e.metaKey || e.ctrlKey)) {
      if (e.ctrlKey && e.code === 'Backquote') toggleTerminal();
      return;
    }
    const k = KEY[e.code] ?? e.code.replace(/^Key|^Digit/, '');
    const combo = `⌘${e.altKey ? '⌥' : ''}${e.shiftKey ? '⇧' : ''}${k}`;
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
  const usageLabel = usageEngine === 'codex' ? 'Codex'
    : usageEngine === 'claude' ? 'Claude Code'
    : usageEngine ? (ENGINE_LABEL[usageEngine] ?? usageEngine) : null;
  const branchInfo = branch?.project === project ? branch : null;
  const branchLabel = branchInfo?.label ?? 'Leyendo rama…';
  const centerTitle = !current ? null
    : view === 'work' ? { name: 'Trabajo', meta: current.name, tag: null, state: null }
    : view === 'coach' && hasPm
      ? { name: 'Project manager', meta: pmEngine === 'claude' ? 'Claude Code' : 'Codex', tag: null, state: sessionState('coach') }
      : activeSession
        ? { name: activeSession.name, meta: ENGINE_LABEL[activeSession.engine] ?? activeSession.engine, tag: null, state: sessionState(String(activeSession.id)) }
        : { name: current.name, meta: 'Workspace', tag: null, state: null };

  const chatEngine = activeSession?.engine ?? (view === 'coach' && hasPm && pmReady ? pmEngine : null);
  const providerPicker = (chatEngine === 'codex' || chatEngine === 'claude') && (
    <select className="chip-select co-provider" aria-label="Proveedor de la conversación"
      title={centerTitle?.state ? 'Interrumpe el turno o espera a que termine para cambiar de proveedor' : 'Cambiar de proveedor'}
      value={chatEngine} disabled={switching !== null || !!centerTitle?.state}
      onChange={(e) => changeEngine(e.currentTarget.value as ChatEngine)}>
      <option value="codex">Codex</option>
      <option value="claude">Claude Code</option>
    </select>
  );
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
      <div className={`srow work-entry${view === 'work' ? ' is-on' : ''}`}>
        <button className="srow-main" aria-current={view === 'work' ? 'page' : undefined} onClick={() => openWork()}>
          <Icon name="tasks" size={13} />
          <span className="srow-name">Trabajo</span>
        </button>
      </div>
      {hasPm &&
        row('coach', view === 'coach', 'Project manager', null, sessionState('coach'), () => setView('coach'), () => {
          setPm(current.path, false);
          setView(agentSessions[0]?.id ?? 'coach');
        })}
      {agentSessions.map((s) => row(`s${s.id}`, view === s.id, s.name, ENGINE_LABEL[s.engine] ?? s.engine, sessionState(String(s.id)), () => setView(s.id), () => closeSession(s.id)))}
      <button className="project-new-session" onClick={() => newSession()}>
        <Icon name="plus" size={12} /> Nueva sesión
      </button>
    </div>
  );

  const editorPath = diff?.path ?? file;
  const editorScope = diff ? diff.session : fileSession;
  const editorRoot = editorScope == null ? current?.path
    : agentSessions.find((session) => session.id === editorScope)?.worktree ?? (diff ? null : fileRoot) ?? current?.path;
  const panelLocation = rightView === 'editor' && editorPath && editorRoot
    ? /^([a-zA-Z]:)?[\\/]/.test(editorPath) ? editorPath : `${editorRoot.replace(/[\\/]+$/, '')}/${editorPath}`
    : current?.path ?? null;
  const editorTab = current && editorPath ? { name: editorPath.split(/[\\/]/).pop() ?? '', path: editorPath, diff: !!diff } : null;
  const panelOpen = !noRight && (!!current || rightView === 'browser');
  const browserOpen = panelOpen && rightView === 'browser';
  const panelTabs = (Object.keys(RIGHT_PANELS) as RightTab[]).filter((tab) => {
    if (tab === 'browser') return false;
    if (tab === 'editor') return !!editorTab;
    if (tab === 'conflicts') return !!current && !!conflictFiles;
    return true;
  });
  const headerAgents = current ? sessionAgents(agentSessions, activity, hasPm ? { engine: pmEngine === 'claude' ? 'Claude' : 'Codex' } : null) : [];
  const fieldDim = { inicio: 1, workspace: layout === 'code' ? 0.35 : 0.7, studio: 0.55, entrega: 0.7, flow: 0.9, brain: 0.85, ajustes: 0.6 }[dest];
  const waiting = Object.values(activity).filter((a) => a === 'permiso').length;
  const destBadges: Partial<Record<Dest, number>> = { workspace: waiting };
  const destLive: Partial<Record<Dest, boolean>> = { workspace: Object.values(activity).some((a) => a === 'trabajando') };
  const errorToast = (error || workspaceError) && (
    <button className="toast" onClick={() => { setError(null); setWorkspaceError(null); }} title="cerrar">
      <Icon name="warn" size={13} />
      <span>{error ?? workspaceError}</span>
    </button>
  );

  return (
    <div className={`app${panelOpen ? ' has-panel' : ''}${noSide ? ' no-side' : ''}${panelOpen && WIDE_RIGHT_PANELS.has(rightView) ? ' is-wide' : ''}${dest !== 'workspace' ? ' is-dest' : ''}${layout === 'code' && panelOpen ? ' lay-code' : ''}${layout === 'split' && panelOpen ? ' is-wide' : ''}${dest === 'workspace' && browserOpen ? ' is-browser' : ''}`}>
      <AmbientField dim={fieldDim} />
      <header className="titlebar" data-tauri-drag-region>
        <div className="tb-left" data-tauri-drag-region>
          <TitleSwitch ws={ws} project={project} branch={branchInfo} onError={setError}
            onProject={(path) => { if (path !== project) selectProject(path); setDest('workspace'); }}
            onBranched={() => { void emit('project-changed'); }}
            onManage={() => { setLeftMode('projects'); setNoSide(false); setDest('workspace'); }}
            onBranchTools={() => { setDest('workspace'); revealRight('git'); setChooseBranch(true); }} />
        </div>
        <button className="tb-pill" onClick={() => setOverlay('palette')} title={shortcut('órdenes, sesiones y vistas · ⌘K')}>
          <Icon name="search" size={14} />
          <span className="grow">Buscar o ejecutar…</span>
          <kbd>{shortcut('⌘K')}</kbd>
        </button>
        <div className="tb-right" data-tauri-drag-region>
          {current && <button className="tb-agents tv" aria-label="Agentes de este proyecto" title="Agentes de este proyecto" onClick={() => setDest('flow')}>
            {headerAgents.length === 0 && <><Icon name="agent" size={13} /><span>0</span></>}
            {headerAgents.slice(0, 5).map((agent) => <AgDot key={agent.id} a={agent} s={12} />)}
            {headerAgents.length > 5 && <span>+{headerAgents.length - 5}</span>}
          </button>}
          <button className="tb-btn tb-attention" aria-label={waiting ? `Necesita tu atención · ${waiting} pendientes` : 'Necesita tu atención'} title="Necesita tu atención" onClick={() => setDest('inicio')}>
            <Icon name="signal" size={16} />{waiting > 0 && <span className="dot is-permiso" aria-hidden="true" />}
          </button>
        </div>
      </header>

      <DestNav dest={dest} onDest={setDest} badges={destBadges} live={destLive}
        browser={{ open: dest === 'workspace' && browserOpen, run: () => { if (dest !== 'workspace') { setDest('workspace'); revealRight('browser'); } else showRight('browser'); } }}
        github={<GithubProfile tool={toolList?.find(tool => tool.id === 'gh')} open={githubOpen} onRefresh={checkTools}
          onOpenChange={open => { setGithubOpen(open); if (open) { setEngineOpen(null); setUsageOpen(false); } }} />} />
      {dest === 'inicio' && (
        <Boundary name="Inicio">
        <Home ws={ws} project={project} agentSessions={agentSessions} resume={loadResume()} onWs={setWs} onError={setError}
          pm={hasPm ? { engine: pmEngine === 'claude' ? 'Claude' : 'Codex' } : null}
          onFlow={(path) => { if (path !== project) selectProject(path); setDest('flow'); }}
          onProject={(path) => { if (path !== project) selectProject(path); setDest('workspace'); }}
          onSession={(path, v) => { if (path !== project) selectProject(path); setView(v); setDest('workspace'); }}
          onWork={(path, task) => { if (path !== project) selectProject(path); if (task) setWorkTarget({ project: path, task, section: 'summary' }); setView('work'); setDest('workspace'); }}
          onResume={() => {
            const r = loadResume();
            if (!r || !ws.projects.some((p) => p.path === r.project && !p.archived)) return;
            if (r.project !== project) selectProject(r.project);
            if (typeof r.view !== 'number' || agentSessions.some((s) => s.id === r.view) || r.project !== project) setView(r.view);
            setDest('workspace');
          }} />
        </Boundary>
      )}
      {dest === 'flow' && (
        <Boundary name="Flow">
        <Flow key={project} project={project} projectName={current?.name ?? null} agentSessions={agentSessions}
          pm={hasPm ? { engine: pmEngine === 'claude' ? 'Claude' : 'Codex' } : null}
          onOpenSession={(id) => { setView(id); setDest('workspace'); }}
          onEditTask={(id) => {
            if (!project) return;
            setWorkTarget({ project, section: 'summary', ...(id == null ? { createTask: true } : { task: id }) });
            setView('work'); setDest('workspace');
          }}
          onAuto={(task) => { if (!project) return; setPm(project, true); setCoachTask(task); setView('coach'); setDest('workspace'); }}
          onDirect={(engine, task) => { newSession(engine, task); setDest('workspace'); }}
          onStartPm={() => { if (project && !hasPm) startPm(project); setView('coach'); setDest('workspace'); }} />
        </Boundary>
      )}
      {dest === 'studio' && (
        <Boundary name="Studio">
        <Studio key={project} project={project} projectName={current?.name ?? null} agentSessions={agentSessions}
          view={studioView} onView={setStudioView} onNewSession={() => newSession('claude', null, 'designer')}
          canvas={current && <DesignCanvas key={current.path} project={current.path}
            reference={sidebarReference(ws, current.path, agentSessions.filter((session) => session.project === current.path), hasPm, view)}
            archived={ws.projects.filter((item) => item.archived).length}
            conversation={<button className="btn sm" onClick={() => { setDest('workspace'); requestAnimationFrame(focusConversation); }}><Icon name="chat" size={13} /> Conversación</button>} />}
          onOpenSession={(id) => { setView(id); setDest('workspace'); }}
          onBrowser={() => { setDest('workspace'); revealRight('browser'); }} />
        </Boundary>
      )}
      {dest === 'entrega' && (
        <Boundary name="Entrega">
        <Entrega key={project} initialScope={entregaScope} project={project} projectName={current?.name ?? null} agentSessions={agentSessions}
          onConflicts={(files) => { setDest('workspace'); showConflicts(files); }} onBranchesChanged={countPending}
          onFile={(path, id, root) => { setFile(path); setFileSession(id); setFileRoot(root); setDiff(null); setDest('workspace'); openEditor(); }} />
        </Boundary>
      )}
      {dest === 'brain' && (
        <Boundary name="Brain">
          <BrainView key={project} project={project} projects={ws.projects}
            onOpenTask={(id, proj) => { const path = proj ?? project; if (!path) return; if (path !== project) selectProject(path); setWorkTarget({ project: path, task: id, section: 'summary' }); setView('work'); setDest('workspace'); }} />
        </Boundary>
      )}
      {dest === 'ajustes' && (
        <Boundary name="Ajustes">
          <Settings agentSessions={agentSessions} project={project} projectName={current?.name ?? null} tools={toolList} checking={checkingTools} autoUpdates={cliLast}
            onRefreshTools={checkTools} onLogin={current ? (command) => { setDest('workspace'); openTerminal(current.path, true, command); } : null}
            usage={{ engine: usageEngine, label: usageLabel, model: usageModel, quota }} commands={commands} />
        </Boundary>
      )}
      {leftMode === 'threads' && current ? (
        <Threads projectName={current.name} view={view} hasPm={hasPm} pmEngine={pmEngine === 'claude' ? 'Claude' : 'Codex'} sessions={agentSessions}
          onView={setView} onNew={(engine) => newSession(engine)} onStartPm={() => { startPm(current.path); setView('coach'); }}
          onClose={closeSession} onProjects={() => setLeftMode('projects')}
          footer={muted && <button className="btn sm ghost" onClick={() => toggleMute()} title={shortcut('silenciado · ⌘⇧M')}><Icon name="mute" size={13} /> Silenciado</button>} />
      ) : (
      <Sidebar
        ws={ws}
        project={project}
        onProject={selectProject}
        onUpdate={update}
        onNewSession={() => newSession()}
        onProjectManager={startPm}
        onJoin={() => setShareMode('join')}
        onShare={(target) => {
          const worktree = target.path === project ? sessionWorktree : null;
          setShareMode({ path: target.path, name: target.name, session: worktree?.id ?? null, worktree: worktree?.name });
        }}
        onProjectView={(path, tab) => {
          if (path !== project) selectProject(path);
          if (tab === 'work') openWork(undefined, undefined, path);
          else revealRight(tab);
        }}
        onProjectTerminal={(path) => {
          if (path !== project) selectProject(path);
          openTerminal(path);
        }}
        onError={setError}
        sessions={sessionList}
        status={<>
          {muted && (
            <button className="side-usage" onClick={() => toggleMute()} title={shortcut('silenciado · ⌘⇧M')}>
              <Icon name="mute" size={13} /> Silenciado
            </button>
          )}
          {current && <button className="side-usage" onClick={() => setLeftMode('threads')}><Icon name="chat" size={13} /> Conversaciones</button>}
        </>}
      />
      )}
      {shareDialog}
      {usageOpen && (
        <section ref={usagePopup} id="usage-popup" className="usage-popup" role="region" aria-label="Herramientas y Jev">
          <header>
            <h2>Herramientas y Jev</h2>
            <button className="icon" aria-label="Cerrar uso" onClick={() => { setUsageOpen(false); usageButton.current?.focus(); }}><Icon name="close" size={12} /></button>
          </header>
          <Tools tools={toolList} checking={checkingTools} hidden={false} onRefresh={checkTools} autoUpdates={cliLast}
            onLogin={current ? (command) => { setUsageOpen(false); setDest('workspace'); openTerminal(current.path, true, command); } : null} />
        </section>
      )}
      <Splitter size={SIZES.side} axis="x" label="Ancho de la barra lateral" className="is-side" />

      <main className="panel center" ref={centerPanel} tabIndex={-1}>
        {centerTitle && (
          <div className="center-head">
            <span className={`dot${centerTitle.state ? ` is-${centerTitle.state}` : ''}`} />
            <span className="ch-name">{centerTitle.name}</span>
            {centerTitle.tag && <span className="tag">{centerTitle.tag}</span>}
            {!providerPicker && centerTitle.meta && <span className="ch-meta">{centerTitle.meta}</span>}
            {centerTitle.state && <span className={`ch-state is-${centerTitle.state}`}>{centerTitle.state === 'permiso' ? 'espera tu permiso' : 'trabajando'}</span>}
            <span className="grow" />
            <div className="ws-layout"><Seg label="Disposición" value={layout} onChange={setLayout} items={[
              { id: 'chat', label: 'Conversación', icon: 'chat' }, { id: 'split', label: 'Dividida', icon: 'split' }, { id: 'code', label: 'Código', icon: 'code' }]} /></div>
            <button className={`tb-btn ws-term${termOpen ? ' is-on' : ''}`} onClick={toggleTerminal} aria-label="Terminal" aria-pressed={termOpen} title={shortcut('terminal · ⌘J')}><Icon name="terminal" size={15} /></button>
            {activeSession && (
              <button className="tb-btn" onClick={() => closeSession(activeSession.id)} aria-label="Cerrar sesión" title="cerrar sesión">
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
        )}
        <div className="main-view">
          {current && <Tasks key={current.path} project={current.path} checkout={branchLabel} hidden={view !== 'work'}
            sessions={agentSessions} focus={workTarget?.project === current.path ? workTarget : null}
            onAuto={(task) => { setPm(current.path, true); setCoachTask(task); setView('coach'); }}
            onDirect={newSession} onSession={setView} onDiff={showDiff}
            onConflicts={(files) => { if (currentProject.current === current.path) showConflicts(files); }}
            onBranchesChanged={countPending} onWorktree={watchWorktree}
            onFile={(path, id, root) => {
              if (currentProject.current !== current.path) return;
              setFile(path);
              setFileSession(id);
              setFileRoot(root);
              setDiff(null);
              openEditor();
            }} />}
          {current && hasPm && pmReady && (pmSession
            ? <SessionView key={'coach-claude:' + current.path} session={pmSession} project={current.path}
                hidden={view !== 'coach'} switching={switching === project} providerPicker={view === 'coach' ? providerPicker : undefined} onDiff={showDiff} onModel={reportModel}
                manager={{ task: coachTask, clearTask: () => setCoachTask(null) }} />
            : <Coordinator key={'coach:' + current.path} project={current.path} onDiff={showDiff} hidden={view !== 'coach'}
                switching={switching === project} providerPicker={view === 'coach' ? providerPicker : undefined}
                task={coachTask} onClearTask={() => setCoachTask(null)} onModel={reportModel} />
          )}
          {current &&
            agentSessions.map((s) => (
              <SessionView
                key={`${s.id}:${s.engine}`}
                session={s}
                switching={switching === s.id}
                providerPicker={view === s.id ? providerPicker : undefined}
                project={current.path}
                hidden={view !== s.id}
                onDiff={showDiff}
                quotaNear={view === s.id && quota.near}
                onOpenFile={(path) => {
                  setFile(path);
                  setFileSession(s.worktree ? s.id : null);
                  setFileRoot(s.worktree);
                  setDiff(null);
                  openEditor();
                }}
                onConflicts={showConflicts} onStartWork={() => openWork()}
                onModel={reportModel}
              />
            ))}
          {current && !hasPm && view === 'coach' && (
            <div className="welcome">
              <h1>¿Qué hacemos?</h1>
              <p>Empieza una sesión en {current.name}.</p>
              <div className="welcome-actions">
                <button className="co-btn is-primary" onClick={() => newSession()}>Sesión normal</button>
                <button className="co-btn" onClick={() => startPm()}>
                  Con project manager
                </button>
              </div>
            </div>
          )}
          {!current && (
            <div className="welcome">
              <h1>¿Qué hacemos hoy?</h1>
              <p>Elige un proyecto a la izquierda.</p>
            </div>
          )}
        </div>
        <section id="project-terminal" className="terminal" aria-label="Terminal" hidden={!(current && termOpen)}>
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
            <button className="tb-btn" onClick={() => setTermOpen(false)} aria-label="Ocultar el terminal" title={shortcut('ocultar · ⌘J')}>
              <Icon name="down" size={12} />
            </button>
          </div>
          {terms
            .filter((t) => ws.projects.some((w) => w.path === t.project))
            .map((t) => (
              <Terminal key={t.id} project={t.project} agentSession={t.session ?? null} initial={t.initial} hidden={!termOpen || t.project !== project || t.id !== activeTerm} />
            ))}
        </section>
        {errorToast}
        {cliNotice && !error && <CliNotice updates={cliNotice} onClose={() => setCliNotice(null)}
          onOpen={() => { setCliNotice(null); setEngineOpen(null); setUsageOpen(true); }} />}
      </main>

      <nav className="rail" aria-label="Paneles y utilidades">
        {panelTabs.map((id) => {
          const panel = RIGHT_PANELS[id];
          const label = id === 'editor' && editorTab ? `Editor · ${editorTab.name}` : panel.title;
          const keys = 'keys' in panel ? ` · ${panel.keys}` : '';
          const active = panelOpen && rightView === id;
          return (
            <Fragment key={id}>
              <button className={`rail-btn${active ? ' is-on' : ''}`} onClick={() => showRight(id)}
                aria-label={label} aria-controls="workspace-right-panel" aria-expanded={active} title={shortcut(`${label}${keys}`)}>
                <Icon name={panel.icon} size={16} />
                {id === 'git' && dirty && <span className="dot is-dirty" />}
              </button>
            </Fragment>
          );
        })}
      </nav>

      {layout === 'code' && panelOpen && dest === 'workspace' && (
        <button className="tr-btn sm ws-back" onClick={() => setLayout('chat')} title={shortcut('Volver a la conversación · ⌘⌥1')}>
          <Icon name="chat" size={13} /> Conversación
        </button>
      )}
      <Right tab={rightView} hidden={!panelOpen} onEditor={openEditor} editor={editorTab} onCloseEditor={closeFile} root={ws.root} location={panelLocation}>
        <Browser visible={panelOpen && rightView === 'browser'} covered={!!overlay || usageOpen || !!engineOpen || githubOpen || dest !== 'workspace'} target={browserTarget} />
        {current && conflictFiles && (
          <Conflicts
            project={current.path}
            files={conflictFiles}
            hidden={!panelOpen || rightView !== 'conflicts'}
            onOpenFile={(path) => {
              setFile(path);
              setFileSession(null);
              setDiff(null);
              openEditor();
            }}
          />
        )}
        {panelOpen && current && rightView === 'git' && (
          <GitPanel
            key={current.path}
            project={current.path}
            selected={diff?.session == null ? diff : null}
            onDiff={showDiff}
            chooseBranch={chooseBranch}
            onBranchPickerOpened={clearBranchPicker}
            onDirty={setDirty}
            pending={pendingCount}
            onPending={openPending}
            onPublish={() => openWork('pulls', null)}
          />
        )}
        {panelOpen && current && rightView === 'files' && (
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
        {panelOpen && current && rightView === 'containers' && <Containers key={current.path} project={current.path} onOpen={openBrowser} />}
        {panelOpen && current && rightView === 'editor' &&
          editorTab &&
          <>
            {dest === 'workspace' && <WorkspaceChanges key={`${current.path}:${(diff ? diff.session : fileSession) ?? ''}`}
              project={current.path} session={(diff ? diff.session : fileSession) ?? null}
              onDiff={showDiff} onEntrega={() => { setEntregaScope((diff ? diff.session : fileSession) ?? null); setDest('entrega'); }} />}
            {diff ? <Diff project={current.path} change={diff} /> :
              <Editor path={file ?? ''} root={(fileSession != null ? fileRoot : null) ?? current.path} session={fileSession} onError={setError} />}
          </>}
      </Right>
      <footer className="statusbar" aria-label="Estado del proyecto">
        <div className="status-project">
          {current && <>
            <button className="status-action status-live" onClick={() => setDest(waiting > 0 ? 'inicio' : 'flow')} title="Actividad de los agentes">
              <Icon name="agent" size={13} />
              <span>{Object.values(activity).filter((a) => a === 'trabajando').length} trabajando</span>
              <span className={waiting > 0 ? 'amb' : undefined}>· {waiting} en espera</span>
            </button>
            <button className={`status-action status-terminal${termOpen ? ' is-on' : ''}`}
              onClick={() => { if (dest === 'workspace' || !termOpen) toggleTerminal(); setDest('workspace'); }}
              aria-controls="project-terminal" aria-expanded={dest === 'workspace' && termOpen} aria-label="Terminal" title={shortcut('Terminal · ⌘J')}>
              <Icon name="terminal" size={13} />
            </button>
          </>}
          {sessionWorktree?.branch && <span className="status-session-branch" title={`Rama de sesión · ${sessionWorktree.branch} ← ${sessionWorktree.base ?? '—'}`}>
            <Icon name="branch" size={12} /><span>{sessionWorktree.branch}</span>
          </span>}
        </div>
        <div ref={statusMeters} className="status-meters">
          <JevStatusButton open={usageOpen} buttonRef={usageButton} onClick={() => {
            setGithubOpen(false); setEngineOpen(null); setUsageOpen((open) => !open);
          }} />
          <EngineUsage project={project} projectName={current?.name ?? null} sessions={agentSessions} pmEngine={pmEngine === 'claude' ? 'claude' : 'codex'} hasPm={hasPm}
            open={engineOpen === 'jev' ? null : engineOpen} onOpen={(engine) => { setEngineOpen(engine); if (engine) { setGithubOpen(false); setUsageOpen(false); } }}
            onSession={(v) => { setView(v); setDest('workspace'); }} onSettings={() => setDest('ajustes')} />
          <JevUsage open={engineOpen === 'jev'} onOpen={(o) => { setEngineOpen(o ? 'jev' : null); if (o) { setGithubOpen(false); setUsageOpen(false); } }} onSettings={() => setDest('ajustes')} />
        </div>
      </footer>
      {overlay === 'palette' && <Palette commands={commands.filter((c) => c.id !== 'palette' && !LOCAL.has(c.id))} onClose={() => setOverlay(null)} />}
      {overlay === 'cheat' && <Cheatsheet commands={commands} onClose={() => setOverlay(null)} />}
    </div>
  );
}
