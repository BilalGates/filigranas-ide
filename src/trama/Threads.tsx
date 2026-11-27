import type { ReactNode } from 'react';
import type { Session } from '../ipc';
import { useUi } from '../ui';
import { Icon } from './icons';
import { AgDot, sessionAgents } from './kit';

// Columna «Conversaciones» del Workspace de Trama v2: PM, trabajo, sesiones
// de tareas, directas y subsesiones delegadas del proyecto abierto, con su
// estado real. El árbol completo de proyectos sigue a un clic.
export default function Threads({ project, projectName, view, hasPm, pmEngine, pmSessionId, sessions, onView, onNew, onStartPm, onClose, onProjects, footer }: {
  project?: string | null;
  projectName: string | null;
  view: 'coach' | number;
  hasPm: boolean;
  pmEngine: string;
  pmSessionId?: number | null;
  sessions: Session[];
  onView: (v: 'coach' | number) => void;
  onNew: () => void;
  onStartPm: () => void;
  onClose: (id: number) => void;
  onProjects: () => void;
  footer?: ReactNode;
}) {
  const { activity } = useUi();
  const agents = sessionAgents(sessions, activity, hasPm ? { engine: pmEngine } : null, project);
  const pm = agents.find((a) => a.id === 'pm');
  const roots = sessions.filter((s) => s.parentSession == null);
  const childrenByParent = new Map<number, Session[]>();
  const orphanChildren: Session[] = [];
  for (const s of sessions) {
    if (s.parentSession == null) continue;
    const knownParent = s.parentSession === pmSessionId || roots.some((r) => r.id === s.parentSession);
    if (!knownParent) {
      orphanChildren.push(s);
      continue;
    }
    const list = childrenByParent.get(s.parentSession) ?? [];
    list.push(s);
    childrenByParent.set(s.parentSession, list);
  }
  const assigned = roots.filter((s) => s.task);
  const isolated = roots.filter((s) => s.worktree && !s.task);
  const direct = roots.filter((s) => !s.worktree && !s.task);

  const subitem = (s: Session) => {
    const a = agents.find((x) => x.session === s.id)!;
    const title = s.title?.trim() || s.task?.split('\n')[0]?.trim() || s.name;
    const statusText = a.state === 'working' ? 'trabajando' : a.state === 'waiting' ? 'en espera · permiso' : a.state === 'done' ? 'terminada' : 'en espera';
    const meta = `${statusText} · ${a.engine}`;
    return (
      <div key={s.id} className="thread-wrap is-sub">
        <button className={`thread thread-sub${view === s.id ? ' on' : ''}`} aria-current={view === s.id} onClick={() => onView(s.id)} title={`${title} (${s.name}) · ${meta}`}>
          <AgDot a={a} s={12} />
          <span className="tx"><span className="t1">{title}</span><span className="t2">{meta}</span></span>
          {a.state === 'waiting' && <span className="chip amber tiny">permiso</span>}
        </button>
        <button className="thread-x" aria-label={`Cerrar ${title}`} title="Cerrar subsesión" onClick={() => onClose(s.id)}><Icon name="close" size={10} /></button>
      </div>
    );
  };

  const renderChildren = (parentId: number | null | undefined) => {
    if (parentId == null) return null;
    const kids = childrenByParent.get(parentId);
    if (!kids?.length) return null;
    return <div className="subthreads" role="group" aria-label="Subsesiones">{kids.map(subitem)}</div>;
  };

  const item = (s: Session) => {
    const a = agents.find((x) => x.session === s.id)!;
    const first = s.task?.split('\n')[0]?.trim();
    const sub = first ? (first.length > 48 ? `${first.slice(0, 47)}…` : first) : s.branch ? s.branch : 'sin encargo';
    return (
      <div key={s.id} className="thread-branch">
        <div className="thread-wrap">
          <button className={`thread${view === s.id ? ' on' : ''}`} aria-current={view === s.id} onClick={() => onView(s.id)} title={`${a.name} · ${sub}`}>
            <AgDot a={a} />
            <span className="tx"><span className="t1">{a.name}</span><span className="t2">{a.state === 'idle' ? sub : `${a.did} · ${sub}`}</span></span>
            {a.state === 'waiting' && <span className="chip amber tiny">permiso</span>}
          </button>
          <button className="thread-x" aria-label={`Cerrar ${s.name}`} title="Cerrar sesión" onClick={() => onClose(s.id)}><Icon name="close" size={10} /></button>
        </div>
        {renderChildren(s.id)}
      </div>
    );
  };
  return (
    <aside className="sidebar tv threads-side" aria-label="Conversaciones">
      <div className="threads">
        <div className="ph">
          <h3 className="grow">Conversaciones</h3>
          <button className="tbtn" onClick={onNew} disabled={!projectName} aria-label="Nueva conversación" title="Nueva sesión (⌘T)"><Icon name="plus" size={14} /></button>
        </div>
        <div className="scr" style={{ flex: 1 }} role="list">
          {!projectName ? <div className="threads-empty">Abre un proyecto para ver sus conversaciones.</div> : <>
            <div className="tgroup">Proyecto</div>
            {pm ? (
              <div className="thread-branch">
                <button className={`thread${view === 'coach' ? ' on' : ''}`} aria-current={view === 'coach'} onClick={() => onView('coach')}>
                  <AgDot a={pm} /><span className="tx"><span className="t1">Project manager</span><span className="t2">{pm.state === 'idle' ? `Coordina ${projectName} · ${pmEngine}` : pm.did}</span></span>
                  {pm.state === 'waiting' && <span className="chip amber tiny">permiso</span>}
                </button>
                {renderChildren(pmSessionId)}
              </div>
            ) : (
              <button className="thread ghost-thread" onClick={onStartPm}><span className="eng"><Icon name="agent" size={12} /></span><span className="tx"><span className="t1">Project manager</span><span className="t2">Empezar a coordinar {projectName}</span></span></button>
            )}
            {assigned.length > 0 && <><div className="tgroup">Sesiones de la tarea</div>{assigned.map(item)}</>}
            {isolated.length > 0 && <><div className="tgroup">Sesiones aisladas</div>{isolated.map(item)}</>}
            {direct.length > 0 && <><div className="tgroup">Directas</div>{direct.map(item)}</>}
            {orphanChildren.length > 0 && <><div className="tgroup">Subsesiones</div>{orphanChildren.map(subitem)}</>}
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
