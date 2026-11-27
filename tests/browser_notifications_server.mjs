// Native acceptance harness: local, opt-in, never included in the application build.
import { createServer } from 'vite';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const output = process.env.FILIGRANAS_BROWSER_EVIDENCE;
if (!output) throw new Error('Set FILIGRANAS_BROWSER_EVIDENCE to an evidence directory');
await mkdir(output, { recursive: true });
const token = randomBytes(32).toString('hex');
await writeFile('/tmp/filigranas-browser-acceptance-token', token, {mode:0o600});
let command = null;
const server = await createServer({ server: {host:'127.0.0.1',port:14620,strictPort:true}, plugins: [{
 name:'native-browser-acceptance',
 configureServer(vite) {
  vite.middlewares.use('/__acceptance', async (req,res) => {
   if(req.headers['x-acceptance-token'] !== token) return res.writeHead(403).end();
   if (req.method === 'POST') {
    let body=''; for await(const chunk of req) body+=chunk;
    const data=JSON.parse(body);
    if(data.command) command=data.command;
    else await writeFile(`${output}/result.json`,JSON.stringify(data,null,2));
    return res.writeHead(204).end();
   }
   const current=command; command=null;
   res.setHeader('content-type','application/json');res.end(JSON.stringify(current));
  });
  vite.middlewares.use('/__native', async (_req,res) => {
   const source=await readFile('index.html','utf8');
   const html=await vite.transformIndexHtml('/__native', source.replace('</body>',`<script>globalThis.__browserAcceptanceToken=${JSON.stringify(token)}</script><script type="module" src="/tests/browser_notifications_native.js"></script></body>`));
   res.setHeader('content-type','text/html');res.end(html);
  });
 },
}]});
await server.listen();
console.log('Native acceptance server http://127.0.0.1:14620/__native');
