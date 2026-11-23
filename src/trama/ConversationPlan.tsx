import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { tasks, type Task } from '../ipc';
import { dependencyLevels } from './graph';
import { Icon } from './icons';

const HEIGHT = 120;
const COLORS: Record<string, string> = {
  done: 'var(--mint)', running: 'var(--violet)', waiting_approval: 'var(--amber)',
  blocked: 'var(--coral)', verifying: 'var(--skyhi)', failed: 'var(--coral)',
};

export default function ConversationPlan({ project, onOpen }: { project: string; onOpen: (task?: number) => void }) {
  const [items, setItems] = useState<Task[]>([]);
  const [width, setWidth] = useState(0);
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let timer = 0;
    const load = () => {
      const request = ++generation;
      void tasks.list(project).then((next) => {
        if (alive && request === generation) setItems(next);
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
      task, x: 24 + (width - 48) * level / last, y: HEIGHT * (i + 1) / (group.length + 1),
    }] as const)));
  }, [items, width]);

  if (!items.length) return null;
  return (
    <section className="co-rich-plan" aria-label="Plan de trabajo">
      <div className="co-plan-head">
        <Icon name="flow" size={14} /><b>Plan · {items.length} {items.length === 1 ? 'tarea' : 'tareas'}</b>
        <button className="co-btn" onClick={() => onOpen()}>Abrir en Flow <Icon name="chev" size={13} /></button>
      </div>
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
    </section>
  );
}
