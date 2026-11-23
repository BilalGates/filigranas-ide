import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const output = process.env.FILIGRANAS_PERFIL_RESULTADO;
if (!output) throw new Error('Indica FILIGRANAS_PERFIL_RESULTADO');

const server = await createServer({
  server: { host: '127.0.0.1', port: 14572, strictPort: true },
  optimizeDeps: { include: ['@tauri-apps/api/app'] },
  plugins: [{
    name: 'perfil-trama-nativo',
    enforce: 'pre',
    configureServer(vite) {
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
          await writeFile(output, JSON.stringify(JSON.parse(body), null, 2) + '\n');
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
      vite.middlewares.use('/__trama_nativo', async (_request, response) => {
        const probe = process.env.FILIGRANAS_TRAMA_AGENTS === '1' ? 'trama_agentes_webview'
          : process.env.FILIGRANAS_TRAMA_SCENES === '1' ? 'trama_escenas_webview' : 'trama_perfil_webview';
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
