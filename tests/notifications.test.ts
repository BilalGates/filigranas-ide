import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationCenter, cliUpdatesToNotifications } from '../src/trama/notifications.ts';
import type { CliUpdate } from '../src/ipc.ts';

test('agrupa errores repetidos por huella y conserva detalles técnicos', () => {
  const center = new NotificationCenter();
  const a = center.push({
    level: 'error',
    title: 'Error de red',
    summary: 'No se pudo conectar',
    details: 'ECONNREFUSED 127.0.0.1:443',
    fingerprint: 'net:err',
  }, 1000);
  const b = center.push({
    level: 'error',
    title: 'Error de red',
    summary: 'No se pudo conectar',
    details: 'ECONNREFUSED 127.0.0.1:443 (intento 2)',
    fingerprint: 'net:err',
  }, 2000);

  const snap = center.getSnapshot();
  assert.equal(snap.entries.length, 1);
  assert.equal(a.id, b.id);
  assert.equal(snap.entries[0].count, 2);
  assert.equal(snap.entries[0].updatedAt, 2000);
  assert.match(snap.entries[0].details ?? '', /intento 2/);
  assert.equal(snap.unreadCount, 1);
  assert.equal(snap.errorCount, 1);
  assert.equal(snap.ephemeralId, b.id);
});

test('cliUpdatesToNotifications conserva detalles de diagnóstico de Codex y OpenCode', () => {
  const updates: CliUpdate[] = [
    { id: 'codex', name: 'Codex', outcome: 'failed', from: '0.1.0', to: null, detail: 'npm ERR! EACCES permission denied' },
    { id: 'opencode', name: 'OpenCode', outcome: 'failed', from: '0.2.0', to: null, detail: 'brew upgrade failed: exit 1' },
    { id: 'claude', name: 'Claude Code', outcome: 'updated', from: '1.0.0', to: '1.1.0', detail: '1.1.0' },
  ];
  const generated = cliUpdatesToNotifications(updates);
  assert.equal(generated.length, 2);
  assert.equal(generated[0].level, 'error');
  assert.match(generated[0].title, /Codex, OpenCode/);
  assert.match(generated[0].details ?? '', /EACCES permission denied/);
  assert.match(generated[0].details ?? '', /brew upgrade failed/);
  assert.equal(generated[0].action?.target, 'tools');
  assert.equal(generated[1].level, 'info');
  assert.match(generated[1].details ?? '', /1\.0\.0 → 1\.1\.0/);
});

test('markAllRead, dismissEphemeral y clear actualizan el estado limpiamente', () => {
  const center = new NotificationCenter();
  const n = center.push({ level: 'warning', title: 'Cuota baja', summary: 'Queda 5%' }, 100);
  assert.equal(center.getSnapshot().unreadCount, 1);
  center.dismissEphemeral();
  assert.equal(center.getSnapshot().ephemeralId, null);
  assert.equal(center.getSnapshot().entries.length, 1);

  center.markAllRead();
  assert.equal(center.getSnapshot().unreadCount, 0);

  center.dismiss(n.id);
  assert.equal(center.getSnapshot().entries.length, 0);
});

test('un grupo conserva diagnósticos distintos y vuelve a estar sin leer', () => {
  const center = new NotificationCenter();
  const first = center.push({ level: 'error', title: 'CLI', fingerprint: 'cli', details: 'HTTP 503: primero' }, 1000);
  center.markRead(first.id);
  center.push({ level: 'error', title: 'CLI', fingerprint: 'cli', details: 'EACCES: segundo' }, 2000);
  const entry = center.getSnapshot().entries[0];
  assert.equal(entry.count, 2);
  assert.equal(entry.read, false);
  assert.match(entry.details!, /HTTP 503: primero/);
  assert.match(entry.details!, /EACCES: segundo/);
});

test('finalizaciones de agentes conservan el destino de sesión y proyecto', () => {
  const center = new NotificationCenter();
  center.push({ level: 'success', title: 'Claude ha finalizado', action: { label: 'Abrir conversación', target: 'session', session: 42, project: '/projects/a' } });
  assert.equal(center.getSnapshot().entries[0].level, 'success');
  assert.deepEqual(center.getSnapshot().entries[0].action, { label: 'Abrir conversación', target: 'session', session: 42, project: '/projects/a' });
});

test('repetir el mismo diagnóstico incrementa la cuenta sin duplicar su texto', () => {
  const center = new NotificationCenter();
  for (const details of ['A', 'B', 'A', 'B']) center.push({ level: 'error', title: 'Error', details });
  const entry = center.getSnapshot().entries[0];
  assert.equal(entry.count, 4);
  assert.equal(entry.diagnostics.length, 2);
  assert.deepEqual(entry.diagnostics.map((d) => d.text), ['A', 'B']);
});
