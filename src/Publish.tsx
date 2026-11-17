import { useCallback, useEffect, useState } from 'react';
import { pr, type PrDraft, type PrInfo } from './ipc';

type Props = { project: string; session: number | null; hidden: boolean };

function Checks({ info }: { info: PrInfo }) {
  const [ok, failed, pending] = info.checks;
  if (!ok && !failed && !pending) return <span className="muted">sin checks</span>;
  return (
    <span>
      {ok > 0 && <span className="add">✓ {ok} </span>}
      {failed > 0 && <span className="del">✗ {failed} </span>}
      {pending > 0 && <span className="muted">… {pending}</span>}
    </span>
  );
}

/**
 * Publicar la rama y abrir la PR en GitHub. Título y descripción salen de
 * los commits y se editan antes; nada se publica sin pulsar el botón.
 */
export default function Publish({ project, session, hidden }: Props) {
  const [draft, setDraft] = useState<PrDraft | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [asDraft, setAsDraft] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<PrInfo | null>(null);

  const load = useCallback(
    (wanted: string | null) => {
      setError(null);
      pr.draft(project, session, wanted).then(
        (d) => {
          setDraft(d);
          setBase(d.base);
          setTitle(d.title);
          setBody(d.body);
        },
        (e) => setError(String(e)),
      );
    },
    [project, session],
  );

  useEffect(() => load(null), [load]);

  const publish = () => {
    if (!draft || !base) return;
    setBusy(true);
    setError(null);
    pr.publish(project, session, base, title, body, asDraft)
      .then(setPublished, (e) => setError(String(e)))
      .finally(() => {
        setBusy(false);
        setConfirm(false);
      });
  };

  // Estado refrescado de la PR (checks), sin cambiar el modo de la vista.
  const [live, setLive] = useState<PrInfo | null>(null);
  const info = live ?? published ?? draft?.existing ?? null;

  // Checks pendientes: refrescar mientras la pestaña esté a la vista.
  const pendingChecks = !!info && info.checks[2] > 0;
  useEffect(() => {
    if (!pendingChecks || hidden) return;
    const timer = window.setInterval(() => {
      pr.status(project, session).then((now) => now && setLive(now), () => {});
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [pendingChecks, hidden, project, session]);

  return (
    <section className="coach publish" aria-label="Publicar" hidden={hidden}>
      <div className="co-head">
        <span>publicar</span>
        <span className="muted">{draft ? `${draft.branch} → ${base ?? '…'}` : 'cargando…'}</span>
      </div>
      <div className="co-log">
        {info && (
          <div className="co-msg">
            <div className="co-by">pull request {info.isDraft ? '(borrador)' : ''} · {info.state.toLowerCase()}</div>
            <button className="co-link" onClick={() => pr.open(info.url).catch((e) => setError(String(e)))}>
              {info.url}
            </button>{' '}
            <Checks info={info} />
          </div>
        )}
        {draft?.previous && !published && (
          <div className="co-aside">
            La PR anterior de esta rama está {draft.previous.state === 'MERGED' ? 'fusionada' : 'cerrada'} (
            <button className="co-link" onClick={() => pr.open(draft.previous!.url).catch((e) => setError(String(e)))}>
              {draft.previous.url}
            </button>
            ). Publicar abrirá una PR nueva con los commits posteriores.
          </div>
        )}
        {draft && !published && (
          <>
            {draft.blocked && <div className="co-error">{draft.blocked}</div>}
            {draft.dirty && <div className="co-aside">Hay cambios sin commit: no viajan en la PR. Pídele a Larry los commits antes si deben ir.</div>}
            <label className="pub-field">
              <span className="muted">base</span>
              <select value={base ?? ''} onChange={(e) => load(e.target.value)}>
                {draft.bases.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            {draft.commits.length > 0 && <pre className="co-code">{draft.commits.join('\n')}</pre>}
            {!draft.existing && (
              <>
                <label className="pub-field">
                  <span className="muted">título</span>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label className="pub-field">
                  <span className="muted">descripción</span>
                  <textarea value={body} rows={10} onChange={(e) => setBody(e.target.value)} />
                </label>
                <label className="pub-check">
                  <input type="checkbox" checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} /> abrir como borrador
                </label>
              </>
            )}
          </>
        )}
        {error && <div className="co-error">{error}</div>}
      </div>
      <div className="co-compose co-compose-bar">
        <span className="muted">
          {confirm
            ? `se hará git push de ${draft?.branch} a origin${draft?.existing ? '' : ` y se abrirá la PR hacia ${base}`}. El merge sigue siendo tuyo.`
            : 'nada se publica hasta que confirmes'}
        </span>
        {published ? null : confirm ? (
          <span className="co-actions">
            <button className="co-btn" onClick={() => setConfirm(false)} disabled={busy}>
              cancelar
            </button>
            <button className="co-btn is-primary" onClick={publish} disabled={busy}>
              {busy ? 'publicando…' : 'confirmar'}
            </button>
          </span>
        ) : (
          <button className="co-btn is-primary" onClick={() => setConfirm(true)} disabled={!draft || !!draft.blocked || !title.trim()}>
            {draft?.existing ? 'publicar commits' : 'publicar y abrir PR'}
          </button>
        )}
      </div>
    </section>
  );
}
