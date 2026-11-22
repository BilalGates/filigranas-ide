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
