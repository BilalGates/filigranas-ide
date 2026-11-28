export type FlowStatus = 'backlog' | 'running' | 'verifying' | 'review' | 'ready_to_merge' | 'waiting' | 'blocked' | 'failed' | 'cancelled' | 'done' | 'paused_quota' | 'queued' | 'pending' | 'waiting_dependencies' | 'interrupted';
/** Preserve backend lifecycle distinctions; never infer success from cancellation. */
export function flowStatus(status: string, phase?: string): FlowStatus {
    if (phase) {
        if (phase === 'waiting_permission')
            return 'waiting';
        if (['pending', 'queued', 'waiting_dependencies', 'interrupted'].includes(phase))
            return phase as FlowStatus;
        if (['running', 'verifying', 'done', 'cancelled', 'blocked', 'failed'].includes(phase))
            return phase as FlowStatus;
    }
    switch (status) {
        case 'running':
        case 'verifying':
        case 'review':
        case 'ready_to_merge':
        case 'blocked':
        case 'failed':
        case 'cancelled':
        case 'done':
        case 'paused_quota': return status;
        case 'waiting_approval': return 'waiting';
        default: return 'backlog';
    }
}
export function flowProgress(tasks: {
    status: string;
}[]) { const done = tasks.filter((t) => t.status === 'done').length; return { done, total: tasks.length, percent: tasks.length ? Math.round(100 * done / tasks.length) : 0 }; }
export function validSelection(id: string, tasks: string[], agents: string[], runs: string[]) { return tasks.includes(id) || agents.includes(id) || runs.includes(id); }
export function placeInspector(width: number, height: number, w: number, h: number, a: {
    x: number;
    y: number;
    width: number;
    height: number;
} | null) {
    const clamp = (v: number, max: number) => Math.max(8, Math.min(v, Math.max(8, max - 8)));
    const right = a ? a.x + a.width + 12 : width - w - 12;
    return { x: clamp(a && right + w > width - 8 ? a.x - w - 12 : right, width - w), y: clamp(a?.y ?? 12, height - h) };
}
export function inspectorKey(key: string, ids: string[], current: string | null) {
    const at = current ? ids.indexOf(current) : -1;
    if (key === 'Escape')
        return null;
    if (key === 'ArrowDown')
        return ids[Math.min(ids.length - 1, at + 1)] ?? current;
    if (key === 'ArrowUp')
        return ids[Math.max(0, at - 1)] ?? current;
    return current;
}
export function taskSelection(project: string | null, selection: {
    project: string | null;
    id: string;
} | null, tasks: string[], agents: string[], runs: string[]) { return selection?.project === project && validSelection(selection.id, tasks, agents, runs) ? selection.id : null; }
/** Stable geometry independent of status/model/selection updates. */
export function flowPositions(tasks: {
    id: string;
    agent: string;
    lvl: number;
}[], agents: string[], lens: 'exec' | 'deps') {
    const lanes = new Map<string, number>(), positions = new Map<string, {
        x: number;
        y: number;
    }>(), counts = new Map<string, number>(), rows = new Map<string, number>(), levels = new Map<number, number>();
    for (const t of tasks) {
        const key = `${t.agent}:${t.lvl}`, n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        rows.set(t.agent, Math.max(rows.get(t.agent) ?? 1, n));
        levels.set(t.lvl, (levels.get(t.lvl) ?? 0) + 1);
    }
    let y = 0;
    for (const id of agents) {
        lanes.set(id, y);
        y += 76 + ((rows.get(id) ?? 1) - 1) * 70;
    }
    counts.clear();
    for (const t of tasks) {
        const key = lens === 'exec' ? `${t.agent}:${t.lvl}` : String(t.lvl), n = counts.get(key) ?? 0;
        counts.set(key, n + 1);
        positions.set(t.id, { x: (lens === 'exec' ? 160 : 40) + t.lvl * 306 + 100, y: lens === 'exec' ? (lanes.get(t.agent) ?? y) + n * 70 : (n - ((levels.get(t.lvl) ?? 1) - 1) / 2) * 80 });
    }
    return { lanes, tasks: positions };
}
