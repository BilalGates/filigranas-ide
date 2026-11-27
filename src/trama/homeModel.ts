import type { Group, HomeActivityItem, HomeSummary, Project, RecentSession, Session } from '../ipc.ts';
import { STATUS } from './taskMeta.ts';

export type LiveActivityMap = Record<string, 'trabajando' | 'permiso' | null>;

export type SessionRuntimeState = 'waiting' | 'working' | 'failed' | 'paused' | 'idle' | 'closed';

export type DerivedSessionStatus = {
  state: SessionRuntimeState;
  label: string;
  priority: number;
  live: boolean;
};

export type ContinueSessionItem = {
  key: string;
  session: RecentSession;
  projectName: string;
  description: string | null;
  status: DerivedSessionStatus;
  isCurrentProject: boolean;
};

export type AttentionTarget =
  | { kind: 'session'; project: string; view: 'coach' | number }
  | { kind: 'task'; project: string; taskId: number }
  | { kind: 'ci'; project: string }
  | { kind: 'work'; project: string };

export type AttentionItem = {
  key: string;
  severity: 'waiting' | 'blocked' | 'paused';
  project: string;
  projectName: string;
  title: string;
  detail: string;
  action: string;
  urgent: boolean;
  target: AttentionTarget;
};

export type ActivityPhase = 'live' | 'pending' | 'history';

export type ActivityFeedItem = {
  id: string;
  phase: ActivityPhase;
  kind: HomeActivityItem['kind'] | 'live_session' | 'permission' | 'commit';
  project: string;
  projectName: string;
  title: string;
  detail: string | null;
  timestampMs: number | null;
  target: AttentionTarget | { kind: 'recent_session'; session: RecentSession } | { kind: 'project'; project: string };
};

export type ProjectLibraryEntry = {
  project: Project;
  groupName: string | null;
  snap?: HomeSummary;
  branch: string | null;
  sessions: RecentSession[];
  latestSession: RecentSession | null;
  lastActivityMs: number | null;
  lastCommitMs: number | null;
  attentionCount: number;
  runningCount: number;
  liveWorkingCount: number;
  liveWaitingCount: number;
  isCurrent: boolean;
};

export type ProjectLibrarySection = {
  key: string;
  label: string | null;
  items: ProjectLibraryEntry[];
};

const ATTENTION_TASK_STATUSES = new Set(['waiting_approval', 'blocked', 'failed', 'paused_quota']);
const RUNNING_TASK_STATUSES = new Set(['running', 'verifying']);

function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function firstMeaningfulLine(text: string | null | undefined, maxLen = 112): string | null {
  if (!text) return null;
  const line = text.split('\n').map((part) => part.trim()).find(Boolean);
  if (!line) return null;
  return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

export function deriveSessionStatus(
  session: RecentSession,
  liveActivity: LiveActivityMap,
  currentProject: string | null,
): DerivedSessionStatus {
  if (currentProject && session.project === currentProject) {
    const key = session.isPm ? 'coach' : session.sessionId != null ? String(session.sessionId) : null;
    const live = key ? liveActivity[key] : null;
    if (live === 'permiso') {
      return { state: 'waiting', label: 'Pide permiso', priority: 4, live: true };
    }
    if (live === 'trabajando') {
      return { state: 'working', label: session.isPm ? 'Coordinando' : 'Trabajando', priority: 3, live: true };
    }
  }
  if (session.running) {
    return { state: 'working', label: session.isPm ? 'Coordinando' : 'Trabajando', priority: 3, live: true };
  }
  if (session.paused) {
    return { state: 'paused', label: 'En pausa', priority: 2, live: false };
  }
  if (session.lastOutcome === 'failed' || session.lastOutcome === 'error') {
    return { state: 'failed', label: 'Con error', priority: 2, live: false };
  }
  if (session.lastOutcome === 'quota') {
    return { state: 'paused', label: 'Sin cuota', priority: 2, live: false };
  }
  if (session.closed) {
    return { state: 'closed', label: 'Cerrada', priority: 0, live: false };
  }
  return { state: 'idle', label: 'Lista', priority: 1, live: false };
}

export function rankContinueSessions(
  recentSessions: readonly RecentSession[],
  projects: readonly Project[],
  liveActivity: LiveActivityMap,
  currentProject: string | null,
  limit = 12,
): ContinueSessionItem[] {
  const byPath = new Map(projects.filter((p) => !p.archived).map((p) => [p.path, p]));
  const seen = new Set<string>();
  const ranked: ContinueSessionItem[] = [];

  for (const session of recentSessions) {
    const proj = byPath.get(session.project);
    if (!proj) continue;
    const key = `${session.project}:${session.sessionId ?? 'pm'}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const status = deriveSessionStatus(session, liveActivity, currentProject);
    const description =
      firstMeaningfulLine(session.task) ??
      (session.isPm ? `Coordinación de ${proj.name}` : null);

    ranked.push({
      key,
      session,
      projectName: proj.name,
      description,
      status,
      isCurrentProject: session.project === currentProject,
    });
  }

  ranked.sort((a, b) => {
    const liveA = a.status.priority >= 3 ? a.status.priority : 0;
    const liveB = b.status.priority >= 3 ? b.status.priority : 0;
    if (liveA !== liveB) return liveB - liveA;
    if (a.session.lastActiveMs !== b.session.lastActiveMs) {
      return b.session.lastActiveMs - a.session.lastActiveMs;
    }
    return b.status.priority - a.status.priority;
  });

  return ranked.slice(0, limit);
}

export function buildAttentionItems({
  projects,
  snaps,
  agentSessions,
  liveActivity,
  currentProject,
}: {
  projects: readonly Project[];
  snaps: Record<string, HomeSummary | undefined>;
  agentSessions: readonly Session[];
  liveActivity: LiveActivityMap;
  currentProject: string | null;
}): AttentionItem[] {
  const activeProjects = projects.filter((p) => !p.archived);
  const names = new Map(activeProjects.map((p) => [p.path, p.name]));
  const out: AttentionItem[] = [];

  if (currentProject && names.has(currentProject)) {
    const currentName = names.get(currentProject)!;
    for (const [key, state] of Object.entries(liveActivity)) {
      if (state !== 'permiso') continue;
      const session = key === 'coach' ? null : agentSessions.find((s) => String(s.id) === key);
      if (key !== 'coach' && !session) continue;
      out.push({
        key: `perm:${currentProject}:${key}`,
        severity: 'waiting',
        project: currentProject,
        projectName: currentName,
        title: `${session ? session.name : 'Project manager'} pide permiso`,
        detail: firstMeaningfulLine(session?.task, 84) ?? currentName,
        action: 'Ir a la sesión',
        urgent: true,
        target: { kind: 'session', project: currentProject, view: session ? session.id : 'coach' },
      });
    }
  }

  for (const { path, name } of activeProjects) {
    const snap = snaps[path];
    if (!snap) continue;

    if (snap.ci?.checksKnown && snap.ci.checksState === 'failure') {
      const [passed, failed, waiting] = snap.ci.checks;
      out.push({
        key: `ci:${path}:${snap.ci.number}`,
        severity: 'blocked',
        project: path,
        projectName: name,
        title: `CI fallido en PR #${snap.ci.number}`,
        detail: `${failed} de ${passed + failed + waiting} checks con error · ${snap.ci.branch}`,
        action: 'Abrir entrega',
        urgent: false,
        target: { kind: 'ci', project: path },
      });
    }

    for (const task of snap.tasks ?? []) {
      if (!ATTENTION_TASK_STATUSES.has(task.status)) continue;
      const severity =
        task.status === 'paused_quota'
          ? 'paused'
          : task.status === 'waiting_approval'
            ? 'waiting'
            : 'blocked';
      out.push({
        key: `task:${path}:${task.id}`,
        severity,
        project: path,
        projectName: name,
        title: `${STATUS[task.status]}: ${task.title}`,
        detail: `Tarea #${task.id}`,
        action: 'Abrir tarea',
        urgent: task.status === 'waiting_approval',
        target: { kind: 'task', project: path, taskId: task.id },
      });
    }

    if (snap.work?.state === 'review') {
      out.push({
        key: `work:${path}:${snap.work.id}`,
        severity: 'waiting',
        project: path,
        projectName: name,
        title: 'Entrega lista para revisar',
        detail: firstMeaningfulLine(snap.work.objective, 90) ?? snap.work.branch,
        action: 'Revisar',
        urgent: false,
        target: { kind: 'work', project: path },
      });
    }
  }

  const order = { waiting: 0, blocked: 1, paused: 2 };
  out.sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    return order[a.severity] - order[b.severity];
  });
  return out;
}

export function buildActivityFeed({
  continueSessions,
  attentionItems,
  backendActivity,
  snaps,
  projects,
  limit = 14,
}: {
  continueSessions: readonly ContinueSessionItem[];
  attentionItems: readonly AttentionItem[];
  backendActivity: readonly HomeActivityItem[];
  snaps: Record<string, HomeSummary | undefined>;
  projects: readonly Project[];
  limit?: number;
}): ActivityFeedItem[] {
  const activeProjects = projects.filter((p) => !p.archived);
  const names = new Map(activeProjects.map((p) => [p.path, p.name]));
  const items: ActivityFeedItem[] = [];
  const seenIds = new Set<string>();

  // 1. Actividad actual en ejecución (claramente separada como 'live').
  for (const entry of continueSessions) {
    if (entry.status.state !== 'working') continue;
    const id = `live:${entry.key}`;
    seenIds.add(id);
    items.push({
      id,
      phase: 'live',
      kind: 'live_session',
      project: entry.session.project,
      projectName: entry.projectName,
      title: `${entry.session.name} en ejecución`,
      detail: entry.description,
      timestampMs: entry.session.lastActiveMs,
      target: { kind: 'recent_session', session: entry.session },
    });
  }

  // 2. Estados pendientes (permisos, bloqueos, revisiones) sin duplicar tareas fallidas del backend.
  const pendingTaskIds = new Set<number>();
  for (const alert of attentionItems) {
    if (alert.target.kind === 'task') pendingTaskIds.add(alert.target.taskId);
    const id = `pending:${alert.key}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    items.push({
      id,
      phase: 'pending',
      kind: alert.target.kind === 'session' ? 'permission' : alert.target.kind === 'task' ? 'task_failed' : 'delivery',
      project: alert.project,
      projectName: alert.projectName,
      title: alert.title,
      detail: alert.detail,
      timestampMs: null,
      target: alert.target,
    });
  }

  // 3. Actividad histórica real desde SQLite (tareas terminadas, turnos, revisiones, entregas).
  const historical: ActivityFeedItem[] = [];
  for (const ev of backendActivity) {
    const projectName = names.get(ev.project);
    if (!projectName) continue;
    if (ev.taskId != null && ev.kind === 'task_failed' && pendingTaskIds.has(ev.taskId)) continue;
    if (seenIds.has(ev.id)) continue;
    seenIds.add(ev.id);

    const target: ActivityFeedItem['target'] =
      ev.taskId != null
        ? { kind: 'task', project: ev.project, taskId: ev.taskId }
        : ev.sessionId != null
          ? { kind: 'session', project: ev.project, view: ev.sessionId }
          : ev.kind === 'delivery' || ev.kind === 'review'
            ? { kind: 'ci', project: ev.project }
            : { kind: 'project', project: ev.project };

    historical.push({
      id: ev.id,
      phase: ev.phase === 'pending' ? 'pending' : 'history',
      kind: ev.kind,
      project: ev.project,
      projectName,
      title: ev.title,
      detail: ev.detail,
      timestampMs: ev.timestampMs,
      target,
    });
  }

  // Si todavía no hay eventos registrados en SQLite, añade últimos commits reales conocidos por Git.
  if (historical.length === 0) {
    for (const p of activeProjects) {
      const snap = snaps[p.path];
      if (!snap?.dates?.length) continue;
      const latestMs = Math.max(...snap.dates.map((d) => new Date(d).getTime()).filter(Number.isFinite));
      if (!Number.isFinite(latestMs)) continue;
      historical.push({
        id: `commit:${p.path}`,
        phase: 'history',
        kind: 'commit',
        project: p.path,
        projectName: p.name,
        title: `Cambios en ${snap.branch ?? 'el repositorio'}`,
        detail: `${snap.dates.length} commit${snap.dates.length === 1 ? '' : 's'} recientes`,
        timestampMs: latestMs,
        target: { kind: 'project', project: p.path },
      });
    }
  }

  historical.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));

  const phaseRank = { live: 0, pending: 1, history: 2 };
  const combined = [...items, ...historical];
  combined.sort((a, b) => {
    if (phaseRank[a.phase] !== phaseRank[b.phase]) return phaseRank[a.phase] - phaseRank[b.phase];
    return (b.timestampMs ?? 0) - (a.timestampMs ?? 0);
  });

  return combined.slice(0, limit);
}

export function buildProjectLibrary({
  projects,
  groups,
  snaps,
  recentSessions,
  liveActivity,
  currentProject,
  query,
  sortBy,
  grouped,
}: {
  projects: readonly Project[];
  groups: readonly Group[];
  snaps: Record<string, HomeSummary | undefined>;
  recentSessions: readonly RecentSession[];
  liveActivity: LiveActivityMap;
  currentProject: string | null;
  query: string;
  sortBy: 'activity' | 'name';
  grouped: boolean;
}): ProjectLibrarySection[] {
  const activeProjects = projects.filter((p) => !p.archived);
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));
  const sessionsByProject = new Map<string, RecentSession[]>();

  for (const s of recentSessions) {
    const list = sessionsByProject.get(s.project) ?? [];
    list.push(s);
    sessionsByProject.set(s.project, list);
  }
  for (const list of sessionsByProject.values()) {
    list.sort((a, b) => {
      if (a.closed !== b.closed) return a.closed ? 1 : -1;
      return b.lastActiveMs - a.lastActiveMs;
    });
  }

  const needle = normalizeText(query.trim());
  const entries: ProjectLibraryEntry[] = [];

  for (const project of activeProjects) {
    const snap = snaps[project.path];
    const projSessions = sessionsByProject.get(project.path) ?? [];
    const latestSession = projSessions[0] ?? null;
    const groupName = project.groupId != null ? (groupNames.get(project.groupId) ?? null) : null;
    const branch = snap?.branch ?? latestSession?.branch ?? null;

    if (needle) {
      const haystack = normalizeText(
        [
          project.name,
          project.folder ?? '',
          project.path,
          branch ?? '',
          groupName ?? '',
          ...projSessions.flatMap((s) => [s.name, s.task ?? '', s.branch ?? '']),
        ].join(' '),
      );
      if (!haystack.includes(needle)) continue;
    }

    const commitTimes = (snap?.dates ?? []).map((d) => new Date(d).getTime()).filter(Number.isFinite);
    const lastCommitMs = commitTimes.length ? Math.max(...commitTimes) : null;
    const taskTimes = (snap?.tasks ?? []).map((t) => t.updatedAt * 1000).filter(Number.isFinite);
    const sessionTimes = projSessions.map((s) => s.lastActiveMs).filter(Number.isFinite);
    const candidates = [...sessionTimes, ...(lastCommitMs != null ? [lastCommitMs] : []), ...taskTimes];
    const lastActivityMs = candidates.length ? Math.max(...candidates) : null;

    const attentionCount =
      (snap?.tasks?.filter((t) => ATTENTION_TASK_STATUSES.has(t.status)).length ?? 0) +
      (snap?.ci?.checksKnown && snap.ci.checksState === 'failure' ? 1 : 0) +
      (snap?.work?.state === 'review' ? 1 : 0);
    const runningCount = snap?.tasks?.filter((t) => RUNNING_TASK_STATUSES.has(t.status)).length ?? 0;

    let liveWorkingCount = 0;
    let liveWaitingCount = 0;
    if (project.path === currentProject) {
      for (const state of Object.values(liveActivity)) {
        if (state === 'trabajando') liveWorkingCount++;
        else if (state === 'permiso') liveWaitingCount++;
      }
    } else {
      liveWorkingCount = projSessions.filter((s) => s.running).length;
    }

    entries.push({
      project,
      groupName,
      snap,
      branch,
      sessions: projSessions,
      latestSession,
      lastActivityMs,
      lastCommitMs,
      attentionCount,
      runningCount,
      liveWorkingCount,
      liveWaitingCount,
      isCurrent: project.path === currentProject,
    });
  }

  const compare = (a: ProjectLibraryEntry, b: ProjectLibraryEntry) => {
    if (sortBy === 'name') {
      return a.project.name.localeCompare(b.project.name, 'es', { sensitivity: 'base' });
    }
    const aLive = a.liveWaitingCount * 10 + a.liveWorkingCount;
    const bLive = b.liveWaitingCount * 10 + b.liveWorkingCount;
    if (aLive !== bLive) return bLive - aLive;
    const aTime = a.lastActivityMs ?? -1;
    const bTime = b.lastActivityMs ?? -1;
    if (aTime !== bTime) return bTime - aTime;
    return a.project.name.localeCompare(b.project.name, 'es', { sensitivity: 'base' });
  };

  if (!grouped || groups.length === 0) {
    entries.sort(compare);
    return entries.length ? [{ key: 'all', label: null, items: entries }] : [];
  }

  const sections: ProjectLibrarySection[] = [];
  for (const g of groups) {
    const items = entries.filter((e) => e.project.groupId === g.id).sort(compare);
    if (items.length) sections.push({ key: `g:${g.id}`, label: g.name, items });
  }
  const loose = entries.filter((e) => e.project.groupId == null || !groupNames.has(e.project.groupId)).sort(compare);
  if (loose.length) sections.push({ key: 'g:none', label: 'Sin grupo', items: loose });
  return sections;
}
