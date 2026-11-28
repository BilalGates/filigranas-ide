// Mide el procesamiento completo de un mensaje activo; no incluye DOM ni pintura.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBody } from '../src/trama/markdown.ts';

const paragraph = '## Sección\n\nTexto **negrita** y `código` con [enlace](https://example.com).\n\n';
let source = paragraph.repeat(500);
const times: number[] = [];
for (let i = 0; i < 20; i++) {
  source += paragraph;
  const start = performance.now();
  renderToStaticMarkup(React.createElement(MarkdownBody, { source }));
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ characters: source.length, updates: times.length, medianMs: times[10], p95Ms: times[18], maxMs: times[19] }));
