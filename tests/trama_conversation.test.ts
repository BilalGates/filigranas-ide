import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readArchitecture, readDiffPreview } from '../src/trama/conversationContent.ts';

test('la tarjeta conserva las etiquetas de Mermaid y la anotación entre nodos', () => {
  const diagram = readArchitecture([
    'flowchart LR',
    'accTitle: GitPanel → IPC → Rust',
    'a["GitPanel.tsx<br/>interfaz"] --> b["ipc.ts<br/>contrato"]',
    'b -->|push · autorización| c["git_ops.rs<br/>Rust"]',
  ].join('\n'));
  assert.deepEqual(diagram, {
    title: 'GitPanel → IPC → Rust',
    nodes: [{ id: 'a', label: 'GitPanel.tsx', detail: 'interfaz' }, { id: 'b', label: 'ipc.ts', detail: 'contrato' }, { id: 'c', label: 'git_ops.rs', detail: 'Rust' }],
    edges: ['', 'push · autorización'],
  });
});

test('los diagramas con ramas, ciclos o instrucciones quedan como código', () => {
  assert.equal(readArchitecture('flowchart LR\na --> b\na --> c'), null);
  assert.equal(readArchitecture('graph LR\na --> b\nb --> a'), null);
  assert.equal(readArchitecture('graph LR\na --> b\nclick a "https://example.invalid"'), null);
});

test('la tarjeta cuenta el diff completo y enseña el primer bloque sin las cabeceras', () => {
  const preview = readDiffPreview([
    'diff --git a/file b/file', '--- a/file', '+++ b/file',
    '@@ -1,2 +1,3 @@', '-primero', '+nuevo', '+adicional', ' común',
    '@@ -30 +31 @@', '-anterior', '+final',
  ].join('\n'));
  assert.deepEqual(preview, {
    adds: 3, dels: 2,
    lines: [{ kind: 'del', text: 'primero' }, { kind: 'add', text: 'nuevo' }, { kind: 'add', text: 'adicional' }],
  });
  assert.equal(readDiffPreview('+++ b/file\n'), null);
});
