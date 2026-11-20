import { useCallback, useEffect, useRef, useState } from 'react';
import { larry, type DiffTarget, type LarryCommit, type LarryOutcome, type LarryPlan, type Session } from './ipc';

type Props = { project: string; session: Session | null; onDiff: (c: DiffTarget) => void; onDone: () => void };

/**
 * Larry: propone los commits del proyecto por unidad funcional. El usuario
 * revisa y edita los mensajes; los commits se crean en local con rutas
 * explícitas. Sin push: publicar es otra acción.
 */
export default function Larry({ project, session, onDiff, onDone }: Props) {
  const sid = session?.id ?? null;
  const [plan, setPlan] = useState<LarryPlan | null>(null);
  const [commits, setCommits] = useState<LarryCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [script, setScript] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<LarryOutcome | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Cada petición tiene su número; una respuesta tardía de otra se ignora.
  const request = useRef(0);

  const show = (id: number) => ({
    ok: (p: LarryPlan) => {
      if (id !== request.current) return;
      setPlan(p);
      setCommits(p.commits);
      setLoading(false);
    },
    fail: (e: unknown) => {
      if (id !== request.current) return;
      setError(String(e));
      setPlan(null);
      setLoading(false);
    },
  });

  const propose = useCallback(() => {
    const id = ++request.current;
    setLoading(true);
    setScript(false);
    setError(null);
    setOutcome(null);
    const { ok, fail } = show(id);
    larry.propose(project, sid).then(ok, fail);
  }, [project, sid]);

  /** No esperar al modelo: grupos del script al instante. */
  const useScript = () => {
    const id = ++request.current;
    setLoading(true);
    setScript(true);
    setError(null);
    setOutcome(null);
    const { ok, fail } = show(id);
    larry.groups(project, sid).then(ok, fail);
  };

  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [loading]);


  const create = () => {
    setBusy(true);
    setError(null);
    larry
      .commit(project, sid, commits)
      .then(setOutcome, (e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const edit = (i: number, message: string) => setCommits((list) => list.map((c, j) => (j === i ? { ...c, message } : c)));
  const ready = commits.length > 0 && commits.every((c) => c.message.trim() && !c.message.includes('describe el cambio'));

  return (
    <section className="coach larry" aria-label="Larry">
      <div className="co-head">
        <span className="muted">commits por unidad funcional{plan ? ` · ${plan.branch}` : ''}{session ? ` · carpeta de ${session.name}` : ''}</span>
        <span className="push" />
        <button className="co-link" onClick={propose} disabled={loading || busy}>
          {plan || outcome || error ? 'Volver a proponer' : 'Proponer commits'}
        </button>
        <button className="co-link" onClick={useScript} disabled={busy || (loading && script)}>
          Usar grupos del script
        </button>
      </div>
      <div className="co-log">
        {loading && (
          <div className="co-error-row muted">
            {script ? 'Agrupando cambios…' : 'Larry está agrupando los cambios…'} {elapsed} s
          </div>
        )}
        {!loading && !plan && !error && <p className="muted">Agrupa los cambios para revisar los archivos y los mensajes de cada commit.</p>}
        {plan?.notes && <div className={plan.notes.includes('no pudo') ? 'co-error' : 'co-aside'}>{plan.notes}</div>}
        {!outcome &&
          commits.map((c, i) => (
            <div className="larry-commit" key={i}>
              <textarea
                aria-label={`Mensaje del commit ${i + 1}`}
                value={c.message}
                rows={Math.min(4, c.message.split('\n').length)}
                onChange={(e) => edit(i, e.target.value)}
              />
              <div className="larry-files">
                {c.files.map((f) => (
                  <button key={f} className="co-file" onClick={() => onDiff({ path: f, orig: null, status: 'M', adds: null, dels: null, ...(session ? { session: session.id, label: `${session.branch} frente a ${session.base}` } : {}) })} title="ver diff">
                    {f}
                  </button>
                ))}
              </div>
            </div>
          ))}
        {outcome && (
          <div className="co-msg">
            {outcome.created.length > 0 && (
              <>
                <div className="co-by">commits creados</div>
                <pre className="co-code">{outcome.created.join('\n')}</pre>
              </>
            )}
            {outcome.stopped ? <div className="co-error">Larry se detuvo: {outcome.stopped}</div> : <div className="co-notice">Commits creados en la rama local.</div>}
          </div>
        )}
        {error && <div className="co-error">{error}</div>}
      </div>
      <div className="co-compose co-compose-bar">
        <span className="muted">{commits.length ? `${commits.length} commit${commits.length === 1 ? '' : 's'} · rutas explícitas · hooks activos` : ''}</span>
        {outcome ? (
          <button className="co-btn" onClick={onDone}>
            cerrar
          </button>
        ) : (
          <button className="co-btn is-primary" onClick={create} disabled={!ready || busy || loading} title={ready ? undefined : 'completa los mensajes'}>
            {busy ? 'creando…' : `crear ${commits.length} commit${commits.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </section>
  );
}
