import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitAttachments, takeBatch } from '../src/chatAttachments.ts';

test('separa el bloque de adjuntos del backend y conserva nombre y ruta', () => {
  const text = 'mira esto\n\nAdjuntos del mensaje:\n- Imagen "image.png" · ruta local: "C:\\\\tmp\\\\adjunto-1.png"\n- Archivo "notas \\"v2\\".txt" · ruta local: "/tmp/adjunto-2.txt"\n- https://example.invalid/a';
  assert.deepEqual(splitAttachments(text), {
    text: 'mira esto',
    attachments: [
      { kind: 'image', name: 'image.png', path: 'C:\\tmp\\adjunto-1.png' },
      { kind: 'file', name: 'notas "v2".txt', path: '/tmp/adjunto-2.txt' },
      { kind: 'link', name: 'https://example.invalid/a' },
    ],
  });
});

test('reconoce el eco local sin rutas y los mensajes solo con adjuntos', () => {
  assert.deepEqual(splitAttachments('Adjuntos del mensaje:\n- captura.PNG\n- informe.pdf'), {
    text: '',
    attachments: [{ kind: 'image', name: 'captura.PNG' }, { kind: 'file', name: 'informe.pdf' }],
  });
});

test('deja intacto el texto que solo menciona la cabecera', () => {
  const text = 'los Adjuntos del mensaje: van al final';
  assert.deepEqual(splitAttachments(text), { text, attachments: [] });
  const other = 'hola\n\nAdjuntos del mensaje:\nesto no es una lista';
  assert.deepEqual(splitAttachments(other), { text: other, attachments: [] });
});

test('la cola junta mensajes hasta el límite de adjuntos y deja el resto', () => {
  const queue = [
    { id: 1, text: 'uno', attachments: [5, 5] },
    { id: 2, text: '', attachments: [5] },
    { id: 3, text: 'tres', attachments: [5, 5] },
  ];
  const { text, attachments, rest } = takeBatch(queue, (n) => n, 4);
  assert.equal(text, 'uno');
  assert.deepEqual(attachments, [5, 5, 5]);
  assert.deepEqual(rest.map((q) => q.id), [3]);
  // El primero sale siempre, aunque supere el límite por sí solo.
  assert.deepEqual(takeBatch(queue, (n) => n, 8, 1).batch.map((q) => q.id), [1]);
  assert.equal(takeBatch([{ id: 1, text: 'a', attachments: [] }, { id: 2, text: 'b', attachments: [] }], () => 0).text, 'a\n\nb');
});
