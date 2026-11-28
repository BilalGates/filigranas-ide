import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBody, followLink } from '../src/trama/markdown.ts';
import { createCodeComponents } from '../src/trama/codeBlock.ts';

const render = (source: string) => renderToStaticMarkup(React.createElement(MarkdownBody, { source }));

test('listas, anidación y formato en línea', () => {
  const html = render('- **`main`:**\n  - hijo\n\n1. primero\n2. segundo');
  assert.match(html, /<ul>/);
  assert.match(html, /<strong><code>main<\/code>:<\/strong>/);
  assert.match(html, /<ul>.*<ul>/s);
  assert.match(html, /<ol>/);
});

test('tablas, enlaces, entidades y saltos conservan texto', () => {
  const html = render('| Nombre | Valor |\n| --- | --- |\n| [á😀](https://example.com) | &amp; &lt; &gt; |\n\nlínea\nsiguiente');
  assert.match(html, /<table>/);
  assert.match(html, /href="https:\/\/example.com\/"/);
  assert.match(html, /á😀/);
  assert.match(html, /&amp; &lt; &gt;/);
  assert.match(html, /línea\nsiguiente/);
});

test('HTML y enlaces peligrosos no se ejecutan', () => {
  const html = render('<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('títulos, citas y bloques de código conservan su contenido', () => {
  const html = render('# Título\n\n> cita\n\n```ts\nconst a = "<b>";\n```');
  assert.match(html, /<h1>Título<\/h1>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /&lt;b&gt;/);
});
test('el HTML y los tipos genéricos se conservan como texto literal', () => {
  const html = render('Promise<string> y <Prose>\n\n<details>contenido</details>');
  assert.match(html, /Promise&lt;string&gt;/);
  assert.match(html, /&lt;Prose&gt;/);
  assert.match(html, /&lt;details&gt;contenido&lt;\/details&gt;/);
});

test('imágenes remotas no se cargan y los enlaces locales no navegan', () => {
  const html = render('![alternativa](https://example.com/image.png) [archivo](src/x.tsx:42)');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /alternativa/);
  assert.doesNotMatch(html, /href="src\/x.tsx:42"/);
});


test('los enlaces bloquean la navegación y solo abren HTTP o HTTPS', () => {
  let prevented = 0;
  const opened: string[] = [];
  const click = { preventDefault: () => { prevented++; } };
  followLink(click, 'https://example.com/a', (url) => opened.push(url));
  followLink(click, 'http://example.com', (url) => opened.push(url));
  followLink(click, 'src/x.tsx:42', (url) => opened.push(url));
  followLink(click, 'javascript:alert(1)', (url) => opened.push(url));
  assert.equal(prevented, 4);
  assert.deepEqual(opened, ['https://example.com/a', 'http://example.com/']);
});

test('bloques usan la tarjeta Mermaid o el botón de copiar con su contenido', () => {
  const components = createCodeComponents(
    ({ data }) => React.createElement('div', { 'data-architecture': data.nodes.length }, 'arquitectura'),
    ({ text, label }) => React.createElement('button', { 'aria-label': label }, text),
  );
  const pre = components.pre;
  assert.equal(components.pre, pre);
  const renderCode = (source: string) => renderToStaticMarkup(React.createElement(MarkdownBody, { source, components }));
  const mermaid = renderCode('```mermaid\nflowchart LR\nA --> B\n```');
  assert.match(mermaid, /data-architecture="2"/);
  assert.doesNotMatch(mermaid, /Copiar bloque/);
  const code = renderCode('```ts\nconst x = 1;\n```');
  assert.match(code, /aria-label="Copiar bloque"/);
  assert.match(code, /<pre class="co-code"><code>const x = 1;<\/code><\/pre>/);
});
