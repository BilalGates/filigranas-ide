import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFileTree,
  clearEntregaStore,
  computeBranchBadges,
  computePipelineStages,
  getEntregaState,
  setEntregaState,
} from '../src/trama/entrega/entregaStore.ts';

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

test('computeBranchBadges representa múltiples condiciones coexistentes sin colapsarlas', () => {
  const badges = computeBranchBadges(
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

  const keys = badges.map((b) => b.key);
  assert.deepEqual(keys, ['active', 'pub', 'div', 'wt', 'pr', 'ci', 'rev']);
  assert.equal(badges.find((b) => b.key === 'ci')?.tone, 'coral');
  assert.equal(badges.find((b) => b.key === 'rev')?.tone, 'coral');
});

test('computePipelineStages detecta verificación obsoleta cuando HEAD cambia', () => {
  const stages = computePipelineStages({
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
    status: { branch: 'feat/x', head: 'newhead', headSha: 'newhead1234567', upstream: 'origin/feat/x', ahead: 0, behind: 0, changes: [] },
    compareCount: 3,
    pr: null,
    healthRuns: [
      { id: 1, task: null, tool: 'test', version: null, source: 'local', revision: 'oldhead0000000', digest: null, outcome: 'ok', observed: 1, findings: [] },
    ],
    openFindingsCount: 0,
    workSession: null,
  });

  assert.equal(stages.length, 7);
  const verif = stages.find((s) => s.id === 'verificacion');
  assert.equal(verif?.tone, 'warn');
  assert.equal(verif?.detail, 'obsoleta');
});

test('entregaStore aísla completamente el estado entre proyectos', () => {
  clearEntregaStore();
  setEntregaState('/repo/a', { inspectedBranch: 'feat/a', treePerspective: 'branch', centerTab: 'pr', inspectorOpen: true });
  setEntregaState('/repo/b', { inspectedBranch: 'fix/b', treePerspective: 'uncommitted', centerTab: 'commits', inspectorOpen: false });

  const a = getEntregaState('/repo/a');
  const b = getEntregaState('/repo/b');
  assert.equal(a.inspectedBranch, 'feat/a');
  assert.equal(a.treePerspective, 'branch');
  assert.equal(a.centerTab, 'pr');
  assert.equal(a.inspectorOpen, true);

  assert.equal(b.inspectedBranch, 'fix/b');
  assert.equal(b.treePerspective, 'uncommitted');
  assert.equal(b.centerTab, 'commits');
  assert.equal(b.inspectorOpen, false);
});
