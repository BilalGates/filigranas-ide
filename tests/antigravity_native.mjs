// Native acceptance harness: compiled production frontend, real Tauri IPC,
// authenticated CLIs. Keep evidence separate from installed application data.
import { build } from 'vite';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const output=process.env.FILIGRANAS_AGY_EVIDENCE;
if(!output)throw Error('FILIGRANAS_AGY_EVIDENCE is required');
const dir='/private/tmp/filigranas-antigravity-native-frontend';
await build({build:{outDir:dir,emptyOutDir:true,manifest:true,rollupOptions:{input:{main:'index.html',native:'tests/antigravity_native_webview.js'}}}});
const manifest=JSON.parse(await readFile(resolve(dir,'.vite/manifest.json'),'utf8'));
const entry=manifest['tests/antigravity_native_webview.js'].file;
const types={'.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml'};
createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:14578');
  if(url.pathname==='/__antigravity_report'){
   if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'}).end(await readFile(output));return;}
   if(req.method!=='POST'){res.writeHead(405).end();return;}
   let body='';for await(const chunk of req){body+=chunk;if(body.length>2_000_000){res.writeHead(413).end();return;}}
   await writeFile(output,JSON.stringify(JSON.parse(body),null,2));res.writeHead(204).end();return;
  }
  if(url.pathname==='/'){
   const html=(await readFile(resolve(dir,'index.html'),'utf8')).replace('</body>',`<script type="module" src="/${entry}"></script></body>`);
   res.writeHead(200,{'content-type':'text/html'}).end(html);return;
  }
  const path=resolve(dir,'.'+decodeURIComponent(url.pathname));
  if(!path.startsWith(dir+'/')){res.writeHead(403).end();return;}
  res.writeHead(200,{'content-type':types[extname(path)]??'application/octet-stream'}).end(await readFile(path));
 }catch{res.writeHead(404).end();}
}).listen(14578,'127.0.0.1',()=>console.log('Compiled native acceptance server http://127.0.0.1:14578'));
