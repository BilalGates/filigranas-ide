import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActivityFeed,
  buildAttentionItems,
  buildProjectLibrary,
  rankContinueSessions,
} from '../src/trama/homeModel.ts';
import type { Group, HomeActivityItem, HomeSummary, Project, RecentSession, Session } from '../src/ipc.ts';

const PROJECTS: Project[] = [
  { name: 'Bitacola', path: '/repos/bitacola', groupId: 1, archived: false },
  { name: 'Filigranas', path: '/repos/filigranas', groupId: 1, archived: false },
  { name: 'Kaza', path: '/repos/kaza', groupId: null, archived: false },
  { name: 'Viejo', path: '/repos/viejo', groupId: null, archived: true },
];
const GROUPS: Group[] = [{ id: 1, name: 'Activos' }];

const RECENT: RecentSession[] = [
  {
    project: '/repos/kaza',
    sessionId: 10,
    isPm: false,
    name: 'sesión 1',
    engine: 'claude',
    branch: 'feat/auth',
    task: 'Añadir login OAuth\nDetalles extra',
    closed: false,
    running: false,
    lastActiveMs: 2_000,
  },
  {
    project: '/repos/bitacola',
    sessionId: null,
    isPm: true,
    name: 'Project manager',
    engine: 'codex',
    branch: 'main',
    task: null,
    closed: false,
    running: false,
    lastActiveMs: 1_000,
  },
  {
    project: '/repos/filigranas',
    sessionId: 22,
    isPm: false,
    name: 'Auditor',
    engine: 'claude',
    branch: 'feat/home',
    task: 'Revisar Inicio',
    closed: true,
    running: false,
    lastOutcome: 'failed',
    lastActiveMs: 3_000,
  },
  {
    project: '/repos/viejo',
    sessionId: 99,
    isPm: false,
    name: 'Archivada',
    engine: 'codex',
    branch: 'main',
    task: null,
    closed: false,
    lastActiveMs: 9_999,
  },
];

test('rankContinueSessions excluye archivados y prioriza permisos y sesiones en curso sobre histórico', () => {
  const ranked = rankContinueSessions(
    RECENT,
    PROJECTS,
    { coach: 'permiso' },
    '/repos/bitacola',
  );
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].projectName, 'Bitacola');
  assert.equal(ranked[0].status.state, 'waiting');
  assert.equal(ranked[1].projectName, 'Filigranas');
  assert.equal(ranked[1].status.state, 'failed');
  assert.equal(ranked[2].projectName, 'Kaza');
  assert.equal(ranked[2].description, 'Añadir login OAuth');
});

test('buildAttentionItems devuelve solo eventos reales y queda vacío cuando todo está en calma', () => {
  const calm = buildAttentionItems({
    projects: PROJECTS,
    snaps: {},
    agentSessions: [],
    liveActivity: {},
    currentProject: '/repos/bitacola',
  });
  assert.deepEqual(calm, []);

  const snaps: Record<string, HomeSummary> = {
    '/repos/kaza': {
      path: '/repos/kaza',
      tasks: [{ id: 4, title: 'Migración SQL', status: 'blocked', updatedAt: 100 }],
      sessions: [],
      work: null,
      branch: 'feat/auth',
      dates: null,
      ci: {
        number: 16,
        url: 'https://example.invalid/pr/16',
        state: 'OPEN',
        isDraft: false,
        branch: 'feat/auth',
        base: 'main',
        head: 'abc1234',
        checks: [13, 1, 0],
        checksState: 'failure',
        checksKnown: true,
        review: null,
        mergeState: 'BLOCKED',
        observedAt: 200,
      },
    },
  };
  const agentSessions: Session[] = [
    { id: 10, project: '/repos/bitacola', engine: 'claude', name: 'Senior', task: 'Ejecutar migración', branch: 'main', worktree: null, base: null, paused: null },
  ];
  const alerts = buildAttentionItems({
    projects: PROJECTS,
    snaps,
    agentSessions,
    liveActivity: { '10': 'permiso' },
    currentProject: '/repos/bitacola',
  });
  assert.equal(alerts.length, 3);
  assert.equal(alerts[0].severity, 'waiting');
  assert.deepEqual(alerts[0].target, { kind: 'session', project: '/repos/bitacola', view: 10 });
  assert.ok(alerts.some((a) => a.target.kind === 'ci' && a.project === '/repos/kaza'));
  assert.ok(alerts.some((a) => a.target.kind === 'task' && a.target.taskId === 4));
});

test('buildActivityFeed separa claramente en curso, pendiente e histórico', () => {
  const continueSessions = rankContinueSessions(RECENT, PROJECTS, { coach: 'trabajando' }, '/repos/bitacola');
  const backendActivity: HomeActivityItem[] = [
    {
      id: 'task:8:done',
      kind: 'task_done',
      phase: 'history',
      project: '/repos/filigranas',
      title: 'Publicar rediseño',
      detail: 'Tarea #8 completada',
      timestampMs: 5_000,
      sessionId: null,
      taskId: 8,
    },
    {
      id: 'review:3',
      kind: 'review',
      phase: 'history',
      project: '/repos/kaza',
      title: 'Revisión · Auditor',
      detail: 'Sin hallazgos',
      timestampMs: 4_000,
      sessionId: 10,
      taskId: null,
    },
  ];

  const feed = buildActivityFeed({
    continueSessions,
    attentionItems: [],
    backendActivity,
    snaps: {},
    projects: PROJECTS,
  });

  assert.equal(feed[0].phase, 'live');
  assert.equal(feed[0].project, '/repos/bitacola');
  assert.equal(feed[1].phase, 'history');
  assert.equal(feed[1].id, 'task:8:done');
  assert.equal(feed[2].phase, 'history');
  assert.equal(feed[2].id, 'review:3');
});

test('buildProjectLibrary busca por nombre/rama/sesión, ordena y selecciona última sesión válida', () => {
  const byActivity = buildProjectLibrary({
    projects: PROJECTS,
    groups: GROUPS,
    snaps: {},
    recentSessions: RECENT,
    liveActivity: {},
    currentProject: '/repos/bitacola',
    query: '',
    sortBy: 'activity',
    grouped: false,
  });
  assert.equal(byActivity.length, 1);
  assert.deepEqual(
    byActivity[0].items.map((e) => e.project.name),
    ['Filigranas', 'Kaza', 'Bitacola'],
  );
  assert.equal(byActivity[0].items[1].latestSession?.sessionId, 10);

  const filtered = buildProjectLibrary({
    projects: PROJECTS,
    groups: GROUPS,
    snaps: {},
    recentSessions: RECENT,
    liveActivity: {},
    currentProject: null,
    query: 'oauth',
    sortBy: 'name',
    grouped: true,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].label, 'Sin grupo');
  assert.equal(filtered[0].items[0].project.name, 'Kaza');
});
