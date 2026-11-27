import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { health, tasks as taskApi, workSessions, type PrInfo, type Project, type Session, type Task, type WorkSession } from '../ipc';
import { Icon } from './icons';
import { ago } from './kit';
import {
  notificationCenter,
  useNotifications,
  type NotificationActionTarget,
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
};

const LEVEL_LABEL: Record<NotificationLevel, string> = {
  error: 'Error',
  warning: 'Aviso',
  info: 'Info',
  action: 'Acción',
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
  for (const t of list) if (ATTENTION.has(t.status) && t.status !== 'waiting_approval')
    pending.push({ key: `t${t.id}`, icon: t.status === 'paused_quota' ? 'pause' : t.status === 'failed' ? 'close' : 'lock', tone: t.status === 'failed' ? 'bad' : 'mut', kind: 'task', text: `#${t.id} ${STATUS[t.status]}: ${t.title}`, run: () => onTask(t.id) });

  const runAction = (target: NotificationActionTarget) => {
    setOpen(false);
    if (target === 'tools') onTools();
    else if (target === 'settings') onSettings();
    else if (target === 'entrega') onEntrega('tarea');
    else onHome();
  };

  const copyDiagnostic = (entry: NotificationEntry) => {
    const text = [entry.title, entry.summary !== entry.title ? entry.summary : '', entry.details ?? ''].filter(Boolean).join('\n\n');
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(entry.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === entry.id ? null : cur)), 1600);
    });
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
            <span className="attn-head">Notificaciones</span>
            <div className="attn-top-actions">
              {unreadCount > 0 && (
                <button type="button" className="attn-mini" onClick={() => notificationCenter.markAllRead()}>
                  Marcar leídas
                </button>
              )}
              {entries.length > 0 && (
                <button type="button" className="attn-mini" onClick={() => notificationCenter.clear()}>
                  Limpiar
                </button>
              )}
            </div>
          </div>

          <div className="attn-scroll">
            {/* 1. Permisos y acciones que requieren autorización: siempre arriba y visibles */}
            {pending.length > 0 && (
              <section className="attn-sec" aria-label="Requiere tu atención">
                <div className="attn-sec-lab">Requiere tu atención</div>
                {pending.map((i) => (
                  <button
                    key={i.key}
                    type="button"
                    className={`attn-item is-${i.tone}${i.kind === 'permission' ? ' is-perm' : ''}`}
                    onClick={() => { setOpen(false); i.run(); }}
                  >
                    <Icon name={i.icon} size={14} />
                    <span>{i.text}</span>
                  </button>
                ))}
              </section>
            )}

            {/* 2. Historial de notificaciones operativas y diagnósticos */}
            <section className="attn-sec" aria-label="Historial de avisos">
              {entries.length > 0 && (
                <div className="attn-sec-bar">
                  <span className="attn-sec-lab">Historial</span>
                  {hasErrorsInHistory && entries.some((e) => e.level !== 'error') && (
                    <div className="attn-tabs" role="tablist" aria-label="Filtrar notificaciones">
                      <button type="button" role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'is-on' : ''} onClick={() => setFilter('all')}>
                        Todo
                      </button>
                      <button type="button" role="tab" aria-selected={filter === 'error'} className={filter === 'error' ? 'is-on' : ''} onClick={() => setFilter('error')}>
                        Errores
                      </button>
                    </div>
                  )}
                </div>
              )}

              {visibleHistory.length === 0 ? (
                pending.length === 0 && (
                  <p className="attn-empty">Sin notificaciones ni asuntos pendientes en {projectName ?? 'el espacio de trabajo'}.</p>
                )
              ) : (
                <div className="attn-list">
                  {visibleHistory.map((entry) => (
                    <article
                      key={entry.id}
                      className={`attn-entry is-${entry.level}${entry.read ? ' is-read' : ''}`}
                    >
                      <div className="attn-entry-row">
                        <span className="attn-entry-ico"><Icon name={LEVEL_ICON[entry.level]} size={13} /></span>
                        <div className="attn-entry-body">
                          <div className="attn-entry-head">
                            <span className="attn-entry-title">{entry.title}</span>
                            {entry.count > 1 && <span className="attn-repeat" title={`${entry.count} ocurrencias agrupadas`}>×{entry.count}</span>}
                            <span className="attn-entry-time">{ago(entry.updatedAt)}</span>
                          </div>
                          <div className="attn-entry-meta">
                            <span className={`attn-level is-${entry.level}`}>{LEVEL_LABEL[entry.level]}</span>
                            {entry.source && <span>{entry.source}</span>}
                          </div>
                          {entry.summary !== entry.title && (
                            <p className="attn-entry-summary">{entry.summary}</p>
                          )}
                          {entry.details && (
                            <details className="attn-details" onToggle={(e) => { if (e.currentTarget.open) notificationCenter.markRead(entry.id); }}>
                              <summary>Detalles técnicos</summary>
                              <pre>{entry.details}</pre>
                            </details>
                          )}
                          <div className="attn-entry-actions">
                            {entry.action && (
                              <button
                                type="button"
                                className="attn-act"
                                onClick={() => { notificationCenter.markRead(entry.id); runAction(entry.action!.target); }}
                              >
                                {entry.action.label}
                              </button>
                            )}
                            {entry.details && (
                              <button type="button" className="attn-act is-subtle" onClick={() => copyDiagnostic(entry)}>
                                {copiedId === entry.id ? 'Copiado' : 'Copiar diagnóstico'}
                              </button>
                            )}
                            {!entry.read && (
                              <button type="button" className="attn-act is-subtle" onClick={() => notificationCenter.markRead(entry.id)}>
                                Leída
                              </button>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="attn-entry-dismiss"
                          aria-label={`Descartar ${entry.title}`}
                          onClick={() => notificationCenter.dismiss(entry.id)}
                        >
                          <Icon name="close" size={11} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>

          <button type="button" className="attn-foot" onClick={() => { setOpen(false); onHome(); }}>
            Ver todos los proyectos en Inicio
          </button>
        </div>
      )}
    </div>
  );
}
