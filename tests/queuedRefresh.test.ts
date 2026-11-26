import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queuedRefresh } from '../src/queuedRefresh.ts';

test('agrupa una ráfaga durante una consulta en una sola recarga', async () => {
  const complete: ((value: number) => void)[] = [];
  const values: number[] = [];
  const queue = queuedRefresh(
    () => new Promise<number>((resolve) => complete.push(resolve)),
    (value) => values.push(value),
    assert.fail,
  );
  const first = queue.refresh();
  await Promise.all([queue.refresh(), queue.refresh(), queue.refresh()]);
  assert.equal(complete.length, 1);
  complete[0](1);
  await Promise.resolve();
  assert.equal(complete.length, 2);
  complete[1](2);
  await first;
  assert.deepEqual(values, [1, 2]);
});

test('al cerrar la vista descarta la respuesta y los avisos pendientes', async () => {
  const complete: ((value: number) => void)[] = [];
  const queue = queuedRefresh(
    () => new Promise<number>((resolve) => complete.push(resolve)),
    assert.fail,
    assert.fail,
  );
  const first = queue.refresh();
  await queue.refresh();
  queue.stop();
  complete[0](1);
  await first;
  assert.equal(complete.length, 1);
});
