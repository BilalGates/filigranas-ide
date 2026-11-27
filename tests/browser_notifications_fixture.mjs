// Real HTTP navigation fixture for WKWebView acceptance (no mocked browser IPC).
import { createServer } from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
const output=process.env.FILIGRANAS_BROWSER_EVIDENCE;
if(!output)throw new Error('Set FILIGRANAS_BROWSER_EVIDENCE');
const events=await readFile(output+'/localhost-events.json','utf8').then(JSON.parse,()=>[]);
createServer(async(req,res)=>{
 if(req.url==='/events' && req.method==='POST'){
  let body='';for await(const part of req)body+=part;
  events.push(JSON.parse(body));
  await writeFile(output+'/localhost-events.json',JSON.stringify(events,null,2));
  return res.writeHead(204).end();
 }
 if(req.url==='/redirect')return res.writeHead(302,{location:'/two'}).end();
 if(req.url==='/slow')return; // deliberately never responds: timeout acceptance.
 res.writeHead(req.url==='/missing'?404:200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html>
 <meta charset="utf-8"><title>Browser · ${req.url}</title><style>body{margin:0;padding:32px;font:18px system-ui;background:#f0f4f8;color:#162535}h1{font-size:32px}a{margin-right:20px}main{min-height:900px}footer{padding:20px;background:#c5d7ea}</style>
 <main><h1>Browser · ${req.url}</h1><p>Servidor HTTP real · localhost:3000</p><a href="/one">Página uno</a><a href="/two">Página dos</a><a target="_blank" href="/popup">Nueva ventana</a><input id="state" value="Estado conservado"><p id="size"></p></main><footer>Fin de la página</footer>
 <script>const nonce=crypto.randomUUID();function report(kind){document.querySelector('#size').textContent=innerWidth+' × '+innerHeight;fetch('/events',{method:'POST',body:JSON.stringify({kind,path:location.pathname,nonce,width:innerWidth,height:innerHeight,history:history.length,at:Date.now()})})}addEventListener('resize',()=>report('resize'));addEventListener('pageshow',()=>report('pageshow'));report('load');
 if(location.pathname==='/spa')setTimeout(()=>{history.pushState({},'', '/spa-restored');report('pushstate')},200);
 if(location.pathname==='/ipc'){
   const ipc=window.__TAURI_INTERNALS__;
   if(!ipc)report('ipc-absent');
   else ipc.invoke('get_workspace').then(()=>report('ipc-allowed'),()=>report('ipc-blocked'));
 }
 </script>`);
}).listen(3000,'127.0.0.1',()=>console.log('HTTP fixture http://localhost:3000'));
