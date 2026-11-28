import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyToClipboard } from '../src/trama/clipboard.ts';

test('el fallback rechaza la copia fallida y retira el campo temporal', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let removed = false;
  const element = { value: '', style: {}, select() {}, remove() { removed = true; } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => element, body: { appendChild() {} }, execCommand: () => false,
  } });
  try {
    await assert.rejects(copyToClipboard('contenido'), /No se pudo copiar/);
    assert.equal(element.value, 'contenido');
    assert.equal(removed, true);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
