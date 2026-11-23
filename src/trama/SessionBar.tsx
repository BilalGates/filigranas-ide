import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { git, sessions, workSessions, type GitStatus, type WorkSession } from '../ipc';
import { Icon } from './icons';

/** Nivel de permisos de una sesión (ver src-tauri/src/autoapprove.rs). */
export type PermissionMode = 'ask' | 'auto' | 'full';
const MODES: { id: PermissionMode; label: string; icon: string; text: string }[] = [
  { id: 'ask', label: 'Pedir permiso', icon: 'lock', text: 'Cada petición del agente te llega para aprobarla o rechazarla.' },
  { id: 'auto', label: 'Automático', icon: 'shield', text: 'Aprueba solo lecturas y ediciones dentro de la carpeta de la sesión. Terminal, red, borrados y lo que salga de la carpeta siguen preguntando.' },
  { id: 'full', label: 'Acceso total', icon: 'unlock', text: 'Aprueba cualquier petición del agente en esta sesión, también fuera de su carpeta. Úsalo solo si confías en el encargo.' },
];
const KEY = (id: number) => `filigranas.permisos.${id}`;

function readMode(id: number): PermissionMode {
  try { const v = localStorage.getItem(KEY(id)); return v === 'auto' || v === 'full' ? v : 'ask'; } catch { return 'ask'; }
}

/** Nivel guardado de la sesión; se vuelve a fijar en el núcleo al abrirla. */
export function usePermissionMode(id: number | null) {
  const [mode, setModeState] = useState<PermissionMode>(() => id == null ? 'ask' : readMode(id));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (id == null) return;
    const saved = readMode(id);
    setModeState(saved);
    sessions.permissionMode(id, saved).catch((e) => setError(String(e)));
  }, [id]);
  const setMode = useCallback((next: PermissionMode) => {
    if (id == null) return;
    sessions.permissionMode(id, next).then(() => {
      setModeState(next);
      setError(null);
      try { if (next === 'ask') localStorage.removeItem(KEY(id)); else localStorage.setItem(KEY(id), next); } catch { /* sin almacenamiento */ }
    }, (e) => setError(String(e)));
  }, [id]);
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

/** Chip de permisos de la barra del compositor. */
export function PermissionChip({ mode, onMode, disabled }: { mode: PermissionMode; onMode: (m: PermissionMode) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const current = MODES.find((m) => m.id === mode)!;
  return (
    <div className="sb-wrap" ref={ref}>
      <button type="button" className={`chip sb-perm is-${mode}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        title={current.text} onClick={() => setOpen(!open)}>
        <Icon name={current.icon} size={12} />{current.label}
      </button>
      {open && <div className="sb-menu up" role="menu" aria-label="Permisos de la sesión">
        {MODES.map((m) => <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === mode} className={`sb-item is-${m.id}`}
          onClick={() => { onMode(m.id); setOpen(false); }}>
          <Icon name={m.icon} size={14} /><span className="sb-text"><b>{m.label}</b><small>{m.text}</small></span>{m.id === mode && <Icon name="check" size={13} />}
        </button>)}
      </div>}
    </div>
  );
}

/**
 * Fila de contexto sobre el compositor: dónde trabaja la sesión (equipo,
 * carpeta, rama y sincronización); el motor ya está en la barra del compositor. En una sesión directa el
 * chip de rama abre la sesión de trabajo (objetivo + rama) que exige el núcleo.
 */
export function SessionContext({ project, worktree, branch, base, extra }: {
  project: string; worktree: string | null; branch: string | null; base: string | null; extra?: ReactNode;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [work, setWork] = useState<WorkSession | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const direct = !worktree;
  const refresh = useCallback(() => {
    if (!direct) return;
    git.status(project).then(setStatus, () => setStatus(null));
    workSessions.current(project).then(setWork, () => setWork(null));
  }, [project, direct]);
  useEffect(() => {
    refresh();
    const offs = [listen('tasks-changed', refresh), listen('project-changed', refresh)];
    return () => { offs.forEach((off) => void off.then((stop) => stop())); };
  }, [refresh]);
  const folder = (worktree ?? project).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const active = work && work.state !== 'finished' ? work : null;
  const shown = direct ? active?.branch ?? status?.branch ?? '…' : branch ?? '…';

  return (
    <div className="sb-context" aria-label="Dónde trabaja la sesión">
      <span className="sb-chip" title={direct ? 'Trabaja en la carpeta del proyecto' : `Copia aislada en ${worktree}`}><Icon name="screen" size={12} />{direct ? 'Este equipo' : 'Copia aislada'}</span>
      <span className="sb-chip" title={worktree ?? project}><Icon name="folder" size={12} />{folder}</span>
      <div className="sb-wrap" ref={ref}>
        <button type="button" className={`sb-chip btn${direct && !active ? ' is-warn' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}
          title={direct ? (active ? `Sesión de trabajo: ${active.objective}` : 'Sin sesión de trabajo: fíjala para que el agente pueda escribir') : `${branch} ← ${base ?? '—'}`}>
          <Icon name="branch" size={12} /><span className="mono">{shown}</span>
        </button>
        {open && <div className="sb-menu up" role="dialog" aria-label="Rama de la sesión">
          {direct ? <WorkForm project={project} work={active} onStarted={() => { refresh(); setOpen(false); }} />
            : <p className="sb-note">Esta sesión trabaja en su propia rama <b className="mono">{branch}</b>, creada desde <b className="mono">{base ?? '—'}</b>. La integras desde Entrega.</p>}
        </div>}
      </div>
      {direct && status?.upstream && <span className="sb-chip mono" title="Commits por publicar y por traer">↑{status.ahead} ↓{status.behind}</span>}
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
  const slug = objective.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '');
  const start = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    workSessions.start(project, objective, kind, objective, false).then(onStarted, (err) => { setError(String(err)); setBusy(false); });
  };
  return (
    <form className="sb-form" onSubmit={start}>
      <p className="sb-note">Para escribir en la carpeta del proyecto, la sesión necesita un objetivo y una rama propia. Los demás agentes directos compartirán esta rama.</p>
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
