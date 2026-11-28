import type {
  AutomationStatus,
  BranchEntry,
  Change,
  CommitDetail,
  GitStatus,
  HealthRun,
  PullSummary,
  Session,
  Task,
  WorkSession,
} from '../../ipc';

export type TreePerspective = 'uncommitted' | 'branch' | 'pr' | 'commit';
export type TimelineStageId = 'tareas' | 'agentes' | 'cambios' | 'tests' | 'commit' | 'pr' | 'ci' | 'integracion';
export type StageStatus = 'done' | 'active' | 'pending' | 'blocked' | 'failed';
export type HistoryScope = 'all' | 'branch';

export type EntregaProjectState = {
  inspectedBranch: string | null;
  inspectedRef: string | null;
  treePerspective: TreePerspective;
  selectedStage: TimelineStageId;
  selectedFile: string | null;
  selectedCommit: string | null;
  historyScope: HistoryScope;
  historySearch: string;
  collapsedDirs: Record<string, boolean>;
  branchSearch: string;
  showMergedBranches: boolean;
};

const DEFAULT_STATE: EntregaProjectState = {
  inspectedBranch: null,
  inspectedRef: null,
  treePerspective: 'uncommitted',
  selectedStage: 'cambios',
  selectedFile: null,
  selectedCommit: null,
  historyScope: 'all',
  historySearch: '',
  collapsedDirs: {},
  branchSearch: '',
  showMergedBranches: false,
};

const store = new Map<string, EntregaProjectState>();

export function getEntregaState(project: string): EntregaProjectState {
  return store.get(project) ?? { ...DEFAULT_STATE };
}

export function setEntregaState(project: string, patch: Partial<EntregaProjectState>): EntregaProjectState {
  const next = { ...getEntregaState(project), ...patch };
  store.set(project, next);
  return next;
}

export function clearEntregaStore() {
  store.clear();
}

export type EntregaLayoutPrefs = {
  /** Ancho de la columna izquierda (Ramas) como fracción [0.14..0.34] del ancho total. */
  branchesRatio: number;
  /** Ancho de la columna central (Árbol de cambios) como fracción [0.16..0.38] del ancho total. */
  treeRatio: number;
  /** Altura de la sección inferior (Historial de commits) como fracción [0.18..0.55] del área central+inferior. */
  historyRatio: number;
};

export const DEFAULT_LAYOUT_PREFS: EntregaLayoutPrefs = {
  branchesRatio: 0.21,
  treeRatio: 0.23,
  historyRatio: 0.32,
};

const LAYOUT_STORAGE_KEY = 'filigranas.entrega.layout.v2';

export function loadEntregaLayoutPrefs(): EntregaLayoutPrefs {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT_PREFS };
    const parsed = JSON.parse(raw) as Partial<EntregaLayoutPrefs>;
    return {
      branchesRatio: typeof parsed.branchesRatio === 'number' && Number.isFinite(parsed.branchesRatio) ? parsed.branchesRatio : DEFAULT_LAYOUT_PREFS.branchesRatio,
      treeRatio: typeof parsed.treeRatio === 'number' && Number.isFinite(parsed.treeRatio) ? parsed.treeRatio : DEFAULT_LAYOUT_PREFS.treeRatio,
      historyRatio: typeof parsed.historyRatio === 'number' && Number.isFinite(parsed.historyRatio) ? parsed.historyRatio : DEFAULT_LAYOUT_PREFS.historyRatio,
    };
  } catch {
    return { ...DEFAULT_LAYOUT_PREFS };
  }
}

export function saveEntregaLayoutPrefs(prefs: EntregaLayoutPrefs): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Entornos sin localStorage
  }
}

export type ResolvedEntregaLayout = {
  branchesPx: number;
  treePx: number;
  rightPx: number;
  historyPx: number;
  compactColumns: boolean;
};

/**
 * Calcula medidas seguras en píxeles para las 3 columnas centrales y el historial inferior,
 * evitando desbordamientos o columnas inutilizables tanto con Workspace abierto como compactado.
 */
export function resolveEntregaLayout(
  prefs: EntregaLayoutPrefs,
  containerWidth: number,
  bodyHeight: number,
): ResolvedEntregaLayout {
  const safeW = Math.max(520, containerWidth);
  const compactColumns = safeW < 820;
  const minBranches = compactColumns ? 148 : 176;
  const minTree = compactColumns ? 156 : 190;
  const minRight = compactColumns ? 216 : 320;

  let branchesPx = Math.round(safeW * Math.min(0.36, Math.max(0.14, prefs.branchesRatio)));
  let treePx = Math.round(safeW * Math.min(0.38, Math.max(0.16, prefs.treeRatio)));

  branchesPx = Math.max(minBranches, branchesPx);
  treePx = Math.max(minTree, treePx);

  const maxLeftCombined = Math.max(minBranches + minTree, safeW - minRight - 2);
  if (branchesPx + treePx > maxLeftCombined) {
    const excess = branchesPx + treePx - maxLeftCombined;
    const treeTrim = Math.min(Math.max(0, treePx - minTree), Math.ceil(excess / 2));
    treePx -= treeTrim;
    const rem = excess - treeTrim;
    const branchTrim = Math.min(Math.max(0, branchesPx - minBranches), rem);
    branchesPx -= branchTrim;
    const finalRem = rem - branchTrim;
    if (finalRem > 0) {
      treePx = Math.max(130, treePx - Math.ceil(finalRem / 2));
      branchesPx = Math.max(130, branchesPx - Math.floor(finalRem / 2));
    }
  }

  const rightPx = Math.max(200, safeW - branchesPx - treePx - 2);

  const safeH = Math.max(280, bodyHeight);
  const minHistory = Math.min(136, Math.round(safeH * 0.25));
  const maxHistory = Math.max(minHistory, Math.round(safeH * 0.56));
  const rawHistory = Math.round(safeH * Math.min(0.56, Math.max(0.18, prefs.historyRatio)));
  const historyPx = Math.max(minHistory, Math.min(maxHistory, rawHistory));

  return { branchesPx, treePx, rightPx, historyPx, compactColumns };
}

export type TreeFileItem = {
  path: string;
  orig: string | null;
  status: string;
  staged?: string | null;
  unstaged?: string | null;
  adds: number | null;
  dels: number | null;
  section?: 'pr' | 'local' | 'commit';
};

export type TreeNode =
  | {
      kind: 'dir';
      name: string;
      path: string;
      filesCount: number;
      adds: number;
      dels: number;
      children: TreeNode[];
    }
  | {
      kind: 'file';
      name: string;
      path: string;
      file: TreeFileItem;
    };

type BuildDir = {
  name: string;
  path: string;
  dirs: Map<string, BuildDir>;
  files: TreeFileItem[];
};

function finalizeDir(dir: BuildDir): Extract<TreeNode, { kind: 'dir' }> {
  const dirChildren = [...dir.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(finalizeDir);
  const fileChildren: Extract<TreeNode, { kind: 'file' }>[] = [...dir.files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({
      kind: 'file',
      name: file.path.split('/').pop() ?? file.path,
      path: file.path,
      file,
    }));
  const children: TreeNode[] = [...dirChildren, ...fileChildren];
  let filesCount = fileChildren.length;
  let adds = fileChildren.reduce((s, c) => s + (c.file.adds ?? 0), 0);
  let dels = fileChildren.reduce((s, c) => s + (c.file.dels ?? 0), 0);
  for (const d of dirChildren) {
    filesCount += d.filesCount;
    adds += d.adds;
    dels += d.dels;
  }
  return { kind: 'dir', name: dir.name, path: dir.path, filesCount, adds, dels, children };
}

/** Construye un árbol jerárquico real de carpetas y archivos. */
export function buildFileTree(items: TreeFileItem[]): TreeNode[] {
  const root: BuildDir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const item of items) {
    const parts = item.path.split('/').filter(Boolean);
    if (parts.length <= 1) {
      root.files.push(item);
      continue;
    }
    let cur = root;
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      acc = acc ? `${acc}/${seg}` : seg;
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { name: seg, path: acc, dirs: new Map(), files: [] };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(item);
  }
  return finalizeDir(root).children;
}

export type TimelineStage = {
  id: TimelineStageId;
  label: string;
  detail: string;
  status: StageStatus;
  isExecuting: boolean;
};

/**
 * Calcula las 8 etapas reales de la línea temporal de Trama v2:
 * Tareas → Agentes → Cambios → Tests → Commit → PR → CI → Integración
 */
export function computeTimelineStages(input: {
  branch: BranchEntry | null;
  status: GitStatus | null;
  compareCount: number;
  pr: PullSummary | null;
  healthRuns: HealthRun[];
  openFindingsCount: number;
  workSession: WorkSession | null;
  tasks: Task[];
  agentSessions: Session[];
  automation: AutomationStatus | null;
}): TimelineStage[] {
  const {
    branch,
    status,
    compareCount,
    pr,
    healthRuns,
    openFindingsCount,
    workSession,
    tasks,
    agentSessions,
    automation,
  } = input;

  const isActiveBranch = branch?.active ?? true;
  const dirtyCount = isActiveBranch ? (status?.changes.length ?? 0) : 0;
  const stagedCount = isActiveBranch ? (status?.changes.filter((c) => c.staged).length ?? 0) : 0;
  const latestRun = healthRuns[0] ?? null;
  const headSha = branch?.headOid ?? status?.headSha ?? null;
  const checkStale = Boolean(latestRun && headSha && latestRun.revision && latestRun.revision !== headSha) || dirtyCount > 0;

  // 1. Tareas
  const openTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const blockedTasks = openTasks.filter((t) => t.status === 'blocked' || t.waitingFor.length > 0);
  const doneTasks = tasks.filter((t) => t.status === 'done');
  let tareasStatus: StageStatus = 'pending';
  let tareasDetail = 'sin tareas';
  if (workSession) {
    tareasDetail = workSession.objective.length > 18 ? `${workSession.objective.slice(0, 17)}…` : workSession.objective;
    tareasStatus = workSession.state === 'finished' ? 'done' : 'active';
  } else if (blockedTasks.length > 0) {
    tareasDetail = `${blockedTasks.length} bloq.`;
    tareasStatus = 'blocked';
  } else if (openTasks.length > 0) {
    tareasDetail = `${openTasks.length} abiertas`;
    tareasStatus = 'active';
  } else if (doneTasks.length > 0) {
    tareasDetail = `${doneTasks.length} cerradas`;
    tareasStatus = 'done';
  }

  // 2. Agentes
  const runningAgents = agentSessions.filter((s) => s.status === 'trabajando');
  const waitingAgents = agentSessions.filter((s) => s.status === 'esperando');
  const runningAutofix = automation?.attempts.find((a) => ['queued', 'running', 'awaiting_ci'].includes(a.status)) ?? null;
  let agentesStatus: StageStatus = 'pending';
  let agentesDetail = 'en reposo';
  if (waitingAgents.length > 0) {
    agentesStatus = 'blocked';
    agentesDetail = `${waitingAgents.length} permiso`;
  } else if (runningAgents.length > 0 || runningAutofix) {
    agentesStatus = 'active';
    agentesDetail = runningAutofix
      ? `autofix #${runningAutofix.attemptNo}`
      : `${runningAgents.length} activos`;
  } else if (agentSessions.length > 0) {
    agentesStatus = 'done';
    agentesDetail = `${agentSessions.length} ${agentSessions.length === 1 ? 'sesión' : 'sesiones'}`;
  }

  // 3. Cambios
  const cambiosStatus: StageStatus =
    dirtyCount > 0 ? 'active' : compareCount > 0 ? 'done' : 'pending';
  const cambiosDetail =
    dirtyCount > 0
      ? `${dirtyCount} sin commit`
      : compareCount > 0
        ? `${compareCount} vs base`
        : 'limpio';

  // 4. Tests
  let testsStatus: StageStatus = 'pending';
  let testsDetail = 'sin ejecutar';
  if (latestRun?.outcome === 'failed' || openFindingsCount > 0) {
    testsStatus = 'failed';
    testsDetail = openFindingsCount > 0 ? `${openFindingsCount} hallazgos` : 'falló';
  } else if (latestRun) {
    testsStatus = checkStale ? 'blocked' : 'done';
    testsDetail = checkStale ? 'obsoleta' : latestRun.outcome === 'ok' || latestRun.outcome === 'passed' ? 'correcto' : latestRun.outcome;
  }

  // 5. Commit
  let commitStatus: StageStatus = 'pending';
  let commitDetail = 'al día';
  if (branch?.diverged) {
    commitStatus = 'blocked';
    commitDetail = `↑${branch.ahead} ↓${branch.behind}`;
  } else if (dirtyCount > 0) {
    commitStatus = stagedCount > 0 ? 'active' : 'pending';
    commitDetail = stagedCount > 0 ? `${stagedCount}/${dirtyCount} prep.` : 'pendiente';
  } else if (branch && !branch.published && compareCount > 0) {
    commitStatus = 'active';
    commitDetail = 'sin publicar';
  } else if ((branch?.ahead ?? 0) > 0) {
    commitStatus = 'active';
    commitDetail = `↑${branch!.ahead} local`;
  } else if (compareCount > 0 || branch?.published) {
    commitStatus = 'done';
    commitDetail = branch?.published ? 'sync' : 'al día';
  }

  // 6. PR
  let prStatus: StageStatus = 'pending';
  let prDetail = 'sin PR';
  if (pr) {
    prDetail = `#${pr.number}${pr.isDraft ? ' draft' : ''}`;
    if (pr.state === 'MERGED') {
      prStatus = 'done';
    } else if (pr.state === 'CLOSED') {
      prStatus = 'blocked';
      prDetail = `#${pr.number} cerrada`;
    } else if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      prStatus = 'failed';
      prDetail = `#${pr.number} cambios`;
    } else if (pr.isDraft) {
      prStatus = 'blocked';
    } else {
      prStatus = pr.reviewDecision === 'APPROVED' ? 'done' : 'active';
    }
  }

  // 7. CI
  let ciStatus: StageStatus = 'pending';
  let ciDetail = '—';
  if (pr) {
    if (pr.checksFailed > 0 || pr.checksState === 'failure') {
      ciStatus = 'failed';
      ciDetail = `${pr.checksFailed} fallo`;
    } else if (pr.checksPending > 0 || pr.checksState === 'pending') {
      ciStatus = 'active';
      ciDetail = `${pr.checksPending} en curso`;
    } else if (pr.checksPassed > 0 || pr.checksState === 'success') {
      ciStatus = 'done';
      ciDetail = `${pr.checksPassed} ok`;
    } else {
      ciDetail = 'sin checks';
    }
  }

  // 8. Integración
  let intStatus: StageStatus = 'pending';
  let intDetail = '—';
  if (pr?.state === 'MERGED' || branch?.mergedIntoDefault) {
    intStatus = 'done';
    intDetail = pr?.state === 'MERGED' ? 'integrada' : 'en base';
  } else if (pr && pr.state === 'OPEN') {
    if (pr.mergeState === 'DIRTY') {
      intStatus = 'failed';
      intDetail = 'conflictos';
    } else if (pr.mergeState === 'BLOCKED' || pr.isDraft) {
      intStatus = 'blocked';
      intDetail = pr.isDraft ? 'borrador' : 'bloqueada';
    } else if (pr.mergeState === 'CLEAN' && pr.checksState === 'success') {
      intStatus = 'active';
      intDetail = 'lista';
    } else {
      intStatus = 'pending';
      intDetail = pr.mergeState.toLowerCase();
    }
  }

  const raw: Omit<TimelineStage, 'isExecuting'>[] = [
    { id: 'tareas', label: 'Tareas', detail: tareasDetail, status: tareasStatus },
    { id: 'agentes', label: 'Agentes', detail: agentesDetail, status: agentesStatus },
    { id: 'cambios', label: 'Cambios', detail: cambiosDetail, status: cambiosStatus },
    { id: 'tests', label: 'Tests', detail: testsDetail, status: testsStatus },
    { id: 'commit', label: 'Commit', detail: commitDetail, status: commitStatus },
    { id: 'pr', label: 'PR', detail: prDetail, status: prStatus },
    { id: 'ci', label: 'CI', detail: ciDetail, status: ciStatus },
    { id: 'integracion', label: 'Integración', detail: intDetail, status: intStatus },
  ];

  // Determina la etapa que está ejecutándose realmente en este instante
  // (priorizando actividad en vivo: CI corriendo, agentes activos, fallo bloqueante, o última etapa activa).
  let executingId: TimelineStageId | null = null;
  if (ciStatus === 'active') executingId = 'ci';
  else if (agentesStatus === 'active') executingId = 'agentes';
  else if (runningAutofix) executingId = 'ci';
  else {
    const activeStages = raw.filter((s) => s.status === 'active');
    if (activeStages.length > 0) {
      executingId = activeStages[activeStages.length - 1].id;
    } else {
      const failedOrBlocked = raw.find((s) => s.status === 'failed' || s.status === 'blocked');
      if (failedOrBlocked) executingId = failedOrBlocked.id;
    }
  }

  return raw.map((stage) => ({
    ...stage,
    isExecuting: stage.id === executingId,
  }));
}

export type BranchCompactSignals = {
  syncLabel: string | null;
  syncTone: 'mint' | 'amber' | 'coral' | 'mut';
  prLabel: string | null;
  prTone: 'sky' | 'mint' | 'amber' | 'coral' | 'mut';
  ciTone: 'mint' | 'amber' | 'coral' | null;
  hasWorktree: boolean;
  activeAgentName: string | null;
  agentBusy: boolean;
};

/** Señales compactas por rama para una lectura inmediata sin exceso de etiquetas. */
export function computeBranchSignals(branch: BranchEntry, pr: PullSummary | null): BranchCompactSignals {
  let syncLabel: string | null = null;
  let syncTone: BranchCompactSignals['syncTone'] = 'mut';
  if (branch.diverged) {
    syncLabel = `↑${branch.ahead}↓${branch.behind}`;
    syncTone = 'coral';
  } else if (branch.ahead > 0) {
    syncLabel = `↑${branch.ahead}`;
    syncTone = 'amber';
  } else if (branch.behind > 0) {
    syncLabel = `↓${branch.behind}`;
    syncTone = 'amber';
  } else if (!branch.published && branch.local) {
    syncLabel = 'local';
    syncTone = 'mut';
  }

  let prLabel: string | null = null;
  let prTone: BranchCompactSignals['prTone'] = 'sky';
  let ciTone: BranchCompactSignals['ciTone'] = null;
  if (pr) {
    prLabel = `#${pr.number}`;
    prTone =
      pr.state === 'MERGED'
        ? 'mint'
        : pr.state === 'CLOSED'
          ? 'mut'
          : pr.reviewDecision === 'CHANGES_REQUESTED'
            ? 'coral'
            : pr.isDraft
              ? 'amber'
              : 'sky';
    if (pr.checksFailed > 0) ciTone = 'coral';
    else if (pr.checksPending > 0) ciTone = 'amber';
    else if (pr.checksPassed > 0) ciTone = 'mint';
  }

  const busyAgent = branch.agents.find((a) => a.active) ?? branch.agents[0] ?? null;

  return {
    syncLabel,
    syncTone,
    prLabel,
    prTone,
    ciTone,
    hasWorktree: Boolean(branch.worktreePath),
    activeAgentName: busyAgent?.name ?? null,
    agentBusy: Boolean(busyAgent?.active),
  };
}

export function changesToTreeItems(changes: Change[]): TreeFileItem[] {
  return changes.map((c) => ({
    path: c.path,
    orig: c.orig,
    status: c.status,
    staged: c.staged ?? null,
    unstaged: c.unstaged ?? null,
    adds: c.adds,
    dels: c.dels,
  }));
}

export function commitFilesToTreeItems(detail: CommitDetail | null): TreeFileItem[] {
  if (!detail) return [];
  return detail.files.map((f) => ({
    path: f.path,
    orig: null,
    status: f.status,
    adds: f.adds,
    dels: f.dels,
    section: 'commit',
  }));
}
