// Pruebas de la lógica pura de Trama: node --experimental-strip-types --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinConstraints, parseConstraints } from '../src/trama/constraints.ts';

test('los bloqueos sobreviven a una ida y vuelta por las restricciones', () => {
  const text = '[bloqueo 0,0,100,12] Cabecera\nTipografía SF Pro';
  const parsed = parseConstraints(text);
  assert.deepEqual(parsed.locks, [{ region: { x: 0, y: 0, width: 100, height: 12 }, text: 'Cabecera' }]);
  assert.equal(parsed.rest, 'Tipografía SF Pro');
  assert.equal(joinConstraints(parsed.locks, parsed.rest), text);
});

test('las restricciones libres no se convierten en bloqueos', () => {
  const parsed = parseConstraints('No cambiar el pie\n[bloqueo roto] algo');
  assert.equal(parsed.locks.length, 0);
  assert.equal(parsed.rest, 'No cambiar el pie\n[bloqueo roto] algo');
});

test('las regiones se redondean a una décima', () => {
  assert.equal(joinConstraints([{ region: { x: 1.234, y: 2.25, width: 3.333, height: 4 }, text: ' Botón ' }], ''), '[bloqueo 1.2,2.3,3.3,4] Botón');
});

test('los hallazgos de varios revisores de un mismo informe se agrupan con quién los señala', async () => {
  const { openFindings } = await import('../src/trama/findings.ts');
  const finding = (rule: string, path: string, line: number, severity: string, title: string | null = null) =>
    ({ fingerprint: `${rule}-${path}-${line}-${severity}`, path, line, rule, title, severity, previous: false, status: 'open', resolution: '' });
  const run = (id: number, tool: string, digest: string | null, findings: ReturnType<typeof finding>[]) =>
    ({ id, task: null, tool, version: null, source: 'SARIF 2.1.0', revision: null, digest, outcome: 'findings', observed: 0, findings });
  const runs = [
    run(3, 'Codex', 'abc:1', [finding('f1', 'src-tauri/src/git_ops.rs', 27, 'error', 'push sin protección'), finding('f3', 'src/GitPanel.tsx', 7, 'warning')]),
    run(2, 'Claude Opus', 'abc:0', [finding('f2', 'src-tauri/src/git_ops.rs', 20, 'warning'), finding('f1', 'src-tauri/src/git_ops.rs', 27, 'warning')]),
    run(1, 'Antiguo', 'old:0', [finding('f9', 'a.rs', 1, 'error')]),
  ];
  const merged = openFindings(runs);
  assert.deepEqual(merged.map((item) => [item.rule, item.who, item.severity]), [
    ['f1', ['Claude Opus', 'Codex'], 'error'], ['f2', ['Claude Opus'], 'warning'], ['f3', ['Codex'], 'warning'],
  ]);
  assert.equal(merged[0].title, 'push sin protección');
  assert.deepEqual(openFindings([run(5, 'git', null, [finding('x', 'b.ts', 2, 'note')]), runs[0]]).map((item) => item.who), [['git']]);
  assert.deepEqual(openFindings(null), []);
});
