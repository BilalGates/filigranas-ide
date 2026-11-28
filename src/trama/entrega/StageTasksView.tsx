import WorkSession from '../../WorkSession';
import type { Task, WorkSession as Work } from '../../ipc';
import { Icon } from '../icons';

type Props = {
  project: string;
  work: Work | null;
  tasks: Task[];
  onGoPr: () => void;
};

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Pendiente',
  ready: 'Lista',
  in_progress: 'En curso',
  running: 'Ejecutando',
  review: 'Verificación',
  blocked: 'Bloqueada',
  done: 'Cerrada',
  cancelled: 'Cancelada',
};

export function StageTasksView({ project, work, tasks, onGoPr }: Props) {
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const closed = tasks.filter((t) => t.status === 'done');

  return (
    <div className="ent-op-scroll">
      <section className="ent-sec">
        <div className="ent-sec-bar">
          <Icon name="flow" size={12} />
          <strong>Sesión de trabajo</strong>
          {work && <span className="ent-mono-meta mono">{work.branch} · {work.state}</span>}
        </div>
        <div className="legacy ent-legacy-wrap">
          <WorkSession
            key={project}
            project={project}
            hidden={false}
            onReview={(ready) => {
              if (ready) onGoPr();
            }}
          />
        </div>
      </section>

      <section className="ent-sec">
        <div className="ent-sec-bar">
          <Icon name="tasks" size={12} />
          <strong>Tareas del proyecto</strong>
          <span className="ent-mono-meta mono">{open.length} abiertas · {closed.length} cerradas</span>
        </div>

        {open.length === 0 ? (
          <p className="ent-empty-inline">Sin tareas abiertas en este proyecto.</p>
        ) : (
          <div className="ent-list">
            {open.slice(0, 20).map((task) => {
              const blocked = task.status === 'blocked' || task.waitingFor.length > 0;
              const branches = [...new Set(task.sessions.map((s) => s.branch).filter(Boolean))];
              return (
                <div key={task.id} className="ent-list-row">
                  <span className={`ent-dot-sm tone-${blocked ? 'amber' : task.status === 'running' || task.status === 'in_progress' ? 'sky' : 'mut'}`} />
                  <div className="ent-list-main">
                    <span className="ent-list-title">
                      <span className="mono mut">#{task.id}</span> {task.title}
                    </span>
                    {branches.length > 0 && (
                      <span className="ent-list-sub mono">{branches.join(' · ')}</span>
                    )}
                  </div>
                  <span className={`ent-inline-tag tone-${blocked ? 'amber' : 'mut'}`}>
                    {STATUS_LABEL[task.status] ?? task.status}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
