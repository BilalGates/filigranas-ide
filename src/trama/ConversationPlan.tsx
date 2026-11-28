import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { tasks, type Session, type Task } from '../ipc';
import { dependencyLevels } from './graph';
import { ConversationCard } from './ConversationCards';
import { AgDot, sessionAgents, useAgentsActivity } from './kit';
import { Icon } from './icons';

const HEIGHT = 140;
const COLORS: Record<string, string> = {
  done: 'var(--mint)', running: 'var(--violet)', waiting_approval: 'var(--amber)',
  blocked: 'var(--coral)', verifying: 'var(--skyhi)', failed: 'var(--coral)',
};

export function useConversationTasks(project: string | null) {
  const [snapshot, setSnapshot] = useState<{ project: string; items: Task[]; limit: number | null } | null>(null);
  const current = snapshot?.project === project ? snapshot : null;
  useEffect(() => {
    if (!project) return;
    let alive = true;
    let generation = 0;
    let timer = 0;
    const load = () => {
      const request = ++generation;
      void Promise.all([tasks.list(project), tasks.parallelLimit(project).catch(() => null)]).then(([items, limit]) => {
        if (alive && request === generation) setSnapshot({ project, items, limit });
      }, () => {});
    };
    const unlisten = listen('tasks-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 140);
    });
    timer = window.setTimeout(load);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      void unlisten.then((off) => off());
    };
  }, [project]);
  return current;
}

export default function ConversationPlan({ items, limit, onOpen }: { items: Task[]; limit: number | null; onOpen: (task?: number) => void }) {
  const [width, setWidth] = useState(0);
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!preview.current) return;
    const resize = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    resize.observe(preview.current);
    return () => resize.disconnect();
  }, [items.length > 0]);

  const model = useMemo(() => {
    const shown = items.slice(0, 8);
    const levels = dependencyLevels(shown.map((task) => ({ id: String(task.id), deps: task.dependencies.map(String) })));
    const columns = new Map<number, Task[]>();
    for (const task of shown) {
      const level = levels.get(String(task.id)) ?? 0;
      const slot = columns.get(level) ?? [];
      slot.push(task);
      columns.set(level, slot);
    }
    const last = Math.max(1, ...columns.keys());
    return new Map([...columns].flatMap(([level, group]) => group.map((task, i) => [task.id, {
      task, x: Math.min(100, width / 4) + Math.max(0, width - Math.min(200, width / 2)) * level / last, y: HEIGHT * (i + 1) / (group.length + 1),
    }] as const)));
  }, [items, width]);

  if (!items.length) return null;
  return (
    <ConversationCard label="Plan de trabajo" icon="flow" title={`Plan · ${items.length} ${items.length === 1 ? 'tarea' : 'tareas'}`}
      detail={limit != null && <span className="muted">{limit} en paralelo</span>}
      action={<button className="co-btn" onClick={() => onOpen()}>Abrir en Flow <Icon name="chev" size={13} /></button>}>
      <div ref={preview} className="co-plan-graph">
        {width > 48 && <svg width={width} height={HEIGHT} aria-label="Dependencias del plan">
          {[...model.values()].flatMap((end) => end.task.dependencies.flatMap((id) => {
            const start = model.get(id);
            if (!start) return [];
            const middle = (start.x + end.x) / 2;
            const live = start.task.status === 'done' && end.task.status === 'running';
            return [<path key={`${id}:${end.task.id}`} className={live ? 'is-live' : ''} d={`M${start.x},${start.y} C${middle},${start.y} ${middle},${end.y} ${end.x},${end.y}`} />];
          }))}
          {[...model.values()].map(({ task, x, y }) => {
            const color = COLORS[task.status] ?? 'var(--tx3)';
            return <g key={task.id} role="button" tabIndex={0} aria-label={task.title}
              onClick={() => onOpen(task.id)} onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onOpen(task.id);
              }}>
              <circle cx={x} cy={y} r={12} fill="transparent" />
              <circle cx={x} cy={y} r={5} fill={COLORS[task.status] && task.status !== 'blocked' ? color : 'var(--ink1)'} stroke={color} strokeWidth={1.4} />
              <text x={x} y={y - 10} textAnchor="middle">{task.title.split(/\s+/).slice(0, 2).join(' ').slice(0, 18)}</text>
              <title>{task.title}</title>
            </g>;
          })}
        </svg>}
      </div>
    </ConversationCard>
  );
}

export type ConversationWorkflow = {
  sessions: Session[];
  onOpenFlow: (task?: number) => void;
  onSession: (id: number) => void;
  onObserve: (id: number) => void;
};

const IN_FLIGHT = new Set(['running', 'verifying', 'waiting_approval']);
export function ConversationTeam({ items, sessions, onObserve, onSession }: { items: Task[] } & ConversationWorkflow) {
  const activity = useAgentsActivity();
  const linked = new Map<number, Task>();
  const children = new Map<number, { done: number; total: number }>();
  for (const item of items) {
    if (item.parentId != null && item.status !== 'cancelled') {
      const count = children.get(item.parentId) ?? { done: 0, total: 0 };
      count.total++;
      if (item.status === 'done') count.done++;
      children.set(item.parentId, count);
    }
    for (const session of item.sessions) {
      const active = activity[String(session.id)];
      if (!session.closed && !linked.has(session.id) && (active || IN_FLIGHT.has(item.status))) linked.set(session.id, item);
    }
  }
  const rows = sessionAgents(sessions, activity, null).flatMap((agent) => {
    const task = agent.session == null ? undefined : linked.get(agent.session);
    return agent.session != null && task ? [{ agent, task, id: agent.session }] : [];
  });

  if (!rows.length) return null;
  return <section className="tv co-team" aria-label="Actividad de las tareas">
    {rows.slice(0, 8).map(({ agent, task, id }) => {
      const count = children.get(task.id);
      const filled = count ? Math.round(10 * count.done / count.total) : Number(task.status === 'done') * 10;
      const progress = count ? `${count.done} de ${count.total} subtareas terminadas` : 'Sin subtareas para medir el avance';
      return <div className="co-team-row" key={id}>
        <AgDot a={agent} />
        <div><div>{agent.name} <span className="mut">· {task.title}</span></div><div className="co-team-status">{agent.did}</div></div>
        <div className="row co-team-actions">
          <span className="prog" role="img" aria-label={progress} title={progress}>
            {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < filled ? 'f' : undefined} />)}
          </span>
          <button className="btn sm" onClick={() => onObserve(id)}><Icon name="eye" size={13} /> Observar<span className="sr-only"> {task.title}</span></button>
          <button className="btn sm ghost" onClick={() => onSession(id)}>Entrar<span className="sr-only"> {agent.name}</span></button>
        </div>
      </div>;
    })}
  </section>;
}
