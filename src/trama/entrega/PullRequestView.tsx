import { useCallback, useEffect, useState } from 'react';
import Pending from '../../Pending';
import {
  cancelReview,
  deliveryAuto,
  githubPr,
  pr as prApi,
  sessions as sessionApi,
  type AutomationStatus,
  type BranchEntry,
  type CleanupOutcome,
  type CleanupPreview,
  type DiffTarget,
  type PullDetail,
  type PullSummary,
  type Review,
  type Session,
} from '../../ipc';
import { Icon } from '../icons';

type Props = {
  mode: 'pr' | 'integracion';
  project: string;
  inspected: BranchEntry | null;
  defaultBranch: string;
  branches: BranchEntry[];
  prSummary: PullSummary | null;
  prDetail: PullDetail | null;
  automation: AutomationStatus | null;
  loading: boolean;
  onRefresh: () => void;
  onInspectPrFiles: () => void;
  onGoChecks: () => void;
  onGoIntegration: () => void;
  onDiff?: (d: DiffTarget) => void;
  onConflicts?: (files: string[]) => void;
};

export function PullRequestView({
  mode,
  project,
  inspected,
  defaultBranch,
  branches,
  prSummary,
  prDetail,
  automation,
  loading,
  onRefresh,
  onInspectPrFiles,
  onGoChecks,
  onGoIntegration,
  onDiff,
  onConflicts,
}: Props) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState(defaultBranch);
  const [draft, setDraft] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');

  const [commentText, setCommentText] = useState('');
  const [replyOpen, setReplyOpen] = useState<number | null>(null);
  const [replyText, setReplyText] = useState('');
  const [reviewerInput, setReviewerInput] = useState('');

  const [mergeMethod, setMergeMethod] = useState<'merge' | 'squash' | 'rebase'>('squash');
  const [pendingReview, setPendingReview] = useState<{ kind: 'create' | 'merge'; review: Review } | null>(null);
  const [confirmCode, setConfirmCode] = useState('');

  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null);
  const [cleanupOutcome, setCleanupOutcome] = useState<CleanupOutcome | null>(null);

  const [orphans, setOrphans] = useState<Session[]>([]);
  const [openOrphan, setOpenOrphan] = useState<number | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setBase(defaultBranch);
    if (inspected && !prSummary) {
      setTitle(inspected.subject || inspected.name);
      setBody('');
    }
    setPendingReview(null);
    setConfirmCode('');
    setCleanupPreview(null);
    setCleanupOutcome(null);
    setEditing(false);
  }, [inspected?.name, defaultBranch, prSummary?.number]);

  useEffect(() => {
    if (!prDetail) return;
    setEditTitle(prDetail.title);
    setEditBody(prDetail.body);
    if (prDetail.mergeSettings.allowSquash) setMergeMethod('squash');
    else if (prDetail.mergeSettings.allowMerge) setMergeMethod('merge');
    else if (prDetail.mergeSettings.allowRebase) setMergeMethod('rebase');
  }, [prDetail?.number, prDetail?.headOid]);

  const loadOrphans = useCallback(() => {
    if (mode !== 'integracion') return;
    sessionApi.orphans(project).then(setOrphans, () => setOrphans([]));
  }, [mode, project]);

  useEffect(() => {
    loadOrphans();
  }, [loadOrphans]);

  const startCreateReview = async () => {
    if (!inspected) return;
    setBusy('create-review');
    setError(null);
    setNotice(null);
    try {
      const review = await githubPr.reviewCreateForBranch(project, inspected.name, base, title, body, draft);
      setPendingReview({ kind: 'create', review });
      setConfirmCode('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmPending = async () => {
    if (!pendingReview) return;
    setBusy('confirm');
    setError(null);
    setNotice(null);
    try {
      const proof = { id: pendingReview.review.id, typed: confirmCode.trim() };
      if (pendingReview.kind === 'create' && inspected) {
        const url = await githubPr.createForBranch(project, inspected.name, base, title, body, draft, proof);
        setNotice(`Pull Request creada: ${url}`);
      } else if (pendingReview.kind === 'merge' && prDetail) {
        await githubPr.merge(project, prDetail.number, mergeMethod, proof);
        setNotice(`PR #${prDetail.number} integrada (${mergeMethod}). Puedes verificar la limpieza post-merge.`);
      }
      setPendingReview(null);
      setConfirmCode('');
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const abortReview = async () => {
    if (!pendingReview) return;
    await cancelReview(pendingReview.review.id).catch(() => {});
    setPendingReview(null);
    setConfirmCode('');
  };

  const saveEdit = async () => {
    if (!prDetail) return;
    setBusy('edit');
    setError(null);
    try {
      await githubPr.update(project, prDetail.number, editTitle, editBody);
      setEditing(false);
      setNotice('Título y descripción actualizados.');
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleDraft = async () => {
    if (!prDetail) return;
    setBusy('draft');
    setError(null);
    try {
      await githubPr.setDraft(project, prDetail.number, !prDetail.isDraft);
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleState = async () => {
    if (!prDetail) return;
    setBusy('state');
    setError(null);
    try {
      await githubPr.setState(project, prDetail.number, prDetail.state === 'OPEN' ? 'close' : 'reopen');
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const postComment = async () => {
    if (!prDetail || !commentText.trim()) return;
    setBusy('comment');
    setError(null);
    try {
      await githubPr.comment(project, prDetail.number, commentText.trim());
      setCommentText('');
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const postReply = async (commentId: number) => {
    if (!prDetail || !replyText.trim()) return;
    setBusy('reply');
    setError(null);
    try {
      await githubPr.replyThread(project, prDetail.number, commentId, replyText.trim());
      setReplyOpen(null);
      setReplyText('');
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const addReviewers = async () => {
    if (!prDetail || !reviewerInput.trim()) return;
    const list = reviewerInput.split(',').map((s) => s.trim()).filter(Boolean);
    setBusy('rev');
    setError(null);
    try {
      await githubPr.requestReviewers(project, prDetail.number, list);
      setReviewerInput('');
      setNotice('Revisión solicitada.');
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const startMergeReview = async () => {
    if (!prDetail) return;
    setBusy('merge-review');
    setError(null);
    try {
      const review = await githubPr.reviewMerge(project, prDetail.number, mergeMethod);
      setPendingReview({ kind: 'merge', review });
      setConfirmCode('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const loadCleanup = async () => {
    if (!prDetail) return;
    setBusy('cleanup-preview');
    setError(null);
    try {
      const prev = await deliveryAuto.cleanupPreview(project, prDetail.number);
      setCleanupPreview(prev);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const runCleanup = async () => {
    if (!prDetail) return;
    setBusy('cleanup-exec');
    setError(null);
    try {
      const out = await deliveryAuto.cleanupExecute(project, prDetail.number);
      setCleanupOutcome(out);
      setCleanupPreview(null);
      setNotice('Limpieza post-merge completada de forma segura.');
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const requestPmAutofix = async () => {
    if (!prDetail) return;
    setBusy('pm-autofix');
    setError(null);
    setNotice(null);
    try {
      const failed = prDetail.checks
        .filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(c.conclusion ?? ''))
        .map((c) => c.name);
      const msg = await deliveryAuto.requestAutofix(
        project,
        prDetail.number,
        prDetail.headOid,
        failed,
        prDetail.reviewDecision,
      );
      setNotice(msg);
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!inspected) {
    return (
      <div className="ent-op-scroll">
        <p className="ent-empty-inline">Selecciona una rama en la columna izquierda.</p>
      </div>
    );
  }

  // ── ETAPA INTEGRACIÓN: Merge explícito + Limpieza segura post-merge + Worktrees cerrados ──
  if (mode === 'integracion') {
    const detail = prDetail;
    const archives = automation?.archives ?? [];
    const chosenOrphan = orphans.find((o) => o.id === openOrphan) ?? null;

    return (
      <div className="ent-op-scroll">
        {error && (
          <div className="tr-error" role="alert">
            <Icon name="warn" size={13} />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="ent-notice">
            <Icon name="check" size={13} />
            <span>{notice}</span>
          </div>
        )}

        <section className="ent-sec">
          <div className="ent-sec-bar">
            <Icon name="merge" size={12} />
            <strong>Integración y merge · <span className="mono">{inspected.name}</span></strong>
            <span className="grow" />
            <span className="ent-inline-tag tone-mint">
              <Icon name="lock" size={10} /> Merge manual
            </span>
          </div>

          {!prSummary ? (
            <p className="ent-empty-inline">
              {inspected.mergedIntoDefault
                ? `La rama ${inspected.name} ya está integrada en ${defaultBranch}.`
                : `No hay Pull Request abierta para ${inspected.name}. Crea una desde la etapa PR antes de integrar.`}
            </p>
          ) : loading && !detail ? (
            <p className="ent-empty-inline">Consultando estado de integración de PR #{prSummary.number}…</p>
          ) : detail && detail.state === 'OPEN' ? (
            <>
              <div className="ent-kv-inline">
                <span>PR <strong className="mono">#{detail.number}</strong> · <code className="mono">{detail.branch} → {detail.base}</code></span>
                <span className={`ent-inline-tag tone-${detail.mergeState === 'CLEAN' ? 'mint' : detail.mergeState === 'DIRTY' ? 'coral' : 'amber'}`}>
                  {detail.mergeState}
                </span>
                {detail.reviewDecision && <span className="ent-inline-tag tone-mut">{detail.reviewDecision}</span>}
              </div>

              {detail.triggersRelease && (
                <div className="ent-warn-banner">
                  <Icon name="warn" size={13} />
                  <span>
                    Integrar en <strong className="mono">{detail.base}</strong> disparará los workflows de CI y publicación automática (<code className="mono">release.yml</code>).
                  </span>
                </div>
              )}

              <div className="ent-row-wrap">
                <select
                  className="in"
                  style={{ maxWidth: 190 }}
                  value={mergeMethod}
                  onChange={(e) => setMergeMethod(e.target.value as 'merge' | 'squash' | 'rebase')}
                >
                  {detail.mergeSettings.allowSquash && <option value="squash">Squash and merge</option>}
                  {detail.mergeSettings.allowMerge && <option value="merge">Create a merge commit</option>}
                  {detail.mergeSettings.allowRebase && <option value="rebase">Rebase and merge</option>}
                </select>
                <button
                  type="button"
                  className="btn sm pearl"
                  disabled={busy !== null || detail.isDraft || !detail.mergeSettings.canPush}
                  onClick={startMergeReview}
                >
                  {busy === 'merge-review' ? 'Verificando…' : 'Preparar integración explícita'}
                </button>
              </div>
              <p className="ent-sec-note">
                El merge exige siempre aprobación humana explícita vinculada al SHA ({detail.headOid.slice(0, 7)}).
              </p>

              {pendingReview?.kind === 'merge' && (
                <div className="ent-confirm-box">
                  <p><strong>Confirmación de merge:</strong> {pendingReview.review.message}</p>
                  <div className="ent-row-wrap">
                    <input
                      className="in mono"
                      style={{ maxWidth: 160 }}
                      value={confirmCode}
                      onChange={(e) => setConfirmCode(e.target.value)}
                      placeholder={`Escribe ${pendingReview.review.code}`}
                    />
                    <button
                      type="button"
                      className="btn sm pearl"
                      disabled={busy !== null || !confirmCode.trim()}
                      onClick={confirmPending}
                    >
                      Confirmar merge
                    </button>
                    <button type="button" className="btn sm ghost" onClick={abortReview}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : detail && detail.state === 'MERGED' ? (
            <>
              <div className="ent-kv-inline">
                <span>PR <strong className="mono">#{detail.number}</strong> integrada en <code className="mono">{detail.base}</code></span>
                <span className="ent-inline-tag tone-mint">MERGED</span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy !== null}
                  onClick={loadCleanup}
                >
                  {busy === 'cleanup-preview' ? 'Verificando…' : 'Comprobar limpieza segura'}
                </button>
              </div>

              {cleanupPreview && (
                <div className="ent-cleanup-box">
                  {cleanupPreview.checks.map((c) => (
                    <div key={c.code} className="ent-check-row">
                      <span className={`ent-inline-tag tone-${c.ok ? 'mint' : 'coral'}`}>
                        {c.ok ? 'OK' : 'BLOQUEO'}
                      </span>
                      <div>
                        <strong>{c.label}</strong>
                        <div className="mut">{c.detail}</div>
                      </div>
                    </div>
                  ))}
                  <div className="ent-cleanup-steps">
                    <div className="ent-sub-lbl">Pasos planificados</div>
                    <ul>
                      {cleanupPreview.plannedSteps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="ent-row-end">
                    <button type="button" className="btn sm ghost" onClick={() => setCleanupPreview(null)}>
                      Cerrar
                    </button>
                    <button
                      type="button"
                      className="btn sm pearl"
                      disabled={!cleanupPreview.canExecute || busy !== null}
                      onClick={runCleanup}
                    >
                      {busy === 'cleanup-exec' ? 'Limpiando…' : 'Ejecutar limpieza verificada'}
                    </button>
                  </div>
                </div>
              )}

              {cleanupOutcome && (
                <div className="ent-notice">
                  <Icon name="check" size={13} />
                  <div>
                    <strong>Archivado #{cleanupOutcome.archivedId}</strong>
                    <div>{cleanupOutcome.executedSteps.join(' · ')}</div>
                    {cleanupOutcome.warnings.length > 0 && (
                      <div className="mut">Avisos: {cleanupOutcome.warnings.join(' · ')}</div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="ent-empty-inline">PR #{prSummary.number} en estado {prSummary.state}.</p>
          )}
        </section>

        {orphans.length > 0 && (
          <section className="ent-sec">
            <div className="ent-sec-bar">
              <Icon name="branch" size={12} />
              <strong>Worktrees de sesiones cerradas</strong>
              <span className="ent-mono-meta mono">{orphans.length}</span>
            </div>
            <div className="ent-list">
              {orphans.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`ent-list-row is-btn${openOrphan === o.id ? ' on' : ''}`}
                  onClick={() => setOpenOrphan(openOrphan === o.id ? null : o.id)}
                >
                  <span className="ent-dot-sm tone-amber" />
                  <span className="ent-list-title mono">{o.branch} → {o.base}</span>
                  <span className="ent-mono-meta">{o.name}</span>
                </button>
              ))}
            </div>
            {chosenOrphan && (
              <div className="legacy ent-legacy-wrap">
                <Pending
                  key={chosenOrphan.id}
                  session={chosenOrphan}
                  closed
                  onDiff={(d) => onDiff?.(d)}
                  onConflicts={(f) => onConflicts?.(f)}
                  onChanged={() => {
                    onRefresh();
                    loadOrphans();
                    setOpenOrphan(null);
                  }}
                />
              </div>
            )}
          </section>
        )}

        {archives.length > 0 && (
          <section className="ent-sec">
            <div className="ent-sec-bar">
              <Icon name="check" size={12} />
              <strong>Ramas limpiadas post-merge</strong>
              <span className="ent-mono-meta mono">{archives.length}</span>
            </div>
            <div className="ent-list">
              {archives.slice(0, 8).map((ar) => (
                <div key={ar.id} className="ent-list-row">
                  <span className="ent-dot-sm tone-mint" />
                  <div className="ent-list-main">
                    <span className="ent-list-title mono">{ar.branch} → {ar.base}</span>
                    {ar.notes && <span className="ent-list-sub">{ar.notes}</span>}
                  </div>
                  {ar.prNumber && <span className="ent-inline-tag tone-mint mono">PR #{ar.prNumber}</span>}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  // ── ETAPA PR: Crear PR o gestionar PR, revisiones y comentarios ──
  if (!prSummary) {
    const baseOptions = [...new Set([defaultBranch, ...branches.filter((b) => b.name !== inspected.name).map((b) => b.name)])];
    return (
      <div className="ent-op-scroll">
        {error && (
          <div className="tr-error" role="alert">
            <Icon name="warn" size={13} />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="ent-notice">
            <Icon name="check" size={13} />
            <span>{notice}</span>
          </div>
        )}

        <section className="ent-sec">
          <div className="ent-sec-bar">
            <Icon name="pr" size={12} />
            <strong>Crear Pull Request · <span className="mono">{inspected.name}</span></strong>
            {inspected.isDefault && <span className="ent-inline-tag tone-amber">Rama base</span>}
          </div>

          {inspected.isDefault ? (
            <p className="ent-empty-inline">
              Selecciona o crea una rama de trabajo distinta de <strong className="mono">{defaultBranch}</strong> para abrir una Pull Request.
            </p>
          ) : (
            <div className="ent-form">
              <div className="ent-form-row">
                <label className="tr-field-row">
                  <span>Destino (base)</span>
                  <select className="in" value={base} onChange={(e) => setBase(e.target.value)}>
                    {baseOptions.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </label>
                <label className="ent-check-inline">
                  <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
                  <span>Abrir como borrador (Draft)</span>
                </label>
              </div>
              <label className="tr-field-row">
                <span>Título</span>
                <input
                  className="in"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Título descriptivo de la PR"
                />
              </label>
              <label className="tr-field-row">
                <span>Descripción</span>
                <textarea
                  className="in"
                  rows={5}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Resumen, decisiones técnicas y verificación realizada…"
                />
              </label>

              {pendingReview?.kind === 'create' ? (
                <div className="ent-confirm-box">
                  <p><strong>Confirmación vinculada al SHA:</strong> {pendingReview.review.message}</p>
                  <div className="ent-row-wrap">
                    <input
                      className="in mono"
                      style={{ maxWidth: 160 }}
                      value={confirmCode}
                      onChange={(e) => setConfirmCode(e.target.value)}
                      placeholder={`Escribe ${pendingReview.review.code}`}
                    />
                    <button
                      type="button"
                      className="btn sm pearl"
                      disabled={busy !== null || !confirmCode.trim()}
                      onClick={confirmPending}
                    >
                      Confirmar y crear PR
                    </button>
                    <button type="button" className="btn sm ghost" onClick={abortReview}>
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="ent-row-end">
                  <span className="ent-sec-note">Publicará el SHA exacto ({inspected.shortOid}) sin cambiar de rama.</span>
                  <button
                    type="button"
                    className="btn sm pearl"
                    disabled={busy !== null || !title.trim()}
                    onClick={startCreateReview}
                  >
                    {busy === 'create-review' ? 'Preparando…' : 'Revisar y crear PR'}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    );
  }

  if (loading && !prDetail) {
    return (
      <div className="ent-op-scroll">
        <p className="ent-empty-inline">Cargando detalle de PR #{prSummary.number}…</p>
      </div>
    );
  }

  const detail = prDetail;

  return (
    <div className="ent-op-scroll">
      {error && (
        <div className="tr-error" role="alert">
          <Icon name="warn" size={13} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="ent-notice">
          <Icon name="check" size={13} />
          <span>{notice}</span>
        </div>
      )}

      <section className="ent-sec">
        <div className="ent-pr-head">
          <div className="ent-pr-title-block">
            <div className="ent-row-wrap">
              <span
                className={`ent-inline-tag tone-${
                  prSummary.state === 'MERGED'
                    ? 'mint'
                    : prSummary.state === 'CLOSED'
                      ? 'coral'
                      : prSummary.isDraft
                        ? 'amber'
                        : 'sky'
                }`}
              >
                {prSummary.isDraft ? 'Borrador' : prSummary.state}
              </span>
              <strong className="mono">#{prSummary.number}</strong>
              <span className="mono mut">{prSummary.branch} → {prSummary.base}</span>
              <span className="mut">@{prSummary.author}</span>
            </div>
            {!editing ? (
              <h3 className="ent-pr-h">{detail?.title ?? prSummary.title}</h3>
            ) : (
              <div className="ent-form">
                <input className="in" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                <textarea className="in" rows={4} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
                <div className="ent-row-end">
                  <button type="button" className="btn sm ghost" onClick={() => setEditing(false)}>Cancelar</button>
                  <button type="button" className="btn sm pearl" disabled={busy !== null} onClick={saveEdit}>
                    Guardar
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="ent-row-wrap">
            <button type="button" className="btn sm" onClick={onInspectPrFiles}>
              <Icon name="diff" size={11} /> Archivos ({detail?.files.length ?? '…'})
            </button>
            <button type="button" className="btn sm" onClick={onGoChecks}>
              <Icon name="signal" size={11} /> CI ({prSummary.checksPassed}✓ {prSummary.checksFailed}✗)
            </button>
            <button type="button" className="btn sm" onClick={onGoIntegration}>
              <Icon name="merge" size={11} /> Integración
            </button>
            {detail && detail.state === 'OPEN' && (detail.checksFailed > 0 || detail.reviewDecision === 'CHANGES_REQUESTED') && (
              <button
                type="button"
                className="btn sm warn"
                disabled={busy !== null}
                onClick={requestPmAutofix}
                title="Enviar fallo sanitizado al Project Manager para delegar diagnóstico y corrección"
              >
                <Icon name="pm" size={11} /> {busy === 'pm-autofix' ? 'Enviando…' : 'Delegar al PM'}
              </button>
            )}
            {detail && detail.state === 'OPEN' && !editing && (
              <button type="button" className="btn sm ghost" onClick={() => setEditing(true)}>
                <Icon name="edit" size={11} /> Editar
              </button>
            )}
            {detail && detail.state === 'OPEN' && (
              <button type="button" className="btn sm ghost" disabled={busy !== null} onClick={toggleDraft}>
                {detail.isDraft ? 'Marcar lista' : 'Borrador'}
              </button>
            )}
            {detail && detail.state !== 'MERGED' && (
              <button type="button" className="btn sm danger" disabled={busy !== null} onClick={toggleState}>
                {detail.state === 'OPEN' ? 'Cerrar' : 'Reabrir'}
              </button>
            )}
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => prApi.open(prSummary.url)}
              title="Abrir en GitHub"
            >
              <Icon name="link" size={11} /> GitHub
            </button>
          </div>
        </div>

        {!editing && detail?.body && <pre className="ent-pr-body">{detail.body}</pre>}

        {detail && detail.localAhead > 0 && (
          <div className="ent-warn-banner">
            <Icon name="warn" size={13} />
            <span>
              La rama local tiene <strong>{detail.localAhead} commits sin subir</strong> respecto a la PR ({detail.headOid.slice(0, 7)}).
            </span>
          </div>
        )}
      </section>

      {detail && (
        <>
          <section className="ent-sec">
            <div className="ent-sec-bar">
              <Icon name="chat" size={12} />
              <strong>Hilos de revisión</strong>
              <span className="ent-mono-meta mono">{detail.reviewThreads.length}</span>
            </div>

            {detail.reviewThreads.length === 0 ? (
              <p className="ent-empty-inline">Sin hilos inline en esta Pull Request.</p>
            ) : (
              detail.reviewThreads.map((t) => {
                const firstDbId = t.comments[0]?.databaseId ?? null;
                return (
                  <div key={t.id} className={`ent-thread${t.isResolved ? ' is-res' : ''}`}>
                    <div className="ent-thread-head">
                      <span className="mono">{t.path}{t.line ? `:${t.line}` : ''}</span>
                      {t.isResolved && <span className="ent-inline-tag tone-mint">Resuelto</span>}
                      {t.isOutdated && <span className="ent-inline-tag tone-mut">Desfasado</span>}
                    </div>
                    {t.comments.map((c) => (
                      <div key={c.id} className="ent-tmsg">
                        <span className="ent-tauth">@{c.author}</span>
                        <span>{c.body}</span>
                      </div>
                    ))}
                    {firstDbId != null && (
                      replyOpen === firstDbId ? (
                        <div className="ent-row-wrap" style={{ marginTop: 4 }}>
                          <input
                            className="in"
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            placeholder="Responder al hilo…"
                          />
                          <button type="button" className="btn sm pearl" disabled={busy !== null} onClick={() => postReply(firstDbId)}>
                            Responder
                          </button>
                          <button type="button" className="btn sm ghost" onClick={() => setReplyOpen(null)}>
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn sm ghost"
                          onClick={() => {
                            setReplyOpen(firstDbId);
                            setReplyText('');
                          }}
                        >
                          Responder
                        </button>
                      )
                    )}
                  </div>
                );
              })
            )}
          </section>

          <section className="ent-sec">
            <div className="ent-sec-bar">
              <Icon name="agent" size={12} />
              <strong>Conversación y revisores</strong>
              <span className="ent-mono-meta">
                {detail.requestedReviewers.length > 0 ? detail.requestedReviewers.join(', ') : 'Sin revisores'}
              </span>
            </div>

            {detail.state === 'OPEN' && (
              <div className="ent-row-wrap">
                <input
                  className="in"
                  value={reviewerInput}
                  onChange={(e) => setReviewerInput(e.target.value)}
                  placeholder="Solicitar revisor (@usuario, …)"
                />
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy !== null || !reviewerInput.trim()}
                  onClick={addReviewers}
                >
                  Solicitar
                </button>
              </div>
            )}

            <div className="ent-comments-list">
              {detail.comments.map((c) => (
                <div key={c.id} className="ent-tmsg">
                  <div className="ent-row-wrap">
                    <span className="ent-tauth">@{c.author}</span>
                    {c.state && <span className="ent-inline-tag tone-mut">{c.state}</span>}
                    <span className="mut mono">{c.createdAt.slice(0, 10)}</span>
                  </div>
                  <p className="ent-cbody">{c.body}</p>
                </div>
              ))}
              {detail.comments.length === 0 && (
                <p className="ent-empty-inline">Sin comentarios generales todavía.</p>
              )}
            </div>

            <div className="ent-row-wrap">
              <input
                className="in"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Añadir comentario en la Pull Request…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void postComment();
                  }
                }}
              />
              <button
                type="button"
                className="btn sm pearl"
                disabled={busy !== null || !commentText.trim()}
                onClick={postComment}
              >
                Comentar
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
