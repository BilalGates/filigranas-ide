import test from 'node:test';
import assert from 'node:assert/strict';
import { flowStatus, flowProgress, placeInspector, taskSelection, inspectorKey, flowPositions } from '../src/trama/flowModel.ts';
test('legacy verification and cancellation never claim execution or success', () => {
    assert.equal(flowStatus('verifying'), 'verifying');
    assert.equal(flowStatus('cancelled'), 'cancelled');
    assert.equal(flowStatus('failed'), 'failed');
    assert.deepEqual(flowProgress([{ status: 'done' }, { status: 'cancelled' }, { status: 'verifying' }]), { done: 1, total: 3, percent: 33 });
    assert.equal(flowProgress([]).percent, 0);
});
test('canonical phase overrides stale operational status', () => {
    assert.equal(flowStatus('running', 'interrupted'), 'interrupted');
    assert.equal(flowStatus('ready', 'waiting_dependencies'), 'waiting_dependencies');
    assert.equal(flowStatus('running', 'waiting_permission'), 'waiting');
    assert.equal(flowStatus('review', 'verifying'), 'verifying');
    assert.equal(flowStatus('ready', 'running'), 'running');
    assert.equal(flowStatus('ready', 'queued'), 'queued');
});
test('selection is scoped to project and available plan entities', () => {
    const selection = { project: 'a', id: '1' };
    assert.equal(taskSelection('b', selection, ['1'], [], []), null);
    assert.equal(taskSelection('a', selection, [], [], []), null);
    assert.equal(taskSelection('a', selection, ['1'], [], []), '1');
    assert.equal(taskSelection('a', { project: 'a', id: 'run:8' }, [], [], ['run:8']), 'run:8');
});
test('inspector flips horizontally and clamps vertically at viewport edges', () => {
    assert.deepEqual(placeInspector(1000, 700, 390, 500, { x: 850, y: 650, width: 100, height: 50 }), { x: 448, y: 192 });
    const p = placeInspector(480, 320, 390, 304, { x: -200, y: -100, width: 30, height: 30 });
    assert.deepEqual(p, { x: 8, y: 8 });
    const absent = placeInspector(1000, 700, 390, 500, null);
    assert.equal(absent.x, 598);
    assert.equal(absent.y, 12);
});
test('keyboard closes and walks tasks without wrapping beyond bounds', () => {
    assert.equal(inspectorKey('Escape', ['1', '2'], '1'), null);
    assert.equal(inspectorKey('ArrowDown', ['1', '2'], '1'), '2');
    assert.equal(inspectorKey('ArrowDown', ['1', '2'], '2'), '2');
    assert.equal(inspectorKey('ArrowUp', ['1', '2'], '1'), '1');
});
test('lane geometry reserves stacked cards and agent label bounds', () => {
    const tasks = [{ id: '1', agent: 'a', lvl: 0 }, { id: '2', agent: 'a', lvl: 0 }, { id: '3', agent: 'b', lvl: 0 }, { id: '4', agent: 'b', lvl: 1 }];
    const l = flowPositions(tasks, ['a', 'b'], 'exec');
    assert.equal(l.tasks.get('2')!.y - l.tasks.get('1')!.y, 70);
    assert.ok(l.tasks.get('3')!.y - l.tasks.get('2')!.y >= 58);
    assert.ok(l.tasks.get('1')!.x - 140 > 95);
    assert.ok(l.tasks.get('4')!.x - l.tasks.get('3')!.x >= 280);
    const d = flowPositions(tasks, ['a', 'b'], 'deps');
    const same = [...d.tasks.values()].filter((p) => p.x === 140);
    assert.equal(new Set(same.map((p) => p.y)).size, 3);
});
