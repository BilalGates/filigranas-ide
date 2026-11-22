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
