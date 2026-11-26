import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { health, tasks as taskApi, workSessions, type PrInfo, type Project, type Session, type Task, type WorkSession } from '../ipc';
import { Icon } from './icons';
import { STATUS } from './taskMeta';
import { parsePmActivityKey } from './workspaceContext';

const ATTENTION = new Set(['waiting_approval', 'blocked', 'failed', 'paused_quota']);
type Item = { key: string; icon: string; tone: 'warn' | 'bad' | 'mut'; text: string; run: () => void };

/**
 * Botón «Necesita atención» de la barra superior: reúne peticiones de permiso
 * de cualquier proyecto/sesión activa e incidencias del proyecto actual (CI,
 * pausas, tareas). Siempre identifica proyecto y sesión de origen.
 */
export default function Attention({ project, projectName, projects, sessions, allSessions, activity, onSession, onTask, onEntrega, onHome }: {
  project: string | null;
  projectName: string | null;
  projects?: Project[];
  sessions: Session[];
  allSessions?: Session[];
  activity: Record<string, string | null>;
  onSession: (id: number | 'coach', sessionProject?: string) => void;
  onTask: (id: number) => void;
  onEntrega: (stage: 'ci' | 'tarea') => void;
  onHome: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Task[]>([]);
  const [ci, setCi] = useState<PrInfo | null>(null);
  const [work, setWork] = useState<WorkSession | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setList([]); setCi(null); setWork(null);
    if (!project) return;
    let alive = true;
    const load = () => {
      taskApi.list(project).then((t) => { if (alive) setList(t); }, () => {});
      health.ci(project, null).then((runs) => { if (alive) setCi(runs.find((r) => r.state === 'OPEN' && r.checksState === 'failure') ?? null); }, () => {});
      workSessions.current(project).then((w) => { if (alive) setWork(w); }, () => {});
    };
    load();
    const off = listen('tasks-changed', load);
    const timer = window.setInterval(load, 60_000);
    return () => { alive = false; window.clearInterval(timer); void off.then((stop) => stop()); };
  }, [project]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  const projectNames = new Map((projects ?? []).map((p) => [p.path, p.name]));
  const nameOf = (p: string) => projectNames.get(p) ?? (p === project && projectName ? projectName : p.split(/[\\/]/).filter(Boolean).pop() ?? p);
  const globalSessions = allSessions ?? sessions;

  const items: Item[] = [];
  for (const [key, state] of Object.entries(activity)) {
    if (state !== 'permiso') continue;
    const pmProj = parsePmActivityKey(key);
    if (pmProj || key === 'coach') {
      const targetProject = pmProj ?? project;
      if (!targetProject) continue;
      items.push({
        key: `p:${key}`,
        icon: 'warn',
        tone: 'warn',
        text: `${nameOf(targetProject)} · Project manager pide permiso`,
        run: () => onSession('coach', targetProject),
      });
      continue;
    }
    const s = globalSessions.find((x) => String(x.id) === key);
    if (!s) continue;
    const label = s.title?.trim() || s.name;
    items.push({
      key: `p:${key}`,
      icon: 'warn',
      tone: 'warn',
      text: `${nameOf(s.project)} · ${label} pide permiso`,
      run: () => onSession(s.id, s.project),
    });
  }
  if (ci) items.push({ key: 'ci', icon: 'close', tone: 'bad', text: `CI fallido en la PR #${ci.number} (${ci.branch})`, run: () => onEntrega('ci') });
  for (const s of globalSessions) if (s.paused) {
    const label = s.title?.trim() || s.name;
    const prefix = s.project !== project ? `${nameOf(s.project)} · ` : '';
    items.push({ key: `z${s.id}`, icon: 'pause', tone: 'mut', text: `${prefix}${label} en pausa · ${s.paused}`, run: () => onSession(s.id, s.project) });
  }
  if (work?.state === 'review') items.push({ key: 'w', icon: 'flow', tone: 'warn', text: 'Sesión de trabajo lista para revisar', run: () => onEntrega('tarea') });
  for (const t of list) if (ATTENTION.has(t.status) && t.status !== 'waiting_approval')
    items.push({ key: `t${t.id}`, icon: t.status === 'paused_quota' ? 'pause' : t.status === 'failed' ? 'close' : 'lock', tone: t.status === 'failed' ? 'bad' : 'mut', text: `#${t.id} ${STATUS[t.status]}: ${t.title}`, run: () => onTask(t.id) });

  const urgent = items.some((i) => i.tone !== 'mut');
  return (
    <div className="attn-wrap" ref={root}>
      <button className={`tb-btn tb-attention${open ? ' is-on' : ''}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={items.length ? `Necesita atención · ${items.length} pendientes` : 'Necesita atención'} title={items.length ? `${items.length} ${items.length === 1 ? 'cosa espera' : 'cosas esperan'} tu atención` : 'Nada pendiente'} onClick={() => setOpen(!open)}>
        <Icon name="bell" size={15} />{items.length > 0 && <span className={`attn-count${urgent ? ' is-urgent' : ''}`} aria-hidden="true">{items.length > 9 ? '9+' : items.length}</span>}
      </button>
      {open && <div className="attn-menu" role="menu" aria-label="Necesita atención">
        <div className="attn-head">Necesita atención</div>
        {items.length === 0 ? <p className="attn-empty">Nada pendiente en {projectName ?? 'este proyecto'}.</p>
          : items.slice(0, 8).map((i) => <button key={i.key} role="menuitem" className={`attn-item is-${i.tone}`} onClick={() => { setOpen(false); i.run(); }}>
            <Icon name={i.icon} size={14} /><span>{i.text}</span>
          </button>)}
        <button role="menuitem" className="attn-foot" onClick={() => { setOpen(false); onHome(); }}>Ver todos los proyectos en Inicio</button>
      </div>}
    </div>
  );
}
