import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { git, type Change, type GitStatus, type LogRow } from './ipc';
import GitGraph, { layoutGraph, parseRefs } from './GitGraph';

const STATUS_COLOR: Record<string, string> = { A: 'var(--add)', U: 'var(--add)', D: 'var(--del)', '!': 'var(--ac)' };
const STATUS_LABEL: Record<string, string> = {
  M: 'modificado',
  A: 'añadido',
  D: 'eliminado',
  R: 'renombrado',
  U: 'sin seguimiento',
  '!': 'en conflicto',
};

type Props = {
  project: string;
  selected: Change | null;
  onDiff: (c: Change) => void;
  onCommits: () => void;
  onPublish: () => void;
  pending: number;
  onPending: () => void;
  /** Selector Git / Contenedores de la columna. */
  header?: ReactNode;
};

/** Control de versiones del proyecto abierto: rama, cambios e historial. */
export default function GitPanel({ project, selected, onDiff, onCommits, onPublish, pending, onPending, header }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(() => {
    const id = ++request.current;
    Promise.all([git.status(project), git.log(project), git.branches(project)]).then(
      ([s, l, b]) => {
        if (id !== request.current) return;
        setStatus(s);
        setLog(l);
        setBranches(b);
        setError(null);
      },
      (e) => id === request.current && setError(String(e)),
    );
  }, [project]);

  useEffect(() => {
    setStatus(null);
    setLog([]);
    setBranches([]);
    refresh();
    let timer: number | undefined;
    const unlisten = listen('project-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 300);
    });
    window.addEventListener('focus', refresh);
    return () => {
      window.clearTimeout(timer);
      unlisten.then((off) => off());
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  const changes = status?.changes ?? [];
  const graph = useMemo(() => layoutGraph(log), [log]);

  // Git rechaza el cambio si se perderían cambios locales; su mensaje se
  // muestra tal cual y el panel sigue en la rama actual.
  const switchTo = (branch: string) => {
    setSwitching(true);
    git
      .switch(project, branch)
      .then(() => setError(null), (e) => setError(String(e)))
      .finally(() => {
        setSwitching(false);
        refresh();
      });
  };

  return (
    <aside className="git" aria-label="Control de versiones">
      <div className="git-top" data-tauri-drag-region />
      {header}
      {error && <div className="git-error">{error}</div>}
      {status && (
        <>
          <div>
            {status.branch && branches.includes(status.branch) ? (
              <select
                className="git-branch"
                aria-label="Rama"
                value={status.branch}
                disabled={switching || branches.length < 2}
                onChange={(e) => switchTo(e.target.value)}
              >
                {branches.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            ) : (
              <div>{status.branch ?? `${status.head ?? 'sin commits'} · separada`}</div>
            )}
            <div className="git-sub">
              {status.upstream ? `→ ${status.upstream}` : 'sin rama remota'}
              {status.ahead > 0 && <span title={`${status.ahead} commits por publicar`}> ↑{status.ahead}</span>}
              {status.behind > 0 && <span title={`${status.behind} commits por traer`}> ↓{status.behind}</span>}
            </div>
          </div>

          <section aria-label="Cambios">
            <div className="git-label">
              <span>cambios</span>
              <span>{changes.length || ''}</span>
            </div>
            {changes.map((c) => (
              <button
                key={c.path}
                className={`git-change${selected?.path === c.path ? ' is-selected' : ''}`}
                onClick={() => onDiff(c)}
                title={c.orig ? `${c.orig} → ${c.path}` : c.path}
              >
                <span style={{ color: STATUS_COLOR[c.status] ?? 'var(--gold)' }} aria-label={STATUS_LABEL[c.status]}>
                  {c.status}
                </span>
                <span className="git-path">{c.path}</span>
                {c.adds != null && <span className="add">+{c.adds}</span>}
                {c.dels != null && <span className="del">−{c.dels}</span>}
              </button>
            ))}
            {changes.length === 0 && <div className="muted">árbol limpio</div>}
          </section>

          {pending > 0 && (
            <button className="git-pending" onClick={onPending} title="sesiones cerradas cuya rama sigue guardada">
              ⎇ {pending} rama{pending === 1 ? '' : 's'} sin integrar
            </button>
          )}

          <button className="git-commits" disabled={changes.length === 0} onClick={onCommits} title="larry propone los commits por unidad funcional">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="6" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.2" fill="none" />
              <path d="M0 6h3.8M8.2 6H12" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            <span>commits</span>
          </button>
          <button className="git-commits" onClick={onPublish} title="git push y pull request en GitHub, con confirmación">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
            <span>publicar rama</span>
          </button>

          <section className="git-log" aria-label="Historial">
            <div className="git-log-body">
              <GitGraph graph={graph} rows={log.length} />
              {log.map((r, i) => (
                <div className="git-row" key={i}>
                  <span className="git-graph" style={{ width: graph.width }} aria-hidden="true" />
                  {r.hash && <span className="git-hash">{r.hash}</span>}
                  {r.hash && (
                    <span className="git-subject" title={r.subject}>
                      {parseRefs(r.refs).map((ref) => (
                        <span key={ref.name} className={`git-ref is-${ref.kind}`}>{ref.name}</span>
                      ))}
                      {r.subject}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </aside>
  );
}
