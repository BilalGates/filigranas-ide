import type { StorageLike } from './workspaceLayout.ts';
import { selectionKey, type ActiveSelection } from './workspaceContext.ts';

/**
 * Varias conversaciones a la vez en el Workspace. El panel activo es siempre
 * la selección activa de la aplicación (`activeSelection`), así que proyecto,
 * columna derecha y atajos siguen al panel activo sin lógica propia.
 */
export type PaneRef = Exclude<ActiveSelection, null>;
export type PaneAxis = 'col' | 'row';
export type PaneRatios = { col: number; row: number };

export type PaneLayout = {
  /** De 0 a 4 conversaciones, en el orden de la rejilla. */
  panes: PaneRef[];
  /** Índice del panel activo. */
  active: number;
  /** Clave del panel maximizado, si lo hay. */
  maximized: string | null;
  /** Proporción de la primera columna y de la primera fila. */
  ratios: PaneRatios;
};

/** single: vista de siempre · columns: 2 · grid: 3 o 4 · tabs: no caben · maximized: uno solo. */
export type PaneMode = 'single' | 'columns' | 'grid' | 'tabs' | 'maximized';

export const MAX_PANES = 4;
export const MIN_PANE_WIDTH = 320;
export const MIN_PANE_HEIGHT = 220;
export const PANE_DIVIDER_PX = 6;
export const DEFAULT_PANE_RATIO = 0.5;
export const MIN_PANE_RATIO = 0.2;
export const MAX_PANE_RATIO = 0.8;
export const PANE_RATIO_STEP = 0.05;
export const PANES_STORAGE_KEY = 'filigranas.paneles.v1';

export const paneKey = (ref: PaneRef): string => selectionKey(ref);

export function emptyPaneLayout(): PaneLayout {
  return { panes: [], active: 0, maximized: null, ratios: { col: DEFAULT_PANE_RATIO, row: DEFAULT_PANE_RATIO } };
}

export function clampPaneRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_PANE_RATIO;
  return Math.min(MAX_PANE_RATIO, Math.max(MIN_PANE_RATIO, ratio));
}

const indexOf = (layout: PaneLayout, ref: PaneRef) => layout.panes.findIndex((p) => paneKey(p) === paneKey(ref));

function focusIndex(layout: PaneLayout, index: number): PaneLayout {
  return layout.active === index ? layout : { ...layout, active: index };
}

/** Lleva la selección al panel activo: si ya está en pantalla, la enfoca; si no, sustituye el contenido del panel activo. */
export function followSelection(layout: PaneLayout, ref: ActiveSelection): PaneLayout {
  if (!ref) return layout;
  const at = indexOf(layout, ref);
  if (at >= 0) {
    const focused = focusIndex(layout, at);
    return focused.maximized && focused.maximized !== paneKey(ref) ? { ...focused, maximized: null } : focused;
  }
  if (!layout.panes.length) return { ...layout, panes: [ref], active: 0, maximized: null };
  return replacePane(layout, Math.min(layout.active, layout.panes.length - 1), ref);
}

/** Sustituye el panel `index` por `ref` (si ya está en otro panel, solo lo enfoca). */
export function replacePane(layout: PaneLayout, index: number, ref: PaneRef): PaneLayout {
  const at = indexOf(layout, ref);
  if (at >= 0) return followSelection(layout, ref);
  if (index < 0 || index >= layout.panes.length) return layout;
  const old = paneKey(layout.panes[index]);
  const panes = layout.panes.map((p, i) => (i === index ? ref : p));
  return { ...layout, panes, active: index, maximized: layout.maximized === old ? paneKey(ref) : layout.maximized };
}

/** Abre `ref` en un panel nuevo. Si ya está en pantalla lo enfoca; con el máximo, sustituye el panel activo. */
export function addPane(layout: PaneLayout, ref: PaneRef): PaneLayout {
  const at = indexOf(layout, ref);
  if (at >= 0) return { ...focusIndex(layout, at), maximized: null };
  if (layout.panes.length >= MAX_PANES) return { ...replacePane(layout, layout.active, ref), maximized: null };
  return { ...layout, panes: [...layout.panes, ref], active: layout.panes.length, maximized: null };
}

/** Quita un panel de la pantalla sin cerrar su conversación. El último no se quita. */
export function closePane(layout: PaneLayout, index: number): PaneLayout {
  if (layout.panes.length <= 1 || index < 0 || index >= layout.panes.length) return layout;
  const removed = paneKey(layout.panes[index]);
  const panes = layout.panes.filter((_, i) => i !== index);
  const active = index < layout.active ? layout.active - 1 : index === layout.active ? Math.min(index, panes.length - 1) : layout.active;
  return { ...layout, panes, active, maximized: layout.maximized === removed ? null : layout.maximized };
}

/** Maximiza el panel o restaura la rejilla; el panel pasa a ser el activo. */
export function toggleMaximizePane(layout: PaneLayout, index: number): PaneLayout {
  if (index < 0 || index >= layout.panes.length || layout.panes.length < 2) return layout;
  const key = paneKey(layout.panes[index]);
  return { ...layout, active: index, maximized: layout.maximized === key ? null : key };
}

export function resizePanes(layout: PaneLayout, axis: PaneAxis, ratio: number): PaneLayout {
  const next = clampPaneRatio(ratio);
  if (layout.ratios[axis] === next) return layout;
  return { ...layout, ratios: { ...layout.ratios, [axis]: next } };
}

/** Iguala las proporciones de un eje, o de ambos. */
export function equalizePanes(layout: PaneLayout, axis?: PaneAxis): PaneLayout {
  const ratios = axis ? { ...layout.ratios, [axis]: DEFAULT_PANE_RATIO } : { col: DEFAULT_PANE_RATIO, row: DEFAULT_PANE_RATIO };
  if (ratios.col === layout.ratios.col && ratios.row === layout.ratios.row) return layout;
  return { ...layout, ratios };
}

/** Índice del panel siguiente (o anterior) al activo, en bucle. */
export function cyclePane(layout: PaneLayout, delta: number): number {
  const n = layout.panes.length;
  if (!n) return 0;
  return (((layout.active + delta) % n) + n) % n;
}

/** Retira los paneles de conversaciones que ya no existen. */
export function prunePanes(layout: PaneLayout, keep: (ref: PaneRef) => boolean): PaneLayout {
  if (layout.panes.every(keep)) return layout;
  const activeKey = layout.panes[layout.active] ? paneKey(layout.panes[layout.active]) : null;
  const panes = layout.panes.filter(keep);
  const kept = panes.findIndex((p) => paneKey(p) === activeKey);
  const active = kept >= 0 ? kept : Math.max(0, Math.min(layout.active, panes.length - 1));
  const maximized = panes.some((p) => paneKey(p) === layout.maximized) ? layout.maximized : null;
  return { ...layout, panes, active, maximized };
}

export type PaneGeometry = { mode: PaneMode; col: number; row: number };

/**
 * Disposición que cabe en `width` × `height` (px del área de conversación).
 * Las proporciones se ajustan para respetar el mínimo de cada panel; si la
 * rejilla no cabe, se degrada a pestañas.
 */
export function computePaneGeometry(count: number, ratios: PaneRatios, width: number, height: number, maximized = false): PaneGeometry {
  const col = clampPaneRatio(ratios.col);
  const row = clampPaneRatio(ratios.row);
  if (count <= 1) return { mode: 'single', col, row };
  if (maximized) return { mode: 'maximized', col, row };
  const fit = (size: number, ratio: number, min: number) => {
    const usable = size - PANE_DIVIDER_PX;
    if (usable < min * 2) return null;
    const lo = min / usable;
    return Math.min(1 - lo, Math.max(lo, ratio));
  };
  const c = fit(width, col, MIN_PANE_WIDTH);
  if (c == null) return { mode: 'tabs', col, row };
  if (count === 2) return { mode: height < MIN_PANE_HEIGHT ? 'tabs' : 'columns', col: c, row };
  const r = fit(height, row, MIN_PANE_HEIGHT);
  if (r == null) return { mode: 'tabs', col, row };
  return { mode: 'grid', col: c, row: r };
}

// ── Persistencia ────────────────────────────────────────────────────────

type PersistedPanes = { version: 1; panes: PaneRef[]; active: number; maximized: string | null; ratios: PaneRatios };

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function isPaneRef(raw: unknown): raw is PaneRef {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.project !== 'string' || !obj.project) return false;
  return obj.kind === 'pm' || (obj.kind === 'session' && typeof obj.sessionId === 'number' && Number.isFinite(obj.sessionId));
}

/** Recupera los paneles guardados de proyectos que siguen disponibles. */
export function loadPaneLayout(validProjects: readonly string[], storage: StorageLike | null = defaultStorage()): PaneLayout {
  const empty = emptyPaneLayout();
  if (!storage) return empty;
  try {
    const parsed = JSON.parse(storage.getItem(PANES_STORAGE_KEY) ?? 'null') as Partial<PersistedPanes> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.panes)) return empty;
    const valid = new Set(validProjects);
    const seen = new Set<string>();
    const savedActive: unknown = parsed.panes[Number.isInteger(parsed.active) ? (parsed.active as number) : 0];
    const activeKey = isPaneRef(savedActive) ? paneKey(savedActive) : null;
    const panes: PaneRef[] = [];
    for (const ref of parsed.panes.filter(isPaneRef)) {
      const key = paneKey(ref);
      if (!valid.has(ref.project) || seen.has(key) || panes.length >= MAX_PANES) continue;
      seen.add(key);
      panes.push(ref.kind === 'pm' ? { kind: 'pm', project: ref.project } : { kind: 'session', sessionId: ref.sessionId, project: ref.project });
    }
    const active = Math.max(0, panes.findIndex((p) => paneKey(p) === activeKey));
    const maximized = typeof parsed.maximized === 'string' && panes[active] && paneKey(panes[active]) === parsed.maximized && panes.length > 1 ? parsed.maximized : null;
    const ratios = {
      col: clampPaneRatio(Number(parsed.ratios?.col ?? DEFAULT_PANE_RATIO)),
      row: clampPaneRatio(Number(parsed.ratios?.row ?? DEFAULT_PANE_RATIO)),
    };
    return { panes, active, maximized, ratios };
  } catch {
    return empty;
  }
}

export function savePaneLayout(layout: PaneLayout, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  const payload: PersistedPanes = { version: 1, panes: layout.panes, active: layout.active, maximized: layout.maximized, ratios: layout.ratios };
  try {
    storage.setItem(PANES_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Sin almacenamiento disponible.
  }
}
