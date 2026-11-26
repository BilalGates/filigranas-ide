import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMountedConversations,
  CONTEXT_STORAGE_KEY,
  deriveWorkspaceContext,
  loadPersistedContext,
  parsePmActivityKey,
  pmActivityKey,
  resolveProjectEntry,
  savePersistedContext,
  selectionKey,
  type ActiveSelection,
  type SessionRef,
} from '../src/trama/workspaceContext.ts';
import type { StorageLike } from '../src/trama/workspaceLayout.ts';

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

const sA1: SessionRef = { id: 101, project: '/repos/filigranas', name: 'xavi', title: 'Rediseño UI', engine: 'claude', status: 'trabajando' };
const sA2: SessionRef = { id: 102, project: '/repos/filigranas', name: 'iniesta', title: 'Auditoría', engine: 'codex', status: null };
const sB1: SessionRef = { id: 201, project: '/repos/asserta', name: 'puyol', title: 'Desarrollo Gantt', engine: 'codex', status: null };

test('proyecto activo se deriva estrictamente de la sesión seleccionada', () => {
  const byId = new Map<number, SessionRef>([[sA1.id, sA1], [sA2.id, sA2], [sB1.id, sB1]]);
  const valid = ['/repos/filigranas', '/repos/asserta'];

  const ctxA = deriveWorkspaceContext({
    selection: { kind: 'session', sessionId: sA1.id, project: '/repos/filigranas' },
    validProjects: valid,
    sessionsById: byId,
    catalogLoaded: true,
  });
  assert.equal(ctxA.project, '/repos/filigranas');
  assert.equal(ctxA.view, sA1.id);
  assert.equal(ctxA.activeSession?.id, sA1.id);
  assert.equal(ctxA.staleReason, null);

  // Cambio de sesión a otro proyecto actualiza automáticamente activeProject.
  const ctxB = deriveWorkspaceContext({
    selection: { kind: 'pm', project: '/repos/asserta' },
    validProjects: valid,
    sessionsById: byId,
    catalogLoaded: true,
  });
  assert.equal(ctxB.project, '/repos/asserta');
  assert.equal(ctxB.view, 'coach');
  assert.equal(ctxB.activeSession, null);
  assert.equal(ctxB.staleReason, null);
});

test('nunca reasigna silenciosamente sesiones huérfanas ni con proyecto discordante', () => {
  const byId = new Map<number, SessionRef>([[sB1.id, sB1]]);
  const valid = ['/repos/filigranas', '/repos/asserta'];

  // Selección corrupta: sessionId de asserta asociada a filigranas.
  const mismatch = deriveWorkspaceContext({
    selection: { kind: 'session', sessionId: sB1.id, project: '/repos/filigranas' },
    validProjects: valid,
    sessionsById: byId,
    catalogLoaded: true,
  });
  assert.equal(mismatch.staleReason, 'session_mismatch');
  assert.equal(mismatch.project, '/repos/filigranas');
  assert.equal(mismatch.activeSession, null);
  assert.ok(mismatch.staleNotice);

  // Sesión que dejó de existir tras cargar catálogo.
  const missingSession = deriveWorkspaceContext({
    selection: { kind: 'session', sessionId: 999, project: '/repos/filigranas' },
    validProjects: valid,
    sessionsById: byId,
    catalogLoaded: true,
  });
  assert.equal(missingSession.staleReason, 'session_missing');
  assert.equal(missingSession.project, '/repos/filigranas');
  assert.equal(missingSession.view, 'coach');
  assert.ok(missingSession.staleNotice);

  // Proyecto archivado o borrado.
  const missingProject = deriveWorkspaceContext({
    selection: { kind: 'session', sessionId: sA1.id, project: '/repos/borrado' },
    validProjects: valid,
    sessionsById: byId,
    catalogLoaded: true,
  });
  assert.equal(missingProject.staleReason, 'project_missing');
  assert.equal(missingProject.project, null);
  assert.equal(missingProject.selection, null);
  assert.ok(missingProject.staleNotice);
});

test('durante la hidratación inicial conserva la sesión guardada hasta cargar el catálogo', () => {
  const pending = deriveWorkspaceContext({
    selection: { kind: 'session', sessionId: sA1.id, project: '/repos/filigranas' },
    validProjects: ['/repos/filigranas'],
    sessionsById: new Map(),
    catalogLoaded: false,
  });
  assert.equal(pending.project, '/repos/filigranas');
  assert.equal(pending.view, sA1.id);
  assert.equal(pending.staleReason, null);
});

test('Inicio recupera la última sesión válida del proyecto o entra a su PM/flujo real sin inventar sesiones', () => {
  const valid = ['/repos/filigranas', '/repos/asserta', '/repos/nuevo'];
  const lastByProject: Record<string, ActiveSelection> = {
    '/repos/filigranas': { kind: 'session', sessionId: sA2.id, project: '/repos/filigranas' },
    '/repos/asserta': { kind: 'session', sessionId: 999, project: '/repos/asserta' }, // cerrada
  };

  // 1. Última sesión sigue abierta -> la recupera.
  const recovered = resolveProjectEntry({
    project: '/repos/filigranas',
    validProjects: valid,
    lastByProject,
    projectSessions: [sA1, sA2],
    hasPm: true,
  });
  assert.deepEqual(recovered, { kind: 'session', sessionId: sA2.id, project: '/repos/filigranas' });

  // 2. Última sesión ya no existe, pero tiene PM activo -> entra al PM.
  const fallbackPm = resolveProjectEntry({
    project: '/repos/asserta',
    validProjects: valid,
    lastByProject,
    projectSessions: [sB1],
    hasPm: true,
  });
  assert.deepEqual(fallbackPm, { kind: 'pm', project: '/repos/asserta' });

  // 3. Sin PM y última sesión cerrada, pero existe otra sesión abierta -> entra a la sesión abierta.
  const fallbackOpen = resolveProjectEntry({
    project: '/repos/asserta',
    validProjects: valid,
    lastByProject,
    projectSessions: [sB1],
    hasPm: false,
  });
  assert.deepEqual(fallbackOpen, { kind: 'session', sessionId: sB1.id, project: '/repos/asserta' });

  // 4. Proyecto nuevo sin PM ni sesiones -> entra al flujo real (vista coach/bienvenida) sin crear sesiones falsas.
  const fresh = resolveProjectEntry({
    project: '/repos/nuevo',
    validProjects: valid,
    lastByProject,
    projectSessions: [],
    hasPm: false,
  });
  assert.deepEqual(fresh, { kind: 'pm', project: '/repos/nuevo' });
});

test('mantiene montadas conversaciones visitadas y en ejecución en segundo plano entre proyectos', () => {
  const valid = ['/repos/filigranas', '/repos/asserta'];
  const active: ActiveSelection = { kind: 'pm', project: '/repos/asserta' };
  const visited = new Set<string>([selectionKey({ kind: 'session', sessionId: sA2.id, project: '/repos/filigranas' }), pmActivityKey('/repos/asserta')]);
  const mounted = computeMountedConversations({
    active,
    visitedKeys: visited,
    sessionsByProject: {
      '/repos/filigranas': [sA1, sA2],
      '/repos/asserta': [sB1],
    },
    pmProjects: new Set(['/repos/filigranas', '/repos/asserta']),
    validProjects: valid,
    activity: { [pmActivityKey('/repos/filigranas')]: 'permiso' },
  });

  // PM de filigranas (pide permiso en segundo plano) + PM de asserta (activo) siguen montados.
  assert.deepEqual(mounted.pmProjects, ['/repos/filigranas', '/repos/asserta']);
  // sA1 (trabajando en segundo plano) + sA2 (visitada) siguen montadas; sB1 (no visitada ni activa) no se monta innecesariamente.
  assert.deepEqual(mounted.sessions.map((s) => s.id), [sA1.id, sA2.id]);
});

test('persiste y recupera última sesión y contexto por proyecto con compatibilidad hacia atrás', () => {
  const valid = ['/repos/filigranas', '/repos/asserta'];
  const storage = memoryStorage();
  const active: ActiveSelection = { kind: 'session', sessionId: sA1.id, project: '/repos/filigranas' };
  savePersistedContext(
    active,
    {
      '/repos/asserta': { kind: 'session', sessionId: sB1.id, project: '/repos/asserta' },
      '/repos/borrado': { kind: 'pm', project: '/repos/borrado' },
    },
    valid,
    storage,
  );

  const loaded = loadPersistedContext(valid, storage);
  assert.deepEqual(loaded.active, active);
  assert.deepEqual(loaded.lastByProject['/repos/asserta'], { kind: 'session', sessionId: sB1.id, project: '/repos/asserta' });
  assert.equal(loaded.lastByProject['/repos/borrado'], undefined);
  assert.equal(loaded.missingProject, null);

  // Compatibilidad con `filigranas.retomar` cuando no existe `filigranas.context.v1`.
  const legacyStorage = memoryStorage({
    'filigranas.retomar': JSON.stringify({ project: '/repos/asserta', view: 201, at: 1234 }),
  });
  assert.equal(legacyStorage.getItem(CONTEXT_STORAGE_KEY), null);
  const legacy = loadPersistedContext(valid, legacyStorage);
  assert.deepEqual(legacy.active, { kind: 'session', sessionId: 201, project: '/repos/asserta' });

  // Si el proyecto guardado ya no existe, reporta `missingProject` sin reasignarlo a otro.
  const stale = loadPersistedContext(['/repos/filigranas'], storage);
  assert.deepEqual(stale.active, active);
  const gone = loadPersistedContext(['/repos/otro'], storage);
  assert.equal(gone.active, null);
  assert.equal(gone.missingProject, '/repos/filigranas');
});

test('claves de actividad de Project Manager están aisladas por proyecto', () => {
  const key = pmActivityKey('/repos/filigranas');
  assert.equal(key, 'pm:/repos/filigranas');
  assert.equal(parsePmActivityKey(key), '/repos/filigranas');
  assert.equal(parsePmActivityKey('101'), null);
  assert.equal(parsePmActivityKey('coach'), null);
});
