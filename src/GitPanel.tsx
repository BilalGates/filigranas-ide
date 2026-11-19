import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { listen } from '@tauri-apps/api/event';
import { git, gitOps, larry, type Change, type CommitDetail, type GitStatus, type LarryCommit, type LogRow, type Review, type Stash } from './ipc';
import ApprovalForm from './ApprovalForm';
import Splitter, { SIZES } from './Splitter';
import GitGraph, { GIT_ROW_HEIGHT, layoutGraph, parseRefs } from './GitGraph';
import { beep, useCommand } from './ui';

const STATUS_COLOR: Record<string, string> = { A: 'var(--ok)', U: 'var(--ok)', D: 'var(--err)', '!': 'var(--err)' };
const LOG_DATE = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const STATUS_LABEL: Record<string, string> = {
  M: 'modificado',
  A: 'añadido',
  D: 'eliminado',
  R: 'renombrado',
  U: 'sin seguimiento',
  '!': 'en conflicto',
};

// Iconos de trazo fino, de la misma familia.
const ICON: Record<string, JSX.Element> = {
  branch: <><circle cx="4" cy="3.5" r="1.7" /><circle cx="4" cy="12.5" r="1.7" /><circle cx="12" cy="5.5" r="1.7" /><path d="M4 5.2v5.6M12 7.2c0 3-8 2-8 3.6" /></>,
  box: <><path d="M8 1.5 14 4.8v6.4L8 14.5 2 11.2V4.8z" /><path d="M2 4.8 8 8l6-3.2M8 8v6.5" /></>,
  pull: <><path d="M8 2v9M4.5 7.5 8 11l3.5-3.5" /><path d="M3 14h10" /></>,
  push: <><path d="M8 13V4M4.5 7.5 8 4l3.5 3.5" /><path d="M3 2h10" /></>,
  more: <><circle cx="3" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="13" cy="8" r=".9" /></>,
  regen: <><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 2.5v3h-3" /></>,
  down: <path d="M4 6l4 4 4-4" />,
  terminal: <><path d="M3 4.5 6.5 8 3 11.5" /><path d="M8.5 12h4.5" /></>,
  mute: <><path d="M2 6h3l4-3v10l-4-3H2z" /><path d="M11 6l4 4M15 6l-4 4" /></>,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  plus: <path d="M8 3v10M3 8h10" />,
  folder: <path d="M1.5 4h4.5l1.5 1.5h7V13h-13z" />,
  file: <><path d="M4 1.5h5.5L13 5v9.5H4z" /><path d="M9.5 1.5V5H13" /></>,
  changes: <><path d="M8 2v6M5 5h6" /><path d="M5 12h6" /></>,
  sidebar: <><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="M6 2.5v11" /></>,
  panel: <><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="M10 2.5v11" /></>,
  gauge: <><path d="M2.5 11a5.5 5.5 0 1 1 11 0" /><path d="M8 11l2.5-3" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>,
  chat: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  pm: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.8-2.6 2.7-4 5-4s4.2 1.4 5 4" /></>,
  wand: <><path d="M3 13 11 5" /><path d="M11 2v2M13 4h-2M12.5 7.5l1 1M7.5 2.5l1 1" /></>,
  merge: <><circle cx="4" cy="3.5" r="1.7" /><circle cx="4" cy="12.5" r="1.7" /><circle cx="12" cy="12.5" r="1.7" /><path d="M4 5.2v5.6M4 6c0 4 8 2 8 4.8" /></>,
  warn: <><path d="M8 2 14.5 13.5h-13z" /><path d="M8 6.5v3M8 11.5v.2" /></>,
};

export function Icon({ name, size = 14 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON[name]}
    </svg>
  );
}

type Props = {
  project: string;
  selected: Change | null;
  onDiff: (c: Change) => void;
  onPublish: () => void;
  pending: number;
  onPending: () => void;
  onBranch: (branch: string | null) => void;
  onDirty?: (dirty: boolean) => void;
};

// Propuesta de Larry: `touched` cuando el usuario ya ha editado algún mensaje
// (entonces no se sustituye sola al cambiar los archivos).
type Draft = { commits: LarryCommit[]; touched: boolean; loading: boolean };
const EMPTY: Draft = { commits: [], touched: false, loading: false };

/** Control de versiones del proyecto abierto, al estilo de Cursor. */
export default function GitPanel({ project, selected, onDiff, onPublish, pending, onPending, onBranch, onDirty }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const [op, setOp] = useState<string | null>(null);
  const [pushReview, setPushReview] = useState<{ review: Review; upstream: boolean } | null>(null);
  const [output, setOutput] = useState<{ text: string; ok: boolean; key: number } | null>(null);
  const [menu, setMenu] = useState<'branch' | 'commit' | 'more' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [message, setMessage] = useState('');
  const draftReq = useRef(0);
  const [detail, setDetail] = useState<{ hash: string; data: CommitDetail | null } | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  // La tarjeta del commit siempre a la vista dentro del historial.
  useEffect(() => {
    detailRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [detail]);

  const say = (text: string, ok = true) => setOutput({ text, ok, key: Date.now() });

  const refresh = useCallback(() => {
    const id = ++request.current;
    Promise.all([git.status(project), git.log(project), git.branches(project), gitOps.stashList(project).catch(() => [] as Stash[])]).then(
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
    setDraft(EMPTY);
    setMessage('');
    setOutput(null);
    setPushReview(null);
    setDetail(null);
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

  useEffect(() => onBranch(status?.branch ?? null), [status?.branch, onBranch]);
  const hasChanges = !!status?.changes.length;
  useEffect(() => {
    if (status) onDirty?.(hasChanges);
  }, [status, hasChanges, onDirty]);

  const changes = status?.changes ?? [];
  const graph = useMemo(() => layoutGraph(log), [log]);
  const detailIndex = log.findIndex((r) => r.hash === detail?.hash);
  const changeKey = changes.map((c) => c.path).join('\n');

  // Larry redacta en cuanto hay cambios (agrupación rápida, sin modelo).
  // ⌘⇧G o el botón ↻ piden la propuesta completa.
  const propose = useCallback(
    (smart: boolean) => {
      const id = ++draftReq.current;
      setDraft((d) => ({ ...d, loading: true }));
      (smart ? larry.propose(project, null) : larry.groups(project, null)).then(
        (plan) => {
          if (id !== draftReq.current) return;
          setDraft({ commits: plan.commits, touched: false, loading: false });
          setMessage(plan.commits[0]?.message ?? '');
        },
        (e) => {
          if (id !== draftReq.current) return;
          setDraft((d) => ({ ...d, loading: false }));
          setOutput({ text: String(e), ok: false, key: Date.now() });
        },
      );
    },
    [project],
  );
  const touched = useRef(false);
  touched.current = draft.touched;
  useEffect(() => {
    if (!changeKey) {
      draftReq.current++;
      setDraft(EMPTY);
      setMessage('');
      return;
    }
    if (!touched.current) propose(false);
  }, [changeKey, propose]);

  const run = (name: string, action: () => Promise<string>) => {
    setOp(name);
    setMenu(null);
    beep('tick');
    action()
      .then((text) => say(text || 'hecho'), (e) => say(String(e), false))
      .finally(() => {
        setOp(null);
        refresh();
      });
  };

  const switchTo = (branch: string) => {
    setMenu(null);
    if (branch === status?.branch) return;
    run('switch', () => git.switch(project, branch).then(() => `rama ${branch}`));
  };

  // Commits a crear: los de Larry con el primer mensaje editado, o uno solo
  // con todos los archivos si el mensaje se escribió a mano.
  const commits: LarryCommit[] = draft.commits.length
    ? draft.commits.map((c, i) => (i === 0 ? { ...c, message } : c))
    : message.trim()
      ? [{ message, files: changes.map((c) => c.path) }]
      : [];
  const ready = commits.length > 0 && commits.every((c) => c.message.trim()) && !draft.loading;

  const reviewPush = (upstream: boolean) => {
    setOp('push');
    gitOps.reviewPush(project, upstream).then((review) => setPushReview({ review, upstream }), (error) => say(String(error), false))
      .finally(() => setOp(null));
  };

  const commit = (andPush: boolean) => {
    if (!ready || op) return;
    setMenu(null);
    setOp('commit');
    larry.commit(project, null, commits).then(
      (outcome) => {
        setDraft(EMPTY);
        setMessage('');
        setOp(null);
        if (outcome.stopped) {
          say(`Larry se detuvo: ${outcome.stopped}`, false);
          refresh();
          return;
        }
        beep('done');
        const n = outcome.created.length;
        say(`${n} commit${n === 1 ? '' : 's'} creado${n === 1 ? '' : 's'}`);
        refresh();
        if (andPush) reviewPush(!status?.upstream);
      },
      (e) => {
        setOp(null);
        say(String(e), false);
      },
    );
  };

  const commitRef = useRef(commit);
  commitRef.current = commit;
  useCommand('commit', useCallback(() => commitRef.current(false), []));
  useCommand('commit-push', useCallback(() => commitRef.current(true), []));
  useCommand('larry', useCallback(() => propose(true), [propose]));

  const editMore = (i: number, text: string) =>
    setDraft((d) => ({ ...d, touched: true, commits: d.commits.map((c, j) => (j === i ? { ...c, message: text } : c)) }));

  const openDetail = (hash: string) => {
    if (detail?.hash === hash) return setDetail(null);
    beep('tick');
    const selection = { hash, data: null };
    setDetail(selection);
    gitOps.detail(project, hash).then(
      (data) => setDetail((d) => (d === selection ? { hash, data } : d)),
      (e) => {
        setDetail((d) => (d === selection ? null : d));
        say(String(e), false);
      },
    );
  };

  // Cerrar menús y el detalle al pulsar fuera o con Escape.
  useEffect(() => {
    if (!menu && !detail) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (menu && !t.closest('.menu, .rh-btn, .split, .sync')) setMenu(null);
      if (detail && !t.closest('.git-detail, .git-row')) setDetail(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setDetail(null);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menu, detail]);

  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const dirty = changes.length > 0;
  const more: [string, string, (() => void) | null][] = [
    ['fetch', 'fetch', () => run('fetch', () => gitOps.fetch(project))],
    ['stash', 'stash', dirty ? () => run('stash', () => gitOps.stash(project, null)) : null],
    ['pop', stashes.length ? `stash pop · ${stashes[0].subject}` : 'stash pop', stashes.length ? () => run('pop', () => gitOps.stashPop(project)) : null],
    ['undo', 'deshacer último commit', status?.head ? () => run('undo', () => gitOps.undoCommit(project)) : null],
  ];

  return (
    <>
      {error && <div className="git-error">{error}</div>}
      {status && (
      <div className="sync git-head">
        <button className="brbtn" aria-expanded={menu === 'branch'} onClick={() => setMenu((m) => (m === 'branch' ? null : 'branch'))} title="cambiar de rama">
        <Icon name="branch" size={13} />
        <span className="rh-name">{status.branch ?? 'sin rama'}</span>
        <Icon name="down" size={10} />
      </button>
      {menu === 'branch' && (
        <div className="menu branch-menu" role="menu">
          {branches.map((b) => (
            <button key={b} role="menuitemradio" aria-checked={b === status.branch} className="menu-item" onClick={() => switchTo(b)}>
              <span className="grow">{b}</span>
              {b === status.branch && <span className="mark">✓</span>}
            </button>
          ))}
        </div>
      )}
      <span className="sync-n" title={status.upstream ? `→ ${status.upstream}` : 'sin rama remota'}>
          ↑{ahead} ↓{behind}
        </span>
        <button className={`ic${op === 'pull' ? ' is-busy' : ''}`} aria-label="Pull" title={behind ? `pull · ${behind}` : 'pull'} disabled={!status.upstream || !!op} onClick={() => run('pull', () => gitOps.pull(project))}>
          <Icon name="pull" />
        </button>
        <button className={`ic${op === 'push' ? ' is-busy' : ''}`} aria-label="Push" title={status.upstream ? 'push' : 'push · crea la rama en origin'} disabled={!status.branch || !!op || !!pushReview} onClick={() => reviewPush(!status.upstream)}>
          <Icon name="push" />
        </button>
        <button className="ic" aria-label="Más acciones de git" aria-expanded={menu === 'more'} onClick={() => setMenu((m) => (m === 'more' ? null : 'more'))}>
          <Icon name="more" />
        </button>
        {menu === 'more' && (
          <div className="menu sync-menu" role="menu">
            {more.map(([id, label, act]) => (
              <button key={id} role="menuitem" className="menu-item" disabled={!act || !!op} onClick={() => act?.()}>
                {label}
              </button>
            ))}
            <div className="menu-sep" />
            <button
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setMenu(null);
                onPublish();
              }}
            >
              pull request…
            </button>
          </div>
        )}
      </div>
      )}
      {status && (
        <>
          <section className="git-commit-box" aria-label="Commit">
            <div className="cbox">
              <textarea
                aria-label="Mensaje de commit"
                placeholder={dirty ? (draft.loading ? 'larry redacta…' : 'mensaje de commit') : 'sin cambios'}
                value={message}
                disabled={!dirty}
                rows={Math.min(6, Math.max(2, message.split('\n').length))}
                spellCheck={false}
                onChange={(e) => {
                  setMessage(e.target.value);
                  setDraft((d) => ({ ...d, touched: true }));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.stopPropagation();
                    commit(false);
                  }
                }}
              />
              <button className={`regen${draft.loading ? ' is-busy' : ''}`} aria-label="Que Larry proponga de nuevo" title="larry propone de nuevo · ⌘⇧G" disabled={!dirty || draft.loading} onClick={() => propose(true)}>
                <Icon name="regen" size={12} />
              </button>
            </div>
            {draft.commits.length > 1 && (
              <div className="more-commits">
                {draft.commits.slice(1).map((c, j) => (
                  <div className="mc" key={j}>
                    <input aria-label={`Mensaje del commit ${j + 2}`} value={c.message} spellCheck={false} onChange={(e) => editMore(j + 1, e.target.value)} />
                    <span className="mc-files" title={c.files.join('\n')}>
                      {c.files.length} archivo{c.files.length === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="split">
              <button className="act" onClick={() => commit(false)} disabled={!ready || !!op} title="crea los commits en local · ⌘⇧C">
                {op === 'commit' ? 'creando…' : commits.length > 1 ? `commit · ${commits.length}` : 'commit'}
              </button>
              <button className="act dd" aria-label="Más formas de hacer commit" aria-expanded={menu === 'commit'} disabled={!ready || !!op} onClick={() => setMenu((m) => (m === 'commit' ? null : 'commit'))}>
                <Icon name="down" size={11} />
              </button>
              {menu === 'commit' && (
                <div className="menu split-menu" role="menu">
                  <button role="menuitem" className="menu-item" onClick={() => commit(false)}>
                    <span className="grow">commit</span>
                    <span className="kbd">⌘⇧C</span>
                  </button>
                  <button role="menuitem" className="menu-item" onClick={() => commit(true)}>
                    <span className="grow">commit y push</span>
                    <span className="kbd">⌘⇧P</span>
                  </button>
                </div>
              )}
            </div>
          </section>

          {pushReview && <ApprovalForm key={pushReview.review.id} review={pushReview.review} action="confirmar push"
            onClose={() => setPushReview(null)} onConfirm={(proof) => {
              setPushReview(null);
              run('push', () => gitOps.push(project, pushReview.upstream, proof));
            }} />}
          {output && (
            <button key={output.key} className={`git-out${output.ok ? '' : ' is-error'}`} onClick={() => setOutput(null)} title="cerrar">
              {output.text}
            </button>
          )}

          {dirty && (
            <section className="git-changes" aria-label="Cambios">
              <div className="git-label">
                <span>cambios</span>
                <span>{changes.length}</span>
              </div>
              {changes.map((c) => (
                <button key={c.path} className={`git-change${selected?.path === c.path ? ' is-selected' : ''}`} onClick={() => onDiff(c)} title={c.orig ? `${c.orig} → ${c.path}` : c.path}>
                  <span className="git-st" style={{ color: STATUS_COLOR[c.status] ?? 'var(--tx3)' }} aria-label={STATUS_LABEL[c.status]}>
                    {c.status}
                  </span>
                  <span className="git-path">{c.path}</span>
                  {(c.adds != null || c.dels != null) && (
                    <span className="git-nums">
                      +{c.adds ?? 0} −{c.dels ?? 0}
                    </span>
                  )}
                </button>
              ))}
            </section>
          )}

          {pending > 0 && (
            <button className="git-pending" onClick={onPending} title="sesiones cerradas cuya rama sigue guardada">
              {pending} rama{pending === 1 ? '' : 's'} sin integrar
            </button>
          )}

          <Splitter size={SIZES.log} axis="y" invert label="Altura del historial" className="is-log" />
          <section className="git-log" aria-label="Historial">
            <div className="git-label">
              <span>historial</span>
            </div>
            <div className="git-log-body" style={{ '--git-row-height': `${GIT_ROW_HEIGHT}px` } as CSSProperties}>
              <GitGraph graph={graph} selected={detailIndex} />
              {log.map((r, i) => {
                const dot = graph.dots[i];
                const timestamp = Date.parse(r.date);
                return (
                <div
                  className={`git-row${detailIndex === i ? ' is-open' : ''}${r.hash ? ' is-commit' : ''}`}
                  key={r.hash}
                  style={{ '--git-lane': dot.color, '--git-inset': `${dot.inset}px` } as CSSProperties}
                  onClick={() => r.hash && openDetail(r.hash)}
                  role={r.hash ? 'button' : undefined}
                  tabIndex={r.hash ? 0 : undefined}
                  aria-expanded={r.hash ? detailIndex === i : undefined}
                  onKeyDown={(e) => {
                    if (r.hash && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      openDetail(r.hash);
                    }
                  }}
                >
                  {r.hash && (
                    <>
                      <span className="git-subject" title={r.subject}>
                        {parseRefs(r.refs).map((ref) => (
                          <span key={ref.name} className={`git-ref is-${ref.kind}`} title={ref.name}>
                            {ref.kind === 'head' && <span aria-hidden="true">✓ </span>}
                            {ref.name}
                          </span>
                        ))}
                        {r.subject}
                      </span>
                      <span className="git-meta git-author" title={r.author}>{r.author}</span>
                      <span className="git-meta git-hash" title={r.hash}>{r.hash}</span>
                      <time className="git-meta git-date" title={r.date} dateTime={r.date}>
                        {Number.isFinite(timestamp) ? LOG_DATE.format(timestamp) : ''}
                      </time>
                    </>
                  )}
                </div>
                );
              })}
              {detail && detailIndex >= 0 && (
                <div ref={detailRef} className="git-detail" role="dialog" aria-label="Detalle del commit" style={{ top: (detailIndex + 1) * GIT_ROW_HEIGHT + 4 }}>
                  {!detail.data ? (
                    <div className="muted">cargando…</div>
                  ) : (
                    <>
                      <div className="gd-head">
                        <span className="gd-hash">{detail.data.hash.slice(0, 7)}</span>
                        <span>{detail.data.author}</span>
                        <span className="muted">{detail.data.date}</span>
                      </div>
                      {detail.data.body && <div className="gd-body">{detail.data.body}</div>}
                      <div className="gd-files">
                        {detail.data.files.map((f) => (
                          <div className="gd-file" key={f.path}>
                            <span className="git-st" style={{ color: STATUS_COLOR[f.status] ?? 'var(--tx3)' }}>
                              {f.status}
                            </span>
                            <span className="git-path">{f.path}</span>
                            <span className="git-nums">
                              +{f.adds ?? 0} −{f.dels ?? 0}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
