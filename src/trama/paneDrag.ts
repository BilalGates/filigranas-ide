import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PaneRef } from './conversationPanes.ts';

/** Zona que acepta conversaciones arrastradas (la rejilla de paneles). */
export type PaneDropTarget = {
  el: HTMLElement;
  over: (x: number, y: number) => void;
  leave: () => void;
  drop: (ref: PaneRef, x: number, y: number) => void;
};

const targets = new Set<PaneDropTarget>();
const THRESHOLD_PX = 6;
let cancelActiveDrag: (() => void) | null = null;

export function cancelPaneDrag() { cancelActiveDrag?.(); }

export function registerPaneDropTarget(target: PaneDropTarget): () => void {
  targets.add(target);
  return () => { targets.delete(target); cancelPaneDrag(); };
}

/**
 * Arrastra una conversación del explorador hasta los paneles. Usa eventos de
 * puntero: el arrastre HTML5 no llega al webview de Windows mientras Tauri
 * gestiona la caída de archivos. Hasta moverse unos píxeles es un clic normal.
 */
export function startPaneDrag(e: ReactPointerEvent<HTMLElement>, ref: PaneRef, label: string) {
  if (e.button !== 0 || e.pointerType === 'touch' || e.metaKey || e.ctrlKey || !targets.size) return;
  cancelPaneDrag();
  const html = document.documentElement;
  const startX = e.clientX;
  const startY = e.clientY;
  let ghost: HTMLElement | null = null;
  let current: PaneDropTarget | null = null;

  const targetAt = (x: number, y: number) => {
    const hit = document.elementFromPoint(x, y);
    return hit ? [...targets].find((t) => t.el.contains(hit)) ?? null : null;
  };
  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD_PX) return;
      ghost = document.createElement('div');
      ghost.className = 'pane-drag-ghost';
      ghost.textContent = label;
      document.body.append(ghost);
      html.dataset.paneDrag = 'true';
      window.getSelection()?.removeAllRanges();
    }
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 12}px)`;
    const next = targetAt(ev.clientX, ev.clientY);
    if (current && current !== next) current.leave();
    current = next;
    current?.over(ev.clientX, ev.clientY);
  };
  const finish = (ev: PointerEvent | null) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', cancel);
    if (cancelActiveDrag === cancel) cancelActiveDrag = null;
    if (!ghost) return;
    ghost.remove();
    delete html.dataset.paneDrag;
    const target = current;
    current = null;
    target?.leave();
    if (ev && target) target.drop(ref, ev.clientX, ev.clientY);
    // El clic que sigue al soltar no debe abrir la fila de origen ni pulsar nada debajo.
    const swallow = (c: MouseEvent) => { c.preventDefault(); c.stopPropagation(); };
    window.addEventListener('click', swallow, true);
    window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
  };
  const up = (ev: PointerEvent) => finish(ev);
  const cancel = () => finish(null);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !ghost) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(null);
  };
  cancelActiveDrag = cancel;
  window.addEventListener('blur', cancel);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
}
