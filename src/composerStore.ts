import { useSyncExternalStore } from 'react';
import { composer, type ComposerSettings } from './ipc';

// Ajustes del Compositor inteligente compartidos por todos los compositores:
// una sola lectura IPC por arranque y actualización al guardar en Ajustes.
let current: ComposerSettings | null = null;
let loading = false;
const listeners = new Set<() => void>();

function load() {
  if (current || loading) return;
  loading = true;
  composer.settings().then((value) => setComposerSettings(value), () => { loading = false; });
}

export function setComposerSettings(value: ComposerSettings) {
  current = value;
  loading = false;
  listeners.forEach((listener) => listener());
}

export function useComposerSettings() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    load();
    return () => listeners.delete(listener);
  }, () => current);
}
