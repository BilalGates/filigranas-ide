import type { BranchEntry, Change, GitStatus, HealthRun, PullSummary, WorkSession } from '../../ipc';

export type TreePerspective = 'uncommitted' | 'branch' | 'pr';
export type CenterTab = 'diff' | 'commits' | 'pr' | 'checks' | 'audits' | 'automation';

export type EntregaProjectState = {
  inspectedBranch: string | null;
  inspectedRef: string | null;
  treePerspective: TreePerspective;
  centerTab: CenterTab;
  selectedFile: string | null;
  selectedCommit: string | null;
  selectedPrNumber: number | null;
  inspectorOpen: boolean;
  collapsedDirs: Record<string, boolean>;
  branchSearch: string;
  showMergedBranches: boolean;
};

const DEFAULT_STATE: EntregaProjectState = {
  inspectedBranch: null,
  inspectedRef: null,
  treePerspective: 'uncommitted',
  centerTab: 'diff',
  selectedFile: null,
  selectedCommit: null,
  selectedPrNumber: null,
  inspectorOpen: false,
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

export type TreeFileItem = {
  path: string;
  orig: string | null;
  status: string;
  staged?: string | null;
  unstaged?: string | null;
  adds: number | null;
  dels: number | null;
  section?: 'pr' | 'local';
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

export type PipelineStageId = 'cambios' | 'verificacion' | 'commit' | 'publicacion' | 'pr' | 'ci' | 'integracion';
export type PipelineTone = 'done' | 'live' | 'warn' | 'fail' | 'idle';
export type PipelineStage = {
  id: PipelineStageId;
  label: string;
  detail: string;
  tone: PipelineTone;
  tab: CenterTab;
};

/** Calcula el estado real de las 7 fases del pipeline superior de Entrega. */
export function computePipelineStages(input: {
  branch: BranchEntry | null;
  status: GitStatus | null;
  compareCount: number;
  pr: PullSummary | null;
  healthRuns: HealthRun[];
  openFindingsCount: number;
  workSession: WorkSession | null;
}): PipelineStage[] {
  const { branch, status, compareCount, pr, healthRuns, openFindingsCount } = input;
  const isActive = branch?.active ?? true;
  const dirtyCount = isActive ? (status?.changes.length ?? 0) : 0;
  const stagedCount = isActive ? (status?.changes.filter((c) => c.staged).length ?? 0) : 0;
  const latestRun = healthRuns[0] ?? null;
  const headSha = branch?.headOid ?? status?.headSha ?? null;
  const checkStale = Boolean(latestRun && headSha && latestRun.revision && latestRun.revision !== headSha) || dirtyCount > 0;

  const cambiosTone: PipelineTone = dirtyCount > 0 ? 'live' : compareCount > 0 ? 'done' : 'idle';
  const verifTone: PipelineTone =
    openFindingsCount > 0 || latestRun?.outcome === 'failed'
      ? 'fail'
      : latestRun
        ? checkStale
          ? 'warn'
          : 'done'
        : 'idle';
  const commitTone: PipelineTone =
    dirtyCount > 0 ? (stagedCount > 0 ? 'live' : 'warn') : compareCount > 0 || (branch?.ahead ?? 0) > 0 ? 'done' : 'idle';
  const pubTone: PipelineTone = !branch
    ? 'idle'
    : branch.diverged
      ? 'fail'
      : branch.published && branch.ahead === 0 && branch.behind === 0
        ? 'done'
        : branch.published
          ? 'warn'
          : 'idle';
  const prTone: PipelineTone = !pr
    ? 'idle'
    : pr.state === 'MERGED'
      ? 'done'
      : pr.state === 'CLOSED'
        ? 'warn'
        : pr.isDraft
          ? 'warn'
          : pr.reviewDecision === 'CHANGES_REQUESTED'
            ? 'fail'
            : 'live';
  const ciTone: PipelineTone = !pr
    ? 'idle'
    : pr.checksState === 'failure'
      ? 'fail'
      : pr.checksState === 'pending'
        ? 'live'
        : pr.checksState === 'success'
          ? 'done'
          : 'idle';
  const intTone: PipelineTone =
    pr?.state === 'MERGED' || branch?.mergedIntoDefault
      ? 'done'
      : pr && pr.state === 'OPEN' && !pr.isDraft && pr.mergeState === 'CLEAN' && pr.checksState === 'success'
        ? 'live'
        : pr?.mergeState === 'DIRTY' || pr?.mergeState === 'BLOCKED'
          ? 'warn'
          : 'idle';

  return [
    {
      id: 'cambios',
      label: 'Cambios',
      detail: dirtyCount > 0 ? `${dirtyCount} sin commit` : compareCount > 0 ? `${compareCount} vs base` : 'limpio',
      tone: cambiosTone,
      tab: 'diff',
    },
    {
      id: 'verificacion',
      label: 'Verificación',
      detail: openFindingsCount > 0 ? `${openFindingsCount} hallazgos` : latestRun ? (checkStale ? 'obsoleta' : latestRun.outcome) : 'sin datos',
      tone: verifTone,
      tab: openFindingsCount > 0 ? 'audits' : 'checks',
    },
    {
      id: 'commit',
      label: 'Commit',
      detail: dirtyCount > 0 ? (stagedCount > 0 ? `${stagedCount}/${dirtyCount} prep.` : 'pendiente') : 'al día',
      tone: commitTone,
      tab: 'commits',
    },
    {
      id: 'publicacion',
      label: 'Publicación',
      detail: !branch ? '—' : branch.diverged ? `↑${branch.ahead} ↓${branch.behind}` : !branch.published ? 'local' : branch.ahead > 0 ? `↑${branch.ahead}` : branch.behind > 0 ? `↓${branch.behind}` : 'sync',
      tone: pubTone,
      tab: 'commits',
    },
    {
      id: 'pr',
      label: 'PR',
      detail: !pr ? 'sin PR' : `#${pr.number} ${pr.isDraft ? 'draft' : pr.state.toLowerCase()}`,
      tone: prTone,
      tab: 'pr',
    },
    {
      id: 'ci',
      label: 'CI',
      detail: !pr ? '—' : pr.checksFailed > 0 ? `${pr.checksFailed} fallo` : pr.checksPending > 0 ? `${pr.checksPending} en curso` : pr.checksPassed > 0 ? `${pr.checksPassed} ok` : 'sin checks',
      tone: ciTone,
      tab: 'checks',
    },
    {
      id: 'integracion',
      label: 'Integración',
      detail: pr?.state === 'MERGED' ? 'integrada' : branch?.mergedIntoDefault ? 'en base' : pr?.mergeState === 'CLEAN' ? 'lista' : pr ? pr.mergeState.toLowerCase() : '—',
      tone: intTone,
      tab: 'pr',
    },
  ];
}

export type BranchBadge = { key: string; label: string; tone: 'sky' | 'mint' | 'amber' | 'coral' | 'mut' };

/** Representa condiciones coexistentes de una rama sin colapsarlas a un único estado excluyente. */
export function computeBranchBadges(branch: BranchEntry, pr: PullSummary | null): BranchBadge[] {
  const badges: BranchBadge[] = [];
  if (branch.active) badges.push({ key: 'active', label: 'Activa', tone: 'sky' });
  if (branch.local && !branch.remote) badges.push({ key: 'local', label: 'Local', tone: 'mut' });
  else if (!branch.local && branch.remote) badges.push({ key: 'remote', label: 'Remota', tone: 'mut' });
  else if (branch.published) badges.push({ key: 'pub', label: 'Publicada', tone: 'mut' });

  if (branch.diverged) badges.push({ key: 'div', label: `↕ ↑${branch.ahead} ↓${branch.behind}`, tone: 'coral' });
  else {
    if (branch.ahead > 0) badges.push({ key: 'ahead', label: `↑${branch.ahead}`, tone: 'amber' });
    if (branch.behind > 0) badges.push({ key: 'behind', label: `↓${branch.behind}`, tone: 'amber' });
  }
  if (branch.worktreePath || branch.agents.length > 0) {
    const busy = branch.agents.some((a) => a.active);
    badges.push({
      key: 'wt',
      label: branch.agents.length > 0 ? branch.agents[0].name : 'Worktree',
      tone: busy ? 'sky' : 'mut',
    });
  }
  if (pr) {
    badges.push({
      key: 'pr',
      label: `PR #${pr.number}${pr.isDraft ? ' draft' : ''}`,
      tone: pr.state === 'MERGED' ? 'mint' : pr.state === 'CLOSED' ? 'mut' : 'sky',
    });
    if (pr.checksFailed > 0) badges.push({ key: 'ci', label: `CI ✗ ${pr.checksFailed}`, tone: 'coral' });
    else if (pr.checksPending > 0) badges.push({ key: 'ci', label: `CI ● ${pr.checksPending}`, tone: 'amber' });
    else if (pr.checksPassed > 0) badges.push({ key: 'ci', label: 'CI ✓', tone: 'mint' });

    if (pr.reviewDecision === 'APPROVED') badges.push({ key: 'rev', label: 'Aprobada', tone: 'mint' });
    else if (pr.reviewDecision === 'CHANGES_REQUESTED') badges.push({ key: 'rev', label: 'Cambios', tone: 'coral' });
  }
  if (branch.mergedIntoDefault && pr?.state !== 'MERGED') {
    badges.push({ key: 'merged', label: 'Integrada', tone: 'mint' });
  }
  return badges;
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
