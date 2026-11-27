import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { health, tasks as taskApi, workSessions, type PrInfo, type Project, type Session, type Task, type WorkSession } from '../ipc';
import { Icon } from './icons';
import { ago } from './kit';
import {
  notificationCenter,
  useNotifications,
  type NotificationAction,
  type NotificationEntry,
  type NotificationLevel,
} from './notifications';
import { STATUS } from './taskMeta';
import { parsePmActivityKey } from './workspaceContext';

const ATTENTION = new Set(['waiting_approval', 'blocked', 'failed', 'paused_quota']);
type PendingItem = {
  key: string;
  icon: string;
  tone: 'warn' | 'bad' | 'mut';
  kind: 'permission' | 'ci' | 'pause' | 'review' | 'task';
  text: string;
  run: () => void;
};

const LEVEL_ICON: Record<NotificationLevel, string> = {
  error: 'warn',
  warning: 'warn',
  info: 'info',
  action: 'spark',
  success: 'check',
};

const LEVEL_LABEL: Record<NotificationLevel, string> = {
  error: 'Error',
  warning: 'Aviso',
  info: 'Info',
  action: 'Acción',
  success: 'Agente finalizado',
};

/**
 * Centro unificado de atención y notificaciones en la campana superior derecha.
 * - Mantiene siempre visibles en primer plano los permisos y bloqueos reales.
 * - Centraliza avisos operativos, errores de CLI y diagnósticos en historial.
 * - Muestra un aviso breve anclado junto a la campana (nunca sobre el Workspace).
 */
export default function Attention({
  project,
  projectName,
  projects,
  sessions,
  allSessions,
  activity,
  onSession,
  onTask,
  onEntrega,
  onHome,
  onTools,
  onSettings,
  onOverlayChange,
}: {
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
  onTools: () => void;
  onSettings: () => void;
  onOverlayChange?: (covered: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'error'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [list, setList] = useState<Task[]>([]);
  const [ci, setCi] = useState<PrInfo | null>(null);
  const [work, setWork] = useState<WorkSession | null>(null);
  const [toastHovered, setToastHovered] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { entries, ephemeralId, unreadCount, errorCount } = useNotifications();

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

  const ephemeral = !open && ephemeralId ? entries.find((e) => e.id === ephemeralId) ?? null : null;

  useEffect(() => {
    if (!ephemeral || toastHovered) return;
    const delay = ephemeral.level === 'error' ? 9000 : 6000;
    const timer = window.setTimeout(() => notificationCenter.dismissEphemeral(), delay);
    return () => window.clearTimeout(timer);
  }, [ephemeral, toastHovered]);

  useEffect(() => {
    onOverlayChange?.(open);
    return () => onOverlayChange?.(false);
  }, [open, onOverlayChange]);

  const projectNames = new Map((projects ?? []).map((p) => [p.path, p.name]));
  const nameOf = (p: string) => projectNames.get(p) ?? (p === project && projectName ? projectName : p.split(/[\\/]/).filter(Boolean).pop() ?? p);
  const globalSessions = allSessions ?? sessions;

  const pending: PendingItem[] = [];
  for (const [key, state] of Object.entries(activity)) {
    if (state !== 'permiso') continue;
    const pmProj = parsePmActivityKey(key);
    if (pmProj || key === 'coach') {
      const targetProject = pmProj ?? project;
      if (!targetProject) continue;
      pending.push({
        key: `p:${key}`,
        icon: 'warn',
        tone: 'warn',
        kind: 'permission',
        text: `${nameOf(targetProject)} · Project manager pide permiso`,
        run: () => onSession('coach', targetProject),
      });
      continue;
    }
    const s = globalSessions.find((x) => String(x.id) === key);
    if (!s) continue;
    const label = s.title?.trim() || s.name;
    pending.push({
      key: `p:${key}`,
      icon: 'warn',
      tone: 'warn',
      kind: 'permission',
      text: `${nameOf(s.project)} · ${label} pide permiso`,
      run: () => onSession(s.id, s.project),
    });
  }
  if (ci) pending.push({ key: 'ci', icon: 'close', tone: 'bad', kind: 'ci', text: `CI fallido en la PR #${ci.number} (${ci.branch})`, run: () => onEntrega('ci') });
  for (const s of globalSessions) if (s.paused) {
    const label = s.title?.trim() || s.name;
    const prefix = s.project !== project ? `${nameOf(s.project)} · ` : '';
    pending.push({ key: `z${s.id}`, icon: 'pause', tone: 'mut', kind: 'pause', text: `${prefix}${label} en pausa · ${s.paused}`, run: () => onSession(s.id, s.project) });
  }
  if (work?.state === 'review') pending.push({ key: 'w', icon: 'flow', tone: 'warn', kind: 'review', text: 'Sesión de trabajo lista para revisar', run: () => onEntrega('tarea') });
  for (const t of list) if (ATTENTION.has(t.status))
    pending.push({ key: `t${t.id}`, icon: t.status === 'paused_quota' ? 'pause' : t.status === 'failed' ? 'close' : 'lock', tone: t.status === 'failed' ? 'bad' : 'mut', kind: 'task', text: `#${t.id} ${STATUS[t.status]}: ${t.title}`, run: () => onTask(t.id) });

  const runAction = (action: NotificationAction) => {
    const target = action.target;
    setOpen(false);
    if (target === 'session' && action.session != null && action.project) onSession(action.session, action.project);
    else if (target === 'tools') onTools();
    else if (target === 'settings') onSettings();
    else if (target === 'entrega') onEntrega('tarea');
    else onHome();
  };

  const copyDiagnostic = (entry: NotificationEntry) => {
    const text = [entry.title, entry.summary !== entry.title ? entry.summary : '', entry.details ?? ''].filter(Boolean).join('\n\n');
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(entry.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === entry.id ? null : cur)), 1600);
    }).catch(() => setCopiedId('failed'));
  };

  const totalBadge = pending.length + unreadCount;
  const hasUrgent = pending.some((i) => i.tone !== 'mut') || errorCount > 0;
  const hasErrorsInHistory = entries.some((e) => e.level === 'error');
  const visibleHistory = filter === 'error' ? entries.filter((e) => e.level === 'error') : entries;

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) notificationCenter.dismissEphemeral();
  };

  return (
    <div className="attn-wrap" ref={root}>
      <button
        className={`tb-btn tb-attention${open ? ' is-on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={totalBadge ? `Notificaciones y atención · ${totalBadge} pendientes` : 'Notificaciones y atención'}
        title={totalBadge ? `${totalBadge} ${totalBadge === 1 ? 'aviso pendiente' : 'avisos pendientes'}` : 'Notificaciones'}
        onClick={toggleOpen}
      >
        <Icon name="bell" size={15} />
        {totalBadge > 0 && (
          <span className={`attn-count${hasUrgent ? ' is-urgent' : ''}`} aria-hidden="true">
            {totalBadge > 9 ? '9+' : totalBadge}
          </span>
        )}
      </button>

      {/* Aviso breve anclado junto a la campana (nunca sobre las conversaciones) */}
      {ephemeral && (
        <div
          className={`attn-toast is-${ephemeral.level}`}
          role={ephemeral.level === 'error' ? 'alert' : 'status'}
          onMouseEnter={() => setToastHovered(true)}
          onMouseLeave={() => setToastHovered(false)}
        >
          <span className="attn-toast-ico"><Icon name={LEVEL_ICON[ephemeral.level]} size={13} /></span>
          <button
            type="button"
            className="attn-toast-main"
            onClick={() => { notificationCenter.dismissEphemeral(); setOpen(true); }}
          >
            <span className="attn-toast-title">
              <span>{ephemeral.title}</span>
              {ephemeral.count > 1 && <span className="attn-repeat">×{ephemeral.count}</span>}
            </span>
            {ephemeral.summary !== ephemeral.title && (
              <span className="attn-toast-sub">{ephemeral.summary}</span>
            )}
          </button>
          <button
            type="button"
            className="attn-toast-close"
            aria-label="Ocultar aviso"
            onClick={() => notificationCenter.dismissEphemeral()}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      )}

      {open && (
        <div className="attn-menu" role="dialog" aria-label="Centro de notificaciones y atención">
          <div className="attn-top">
            <span className="attn-top-title">Notificaciones</span>
            {unreadCount > 0 && <span className="attn-unread">{unreadCount} sin leer</span>}
            <button type="button" className="attn-mini-btn" aria-label="Cerrar notificaciones" onClick={() => setOpen(false)}>
              <Icon name="close" size={12} />
            </button>
          </div>

          {pending.length > 0 && (
            <section className="attn-pending" aria-label="Requiere tu atención">
              <div className="attn-sec-head"><span className="attn-head">Requiere tu atención · {pending.length}</span></div>
              {pending.map((i) => (
                <button key={i.key} type="button" className={`attn-item is-${i.tone}${i.kind === 'permission' ? ' is-perm' : ''}`}
                  onClick={() => { setOpen(false); i.run(); }}>
                  <Icon name={i.icon} size={14} /><span>{i.text}</span>
                </button>
              ))}
            </section>
          )}

          <div className="attn-scroll" aria-label="Historial de notificaciones">
            {visibleHistory.length === 0 ? (
              <p className="attn-empty">{filter === 'error' ? 'Sin errores.' : 'Sin notificaciones.'}</p>
            ) : visibleHistory.map((entry) => (
              <details key={entry.id} className={`attn-entry is-${entry.level}${entry.read ? ' is-read' : ' is-unread'}`}
                onToggle={(e) => { if (e.currentTarget.open) notificationCenter.markRead(entry.id); }}>
                <summary className="attn-entry-row">
                  <span className="attn-entry-ico"><Icon name={LEVEL_ICON[entry.level]} size={13} /></span>
                  <span className="attn-entry-body">
                    <span className="attn-entry-head">
                      <span className="attn-entry-title">{entry.title}</span>
                      {entry.count > 1 && <span className="attn-repeat" title={`${entry.count} ocurrencias agrupadas`}>×{entry.count}</span>}
                      <time className="attn-entry-time" dateTime={new Date(entry.updatedAt).toISOString()}
                        title={new Date(entry.updatedAt).toLocaleString()}>{ago(entry.updatedAt)}</time>
                    </span>
                    {entry.summary !== entry.title && <span className="attn-entry-summary">{entry.summary}</span>}
                    <span className="attn-entry-meta"><span>{LEVEL_LABEL[entry.level]}</span>{entry.source && <span>· {entry.source}</span>}</span>
                  </span>
                  <span className="attn-entry-chevron" aria-hidden="true">›</span>
                </summary>
                <div className="attn-expanded">
                  {entry.title.length > 42 && <strong className="attn-full-summary">{entry.title}</strong>}
                  {entry.summary !== entry.title && <p className="attn-full-summary">{entry.summary}</p>}
                  <div className="attn-entry-meta">{new Date(entry.updatedAt).toLocaleString()}
                    {entry.count > 1 && ` · Primera: ${new Date(entry.createdAt).toLocaleString()}`}</div>
                  {entry.details && <div className="attn-details"><pre aria-label="Detalles técnicos">{entry.details}</pre></div>}
                  <div className="attn-entry-actions">
                    {entry.action && <button type="button" className="attn-act is-primary"
                      onClick={() => runAction(entry.action!)}>{entry.action.label}</button>}
                    {entry.details && <button type="button" className="attn-act" onClick={() => copyDiagnostic(entry)}>
                      {copiedId === entry.id ? 'Copiado' : 'Copiar diagnóstico'}</button>}
                    <button type="button" className="attn-act" onClick={() => notificationCenter.dismiss(entry.id)}>Descartar</button>
                    {copiedId === 'failed' && <span role="status">No se pudo copiar el diagnóstico.</span>}
                  </div>
                </div>
              </details>
            ))}
          </div>
          {entries.length > 0 && <div className="attn-footer">
            {hasErrorsInHistory && <button type="button" className="attn-mini-btn" aria-pressed={filter === 'error'}
              onClick={() => setFilter(filter === 'all' ? 'error' : 'all')}>{filter === 'all' ? 'Solo errores' : 'Ver todo'}</button>}
            <span className="grow" />
            <button type="button" className="attn-mini-btn" disabled={!unreadCount} onClick={() => notificationCenter.markAllRead()}>Marcar leídas</button>
            <button type="button" className="attn-mini-btn" onClick={() => { notificationCenter.clear(); setFilter('all'); }}>Limpiar historial</button>
          </div>}

        </div>
      )}
    </div>
  );
}
