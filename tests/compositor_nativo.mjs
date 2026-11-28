// Servidor del recorrido nativo del Compositor inteligente.
// FILIGRANAS_COMPOSITOR_RESULTADO=/tmp/x.json VITE_COMPOSITOR_ROOT=/private/tmp/compositor-…/repos node tests/compositor_nativo.mjs
// y después, desde el repositorio:
// tauri dev --no-watch --config '{"identifier":"com.filigranas.ide.compositor","build":{"devUrl":"http://127.0.0.1:14573/__compositor","beforeDevCommand":null}}'
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const output = process.env.FILIGRANAS_COMPOSITOR_RESULTADO;
if (!output) throw new Error('Indica FILIGRANAS_COMPOSITOR_RESULTADO');

const server = await createServer({
  server: { host: '127.0.0.1', port: 14573, strictPort: true },
  optimizeDeps: { include: ['@tauri-apps/api/app'] },
  plugins: [{
    name: 'compositor-nativo',
    configureServer(vite) {
      vite.middlewares.use('/__compositor_resultado', async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        await writeFile(output + '.tmp', JSON.stringify(JSON.parse(body), null, 2) + '\n');
        await rename(output + '.tmp', output);
        response.writeHead(204).end();
      });
      vite.middlewares.use('/__compositor', async (_request, response) => {
        const template = await readFile('index.html', 'utf8');
        const html = await vite.transformIndexHtml('/__compositor', template.replace(
          '<script type="module" src="/src/main.tsx"></script>',
          '<script type="module" src="/tests/compositor_webview.tsx"></script>',
        ));
        response.writeHead(200, { 'content-type': 'text/html' }).end(html);
      });
    },
  }],
});
await server.listen();
server.printUrls();
