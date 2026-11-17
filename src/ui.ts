import { useEffect, useSyncExternalStore } from 'react';

// ── sonido ─────────────────────────────────────────────────
// Tonos cortos sintetizados, muy bajos. Sin archivos. ⌘⇧M silencia y la
// preferencia se guarda.

type Tone = [freq: number, at: number, dur: number, vol: number];
const TONES: Record<string, Tone[]> = {
  tick: [[1760, 0, 0.035, 0.016]],
  open: [[1240, 0, 0.05, 0.014]],
  send: [[880, 0, 0.06, 0.028], [1320, 0.05, 0.08, 0.024]],
  done: [[660, 0, 0.14, 0.028], [990, 0.09, 0.2, 0.024]],
  ask: [[520, 0, 0.1, 0.028], [390, 0.1, 0.14, 0.028]],
};

let muted = read('filigranas.silencio') === '1';
let ctx: AudioContext | null = null;

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function beep(kind: keyof typeof TONES) {
  if (muted) return;
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime;
    for (const [f, at, dur, vol] of TONES[kind]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(vol, t0 + at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + at);
      o.stop(t0 + at + dur + 0.02);
    }
  } catch {
    // sin audio: la interfaz sigue igual
  }
}

export function toggleMute() {
  muted = !muted;
  try {
    localStorage.setItem('filigranas.silencio', muted ? '1' : '0');
  } catch {
    // sin almacenamiento
  }
  if (!muted) beep('tick');
  notify();
  return muted;
}

// ── actividad de las pestañas ──────────────────────────────
// Cada vista informa de su estado; la barra de pestañas lo pinta
// (borde animado si trabaja, punto rojo si pide permiso).

export type Activity = 'trabajando' | 'permiso' | null;
let activity: Record<string, Activity> = {};

export function reportActivity(key: string, state: Activity) {
  if (activity[key] === state) return;
  const prev = activity[key];
  activity = { ...activity, [key]: state };
  if (state === 'permiso' && prev !== 'permiso') beep('ask');
  if (prev === 'trabajando' && state === null) beep('done');
  notify();
}

const listeners = new Set<() => void>();
function notify() {
  snapshot = { activity, muted };
  listeners.forEach((l) => l());
}
let snapshot = { activity, muted };

export function useUi() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

/** Traduce el estado textual de una vista al de su pestaña. */
export function useReportActivity(key: string, state: string) {
  useEffect(() => {
    reportActivity(key, state === 'esperando permiso' ? 'permiso' : state === 'en marcha' ? 'trabajando' : null);
  }, [key, state]);
  useEffect(() => () => reportActivity(key, null), [key]);
}

// ── órdenes ────────────────────────────────────────────────
// Los atajos globales viven en App; las vistas que ejecutan la orden
// (git, compositor) se suscriben aquí.

export function emit(command: string) {
  window.dispatchEvent(new CustomEvent('filigranas', { detail: command }));
}

export function useCommand(command: string, run: () => void) {
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<string>).detail === command && run();
    window.addEventListener('filigranas', on);
    return () => window.removeEventListener('filigranas', on);
  }, [command, run]);
}
