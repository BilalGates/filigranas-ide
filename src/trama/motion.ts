import { useSyncExternalStore } from 'react';

// Lenguaje de movimiento de Trama. Tres modos:
// · completo: estados animados y campo ambiental.
// · sin-ambiente: estados animados, fondo quieto (menos energía).
// · reducido: sin animaciones; el estado se lee por forma y color.
// `prefers-reduced-motion` siempre gana sobre la preferencia guardada.
export type Motion = 'completo' | 'sin-ambiente' | 'reducido';
const KEY = 'filigranas.movimiento';
const FIELD = 'filigranas.campo';

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* sin almacenamiento */ }
}

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const savedIntensity = Number(read(FIELD) ?? '1');
let state = {
  motion: (['completo', 'sin-ambiente', 'reducido'].includes(read(KEY) ?? '') ? read(KEY) : 'completo') as Motion,
  intensity: Number.isFinite(savedIntensity) ? Math.max(0, Math.min(1.6, savedIntensity)) : 1,
  systemReduced: !!media?.matches,
};
const listeners = new Set<() => void>();

/** Modo efectivo: la preferencia del sistema reduce siempre. */
export const effectiveMotion = (): Motion => (state.systemReduced ? 'reducido' : state.motion);
export const ambientEnabled = () => effectiveMotion() === 'completo' && state.intensity > 0;

function apply() {
  document.documentElement.dataset.motion = effectiveMotion();
  listeners.forEach((l) => l());
}
media?.addEventListener?.('change', (e) => {
  state = { ...state, systemReduced: e.matches };
  apply();
});
apply();

export function setMotion(motion: Motion) {
  state = { ...state, motion };
  write(KEY, motion);
  apply();
}
export function setFieldIntensity(intensity: number) {
  state = { ...state, intensity: Math.max(0, Math.min(1.6, intensity)) };
  write(FIELD, String(state.intensity));
  apply();
}
export function getMotionState() {
  return state;
}
export function useMotion() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
