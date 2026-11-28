import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPane,
  closePane,
  computePaneGeometry,
  cyclePane,
  DEFAULT_PANE_RATIO,
  emptyPaneLayout,
  equalizePanes,
  followSelection,
  loadPaneLayout,
  MAX_PANE_RATIO,
  MAX_PANES,
  MIN_PANE_HEIGHT,
  MIN_PANE_RATIO,
  MIN_PANE_WIDTH,
  PANE_DIVIDER_PX,
  paneKey,
  PANES_STORAGE_KEY,
  prunePanes,
  replacePane,
  resizePanes,
  savePaneLayout,
  toggleMaximizePane,
  type PaneLayout,
  type PaneRef,
} from '../src/trama/conversationPanes.ts';
import { selectionKey } from '../src/trama/workspaceContext.ts';
import type { StorageLike } from '../src/trama/workspaceLayout.ts';

const A = '/repos/a';
const B = '/repos/b';
const pm = (project = A): PaneRef => ({ kind: 'pm', project });
const s = (id: number, project = A): PaneRef => ({ kind: 'session', sessionId: id, project });
const keys = (layout: PaneLayout) => layout.panes.map(paneKey);

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
}

function layoutOf(...refs: PaneRef[]): PaneLayout {
  return refs.reduce((layout, ref) => addPane(layout, ref), emptyPaneLayout());
}

test('la clave de panel coincide con la clave de selección de la aplicación', () => {
  assert.equal(paneKey(pm()), selectionKey(pm()));
  assert.equal(paneKey(s(7)), selectionKey(s(7)));
});

test('con un panel, seguir la selección sustituye su contenido como hasta ahora', () => {
  let layout = followSelection(emptyPaneLayout(), s(1));
  assert.deepEqual(keys(layout), ['s:1']);
  layout = followSelection(layout, s(2));
  assert.deepEqual(keys(layout), ['s:2']);
  assert.equal(layout.active, 0);
  assert.equal(followSelection(layout, null), layout);
  assert.equal(followSelection(layout, s(2)), layout, 'sin cambios devuelve el mismo objeto');
});

test('seleccionar una conversación ya en pantalla enfoca su panel; otra sustituye el panel activo', () => {
  let layout = layoutOf(s(1), s(2), s(3));
  assert.equal(layout.active, 2);
  layout = followSelection(layout, s(1));
  assert.equal(layout.active, 0);
  assert.deepEqual(keys(layout), ['s:1', 's:2', 's:3']);
  layout = followSelection(layout, pm());
  assert.deepEqual(keys(layout), ['pm:/repos/a', 's:2', 's:3']);
  assert.equal(layout.active, 0);
});

test('añadir abre un panel nuevo al final, sin duplicados y hasta cuatro', () => {
  let layout = layoutOf(s(1));
  layout = addPane(layout, s(2));
  assert.deepEqual(keys(layout), ['s:1', 's:2']);
  assert.equal(layout.active, 1);
  const again = addPane(layout, s(1));
  assert.deepEqual(keys(again), ['s:1', 's:2']);
  assert.equal(again.active, 0);
  layout = addPane(addPane(layout, s(3)), s(4, B));
  assert.equal(layout.panes.length, MAX_PANES);
  // Con el máximo, la conversación nueva ocupa el panel activo.
  layout = followSelection(layout, s(2));
  layout = addPane(layout, s(5));
  assert.deepEqual(keys(layout), ['s:1', 's:5', 's:3', 's:4']);
  assert.equal(layout.active, 1);
});

test('sustituir un panel concreto (soltar sobre él) y no duplicar', () => {
  const layout = layoutOf(s(1), s(2), s(3), s(4));
  const next = replacePane(layout, 2, s(9));
  assert.deepEqual(keys(next), ['s:1', 's:2', 's:9', 's:4']);
  assert.equal(next.active, 2);
  const dup = replacePane(layout, 2, s(1));
  assert.deepEqual(keys(dup), keys(layout));
  assert.equal(dup.active, 0);
  assert.equal(replacePane(layout, 7, s(9)), layout);
});

test('quitar un panel no deja la pantalla vacía y reasigna el activo', () => {
  const layout = { ...layoutOf(s(1), s(2), s(3)), active: 1 };
  const middle = closePane(layout, 1);
  assert.deepEqual(keys(middle), ['s:1', 's:3']);
  assert.equal(middle.active, 1, 'pasa al vecino que ocupa su lugar');
  const before = closePane(layout, 0);
  assert.deepEqual(keys(before), ['s:2', 's:3']);
  assert.equal(before.active, 0, 'el activo sigue siendo s:2');
  const last = closePane({ ...layout, active: 2 }, 2);
  assert.equal(last.active, 1);
  const single = layoutOf(s(1));
  assert.equal(closePane(single, 0), single, 'el último panel no se quita');
  assert.equal(closePane(layout, 5), layout);
});

test('maximizar y restaurar; quitar el maximizado restaura la rejilla', () => {
  let layout = layoutOf(s(1), s(2), s(3));
  layout = toggleMaximizePane(layout, 0);
  assert.equal(layout.maximized, 's:1');
  assert.equal(layout.active, 0);
  assert.equal(toggleMaximizePane(layout, 0).maximized, null);
  // Sustituir el contenido del panel maximizado lo mantiene maximizado.
  const replaced = followSelection(layout, s(8));
  assert.equal(replaced.maximized, 's:8');
  assert.equal(closePane(layout, 0).maximized, null);
  // Abrir otro panel restaura la rejilla para que se vea.
  assert.equal(addPane(layout, s(4)).maximized, null);
  assert.equal(toggleMaximizePane(layoutOf(s(1)), 0).maximized, null, 'con un panel no hay nada que maximizar');
});

test('redimensionar respeta los límites e igualar vuelve al 50 %', () => {
  let layout = layoutOf(s(1), s(2), s(3));
  layout = resizePanes(layout, 'col', 0.95);
  assert.equal(layout.ratios.col, MAX_PANE_RATIO);
  layout = resizePanes(layout, 'row', -3);
  assert.equal(layout.ratios.row, MIN_PANE_RATIO);
  assert.equal(resizePanes(layout, 'row', -1), layout);
  assert.equal(resizePanes(layout, 'col', Number.NaN).ratios.col, DEFAULT_PANE_RATIO);
  const col = equalizePanes(layout, 'col');
  assert.deepEqual(col.ratios, { col: 0.5, row: MIN_PANE_RATIO });
  const equal = equalizePanes(layout);
  assert.deepEqual(equal.ratios, { col: 0.5, row: 0.5 });
  assert.equal(equalizePanes(equal), equal, 'igualar dos veces no cambia nada');
});

test('recorrer los paneles en bucle', () => {
  const layout = { ...layoutOf(s(1), s(2), s(3)), active: 2 };
  assert.equal(cyclePane(layout, 1), 0);
  assert.equal(cyclePane(layout, -1), 1);
  assert.equal(cyclePane(emptyPaneLayout(), 1), 0);
});

test('retirar paneles de conversaciones cerradas conserva el activo si sigue', () => {
  const layout = { ...layoutOf(s(1), s(2), s(3), s(4)), active: 2, maximized: 's:4' };
  const pruned = prunePanes(layout, (ref) => paneKey(ref) !== 's:2' && paneKey(ref) !== 's:4');
  assert.deepEqual(keys(pruned), ['s:1', 's:3']);
  assert.equal(pruned.active, 1);
  assert.equal(pruned.maximized, null);
  assert.equal(prunePanes(layout, () => true), layout);
  const gone = prunePanes({ ...layout, active: 3 }, (ref) => paneKey(ref) !== 's:4');
  assert.equal(gone.active, 2);
  assert.deepEqual(prunePanes(layout, () => false).panes, []);
});

test('geometría: uno, columnas, rejilla y límites por ancho mínimo', () => {
  const ratios = { col: 0.5, row: 0.5 };
  assert.equal(computePaneGeometry(1, ratios, 300, 300).mode, 'single');
  assert.equal(computePaneGeometry(2, ratios, 1200, 800).mode, 'columns');
  assert.equal(computePaneGeometry(3, ratios, 1200, 800).mode, 'grid');
  assert.equal(computePaneGeometry(4, ratios, 1200, 800).mode, 'grid');
  assert.equal(computePaneGeometry(4, ratios, 1200, 800, true).mode, 'maximized');
  // Una proporción extrema se ajusta para que cada panel conserve su mínimo.
  const width = 900;
  const geo = computePaneGeometry(2, { col: 0.2, row: 0.5 }, width, 800);
  assert.ok(geo.col * (width - PANE_DIVIDER_PX) >= MIN_PANE_WIDTH - 0.01);
  const high = computePaneGeometry(4, { col: 0.5, row: 0.8 }, 1200, 600);
  assert.ok((1 - high.row) * (600 - PANE_DIVIDER_PX) >= MIN_PANE_HEIGHT - 0.01);
});

test('geometría: si no caben, se degrada a pestañas', () => {
  const ratios = { col: 0.5, row: 0.5 };
  const narrow = MIN_PANE_WIDTH * 2 + PANE_DIVIDER_PX - 1;
  assert.equal(computePaneGeometry(2, ratios, narrow, 800).mode, 'tabs');
  assert.equal(computePaneGeometry(2, ratios, narrow + 1, 800).mode, 'columns');
  const short = MIN_PANE_HEIGHT * 2 + PANE_DIVIDER_PX - 1;
  assert.equal(computePaneGeometry(4, ratios, 1200, short).mode, 'tabs');
  assert.equal(computePaneGeometry(2, ratios, 1200, short).mode, 'columns', 'dos columnas no dependen de la altura');
});

test('persistencia: guarda y recupera paneles, activo, maximizado y proporciones', () => {
  const storage = memoryStorage();
  const layout = { ...resizePanes(resizePanes(layoutOf(pm(), s(2), s(3, B)), 'col', 0.62), 'row', 0.3), active: 1, maximized: 's:2' };
  savePaneLayout(layout, storage);
  const restored = loadPaneLayout([A, B], storage);
  assert.deepEqual(restored, layout);
});

test('persistencia: descarta proyectos que ya no están, duplicados, basura y exceso', () => {
  const storage = memoryStorage();
  storage.setItem(PANES_STORAGE_KEY, JSON.stringify({
    version: 1,
    panes: [s(1), { kind: 'session', sessionId: 'x', project: A }, s(2, '/repos/borrado'), s(1), pm(B), s(3), s(4), s(5)],
    active: 4,
    maximized: 's:2',
    ratios: { col: 9, row: 'nada' },
  }));
  const restored = loadPaneLayout([A, B], storage);
  assert.deepEqual(keys(restored), ['s:1', 'pm:/repos/b', 's:3', 's:4']);
  assert.equal(restored.active, 1, 'el activo guardado (pm de B) sigue activo');
  assert.equal(restored.maximized, null, 'el maximizado ya no está en pantalla');
  assert.deepEqual(restored.ratios, { col: MAX_PANE_RATIO, row: DEFAULT_PANE_RATIO });
});

test('persistencia: sin datos, versión desconocida o JSON roto empiezan vacíos', () => {
  const storage = memoryStorage();
  assert.deepEqual(loadPaneLayout([A], storage), emptyPaneLayout());
  storage.setItem(PANES_STORAGE_KEY, '{roto');
  assert.deepEqual(loadPaneLayout([A], storage), emptyPaneLayout());
  storage.setItem(PANES_STORAGE_KEY, JSON.stringify({ version: 2, panes: [s(1)] }));
  assert.deepEqual(loadPaneLayout([A], storage), emptyPaneLayout());
  assert.deepEqual(loadPaneLayout([A], null), emptyPaneLayout());
  assert.doesNotThrow(() => savePaneLayout(layoutOf(s(1)), null));
});


test('seleccionar otro panel restaura la rejilla y hace visible la selección', () => {
  const maximized = toggleMaximizePane(layoutOf(s(1), s(2, B)), 0);
  const focused = followSelection(maximized, s(2, B));
  assert.equal(focused.active, 1);
  assert.equal(focused.maximized, null);
  assert.equal(replacePane(maximized, 0, s(2, B)).maximized, null);
});

test('dos columnas requieren 220 píxeles de alto', () => {
  const ratios = { col: 0.5, row: 0.5 };
  assert.equal(computePaneGeometry(2, ratios, 1000, MIN_PANE_HEIGHT - 1).mode, 'tabs');
  assert.equal(computePaneGeometry(2, ratios, 1000, MIN_PANE_HEIGHT).mode, 'columns');
});

test('descarta maximizado persistido que no coincide con el activo', () => {
  const storage = memoryStorage();
  savePaneLayout({ ...layoutOf(s(1), s(2)), maximized: 's:1' }, storage);
  assert.equal(loadPaneLayout([A], storage).maximized, null);
});
