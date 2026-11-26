import type { StorageLike } from './workspaceLayout';

export type ActiveSelection =
  | { kind: 'session'; sessionId: number; project: string }
  | { kind: 'pm'; project: string }
  | null;

export type SessionRef = {
  id: number;
  project: string;
  name: string;
  title?: string | null;
  engine: string;
  status?: 'trabajando' | 'esperando' | 'terminada' | null;
  parentSession?: number | null;
};

export type StaleReason = null | 'project_missing' | 'session_missing' | 'session_mismatch';

export type DerivedWorkspaceContext<S extends SessionRef = SessionRef> = {
  selection: ActiveSelection;
  project: string | null;
  view: 'coach' | number;
  activeSession: S | null;
  staleReason: StaleReason;
  staleNotice: string | null;
};

export type PersistedWorkspaceContext = {
  version: 1;
  active: ActiveSelection;
  lastByProject: Record<string, Exclude<ActiveSelection, null>>;
};

export const CONTEXT_STORAGE_KEY = 'filigranas.context.v1';
const LEGACY_RESUME_KEY = 'filigranas.retomar';
const LEGACY_SHELL_KEY = 'filigranas.shell.v1';

/** Clave de actividad única por proyecto para el Project Manager (evita colisiones globales). */
export function pmActivityKey(project: string): string {
  return `pm:${project}`;
}

/** Devuelve la ruta de proyecto si una clave de actividad corresponde a un Project Manager. */
export function parsePmActivityKey(key: string): string | null {
  if (!key.startsWith('pm:')) return null;
  const project = key.slice(3);
  return project.length > 0 ? project : null;
}

/** Clave estable para mantener montadas conversaciones visitadas o activas entre proyectos. */
export function selectionKey(selection: Exclude<ActiveSelection, null>): string {
  return selection.kind === 'pm' ? pmActivityKey(selection.project) : `s:${selection.sessionId}`;
}

export function sameSelection(a: ActiveSelection, b: ActiveSelection): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.project !== b.project) return false;
  return a.kind === 'pm' || (b.kind === 'session' && a.sessionId === b.sessionId);
}

function projectLabel(project: string, projectNames?: ReadonlyMap<string, string>): string {
  return projectNames?.get(project) ?? project.split(/[\\/]/).filter(Boolean).pop() ?? project;
}

/**
 * Principio arquitectónico único:
 * `activeSelection → session.project → activeProject`.
 *
 * Verifica siempre que el proyecto exista y que una sesión pertenezca realmente
 * a ese proyecto. Nunca reasigna silenciosamente sesiones huérfanas a otro proyecto.
 */
export function deriveWorkspaceContext<S extends SessionRef>(input: {
  selection: ActiveSelection;
  validProjects: readonly string[];
  sessionsById: ReadonlyMap<number, S>;
  catalogLoaded: boolean;
  projectNames?: ReadonlyMap<string, string>;
}): DerivedWorkspaceContext<S> {
  const { selection, validProjects, sessionsById, catalogLoaded, projectNames } = input;
  if (!selection) {
    return {
      selection: null,
      project: null,
      view: 'coach',
      activeSession: null,
      staleReason: null,
      staleNotice: null,
    };
  }

  const valid = new Set(validProjects);
  if (!valid.has(selection.project)) {
    const label = projectLabel(selection.project, projectNames);
    return {
      selection: null,
      project: null,
      view: 'coach',
      activeSession: null,
      staleReason: 'project_missing',
      staleNotice: `El proyecto «${label}» ya no está disponible o fue archivado.`,
    };
  }

  if (selection.kind === 'pm') {
    return {
      selection,
      project: selection.project,
      view: 'coach',
      activeSession: null,
      staleReason: null,
      staleNotice: null,
    };
  }

  const found = sessionsById.get(selection.sessionId);
  if (found) {
    if (found.project !== selection.project) {
      return {
        selection: { kind: 'pm', project: selection.project },
        project: selection.project,
        view: 'coach',
        activeSession: null,
        staleReason: 'session_mismatch',
        staleNotice: `La sesión seleccionada no corresponde al proyecto «${projectLabel(selection.project, projectNames)}».`,
      };
    }
    return {
      selection,
      project: found.project,
      view: found.id,
      activeSession: found,
      staleReason: null,
      staleNotice: null,
    };
  }

  // Durante la hidratación inicial del catálogo, conservar la referencia sin degradarla antes de tiempo.
  if (!catalogLoaded) {
    return {
      selection,
      project: selection.project,
      view: selection.sessionId,
      activeSession: null,
      staleReason: null,
      staleNotice: null,
    };
  }

  return {
    selection: { kind: 'pm', project: selection.project },
    project: selection.project,
    view: 'coach',
    activeSession: null,
    staleReason: 'session_missing',
    staleNotice: `La sesión anterior en «${projectLabel(selection.project, projectNames)}» se cerró o ya no existe.`,
  };
}

/**
 * Resolución al elegir un proyecto desde Inicio:
 * 1. Recupera su última sesión válida, si existe.
 * 2. Si no existe y hay sesiones abiertas reales en el proyecto, entra a la primera válida.
 * 3. Si no, entra a su Project Manager / flujo de inicialización real sin arrancar agentes.
 */
export function resolveProjectEntry<S extends SessionRef>(input: {
  project: string;
  validProjects: readonly string[];
  lastByProject: Readonly<Record<string, ActiveSelection | undefined>>;
  projectSessions: readonly S[];
  hasPm: boolean;
}): ActiveSelection {
  const { project, validProjects, lastByProject, projectSessions, hasPm } = input;
  if (!validProjects.includes(project)) return null;

  const validSessions = projectSessions.filter((s) => s.project === project);
  const last = lastByProject[project];
  if (last && last.project === project) {
    if (last.kind === 'session' && validSessions.some((s) => s.id === last.sessionId)) {
      return last;
    }
    if (last.kind === 'pm' && hasPm) {
      return last;
    }
  }

  if (hasPm) {
    return { kind: 'pm', project };
  }
  if (validSessions.length > 0) {
    return { kind: 'session', sessionId: validSessions[0].id, project };
  }
  return { kind: 'pm', project };
}

/**
 * Calcula qué conversaciones (PM y sesiones) deben seguir montadas con `hidden={!isActive}`
 * en todos los proyectos válidos para que cambiar de sesión nunca reinicie ni detenga ejecuciones.
 */
export function computeMountedConversations<S extends SessionRef>(input: {
  active: ActiveSelection;
  visitedKeys: ReadonlySet<string>;
  sessionsByProject: Readonly<Record<string, readonly S[] | undefined>>;
  pmProjects: ReadonlySet<string>;
  validProjects: readonly string[];
  activity: Readonly<Record<string, string | null | undefined>>;
}): { pmProjects: string[]; sessions: S[] } {
  const { active, visitedKeys, sessionsByProject, pmProjects, validProjects, activity } = input;
  const mountedPms: string[] = [];
  const mountedSessions: S[] = [];

  for (const project of validProjects) {
    const pmKey = pmActivityKey(project);
    const pmActive = active?.kind === 'pm' && active.project === project;
    const pmLive = activity[pmKey] === 'trabajando' || activity[pmKey] === 'permiso';
    if (pmProjects.has(project) && (pmActive || visitedKeys.has(pmKey) || pmLive)) {
      mountedPms.push(project);
    }

    const list = sessionsByProject[project] ?? [];
    for (const s of list) {
      if (s.project !== project) continue;
      const sKey = `s:${s.id}`;
      const isSelected = active?.kind === 'session' && active.sessionId === s.id && active.project === project;
      const isLive =
        activity[String(s.id)] === 'trabajando' ||
        activity[String(s.id)] === 'permiso' ||
        s.status === 'trabajando' ||
        s.status === 'esperando';
      if (isSelected || visitedKeys.has(sKey) || isLive) {
        mountedSessions.push(s);
      }
    }
  }

  return { pmProjects: mountedPms, sessions: mountedSessions };
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function isValidSelection(raw: unknown): raw is Exclude<ActiveSelection, null> {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.project !== 'string' || !obj.project) return false;
  if (obj.kind === 'pm') return true;
  if (obj.kind === 'session' && typeof obj.sessionId === 'number' && Number.isFinite(obj.sessionId)) return true;
  return false;
}

/**
 * Carga la última selección persistida y el mapa `lastByProject`, con compatibilidad
 * hacia atrás respecto a `filigranas.retomar` y `filigranas.shell.v1`.
 */
export function loadPersistedContext(
  validProjects: readonly string[],
  storage: StorageLike | null = defaultStorage(),
): {
  active: ActiveSelection;
  lastByProject: Record<string, Exclude<ActiveSelection, null>>;
  missingProject: string | null;
} {
  const valid = new Set(validProjects);
  const lastByProject: Record<string, Exclude<ActiveSelection, null>> = {};
  if (!storage) return { active: null, lastByProject, missingProject: null };

  try {
    const raw = storage.getItem(CONTEXT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceContext> | null;
      if (parsed && parsed.version === 1) {
        if (parsed.lastByProject && typeof parsed.lastByProject === 'object') {
          for (const [proj, sel] of Object.entries(parsed.lastByProject)) {
            if (valid.has(proj) && isValidSelection(sel) && sel.project === proj) {
              lastByProject[proj] = sel;
            }
          }
        }
        if (isValidSelection(parsed.active)) {
          if (valid.has(parsed.active.project)) {
            return { active: parsed.active, lastByProject, missingProject: null };
          }
          return { active: null, lastByProject, missingProject: parsed.active.project };
        }
        return { active: null, lastByProject, missingProject: null };
      }
    }
  } catch {
    // Fallback a almacenamiento anterior.
  }

  // Compatibilidad con `filigranas.retomar`
  try {
    const rawResume = storage.getItem(LEGACY_RESUME_KEY);
    if (rawResume) {
      const parsed = JSON.parse(rawResume) as { project?: unknown; view?: unknown } | null;
      if (parsed && typeof parsed.project === 'string' && parsed.project) {
        if (!valid.has(parsed.project)) {
          return { active: null, lastByProject, missingProject: parsed.project };
        }
        const active: Exclude<ActiveSelection, null> =
          typeof parsed.view === 'number' && Number.isFinite(parsed.view)
            ? { kind: 'session', sessionId: parsed.view, project: parsed.project }
            : { kind: 'pm', project: parsed.project };
        lastByProject[parsed.project] = active;
        return { active, lastByProject, missingProject: null };
      }
    }
  } catch {
    // Continuar con legacy shell.
  }

  // Compatibilidad con `filigranas.shell.v1`
  try {
    const rawShell = storage.getItem(LEGACY_SHELL_KEY);
    if (rawShell) {
      const parsed = JSON.parse(rawShell) as { lastProject?: unknown } | null;
      if (parsed && typeof parsed.lastProject === 'string' && valid.has(parsed.lastProject)) {
        const active: Exclude<ActiveSelection, null> = { kind: 'pm', project: parsed.lastProject };
        lastByProject[parsed.lastProject] = active;
        return { active, lastByProject, missingProject: null };
      }
    }
  } catch {
    // Sin estado persistido.
  }

  return { active: null, lastByProject, missingProject: null };
}

export function savePersistedContext(
  active: ActiveSelection,
  lastByProject: Readonly<Record<string, ActiveSelection | undefined>>,
  validProjects: readonly string[],
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  const valid = new Set(validProjects);
  const pruned: Record<string, Exclude<ActiveSelection, null>> = {};
  for (const [proj, sel] of Object.entries(lastByProject)) {
    if (valid.has(proj) && sel && sel.project === proj) {
      pruned[proj] = sel;
    }
  }
  const persistedActive = active && valid.has(active.project) ? active : null;
  if (persistedActive) {
    pruned[persistedActive.project] = persistedActive;
  }
  const payload: PersistedWorkspaceContext = {
    version: 1,
    active: persistedActive,
    lastByProject: pruned,
  };
  try {
    storage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Sin almacenamiento disponible.
  }
}
