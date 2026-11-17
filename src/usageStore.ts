import { useSyncExternalStore } from 'react';

// Consumo de los modelos: cuotas de cada motor (las informan Codex y Claude
// Code en sus eventos) y tokens acumulados por modelo. Los tokens se guardan
// en localStorage hasta que el usuario reinicia el recuento.

export type Window = { label: string; percent: number; resetsAt: number | null };
export type Limits = { engine: string; windows: Window[]; out: boolean };
export type ModelTokens = { model: string; engine: string; input: number; cached: number; output: number; turns: number };
export type Usage = { limits: Record<string, Limits>; models: ModelTokens[]; since: number };

const KEY = 'filigranas.tokens';

function load(): Pick<Usage, 'models' | 'since'> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && Array.isArray(v.models)) return { models: v.models, since: v.since ?? Date.now() };
  } catch {
    // recuento nuevo
  }
  return { models: [], since: Date.now() };
}

let state: Usage = { limits: {}, ...load() };
const listeners = new Set<() => void>();

function set(next: Usage, persist = false) {
  state = next;
  if (persist) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ models: state.models, since: state.since }));
    } catch {
      // sin almacenamiento: el recuento dura lo que la ventana
    }
  }
  listeners.forEach((l) => l());
}

export function reportLimits(limits: Limits) {
  set({ ...state, limits: { ...state.limits, [limits.engine]: limits } });
}

export function addTokens(engine: string, model: string | null | undefined, t: { input?: number; cached?: number; output?: number }) {
  const name = model || engine;
  const input = t.input ?? 0;
  const cached = t.cached ?? 0;
  const output = t.output ?? 0;
  if (!input && !cached && !output) return;
  const found = state.models.some((m) => m.model === name && m.engine === engine);
  const models = found
    ? state.models.map((m) =>
        m.model === name && m.engine === engine
          ? { ...m, input: m.input + input, cached: m.cached + cached, output: m.output + output, turns: m.turns + 1 }
          : m,
      )
    : [...state.models, { model: name, engine, input, cached, output, turns: 1 }];
  set({ ...state, models }, true);
}

export function resetTokens() {
  set({ ...state, models: [], since: Date.now() }, true);
}

export function useUsage() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const totalOf = (m: ModelTokens) => m.input + m.cached + m.output;

export function compact(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k`;
  return String(n);
}

export function spanLabel(mins: number | null | undefined) {
  const m = mins ?? 0;
  return m >= 10080 ? 'semana' : m >= 1440 ? `${Math.round(m / 1440)} d` : `${Math.round(m / 60)} h`;
}
