import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeTool,
  COMPACT_RAIL_PX,
  computeLayoutGeometry,
  createInitialShellState,
  DEFAULT_WORKSPACE_RATIO,
  maximizeTool,
  MIN_TOOL_PX,
  MIN_WORKSPACE_PX,
  minimizeWorkspace,
  onProjectSelected,
  openTool,
  persistShellState,
  resetWorkspaceRatio,
  resizeWorkspace,
  resolveStartupShell,
  restoreSplit,
  restoreWorkspace,
  SPLITTER_PX,
  toggleMaximizeTool,
  toggleTool,
  TOOLS,
  type StorageLike,
  type ToolId,
  visibleDisposition,
} from '../src/trama/workspaceLayout.ts';

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

test('barra lateral contiene exactamente las 8 herramientas y ningún icono de Workspace', () => {
  const ids = TOOLS.map((t) => t.id);
  assert.deepEqual(ids, ['inicio', 'flow', 'studio', 'entrega', 'brain', 'containers', 'browser', 'ajustes']);
  assert.equal((ids as string[]).includes('workspace'), false);
});

test('arranque sin proyecto abre Workspace + Inicio en vista dividida (35 % / 65 %)', () => {
  const storage = memoryStorage();
  const { project, shell } = resolveStartupShell(['/repos/a', '/repos/b'], storage);
  assert.equal(project, null);
  assert.equal(shell.activeTool, 'inicio');
  assert.equal(shell.mode, 'split');
  assert.equal(shell.workspaceRatio, DEFAULT_WORKSPACE_RATIO);

  const geo = computeLayoutGeometry(shell, 1440 - 56);
  assert.equal(geo.effectiveMode, 'split');
  assert.equal(geo.showSplitter, true);
  assert.ok(Math.abs(geo.workspaceWidthPx / (1440 - 56 - SPLITTER_PX) - 0.35) < 0.02);
  assert.ok(geo.toolWidthPx >= MIN_TOOL_PX);
});

test('seleccionar un proyecto cierra Inicio y expande Workspace a toda el área', () => {
  const initial = createInitialShellState(false);
  assert.equal(initial.activeTool, 'inicio');
  const afterSelect = onProjectSelected(initial);
  assert.equal(afterSelect.activeTool, null);
  assert.equal(afterSelect.mode, 'workspace');

  const geo = computeLayoutGeometry(afterSelect, 1440 - 56);
  assert.equal(geo.effectiveMode, 'workspace');
  assert.equal(geo.workspaceWidthPx, 1440 - 56);
  assert.equal(geo.toolWidthPx, 0);
  assert.equal(geo.showSplitter, false);
  assert.equal(geo.collapseWorkspaceSidebar, false);
});

test('abrir cada herramienta, cambiar entre herramientas y cerrar devuelve Workspace completo', () => {
  let state = onProjectSelected(createInitialShellState(false));
  const allTools: ToolId[] = ['inicio', 'flow', 'studio', 'entrega', 'brain', 'containers', 'browser', 'ajustes'];

  for (const tool of allTools) {
    state = openTool(state, tool);
    assert.equal(state.activeTool, tool);
    assert.equal(state.mode, 'split');
  }

  // Pulsar de nuevo la herramienta activa la cierra y expande Workspace.
  state = toggleTool(state, 'ajustes');
  assert.equal(state.activeTool, null);
  assert.equal(state.mode, 'workspace');

  // Reabrir desde Workspace vuelve a dividida.
  state = toggleTool(state, 'flow');
  assert.equal(state.activeTool, 'flow');
  assert.equal(state.mode, 'split');

  state = closeTool(state);
  assert.equal(state.activeTool, null);
  assert.equal(state.mode, 'workspace');
});

test('arrastre del divisor respeta límites seguros y el doble clic restablece 35 % / 65 %', () => {
  let state = openTool(onProjectSelected(createInitialShellState(false)), 'flow');
  const available = 1440 - 56;

  // Arrastrar demasiado a la izquierda respeta MIN_WORKSPACE_PX.
  state = resizeWorkspace(state, 100, available);
  assert.equal(state.workspacePx, MIN_WORKSPACE_PX);

  // Arrastrar demasiado a la derecha respeta MAX_WORKSPACE_RATIO / MIN_TOOL_PX.
  state = resizeWorkspace(state, 1300, available);
  const geoMax = computeLayoutGeometry(state, available);
  assert.ok(geoMax.toolWidthPx >= MIN_TOOL_PX);
  assert.ok(geoMax.workspaceWidthPx <= geoMax.maxWorkspacePx);

  // Restablecer devuelve la proporción por defecto.
  state = resetWorkspaceRatio(state);
  assert.equal(state.workspaceRatio, DEFAULT_WORKSPACE_RATIO);
  assert.equal(state.workspacePx, null);
});

test('maximizar, restaurar dividida, minimizar Workspace y recuperar conservan proporciones', () => {
  const available = 1440 - 56;
  let state = openTool(onProjectSelected(createInitialShellState(false)), 'studio');
  state = resizeWorkspace(state, 520, available);
  const savedRatio = state.workspaceRatio;

  // Maximizar oculta visualmente Workspace (0 px) sin borrar la proporción guardada.
  state = maximizeTool(state);
  assert.equal(state.mode, 'maximized');
  assert.equal(state.lastToolMode, 'split');
  assert.equal(state.workspaceRatio, savedRatio);
  const geoMax = computeLayoutGeometry(state, available);
  assert.equal(geoMax.workspaceWidthPx, 0);
  assert.equal(geoMax.toolWidthPx, available);

  // Restaurar vuelve a la vista dividida con el ancho guardado.
  state = toggleMaximizeTool(state);
  assert.equal(state.mode, 'split');
  assert.equal(state.workspaceRatio, savedRatio);
  const geoRestored = computeLayoutGeometry(state, available);
  assert.equal(geoRestored.workspaceWidthPx, 520);

  // Minimizar Workspace lo reduce a la columna compacta de 64 px.
  state = minimizeWorkspace(state);
  assert.equal(state.mode, 'compact');
  const geoCompact = computeLayoutGeometry(state, available);
  assert.equal(geoCompact.effectiveMode, 'compact');
  assert.equal(geoCompact.workspaceWidthPx, COMPACT_RAIL_PX);
  assert.equal(geoCompact.toolWidthPx, available - COMPACT_RAIL_PX);

  // Recuperar Workspace devuelve vista dividida.
  state = restoreWorkspace(state);
  assert.equal(state.mode, 'split');

  // Desde maximizado, restoreSplit siempre recupera split.
  state = maximizeTool(minimizeWorkspace(state));
  assert.equal(state.lastToolMode, 'compact');
  state = restoreSplit(state);
  assert.equal(state.mode, 'split');
});

test('tamaños de ventana 1600, 1440, 1280, 1050, 960 y estrechos evitan paneles inutilizables', () => {
  const split = openTool(onProjectSelected(createInitialShellState(false)), 'entrega');
  for (const viewport of [1600, 1440, 1280, 1050, 960]) {
    const navW = viewport <= 900 ? 48 : 56;
    const available = viewport - navW;
    const geo = computeLayoutGeometry(split, available);
    assert.equal(geo.effectiveMode, 'split', `viewport ${viewport} debe admitir vista dividida`);
    assert.ok(geo.workspaceWidthPx >= MIN_WORKSPACE_PX, `workspace demasiado estrecho en ${viewport}`);
    assert.ok(geo.toolWidthPx >= MIN_TOOL_PX, `tool demasiado estrecho en ${viewport}`);
    assert.equal(geo.workspaceWidthPx + geo.toolWidthPx + SPLITTER_PX, available);
  }

  // Ventana por debajo del umbral de dividida autocompacta Workspace sin desbordamiento.
  const narrow = computeLayoutGeometry(split, 700);
  assert.equal(narrow.effectiveMode, 'compact');
  assert.equal(narrow.autoCompacted, true);
  assert.equal(narrow.workspaceWidthPx + narrow.toolWidthPx, 700);
});

test('persistencia por proyecto, reinicio y descarte de proyectos borrados o inaccesibles', () => {
  const storage = memoryStorage();
  const valid = ['/repos/alpha', '/repos/beta'];

  // Proyecto alpha con Flow abierto y proporción personalizada.
  let alphaShell = openTool(onProjectSelected(createInitialShellState(false)), 'flow');
  alphaShell = resizeWorkspace(alphaShell, 500, 1384);
  persistShellState('/repos/alpha', alphaShell, valid, storage);

  // Reinicio con ambos proyectos válidos recupera alpha + Flow + proporción.
  const boot1 = resolveStartupShell(valid, storage);
  assert.equal(boot1.project, '/repos/alpha');
  assert.equal(boot1.shell.activeTool, 'flow');
  assert.equal(boot1.shell.mode, 'split');
  assert.ok(Math.abs(boot1.shell.workspaceRatio - alphaShell.workspaceRatio) < 0.001);

  // Cambiar a beta (en Workspace completo) no mezcla el estado de alpha.
  const betaShell = onProjectSelected(boot1.shell);
  persistShellState('/repos/beta', betaShell, valid, storage);
  const boot2 = resolveStartupShell(valid, storage);
  assert.equal(boot2.project, '/repos/beta');
  assert.equal(boot2.shell.activeTool, null);
  assert.equal(boot2.shell.mode, 'workspace');

  // Si beta desaparece o se archiva, el arranque vuelve a Workspace + Inicio sin proyecto.
  const bootMissing = resolveStartupShell(['/repos/alpha'], storage);
  assert.equal(bootMissing.project, null);
  assert.equal(bootMissing.shell.activeTool, 'inicio');
  assert.equal(bootMissing.shell.mode, 'split');
});

test('la cabecera marca la disposición visible, no solo la preferida', () => {
  // Con panel, se marca la preferencia.
  assert.equal(visibleDisposition('chat', true, false), 'chat');
  assert.equal(visibleDisposition('split', true, false), 'split');
  assert.equal(visibleDisposition('code', true, false), 'code');
  // Al cerrar el panel desde Cambios, Archivos, ⌘I o ⌘W solo queda la conversación.
  assert.equal(visibleDisposition('split', false, false), 'chat');
  assert.equal(visibleDisposition('code', false, false), 'chat');
  // Observación acompaña a la conversación aunque se prefiera Código.
  assert.equal(visibleDisposition('code', true, true), 'split');
  assert.equal(visibleDisposition('chat', true, true), 'chat');
});
