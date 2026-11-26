export type ToolId =
  | 'inicio'
  | 'flow'
  | 'studio'
  | 'entrega'
  | 'brain'
  | 'containers'
  | 'browser'
  | 'ajustes';

export type ToolSpec = {
  id: ToolId;
  label: string;
  icon: string;
  keys: string;
  /** Si aparece anclada al pie de la barra lateral. */
  footer?: boolean;
};

/**
 * Ocho herramientas acoplables en la barra lateral (sin icono de Workspace:
 * Workspace es la superficie permanente de la aplicación).
 */
export const TOOLS: ToolSpec[] = [
  { id: 'inicio', label: 'Inicio', icon: 'home', keys: '⌘⇧1' },
  { id: 'flow', label: 'Flow', icon: 'flow', keys: '⌘⇧2' },
  { id: 'studio', label: 'Studio', icon: 'studio', keys: '⌘⇧3' },
  { id: 'entrega', label: 'Entrega', icon: 'review', keys: '⌘⇧4' },
  { id: 'brain', label: 'Brain', icon: 'brain', keys: '⌘⇧5' },
  { id: 'containers', label: 'Contenedores', icon: 'box', keys: '⌘⇧6' },
  { id: 'browser', label: 'Browser', icon: 'globe', keys: '⌘⇧7' },
  { id: 'ajustes', label: 'Ajustes', icon: 'settings', keys: '⌘,', footer: true },
];

export const TOOL_MAP: Record<ToolId, ToolSpec> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t]),
) as Record<ToolId, ToolSpec>;

export function isToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && value in TOOL_MAP;
}

export type ShellMode = 'workspace' | 'split' | 'maximized' | 'compact';

export type ShellState = {
  activeTool: ToolId | null;
  mode: ShellMode;
  /** Último modo de herramienta abierta para restaurar al reabrir o desmaximizar. */
  lastToolMode: 'split' | 'compact';
  /** Proporción preferida de Workspace en vista dividida (por defecto 35 %). */
  workspaceRatio: number;
  /** Anchura explícita en px tras arrastrar el divisor (se recalcula al cambiar ventana). */
  workspacePx: number | null;
};

export type ProjectShellPrefs = {
  activeTool: ToolId | null;
  mode: ShellMode;
  lastToolMode?: 'split' | 'compact';
  workspaceRatio?: number;
};

export type PersistedShell = {
  version: 1;
  lastProject: string | null;
  workspaceRatio: number;
  lastToolMode: 'split' | 'compact';
  projects: Record<string, ProjectShellPrefs>;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const SHELL_STORAGE_KEY = 'filigranas.shell.v1';
export const DEFAULT_WORKSPACE_RATIO = 0.35;
export const MIN_WORKSPACE_RATIO = 0.2;
export const MAX_WORKSPACE_RATIO = 0.65;
export const MIN_WORKSPACE_PX = 340;
export const MIN_TOOL_PX = 440;
export const COMPACT_RAIL_PX = 64;
export const SPLITTER_PX = 8;
/** Por debajo de este ancho de Workspace en dividida, se repliega su columna interna de hilos. */
export const SIDEBAR_COLLAPSE_THRESHOLD_PX = 660;

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_WORKSPACE_RATIO;
  return Math.min(MAX_WORKSPACE_RATIO, Math.max(MIN_WORKSPACE_RATIO, ratio));
}

function normalizeMode(mode: unknown, activeTool: ToolId | null): ShellMode {
  if (activeTool == null) return 'workspace';
  return mode === 'split' || mode === 'maximized' || mode === 'compact' ? mode : 'split';
}

export function createInitialShellState(
  hasValidProject: boolean,
  saved?: Partial<ProjectShellPrefs> | null,
  fallbackRatio = DEFAULT_WORKSPACE_RATIO,
  fallbackLastMode: 'split' | 'compact' = 'split',
): ShellState {
  const ratio = clampRatio(saved?.workspaceRatio ?? fallbackRatio);
  const lastToolMode = saved?.lastToolMode === 'compact' ? 'compact' : fallbackLastMode;
  // Regla de arranque: sin proyecto activo válido, Workspace + Inicio.
  if (!hasValidProject) {
    return {
      activeTool: 'inicio',
      mode: 'split',
      lastToolMode: 'split',
      workspaceRatio: ratio,
      workspacePx: null,
    };
  }
  const activeTool = saved && isToolId(saved.activeTool) ? saved.activeTool : null;
  const mode = normalizeMode(saved?.mode, activeTool);
  return {
    activeTool,
    mode,
    lastToolMode,
    workspaceRatio: ratio,
    workspacePx: null,
  };
}

/** Abre (o cambia a) una herramienta acoplada junto a Workspace. */
export function openTool(state: ShellState, tool: ToolId): ShellState {
  if (state.activeTool === tool && state.mode !== 'workspace') {
    return state;
  }
  const nextMode: ShellMode =
    state.mode === 'workspace' ? state.lastToolMode : state.mode;
  return {
    ...state,
    activeTool: tool,
    mode: nextMode,
  };
}

/** Alterna una herramienta desde la barra lateral: si ya estaba abierta, la cierra. */
export function toggleTool(state: ShellState, tool: ToolId): ShellState {
  if (state.activeTool === tool && state.mode !== 'workspace') {
    return closeTool(state);
  }
  return openTool(state, tool);
}

/** Cierra la herramienta activa y devuelve Workspace al 100 %. */
export function closeTool(state: ShellState): ShellState {
  if (state.activeTool === null && state.mode === 'workspace') return state;
  return {
    ...state,
    activeTool: null,
    mode: 'workspace',
    workspacePx: null,
  };
}

/** Maximiza la herramienta activa conservando Workspace montado y el modo previo. */
export function maximizeTool(state: ShellState): ShellState {
  if (!state.activeTool || state.mode === 'maximized') return state;
  return {
    ...state,
    lastToolMode: state.mode === 'compact' ? 'compact' : 'split',
    mode: 'maximized',
  };
}

/** Restaura la vista dividida desde maximizado o compacto. */
export function restoreSplit(state: ShellState): ShellState {
  if (!state.activeTool) return state;
  return {
    ...state,
    mode: 'split',
    lastToolMode: 'split',
  };
}

/** Alterna entre maximizar herramienta y restaurar la vista dividida previa. */
export function toggleMaximizeTool(state: ShellState): ShellState {
  if (!state.activeTool) return state;
  if (state.mode === 'maximized') {
    return { ...state, mode: state.lastToolMode };
  }
  return maximizeTool(state);
}

/** Minimiza Workspace a la columna compacta recuperable sin finalizar sesiones. */
export function minimizeWorkspace(state: ShellState): ShellState {
  if (!state.activeTool) return state;
  return {
    ...state,
    mode: 'compact',
    lastToolMode: 'compact',
  };
}

/** Recupera Workspace desde el estado compacto (o maximizado) a vista dividida. */
export function restoreWorkspace(state: ShellState): ShellState {
  if (!state.activeTool) {
    return { ...state, mode: 'workspace' };
  }
  return {
    ...state,
    mode: 'split',
    lastToolMode: 'split',
  };
}

/**
 * Al seleccionar un proyecto desde Inicio o el selector superior:
 * Inicio se cierra automáticamente y Workspace ocupa toda el área disponible.
 */
export function onProjectSelected(state: ShellState): ShellState {
  return {
    ...state,
    activeTool: null,
    mode: 'workspace',
    workspacePx: null,
  };
}

export type LayoutGeometry = {
  effectiveMode: ShellMode;
  workspaceWidthPx: number;
  toolWidthPx: number;
  showSplitter: boolean;
  collapseWorkspaceSidebar: boolean;
  minWorkspacePx: number;
  maxWorkspacePx: number;
  autoCompacted: boolean;
};

/**
 * Calcula medidas seguras para cualquier ancho de ventana (1600, 1440, 1280,
 * 1050 y el ancho mínimo 960), evitando paneles inutilizables o desbordamiento.
 */
export function computeLayoutGeometry(state: ShellState, availableWidth: number): LayoutGeometry {
  const width = Math.max(320, Math.floor(availableWidth));

  if (!state.activeTool || state.mode === 'workspace') {
    return {
      effectiveMode: 'workspace',
      workspaceWidthPx: width,
      toolWidthPx: 0,
      showSplitter: false,
      collapseWorkspaceSidebar: false,
      minWorkspacePx: MIN_WORKSPACE_PX,
      maxWorkspacePx: width,
      autoCompacted: false,
    };
  }

  if (state.mode === 'maximized') {
    return {
      effectiveMode: 'maximized',
      workspaceWidthPx: 0,
      toolWidthPx: width,
      showSplitter: false,
      collapseWorkspaceSidebar: true,
      minWorkspacePx: MIN_WORKSPACE_PX,
      maxWorkspacePx: Math.max(MIN_WORKSPACE_PX, width - MIN_TOOL_PX - SPLITTER_PX),
      autoCompacted: false,
    };
  }

  const fitsSplit = width >= MIN_WORKSPACE_PX + MIN_TOOL_PX + SPLITTER_PX;

  if (state.mode === 'compact' || !fitsSplit) {
    const rail = Math.min(COMPACT_RAIL_PX, Math.max(48, width - 260));
    return {
      effectiveMode: 'compact',
      workspaceWidthPx: rail,
      toolWidthPx: Math.max(0, width - rail),
      showSplitter: false,
      collapseWorkspaceSidebar: true,
      minWorkspacePx: MIN_WORKSPACE_PX,
      maxWorkspacePx: Math.max(MIN_WORKSPACE_PX, width - MIN_TOOL_PX - SPLITTER_PX),
      autoCompacted: state.mode !== 'compact' && !fitsSplit,
    };
  }

  const minWorkspacePx = MIN_WORKSPACE_PX;
  const maxWorkspacePx = Math.max(
    minWorkspacePx,
    Math.min(Math.floor((width - SPLITTER_PX) * MAX_WORKSPACE_RATIO), width - MIN_TOOL_PX - SPLITTER_PX),
  );
  const desired =
    state.workspacePx != null && Number.isFinite(state.workspacePx)
      ? state.workspacePx
      : Math.round((width - SPLITTER_PX) * clampRatio(state.workspaceRatio));
  const workspaceWidthPx = Math.min(maxWorkspacePx, Math.max(minWorkspacePx, desired));
  const toolWidthPx = Math.max(MIN_TOOL_PX, width - SPLITTER_PX - workspaceWidthPx);

  return {
    effectiveMode: 'split',
    workspaceWidthPx,
    toolWidthPx,
    showSplitter: true,
    collapseWorkspaceSidebar: workspaceWidthPx < SIDEBAR_COLLAPSE_THRESHOLD_PX,
    minWorkspacePx,
    maxWorkspacePx,
    autoCompacted: false,
  };
}

export function resizeWorkspace(state: ShellState, targetPx: number, availableWidth: number): ShellState {
  if (!state.activeTool || state.mode !== 'split') return state;
  const usable = Math.max(1, availableWidth - SPLITTER_PX);
  const minPx = MIN_WORKSPACE_PX;
  const maxPx = Math.max(minPx, Math.min(Math.floor(usable * MAX_WORKSPACE_RATIO), usable - MIN_TOOL_PX));
  const clampedPx = Math.round(Math.min(maxPx, Math.max(minPx, targetPx)));
  const ratio = clampRatio(clampedPx / usable);
  return {
    ...state,
    workspacePx: clampedPx,
    workspaceRatio: ratio,
  };
}

export function resetWorkspaceRatio(state: ShellState): ShellState {
  return {
    ...state,
    workspaceRatio: DEFAULT_WORKSPACE_RATIO,
    workspacePx: null,
  };
}

// ── Persistencia por proyecto y recuperación en arranque ────────────────

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadPersistedShell(storage: StorageLike | null = defaultStorage()): PersistedShell {
  const empty: PersistedShell = {
    version: 1,
    lastProject: null,
    workspaceRatio: DEFAULT_WORKSPACE_RATIO,
    lastToolMode: 'split',
    projects: {},
  };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(SHELL_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<PersistedShell> | null;
    if (!parsed || typeof parsed !== 'object') return empty;
    const projects: Record<string, ProjectShellPrefs> = {};
    if (parsed.projects && typeof parsed.projects === 'object') {
      for (const [path, pref] of Object.entries(parsed.projects)) {
        if (!path || !pref || typeof pref !== 'object') continue;
        const activeTool = isToolId(pref.activeTool) ? pref.activeTool : null;
        projects[path] = {
          activeTool,
          mode: normalizeMode(pref.mode, activeTool),
          lastToolMode: pref.lastToolMode === 'compact' ? 'compact' : 'split',
          workspaceRatio: pref.workspaceRatio != null ? clampRatio(pref.workspaceRatio) : undefined,
        };
      }
    }
    return {
      version: 1,
      lastProject: typeof parsed.lastProject === 'string' && parsed.lastProject ? parsed.lastProject : null,
      workspaceRatio: clampRatio(parsed.workspaceRatio ?? DEFAULT_WORKSPACE_RATIO),
      lastToolMode: parsed.lastToolMode === 'compact' ? 'compact' : 'split',
      projects,
    };
  } catch {
    return empty;
  }
}

export function savePersistedShell(
  data: PersistedShell,
  storage: StorageLike | null = defaultStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(SHELL_STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* sin almacenamiento disponible */
  }
}

/**
 * Resuelve el estado al arrancar Filigranas contrastando contra los proyectos
 * válidos existentes en disco: nunca recupera rutas borradas o archivadas.
 */
export function resolveStartupShell(
  validProjectPaths: string[],
  storage: StorageLike | null = defaultStorage(),
): { project: string | null; shell: ShellState } {
  const persisted = loadPersistedShell(storage);
  const validSet = new Set(validProjectPaths);

  // Limpia proyectos inexistentes o archivados al arrancar.
  const prunedProjects: Record<string, ProjectShellPrefs> = {};
  for (const [path, prefs] of Object.entries(persisted.projects)) {
    if (validSet.has(path)) prunedProjects[path] = prefs;
  }

  const project =
    persisted.lastProject && validSet.has(persisted.lastProject)
      ? persisted.lastProject
      : null;

  if (!project) {
    return {
      project: null,
      shell: createInitialShellState(false, null, persisted.workspaceRatio, persisted.lastToolMode),
    };
  }

  const savedForProject = prunedProjects[project] ?? null;
  return {
    project,
    shell: createInitialShellState(true, savedForProject, persisted.workspaceRatio, persisted.lastToolMode),
  };
}

/** Persiste el estado del proyecto actual y actualiza las preferencias globales. */
export function persistShellState(
  project: string | null,
  shell: ShellState,
  validProjectPaths?: string[],
  storage: StorageLike | null = defaultStorage(),
) {
  const current = loadPersistedShell(storage);
  const validSet = validProjectPaths ? new Set(validProjectPaths) : null;
  const projects: Record<string, ProjectShellPrefs> = {};
  for (const [path, prefs] of Object.entries(current.projects)) {
    if (!validSet || validSet.has(path)) projects[path] = prefs;
  }
  if (project) {
    projects[project] = {
      activeTool: shell.activeTool,
      mode: shell.mode,
      lastToolMode: shell.lastToolMode,
      workspaceRatio: clampRatio(shell.workspaceRatio),
    };
  }
  savePersistedShell(
    {
      version: 1,
      lastProject: project,
      workspaceRatio: clampRatio(shell.workspaceRatio),
      lastToolMode: shell.lastToolMode,
      projects,
    },
    storage,
  );
}
