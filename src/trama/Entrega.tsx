import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  cancelReview,
  deliveryAuto,
  git,
  gitOps,
  githubPr,
  health,
  tasks as taskApi,
  workSessions,
  type AutomationStatus,
  type BranchEntry,
  type BranchInventory,
  type CommitDetail,
  type CompareResult,
  type GitStatus,
  type HealthRun,
  type LogRow,
  type PullDetail,
  type PullSummary,
  type RepoPulls,
  type Review,
  type Session,
  type Task,
  type WorkSession,
} from '../ipc';
import { openFindings, type ReviewNote } from './findings';
import { Icon } from './icons';
import ReviewDiff, { type DiffSpec } from './ReviewDiff';
import { BranchExplorer } from './entrega/BranchExplorer';
import { ChangeTree } from './entrega/ChangeTree';
import { ChecksView } from './entrega/ChecksView';
import { CommitGraph } from './entrega/CommitGraph';
import { CommitsView } from './entrega/CommitsView';
import {
  DEFAULT_LAYOUT_PREFS,
  changesToTreeItems,
  commitFilesToTreeItems,
  computeTimelineStages,
  getEntregaState,
  loadEntregaLayoutPrefs,
  resolveEntregaLayout,
  saveEntregaLayoutPrefs,
  setEntregaState,
  type EntregaLayoutPrefs,
  type EntregaProjectState,
  type HistoryScope,
  type TimelineStageId,
  type TreeFileItem,
  type TreePerspective,
} from './entrega/entregaStore';
import { PullRequestView } from './entrega/PullRequestView';
import { StageAgentsView } from './entrega/StageAgentsView';
import { StageTasksView } from './entrega/StageTasksView';
import { TimelineHeader } from './entrega/TimelineHeader';

export type EntregaStage =
  | 'tarea'
  | 'tareas'
  | 'agentes'
  | 'rama'
  | 'cambios'
  | 'tests'
  | 'commit'
  | 'pr'
  | 'ci'
  | 'integracion';

function mapInitialStage(stage?: EntregaStage | null, ci?: boolean): TimelineStageId | null {
  if (ci) return 'ci';
  switch (stage) {
    case 'tarea':
    case 'tareas':
      return 'tareas';
    case 'agentes':
      return 'agentes';
    case 'rama':
    case 'cambios':
      return 'cambios';
    case 'tests':
      return 'tests';
    case 'commit':
      return 'commit';
    case 'pr':
      return 'pr';
    case 'ci':
      return 'ci';
    case 'integracion':
      return 'integracion';
    default:
      return null;
  }
}

export default function Entrega({
  project,
  projectName,
  agentSessions,
  initialStage,
  initialCi,
  onConsumeCi,
  onFile,
  onConflicts,
  onBranchesChanged,
  onOpenSettings,
}: {
  project: string | null;
  projectName: string | null;
  agentSessions: Session[];
  initialStage?: EntregaStage | null;
  initialScope?: 'project' | number | null;
  initialCi?: boolean;
  onConsumeCi?: () => void;
  onFile: (path: string, session: number | null, root: string | null) => void;
  onConflicts?: (files: string[]) => void;
  onBranchesChanged?: () => void;
  onOpenSettings?: () => void;
}) {
  const [ui, setUi] = useState<EntregaProjectState>(() =>
    project ? getEntregaState(project) : getEntregaState('__none__'),
  );

  const patchUi = useCallback(
    (patch: Partial<EntregaProjectState>) => {
      if (!project) return;
      setUi(setEntregaState(project, patch));
    },
    [project],
  );

  useEffect(() => {
    if (!project) return;
    const saved = getEntregaState(project);
    const forced = mapInitialStage(initialStage, initialCi);
    if (forced && saved.selectedStage !== forced) {
      setUi(setEntregaState(project, { selectedStage: forced }));
    } else {
      setUi(saved);
    }
    if (initialCi) onConsumeCi?.();
  }, [project, initialStage, initialCi, onConsumeCi]);

  // Preferencias de distribución adaptables y persistentes (columnas + altura de historial).
  const [layoutPrefs, setLayoutPrefs] = useState<EntregaLayoutPrefs>(loadEntregaLayoutPrefs);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodySize, setBodySize] = useState({ width: 1120, height: 640 });
  const [dragging, setDragging] = useState<'col1' | 'col2' | 'hist' | null>(null);
  const dragOrigin = useRef<{ startX: number; startY: number; startBranches: number; startTree: number; startHist: number } | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setBodySize({ width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project]);

  const layout = useMemo(
    () => resolveEntregaLayout(layoutPrefs, bodySize.width, bodySize.height),
    [layoutPrefs, bodySize.width, bodySize.height],
  );

  const updateLayoutPrefs = useCallback((next: EntregaLayoutPrefs) => {
    setLayoutPrefs(next);
    saveEntregaLayoutPrefs(next);
  }, []);

  // Estado de datos reales (reutilizando íntegramente el backend Git/GitHub existente)
  const [inventory, setInventory] = useState<BranchInventory | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [compare, setCompare] = useState<CompareResult | null>(null);
  const [repoLog, setRepoLog] = useState<LogRow[]>([]);
  const [branchLog, setBranchLog] = useState<LogRow[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [repoPulls, setRepoPulls] = useState<RepoPulls | null>(null);
  const [prDetail, setPrDetail] = useState<PullDetail | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const [healthRuns, setHealthRuns] = useState<HealthRun[]>([]);
  const [work, setWork] = useState<WorkSession | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [autoStatus, setAutoStatus] = useState<AutomationStatus | null>(null);

  const [diffSubMode, setDiffSubMode] = useState<'worktree' | 'unstaged' | 'staged'>('worktree');
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [focusFinding, setFocusFinding] = useState<ReviewNote | undefined>(undefined);
  const commitCacheRef = useRef(new Map<string, CommitDetail>());

  const [pushReview, setPushReview] = useState<{ branch: string; setUpstream: boolean; review: Review } | null>(null);
  const [pushCode, setPushCode] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerNotice, setBannerNotice] = useState<string | null>(null);

  const projectSessions = useMemo(
    () => (project ? agentSessions.filter((s) => s.project === project) : []),
    [agentSessions, project],
  );

  const loadLocal = useCallback(async () => {
    if (!project) return;
    setLogLoading((prev) => prev || repoLog.length === 0);
    try {
      const [inv, st, lg, runs, ws, tks, auto] = await Promise.all([
        git.branchInventory(project),
        git.status(project),
        git.log(project).catch(() => [] as LogRow[]),
        health.list(project, null).catch(() => [] as HealthRun[]),
        workSessions.current(project).catch(() => null),
        taskApi.list(project).catch(() => [] as Task[]),
        deliveryAuto.status(project).catch(() => null),
      ]);
      setInventory(inv);
      setStatus(st);
      setRepoLog(lg);
      setHealthRuns(runs);
      setWork(ws);
      setTasks(tks);
      setAutoStatus(auto);

      const saved = getEntregaState(project);
      const stillExists = saved.inspectedBranch && inv.branches.some((b) => b.name === saved.inspectedBranch);
      if (!stillExists) {
        const fallback = inv.branches.find((b) => b.active) ?? inv.branches[0] ?? null;
        if (fallback) {
          setUi(setEntregaState(project, { inspectedBranch: fallback.name, inspectedRef: fallback.refName }));
        }
      }
    } catch (e) {
      setBannerError(String(e));
    } finally {
      setLogLoading(false);
    }
  }, [project]);

  const loadPulls = useCallback(async () => {
    if (!project) return;
    try {
      const res = await githubPr.listRepo(project);
      setRepoPulls(res);
    } catch {
      // `pr_list_repo` devuelve errores estructurados en `res.error`.
    }
  }, [project]);

  useEffect(() => {
    commitCacheRef.current.clear();
    setInventory(null);
    setStatus(null);
    setCompare(null);
    setRepoLog([]);
    setBranchLog([]);
    setRepoPulls(null);
    setPrDetail(null);
    setCommitDetail(null);
    setPushReview(null);
    setBannerError(null);
    setBannerNotice(null);
    if (!project) return;
    void loadLocal();
    void loadPulls();
  }, [project, loadLocal, loadPulls]);

  // Refresco orientado a eventos reales del repositorio y tareas (sin polling ciego).
  useEffect(() => {
    if (!project) return;
    let timer: number;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void loadLocal(), 200);
    };
    const offProj = listen('project-changed', schedule);
    const offTasks = listen('tasks-changed', schedule);
    return () => {
      window.clearTimeout(timer);
      void offProj.then((off) => off());
      void offTasks.then((off) => off());
    };
  }, [project, loadLocal]);

  const inspected: BranchEntry | null = useMemo(() => {
    if (!inventory) return null;
    return (
      inventory.branches.find((b) => b.name === ui.inspectedBranch) ??
      inventory.branches.find((b) => b.active) ??
      inventory.branches[0] ??
      null
    );
  }, [inventory, ui.inspectedBranch]);

  const prByBranch = useMemo(() => {
    const map = new Map<string, PullSummary>();
    for (const p of repoPulls?.pulls ?? []) {
      const prev = map.get(p.branch);
      if (!prev || (prev.state !== 'OPEN' && p.state === 'OPEN')) {
        map.set(p.branch, p);
      }
    }
    return map;
  }, [repoPulls]);

  const inspectedPr: PullSummary | null = inspected ? (prByBranch.get(inspected.name) ?? null) : null;

  // Compara la rama inspeccionada frente a su base real (sin checkout).
  useEffect(() => {
    if (!project || !inspected) return;
    let cancelled = false;
    const baseRef = inspectedPr?.base
      ? (inventory?.branches.find((b) => b.name === inspectedPr.base)?.refName ?? inspectedPr.base)
      : (inventory?.defaultRef ?? null);
    git
      .compareBranch(project, inspected.refName, baseRef)
      .then((cmp) => {
        if (!cancelled) setCompare(cmp);
      })
      .catch(() => {
        if (!cancelled) setCompare(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project, inspected?.refName, inspected?.headOid, inspectedPr?.base, inventory?.defaultRef]);

  // Carga el historial filtrado por rama solo cuando el usuario elige filtrar por rama.
  useEffect(() => {
    if (!project || !inspected || ui.historyScope !== 'branch') return;
    let cancelled = false;
    setLogLoading(true);
    git
      .branchLog(project, inspected.refName, 160)
      .then((logs) => {
        if (!cancelled) setBranchLog(logs);
      })
      .catch(() => {
        if (!cancelled) setBranchLog([]);
      })
      .finally(() => {
        if (!cancelled) setLogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, inspected?.refName, inspected?.headOid, ui.historyScope]);

  // Detalle completo de PR bajo demanda cuando la rama inspeccionada tiene PR.
  const loadPrDetail = useCallback(
    async (num: number) => {
      if (!project) return;
      setPrLoading(true);
      try {
        const d = await githubPr.detail(project, num);
        setPrDetail(d);
      } catch (e) {
        setBannerError(String(e));
      } finally {
        setPrLoading(false);
      }
    },
    [project],
  );

  useEffect(() => {
    if (!inspectedPr) {
      setPrDetail(null);
      return;
    }
    if (prDetail?.number === inspectedPr.number && prDetail.headOid === inspectedPr.headOid) return;
    void loadPrDetail(inspectedPr.number);
  }, [inspectedPr?.number, inspectedPr?.headOid, loadPrDetail]);

  // Recupera detalle del commit seleccionado si persistía en estado.
  useEffect(() => {
    if (!project || !ui.selectedCommit) {
      setCommitDetail(null);
      return;
    }
    const key = `${project}:${ui.selectedCommit}`;
    const cached = commitCacheRef.current.get(key);
    if (cached) {
      setCommitDetail(cached);
      return;
    }
    let cancelled = false;
    gitOps
      .detail(project, ui.selectedCommit)
      .then((d) => {
        commitCacheRef.current.set(key, d);
        if (!cancelled) setCommitDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setBannerError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project, ui.selectedCommit]);

  const allOpenFindings = useMemo(() => openFindings(healthRuns), [healthRuns]);

  // Elementos del árbol permanente según perspectiva activa (incluyendo commit seleccionado).
  const treeData = useMemo<{ items: TreeFileItem[]; localExtra: TreeFileItem[] }>(() => {
    if (ui.treePerspective === 'commit' && ui.selectedCommit) {
      return { items: commitFilesToTreeItems(commitDetail), localExtra: [] };
    }
    if (ui.treePerspective === 'uncommitted') {
      if (!inspected?.active) return { items: [], localExtra: [] };
      return { items: changesToTreeItems(status?.changes ?? []), localExtra: [] };
    }
    if (ui.treePerspective === 'branch') {
      return { items: changesToTreeItems(compare?.files ?? []), localExtra: [] };
    }
    const prFiles: TreeFileItem[] = (prDetail?.files ?? []).map((f) => ({
      path: f.path,
      orig: null,
      status: 'M',
      adds: f.additions,
      dels: f.deletions,
      section: 'pr',
    }));
    const localExtra = inspected?.active ? changesToTreeItems(status?.changes ?? []) : [];
    return { items: prFiles, localExtra };
  }, [ui.treePerspective, ui.selectedCommit, commitDetail, inspected?.active, status?.changes, compare?.files, prDetail?.files]);

  const selectedTreeFile: TreeFileItem | null = useMemo(() => {
    const all = [...treeData.items, ...treeData.localExtra];
    return all.find((f) => f.path === ui.selectedFile) ?? all[0] ?? null;
  }, [treeData, ui.selectedFile]);

  const diffSpec: DiffSpec | undefined = useMemo(() => {
    if (ui.treePerspective === 'commit' && ui.selectedCommit) {
      return { mode: 'commit', commit: commitDetail?.hash ?? ui.selectedCommit };
    }
    if (!selectedTreeFile || !inspected) return undefined;
    if (ui.treePerspective === 'uncommitted') {
      return {
        mode: diffSubMode,
        revisionKey: `${status?.headSha ?? ''}:${selectedTreeFile.staged ?? ''}:${selectedTreeFile.unstaged ?? ''}`,
      };
    }
    if (ui.treePerspective === 'pr' && selectedTreeFile.section === 'local') {
      return { mode: 'worktree', revisionKey: status?.headSha ?? '' };
    }
    const baseRef =
      ui.treePerspective === 'pr' && prDetail
        ? (inventory?.branches.find((b) => b.name === prDetail.base)?.refName ?? `refs/remotes/origin/${prDetail.base}`)
        : (compare?.baseRef ?? inventory?.defaultRef ?? 'HEAD');
    const headRef =
      ui.treePerspective === 'pr' && prDetail
        ? (prDetail.headOid || inspected.refName)
        : inspected.refName;
    return { mode: 'range', baseRef, headRef, revisionKey: `${baseRef}:${headRef}` };
  }, [
    ui.treePerspective,
    ui.selectedCommit,
    commitDetail?.hash,
    selectedTreeFile,
    inspected,
    diffSubMode,
    status?.headSha,
    prDetail,
    compare?.baseRef,
    inventory,
  ]);

  const stages = useMemo(
    () =>
      computeTimelineStages({
        branch: inspected,
        status,
        compareCount: compare?.files.length ?? 0,
        pr: inspectedPr,
        healthRuns,
        openFindingsCount: allOpenFindings.length,
        workSession: work,
        tasks,
        agentSessions: projectSessions,
        automation: autoStatus,
      }),
    [inspected, status, compare?.files.length, inspectedPr, healthRuns, allOpenFindings.length, work, tasks, projectSessions, autoStatus],
  );

  const agentBranches = useMemo(
    () => [...new Set(projectSessions.map((s) => s.branch).filter((b): b is string => Boolean(b)))],
    [projectSessions],
  );

  // Acciones Git globales
  const doFetch = async () => {
    if (!project) return;
    setBusyAction('fetch');
    setBannerError(null);
    try {
      await gitOps.fetch(project);
      await Promise.all([loadLocal(), loadPulls()]);
      setBannerNotice('Referencias remotas actualizadas.');
    } catch (e) {
      setBannerError(String(e));
    } finally {
      setBusyAction(null);
    }
  };

  const doPull = async () => {
    if (!project) return;
    setBusyAction('pull');
    setBannerError(null);
    try {
      const msg = await gitOps.pull(project);
      await loadLocal();
      setBannerNotice(msg || 'Rama actualizada con avance rápido.');
    } catch (e) {
      setBannerError(String(e));
    } finally {
      setBusyAction(null);
    }
  };

  const doCheckout = async (branchName: string) => {
    if (!project) return;
    setBusyAction('switch');
    setBannerError(null);
    setBannerNotice(null);
    try {
      await git.switch(project, branchName);
      onBranchesChanged?.();
      await loadLocal();
      setBannerNotice(`Rama activa cambiada a «${branchName}».`);
    } catch (e) {
      setBannerError(String(e));
    } finally {
      setBusyAction(null);
    }
  };

  const startPushForBranch = async (branch: BranchEntry | null) => {
    if (!project || !branch?.local) return;
    setBusyAction('push-review');
    setBannerError(null);
    try {
      const setUpstream = !branch.published;
      const review = await gitOps.reviewPushBranch(project, branch.name, setUpstream);
      setPushReview({ branch: branch.name, setUpstream, review });
      setPushCode('');
    } catch (e) {
      setBannerError(String(e));
    } finally {
      setBusyAction(null);
    }
  };

  const confirmPush = async () => {
    if (!project || !pushReview) return;
    setBusyAction('push');
    setBannerError(null);
    try {
      const msg = await gitOps.pushBranch(project, pushReview.branch, pushReview.setUpstream, {
        id: pushReview.review.id,
        typed: pushCode.trim(),
      });
      setPushReview(null);
      setPushCode('');
      setBannerNotice(msg);
      await Promise.all([loadLocal(), loadPulls()]);
    } catch (e) {
      setBannerError(String(e));
    } finally {
      setBusyAction(null);
    }
  };

  const doStage = async (paths: string[]) => {
    if (!project) return;
    setBannerError(null);
    try {
      await gitOps.stage(project, paths, null);
      await loadLocal();
    } catch (e) {
      setBannerError(String(e));
    }
  };

  const doUnstage = async (paths: string[]) => {
    if (!project) return;
    setBannerError(null);
    try {
      await gitOps.unstage(project, paths, null);
      await loadLocal();
    } catch (e) {
      setBannerError(String(e));
    }
  };

  // Interconexión entre secciones
  const handleInspectBranch = (b: BranchEntry) => {
    const nextPersp: TreePerspective = b.active
      ? (status?.changes.length ? 'uncommitted' : 'branch')
      : 'branch';
    patchUi({
      inspectedBranch: b.name,
      inspectedRef: b.refName,
      treePerspective: nextPersp,
      selectedFile: null,
      selectedCommit: null,
    });
  };

  const handleSelectCommit = useCallback(
    (hash: string) => {
      patchUi({
        selectedCommit: hash,
        treePerspective: 'commit',
        selectedFile: null,
        selectedStage: 'cambios',
      });
    },
    [patchUi],
  );

  const handleClearCommit = useCallback(() => {
    const fallbackPersp: TreePerspective = inspected?.active
      ? (status?.changes.length ? 'uncommitted' : 'branch')
      : 'branch';
    patchUi({
      selectedCommit: null,
      treePerspective: fallbackPersp,
      selectedFile: null,
    });
  }, [inspected?.active, status?.changes.length, patchUi]);

  const handleScopeChange = useCallback(
    (historyScope: HistoryScope) => patchUi({ historyScope }),
    [patchUi],
  );

  const handleHistorySearchChange = useCallback(
    (historySearch: string) => patchUi({ historySearch }),
    [patchUi],
  );

  // Gestión de arrastre de divisores redimensionables
  const beginDrag = (kind: 'col1' | 'col2' | 'hist', e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragOrigin.current = {
      startX: e.clientX,
      startY: e.clientY,
      startBranches: layout.branchesPx,
      startTree: layout.treePx,
      startHist: layout.historyPx,
    };
    setDragging(kind);
    document.documentElement.dataset.resizing = kind === 'hist' ? 'y' : 'x';
  };

  const moveDrag = (kind: 'col1' | 'col2' | 'hist', e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragOrigin.current) return;
    const w = Math.max(520, bodySize.width);
    const h = Math.max(280, bodySize.height);
    if (kind === 'col1') {
      const nextPx = dragOrigin.current.startBranches + (e.clientX - dragOrigin.current.startX);
      const ratio = Math.min(0.36, Math.max(0.14, nextPx / w));
      updateLayoutPrefs({ ...layoutPrefs, branchesRatio: ratio });
    } else if (kind === 'col2') {
      const nextPx = dragOrigin.current.startTree + (e.clientX - dragOrigin.current.startX);
      const ratio = Math.min(0.38, Math.max(0.16, nextPx / w));
      updateLayoutPrefs({ ...layoutPrefs, treeRatio: ratio });
    } else {
      const nextPx = dragOrigin.current.startHist - (e.clientY - dragOrigin.current.startY);
      const ratio = Math.min(0.56, Math.max(0.18, nextPx / h));
      updateLayoutPrefs({ ...layoutPrefs, historyRatio: ratio });
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragOrigin.current) return;
    dragOrigin.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(null);
    delete document.documentElement.dataset.resizing;
  };

  if (!project) {
    return (
      <div className="tv ent-root">
        <div className="tr-empty">
          <Icon name="review" size={28} />
          <h3>Entrega</h3>
          <p>Selecciona un proyecto para seguir la línea temporal, ramas, cambios, Pull Requests y el grafo de commits.</p>
        </div>
      </div>
    );
  }

  const diffTarget = selectedTreeFile
    ? {
        path: selectedTreeFile.path,
        orig: selectedTreeFile.orig,
        status: selectedTreeFile.status,
        adds: selectedTreeFile.adds,
        dels: selectedTreeFile.dels,
      }
    : null;

  const fileFindings = diffTarget ? allOpenFindings.filter((f) => f.path === diffTarget.path) : [];
  const graphRows = ui.historyScope === 'branch' ? branchLog : repoLog;
  const activeStageObj = stages.find((s) => s.id === ui.selectedStage) ?? stages[2];

  return (
    <div className={`tv ent-root${dragging ? ' is-dragging' : ''}`}>
      {/* SECCIÓN 01 — Entrega (Línea temporal Trama v2) */}
      <TimelineHeader
        projectName={projectName ?? project.split('/').pop() ?? 'Proyecto'}
        activeBranch={inventory?.activeBranch ?? status?.branch ?? null}
        agentBranches={agentBranches}
        inspected={inspected}
        stages={stages}
        selectedStage={ui.selectedStage}
        automation={autoStatus}
        busyAction={busyAction}
        onSelectStage={(id) => patchUi({ selectedStage: id })}
        onFetch={doFetch}
        onPull={doPull}
        onPush={() => void startPushForBranch(inspected)}
        onCheckout={doCheckout}
        onOpenSettings={onOpenSettings}
      />

      {pushReview && (
        <div className="ent-push-bar">
          <Icon name="push" size={13} />
          <span><strong>Confirmar publicación:</strong> {pushReview.review.message}</span>
          <input
            className="in mono"
            style={{ maxWidth: 150 }}
            value={pushCode}
            onChange={(e) => setPushCode(e.target.value)}
            placeholder={`Escribe ${pushReview.review.code}`}
          />
          <button type="button" className="btn sm pearl" disabled={busyAction !== null || !pushCode.trim()} onClick={confirmPush}>
            Publicar
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              void cancelReview(pushReview.review.id);
              setPushReview(null);
            }}
          >
            Cancelar
          </button>
        </div>
      )}

      {(bannerError || bannerNotice || (repoPulls?.error && (ui.selectedStage === 'pr' || ui.selectedStage === 'ci'))) && (
        <div className="ent-banners">
          {bannerError && (
            <div className="tr-error" role="alert">
              <Icon name="warn" size={13} />
              <span className="grow">{bannerError}</span>
              <button type="button" className="tbtn" onClick={() => setBannerError(null)} aria-label="Cerrar error">
                <Icon name="close" size={12} />
              </button>
            </div>
          )}
          {bannerNotice && (
            <div className="ent-notice">
              <Icon name="check" size={13} />
              <span className="grow">{bannerNotice}</span>
              <button type="button" className="tbtn" onClick={() => setBannerNotice(null)} aria-label="Cerrar aviso">
                <Icon name="close" size={12} />
              </button>
            </div>
          )}
          {repoPulls?.error && (ui.selectedStage === 'pr' || ui.selectedStage === 'ci') && (
            <div className="ent-warn-banner">
              <Icon name="warn" size={13} />
              <span>GitHub: {repoPulls.error}</span>
            </div>
          )}
        </div>
      )}

      {/* Contenedor vertical para SECCIÓN 02 (58%) + Divisor + SECCIÓN 03 (30%) */}
      <div ref={bodyRef} className="ent-workspace">
        {/* SECCIÓN 02 — Ramas, cambios y commit (3 columnas redimensionables) */}
        <div className="ent-s02" aria-label="Ramas, cambios y revisión">
          <div className="ent-pane-slot" style={{ width: layout.branchesPx }}>
            <BranchExplorer
              branches={inventory?.branches ?? []}
              inspectedBranch={inspected?.name ?? null}
              prByBranch={prByBranch}
              search={ui.branchSearch}
              showMerged={ui.showMergedBranches}
              onSearch={(branchSearch) => patchUi({ branchSearch })}
              onToggleMerged={() => patchUi({ showMergedBranches: !ui.showMergedBranches })}
              onInspect={handleInspectBranch}
              onCheckout={doCheckout}
              onFilterHistory={(b) => {
                handleInspectBranch(b);
                patchUi({ historyScope: 'branch' });
              }}
              onOpenPr={(b) => {
                handleInspectBranch(b);
                patchUi({ selectedStage: 'pr' });
              }}
              onPushBranch={(b) => void startPushForBranch(b)}
            />
          </div>

          <div
            className="ent-vsplit"
            role="separator"
            aria-orientation="vertical"
            aria-label="Ajustar ancho de ramas"
            tabIndex={0}
            title="Arrastra para ajustar · Doble clic para restablecer"
            onPointerDown={(e) => beginDrag('col1', e)}
            onPointerMove={(e) => moveDrag('col1', e)}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={() => updateLayoutPrefs({ ...layoutPrefs, branchesRatio: DEFAULT_LAYOUT_PREFS.branchesRatio })}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') updateLayoutPrefs({ ...layoutPrefs, branchesRatio: Math.max(0.14, layoutPrefs.branchesRatio - 0.02) });
              else if (e.key === 'ArrowRight') updateLayoutPrefs({ ...layoutPrefs, branchesRatio: Math.min(0.36, layoutPrefs.branchesRatio + 0.02) });
            }}
          />

          <div className="ent-pane-slot" style={{ width: layout.treePx }}>
            <ChangeTree
              perspective={ui.treePerspective}
              items={treeData.items}
              localExtraItems={treeData.localExtra}
              selectedFile={selectedTreeFile?.path ?? null}
              selectedCommitHash={ui.selectedCommit}
              commitLoading={Boolean(ui.selectedCommit && (!commitDetail || !commitDetail.hash.startsWith(ui.selectedCommit)))}
              collapsedDirs={ui.collapsedDirs}
              canStage={Boolean(inspected?.active)}
              prNumber={inspectedPr?.number ?? null}
              baseLabel={inspectedPr?.base ?? inventory?.defaultBranch ?? 'base'}
              onPerspective={(treePerspective) => {
                patchUi({ treePerspective, selectedFile: null, selectedCommit: null });
              }}
              onClearCommit={handleClearCommit}
              onSelectFile={(item) => {
                patchUi({ selectedFile: item.path, selectedStage: 'cambios' });
              }}
              onToggleDir={(dirPath) =>
                patchUi({ collapsedDirs: { ...ui.collapsedDirs, [dirPath]: !ui.collapsedDirs[dirPath] } })
              }
              onStage={doStage}
              onUnstage={doUnstage}
              onOpenEditor={(path) => onFile(path, null, project)}
            />
          </div>

          <div
            className="ent-vsplit"
            role="separator"
            aria-orientation="vertical"
            aria-label="Ajustar ancho del árbol de cambios"
            tabIndex={0}
            title="Arrastra para ajustar · Doble clic para restablecer"
            onPointerDown={(e) => beginDrag('col2', e)}
            onPointerMove={(e) => moveDrag('col2', e)}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={() => updateLayoutPrefs({ ...layoutPrefs, treeRatio: DEFAULT_LAYOUT_PREFS.treeRatio })}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') updateLayoutPrefs({ ...layoutPrefs, treeRatio: Math.max(0.16, layoutPrefs.treeRatio - 0.02) });
              else if (e.key === 'ArrowRight') updateLayoutPrefs({ ...layoutPrefs, treeRatio: Math.min(0.38, layoutPrefs.treeRatio + 0.02) });
            }}
          />

          {/* Columna derecha — Revisión y operaciones (cambia contextualmente según etapa, commit o archivo) */}
          <main className="ent-col ent-col-right" aria-label={`Revisión y operaciones: ${activeStageObj.label}`}>
            <div className="ent-col-head ent-right-head">
              <span className={`ent-dot-sm tone-${activeStageObj.status === 'done' ? 'mint' : activeStageObj.status === 'active' ? 'sky' : activeStageObj.status === 'failed' ? 'coral' : activeStageObj.status === 'blocked' ? 'amber' : 'mut'}`} />
              <span>
                {ui.selectedStage === 'cambios' && ui.treePerspective === 'commit' && ui.selectedCommit
                  ? `Commit ${ui.selectedCommit.slice(0, 7)}`
                  : activeStageObj.label}
              </span>
              {ui.selectedStage === 'cambios' && diffTarget && (
                <span className="ent-right-path mono" title={diffTarget.path}>
                  {diffTarget.path}
                </span>
              )}
              <span className="grow" />

              {ui.selectedStage === 'cambios' && diffTarget && (
                <div className="ent-right-acts">
                  {ui.treePerspective === 'commit' && ui.selectedCommit ? (
                    <button type="button" className="btn sm ghost" onClick={handleClearCommit}>
                      Salir de commit
                    </button>
                  ) : ui.treePerspective === 'uncommitted' ? (
                    <div className="tr-seg ent-mini-seg">
                      <button type="button" aria-pressed={diffSubMode === 'worktree'} onClick={() => setDiffSubMode('worktree')}>
                        Todo
                      </button>
                      <button type="button" aria-pressed={diffSubMode === 'unstaged'} onClick={() => setDiffSubMode('unstaged')}>
                        Sin prep.
                      </button>
                      <button type="button" aria-pressed={diffSubMode === 'staged'} onClick={() => setDiffSubMode('staged')}>
                        Prep.
                      </button>
                    </div>
                  ) : null}

                  {ui.treePerspective === 'branch' && compare && (
                    <span className="ent-mono-meta mono">
                      {compare.mergeBase?.slice(0, 7) ?? compare.baseRef}..{inspected?.shortOid}
                    </span>
                  )}
                  {fileFindings.length > 0 && (
                    <button
                      type="button"
                      className="ent-inline-tag tone-amber"
                      onClick={() => patchUi({ selectedStage: 'tests' })}
                    >
                      {fileFindings.length} hallazgos
                    </button>
                  )}
                  {inspected?.active && ui.treePerspective !== 'commit' && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => onFile(diffTarget.path, null, project)}
                      title="Abrir archivo en el editor"
                    >
                      <Icon name="code" size={11} /> Editor
                    </button>
                  )}
                </div>
              )}
            </div>

            {ui.selectedStage === 'tareas' && (
              <StageTasksView
                project={project}
                work={work}
                tasks={tasks}
                onGoPr={() => patchUi({ selectedStage: 'pr' })}
              />
            )}

            {ui.selectedStage === 'agentes' && (
              <StageAgentsView
                project={project}
                activeBranch={inventory?.activeBranch ?? status?.branch ?? null}
                agentSessions={projectSessions}
                automation={autoStatus}
                onRefresh={() => void loadLocal()}
                onOpenSettings={onOpenSettings}
              />
            )}

            {ui.selectedStage === 'cambios' && (
              <div className="ent-diff-host">
                {ui.treePerspective === 'commit' && commitDetail && (
                  <div className="ent-commit-summary">
                    <div className="ent-commit-sum-top">
                      <strong className="mono">{commitDetail.hash.slice(0, 10)}</strong>
                      <span className="mut">{commitDetail.author}</span>
                      <span className="mut mono">{commitDetail.date.slice(0, 16).replace('T', ' ')}</span>
                      <span className="ent-mono-meta mono">{commitDetail.files.length} archivos</span>
                    </div>
                    {commitDetail.body && (
                      <div className="ent-commit-sum-body">{commitDetail.body.trim()}</div>
                    )}
                  </div>
                )}

                {diffTarget ? (
                  <ReviewDiff
                    project={project}
                    change={diffTarget}
                    diffSpec={diffSpec}
                    findings={fileFindings}
                    finding={focusFinding}
                  />
                ) : (
                  <div className="ent-empty-pane">
                    <Icon name="diff" size={20} />
                    <p>
                      {ui.treePerspective === 'uncommitted'
                        ? 'Árbol de trabajo limpio. Selecciona un commit en el historial inferior o cambia a «vs base» para revisar diferencias.'
                        : 'Selecciona un archivo en el árbol central para inspeccionar su diff.'}
                    </p>
                    {ui.treePerspective === 'uncommitted' && (compare?.files.length ?? 0) > 0 && (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => patchUi({ treePerspective: 'branch', selectedFile: null })}
                      >
                        Ver {compare!.files.length} archivos vs {inspectedPr?.base ?? inventory?.defaultBranch ?? 'base'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {ui.selectedStage === 'tests' && (
              <ChecksView
                mode="tests"
                project={project}
                headSha={inspected?.headOid ?? status?.headSha ?? null}
                dirtyTree={Boolean(inspected?.active && (status?.changes.length ?? 0) > 0)}
                isActiveBranch={Boolean(inspected?.active)}
                prDetail={prDetail}
                healthRuns={healthRuns}
                automation={autoStatus}
                onRefresh={() => {
                  void loadLocal();
                  if (inspectedPr) void loadPrDetail(inspectedPr.number);
                }}
                onOpenFinding={(note) => {
                  setFocusFinding(note);
                  patchUi({
                    selectedStage: 'cambios',
                    selectedCommit: null,
                    treePerspective: inspected?.active && (status?.changes.length ?? 0) > 0 ? 'uncommitted' : 'branch',
                    selectedFile: note.path ?? ui.selectedFile,
                  });
                }}
              />
            )}

            {ui.selectedStage === 'commit' && (
              <CommitsView
                project={project}
                inspected={inspected}
                status={status}
                onStage={doStage}
                onUnstage={doUnstage}
                onRefresh={() => {
                  void loadLocal();
                  void loadPulls();
                }}
              />
            )}

            {(ui.selectedStage === 'pr' || ui.selectedStage === 'integracion') && (
              <PullRequestView
                mode={ui.selectedStage}
                project={project}
                inspected={inspected}
                defaultBranch={inventory?.defaultBranch ?? 'main'}
                branches={inventory?.branches ?? []}
                prSummary={inspectedPr}
                prDetail={prDetail}
                automation={autoStatus}
                loading={prLoading}
                onRefresh={() => {
                  void loadLocal();
                  void loadPulls();
                  if (inspectedPr) void loadPrDetail(inspectedPr.number);
                }}
                onInspectPrFiles={() =>
                  patchUi({
                    treePerspective: 'pr',
                    selectedStage: 'cambios',
                    selectedCommit: null,
                    selectedFile: null,
                  })
                }
                onGoChecks={() => patchUi({ selectedStage: 'ci' })}
                onGoIntegration={() => patchUi({ selectedStage: 'integracion' })}
                onDiff={(d) => patchUi({ selectedFile: d.path, selectedStage: 'cambios' })}
                onConflicts={onConflicts}
              />
            )}

            {ui.selectedStage === 'ci' && (
              <ChecksView
                mode="ci"
                project={project}
                headSha={inspected?.headOid ?? status?.headSha ?? null}
                dirtyTree={Boolean(inspected?.active && (status?.changes.length ?? 0) > 0)}
                isActiveBranch={Boolean(inspected?.active)}
                prDetail={prDetail}
                healthRuns={healthRuns}
                automation={autoStatus}
                onRefresh={() => {
                  void loadLocal();
                  void loadPulls();
                  if (inspectedPr) void loadPrDetail(inspectedPr.number);
                }}
                onOpenFinding={(note) => {
                  setFocusFinding(note);
                  patchUi({ selectedStage: 'cambios', selectedFile: note.path ?? ui.selectedFile });
                }}
              />
            )}
          </main>
        </div>

        {/* Divisor horizontal redimensionable entre SECCIÓN 02 y SECCIÓN 03 */}
        <div
          className="ent-hsplit"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Ajustar altura del historial de commits"
          tabIndex={0}
          title="Arrastra para ajustar altura del historial · Doble clic para restablecer"
          onPointerDown={(e) => beginDrag('hist', e)}
          onPointerMove={(e) => moveDrag('hist', e)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => updateLayoutPrefs({ ...layoutPrefs, historyRatio: DEFAULT_LAYOUT_PREFS.historyRatio })}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') updateLayoutPrefs({ ...layoutPrefs, historyRatio: Math.min(0.56, layoutPrefs.historyRatio + 0.03) });
            else if (e.key === 'ArrowDown') updateLayoutPrefs({ ...layoutPrefs, historyRatio: Math.max(0.18, layoutPrefs.historyRatio - 0.03) });
          }}
        />

        {/* SECCIÓN 03 — Historial de commits permanente e interactivo (Git Graph real) */}
        <div className="ent-s03-slot" style={{ height: layout.historyPx }}>
          <CommitGraph
            rows={graphRows}
            loading={logLoading}
            scope={ui.historyScope}
            inspectedBranchName={inspected?.name ?? null}
            selectedCommit={ui.selectedCommit}
            search={ui.historySearch}
            pulls={repoPulls?.pulls ?? []}
            onScopeChange={handleScopeChange}
            onSearchChange={handleHistorySearchChange}
            onSelectCommit={handleSelectCommit}
            onClearCommit={handleClearCommit}
          />
        </div>
      </div>
    </div>
  );
}
