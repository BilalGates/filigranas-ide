import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelReview, pr, type PrDraft, type PrInfo, type Proof, type Review } from './ipc';
import ApprovalForm from './ApprovalForm';

type Props = { project: string; session: number | null; hidden: boolean; workClosure?: boolean };

export const CHECK_STATE = { success: 'correctos', pending: 'pendientes', failure: 'fallidos', unknown: 'desconocidos' };
const REVIEW: Record<string, string> = { APPROVED: 'aprobada', REVIEW_REQUIRED: 'pendiente', CHANGES_REQUESTED: 'cambios solicitados' };

export default function Publish({ project, session, hidden, workClosure = false }: Props) {
  const [draft, setDraft] = useState<PrDraft | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [asDraft, setAsDraft] = useState(true);
  const [method, setMethod] = useState('merge');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [info, setInfo] = useState<PrInfo | null>(null);
  const [published, setPublished] = useState(false);
  const [confirm, setConfirm] = useState<{ review: Review; action: string; run: (proof: Proof) => Promise<PrInfo> } | null>(null);
  const sequence = useRef(0);
  const approval = useRef<string | null>(null);
  const suspended = useRef(hidden);
  suspended.current = hidden;

  const discardApproval = useCallback(() => {
    const id = approval.current;
    approval.current = null;
    if (id) void cancelReview(id).catch(() => {});
  }, []);

  useEffect(() => {
    if (!hidden) return;
    discardApproval();
    setConfirm(null);
  }, [hidden, discardApproval]);

  const load = useCallback(async (base: string | null) => {
    const request = ++sequence.current;
    setError(null);
    setConfirm(null);
    setBusy(true);
    try {
      const d = await pr.draft(project, session, workClosure ? 'main' : base);
      if (request !== sequence.current) return;
      setDraft(d);
      setTitle(d.title);
      setBody(d.body);
      setInfo(d.existing);
      setRemoteError(d.remoteError);
      setPublished(false);
    } catch (error) {
      if (request === sequence.current) setError(String(error));
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }, [project, session, workClosure]);

  useEffect(() => {
    void load(null);
    return () => {
      ++sequence.current;
      discardApproval();
    };
  }, [load, discardApproval]);

  const number = info?.number;
  const refresh = useCallback(async () => {
    if (number == null) return;
    const request = sequence.current;
    try {
      const next = await pr.status(project, session, number);
      if (request !== sequence.current) return;
      setInfo(next);
      setRemoteError(null);
    } catch (error) {
      if (request === sequence.current) setRemoteError(String(error));
    }
  }, [number, project, session]);

  const open = info?.state === 'OPEN';
  useEffect(() => {
    if (!open || hidden || busy) return;
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
  }, [open, hidden, busy, refresh]);

  const prepare = async (action: string, review: Promise<Review>, run: (proof: Proof) => Promise<PrInfo>) => {
    const request = sequence.current;
    setBusy(true);
    setError(null);
    try {
      const prepared = await review;
      if (request !== sequence.current || suspended.current) {
        await cancelReview(prepared.id);
        return;
      }
      approval.current = prepared.id;
      setConfirm({ review: prepared, action, run });
    } catch (error) {
      if (request === sequence.current) setError(String(error));
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  };

  const mutate = async (run: () => Promise<PrInfo>) => {
    ++sequence.current;
    approval.current = null;
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      setInfo(result);
      setRemoteError(null);
      setPublished(true);
    } catch (error) {
      const message = String(error);
      if (!['publicación cancelada', 'merge cancelado'].includes(message)) setError(message);
    } finally {
      setBusy(false);
    }
  };

  const eligible = !!(info && !remoteError && draft?.head === info.head && info.state === 'OPEN'
    && !info.isDraft && info.mergeState === 'CLEAN' && (!info.review || info.review === 'APPROVED')
    && info.checksKnown && !info.checks[1] && !info.checks[2]);

  return (
    <section className="coach publish" aria-label="Publicar" hidden={hidden}>
      <div className="co-head">
        {draft?.taskId != null && <span>tarea #{draft.taskId}</span>}
        <span className="muted">{draft ? `${draft.branch} → ${draft.base || '…'}` : 'cargando…'}</span>
      </div>
      <div className="co-log">
        {remoteError && <div className="co-error" role="status">Estado remoto sin actualizar. {remoteError}</div>}
        {info && <div className="co-msg">
          <div className="co-by">PR #{info.number} · {info.state.toLowerCase()}{info.isDraft ? ' · borrador' : ''}</div>
          <button className="co-link" onClick={() => pr.open(info.url).catch((e) => setError(String(e)))}>{info.url}</button>
          <div>CI de GitHub · {CHECK_STATE[info.checksState]} · {info.checks.join(' / ')} correctos / fallidos / pendientes</div>
          <div>Revisión · {info.review ? REVIEW[info.review] ?? info.review : 'sin decisión'} · Merge · {info.mergeState}</div>
          <button className="co-btn" disabled={busy} onClick={() => void refresh()}>actualizar estado</button>
        </div>}
        {draft?.previous && !published && <div className="co-aside">
          PR anterior · <button className="co-link" onClick={() => pr.open(draft.previous!.url).catch((e) => setError(String(e)))}>
            #{draft.previous.number}
          </button> · {draft.previous.state.toLowerCase()}
        </div>}
        {draft && <>
          <div className="muted">Diff local de Larry para {draft.head.slice(0, 12)} · {draft.larryChecked ? 'comprobado' : 'sin registro'}</div>
          {draft.blocked && <div className="co-error">{draft.blocked}</div>}
          {draft.dirty && <div className="co-aside">Hay cambios sin commit que quedan fuera de la PR.</div>}
          {!published && <>
            <label className="pub-field">
              <span className="muted">base</span>
              <select value={draft.base} disabled={busy || !!confirm || workClosure || draft.workSession != null} onChange={(e) => void load(e.target.value)}>
                {draft.bases.map((base) => <option key={base} value={base}>{base}</option>)}
              </select>
            </label>
            {draft.commits.length > 0 && <pre className="co-code">{draft.commits.join('\n')}</pre>}
            {!info && <>
              <label className="pub-field"><span className="muted">título</span><input value={title} disabled={busy || !!confirm} onChange={(e) => setTitle(e.target.value)} /></label>
              <label className="pub-field"><span className="muted">descripción</span><textarea value={body} disabled={busy} rows={10} onChange={(e) => setBody(e.target.value)} /></label>
              <label className="pub-check"><input type="checkbox" checked={asDraft} disabled={busy || !!confirm} onChange={(e) => setAsDraft(e.target.checked)} /> abrir como borrador</label>
            </>}
          </>}
        </>}
        {error && <div className="co-error" role="alert">{error}</div>}
      </div>
      <div className="co-compose co-compose-bar">
        {confirm && <ApprovalForm key={confirm.review.id} review={confirm.review} action={confirm.action}
          onClose={() => { approval.current = null; setConfirm(null); }} onConfirm={(proof) => void mutate(() => confirm.run(proof))} />}
        {!confirm && !published && draft && <button className="co-btn is-primary" disabled={busy || !!draft.blocked || (!info && !title.trim())}
          onClick={() => void prepare('confirmar publicación', pr.reviewPublish(project, session, draft, title, body, asDraft),
            (proof) => pr.publish(project, session, draft, title, body, asDraft, proof))}>
          {workClosure || draft.workSession != null ? 'publicar PR y finalizar sesión' : info ? 'publicar commits' : 'publicar y abrir PR'}
        </button>}
        {!confirm && info?.state === 'OPEN' && <>
          <select className="chip-select" aria-label="Método de merge" value={method} disabled={busy || !eligible} onChange={(e) => setMethod(e.target.value)}>
            <option value="merge">merge</option><option value="squash">squash</option><option value="rebase">rebase</option>
          </select>
          <button className="co-btn" disabled={busy || !eligible} onClick={() => void prepare('confirmar merge', pr.reviewMerge(project, session, info, method),
            (proof) => pr.merge(project, session, info, method, proof))}>fusionar PR</button>
        </>}
      </div>
    </section>
  );
}
