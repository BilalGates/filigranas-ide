import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptResult, assistMessages, canSuggest, ghostKey, isCurrent } from '../src/composerAssist.ts';

const key = (k: string, extra: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }> = {}) =>
  ({ key: k, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...extra });

test('Tab acepta y Escape descarta solo con sugerencia y compositor vacío', () => {
  assert.equal(ghostKey(key('Tab'), 'Delega la corrección', ''), 'accept');
  assert.equal(ghostKey(key('Escape'), 'Delega la corrección', ''), 'dismiss');
  // Sin sugerencia, Tab y Escape siguen su comportamiento normal.
  assert.equal(ghostKey(key('Tab'), null, ''), null);
  assert.equal(ghostKey(key('Escape'), null, ''), null);
  // Con texto escrito la sugerencia ya no existe: no se sobrescribe nada.
  assert.equal(ghostKey(key('Tab'), 'x', 'mi borrador'), null);
  // ⇧Tab, combinaciones y la composición de un IME no se interceptan.
  assert.equal(ghostKey(key('Tab', { shiftKey: true }), 'x', ''), null);
  assert.equal(ghostKey(key('Tab', { metaKey: true }), 'x', ''), null);
  assert.equal(ghostKey(key('Tab', { isComposing: true }), 'x', ''), null);
  // Enter mantiene su comportamiento: nunca envía la sugerencia.
  assert.equal(ghostKey(key('Enter'), 'x', ''), null);
  // Cualquier otra tecla escribe y sustituye la sugerencia.
  assert.equal(ghostKey(key('a'), 'x', ''), null);
});

test('solo se pide sugerencia con el compositor vacío y en reposo', () => {
  const idle = { value: '', attachments: 0, queued: 0, running: false, disabled: false, busy: false };
  assert.equal(canSuggest(idle), true);
  assert.equal(canSuggest({ ...idle, value: 'borrador existente' }), false);
  assert.equal(canSuggest({ ...idle, value: '   ' }), true);
  assert.equal(canSuggest({ ...idle, attachments: 1 }), false);
  assert.equal(canSuggest({ ...idle, queued: 1 }), false);
  assert.equal(canSuggest({ ...idle, running: true }), false);
  assert.equal(canSuggest({ ...idle, disabled: true }), false);
  assert.equal(canSuggest({ ...idle, busy: true }), false);
});

test('descarta resultados obsoletos al cambiar de conversación o proyecto', () => {
  assert.equal(isCurrent({ scope: 'pm:/a', seq: 3 }, { scope: 'pm:/a', seq: 3 }), true);
  assert.equal(isCurrent({ scope: 'pm:/a', seq: 3 }, { scope: 'pm:/b', seq: 3 }), false);
  assert.equal(isCurrent({ scope: 'session:4', seq: 3 }, { scope: 'session:4', seq: 4 }), false);
});

test('un resultado tardío no pisa lo escrito ni reaparece tras descartarlo', () => {
  const none = new Set<string>();
  assert.equal(acceptResult('Sigue', { value: '', dismissed: none, running: false }), 'Sigue');
  assert.equal(acceptResult('Sigue', { value: 'ya escribí', dismissed: none, running: false }), null);
  assert.equal(acceptResult('Sigue', { value: '', dismissed: new Set(['Sigue']), running: false }), null);
  assert.equal(acceptResult('Sigue', { value: '', dismissed: none, running: true }), null);
  assert.equal(acceptResult(null, { value: '', dismissed: none, running: false }), null);
});

test('el contexto toma los últimos mensajes de texto y omite herramientas', () => {
  const items = [
    { type: 'userMessage', content: [{ type: 'text', text: 'primero' }] },
    { type: 'commandExecution', text: 'ls -la' },
    ...Array.from({ length: 8 }, (_, i) => ({ type: i % 2 ? 'agentMessage' : 'userMessage', text: `m${i}` })),
    { type: 'agentMessage', text: 'x'.repeat(5000) },
  ];
  const messages = assistMessages(items);
  assert.equal(messages.length, 6);
  assert.ok(messages.every((m) => m.role === 'user' || m.role === 'assistant'));
  assert.ok(!messages.some((m) => m.text.includes('ls -la')));
  assert.equal(messages.at(-1)?.text.length, 1200);
  assert.deepEqual(assistMessages([]), []);
});
