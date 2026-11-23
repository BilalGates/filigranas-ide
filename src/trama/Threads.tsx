import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '../ipc';
import { useUi } from '../ui';
import { Icon } from './icons';
import { AgDot, sessionAgents } from './kit';

// Columna «Conversaciones» del Workspace de Trama v2: PM, trabajo, sesiones
// de tareas y directas del proyecto abierto, con su estado real. El árbol
// completo de proyectos (grupos, archivo, compartir) sigue a un clic.
export default function Threads({ projectName, view, hasPm, pmEngine, sessions, onView, onNew, onStartPm, onClose, onProjects, footer }: {
  projectName: string | null;
  view: 'coach' | 'work' | number;
  hasPm: boolean;
  pmEngine: string;
  sessions: Session[];
  onView: (v: 'coach' | number) => void;
  onNew: (engine: 'codex' | 'claude') => void;
  onStartPm: () => void;
  onClose: (id: number) => void;
  onProjects: () => void;
  footer?: ReactNode;
}) {
  const { activity } = useUi();
  const [menu, setMenu] = useState(false);
  const newRef = useRef<HTMLDivElement>(null);
  // El menú de «+» se cierra al pulsar fuera o con Escape.
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => { if (!newRef.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [menu]);
  const agents = sessionAgents(sessions, activity, hasPm ? { engine: pmEngine } : null);
  const pm = agents.find((a) => a.id === 'pm');
  const assigned = sessions.filter((s) => s.task);
  const isolated = sessions.filter((s) => s.worktree && !s.task);
  const direct = sessions.filter((s) => !s.worktree && !s.task);
  const item = (s: Session) => {
    const a = agents.find((x) => x.session === s.id)!;
    const first = s.task?.split('\n')[0]?.trim();
    const sub = first ? (first.length > 48 ? `${first.slice(0, 47)}…` : first) : s.branch ? s.branch : 'sin encargo';
    return (
      <div key={s.id} className="thread-wrap">
        <button className={`thread${view === s.id ? ' on' : ''}`} aria-current={view === s.id} onClick={() => onView(s.id)} title={`${a.name} · ${sub}`}>
          <AgDot a={a} />
          <span className="tx"><span className="t1">{a.name}</span><span className="t2">{a.state === 'idle' ? sub : `${a.did} · ${sub}`}</span></span>
          {a.state === 'waiting' && <span className="chip amber tiny">permiso</span>}
        </button>
        <button className="thread-x" aria-label={`Cerrar ${s.name}`} title="Cerrar sesión" onClick={() => onClose(s.id)}><Icon name="close" size={10} /></button>
      </div>
    );
  };
  return (
    <aside className="sidebar tv threads-side" aria-label="Conversaciones">
      <div className="threads">
        <div className="ph">
          <h3 className="grow">Conversaciones</h3>
          <div className="threads-new" ref={newRef}>
            <button className="tbtn" onClick={() => setMenu(!menu)} aria-label="Nueva conversación" aria-expanded={menu} title="Nueva sesión (⌘T)"><Icon name="plus" size={14} /></button>
            {menu && (
              <div className="ctx threads-menu" role="menu">
                <button role="menuitem" onClick={() => { setMenu(false); onNew('codex'); }}><Icon name="chat" size={14} /><span className="grow">Sesión con Codex</span></button>
                <button role="menuitem" onClick={() => { setMenu(false); onNew('claude'); }}><Icon name="chat" size={14} /><span className="grow">Sesión con Claude</span></button>
                {!hasPm && <><hr /><button role="menuitem" onClick={() => { setMenu(false); onStartPm(); }}><Icon name="agent" size={14} /><span className="grow">Empezar con el Project manager</span></button></>}
              </div>
            )}
          </div>
        </div>
        <div className="scr" style={{ flex: 1 }} role="list">
          {!projectName ? <div className="threads-empty">Abre un proyecto para ver sus conversaciones.</div> : <>
            <div className="tgroup">Proyecto</div>
            {pm ? (
              <button className={`thread${view === 'coach' ? ' on' : ''}`} aria-current={view === 'coach'} onClick={() => onView('coach')}>
                <AgDot a={pm} /><span className="tx"><span className="t1">Project manager</span><span className="t2">{pm.state === 'idle' ? `Coordina ${projectName} · ${pmEngine}` : pm.did}</span></span>
                {pm.state === 'waiting' && <span className="chip amber tiny">permiso</span>}
              </button>
            ) : (
              <button className="thread ghost-thread" onClick={onStartPm}><span className="eng"><Icon name="agent" size={12} /></span><span className="tx"><span className="t1">Project manager</span><span className="t2">Empezar a coordinar {projectName}</span></span></button>
            )}
            {assigned.length > 0 && <><div className="tgroup">Sesiones de la tarea</div>{assigned.map(item)}</>}
            {isolated.length > 0 && <><div className="tgroup">Sesiones aisladas</div>{isolated.map(item)}</>}
            {direct.length > 0 && <><div className="tgroup">Directas</div>{direct.map(item)}</>}
            {!sessions.length && <div className="threads-empty">Sin sesiones abiertas. Crea una con <Icon name="plus" size={11} /> o deja que el PM reparta el trabajo.</div>}
          </>}
        </div>
        <div className="threads-foot">
          {footer}
          <button className="btn sm ghost" onClick={onProjects}><Icon name="folder" size={13} /> Proyectos y grupos</button>
        </div>
      </div>
    </aside>
  );
}
