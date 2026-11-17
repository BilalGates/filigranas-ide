import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { git, gitOps, larry, type Change, type GitStatus, type LarryCommit, type LarryPlan, type LogRow, type Stash } from './ipc';
import Splitter, { SIZES } from './Splitter';
import Usage from './Usage';
import GitGraph, { layoutGraph, parseRefs } from './GitGraph';

const STATUS_COLOR: Record<string, string> = { A: 'var(--ok)', U: 'var(--ok)', D: 'var(--err)', '!': 'var(--err)' };
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
  onPublish: () => void;
  pending: number;
  onPending: () => void;
  /** Selector Git / Contenedores de la columna. */
  header?: ReactNode;
};

/** Control de versiones del proyecto abierto: rama, cambios e historial. */
// Iconos de 16 px, trazo fino, en la misma familia.
const ICON: Record<string, JSX.Element> = {
  commit: <><circle cx="8" cy="8" r="2.6" /><path d="M1 8h4.4M10.6 8H15" /></>,
  fetch: <><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 2.5v3h-3" /></>,
  pull: <><path d="M8 2v9M4.5 7.5 8 11l3.5-3.5" /><path d="M3 14h10" /></>,
  push: <><path d="M8 13V4M4.5 7.5 8 4l3.5 3.5" /><path d="M3 2h10" /></>,
  stash: <><path d="M2.5 9.5v4h11v-4" /><path d="M8 2v8M5 7l3 3 3-3" /></>,
  pop: <><path d="M2.5 9.5v4h11v-4" /><path d="M8 10V2M5 5l3-3 3 3" /></>,
  undo: <><path d="M5 4 2 7l3 3" /><path d="M2 7h7.5a4 4 0 0 1 0 8H7" /></>,
  pr: <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="12.5" r="1.6" /><path d="M4 5.1v5.8M12 10.9V7a2.5 2.5 0 0 0-2.5-2.5H7M8.5 3 7 4.5 8.5 6" /></>,
};

function Icon({ name }: { name: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON[name]}
    </svg>
  );
}

type Draft = { loading: boolean; plan: LarryPlan | null; commits: LarryCommit[]; error: string | null; busy: boolean };

export default function GitPanel({ project, selected, onDiff, onPublish, pending, onPending, header }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  // Acción de git en curso y lo último que ha dicho git.
  const [op, setOp] = useState<string | null>(null);
  const [output, setOutput] = useState<{ text: string; ok: boolean } | null>(null);
  const [stashes, setStashes] = useState<Stash[]>([]);
  // Propuesta de commits de Larry, visible antes de confirmar.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const draftReq = useRef(0);

  const refresh = useCallback(() => {
    const id = ++request.current;
    Promise.all([git.status(project), git.log(project), git.branches(project), gitOps.stashList(project).catch(() => [])]).then(
      ([s, l, b, st]) => {
        if (id !== request.current) return;
        setStatus(s);
        setLog(l);
        setBranches(b);
        setStashes(st);
        setError(null);
      },
      (e) => id === request.current && setError(String(e)),
    );
  }, [project]);

  useEffect(() => {
    setStatus(null);
    setLog([]);
    setBranches([]);
    setDraft(null);
    setOutput(null);
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

  const run = (name: string, action: () => Promise<string>) => {
    setOp(name);
    setOutput(null);
    action()
      .then((text) => setOutput({ text: text || 'hecho', ok: true }), (e) => setOutput({ text: String(e), ok: false }))
      .finally(() => {
        setOp(null);
        refresh();
      });
  };

  // ── propuesta de commits ──
  const propose = (quick = false) => {
    const id = ++draftReq.current;
    setDraft({ loading: true, plan: null, commits: [], error: null, busy: false });
    setElapsed(0);
    (quick ? larry.groups(project, null) : larry.propose(project, null)).then(
      (plan) => id === draftReq.current && setDraft({ loading: false, plan, commits: plan.commits, error: null, busy: false }),
      (e) => id === draftReq.current && setDraft({ loading: false, plan: null, commits: [], error: String(e), busy: false }),
    );
  };
  useEffect(() => {
    if (!draft?.loading) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [draft?.loading]);

  const editCommit = (i: number, message: string) =>
    setDraft((d) => d && { ...d, commits: d.commits.map((c, j) => (j === i ? { ...c, message } : c)) });
  const dropCommit = (i: number) => setDraft((d) => d && { ...d, commits: d.commits.filter((_, j) => j !== i) });
  const ready = !!draft && draft.commits.length > 0 && draft.commits.every((c) => c.message.trim() && !c.message.includes('describe el cambio'));

  const confirm = () => {
    if (!draft) return;
    setDraft({ ...draft, busy: true, error: null });
    larry.commit(project, null, draft.commits).then(
      (outcome) => {
        setDraft(null);
        setOutput({ text: outcome.stopped ? `Larry se detuvo: ${outcome.stopped}` : outcome.created.join('\n'), ok: !outcome.stopped });
        refresh();
      },
      (e) => setDraft((d) => d && { ...d, busy: false, error: String(e) }),
    );
  };

  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const dirty = changes.length > 0;
  const actions: { id: string; label: string; disabled?: boolean; badge?: number; act: () => void }[] = [
    { id: 'commit', label: dirty ? 'proponer commits (larry)' : 'no hay cambios que confirmar', disabled: !dirty, act: () => (draft ? setDraft(null) : propose()) },
    { id: 'fetch', label: 'fetch · traer referencias del remoto', act: () => run('fetch', () => gitOps.fetch(project)) },
    { id: 'pull', label: behind ? `pull · traer ${behind} commit${behind === 1 ? '' : 's'}` : 'pull (solo avance rápido)', badge: behind, disabled: !status?.upstream, act: () => run('pull', () => gitOps.pull(project)) },
    {
      id: 'push',
      label: status?.upstream ? (ahead ? `push · publicar ${ahead} commit${ahead === 1 ? '' : 's'}` : 'push') : 'push · crear la rama en origin',
      badge: ahead,
      disabled: !status?.branch,
      act: () => run('push', () => gitOps.push(project, !status?.upstream)),
    },
    { id: 'stash', label: 'stash · guardar los cambios aparte', disabled: !dirty, act: () => run('stash', () => gitOps.stash(project, null)) },
    { id: 'pop', label: stashes.length ? `stash pop · recuperar «${stashes[0].subject}»` : 'no hay stash guardado', badge: stashes.length, disabled: !stashes.length, act: () => run('pop', () => gitOps.stashPop(project)) },
    { id: 'undo', label: 'deshacer el último commit (los cambios se conservan)', disabled: !status?.head, act: () => run('undo', () => gitOps.undoCommit(project)) },
    { id: 'pr', label: 'publicar rama y abrir pull request', act: onPublish },
  ];

  return (
    <aside className="git" aria-label="Control de versiones">
      <Splitter size={SIZES.git} axis="x" invert label="Ancho del panel de Git" className="is-edge-left" />
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

          <div className="git-actions" role="toolbar" aria-label="Acciones de git">
            {actions.map((a) => (
              <button
                key={a.id}
                className={`git-act${op === a.id ? ' is-busy' : ''}${a.id === 'commit' && draft ? ' is-on' : ''}`}
                onClick={a.act}
                disabled={a.disabled || !!op}
                title={a.label}
                aria-label={a.label}
              >
                <Icon name={a.id} />
                {!!a.badge && <span className="git-badge">{a.badge}</span>}
              </button>
            ))}
          </div>
          {output && (
            <button className={`git-out${output.ok ? '' : ' is-error'}`} onClick={() => setOutput(null)} title="cerrar">
              {output.text}
            </button>
          )}

          <section className="git-changes" aria-label="Cambios">
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
                <span style={{ color: STATUS_COLOR[c.status] ?? 'var(--tx3)' }} aria-label={STATUS_LABEL[c.status]}>
                  {c.status}
                </span>
                <span className="git-path">{c.path}</span>
                {c.adds != null && <span className="add">+{c.adds}</span>}
                {c.dels != null && <span className="del">−{c.dels}</span>}
              </button>
            ))}
            {changes.length === 0 && <div className="muted">árbol limpio</div>}
          </section>

          {draft && (
            <section className="git-draft" aria-label="Commits propuestos">
              <div className="git-label">
                <span>commits propuestos</span>
                <button className="co-link" onClick={() => setDraft(null)}>
                  descartar
                </button>
              </div>
              {draft.loading && (
                <div className="git-draft-wait">
                  <span className="spinner" aria-hidden="true" />
                  larry agrupa los cambios… {elapsed} s
                  <button className="co-link" onClick={() => propose(true)}>
                    no esperar
                  </button>
                </div>
              )}
              {draft.plan?.notes && <div className="git-note">{draft.plan.notes}</div>}
              {draft.commits.map((c, i) => (
                <div className="git-commit" key={i}>
                  <textarea
                    aria-label={`Mensaje del commit ${i + 1}`}
                    value={c.message}
                    rows={Math.min(8, c.message.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 34)), 0))}
                    onChange={(e) => editCommit(i, e.target.value)}
                    spellCheck={false}
                  />
                  <div className="git-commit-files">
                    {c.files.map((f) => (
                      <button key={f} className="git-path" onClick={() => onDiff({ path: f, orig: null, status: 'M', adds: null, dels: null })} title="ver diff">
                        {f}
                      </button>
                    ))}
                  </div>
                  {draft.commits.length > 1 && (
                    <button className="git-commit-drop" onClick={() => dropCommit(i)} title="quitar este commit de la propuesta" aria-label="Quitar este commit">
                      ×
                    </button>
                  )}
                </div>
              ))}
              {draft.error && <div className="git-error">{draft.error}</div>}
              {!draft.loading && (
                <div className="git-draft-bar">
                  <button className="co-link" onClick={() => propose()} disabled={draft.busy}>
                    volver a proponer
                  </button>
                  <button className="primary" onClick={confirm} disabled={!ready || draft.busy} title={ready ? 'crea los commits en local; no publica' : 'completa los mensajes'}>
                    {draft.busy ? 'creando…' : `confirmar ${draft.commits.length} commit${draft.commits.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              )}
            </section>
          )}

          {pending > 0 && (
            <button className="git-pending" onClick={onPending} title="sesiones cerradas cuya rama sigue guardada">
              ⎇ {pending} rama{pending === 1 ? '' : 's'} sin integrar
            </button>
          )}

          <Splitter size={SIZES.log} axis="y" invert label="Altura del historial" className="is-log" />
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
      <Usage />
    </aside>
  );
}
