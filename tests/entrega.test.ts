import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LAYOUT_PREFS,
  buildFileTree,
  clearEntregaStore,
  commitFilesToTreeItems,
  computeBranchSignals,
  computeTimelineStages,
  getEntregaState,
  resolveEntregaLayout,
  setEntregaState,
} from '../src/trama/entrega/entregaStore.ts';
import { layoutCommitGraph } from '../src/trama/entrega/commitGraphLayout.ts';

test('buildFileTree construye jerarquía real de carpetas con totales acumulados', () => {
  const tree = buildFileTree([
    { path: 'README.md', orig: null, status: 'M', staged: 'M', unstaged: null, adds: 2, dels: 1 },
    { path: 'src/trama/Entrega.tsx', orig: null, status: 'M', staged: null, unstaged: 'M', adds: 40, dels: 10 },
    { path: 'src/trama/entrega/BranchExplorer.tsx', orig: null, status: 'A', staged: 'A', unstaged: 'M', adds: 120, dels: 0 },
  ]);

  assert.equal(tree.length, 2);
  assert.equal(tree[0].kind, 'dir');
  assert.equal(tree[0].name, 'src');
  if (tree[0].kind === 'dir') {
    assert.equal(tree[0].filesCount, 2);
    assert.equal(tree[0].adds, 160);
    assert.equal(tree[0].dels, 10);
    const trama = tree[0].children[0];
    assert.equal(trama.kind, 'dir');
    if (trama.kind === 'dir') {
      assert.equal(trama.name, 'trama');
      assert.equal(trama.children.length, 2);
      assert.equal(trama.children[0].kind, 'dir');
      assert.equal(trama.children[1].kind, 'file');
    }
  }
  assert.equal(tree[1].kind, 'file');
  assert.equal(tree[1].name, 'README.md');
});

test('commitFilesToTreeItems proyecta archivos de un commit seleccionado para el árbol central', () => {
  const items = commitFilesToTreeItems({
    hash: 'abc1234567890',
    author: 'Bilal',
    date: '2026-11-28T00:00:00Z',
    body: 'feat(entrega): grafo real',
    files: [
      { status: 'M', path: 'src/trama/Entrega.tsx', adds: 12, dels: 4 },
      { status: 'A', path: 'src/trama/entrega/CommitGraph.tsx', adds: 210, dels: 0 },
    ],
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].section, 'commit');
  assert.equal(items[1].status, 'A');
  assert.equal(items[1].adds, 210);
});

test('computeBranchSignals condensa sincronización, PR, CI y worktree sin exceso de etiquetas', () => {
  const sig = computeBranchSignals(
    {
      name: 'feat/entrega',
      refName: 'refs/heads/feat/entrega',
      local: true,
      remote: true,
      remoteName: 'origin',
      remoteRef: 'origin/feat/entrega',
      upstream: 'origin/feat/entrega',
      published: true,
      active: true,
      isDefault: false,
      ahead: 2,
      behind: 1,
      diverged: true,
      headOid: '1234567890abcdef',
      shortOid: '1234567',
      subject: 'feat: entrega',
      author: 'Bilal',
      committedAt: '2026-11-27T12:00:00Z',
      mergedIntoDefault: false,
      worktreePath: '/tmp/wt',
      agents: [{ sessionId: 1, name: 'Agente 1', engine: 'claude', worktree: '/tmp/wt', active: true }],
    },
    {
      number: 42,
      title: 'Rediseño de Entrega',
      url: 'https://github.com/o/r/pull/42',
      state: 'OPEN',
      isDraft: false,
      branch: 'feat/entrega',
      base: 'main',
      headOid: '1234567890abcdef',
      author: 'bilal',
      updatedAt: '2026-11-27T12:00:00Z',
      mergedAt: null,
      mergeCommitOid: null,
      reviewDecision: 'CHANGES_REQUESTED',
      mergeState: 'BLOCKED',
      checksPassed: 3,
      checksFailed: 1,
      checksPending: 0,
      checksState: 'failure',
    },
  );

  assert.equal(sig.syncLabel, '↑2↓1');
  assert.equal(sig.syncTone, 'coral');
  assert.equal(sig.prLabel, '#42');
  assert.equal(sig.prTone, 'coral');
  assert.equal(sig.ciTone, 'coral');
  assert.equal(sig.hasWorktree, true);
  assert.equal(sig.agentBusy, true);
});

test('computeTimelineStages devuelve las 8 etapas de Trama v2 y distingue estados reales y etapa en ejecución', () => {
  const stages = computeTimelineStages({
    branch: {
      name: 'feat/x',
      refName: 'refs/heads/feat/x',
      local: true,
      remote: true,
      remoteName: 'origin',
      remoteRef: 'origin/feat/x',
      upstream: 'origin/feat/x',
      published: true,
      active: true,
      isDefault: false,
      ahead: 0,
      behind: 0,
      diverged: false,
      headOid: 'newhead1234567',
      shortOid: 'newhead',
      subject: 'fix',
      author: 'Bilal',
      committedAt: '2026-11-27T12:00:00Z',
      mergedIntoDefault: false,
      worktreePath: null,
      agents: [],
    },
    status: {
      branch: 'feat/x',
      head: 'newhead',
      headSha: 'newhead1234567',
      upstream: 'origin/feat/x',
      ahead: 0,
      behind: 0,
      changes: [],
    },
    compareCount: 3,
    pr: {
      number: 18,
      title: 'feat/x',
      url: 'https://github.com/o/r/pull/18',
      state: 'OPEN',
      isDraft: false,
      branch: 'feat/x',
      base: 'main',
      headOid: 'newhead1234567',
      author: 'bilal',
      updatedAt: '2026-11-27T12:00:00Z',
      mergedAt: null,
      mergeCommitOid: null,
      reviewDecision: null,
      mergeState: 'BLOCKED',
      checksPassed: 2,
      checksFailed: 0,
      checksPending: 1,
      checksState: 'pending',
    },
    healthRuns: [
      {
        id: 1,
        task: null,
        tool: 'test',
        version: null,
        source: 'local',
        revision: 'oldhead0000000',
        digest: null,
        outcome: 'ok',
        observed: 1,
        findings: [],
      },
    ],
    openFindingsCount: 0,
    workSession: null,
    tasks: [],
    agentSessions: [],
    automation: null,
  });

  assert.deepEqual(
    stages.map((s) => s.id),
    ['tareas', 'agentes', 'cambios', 'tests', 'commit', 'pr', 'ci', 'integracion'],
  );
  const testsStage = stages.find((s) => s.id === 'tests');
  assert.equal(testsStage?.status, 'blocked');
  assert.equal(testsStage?.detail, 'obsoleta');

  const ciStage = stages.find((s) => s.id === 'ci');
  assert.equal(ciStage?.status, 'active');
  assert.equal(ciStage?.isExecuting, true);

  const intStage = stages.find((s) => s.id === 'integracion');
  assert.equal(intStage?.status, 'blocked');
});

test('resolveEntregaLayout mantiene columnas utilizables con Workspace abierto y compactado', () => {
  const compactWs = resolveEntregaLayout(DEFAULT_LAYOUT_PREFS, 1360, 740);
  assert.equal(compactWs.compactColumns, false);
  assert.ok(compactWs.branchesPx >= 176);
  assert.ok(compactWs.treePx >= 190);
  assert.ok(compactWs.rightPx >= 320);
  assert.ok(compactWs.historyPx >= 136 && compactWs.historyPx <= 420);

  const openWs = resolveEntregaLayout({ branchesRatio: 0.35, treeRatio: 0.36, historyRatio: 0.32 }, 760, 560);
  assert.equal(openWs.compactColumns, true);
  assert.ok(openWs.branchesPx >= 130);
  assert.ok(openWs.treePx >= 130);
  assert.ok(openWs.rightPx >= 200);
  assert.ok(openWs.branchesPx + openWs.treePx + openWs.rightPx <= 760);
});

test('layoutCommitGraph representa topología real de merges, bifurcaciones y HEAD', () => {
  const graph = layoutCommitGraph([
    { hash: 'c4', parents: ['c3', 'c2'], refs: 'HEAD -> main, origin/main', author: 'Bilal', date: '2026-11-28T00:00:00Z', subject: 'Merge branch feat' },
    { hash: 'c3', parents: ['c1'], refs: '', author: 'Bilal', date: '2026-11-27T23:00:00Z', subject: 'main commit' },
    { hash: 'c2', parents: ['c1'], refs: 'feat/demo', author: 'Bilal', date: '2026-11-27T22:00:00Z', subject: 'feat commit' },
    { hash: 'c1', parents: [], refs: '', author: 'Bilal', date: '2026-11-27T21:00:00Z', subject: 'init' },
  ]);

  assert.equal(graph.dots.length, 4);
  assert.equal(graph.dots[0].kind, 'merge');
  assert.ok(graph.lines.length >= 4);
  // c3 y c2 ocupan carriles distintos antes de converger en c1
  assert.notEqual(graph.dots[1].x, graph.dots[2].x);
  assert.equal(graph.dots[3].x, graph.dots[1].x);
});

test('entregaStore aísla completamente el estado entre proyectos', () => {
  clearEntregaStore();
  setEntregaState('/repo/a', {
    inspectedBranch: 'feat/a',
    treePerspective: 'branch',
    selectedStage: 'pr',
    selectedCommit: '111aaaa',
    historyScope: 'branch',
  });
  setEntregaState('/repo/b', {
    inspectedBranch: 'fix/b',
    treePerspective: 'uncommitted',
    selectedStage: 'commit',
    selectedCommit: null,
    historyScope: 'all',
  });

  const a = getEntregaState('/repo/a');
  const b = getEntregaState('/repo/b');
  assert.equal(a.inspectedBranch, 'feat/a');
  assert.equal(a.treePerspective, 'branch');
  assert.equal(a.selectedStage, 'pr');
  assert.equal(a.selectedCommit, '111aaaa');
  assert.equal(a.historyScope, 'branch');

  assert.equal(b.inspectedBranch, 'fix/b');
  assert.equal(b.treePerspective, 'uncommitted');
  assert.equal(b.selectedStage, 'commit');
  assert.equal(b.selectedCommit, null);
  assert.equal(b.historyScope, 'all');
});
