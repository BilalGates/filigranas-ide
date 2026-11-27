import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  cancelReview,
  deliveryAuto,
  git,
  gitOps,
  githubPr,
  health,
  workSessions,
  type AutomationStatus,
  type BranchEntry,
  type BranchInventory,
  type CheckLog,
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
  type WorkSession,
} from '../ipc';
import { openFindings, type ReviewNote } from './findings';
import { Icon } from './icons';
import ReviewDiff, { type DiffSpec } from './ReviewDiff';
import { AuditsView } from './entrega/AuditsView';
import { AutomationView } from './entrega/AutomationView';
import { BranchExplorer } from './entrega/BranchExplorer';
import { ChangeTree } from './entrega/ChangeTree';
import { ChecksView } from './entrega/ChecksView';
import { CommitsView } from './entrega/CommitsView';
import { ContextInspector, type InspectorPayload } from './entrega/ContextInspector';
import { DeliveryHeader } from './entrega/DeliveryHeader';
import {
  changesToTreeItems,
  computePipelineStages,
  getEntregaState,
  setEntregaState,
  type CenterTab,
  type EntregaProjectState,
  type TreeFileItem,
  type TreePerspective,
} from './entrega/entregaStore';
import { PullRequestView } from './entrega/PullRequestView';

export type EntregaStage =
  | 'tarea'
  | 'agentes'
  | 'rama'
  | 'cambios'
  | 'tests'
  | 'commit'
  | 'pr'
  | 'ci'
  | 'integracion';

function mapInitialStage(stage?: EntregaStage | null, ci?: boolean): CenterTab | null {
  if (ci) return 'checks';
  switch (stage) {
    case 'cambios':
      return 'diff';
    case 'commit':
    case 'rama':
      return 'commits';
    case 'pr':
    case 'integracion':
      return 'pr';
    case 'ci':
    case 'tests':
      return 'checks';
    default:
      return null;
  }
}

export default function Entrega({
  project,
  projectName,
  initialStage,
  initialCi,
  onConsumeCi,
  onFile,
  onBranchesChanged,
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

  // Al cambiar de proyecto se restaura su estado independiente de Entrega.
  useEffect(() => {
    if (!project) return;
    const saved = getEntregaState(project);
    const forcedTab = mapInitialStage(initialStage, initialCi);
    if (forcedTab && saved.centerTab !== forcedTab) {
      setUi(setEntregaState(project, { centerTab: forcedTab }));
    } else {
      setUi(saved);
    }
    if (initialCi) onConsumeCi?.();
  }, [project, initialStage, initialCi, onConsumeCi]);

  const [inventory, setInventory] = useState<BranchInventory | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [compare, setCompare] = useState<CompareResult | null>(null);
  const [branchLog, setBranchLog] = useState<LogRow[]>([]);
  const [repoPulls, setRepoPulls] = useState<RepoPulls | null>(null);
  const [prDetail, setPrDetail] = useState<PullDetail | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const [healthRuns, setHealthRuns] = useState<HealthRun[]>([]);
  const [work, setWork] = useState<WorkSession | null>(null);
  const [autoStatus, setAutoStatus] = useState<AutomationStatus | null>(null);

  const [diffSubMode, setDiffSubMode] = useState<'worktree' | 'unstaged' | 'staged'>('worktree');
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [commitDiffFile, setCommitDiffFile] = useState<{ commit: string; path: string } | null>(null);
  const [activeLog, setActiveLog] = useState<{ title: string; log: CheckLog } | null>(null);
  const [focusFinding, setFocusFinding] = useState<ReviewNote | undefined>(undefined);

  const [pushReview, setPushReview] = useState<{ branch: string; setUpstream: boolean; review: Review } | null>(null);
  const [pushCode, setPushCode] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerNotice, setBannerNotice] = useState<string | null>(null);

  const loadLocal = useCallback(async () => {
    if (!project) return;
    try {
      const [inv, st, runs, ws, auto] = await Promise.all([
        git.branchInventory(project),
        git.status(project),
        health.list(project, null).catch(() => [] as HealthRun[]),
        workSessions.current(project).catch(() => null),
        deliveryAuto.status(project).catch(() => null),
      ]);
      setInventory(inv);
      setStatus(st);
      setHealthRuns(runs);
      setWork(ws);
      setAutoStatus(auto);

      // Si no hay rama inspeccionada guardada o ya no existe, enfoca la rama activa.
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
    }
  }, [project]);

  const loadPulls = useCallback(async () => {
    if (!project) return;
    try {
      const res = await githubPr.listRepo(project);
      setRepoPulls(res);
    } catch {
      // Silencioso: `pr_list_repo` devuelve errores estructurados en `res.error`.
    }
  }, [project]);

  useEffect(() => {
    setInventory(null);
    setStatus(null);
    setCompare(null);
    setBranchLog([]);
    setRepoPulls(null);
    setPrDetail(null);
    setCommitDetail(null);
    setCommitDiffFile(null);
    setActiveLog(null);
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
      timer = window.setTimeout(() => void loadLocal(), 180);
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
      // Prioriza PR abierta sobre cerradas/integradas anteriores.
      if (!prev || (prev.state !== 'OPEN' && p.state === 'OPEN')) {
        map.set(p.branch, p);
      }
    }
    return map;
  }, [repoPulls]);

  const inspectedPr: PullSummary | null = inspected ? (prByBranch.get(inspected.name) ?? null) : null;

  // Compara la rama inspeccionada frente a su base real y carga su historial (sin checkout).
  useEffect(() => {
    if (!project || !inspected) return;
    let cancelled = false;
    const baseRef = inspectedPr?.base
      ? (inventory?.branches.find((b) => b.name === inspectedPr.base)?.refName ?? inspectedPr.base)
      : (inventory?.defaultRef ?? null);
    Promise.all([
      git.compareBranch(project, inspected.refName, baseRef).catch(() => null),
      git.branchLog(project, inspected.refName, 60).catch(() => [] as LogRow[]),
    ]).then(([cmp, logs]) => {
      if (cancelled) return;
      setCompare(cmp);
      setBranchLog(logs);
    });
    return () => {
      cancelled = true;
    };
  }, [project, inspected?.refName, inspected?.headOid, inspectedPr?.base, inventory?.defaultRef]);

  // Detalle completo de PR bajo demanda al tener una PR asociada a la rama inspeccionada.
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

  const allOpenFindings = useMemo(() => openFindings(healthRuns), [healthRuns]);

  // Elementos del árbol según la perspectiva activa.
  const treeData = useMemo<{ items: TreeFileItem[]; localExtra: TreeFileItem[] }>(() => {
    if (ui.treePerspective === 'uncommitted') {
      if (!inspected?.active) return { items: [], localExtra: [] };
      return { items: changesToTreeItems(status?.changes ?? []), localExtra: [] };
    }
    if (ui.treePerspective === 'branch') {
      return { items: changesToTreeItems(compare?.files ?? []), localExtra: [] };
    }
    // Perspectiva Pull Request: archivos de GitHub separados de los cambios locales sin subir.
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
  }, [ui.treePerspective, inspected?.active, status?.changes, compare?.files, prDetail?.files]);

  const selectedTreeFile: TreeFileItem | null = useMemo(() => {
    const all = [...treeData.items, ...treeData.localExtra];
    return all.find((f) => f.path === ui.selectedFile) ?? all[0] ?? null;
  }, [treeData, ui.selectedFile]);

  const diffSpec: DiffSpec | undefined = useMemo(() => {
    if (commitDiffFile) {
      return { mode: 'commit', commit: commitDiffFile.commit };
    }
    if (!selectedTreeFile || !inspected) return undefined;
    if (ui.treePerspective === 'uncommitted') {
      return { mode: diffSubMode, revisionKey: `${status?.headSha ?? ''}:${selectedTreeFile.staged ?? ''}:${selectedTreeFile.unstaged ?? ''}` };
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
  }, [commitDiffFile, selectedTreeFile, inspected, ui.treePerspective, diffSubMode, status?.headSha, prDetail, compare?.baseRef, inventory]);

  const stages = useMemo(
    () =>
      computePipelineStages({
        branch: inspected,
        status,
        compareCount: compare?.files.length ?? 0,
        pr: inspectedPr,
        healthRuns,
        openFindingsCount: allOpenFindings.length,
        workSession: work,
      }),
    [inspected, status, compare?.files.length, inspectedPr, healthRuns, allOpenFindings.length, work],
  );

  // Acciones Git globales (cabecera + explorador)
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

  const startPush = async () => {
    if (!project || !inspected?.local) return;
    setBusyAction('push-review');
    setBannerError(null);
    try {
      const setUpstream = !inspected.published;
      const review = await gitOps.reviewPushBranch(project, inspected.name, setUpstream);
      setPushReview({ branch: inspected.name, setUpstream, review });
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

  const handleInspectBranch = (b: BranchEntry) => {
    setCommitDiffFile(null);
    setCommitDetail(null);
    setActiveLog(null);
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

  const handleSelectCommit = async (hash: string) => {
    if (!project) return;
    patchUi({ selectedCommit: hash, inspectorOpen: true });
    setActiveLog(null);
    try {
      const d = await gitOps.detail(project, hash);
      setCommitDetail(d);
    } catch (e) {
      setBannerError(String(e));
    }
  };

  const inspectorPayload: InspectorPayload | null = useMemo(() => {
    if (activeLog) return { kind: 'log', title: activeLog.title, log: activeLog.log };
    if (commitDetail && ui.selectedCommit) {
      return {
        kind: 'commit',
        detail: commitDetail,
        onOpenFile: (path) => {
          setCommitDiffFile({ commit: commitDetail.hash, path });
          patchUi({ centerTab: 'diff', selectedFile: path });
        },
      };
    }
    if (ui.centerTab === 'diff' && selectedTreeFile) {
      const fileFindings = allOpenFindings.filter((f) => f.path === selectedTreeFile.path);
      return { kind: 'file', file: selectedTreeFile, findings: fileFindings };
    }
    if (ui.centerTab === 'pr' && prDetail) {
      return { kind: 'pr', detail: prDetail };
    }
    return null;
  }, [activeLog, commitDetail, ui.selectedCommit, ui.centerTab, selectedTreeFile, allOpenFindings, prDetail, patchUi]);

  const showInspector = Boolean(ui.inspectorOpen && inspectorPayload);

  if (!project) {
    return (
      <div className="tv ent-root">
        <div className="tr-empty">
          <Icon name="review" size={28} />
          <h3>Centro de Entrega</h3>
          <p>Selecciona un proyecto para inspeccionar ramas, cambios, commits, Pull Requests y comprobaciones CI.</p>
        </div>
      </div>
    );
  }

  const diffTarget = commitDiffFile
    ? { path: commitDiffFile.path, orig: null, status: 'M', adds: null, dels: null }
    : selectedTreeFile
      ? {
          path: selectedTreeFile.path,
          orig: selectedTreeFile.orig,
          status: selectedTreeFile.status,
          adds: selectedTreeFile.adds,
          dels: selectedTreeFile.dels,
        }
      : null;

  const fileFindings = diffTarget ? allOpenFindings.filter((f) => f.path === diffTarget.path) : [];

  return (
    <div className="tv ent-root">
      <DeliveryHeader
        projectName={projectName ?? project.split('/').pop() ?? 'Proyecto'}
        activeBranch={inventory?.activeBranch ?? status?.branch ?? null}
        inspected={inspected}
        stages={stages}
        activeTab={ui.centerTab}
        busyAction={busyAction}
        inspectorOpen={showInspector}
        hasInspectorData={inspectorPayload !== null}
        onSelectStage={(tab) => patchUi({ centerTab: tab })}
        onFetch={doFetch}
        onPull={doPull}
        onPush={startPush}
        onCheckout={doCheckout}
        onToggleInspector={() => patchUi({ inspectorOpen: !ui.inspectorOpen })}
      />

      {pushReview && (
        <div className="ent-push-bar">
          <Icon name="push" size={14} />
          <span><strong>Confirmar publicación:</strong> {pushReview.review.message}</span>
          <input
            className="in mono"
            style={{ maxWidth: 150 }}
            value={pushCode}
            onChange={(e) => setPushCode(e.target.value)}
            placeholder={`Escribe ${pushReview.review.code}`}
          />
          <button className="btn sm pearl" disabled={busyAction !== null || !pushCode.trim()} onClick={confirmPush}>
            Publicar
          </button>
          <button
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

      {(bannerError || bannerNotice || (repoPulls?.error && ui.centerTab === 'pr')) && (
        <div className="ent-banners">
          {bannerError && (
            <div className="tr-error" role="alert">
              <Icon name="warn" size={14} />
              <span className="grow">{bannerError}</span>
              <button className="tbtn" onClick={() => setBannerError(null)} aria-label="Cerrar error"><Icon name="close" size={12} /></button>
            </div>
          )}
          {bannerNotice && (
            <div className="ent-notice">
              <Icon name="check" size={14} />
              <span className="grow">{bannerNotice}</span>
              <button className="tbtn" onClick={() => setBannerNotice(null)} aria-label="Cerrar aviso"><Icon name="close" size={12} /></button>
            </div>
          )}
          {repoPulls?.error && ui.centerTab === 'pr' && (
            <div className="ent-warn-banner">
              <Icon name="warn" size={14} />
              <span>GitHub: {repoPulls.error}</span>
            </div>
          )}
        </div>
      )}

      <div className={`ent-body${showInspector ? ' has-insp' : ''}`}>
        {/* Explorador permanente izquierdo: Ramas + Árbol de cambios */}
        <aside className="ent-left" aria-label="Explorador de ramas y cambios">
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
          />
          <ChangeTree
            perspective={ui.treePerspective}
            items={treeData.items}
            localExtraItems={treeData.localExtra}
            selectedFile={selectedTreeFile?.path ?? null}
            collapsedDirs={ui.collapsedDirs}
            canStage={Boolean(inspected?.active)}
            prNumber={inspectedPr?.number ?? null}
            baseLabel={inspectedPr?.base ?? inventory?.defaultBranch ?? 'base'}
            onPerspective={(treePerspective) => {
              setCommitDiffFile(null);
              patchUi({ treePerspective, selectedFile: null });
            }}
            onSelectFile={(item) => {
              setCommitDiffFile(null);
              setActiveLog(null);
              patchUi({ selectedFile: item.path, centerTab: 'diff' });
            }}
            onToggleDir={(dirPath) =>
              patchUi({ collapsedDirs: { ...ui.collapsedDirs, [dirPath]: !ui.collapsedDirs[dirPath] } })
            }
            onStage={doStage}
            onUnstage={doUnstage}
            onOpenEditor={(path) => onFile(path, null, project)}
          />
        </aside>

        {/* Área central única con navegación contextual compacta */}
        <main className="ent-center">
          <div className="ent-tabs-bar">
            <div className="tr-seg" role="tablist" aria-label="Superficies de Entrega">
              <button role="tab" aria-selected={ui.centerTab === 'diff'} onClick={() => patchUi({ centerTab: 'diff' })}>
                <Icon name="diff" size={12} /> Diff
              </button>
              <button role="tab" aria-selected={ui.centerTab === 'commits'} onClick={() => patchUi({ centerTab: 'commits' })}>
                <Icon name="commit" size={12} /> Commits y Larry
              </button>
              <button role="tab" aria-selected={ui.centerTab === 'pr'} onClick={() => patchUi({ centerTab: 'pr' })}>
                <Icon name="pr" size={12} /> PR{inspectedPr ? ` #${inspectedPr.number}` : ''}
              </button>
              <button role="tab" aria-selected={ui.centerTab === 'checks'} onClick={() => patchUi({ centerTab: 'checks' })}>
                <Icon name="health" size={12} /> Tests y CI
                {inspectedPr && inspectedPr.checksFailed > 0 && <span className="ent-badge-err">{inspectedPr.checksFailed}</span>}
              </button>
              <button role="tab" aria-selected={ui.centerTab === 'audits'} onClick={() => patchUi({ centerTab: 'audits' })}>
                <Icon name="shield" size={12} /> Auditoría
                {allOpenFindings.length > 0 && <span className="ent-badge-warn">{allOpenFindings.length}</span>}
              </button>
              <button role="tab" aria-selected={ui.centerTab === 'automation'} onClick={() => patchUi({ centerTab: 'automation' })}>
                <Icon name="spark" size={12} /> Auto
              </button>
            </div>

            {ui.centerTab === 'diff' && diffTarget && (
              <div className="ent-diff-bar-right">
                {commitDiffFile ? (
                  <button className="btn sm" onClick={() => setCommitDiffFile(null)}>
                    Volver a {ui.treePerspective === 'uncommitted' ? 'sin commit' : ui.treePerspective}
                  </button>
                ) : ui.treePerspective === 'uncommitted' ? (
                  <div className="tr-seg">
                    <button aria-pressed={diffSubMode === 'worktree'} onClick={() => setDiffSubMode('worktree')}>Todo</button>
                    <button aria-pressed={diffSubMode === 'unstaged'} onClick={() => setDiffSubMode('unstaged')}>Sin preparar</button>
                    <button aria-pressed={diffSubMode === 'staged'} onClick={() => setDiffSubMode('staged')}>Preparado</button>
                  </div>
                ) : null}
                {inspected?.active && (
                  <button className="btn sm" onClick={() => onFile(diffTarget.path, null, project)}>
                    <Icon name="code" size={12} /> Abrir en editor
                  </button>
                )}
              </div>
            )}
          </div>

          {ui.centerTab === 'diff' && (
            <div className="ent-diff-host">
              {diffTarget ? (
                <>
                  <div className="ent-diff-meta">
                    <span className="mono">{diffTarget.path}</span>
                    {commitDiffFile && <span className="chip tiny mono">Commit {commitDiffFile.commit.slice(0, 7)}</span>}
                    {!commitDiffFile && ui.treePerspective === 'branch' && compare && (
                      <span className="chip tiny mono">
                        {compare.mergeBase?.slice(0, 7) ?? compare.baseRef}..{inspected?.shortOid}
                      </span>
                    )}
                    {!commitDiffFile && ui.treePerspective === 'pr' && inspectedPr && (
                      <span className="chip sky tiny">PR #{inspectedPr.number}</span>
                    )}
                    {fileFindings.length > 0 && (
                      <span className="chip amber tiny">{fileFindings.length} hallazgos</span>
                    )}
                  </div>
                  <ReviewDiff
                    project={project}
                    change={diffTarget}
                    diffSpec={diffSpec}
                    findings={fileFindings}
                    finding={focusFinding}
                  />
                </>
              ) : (
                <div className="tr-empty">
                  <Icon name="diff" size={24} />
                  <h3>Sin archivo seleccionado</h3>
                  <p>
                    Elige un archivo en el árbol izquierdo o cambia la perspectiva a <strong>vs base</strong> para inspeccionar todos los cambios de la rama.
                  </p>
                </div>
              )}
            </div>
          )}

          {ui.centerTab === 'commits' && (
            <CommitsView
              project={project}
              inspected={inspected}
              status={status}
              commits={branchLog}
              selectedCommit={ui.selectedCommit}
              onSelectCommit={handleSelectCommit}
              onStage={doStage}
              onUnstage={doUnstage}
              onRefresh={() => {
                void loadLocal();
                void loadPulls();
              }}
            />
          )}

          {ui.centerTab === 'pr' && (
            <PullRequestView
              project={project}
              inspected={inspected}
              defaultBranch={inventory?.defaultBranch ?? 'main'}
              branches={inventory?.branches ?? []}
              prSummary={inspectedPr}
              prDetail={prDetail}
              loading={prLoading}
              onRefresh={() => {
                void loadLocal();
                void loadPulls();
                if (inspectedPr) void loadPrDetail(inspectedPr.number);
              }}
              onInspectPrFiles={() => patchUi({ treePerspective: 'pr', centerTab: 'diff', selectedFile: null })}
              onGoChecks={() => patchUi({ centerTab: 'checks' })}
            />
          )}

          {ui.centerTab === 'checks' && (
            <ChecksView
              project={project}
              headSha={inspected?.headOid ?? status?.headSha ?? null}
              dirtyTree={Boolean(inspected?.active && (status?.changes.length ?? 0) > 0)}
              isActiveBranch={Boolean(inspected?.active)}
              prDetail={prDetail}
              healthRuns={healthRuns}
              onRefresh={() => {
                void loadLocal();
                if (inspectedPr) void loadPrDetail(inspectedPr.number);
              }}
              onInspectLog={(title, log) => {
                setActiveLog({ title, log });
                patchUi({ inspectorOpen: true });
              }}
            />
          )}

          {ui.centerTab === 'audits' && (
            <AuditsView
              project={project}
              headSha={inspected?.headOid ?? status?.headSha ?? null}
              dirtyTree={Boolean(inspected?.active && (status?.changes.length ?? 0) > 0)}
              runs={healthRuns}
              onOpenFinding={(note) => {
                setFocusFinding(note);
                setCommitDiffFile(null);
                patchUi({
                  centerTab: 'diff',
                  selectedFile: note.path ?? ui.selectedFile,
                  inspectorOpen: true,
                });
              }}
              onRefresh={() => void loadLocal()}
            />
          )}

          {ui.centerTab === 'automation' && (
            <AutomationView
              project={project}
              status={autoStatus}
              onRefresh={() => void loadLocal()}
            />
          )}
        </main>

        {/* Inspector contextual condicional: solo existe cuando aporta contexto real */}
        {showInspector && inspectorPayload && (
          <ContextInspector
            payload={inspectorPayload}
            onClose={() => {
              setActiveLog(null);
              patchUi({ inspectorOpen: false });
            }}
          />
        )}
      </div>
    </div>
  );
}
