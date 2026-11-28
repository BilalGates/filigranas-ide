import { useEffect, useState, useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { providers, type ProviderHealth, coordinator, type CoordinatorEvent, type RateLimits, type SessionEvent } from './ipc';

type Engine = import('./providers').ExecutionProvider;
export const LOW_REMAINING = 10;
export type QuotaWindow = { label: string; percent: number; resetsAt: number | null };
type Snapshot = { observedAt: number; windows: QuotaWindow[]; blockedUntil: number | null; warningUntil: number | null };

const EMPTY: Snapshot = { observedAt: 0, windows: [], blockedUntil: null, warningUntil: null };
const CLAUDE_KEY = 'filigranas.claude-quota';
const nowSeconds = () => Date.now() / 1000;

function loadClaude(): Snapshot {
  try {
    const saved = JSON.parse(localStorage.getItem(CLAUDE_KEY) ?? '[]');
    const windows: QuotaWindow[] = Array.isArray(saved) ? saved : saved.windows;
    return {
      observedAt: Number.isFinite(saved.observedAt) ? saved.observedAt : 0,
      windows: windows.filter((w) => Number.isFinite(w.percent) && w.resetsAt != null && w.resetsAt > nowSeconds()),
      blockedUntil: Number.isFinite(saved.blockedUntil) ? saved.blockedUntil : null,
      warningUntil: Number.isFinite(saved.warningUntil) ? saved.warningUntil : null,
    };
  } catch {
    return EMPTY;
  }
}

let limits: Record<Engine, Snapshot> = { codex: EMPTY, claude: loadClaude(), agy: EMPTY };
const listeners = new Set<() => void>();
let health: Record<string, ProviderHealth> = {};
function reportHealth(value: ProviderHealth) {
  health = { ...health, [value.id]: value };
  limits = { ...limits };
  listeners.forEach((notify) => notify());
}

function report(engine: Engine, snapshot: Snapshot) {
  limits = { ...limits, [engine]: snapshot };
  listeners.forEach((notify) => notify());
}

export function reportCodex(snapshot: RateLimits) {
  const windows = [snapshot.primary, snapshot.secondary].flatMap((w) => {
    if (!w || !Number.isFinite(w.usedPercent)) return [];
    const minutes = w.windowDurationMins;
    const label = minutes === 10080 ? 'semana' : minutes && minutes >= 1440 ? `${minutes / 1440} d` : minutes ? `${minutes / 60} h` : 'cuota';
    return [{ label, percent: w.usedPercent, resetsAt: w.resetsAt ?? null }];
  });
  const blocked = snapshot.ordinaryUsageAllowed === false || snapshot.spendControlReached === true || !!snapshot.rateLimitReachedType;
  report('codex', { observedAt: nowSeconds(), windows, blockedUntil: blocked ? nowSeconds() + 120 : null, warningUntil: null });
}

export function reportQuotaLimit(engine: Engine) {
  const snapshot = limits[engine];
  report(engine, { ...snapshot, blockedUntil: Math.max(snapshot.blockedUntil ?? 0, nowSeconds() + 120) });
}

type ClaudeWindow = { utilization?: number; resetsAt?: number };
type ClaudeQuota = ClaudeWindow & {
  rateLimitType?: string;
  status?: string;
  unifiedWindows?: Record<string, ClaudeWindow>;
};

function reportClaude(info: ClaudeQuota) {
  const now = nowSeconds();
  const active = new Map(limits.claude.windows.filter((w) => w.resetsAt == null || w.resetsAt > now).map((w) => [w.label, w]));
  for (const [key, label] of [['five_hour', '5 h'], ['seven_day', 'semana'], ['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']]) {
    const unified = info.unifiedWindows?.[key];
    const own = info.rateLimitType === key ? info : undefined;
    const utilization = own?.status === 'rejected' ? 1 : unified?.utilization ?? own?.utilization;
    const resetsAt = unified?.resetsAt ?? own?.resetsAt;
    if (typeof utilization === 'number' && Number.isFinite(utilization)) {
      active.set(label, { label, percent: utilization * 100, resetsAt: resetsAt ?? null });
    } else if (resetsAt != null && active.get(label)?.resetsAt !== resetsAt) {
      active.delete(label);
    }
  }
  const until = info.resetsAt && info.resetsAt > now ? info.resetsAt : now + 120;
  const snapshot = {
    observedAt: now,
    windows: [...active.values()],
    blockedUntil: info.status === 'rejected' ? until : null,
    warningUntil: info.status === 'allowed_warning' ? until : null,
  };
  report('claude', snapshot);
  try {
    localStorage.setItem(CLAUDE_KEY, JSON.stringify(snapshot));
  } catch {
    // La lectura sigue disponible en esta ventana.
  }
}

export function useQuotaEvents() {
  useEffect(() => {
    let active = true;
    const providerEvents = listen<ProviderHealth>('provider-health', ({ payload }) => { if (active) reportHealth(payload); });
    void providerEvents.then(() => providers.health()).then((values) => { if (active) values.forEach(reportHealth); }, () => {});
    const codex = listen<CoordinatorEvent>('coordinator', ({ payload }) => {
      if (payload.method === 'account/rateLimits/updated' && payload.params.rateLimits) reportCodex(payload.params.rateLimits);
    });
    const claude = listen<SessionEvent>('session', ({ payload: { msg } }) => {
      if (msg.type === 'rate_limit_event' && msg.rate_limit_info) reportClaude(msg.rate_limit_info);
    });
    return () => {
      active = false;
      void providerEvents.then((off) => off());
      void codex.then((off) => off());
      void claude.then((off) => off());
    };
  }, []);
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

export function useProviderQuota(engine: string | null, model: string | null, refreshCodex = engine === 'codex') {
  const snapshots = useSyncExternalStore(subscribe, () => limits);
  const [now, setNow] = useState(nowSeconds);
  const [codexLoading, setCodexLoading] = useState(false);

  useEffect(() => {
    if (!engine && !refreshCodex) return;
    let active = true;
    let pending = false;
    const refresh = () => {
      setNow(nowSeconds());
      if (!refreshCodex || pending) return;
      pending = true;
      setCodexLoading(true);
      void coordinator.rateLimits().then((snapshot) => {
        if (active) reportCodex(snapshot);
      }, () => {}).finally(() => {
        pending = false;
        if (active) setCodexLoading(false);
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [engine, refreshCodex]);

  const snapshot = engine === 'claude' || engine === 'codex' || engine === 'agy' ? snapshots[engine] : EMPTY;
  const windows = snapshot.windows.filter((w) =>
    (w.resetsAt == null || w.resetsAt > now) &&
    (!['Opus', 'Sonnet'].includes(w.label) || model?.toLowerCase().includes(w.label.toLowerCase())));
  const remaining = windows.length ? Math.max(0, 100 - Math.max(...windows.map((w) => w.percent))) : null;
  const provider = engine ? health[engine] : undefined;
  const representative = windows.reduce<QuotaWindow | null>((chosen, window) => !chosen || window.percent > chosen.percent ? window : chosen, null);
  const disconnected = provider?.connected === false;
  const used = disconnected ? null : representative?.percent ?? null;
  const quotaStale = engine === 'agy' && !!provider?.quotaModel && (!provider.quotaObservedAt || now - provider.quotaObservedAt > 1800);
  const exhausted = (snapshot.blockedUntil ?? 0) > now || remaining === 0 || (engine === 'agy' && !!provider?.quotaModel && !quotaStale);
  const stale = quotaStale || (snapshot.observedAt > 0 && now - snapshot.observedAt > 300);
  const status = disconnected ? 'desconectado' : exhausted ? 'cuota agotada' : stale ? 'datos desactualizados' : used === null ? 'consumo no disponible' : 'consumo conocido';
  const near = exhausted || (snapshot.warningUntil ?? 0) > now || (remaining !== null && remaining <= LOW_REMAINING);
  return { windows, remaining, used, representative, exhausted, near, stale, status, provider, observedAt: snapshot.observedAt || provider?.quotaObservedAt || provider?.observedAt || 0, loading: engine === 'codex' && codexLoading };
}

export type ProviderQuota = ReturnType<typeof useProviderQuota>;

export function percentLabel(percent: number) {
  return percent > 0 && percent < 1 ? '<1 %' : `${Math.round(percent)} %`;
}

export function contextRemaining(used: unknown, size: unknown): number | null {
  if (typeof used !== 'number' || typeof size !== 'number' || !Number.isFinite(used) || !Number.isFinite(size) || used < 0 || size <= 0) return null;
  return Math.max(0, 100 * (1 - used / size));
}
