import { useEffect, useState } from 'react';
import {
  cancelReview,
  deliveryAuto,
  githubPr,
  pr as prApi,
  type BranchEntry,
  type CleanupOutcome,
  type CleanupPreview,
  type PullDetail,
  type PullSummary,
  type Review,
} from '../../ipc';
import { Icon } from '../icons';

type Props = {
  project: string;
  inspected: BranchEntry | null;
  defaultBranch: string;
  branches: BranchEntry[];
  prSummary: PullSummary | null;
  prDetail: PullDetail | null;
  loading: boolean;
  onRefresh: () => void;
  onInspectPrFiles: () => void;
  onGoChecks: () => void;
};

export function PullRequestView({
  project,
  inspected,
  defaultBranch,
  branches,
  prSummary,
  prDetail,
  loading,
  onRefresh,
  onInspectPrFiles,
  onGoChecks,
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
        setNotice(`PR #${prDetail.number} integrada (${mergeMethod}). Puedes revisar la limpieza post-merge.`);
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
    return <div className="ent-view"><p className="ent-empty-mini">Selecciona una rama en el explorador izquierdo.</p></div>;
  }

  // Caso 1: La rama inspeccionada todavía no tiene Pull Request
  if (!prSummary) {
    const baseOptions = [...new Set([defaultBranch, ...branches.filter((b) => b.name !== inspected.name).map((b) => b.name)])];
    return (
      <div className="ent-view">
        {error && <div className="tr-error" role="alert"><Icon name="warn" size={14} /><span>{error}</span></div>}
        {notice && <div className="ent-notice"><Icon name="check" size={14} /><span>{notice}</span></div>}

        <section className="ent-card">
          <div className="ent-card-head">
            <strong><Icon name="pr" size={14} /> Crear Pull Request para <span className="mono">{inspected.name}</span></strong>
            {inspected.isDefault && <span className="chip amber tiny">Rama base del repositorio</span>}
          </div>

          {inspected.isDefault ? (
            <p className="mut">Crea o selecciona una rama de trabajo distinta de <strong className="mono">{defaultBranch}</strong> para abrir una Pull Request.</p>
          ) : (
            <div className="ent-form">
              <div className="ent-form-row">
                <label className="tr-field-row">
                  <span>Rama destino (base)</span>
                  <select className="in" value={base} onChange={(e) => setBase(e.target.value)}>
                    {baseOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </label>
                <label className="ent-check-inline">
                  <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
                  <span>Abrir como borrador (Draft)</span>
                </label>
              </div>
              <label className="tr-field-row">
                <span>Título</span>
                <input className="in" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título descriptivo de la PR" />
              </label>
              <label className="tr-field-row">
                <span>Descripción</span>
                <textarea className="in" rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Resumen, decisiones técnicas y verificación realizada…" />
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
                    <button className="btn sm pearl" disabled={busy !== null || !confirmCode.trim()} onClick={confirmPending}>
                      Confirmar y crear PR
                    </button>
                    <button className="btn sm ghost" onClick={abortReview}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <div className="ent-row-end">
                  <span className="mut">Publicará el SHA exacto ({inspected.shortOid}) sin hacer checkout.</span>
                  <button className="btn sm pearl" disabled={busy !== null || !title.trim()} onClick={startCreateReview}>
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
    return <div className="ent-view"><p className="ent-empty-mini">Cargando detalle completo de PR #{prSummary.number}…</p></div>;
  }

  const detail = prDetail;

  return (
    <div className="ent-view">
      {error && <div className="tr-error" role="alert"><Icon name="warn" size={14} /><span>{error}</span></div>}
      {notice && <div className="ent-notice"><Icon name="check" size={14} /><span>{notice}</span></div>}

      <section className="ent-card">
        <div className="ent-pr-head">
          <div className="ent-pr-title-block">
            <div className="ent-row-wrap">
              <span className={`chip ${prSummary.state === 'MERGED' ? 'mint' : prSummary.state === 'CLOSED' ? 'coral' : prSummary.isDraft ? 'amber' : 'sky'}`}>
                {prSummary.isDraft ? 'Borrador' : prSummary.state}
              </span>
              <strong className="mono">#{prSummary.number}</strong>
              <span className="mono mut">{prSummary.branch} → {prSummary.base}</span>
              <span className="mut">por @{prSummary.author}</span>
            </div>
            {!editing ? (
              <h3 className="ent-pr-h">{detail?.title ?? prSummary.title}</h3>
            ) : (
              <div className="ent-form">
                <input className="in" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                <textarea className="in" rows={4} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
                <div className="ent-row-end">
                  <button className="btn sm ghost" onClick={() => setEditing(false)}>Cancelar</button>
                  <button className="btn sm pearl" disabled={busy !== null} onClick={saveEdit}>Guardar cambios</button>
                </div>
              </div>
            )}
          </div>
          <div className="ent-row-wrap">
            <button className="btn sm" onClick={onInspectPrFiles}>
              <Icon name="diff" size={12} /> Archivos ({detail?.files.length ?? '…'})
            </button>
            <button className="btn sm" onClick={onGoChecks}>
              <Icon name="health" size={12} /> CI ({prSummary.checksPassed}✓ {prSummary.checksFailed}✗)
            </button>
            {detail && detail.state === 'OPEN' && (detail.checksFailed > 0 || detail.reviewDecision === 'CHANGES_REQUESTED') && (
              <button
                className="btn sm warn"
                disabled={busy !== null}
                onClick={requestPmAutofix}
                title="Enviar fallo sanitizado al Project Manager para delegar diagnóstico y corrección en agentes"
              >
                <Icon name="pm" size={12} /> {busy === 'pm-autofix' ? 'Enviando al PM…' : 'Delegar corrección al PM'}
              </button>
            )}
            {detail && detail.state === 'OPEN' && !editing && (
              <button className="btn sm" onClick={() => setEditing(true)}><Icon name="edit" size={12} /> Editar</button>
            )}
            {detail && detail.state === 'OPEN' && (
              <button className="btn sm" disabled={busy !== null} onClick={toggleDraft}>
                {detail.isDraft ? 'Marcar lista' : 'Pasar a borrador'}
              </button>
            )}
            {detail && detail.state !== 'MERGED' && (
              <button className="btn sm danger" disabled={busy !== null} onClick={toggleState}>
                {detail.state === 'OPEN' ? 'Cerrar PR' : 'Reabrir PR'}
              </button>
            )}
            <button className="btn sm ghost" onClick={() => prApi.open(prSummary.url)} title="Abrir en GitHub">
              <Icon name="link" size={12} /> GitHub
            </button>
          </div>
        </div>

        {!editing && detail?.body && <pre className="ent-pr-body">{detail.body}</pre>}

        {detail && detail.localAhead > 0 && (
          <div className="ent-warn-banner">
            <Icon name="warn" size={14} />
            <span>
              La rama local tiene <strong>{detail.localAhead} commits sin subir</strong> respecto al HEAD de la PR ({detail.headOid.slice(0, 7)}).
              Los archivos de la PR en GitHub se mantienen separados de tus cambios locales.
            </span>
          </div>
        )}
      </section>

      {/* Bloque de Integración / Merge o Limpieza post-merge */}
      {detail && detail.state === 'OPEN' && (
        <section className="ent-card">
          <div className="ent-card-head">
            <strong><Icon name="merge" size={13} /> Integración (Merge)</strong>
            <div className="ent-row-wrap">
              <span className={`chip tiny ${detail.mergeState === 'CLEAN' ? 'mint' : detail.mergeState === 'DIRTY' ? 'coral' : 'amber'}`}>
                {detail.mergeState}
              </span>
              {detail.reviewDecision && <span className="chip tiny">{detail.reviewDecision}</span>}
            </div>
          </div>

          {detail.triggersRelease && (
            <div className="ent-warn-banner">
              <Icon name="warn" size={14} />
              <span>
                Atención: integrar en <strong className="mono">{detail.base}</strong> disparará los workflows de CI y publicación automática (<code className="mono">release.yml</code>).
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
              className="btn sm pearl"
              disabled={busy !== null || detail.isDraft || !detail.mergeSettings.canPush}
              onClick={startMergeReview}
            >
              {busy === 'merge-review' ? 'Verificando…' : 'Preparar integración explícita'}
            </button>
            <span className="mut">El merge requiere siempre aprobación humana explícita vinculada al SHA.</span>
          </div>

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
                <button className="btn sm pearl" disabled={busy !== null || !confirmCode.trim()} onClick={confirmPending}>
                  Confirmar merge
                </button>
                <button className="btn sm ghost" onClick={abortReview}>Cancelar</button>
              </div>
            </div>
          )}
        </section>
      )}

      {detail && detail.state === 'MERGED' && (
        <section className="ent-card">
          <div className="ent-card-head">
            <strong><Icon name="check" size={13} /> Limpieza automática segura post-merge</strong>
            <button className="btn sm" disabled={busy !== null} onClick={loadCleanup}>
              {busy === 'cleanup-preview' ? 'Verificando…' : 'Comprobar limpieza segura'}
            </button>
          </div>
          {cleanupPreview && (
            <div className="ent-cleanup-box">
              {cleanupPreview.checks.map((c) => (
                <div key={c.code} className="ent-check-row">
                  <span className={`chip tiny ${c.ok ? 'mint' : 'coral'}`}>{c.ok ? 'OK' : 'BLOQUEO'}</span>
                  <div>
                    <strong>{c.label}</strong>
                    <div className="mut">{c.detail}</div>
                  </div>
                </div>
              ))}
              <div className="ent-cleanup-steps">
                <div className="lab">Pasos planificados</div>
                <ul>{cleanupPreview.plannedSteps.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
              <div className="ent-row-end">
                <button className="btn sm ghost" onClick={() => setCleanupPreview(null)}>Cerrar</button>
                <button
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
              <Icon name="check" size={14} />
              <div>
                <strong>Archivado #{cleanupOutcome.archivedId}</strong>
                <div>{cleanupOutcome.executedSteps.join(' · ')}</div>
                {cleanupOutcome.warnings.length > 0 && <div className="mut">Avisos: {cleanupOutcome.warnings.join(' · ')}</div>}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Revisores + Hilos inline + Conversación */}
      {detail && (
        <div className="ent-grid2">
          <section className="ent-card">
            <div className="ent-card-head">
              <strong>Hilos de revisión ({detail.reviewThreads.length})</strong>
              <span className="mut">Comentarios en archivos</span>
            </div>
            {detail.reviewThreads.length === 0 ? (
              <p className="ent-empty-mini">Sin hilos inline en esta PR.</p>
            ) : (
              detail.reviewThreads.map((t) => {
                const firstDbId = t.comments[0]?.databaseId ?? null;
                return (
                  <div key={t.id} className={`ent-thread${t.isResolved ? ' is-res' : ''}`}>
                    <div className="ent-thread-head">
                      <span className="mono">{t.path}{t.line ? `:${t.line}` : ''}</span>
                      {t.isResolved && <span className="chip mint tiny">Resuelto</span>}
                      {t.isOutdated && <span className="chip tiny">Desfasado</span>}
                    </div>
                    {t.comments.map((c) => (
                      <div key={c.id} className="ent-tmsg">
                        <span className="ent-tauth">@{c.author}</span>
                        <span>{c.body}</span>
                      </div>
                    ))}
                    {firstDbId != null && (
                      replyOpen === firstDbId ? (
                        <div className="ent-row-wrap" style={{ marginTop: 6 }}>
                          <input className="in" value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Responder al hilo…" />
                          <button className="btn sm pearl" disabled={busy !== null} onClick={() => postReply(firstDbId)}>Responder</button>
                          <button className="btn sm ghost" onClick={() => setReplyOpen(null)}>Cancelar</button>
                        </div>
                      ) : (
                        <button className="btn sm ghost" onClick={() => { setReplyOpen(firstDbId); setReplyText(''); }}>
                          Responder hilo
                        </button>
                      )
                    )}
                  </div>
                );
              })
            )}
          </section>

          <section className="ent-card">
            <div className="ent-card-head">
              <strong>Conversación y revisores</strong>
              <span className="mut">{detail.requestedReviewers.length > 0 ? `Revisores: ${detail.requestedReviewers.join(', ')}` : 'Sin revisores'}</span>
            </div>

            {detail.state === 'OPEN' && (
              <div className="ent-row-wrap">
                <input
                  className="in"
                  value={reviewerInput}
                  onChange={(e) => setReviewerInput(e.target.value)}
                  placeholder="Solicitar revisor (@usuario, …)"
                />
                <button className="btn sm" disabled={busy !== null || !reviewerInput.trim()} onClick={addReviewers}>
                  Solicitar
                </button>
              </div>
            )}

            <div className="ent-comments-list">
              {detail.comments.map((c) => (
                <div key={c.id} className="ent-tmsg">
                  <div className="ent-row-wrap">
                    <span className="ent-tauth">@{c.author}</span>
                    {c.state && <span className="chip tiny">{c.state}</span>}
                    <span className="mut mono">{c.createdAt.slice(0, 10)}</span>
                  </div>
                  <p className="ent-cbody">{c.body}</p>
                </div>
              ))}
              {detail.comments.length === 0 && <p className="ent-empty-mini">Sin comentarios generales todavía.</p>}
            </div>

            <div className="ent-row-wrap">
              <input
                className="in"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Añadir comentario en la Pull Request…"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void postComment(); } }}
              />
              <button className="btn sm pearl" disabled={busy !== null || !commentText.trim()} onClick={postComment}>
                Comentar
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
