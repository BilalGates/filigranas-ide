import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { unifiedDiff } from '../src/unifiedDiff.ts';

test('diff unificado conserva ambos números y las líneas exactas', () => {
  const { rows, limited } = unifiedDiff('inicio\n  previo\nfin', 'inicio\n  nuevo\nfin');
  assert.equal(limited, false);
  assert.deepEqual(rows, [
    { text: 'inicio', original: 1, modified: 1 },
    { text: '  previo', original: 2, type: 'removed' },
    { text: '  nuevo', modified: 2, type: 'added' },
    { text: 'fin', original: 3, modified: 3 },
  ]);
});

test('diff unificado representa altas y borrados sin una línea fantasma', () => {
  assert.deepEqual(unifiedDiff('', 'nuevo').rows, [{ text: 'nuevo', modified: 1, type: 'added' }]);
  assert.deepEqual(unifiedDiff('previo', '').rows, [{ text: 'previo', original: 1, type: 'removed' }]);
});

test('el salto de línea final no añade una fila vacía al diff', () => {
  const rows = unifiedDiff('a\nb\n', 'a\nc\n').rows;
  assert.deepEqual(rows.map((row) => [row.text, row.type ?? '']), [['a', ''], ['b', 'removed'], ['c', 'added']]);
});

test('un cambio que solo quita o añade el salto final se marca sin filas vacías', () => {
  const removed = unifiedDiff('a\nb\n', 'a\nb');
  assert.deepEqual(removed.rows.map((row) => row.type ?? ''), ['', '']);
  assert.equal(removed.noFinalNewline, 'modified');
  assert.equal(unifiedDiff('a', 'a\n').noFinalNewline, 'original');
  assert.equal(unifiedDiff('a\n', 'b\n').noFinalNewline, null);
  // Como git: un archivo nuevo sin salto final también se marca.
  assert.equal(unifiedDiff('', 'a').noFinalNewline, 'modified');
});
