import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, git, sessions, workSessions, type GitStatus, type WorkSession } from '../ipc';
import { queuedRefresh } from '../queuedRefresh';
import { emit } from '../ui';
import { Icon } from './icons';
import { pushOperationalError } from './notifications';

/** Nivel de permisos de una sesión o del Project manager (ver src-tauri/src/autoapprove.rs). */
export type PermissionMode = 'readonly' | 'ask' | 'auto' | 'full';
const MODES: { id: PermissionMode; label: string; icon: string; text: string }[] = [
  { id: 'readonly', label: 'Solo lectura', icon: 'lock', text: 'Consultas sin modificaciones. Las escrituras se rechazan por política.' },
  { id: 'ask', label: 'Con autorización', icon: 'lock', text: 'Cada petición del agente te llega para aprobarla o rechazarla.' },
  { id: 'auto', label: 'Automático', icon: 'shield', text: 'Aprueba lecturas, ediciones dentro del proyecto y tests o builds locales. Los cambios en Git, en la configuración de los agentes, en manifiestos o scripts de build y cualquier otra orden te llegan para aprobarlos.' },
  { id: 'full', label: 'Full control', icon: 'unlock', text: 'Aprueba ediciones y órdenes simples dentro del proyecto. Publicar, integrar, borrar, cambiar de rama, la red, los intérpretes y las órdenes compuestas siguen pidiendo tu aprobación.' },
];
const KEY = (scope: string) => `filigranas.permisos.${scope}`;
const BRANCH_CHANGED_EVENT = 'filigranas:branch-changed';

function readMode(scope: string, fallbackScope?: string): PermissionMode {
  try {
    const v = localStorage.getItem(KEY(scope));
    if (v === 'readonly' || v === 'auto' || v === 'full' || v === 'ask') return v;
    if (fallbackScope) {
      const parent = localStorage.getItem(KEY(fallbackScope));
      if (parent === 'readonly' || parent === 'ask' || parent === 'auto' || parent === 'full') return parent;
    }
    return 'ask';
  } catch {
    return 'ask';
  }
}

/** Nivel guardado del chat; se vuelve a fijar en el núcleo al abrirlo. */
export function usePermissionMode(id: number | null, project: string | null = null, storageScope?: string, fallbackScope?: string) {
  const scope = storageScope ?? (id != null ? String(id) : project ? `pm:${project}` : null);
  const [mode, setModeState] = useState<PermissionMode>(() => scope == null ? 'ask' : readMode(scope, fallbackScope));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (scope == null || (id == null && !project)) return;
    let active = true;
    // El backend conserva la herencia de una subsesión recién creada. Montar
    // una vista sin preferencia propia nunca la sobrescribe con ask.
    const own = localStorage.getItem(KEY(scope));
    const saved = own == null ? null : readMode(scope, fallbackScope);
    const loading = saved == null
      ? sessions.getPermissionMode(id, project)
      : sessions.permissionMode(id, saved, project);
    loading.then((value) => { if (active) setModeState(value as PermissionMode); }, (e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [id, project, scope, fallbackScope]);
  const setMode = useCallback((next: PermissionMode) => {
    if (scope == null || (id == null && !project)) return;
    sessions.permissionMode(id, next, project).then(() => {
      setModeState(next);
      setError(null);
      try { localStorage.setItem(KEY(scope), next); } catch { /* sin almacenamiento */ }
    }, (e) => setError(String(e)));
  }, [id, project, scope]);
  return { mode, setMode, error };
}

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) latest.current(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') latest.current(); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return ref;
}

/** Chip de modo de trabajo (permisos) de la barra del compositor. */
export function PermissionChip({ mode, onMode, disabled }: { mode: PermissionMode; onMode: (m: PermissionMode) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const current = MODES.find((m) => m.id === mode)!;
  return (
    <div className="sb-wrap" ref={ref}>
      <button type="button" className={`chip cm-trigger sb-perm is-${mode}${open ? ' is-open' : ''}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        aria-label={`Modo de trabajo: ${current.label}`} title={current.text} onClick={() => setOpen(!open)}>
        <Icon name={current.icon} size={12} />
        <span>{current.label}</span>
        <svg className="cm-caret" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M2.5 6.2 5 3.8l2.5 2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div className="sb-menu up" role="menu" aria-label="Modo de trabajo del modelo">
        <div className="cm-heading">Modo de trabajo</div>
        {MODES.map((m) => <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === mode} className={`sb-item is-${m.id}`}
          onClick={() => { onMode(m.id); setOpen(false); }}>
          <Icon name={m.icon} size={14} /><span className="sb-text"><b>{m.label}</b><small>{m.text}</small></span>{m.id === mode && <Icon name="check" size={13} />}
        </button>)}
      </div>}
    </div>
  );
}

/** Carpeta del worktree aislado: muestra su ruta y la abre en el explorador o en VS Code. */
function WorktreeChip({ path, folder }: { path: string; folder: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useOutside(open, () => setOpen(false));
  const run = (editor: boolean) => api.openWorktree(path, editor).then(() => setOpen(false), (e) => setError(String(e)));
  return (
    <div className="sb-wrap" ref={ref}>
      <button type="button" className="sb-chip btn" aria-expanded={open} title={path} onClick={() => { setError(null); setOpen(!open); }}>
        <Icon name="folder" size={12} />{folder}
      </button>
      {open && <div className="sb-menu up" role="menu" aria-label="Carpeta del worktree">
        <p className="sb-note mono" style={{ wordBreak: 'break-all' }}>{path}</p>
        <button type="button" role="menuitem" className="menu-item" onClick={() => void run(false)}>Mostrar en el explorador</button>
        <button type="button" role="menuitem" className="menu-item" onClick={() => void run(true)}>Abrir en VS Code</button>
        <button type="button" role="menuitem" className="menu-item" onClick={() => void navigator.clipboard.writeText(path).then(() => setOpen(false))}>Copiar ruta</button>
        {error && <p className="sb-note" role="alert">{error}</p>}
      </div>}
    </div>
  );
}

/**
 * Fila de contexto sobre el compositor: dónde trabaja la sesión (equipo,
 * carpeta, rama y sincronización). En sesiones directas el chip de rama actúa
 * como selector real de ramas Git del proyecto activo.
 */
export function SessionContext({ project, worktree, branch, base, extra, hidden = false }: {
  project: string; worktree: string | null; branch: string | null; base: string | null; extra?: ReactNode; hidden?: boolean;
}) {
  const [branchInfo, setBranchInfo] = useState<{ project: string; status: GitStatus | null; label: string } | null>(null);
  const [workInfo, setWorkInfo] = useState<{ project: string; item: WorkSession | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [showWorkForm, setShowWorkForm] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const refreshRef = useRef<(() => void) | null>(null);
  const direct = !worktree;

  useEffect(() => {
    setOpen(false);
    setQ('');
    setSwitchError(null);
    setShowWorkForm(false);
    setBranches(null);
  }, [project, direct]);

  useEffect(() => {
    if (!direct) {
      refreshRef.current = null;
      return;
    }
    let timer: number | undefined;
    const queue = queuedRefresh(
      async () => {
        const [gitResult, work] = await Promise.all([
          git.status(project).then(
            async (s) => ({ status: s, label: s.branch ?? await git.head(project) }),
            async () => ({ status: null, label: await git.head(project) }),
          ),
          workSessions.current(project).catch(() => null),
        ]);
        return { ...gitResult, work };
      },
      ({ status, label, work }) => {
        setBranchInfo({ project, status, label });
        setWorkInfo({ project, item: work });
      },
      () => {
        setBranchInfo({ project, status: null, label: 'Rama no disponible' });
      },
    );
    const trigger = () => { void queue.refresh(); };
    refreshRef.current = trigger;
    trigger();
    const onProjectChanged = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(trigger, 200);
    };
    const onBranchChanged = (e: Event) => {
      const target = (e as CustomEvent<string>).detail;
      if (!target || target === project) trigger();
    };
    const offs = [
      listen('tasks-changed', trigger),
      listen('project-changed', onProjectChanged),
    ];
    window.addEventListener('focus', trigger);
    window.addEventListener(BRANCH_CHANGED_EVENT, onBranchChanged);
    return () => {
      refreshRef.current = null;
      queue.stop();
      window.clearTimeout(timer);
      offs.forEach((off) => void off.then((stop) => stop()));
      window.removeEventListener('focus', trigger);
      window.removeEventListener(BRANCH_CHANGED_EVENT, onBranchChanged);
    };
  }, [project, direct]);

  useEffect(() => {
    if (hidden) {
      setOpen(false);
      return;
    }
    if (direct) refreshRef.current?.();
  }, [hidden, direct]);

  useEffect(() => {
    setQ('');
    setSwitchError(null);
    setShowWorkForm(false);
    if (!open || !direct) return;
    let alive = true;
    setBranches(null);
    void git.branches(project).then(
      (list) => { if (alive) setBranches(list); },
      (err) => {
        if (!alive) return;
        const msg = String(err);
        setSwitchError(msg);
        pushOperationalError(msg, { source: 'Git' });
        setBranches([]);
      },
    );
    return () => { alive = false; };
  }, [open, direct, project]);

  const folder = (worktree ?? project).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const status = branchInfo?.project === project ? branchInfo.status : null;
  const branchLabel = branchInfo?.project === project ? branchInfo.label : null;
  const work = workInfo?.project === project ? workInfo.item : null;
  const active = work && work.state !== 'finished' ? work : null;
  const shown = direct ? (branchLabel ?? active?.branch ?? '…') : (branch ?? '…');
  const currentBranch = status?.branch ?? branchLabel;
  const shownBranches = (branches ?? []).filter((b) => b.toLowerCase().includes(q.trim().toLowerCase()));

  const switchBranch = async (target: string) => {
    if (target === currentBranch) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setSwitchError(null);
    try {
      await git.switch(project, target);
      refreshRef.current?.();
      window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: project }));
      setOpen(false);
    } catch (err) {
      const msg = String(err);
      setSwitchError(msg);
      pushOperationalError(msg, { source: 'Git' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sb-context" aria-label="Dónde trabaja la sesión">
      <span className="sb-chip" title={direct ? 'Trabaja en la carpeta del proyecto' : `Copia aislada en ${worktree}`}>
        <Icon name="screen" size={12} />{direct ? 'Este equipo' : 'Copia aislada'}
      </span>
      {worktree ? <WorktreeChip path={worktree} folder={folder ?? ''} />
        : <span className="sb-chip" title={project}><Icon name="folder" size={12} />{folder}</span>}
      <div className="sb-wrap" ref={ref}>
        <button
          type="button"
          className={`sb-chip btn sb-branch${open ? ' is-open' : ''}`}
          aria-haspopup={direct ? 'menu' : 'dialog'}
          aria-expanded={open}
          aria-label={direct ? `Rama del proyecto: ${shown}` : `Rama de la sesión: ${shown}`}
          onClick={() => setOpen((v) => !v)}
          title={direct
            ? (active ? `Rama activa: ${shown} · Sesión de trabajo: ${active.objective}` : `Rama del proyecto: ${shown} · Cambiar de rama`)
            : `${branch} ← ${base ?? '—'}`}
        >
          <Icon name="branch" size={12} />
          <span className="mono">{shown}</span>
          {direct && (
            <svg className="cm-caret" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="M2.5 6.2 5 3.8l2.5 2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        {open && direct && (
          <div className="sb-menu up sb-branch-menu" role={showWorkForm ? 'dialog' : 'menu'} aria-label={showWorkForm ? 'Nueva sesión de trabajo' : 'Ramas'}>
            {showWorkForm ? (
              <div className="sb-branch-form">
                <button type="button" className="sb-branch-back" onClick={() => setShowWorkForm(false)}>
                  ← Volver a ramas
                </button>
                <WorkForm
                  project={project}
                  work={active}
                  onStarted={() => {
                    refreshRef.current?.();
                    window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: project }));
                    setShowWorkForm(false);
                    setOpen(false);
                  }}
                />
              </div>
            ) : (
              <>
                <input
                  autoFocus
                  className="sb-branch-q"
                  placeholder="Buscar rama"
                  value={q}
                  onChange={(e) => setQ(e.currentTarget.value)}
                  aria-label="Buscar rama"
                />
                {switchError && <div className="sb-branch-error" role="alert">{switchError}</div>}
                {active && (
                  <div className="sb-branch-work">
                    Sesión de trabajo en <b className="mono">{active.branch}</b> · {active.objective}
                  </div>
                )}
                <div className="sb-branch-list">
                  {branches === null ? (
                    <div className="sb-branch-empty">Leyendo ramas…</div>
                  ) : !shownBranches.length ? (
                    <div className="sb-branch-empty">Sin ramas que coincidan.</div>
                  ) : (
                    shownBranches.map((b) => (
                      <button
                        key={b}
                        type="button"
                        role="menuitem"
                        disabled={busy}
                        className={b === currentBranch ? 'on' : ''}
                        onClick={() => void switchBranch(b)}
                      >
                        <Icon name="branch" size={12} />
                        <span className="grow mono">{b}</span>
                        {b === currentBranch && <Icon name="check" size={12} />}
                      </button>
                    ))
                  )}
                </div>
                <div className="sb-branch-foot">
                  <button type="button" role="menuitem" onClick={() => { setOpen(false); emit('branch-tools'); }}>
                    Operaciones de rama
                  </button>
                  {!active && (
                    <button type="button" role="menuitem" onClick={() => setShowWorkForm(true)}>
                      Nueva sesión de trabajo…
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {open && !direct && (
          <div className="sb-menu up" role="dialog" aria-label="Rama de la sesión">
            <p className="sb-note">Esta sesión trabaja en su propia rama <b className="mono">{branch}</b>, creada desde <b className="mono">{base ?? '—'}</b>. La integras desde Entrega.</p>
          </div>
        )}
      </div>
      {direct && status?.upstream && <span className="sb-chip mono" title={`Sincronización con ${status.upstream}`}>↑{status.ahead} ↓{status.behind}</span>}
      <span className="grow" />
      {extra}
    </div>
  );
}

const KINDS = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore'];

function WorkForm({ project, work, onStarted }: { project: string; work: WorkSession | null; onStarted: () => void }) {
  const [objective, setObjective] = useState('');
  const [kind, setKind] = useState('feat');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (work) return (
    <div className="sb-note">
      <p>Sesión de trabajo en <b className="mono">{work.branch}</b>.</p>
      <p className="mut">{work.objective}</p>
      <p className="mut">Revísala y publícala desde Entrega.</p>
    </div>
  );
  const slug = objective.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '');
  const start = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    workSessions.start(project, objective, kind, objective, false).then(onStarted, (err) => { setError(String(err)); setBusy(false); });
  };
  return (
    <form className="sb-form" onSubmit={start}>
      <p className="sb-note">Puedes conversar sin un trabajo Git activo. Crea un trabajo para coordinar un objetivo, una rama y el reparto de archivos entre agentes.</p>
      {error && <div className="co-error" role="alert">{error}</div>}
      <label><span className="lab">Objetivo</span><input className="in" required autoFocus value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Qué vais a conseguir" /></label>
      <div className="sb-row">
        <select className="in" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo de rama">{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
        <span className="mono mut sb-slug">{kind}/{slug || 'objetivo'}</span>
      </div>
      <button className="tr-btn pearl" disabled={busy || !objective.trim()}>{busy ? 'Creando rama…' : 'Crear rama y empezar'}</button>
    </form>
  );
}
