import { useSyncExternalStore } from 'react';
import type { CliUpdate } from '../ipc.ts';

export type NotificationLevel = 'error' | 'warning' | 'info' | 'action' | 'success';

export type NotificationActionTarget = 'tools' | 'settings' | 'entrega' | 'home' | 'session';

export type NotificationAction = {
  label: string;
  target: NotificationActionTarget;
  session?: number | 'coach';
  project?: string;
};

export type NotificationEntry = {
  id: string;
  fingerprint: string;
  level: NotificationLevel;
  title: string;
  summary: string;
  details: string | null;
  diagnostics: readonly { at: number; text: string }[];
  count: number;
  createdAt: number;
  updatedAt: number;
  read: boolean;
  source: string | null;
  action: NotificationAction | null;
};

export type PushNotificationInput = {
  level: NotificationLevel;
  title: string;
  summary?: string;
  details?: string | null;
  fingerprint?: string;
  source?: string | null;
  action?: NotificationAction | null;
  ephemeral?: boolean;
};

export type NotificationSnapshot = {
  entries: readonly NotificationEntry[];
  ephemeralId: string | null;
  unreadCount: number;
  errorCount: number;
};

const MAX_HISTORY = 60;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 180);
}

/**
 * Almacén central de notificaciones operativas.
 * Agrupa errores repetidos por huella, conserva detalles técnicos para
 * diagnóstico y mantiene el aviso breve anclado junto a la campana.
 */
export class NotificationCenter {
  private entries: NotificationEntry[] = [];
  private ephemeralId: string | null = null;
  private seq = 1;
  private listeners = new Set<() => void>();
  private snapshot: NotificationSnapshot = {
    entries: [],
    ephemeralId: null,
    unreadCount: 0,
    errorCount: 0,
  };

  private emit() {
    let unreadCount = 0;
    let errorCount = 0;
    for (const e of this.entries) {
      if (!e.read) unreadCount++;
      if (!e.read && e.level === 'error') errorCount++;
    }
    this.snapshot = {
      entries: [...this.entries],
      ephemeralId: this.ephemeralId,
      unreadCount,
      errorCount,
    };
    this.listeners.forEach((l) => l());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  push(input: PushNotificationInput, now = Date.now()): NotificationEntry {
    const title = input.title.trim() || 'Aviso del sistema';
    const summary = (input.summary ?? title).trim();
    const details = input.details?.trim() ? input.details.trim() : null;
    const fingerprint = input.fingerprint ?? `${input.level}:${normalizeKey(title)}:${normalizeKey(summary)}`;

    const existingIndex = this.entries.findIndex((item) => item.fingerprint === fingerprint);
    let entry: NotificationEntry;
    if (existingIndex >= 0) {
      const existing = this.entries[existingIndex];
      const diagnostics = details && !existing.diagnostics.some((d) => d.text === details)
        ? [...existing.diagnostics, { at: now, text: details }] : existing.diagnostics;
      entry = {
        ...existing,
        title,
        summary,
        diagnostics,
        details: diagnostics.map((d, i) => `${i ? `— ${new Date(d.at).toLocaleString()} —\n` : ''}${d.text}`).join('\n\n') || null,
        action: input.action !== undefined ? input.action : existing.action,
        source: input.source !== undefined ? input.source : existing.source,
        count: existing.count + 1,
        updatedAt: now,
        read: false,
      };
      this.entries.splice(existingIndex, 1);
      this.entries.unshift(entry);
    } else {
      entry = {
        id: `n-${this.seq++}`,
        fingerprint,
        level: input.level,
        title,
        summary,
        details,
        diagnostics: details ? [{ at: now, text: details }] : [],
        count: 1,
        createdAt: now,
        updatedAt: now,
        read: false,
        source: input.source ?? null,
        action: input.action ?? null,
      };
      this.entries.unshift(entry);
      if (this.entries.length > MAX_HISTORY) this.entries.length = MAX_HISTORY;
    }

    if (input.ephemeral !== false) {
      this.ephemeralId = entry.id;
    }
    this.emit();
    return entry;
  }

  markRead(id: string) {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0 || this.entries[idx].read) return;
    this.entries[idx] = { ...this.entries[idx], read: true };
    if (this.ephemeralId === id) this.ephemeralId = null;
    this.emit();
  }

  markAllRead() {
    let changed = this.ephemeralId !== null;
    this.ephemeralId = null;
    this.entries = this.entries.map((e) => {
      if (e.read) return e;
      changed = true;
      return { ...e, read: true };
    });
    if (changed) this.emit();
  }

  dismiss(id: string) {
    const next = this.entries.filter((e) => e.id !== id);
    if (next.length === this.entries.length && this.ephemeralId !== id) return;
    this.entries = next;
    if (this.ephemeralId === id) this.ephemeralId = null;
    this.emit();
  }

  clear() {
    if (!this.entries.length && this.ephemeralId === null) return;
    this.entries = [];
    this.ephemeralId = null;
    this.emit();
  }

  dismissEphemeral() {
    if (this.ephemeralId === null) return;
    this.ephemeralId = null;
    this.emit();
  }
}

export const notificationCenter = new NotificationCenter();

export function useNotifications(): NotificationSnapshot {
  return useSyncExternalStore(notificationCenter.subscribe, notificationCenter.getSnapshot);
}

export function pushNotification(input: PushNotificationInput) {
  return notificationCenter.push(input);
}

/**
 * Clasifica un mensaje de error operativo y conserva el texto técnico completo
 * para diagnóstico desde el centro de notificaciones.
 */
export function pushOperationalError(raw: string, opts?: { source?: string; action?: NotificationAction | null }) {
  const clean = raw.trim();
  if (!clean) return null;
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? clean;
  const isWorktreeNote = first.startsWith('La rama ') && first.includes('se conserva');
  const title = first.length > 96 ? `${first.slice(0, 95)}…` : first;
  const hasDetails = lines.length > 1 || clean.length > 96;
  return notificationCenter.push({
    level: isWorktreeNote ? 'info' : 'error',
    title,
    summary: isWorktreeNote ? first : (opts?.source ? `${opts.source} · ${title}` : title),
    details: hasDetails ? clean : null,
    fingerprint: `${isWorktreeNote ? 'info' : 'error'}:${opts?.source ?? 'app'}:${normalizeKey(first)}`,
    source: opts?.source ?? null,
    action: opts?.action ?? (isWorktreeNote ? { label: 'Abrir Entrega', target: 'entrega' } : null),
  });
}

/**
 * Traduce el resultado de actualización automática de las CLI a notificaciones
 * agrupadas con todos los detalles técnicos de diagnóstico.
 */
export function cliUpdatesToNotifications(updates: readonly CliUpdate[]): PushNotificationInput[] {
  const out: PushNotificationInput[] = [];
  const failed = updates.filter((u) => u.outcome === 'failed');
  const updated = updates.filter((u) => u.outcome === 'updated');

  if (failed.length > 0) {
    const names = failed.map((u) => u.name).join(', ');
    const title = failed.length === 1
      ? `No se pudo actualizar ${failed[0].name}`
      : `No se pudieron actualizar ${failed.length} CLI (${names})`;
    const details = failed
      .map((u) => `[${u.name}]${u.from ? ` (actual: ${u.from})` : ''}\n${u.detail || 'Sin detalle adicional.'}`)
      .join('\n\n');
    out.push({
      level: 'error',
      title,
      summary: failed.map((u) => `${u.name}: ${u.detail || 'error al actualizar'}`).join(' · '),
      details,
      fingerprint: `cli-update-failed:${failed.map((u) => u.id).sort().join(',')}`,
      source: 'Actualización de CLI',
      action: { label: 'Diagnóstico y CLI', target: 'tools' },
    });
  }

  if (updated.length > 0) {
    const names = updated.map((u) => u.name).join(', ');
    const title = updated.length === 1
      ? `${updated[0].name} se ha actualizado`
      : `Se han actualizado ${updated.length} CLI`;
    const details = updated
      .map((u) => `${u.name}: ${u.from || '—'} → ${u.to ?? u.detail}`)
      .join('\n');
    out.push({
      level: 'info',
      title,
      summary: names,
      details,
      fingerprint: `cli-update-ok:${updated.map((u) => `${u.id}:${u.to ?? ''}`).sort().join(',')}`,
      source: 'Actualización de CLI',
      action: { label: 'Ver herramientas', target: 'tools' },
    });
  }

  return out;
}

export function pushCliUpdatesNotification(updates: readonly CliUpdate[]) {
  for (const item of cliUpdatesToNotifications(updates)) {
    notificationCenter.push(item);
  }
}

/** Called only on an explicit provider completion event, never on unmount/idle. */
export function pushAgentCompletion(project: string, session: number | 'coach', name: string) {
  return pushNotification({
    level: 'success', title: `${name} ha finalizado`, summary: 'Turno completado. La conversación conserva el resultado.',
    source: project.split(/[\\/]/).filter(Boolean).pop() ?? project,
    fingerprint: `agent-completed:${project}:${session}`,
    action: { label: 'Abrir conversación', target: 'session', session, project },
  });
}
