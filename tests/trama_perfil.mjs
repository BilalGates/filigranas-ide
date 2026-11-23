import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const output = process.env.FILIGRANAS_PERFIL_RESULTADO;
if (!output) throw new Error('Indica FILIGRANAS_PERFIL_RESULTADO');

const comparison = process.env.FILIGRANAS_TRAMA_COMPARATIVAS;
const referenceDir = 'design/trama-v2/reference';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function referenceRoutes(vite) {
  const manifest = JSON.parse(await readFile(join(referenceDir, 'manifest.json')));
  const original = await readFile(join(referenceDir, manifest.file), 'utf8');
  if (sha256(original) !== manifest.sha256) throw new Error('HTML de referencia modificado');
  const checked = async (item) => {
    const content = await readFile(join(referenceDir, item.path));
    if (sha256(content) !== item.sha256) throw new Error(`Recurso modificado: ${item.path}`);
    return content;
  };
  let css = (await checked(manifest.fontStylesheet)).toString();
  for (const resource of manifest.resources.filter((item) => item.path.endsWith('.woff2'))) {
    await checked(resource);
    css = css.replaceAll(resource.source, '/' + join(referenceDir, resource.path));
  }
  const literal = (name) => runInNewContext(
    '([' + original.match(new RegExp('(?:const|let) ' + name + '=\\[([\\s\\S]+?)\\];'))[1] + '])',
    Object.create(null), { timeout: 100 },
  );
  const fixtures = JSON.stringify({ projects: literal('PROJ'), memory: literal('MEM') });
  vite.middlewares.use('/__trama_fixtures', (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end(fixtures);
  });
  vite.middlewares.use('/__trama_fuentes', (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/css' }).end(css);
  });
  vite.middlewares.use('/__trama_referencia', (_request, response) => {
    const page = original
      .replace(/<link[^>]*fonts\.google(?:apis|static)\.com[^>]*>/gu, '')
      .replace('</head>', '<link rel="stylesheet" href="/__trama_fuentes"></head>')
      .replace('<script>', '<script>const originalInterval = window.setInterval; window.setInterval = (fn, ...args) => fn.name === "tick" ? 0 : originalInterval(fn, ...args);</script><script>')
      .replace('</body>', '<script type="module" src="/tests/trama_comparativa_referencia.js"></script></body>');
    response.writeHead(200, { 'content-type': 'text/html' }).end(page);
  });
  vite.middlewares.use('/__trama_capturada', async (request, response) => {
    const name = request.url?.slice(1);
    if (!/^(native|artifact)-(inicio|workspace(?:-arquitectura|-observar|-permiso)?|flow(?:-dependencias)?|studio(?:-comparacion)?|entrega(?:-hallazgo|-ci)?|brain(?:-agrupado|-inferencias)?|ajustes)$/.test(name ?? '')) {
      response.writeHead(400).end();
      return;
    }
    const path = join(comparison, name + '.png');
    const exists = await access(path).then(() => true, () => false);
    response.writeHead(exists ? 204 : 404, { 'cache-control': 'no-store' }).end();
  });
}

const server = await createServer({
  server: { host: '127.0.0.1', port: 14572, strictPort: true },
  optimizeDeps: { include: ['@tauri-apps/api/app'] },
  plugins: [{
    name: 'perfil-trama-nativo',
    enforce: 'pre',
    async configureServer(vite) {
      if (comparison) await referenceRoutes(vite);
      vite.middlewares.use('/__perfil_trama', async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405).end();
          return;
        }
        try {
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 200_000) throw new Error('Resultado demasiado grande');
          }
          await writeFile(output + '.tmp', JSON.stringify(JSON.parse(body), null, 2) + '\n');
          await rename(output + '.tmp', output);
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
      if (process.env.FILIGRANAS_TRAMA_FIELD === '1') {
        vite.middlewares.use('/__trama_campo_referencia', async (_request, response) => {
          const original = await readFile('design/trama-v2/reference/index.html', 'utf8');
          const page = original.replace(/<link[^>]*fonts\.google(?:apis|static)\.com[^>]*>/gu, '').replace('</body>', '<script type="module" src="/tests/trama_campo_referencia.js"></script></body>');
          response.writeHead(200, { 'content-type': 'text/html' }).end(page);
        });
      }
      vite.middlewares.use('/__trama_nativo', async (_request, response) => {
        const probe = comparison ? 'trama_comparativa_nativa' : process.env.FILIGRANAS_TRAMA_AGENTS === '1' ? 'trama_agentes_webview'
          : process.env.FILIGRANAS_TRAMA_SCENES === '1' ? 'trama_escenas_webview'
          : process.env.FILIGRANAS_TRAMA_FIELD === '1' ? 'trama_campo_webview' : 'trama_perfil_webview';
        const template = await readFile('index.html', 'utf8');
        const html = await vite.transformIndexHtml('/__trama_nativo', template.replace(
          '<script type="module" src="/src/main.tsx"></script>',
          `<script type="module" src="/tests/${probe}.js"></script>`,
        ));
        response.writeHead(200, { 'content-type': 'text/html' }).end(html);
      });
    },
    transform(code, id) {
      if (id.endsWith('/src/main.tsx')) {
        return code.replace('import { StrictMode }', 'import { Profiler, StrictMode }').replace(
          '<App />',
          '<Profiler id="App" onRender={(_id, _phase, duration) => Reflect.get(window, "__perfilTrama")?.render(duration)}><App /></Profiler>',
        );
      }
      if (id.endsWith('/src/ipc.ts')) {
        return code.replace("import { invoke, type Channel } from '@tauri-apps/api/core';", `import { invoke as nativeInvoke, type Channel } from '@tauri-apps/api/core';
const invoke: typeof nativeInvoke = (command, args, options) => {
  const end = Reflect.get(window, "__perfilTrama")?.ipc(command);
  return nativeInvoke(command, args, options).finally(() => end?.());
};`);
      }
    },
  }],
});
await server.listen();
server.printUrls();
