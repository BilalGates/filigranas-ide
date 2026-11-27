import { useAppUpdates } from './appUpdates';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, chats, git, sessions, tools as toolsApi, type ChatEngine, type DiffTarget, type CliUpdate, type RecentSession, type Session, type Tool, type Workspace } from './ipc';
import Onboarding from './Onboarding';
import type { ProviderSwitch } from './ModelConfigMenu';
import Editor from './Editor';
import Diff from './Diff';
import GitPanel, { Icon } from './GitPanel';
import Right, { RIGHT_PANELS, WIDE_RIGHT_PANELS, type RightTab } from './Right';
import FileTree from './FileTree';
import Terminal from './Terminal';
import Coordinator from './Coordinator';
import SessionView, { ENGINE_LABEL } from './Session';
import DesignCanvas from './DesignCanvas';
import WorkspaceChanges from './trama/WorkspaceChanges';
import { sidebarReference } from './designCanvasModel';
import Tools from './Tools';
import { useProviderQuota, useQuotaEvents } from './usageStore';
import { Cheatsheet, Palette, type Command } from './Palette';
import { emit, setLightTheme, shortcut, toggleMute, useCommand, useUi } from './ui';
import Conflicts from './Conflicts';
import Containers from './Containers';
import Browser from './Browser';
import Splitter, { SIZES } from './Splitter';
import GithubProfile from './GithubProfile';
import AmbientField from './trama/AmbientField';
import { DestNav, saveResume, TOOLS, type ToolId } from './trama/nav';
import WorkspaceShell from './trama/WorkspaceShell';
import {
  closeTool,
  createInitialShellState,
  minimizeWorkspace,
  onProjectSelected,
  openTool,
  persistShellState,
  resetWorkspaceRatio,
  resizeWorkspace,
  resolveStartupShell,
  restoreWorkspace,
  toggleMaximizeTool,
  toggleTool,
  visibleDisposition,
  type ShellState,
} from './trama/workspaceLayout';
import Home from './trama/Home';
import Flow from './trama/Flow';
import Studio from './trama/Studio';
import Entrega, { type EntregaStage } from './trama/Entrega';
import Boundary from './trama/Boundary';
import BrainView from './trama/BrainView';
import Explorer from './trama/Explorer';
import TitleSwitch from './trama/TitleSwitch';
import SystemKpi from './trama/SystemKpi';
import RecentSessions from './trama/RecentSessions';
import EngineUsage, { type Engine } from './trama/EngineUsage';
import JevUsage from './trama/JevUsage';
import Attention from './trama/Attention';
import { pushCliUpdatesNotification, pushOperationalError } from './trama/notifications';
import Settings from './trama/Settings';
import { Seg } from './trama/ui';
import { AgDot, sessionAgents } from './trama/kit';
import {
  computeMountedConversations,
  deriveWorkspaceContext,
  loadPersistedContext,
  pmActivityKey,
  resolveProjectEntry,
  savePersistedContext,
  selectionKey,
  type ActiveSelection,
} from './trama/workspaceContext';

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

// Acciones de la cabecera del Workspace: paneles, disposición y vuelta desde Código.
const WS_ACTIONS = '.ws-panels, .ws-layout, .ws-back';

/** El ratón no deja el foco en ellas: Chromium pintaba el anillo con la siguiente tecla. */
function noMouseFocus(e: ReactMouseEvent) {
  e.preventDefault();
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest(WS_ACTIONS)) focused.blur();
}

/** Si el cambio de disposición oculta el botón con el foco, el teclado pasa a su equivalente visible. */
function followFocus() {
  const from = document.activeElement;
  if (!from?.closest(WS_ACTIONS)) return;
  const shown = (el: Element) => el.isConnected && getComputedStyle(el).visibility !== 'hidden';
  requestAnimationFrame(() => {
    if (shown(from)) return;
    [...document.querySelectorAll<HTMLElement>('.ws-back .tr-btn, .ws-layout [aria-pressed="true"]')].find(shown)?.focus();
  });
}

export default function App() {
  useAppUpdates();
  useQuotaEvents();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [startupConfirmed, setStartupConfirmed] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const setError = useCallback((message: string | null) => {
    if (message) pushOperationalError(message);
  }, []);
  // Fuente única de verdad: activeSelection → session.project → activeProject.
  const [activeSelection, setActiveSelection] = useState<ActiveSelection>(null);
  const [lastByProject, setLastByProject] = useState<Record<string, Exclude<ActiveSelection, null>>>({});
  const [visitedKeys, setVisitedKeys] = useState<Set<string>>(() => new Set());
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [pmClaudeByProject, setPmClaudeByProject] = useState<Record<string, Session | null>>({});
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const loadedProjectsRef = useRef<Set<string>>(new Set());
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
  // Tarea que Flow debe seleccionar al abrirse (desde Inicio, Brain o la paleta).
  const [flowTask, setFlowTask] = useState<number | null>(null);
  // Etapa con la que se abre Entrega (Code Health, PR, commits, ramas sin integrar).
  const [entregaStage, setEntregaStage] = useState<EntregaStage | null>(null);
  const [coachTask, setCoachTask] = useState<{ id: number; title: string } | null>(null);
  const [pendingBranches, setPendingBranches] = useState<{ project: string; count: number } | null>(null);
  // CLI externas: se comprueban al arrancar y desde su vista.
  const [toolList, setToolList] = useState<Tool[] | null>(null);
  const [checkingTools, setCheckingTools] = useState(false);
  // Archivos con marcas de conflicto tras una integración.
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);
  const [rightView, setRightView] = useState<RightTab>('git');
  const [observed, setObserved] = useState<number | null>(null);
  const beforeObservation = useRef<{ tab: RightTab; hidden: boolean } | null>(null);
  const [observationTarget, setObservationTarget] = useState<HTMLDivElement | null>(null);
  const [observationTabs, setObservationTabs] = useState<HTMLElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const [flowFocus, setFlowFocus] = useState<{ project: string; task: number } | null>(null);
  const [switching, setSwitching] = useState<number | string | null>(null);
  const [githubOpen, setGithubOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState<Engine | 'jev' | null>(null);
  // Último resultado automático, para verlo en Herramientas y en el centro de notificaciones.
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
  const [chooseBranch, setChooseBranch] = useState(false);
  const clearBranchPicker = useCallback(() => setChooseBranch(false), []);

  const [overlay, setOverlay] = useState<'palette' | 'cheat' | null>(null);
  const [noSide, setNoSide] = useState(false);
  const [narrowSideOpen, setNarrowSideOpen] = useState(false);
  const [compactExplorerOpen, setCompactExplorerOpen] = useState(false);
  const [noRight, setNoRight] = useState(() => { try { return (localStorage.getItem('filigranas.disposicion') ?? 'chat') === 'chat'; } catch { return true; } });
  const [shell, setShell] = useState<ShellState>(() => createInitialShellState(false));
  const shellHydrated = useRef(false);
  const [attentionCovered, setAttentionCovered] = useState(false);
  const [browserMounted, setBrowserMounted] = useState(false);
  const [focusCi, setFocusCi] = useState<string | null>(null);
  const [entregaScope, setEntregaScope] = useState<number | null>(null);
  const [studioView, setStudioView] = useState<'captures' | 'canvas'>('captures');
  const [layout, setLayoutState] = useState<'chat' | 'split' | 'code'>(() => {
    try { const v = localStorage.getItem('filigranas.disposicion'); return v === 'split' || v === 'code' ? v : 'chat'; } catch { return 'chat'; }
  });
  const openToolInShell = useCallback((tool: ToolId) => {
    if (tool !== 'entrega') { setEntregaScope(null); setEntregaStage(null); }
    if (tool !== 'flow') setFlowTask(null);
    setShell((s) => openTool(s, tool));
  }, []);
  const toggleToolInShell = useCallback((tool: ToolId) => {
    setShell((s) => {
      const next = toggleTool(s, tool);
      if (next.activeTool !== 'entrega') { setEntregaScope(null); setEntregaStage(null); }
      if (next.activeTool !== 'flow') setFlowTask(null);
      return next;
    });
  }, []);
  const closeActiveTool = useCallback(() => {
    setEntregaScope(null);
    setEntregaStage(null);
    setFlowTask(null);
    setShell((s) => closeTool(s));
  }, []);
  const ensureWorkspaceVisible = useCallback(() => {
    setShell((s) => (s.mode === 'maximized' || s.mode === 'compact' ? restoreWorkspace(s) : s));
  }, []);
  useCommand('branch-tools', useCallback(() => {
    setRightView('git');
    setNoRight(false);
    ensureWorkspaceVisible();
    setChooseBranch(true);
  }, [ensureWorkspaceVisible]));
  useEffect(() => {
    if (shell.activeTool === 'browser') setBrowserMounted(true);
  }, [shell.activeTool]);
  const { activity, muted, light } = useUi();
  const validProjects = useMemo(
    () => (ws ? ws.projects.filter((p) => !p.archived).map((p) => p.path) : []),
    [ws],
  );
  const validProjectsKey = useMemo(() => JSON.stringify(validProjects), [validProjects]);
  const projectNames = useMemo(
    () => new Map((ws?.projects ?? []).map((p) => [p.path, p.name])),
    [ws],
  );
  const allOpenSessions = useMemo(
    () => Object.values(sessionsByProject).flat(),
    [sessionsByProject],
  );
  const sessionsById = useMemo(
    () => new Map(allOpenSessions.map((s) => [s.id, s])),
    [allOpenSessions],
  );
  const derived = useMemo(
    () =>
      deriveWorkspaceContext({
        selection: activeSelection,
        validProjects,
        sessionsById,
        catalogLoaded,
        projectNames,
      }),
    [activeSelection, validProjects, sessionsById, catalogLoaded, projectNames],
  );
  const project = derived.project;
  const view = derived.view;
  const activeSession = derived.activeSession;
  const currentProject = useRef(project);
  currentProject.current = project;
  const agentSessions = useMemo(
    () => (project ? sessionsByProject[project] ?? [] : []),
    [project, sessionsByProject],
  );
  const pmReady = !!project && catalogLoaded;
  const pmSession = project ? pmClaudeByProject[project] ?? null : null;
  const pmEngine = pmSession?.engine ?? 'codex';
  const mountedConversations = useMemo(
    () =>
      computeMountedConversations({
        active: derived.selection,
        visitedKeys,
        sessionsByProject,
        pmProjects,
        validProjects,
        activity,
      }),
    [derived.selection, visitedKeys, sessionsByProject, pmProjects, validProjects, activity],
  );
  useEffect(() => {
    setNarrowSideOpen(false);
  }, [shell.mode, shell.activeTool, view, project]);
  useEffect(() => {
    if (shell.mode !== 'compact') setCompactExplorerOpen(false);
  }, [shell.mode]);
  const usageEngine = activeSession?.engine ?? (project && pmReady && pmProjects.has(project) && view === 'coach' ? pmEngine : 'codex');
  const usageModel = reportedModel?.key === (activeSession?.id ?? project) && usageEngine ? reportedModel.model : null;
  const quota = useProviderQuota(usageEngine, usageModel, true);
  const sessionWorktree = activeSession?.worktree ? activeSession : null;

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
      (e) => {
        const msg = String(e);
        setWorkspaceError(msg);
        pushOperationalError(msg, { source: 'Espacio de trabajo' });
      },
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

  const markVisited = useCallback((sel: Exclude<ActiveSelection, null>) => {
    const key = selectionKey(sel);
    setVisitedKeys((cur) => {
      if (cur.has(key)) return cur;
      const next = new Set(cur);
      next.add(key);
      return next;
    });
  }, []);

  // Arranque: recupera la última sesión válida y su proyecto derivado, o abre Workspace + Inicio.
  useEffect(() => {
    if (!startupConfirmed || !ws?.root || shellHydrated.current) return;
    shellHydrated.current = true;
    const validPaths = ws.projects.filter((p) => !p.archived).map((p) => p.path);
    const persisted = loadPersistedContext(validPaths);
    const startup = resolveStartupShell(validPaths);
    setLastByProject(persisted.lastByProject);
    const initialSelection: ActiveSelection =
      persisted.active ?? (startup.project ? { kind: 'pm', project: startup.project } : null);
    setActiveSelection(initialSelection);
    if (initialSelection) {
      markVisited(initialSelection);
      setLastByProject((cur) => ({ ...cur, [initialSelection.project]: initialSelection }));
    }
    const nextShell = initialSelection
      ? (startup.project === initialSelection.project ? startup.shell : onProjectSelected(startup.shell))
      : createInitialShellState(false, null, startup.shell.workspaceRatio, startup.shell.lastToolMode);
    setShell(nextShell);
    if (nextShell.activeTool === 'browser') setBrowserMounted(true);
    if (!initialSelection && persisted.missingProject) {
      const label = persisted.missingProject.split(/[\\/]/).filter(Boolean).pop() ?? persisted.missingProject;
      setError(`El proyecto guardado «${label}» ya no está disponible o fue archivado.`);
    }
  }, [startupConfirmed, ws, markVisited]);

  // Persiste contexto global (sesión activa + última sesión por proyecto) y layout del shell.
  useEffect(() => {
    if (!shellHydrated.current || !ws?.root) return;
    savePersistedContext(derived.selection, lastByProject, validProjects);
    persistShellState(project, shell, validProjects);
  }, [derived.selection, lastByProject, project, shell, validProjects, ws?.root]);

  // Hidrata el catálogo global de sesiones y PMs en una sola consulta bulk (sin recargar al cambiar de conversación).
  useEffect(() => {
    if (!startupConfirmed || !ws?.root) return;
    const paths: string[] = JSON.parse(validProjectsKey);
    const missing = paths.filter((p) => !loadedProjectsRef.current.has(p));
    if (!missing.length) {
      setCatalogLoaded(true);
      return;
    }
    let alive = true;
    sessions.catalog(missing).then(
      (cat) => {
        if (!alive) return;
        for (const p of missing) loadedProjectsRef.current.add(p);
        setSessionsByProject((cur) => {
          const next = { ...cur };
          for (const p of missing) next[p] = [];
          for (const s of cat.sessions) {
            (next[s.project] ??= []).push(s);
          }
          return next;
        });
        setPmClaudeByProject((cur) => {
          const next = { ...cur };
          for (const p of missing) next[p] = cat.pmClaude[p] ?? null;
          return next;
        });
        const discoveredPms = [
          ...Object.keys(cat.pmClaude),
          ...cat.pmCodexProjects,
        ];
        if (discoveredPms.length) {
          setPmProjects((cur) => {
            let changed = false;
            const next = new Set(cur);
            for (const p of discoveredPms) {
              if (!next.has(p)) { next.add(p); changed = true; }
            }
            if (!changed) return cur;
            try { localStorage.setItem(PM_KEY, JSON.stringify([...next])); } catch { /* */ }
            return next;
          });
        }
        setCatalogLoaded(true);
      },
      (e) => {
        if (!alive) return;
        setError(String(e));
        setCatalogLoaded(true);
      },
    );
    return () => { alive = false; };
  }, [startupConfirmed, ws?.root, validProjectsKey]);

  // Suscripción única global: actualiza solo el proyecto afectado sin recargar el catálogo completo.
  useEffect(() => {
    let alive = true;
    const unlisten = listen<{ project: string; focus?: number | null }>('sessions-changed', ({ payload }) => {
      const targetProject = payload.project;
      sessions.list(targetProject).then(
        (list) => {
          if (!alive) return;
          setSessionsByProject((cur) => ({ ...cur, [targetProject]: list }));
          if (payload.focus != null && targetProject === currentProject.current && list.some((s) => s.id === payload.focus)) {
            const nextSel: Exclude<ActiveSelection, null> = { kind: 'session', sessionId: payload.focus, project: targetProject };
            setActiveSelection(nextSel);
            setLastByProject((cur) => ({ ...cur, [targetProject]: nextSel }));
            markVisited(nextSel);
          }
        },
        (e) => { if (alive) setError(String(e)); },
      );
    });
    return () => {
      alive = false;
      void unlisten.then((off) => off());
    };
  }, [markVisited]);

  // Gestión explícita cuando el proyecto o la sesión activa dejan de existir (sin reasignaciones silenciosas).
  useEffect(() => {
    if (!derived.staleReason) return;
    if (derived.staleReason === 'project_missing') {
      setActiveSelection(null);
      setFile(null);
      setDiff(null);
      setFileSession(null);
      setConflictFiles(null);
      setObserved(null);
      setCoachTask(null);
      setEntregaScope(null);
      setShell((s) => createInitialShellState(false, null, s.workspaceRatio, s.lastToolMode));
      if (derived.staleNotice) setError(derived.staleNotice);
    } else if (derived.staleReason === 'session_missing' || derived.staleReason === 'session_mismatch') {
      setActiveSelection(derived.selection);
      if (derived.selection) {
        setLastByProject((cur) => ({ ...cur, [derived.selection!.project]: derived.selection! }));
      }
      if (derived.staleNotice) setError(derived.staleNotice);
    }
  }, [derived.staleReason, derived.staleNotice, derived.selection]);

  const newSession = (engine?: string, task: number | null = null, skillRole: 'designer' | null = null, targetProject?: string | null) => {
    const destProject = targetProject ?? project;
    if (!destProject) return;
    const destPmEngine = pmClaudeByProject[destProject]?.engine ?? 'codex';
    const chosen = engine ?? (destPmEngine === 'claude' ? 'claude' : 'codex');
    sessions.create(destProject, chosen, task, skillRole).then(
      ({ notice, ...s }) => {
        setSessionsByProject((cur) => {
          const list = cur[s.project] ?? [];
          return { ...cur, [s.project]: list.some((item) => item.id === s.id) ? list : [...list, s] };
        });
        if (targetProject != null || currentProject.current === s.project) {
          const nextSel: Exclude<ActiveSelection, null> = { kind: 'session', sessionId: s.id, project: s.project };
          setActiveSelection(nextSel);
          setLastByProject((cur) => ({ ...cur, [s.project]: nextSel }));
          markVisited(nextSel);
          if (shell.activeTool === 'inicio') setShell((cur) => onProjectSelected(cur));
        }
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
    const unlisten = listen<CliUpdate[]>('cli-updates', (e) => {
      setCliLast(e.payload);
      pushCliUpdatesNotification(e.payload);
      checkTools();
    });
    return () => { unlisten.then((off) => off()); };
  }, [checkTools]);

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
    const closing = sessionsById.get(id);
    sessions.close(id).then(
      () => {
        if (closing) {
          const fallback: Exclude<ActiveSelection, null> = { kind: 'pm', project: closing.project };
          setActiveSelection((cur) => (cur?.kind === 'session' && cur.sessionId === id ? fallback : cur));
          setLastByProject((cur) => {
            const prev = cur[closing.project];
            return prev?.kind === 'session' && prev.sessionId === id ? { ...cur, [closing.project]: fallback } : cur;
          });
          setSessionsByProject((cur) => ({
            ...cur,
            [closing.project]: (cur[closing.project] ?? []).filter((s) => s.id !== id),
          }));
        }
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
    : sessionWorktree?.id ?? null;
  useEffect(() => {
    git.watch(project, watchedSession).catch((e) => setError(String(e)));
  }, [project, watchedSession]);

  // Sus terminales de worktree tampoco sobreviven si su sesión fue cerrada o limpiada.
  useEffect(() => {
    if (!catalogLoaded) return;
    setTerms((current) => {
      const kept = current.filter((t) => t.session == null || sessionsById.has(t.session));
      return kept.length === current.length ? current : kept;
    });
  }, [sessionsById, catalogLoaded]);

  const revealRight = (tab: RightTab) => {
    setRightView(tab);
    setNoRight(false);
    ensureWorkspaceVisible();
  };
  const showRight = (tab: RightTab) => {
    followFocus();
    if (tab === rightView && !noRight && shell.mode !== 'maximized' && shell.mode !== 'compact') setNoRight(true);
    else revealRight(tab);
  };

  // Lo que antes abría la vista Trabajo vive ahora en Entrega y en Flow.
  const openEntrega = (stage: EntregaStage | null, scope: Session | null = activeSession ?? null) => {
    setEntregaScope(scope?.id ?? null);
    setEntregaStage(stage);
    openToolInShell('entrega');
  };
  const openPending = () => openEntrega('integracion', null);
  const openTask = (path: string, task: number | null) => {
    if (path !== project) selectProject(path, { keepTool: true });
    setFlowTask(task);
    openToolInShell('flow');
  };
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
    if (project && catalogLoaded) saveResume({ project, view, at: Date.now() });
  }, [project, catalogLoaded, view]);

  const closeFile = () => {
    setFile(null);
    setDiff(null);
    setFileSession(null);
    setRightView((v) => (v === 'editor' ? 'git' : v));
  };

  if (!ws && !workspaceError) return <div className="app" />;
  if (!startupConfirmed || !ws?.root) return <Onboarding
    initialRoot={ws?.root ?? null}
    onDone={(workspace) => {
      shellHydrated.current = false;
      loadedProjectsRef.current = new Set();
      setCatalogLoaded(false);
      setWs(workspace);
      setWorkspaceError(null);
      setStartupConfirmed(true);
    }}
    recoveryError={workspaceError} onRetry={refresh}
    github={toolList?.find((tool) => tool.id === 'gh')} onToolsRefresh={checkTools} />;

  const current = ws.projects.find((p) => p.path === project);
  const resetProjectTransientUi = () => {
    setChooseBranch(false);
    setDirty(false);
    setCoachTask(null);
    closeFile();
    setConflictFiles(null);
    setObserved(null);
    beforeObservation.current = null;
    setEntregaScope(null);
    setFocusCi(null);
    setRightView((tab) => (tab === 'conflicts' || tab === 'observe' ? 'git' : tab));
  };

  /**
   * Cambia la sesión activa (fuente única de verdad). Deriva automáticamente
   * el proyecto asociado, sincroniza las herramientas abiertas sin cerrarlas
   * y conserva vivas las demás sesiones y procesos en segundo plano.
   */
  const selectSession = (next: ActiveSelection, opts?: { closeInicio?: boolean; ensureWorkspace?: boolean }) => {
    if (!next) {
      resetProjectTransientUi();
      setActiveSelection(null);
      setShell((s) => createInitialShellState(false, null, s.workspaceRatio, s.lastToolMode));
      return;
    }
    const projectChanged = next.project !== currentProject.current;
    if (projectChanged) resetProjectTransientUi();
    setActiveSelection(next);
    setLastByProject((cur) => ({ ...cur, [next.project]: next }));
    markVisited(next);
    if (opts?.closeInicio) {
      setShell((s) => onProjectSelected(s));
    } else if (opts?.ensureWorkspace) {
      ensureWorkspaceVisible();
    }
  };

  const selectView = (target: 'coach' | number, targetProject = current?.path ?? null, opts?: { closeInicio?: boolean; ensureWorkspace?: boolean }) => {
    if (!targetProject) return;
    selectSession(
      target === 'coach'
        ? { kind: 'pm', project: targetProject }
        : { kind: 'session', sessionId: target, project: targetProject },
      opts,
    );
  };

  /**
   * Selección de proyecto desde Inicio: recupera su última sesión válida si
   * existe, o entra a su PM/flujo real sin iniciar agentes artificialmente;
   * cierra Inicio y expande Workspace (salvo `keepTool` al abrir Flow/Entrega).
   */
  const selectProject = (path: string | null, opts?: { keepTool?: boolean }) => {
    if (!path) {
      selectSession(null);
      return;
    }
    const entry = resolveProjectEntry({
      project: path,
      validProjects,
      lastByProject,
      projectSessions: sessionsByProject[path] ?? [],
      hasPm: pmProjects.has(path),
    });
    selectSession(entry, { closeInicio: !opts?.keepTool });
  };
  const hasPm = !!current && pmProjects.has(current.path);
  const workflowFor = (targetProject: string) => ({
    sessions: sessionsByProject[targetProject] ?? [],
    onOpenFlow: (task?: number) => {
      if (targetProject !== currentProject.current) selectProject(targetProject, { keepTool: true });
      setFlowFocus(task == null ? null : { project: targetProject, task });
      openToolInShell('flow');
    },
    onSession: (id: number) => {
      selectSession({ kind: 'session', sessionId: id, project: targetProject }, { ensureWorkspace: true });
    },
    onObserve: (id: number) => {
      if (targetProject !== currentProject.current) selectSession({ kind: 'session', sessionId: id, project: targetProject });
      if (rightView !== 'observe') beforeObservation.current = { tab: rightView, hidden: noRight };
      setObserved(id);
      revealRight('observe');
    },
  });
  const startPm = (path = current?.path) => {
    if (!path) return;
    setPm(path, true);
    selectSession({ kind: 'pm', project: path }, { closeInicio: shell.activeTool === 'inicio' });
  };
  const changeEngine = (engine: ChatEngine) => {
    if (!current || switching !== null) return;
    const path = current.path;
    const id = activeSession?.id ?? null;
    setSwitching(id ?? path);
    chats.switchEngine(path, id, engine).then(
      (session) => {
        setReportedModel((model) => model?.key === (id ?? path) ? null : model);
        if (id === null) {
          setPmClaudeByProject((cur) => ({ ...cur, [path]: session }));
        } else if (session) {
          setSessionsByProject((cur) => ({
            ...cur,
            [path]: (cur[path] ?? []).map((item) => (item.id === id ? session : item)),
          }));
        }
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
    openToolInShell('browser');
  };
  const editorOpen = !!(current && (diff || file));
  // Disposición del Workspace. Chat: conversación con la columna derecha
  // libre. Dividida: conversación + editor ancho. Código: el editor ocupa
  // el centro (la conversación y los terminales siguen montados).
  const setLayout = (next: 'chat' | 'split' | 'code') => {
    followFocus();
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
    { id: 'pm', label: hasPm ? 'project manager' : 'sesión con project manager', keys: '⌘1', run: () => (hasPm ? selectView('coach') : startPm()) },
    ...agentSessions.slice(0, 8).map((s, i) => ({ id: `s${s.id}`, label: `sesión ${s.name}`, keys: `⌘${i + 2}`, run: () => selectView(s.id) })),
    { id: 'editor', label: 'editor', keys: '⌘E', run: () => editorOpen && (rightView === 'editor' ? setRightView('git') : openEditor()) },
    { id: 'files', label: 'archivos', keys: '⌘P', run: () => showRight('files') },
    { id: 'term', label: termOpen ? 'ocultar terminal' : 'abrir terminal', keys: '⌘J', run: toggleTerminal },
    { id: 'side', label: noSide ? 'mostrar barra lateral' : 'ocultar barra lateral', keys: '⌘B', run: toggleSidebar },
    { id: 'layout-chat', label: 'disposición · chat', keys: '⌘⌥1', run: () => setLayout('chat') },
    { id: 'layout-split', label: 'disposición · dividida', keys: '⌘⌥2', run: () => setLayout('split') },
    { id: 'layout-code', label: 'disposición · código', keys: '⌘⌥3', run: () => setLayout('code') },
    { id: 'right', label: noRight ? 'mostrar columna derecha' : 'ocultar columna derecha', keys: '⌘I', run: () => setNoRight((v) => !v) },
    ...(current ? [
      { id: 'tasks', label: 'Flow · tareas', run: () => openTask(current.path, null) },
      { id: 'health', label: 'Code Health', run: () => openEntrega('tests') },
      { id: 'pending', label: 'Ramas sin integrar', run: openPending },
    ] : []),
    { id: 'git', label: 'git', keys: '⌘G', run: () => showRight('git') },
    { id: 'pr', label: 'pull request', run: () => openEntrega('pr') },
    { id: 'containers', label: 'contenedores', keys: '⌘⇧O', run: () => current && toggleToolInShell('containers') },
    { id: 'browser', label: 'browser', run: () => toggleToolInShell('browser') },
    ...(shell.activeTool ? [
      { id: 'tool-maximize', label: shell.mode === 'maximized' ? 'restaurar vista dividida' : 'maximizar herramienta', keys: '⌘⇧F', run: () => setShell((s) => toggleMaximizeTool(s)) },
      { id: 'tool-close', label: 'cerrar herramienta activa', keys: '⌘⇧W', run: closeActiveTool },
    ] : []),
    { id: 'commit', label: 'commit', keys: '⌘⇧C', run: () => emit('commit') },
    { id: 'commit-push', label: 'commit y push', keys: '⌘⇧P', run: () => emit('commit-push') },
    { id: 'larry', label: 'Larry · commits', keys: '⌘⇧G', run: () => openEntrega('commit') },
    { id: 'send', label: 'enviar mensaje (⇧↩ salto de línea)', keys: '↩', run: () => {} },
    { id: 'stop', label: 'interrumpir', keys: '⌘.', run: () => {} },
    { id: 'model', label: 'modelo', keys: '⌘M', run: () => {} },
    { id: 'effort', label: 'esfuerzo', keys: '⌘⇧E', run: () => {} },
    { id: 'allow', label: 'aprobar permiso', keys: '⌘Y', run: () => {} },
    { id: 'deny', label: 'rechazar permiso', keys: '⌘N', run: () => {} },
    { id: 'usage', label: 'uso de los modelos', keys: '⌘U', run: toggleUsage },
    { id: 'mute', label: muted ? 'activar sonido' : 'silenciar', keys: '⌘⇧M', run: () => toggleMute() },
    { id: 'theme', label: 'cambiar tema', keys: '⌘⇧L', run: () => setLightTheme(!light) },
  ];
  const GLOBAL = new Set(['palette', 'cheat', 'usage', 'mute', 'theme', 'send', 'stop', 'model', 'effort', 'allow', 'deny', 'containers', 'browser', 'tasks', 'health', 'pending', 'pr', 'larry', 'tool-maximize', 'tool-close']);
  const commands: Command[] = [
    ...TOOLS.map((d) => ({
      id: `tool-${d.id}`,
      label: d.label,
      keys: d.keys,
      group: 'Órdenes',
      run: () => {
        if (d.id === 'containers' && !current) return;
        toggleToolInShell(d.id);
      },
    })),
    ...baseCommands.map((c) => {
      const wrapped = GLOBAL.has(c.id) ? c : { ...c, run: () => { ensureWorkspaceVisible(); c.run(); } };
      return { ...wrapped, group: wrapped.group ?? 'Órdenes' };
    }),
  ];

  // Atajos que resuelve la vista visible (conversación, editor).
  const LOCAL = new Set(['send', 'stop', 'model', 'effort', 'allow', 'deny']);

  // Búsqueda global (⌘K): proyectos, sesiones de todos los proyectos y órdenes.
  const paletteCommands: Command[] = (() => {
    const activeList = ws.projects.filter((p) => !p.archived);
    const groupNames = new Map(ws.groups.map((g) => [g.id, g.name]));
    const orderedProjects = [...activeList].sort((a, b) => {
      if (a.path === project) return -1;
      if (b.path === project) return 1;
      return a.name.localeCompare(b.name, 'es');
    });
    const sessionItems: Command[] = [];
    for (const p of orderedProjects) {
      const pmClaude = pmClaudeByProject[p.path] ?? null;
      const pPmEngine = pmClaude?.engine === 'claude' ? 'Claude' : 'Codex';
      const pmLive = activity[pmActivityKey(p.path)] ?? null;
      if (pmProjects.has(p.path)) {
        sessionItems.push({
          id: `pal-pm:${p.path}`,
          group: 'Sesiones',
          label: 'Project Manager',
          subtitle: `${p.name} · ${pPmEngine}`,
          keywords: `${p.name} project manager pm ${pPmEngine}`,
          state: pmLive,
          run: () => selectSession({ kind: 'pm', project: p.path }, { closeInicio: shell.activeTool === 'inicio' }),
        });
      }
      for (const s of sessionsByProject[p.path] ?? []) {
        const eng = s.engine === 'claude' ? 'Claude' : s.engine === 'codex' ? 'Codex' : (ENGINE_LABEL[s.engine] ?? s.engine);
        const st = activity[String(s.id)] ?? (s.status === 'trabajando' ? 'trabajando' : s.status === 'esperando' ? 'permiso' : null);
        sessionItems.push({
          id: `pal-sess:${s.id}`,
          group: 'Sesiones',
          label: s.title?.trim() || s.name,
          subtitle: `${p.name} · ${eng}${s.parentSession != null ? ' · subsesión' : ''}`,
          keywords: `${p.name} ${s.name} ${s.title ?? ''} ${eng} ${s.branch ?? ''} ${s.task ?? ''}`,
          state: st,
          run: () => selectSession({ kind: 'session', sessionId: s.id, project: p.path }, { closeInicio: shell.activeTool === 'inicio' }),
        });
      }
    }
    const projectItems: Command[] = orderedProjects.map((p) => {
      const gName = p.groupId != null ? groupNames.get(p.groupId) : undefined;
      return {
        id: `pal-proj:${p.path}`,
        group: 'Proyectos',
        label: p.name,
        subtitle: gName ? `${gName} · abrir proyecto` : 'Abrir proyecto',
        keywords: `${p.name} ${gName ?? ''} proyecto`,
        run: () => selectProject(p.path, { keepTool: shell.activeTool != null && shell.activeTool !== 'inicio' }),
      };
    });
    const orderItems = commands.filter((c) => c.id !== 'palette' && !LOCAL.has(c.id) && !/^s\d+$/.test(c.id));
    return [...sessionItems, ...projectItems, ...orderItems];
  })();
  const KEY: Record<string, string> = { Enter: '↩', Period: '.', Slash: '/', Backquote: '`', Comma: ',' };
  keys.current = (e) => {
    if (e.defaultPrevented || (e.target instanceof Element && e.target.closest('.tr-modal'))) return;
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
  const centerTitle = !current ? null
    : view === 'coach' && hasPm
      ? { name: 'Project manager', meta: pmEngine === 'claude' ? 'Claude Code' : 'Codex', tag: null, state: sessionState(pmActivityKey(current.path)) }
      : activeSession
        ? {
            name: activeSession.title?.trim() || activeSession.name,
            meta: ENGINE_LABEL[activeSession.engine] ?? activeSession.engine,
            tag: activeSession.parentSession != null ? 'subsesión' : null,
            state: sessionState(String(activeSession.id)) ?? (activeSession.status === 'trabajando' ? 'trabajando' : activeSession.status === 'esperando' ? 'permiso' : null),
          }
        : { name: current.name, meta: 'Workspace', tag: null, state: null };

  const chatEngine = activeSession?.engine ?? (view === 'coach' && hasPm && pmReady ? pmEngine : null);
  const providerSwitch: ProviderSwitch | undefined = (chatEngine === 'codex' || chatEngine === 'claude')
    ? {
        engine: chatEngine,
        disabled: switching !== null || !!centerTitle?.state,
        title: centerTitle?.state ? 'Interrumpe el turno o espera a que termine para cambiar de proveedor' : 'Cambiar de proveedor',
        onChange: (value) => changeEngine(value),
      }
    : undefined;

  const editorPath = diff?.path ?? file;
  const editorScope = diff ? diff.session : fileSession;
  const editorRoot = editorScope == null ? current?.path
    : agentSessions.find((session) => session.id === editorScope)?.worktree ?? (diff ? null : fileRoot) ?? current?.path;
  const panelLocation = rightView === 'editor' && editorPath && editorRoot
    ? /^([a-zA-Z]:)?[\\/]/.test(editorPath) ? editorPath : `${editorRoot.replace(/[\\/]+$/, '')}/${editorPath}`
    : current?.path ?? null;
  const editorTab = current && editorPath ? { name: editorPath.split(/[\\/]/).pop() ?? '', path: editorPath, diff: !!diff } : null;
  const observing = agentSessions.find((session) => session.id === observed && session.project === current?.path);
  const observedPanel = shell.mode !== 'maximized' && shell.mode !== 'compact' && rightView === 'observe' && !noRight ? observing : undefined;
  const closeObservation = () => {
    setObserved(null);
    setNoRight(beforeObservation.current?.hidden ?? true);
    setRightView(beforeObservation.current?.tab ?? 'git');
    beforeObservation.current = null;
  };
  const panelOpen = !noRight && !!current && (rightView !== 'observe' || !!observing);
  // Cambios y Archivos viven en la cabecera del Workspace; Browser y Contenedores
  // viven como herramientas acoplables. El rail solo muestra paneles contextuales.
  const panelTabs = (Object.keys(RIGHT_PANELS) as RightTab[]).filter((tab) => {
    if (tab === 'git' || tab === 'files') return false;
    if (tab === 'observe') return !!observing;
    if (tab === 'editor') return !!editorTab;
    if (tab === 'conflicts') return !!current && !!conflictFiles;
    return true;
  });
  // Cambios y Archivos: en la cabecera del Workspace y, en Código, junto a «Conversación».
  const panelButtons = (
    <div className="ws-panels tr-seg" role="group" aria-label="Paneles del proyecto" onMouseDown={noMouseFocus}>
      {(['git', 'files'] as const).map((id) => {
        const panel = RIGHT_PANELS[id];
        const active = panelOpen && rightView === id;
        return (
          <button key={id} onClick={() => showRight(id)}
            aria-label={panel.title} aria-pressed={active} aria-controls="workspace-right-panel" title={shortcut(`${panel.title} · ${panel.keys}`)}>
            <Icon name={panel.icon} size={13} />
            {id === 'git' && dirty && <span className="dot is-dirty" />}
          </button>
        );
      })}
    </div>
  );
  const headerAgents = current ? sessionAgents(agentSessions, activity, hasPm ? { engine: pmEngine === 'claude' ? 'Claude' : 'Codex' } : null, current.path) : [];
  const dimByTool: Record<ToolId, number> = { inicio: 1, flow: 0.9, studio: 0.55, entrega: 0.7, brain: 0.85, containers: 0.65, browser: 0.5, ajustes: 0.6 };
  const fieldDim = shell.activeTool ? dimByTool[shell.activeTool] : (layout === 'code' ? 0.35 : 0.7);
  const waiting = Object.values(activity).filter((a) => a === 'permiso').length;
  const workingCount = Object.values(activity).filter((a) => a === 'trabajando').length;
  const navBadges: Partial<Record<ToolId, number>> = { flow: waiting };
  const navLive: Partial<Record<ToolId, boolean>> = { flow: workingCount > 0 };
  const activeCompactAgent = view === 'coach'
    ? headerAgents.find((a) => a.id === 'pm') ?? null
    : headerAgents.find((a) => a.session === view) ?? null;
  const compactInfo = {
    projectName: current?.name ?? null,
    conversationName: centerTitle?.name ?? 'Workspace',
    activeAgent: activeCompactAgent,
    workingCount,
    waitingCount: waiting,
  };
  const useMemoryInChat = (snippet: string) => {
    ensureWorkspaceVisible();
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('filigranas:insert-chat', { detail: snippet }));
      focusConversation();
    });
  };

  const openRecentSession = (item: RecentSession) => {
    if (item.isPm) {
      setPm(item.project, true);
      selectSession({ kind: 'pm', project: item.project }, { closeInicio: true });
    } else if (item.sessionId != null) {
      if (item.closed) {
        sessions.reopen(item.sessionId).then(
          (reopened) => {
            setSessionsByProject((cur) => {
              const list = cur[reopened.project] ?? [];
              return { ...cur, [reopened.project]: list.some((s) => s.id === reopened.id) ? list : [...list, reopened] };
            });
            selectSession({ kind: 'session', sessionId: reopened.id, project: reopened.project }, { closeInicio: true });
          },
          () => { selectProject(item.project); },
        );
      } else {
        selectSession({ kind: 'session', sessionId: item.sessionId, project: item.project }, { closeInicio: true });
      }
    } else {
      selectProject(item.project);
    }
    requestAnimationFrame(focusConversation);
  };

  const activeToolNode = (() => {
    switch (shell.activeTool) {
      case 'inicio':
        return (
          <Boundary name="Inicio">
            <Home
              active={true}
              ws={ws}
              project={project}
              agentSessions={allOpenSessions}
              sessionsByProject={sessionsByProject}
              onWs={setWs}
              onError={setError}
              onCi={(path) => { if (path !== project) selectProject(path, { keepTool: true }); setEntregaScope(null); setFocusCi(path); openToolInShell('entrega'); }}
              onProject={(path) => selectProject(path)}
              onSession={(path, v) => {
                if (v === 'coach') setPm(path, true);
                selectView(v, path, { closeInicio: true });
                requestAnimationFrame(focusConversation);
              }}
              onOpenRecentSession={openRecentSession}
              onWork={(path, task) => { if (task) openTask(path, task); else { if (path !== project) selectProject(path, { keepTool: true }); openEntrega('tarea', null); } }}
            />
          </Boundary>
        );
      case 'flow':
        return (
          <Boundary name="Flow">
            <Flow key={project ?? 'none'} project={project} projectName={current?.name ?? null} initialTask={flowFocus?.project === project ? flowFocus?.task : null} agentSessions={agentSessions}
              pm={hasPm ? { engine: pmEngine === 'claude' ? 'Claude' : 'Codex' } : null}
              onOpenSession={(id) => { selectView(id, undefined, { ensureWorkspace: true }); requestAnimationFrame(focusConversation); }}
              focusTask={flowTask}
              onAuto={(task) => { if (!project) return; setPm(project, true); setCoachTask(task); selectView('coach', project, { ensureWorkspace: true }); requestAnimationFrame(focusConversation); }}
              onDirect={(engine, task) => { newSession(engine, task); ensureWorkspaceVisible(); }}
              onStartPm={() => { if (project && !hasPm) startPm(project); else selectView('coach', project, { ensureWorkspace: true }); }} />
          </Boundary>
        );
      case 'studio':
        return (
          <Boundary name="Studio">
            <Studio key={project ?? 'none'} project={project} projectName={current?.name ?? null} agentSessions={agentSessions}
              view={studioView} onView={setStudioView} onNewSession={() => { newSession('claude', null, 'designer'); ensureWorkspaceVisible(); }}
              canvas={current && <DesignCanvas key={current.path} project={current.path}
                reference={sidebarReference(ws, current.path, agentSessions.filter((session) => session.project === current.path), hasPm, view)}
                archived={ws.projects.filter((item) => item.archived).length}
                conversation={<button className="btn sm" onClick={() => { ensureWorkspaceVisible(); requestAnimationFrame(focusConversation); }}><Icon name="chat" size={13} /> Conversación</button>} />}
              onOpenSession={(id) => { selectView(id, undefined, { ensureWorkspace: true }); requestAnimationFrame(focusConversation); }}
              onBrowser={() => openToolInShell('browser')} />
          </Boundary>
        );
      case 'entrega':
        return (
          <Boundary name="Entrega">
            <Entrega key={project ?? 'none'} initialScope={entregaScope} initialStage={entregaStage} initialCi={focusCi === project && focusCi != null} onConsumeCi={() => setFocusCi(null)} project={project} projectName={current?.name ?? null} agentSessions={agentSessions}
              onConflicts={(files) => showConflicts(files)} onBranchesChanged={countPending}
              onFile={(path, id, root) => { setFile(path); setFileSession(id); setFileRoot(root); setDiff(null); openEditor(); }} />
          </Boundary>
        );
      case 'brain':
        return (
          <Boundary name="Brain">
            <BrainView key={project ?? 'none'} project={project} projects={ws.projects}
              onOpenTask={(id, proj) => { const path = proj ?? project; if (path) openTask(path, id); }}
              onUseInChat={current ? useMemoryInChat : undefined} />
          </Boundary>
        );
      case 'containers':
        return (
          <Boundary name="Contenedores">
            <div className="tv tr-root tool-containers">
              {current ? (
                <Containers key={current.path} project={current.path} projectName={current.name} onOpen={openBrowser} />
              ) : (
                <div className="welcome">
                  <h1>Contenedores y servicios</h1>
                  <p>Selecciona un proyecto en Inicio para administrar sus contenedores Docker y servicios locales.</p>
                  <div className="welcome-actions">
                    <button className="co-btn is-primary" onClick={() => openToolInShell('inicio')}>Abrir Inicio</button>
                  </div>
                </div>
              )}
            </div>
          </Boundary>
        );
      case 'ajustes':
        return (
          <Boundary name="Ajustes">
            <Settings agentSessions={agentSessions} project={project} projectName={current?.name ?? null} tools={toolList} checking={checkingTools} autoUpdates={cliLast}
              onRefreshTools={checkTools} onLogin={current ? (command) => { ensureWorkspaceVisible(); openTerminal(current.path, true, command); } : null}
              usage={{ engine: usageEngine, label: usageLabel, model: usageModel, quota }} commands={commands} />
          </Boundary>
        );
      default:
        return null;
    }
  })();

  const browserLayer = (
    <Browser
      visible={shell.activeTool === 'browser'}
      covered={!!overlay || usageOpen || !!engineOpen || githubOpen || attentionCovered}
      target={browserTarget}
      project={project}
      projectName={current?.name ?? null}
    />
  );

  const renderExplorer = (opts?: { onPicked?: () => void; keepCompact?: boolean }) => (
    <Explorer
      ws={ws}
      selection={derived.selection}
      project={project}
      sessionsByProject={sessionsByProject}
      pmProjects={pmProjects}
      pmClaudeByProject={pmClaudeByProject}
      onSelectSession={(next) => {
        selectSession(next, { closeInicio: shell.activeTool === 'inicio' });
        opts?.onPicked?.();
      }}
      onSelectProject={(path) => {
        selectProject(path, { keepTool: shell.activeTool != null && shell.activeTool !== 'inicio' });
        opts?.onPicked?.();
      }}
      onNewSession={(path) => {
        newSession(undefined, null, null, path);
        opts?.onPicked?.();
      }}
      onStartPm={(path) => {
        setPm(path, true);
        selectSession({ kind: 'pm', project: path }, { closeInicio: shell.activeTool === 'inicio' });
        opts?.onPicked?.();
      }}
      onHidePm={(path) => {
        setPm(path, false);
        const first = (sessionsByProject[path] ?? [])[0];
        if (project === path && view === 'coach' && first) {
          selectSession({ kind: 'session', sessionId: first.id, project: path });
        }
      }}
      onCloseSession={closeSession}
      onUpdate={update}
      onProjectView={(path, tab) => {
        if (tab === 'containers') {
          if (path !== project) selectProject(path, { keepTool: true });
          openToolInShell('containers');
          opts?.onPicked?.();
          return;
        }
        if (path !== project) selectProject(path, { keepTool: !opts?.keepCompact && shell.activeTool != null && shell.activeTool !== 'inicio' });
        revealRight(tab);
        opts?.onPicked?.();
      }}
      onProjectTerminal={(path) => {
        if (path !== project) selectProject(path, { keepTool: shell.activeTool != null && shell.activeTool !== 'inicio' });
        ensureWorkspaceVisible();
        openTerminal(path);
        opts?.onPicked?.();
      }}
      onError={setError}
      footer={muted && (
        <button type="button" className="btn sm ghost" onClick={() => toggleMute()} title={shortcut('silenciado · ⌘⇧M')}>
          <Icon name="mute" size={12} /> Silenciado
        </button>
      )}
    />
  );

  return (
    <div className="app">
      <AmbientField dim={fieldDim} />
      <header className="titlebar" data-tauri-drag-region>
        <div className="tb-left" data-tauri-drag-region>
          <TitleSwitch
            ws={ws}
            selection={derived.selection}
            project={project}
            sessionsByProject={sessionsByProject}
            activity={activity}
          />
        </div>
        <div className="tb-center">
          <button className="tb-pill" onClick={() => setOverlay('palette')} title={shortcut('Buscar proyecto, sesión u orden · ⌘K')}>
            <Icon name="search" size={14} />
            <span className="grow">Buscar proyecto, sesión u orden…</span>
            <kbd>{shortcut('⌘K')}</kbd>
          </button>
          {current && (
            <button
              className={`tb-btn tb-term${termOpen && shell.mode !== 'maximized' && shell.mode !== 'compact' ? ' is-on' : ''}`}
              onClick={() => { ensureWorkspaceVisible(); toggleTerminal(); }}
              aria-controls="project-terminal"
              aria-expanded={termOpen && shell.mode !== 'maximized' && shell.mode !== 'compact'}
              aria-label="Terminal"
              title={shortcut('Terminal · ⌘J')}
            >
              <Icon name="terminal" size={15} />
            </button>
          )}
        </div>
        <div className="tb-right" data-tauri-drag-region>
          {current && <button className="tb-agents tv" aria-label="Agentes de este proyecto" title="Agentes de este proyecto" onClick={() => toggleToolInShell('flow')}>
            {headerAgents.length === 0 && <><Icon name="agent" size={13} /><span>0</span></>}
            {headerAgents.slice(0, 5).map((agent) => <AgDot key={agent.id} a={agent} s={12} />)}
            {headerAgents.length > 5 && <span>+{headerAgents.length - 5}</span>}
          </button>}
          <Attention
            onOverlayChange={setAttentionCovered}
            project={project}
            projectName={current?.name ?? null}
            projects={ws.projects}
            sessions={agentSessions}
            allSessions={allOpenSessions}
            activity={activity}
            onSession={(id, sessionProject) => selectView(id, sessionProject ?? project, { ensureWorkspace: true })}
            onTask={(id) => { if (project) openTask(project, id); }}
            onEntrega={(stage) => openEntrega(stage, null)}
            onHome={() => openToolInShell('inicio')}
            onTools={() => { setEngineOpen(null); setGithubOpen(false); setUsageOpen(true); }}
            onSettings={() => openToolInShell('ajustes')}
          />
        </div>
      </header>

      <DestNav
        activeTool={shell.activeTool}
        onTool={toggleToolInShell}
        badges={navBadges}
        live={navLive}
        disabledTools={{ containers: !current }}
        github={<GithubProfile tool={toolList?.find((tool) => tool.id === 'gh')} open={githubOpen} onRefresh={checkTools}
          onOpenChange={(open) => { setGithubOpen(open); if (open) { setEngineOpen(null); setUsageOpen(false); } }} />}
      />

      <WorkspaceShell
        state={shell}
        compactInfo={compactInfo}
        browserMounted={browserMounted}
        compactExplorer={renderExplorer({ onPicked: () => setCompactExplorerOpen(false), keepCompact: true })}
        compactExplorerOpen={compactExplorerOpen}
        onToggleCompactExplorer={() => setCompactExplorerOpen((v) => !v)}
        onCloseCompactExplorer={() => setCompactExplorerOpen(false)}
        onResize={(px, available) => setShell((s) => resizeWorkspace(s, px, available))}
        onResetRatio={() => setShell((s) => resetWorkspaceRatio(s))}
        onMinimizeWorkspace={() => setShell((s) => minimizeWorkspace(s))}
        onRestoreWorkspace={() => { setCompactExplorerOpen(false); setShell((s) => restoreWorkspace(s)); }}
        onCloseTool={closeActiveTool}
        tool={activeToolNode}
        browserLayer={browserLayer}
        workspace={(geometry) => {
          const collapsedSide = noSide || geometry.collapseWorkspaceSidebar;
          const showDrawer = collapsedSide && narrowSideOpen;
          const wsPanelOpen = panelOpen && (!geometry.collapseWorkspaceSidebar || rightView === 'editor' || rightView === 'conflicts' || rightView === 'observe');
          // En Código el panel ocupa el centro; Observación siempre acompaña a la conversación.
          const codeView = layout === 'code' && wsPanelOpen && rightView !== 'observe';
          return (
            <div className={`ws-inner${wsPanelOpen ? ' has-panel' : ''}${collapsedSide ? ' no-side' : ''}${geometry.collapseWorkspaceSidebar ? ' is-split-narrow' : ''}${showDrawer ? ' has-side-drawer' : ''}${wsPanelOpen && WIDE_RIGHT_PANELS.has(rightView) ? ' is-wide' : ''}${codeView ? ' lay-code' : ''}${layout === 'split' && wsPanelOpen ? ' is-wide' : ''}`}>
              {showDrawer && <div className="ws-drawer-backdrop" onClick={() => setNarrowSideOpen(false)} aria-hidden="true" />}
              {renderExplorer({ onPicked: () => setNarrowSideOpen(false) })}
              {!collapsedSide && <Splitter size={SIZES.side} axis="x" label="Ancho de la barra lateral" className="is-side" />}

              <main className="panel center" ref={centerPanel} tabIndex={-1}>
                {(centerTitle || collapsedSide) && (
                  <div className="center-head">
                    {collapsedSide && (
                      <button
                        type="button"
                        className={`tb-btn ws-side-toggle${showDrawer ? ' is-on' : ''}`}
                        onClick={() => setNarrowSideOpen((v) => !v)}
                        aria-label="Mostrar explorador de proyectos y conversaciones"
                        aria-expanded={showDrawer}
                        title={shortcut('Explorador · ⌘B')}
                      >
                        <Icon name="sidebar" size={14} />
                      </button>
                    )}
                    {centerTitle && <>
                      <span className={`dot${centerTitle.state ? ` is-${centerTitle.state}` : ''}`} />
                      <span className="ch-name">{centerTitle.name}</span>
                      {centerTitle.tag && <span className="tag">{centerTitle.tag}</span>}
                      {!providerSwitch && centerTitle.meta && <span className="ch-meta">{centerTitle.meta}</span>}
                      {centerTitle.state && <span className={`ch-state is-${centerTitle.state}`}>{centerTitle.state === 'permiso' ? 'espera tu permiso' : 'trabajando'}</span>}
                    </>}
                    <span className="grow" />
                    {current && !geometry.collapseWorkspaceSidebar && panelButtons}
                    {current && !geometry.collapseWorkspaceSidebar && (
                      <div className="ws-layout" onMouseDown={noMouseFocus}><Seg label="Disposición" value={visibleDisposition(layout, wsPanelOpen, rightView === 'observe')} onChange={setLayout} items={[
                        { id: 'chat', label: 'Conversación', icon: 'chat' }, { id: 'split', label: 'Dividida', icon: 'split' }, { id: 'code', label: 'Código', icon: 'code' }]} /></div>
                    )}
                    {activeSession && (
                      <button className="tb-btn" onClick={() => closeSession(activeSession.id)} aria-label="Cerrar sesión" title="cerrar sesión">
                        <Icon name="close" size={11} />
                      </button>
                    )}
                  </div>
                )}
                <div className="main-view">
                  {catalogLoaded && mountedConversations.pmProjects.map((pmPath) => {
                    const isActivePm = derived.selection?.kind === 'pm' && derived.selection.project === pmPath;
                    const pmSess = pmClaudeByProject[pmPath] ?? null;
                    const wf = workflowFor(pmPath);
                    return pmSess ? (
                      <SessionView
                        key={'coach-claude:' + pmPath}
                        session={pmSess}
                        project={pmPath}
                        hidden={!isActivePm}
                        switching={switching === pmPath}
                        providerSwitch={isActivePm ? providerSwitch : undefined}
                        onDiff={showDiff}
                        onModel={reportModel}
                        workflow={wf}
                        manager={{ task: isActivePm ? coachTask : null, clearTask: () => setCoachTask(null) }}
                      />
                    ) : (
                      <Coordinator
                        key={'coach:' + pmPath}
                        project={pmPath}
                        onDiff={showDiff}
                        hidden={!isActivePm}
                        switching={switching === pmPath}
                        providerSwitch={isActivePm ? providerSwitch : undefined}
                        task={isActivePm ? coachTask : null}
                        onClearTask={() => setCoachTask(null)}
                        onModel={reportModel}
                        workflow={wf}
                      />
                    );
                  })}
                  {mountedConversations.sessions.map((s) => {
                    const isActiveSess =
                      derived.selection?.kind === 'session' &&
                      derived.selection.sessionId === s.id &&
                      derived.selection.project === s.project;
                    const projectPmId = pmClaudeByProject[s.project]?.id ?? null;
                    return (
                      <SessionView
                        key={`${s.id}:${s.engine}`}
                        session={s}
                        switching={switching === s.id}
                        providerSwitch={isActiveSess ? providerSwitch : undefined}
                        project={s.project}
                        hidden={!isActiveSess}
                        observation={observedPanel?.id === s.id ? observationTarget : null}
                        onDiff={showDiff}
                        quotaNear={isActiveSess && quota.near}
                        onOpenFile={(path) => {
                          setFile(path);
                          setFileSession(s.worktree ? s.id : null);
                          setFileRoot(s.worktree);
                          setDiff(null);
                          openEditor();
                        }}
                        onConflicts={showConflicts}
                        onStartWork={() => openEntrega('tarea', null)}
                        onModel={reportModel}
                        parentPermissionScope={s.parentSession != null ? (s.parentSession === projectPmId ? `pm:${s.project}` : String(s.parentSession)) : undefined}
                      />
                    );
                  })}
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
                    <RecentSessions
                      projects={ws.projects}
                      inicioOpen={shell.activeTool === 'inicio'}
                      onOpenInicio={() => openToolInShell('inicio')}
                      onOpenSession={openRecentSession}
                    />
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
              </main>

              {panelTabs.length > 0 && <nav className="rail" aria-label="Paneles y utilidades">
                {panelTabs.map((id) => {
                  const panel = RIGHT_PANELS[id];
                  const label = id === 'editor' && editorTab ? `Editor · ${editorTab.name}` : panel.title;
                  const keys = 'keys' in panel ? ` · ${panel.keys}` : '';
                  const active = wsPanelOpen && rightView === id;
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
              </nav>}

              <Right tab={rightView} hidden={!wsPanelOpen} onEditor={openEditor} editor={editorTab} onCloseEditor={closeFile}
                observation={observedPanel ? { title: `Observando · ${observedPanel.name}`, close: closeObservation, tabs: setObservationTabs, mark: (() => { const agent = headerAgents.find((item) => item.session === observedPanel.id); return agent ? <span className="tv obs-mark"><AgDot a={agent} s={12} /></span> : null; })() } : undefined}
                root={ws.root} location={panelLocation}
                actions={codeView && (
                  <div className="ws-back" onMouseDown={noMouseFocus}>
                    {current && panelButtons}
                    <button className="tr-btn sm" onClick={() => setLayout('chat')} title={shortcut('Volver a la conversación · ⌘⌥1')}>
                      <Icon name="chat" size={13} /> Conversación
                    </button>
                  </div>
                )}>
                {current && conflictFiles && (
                  <Conflicts
                    project={current.path}
                    files={conflictFiles}
                    hidden={!wsPanelOpen || rightView !== 'conflicts'}
                    onOpenFile={(path) => {
                      setFile(path);
                      setFileSession(null);
                      setDiff(null);
                      openEditor();
                    }}
                  />
                )}
                {wsPanelOpen && current && rightView === 'git' && (
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
                    onPublish={() => openEntrega('pr', null)}
                  />
                )}
                {wsPanelOpen && current && rightView === 'files' && (
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
                {observedPanel && <section className="workspace-observation" aria-label={`Observando a ${observedPanel.name}`}>
                  <WorkspaceChanges key={observedPanel.id} project={observedPanel.project} session={observedPanel.worktree ? observedPanel.id : null}
                    conversation={<div ref={setObservationTarget} className="workspace-observation-log" />} tabsTarget={observationTabs}
                    onDiff={showDiff} onEntrega={() => { setEntregaScope(observedPanel.worktree ? observedPanel.id : null); openToolInShell('entrega'); }} />
                </section>}
                {wsPanelOpen && current && rightView === 'editor' &&
                  editorTab &&
                  <>
                    <WorkspaceChanges key={`${current.path}:${(diff ? diff.session : fileSession) ?? ''}`}
                      project={current.path} session={(diff ? diff.session : fileSession) ?? null}
                      onDiff={showDiff} onEntrega={() => { setEntregaScope((diff ? diff.session : fileSession) ?? null); openToolInShell('entrega'); }} />
                    {diff ? <Diff project={current.path} change={diff} /> :
                      <Editor path={file ?? ''} root={(fileSession != null ? fileRoot : null) ?? current.path} session={fileSession} onError={setError} />}
                  </>}
              </Right>
            </div>
          );
        }}
      />

      {usageOpen && (
        <section ref={usagePopup} id="usage-popup" className="usage-popup" role="region" aria-label="Herramientas y Jev">
          <header>
            <h2>Herramientas y Jev</h2>
            <button className="icon" aria-label="Cerrar uso" onClick={() => { setUsageOpen(false); usageButton.current?.focus(); }}><Icon name="close" size={12} /></button>
          </header>
          <Tools tools={toolList} checking={checkingTools} hidden={false} onRefresh={checkTools} autoUpdates={cliLast}
            onLogin={current ? (command) => { setUsageOpen(false); ensureWorkspaceVisible(); openTerminal(current.path, true, command); } : null} />
        </section>
      )}

      <footer className="statusbar" aria-label="Estado del sistema y uso">
        <div className="status-project">
          <SystemKpi />
          {sessionWorktree?.branch && <span className="status-session-branch" title={`Rama de sesión · ${sessionWorktree.branch} ← ${sessionWorktree.base ?? '—'}`}>
            <Icon name="branch" size={12} /><span>{sessionWorktree.branch}</span>
          </span>}
        </div>
        <div ref={statusMeters} className="status-meters">
          <EngineUsage project={project} projectName={current?.name ?? null} sessions={agentSessions} pmEngine={pmEngine === 'claude' ? 'claude' : 'codex'} hasPm={hasPm}
            open={engineOpen === 'jev' ? null : engineOpen} onOpen={(engine) => { setEngineOpen(engine); if (engine) { setGithubOpen(false); setUsageOpen(false); } }}
            onSession={(v) => selectView(v, undefined, { ensureWorkspace: true })} onSettings={() => openToolInShell('ajustes')} />
          <JevUsage open={engineOpen === 'jev'} buttonRef={usageButton} onOpen={(o) => { setEngineOpen(o ? 'jev' : null); if (o) { setGithubOpen(false); setUsageOpen(false); } }}
            onSettings={() => openToolInShell('ajustes')} onTools={() => { setGithubOpen(false); setUsageOpen(true); }} />
        </div>
      </footer>
      {overlay === 'palette' && <Palette commands={paletteCommands} onClose={() => setOverlay(null)} />}
      {overlay === 'cheat' && <Cheatsheet commands={commands} onClose={() => setOverlay(null)} />}
    </div>
  );
}
