import { browser, api } from '../src/ipc';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,label)=>{if(!ok)throw Error(label);};
async function until(check,label,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){const result=await check();if(result)return result;await sleep(70);}throw Error('Timeout: '+label);}
const button=label=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent.trim()===label);
async function openAddress(url){const input=document.querySelector('[aria-label="Dirección web"]');assert(input,'address bar');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,url);input.dispatchEvent(new Event('input',{bubbles:true}));await sleep(50);input.closest('form').requestSubmit();}
async function loaded(project,url){return until(async()=>{const s=await browser.status(project);return s.loaded&&!s.loading&&s.url===url?s:false;},url);}
async function selectProject(project){const b=[...document.querySelectorAll('button')].find(b=>b.title===project.path&&b.textContent.trim()===project.name);assert(b,'project '+project.name);b.click();await sleep(200);const nav=document.querySelector('[aria-label^="Browser ("]');if(!document.querySelector('.browser-panel')||document.querySelector('.browser-panel').hidden)nav.click();await sleep(300);}
async function geometry(project){await sleep(350);const s=await browser.status(project);const r=document.querySelector('.browser-surface').getBoundingClientRect();assert(r.height>=64,'surface height');assert(Math.abs(s.width-r.width)<=1.5&&Math.abs(s.height-r.height)<=1.5,'native vs DOM bounds');return {status:s,rect:r.toJSON()};}
export async function runBrowser(){
 const report={navigation:[],geometry:[]};
 button('Cerrar lista')?.click();await sleep(100);
 const projects=(await api.workspace()).projects;
 const uno=projects.find(p=>p.name==='uno'),dos=projects.find(p=>p.name==='dos');
 assert(uno&&dos,'isolated fixtures');
 await selectProject(uno);
 await openAddress('http://localhost:3000/one');report.navigation.push(await loaded(uno.path,'http://localhost:3000/one'));
 await openAddress('http://localhost:3000/two');report.navigation.push(await loaded(uno.path,'http://localhost:3000/two'));
 button('Atrás').click();report.navigation.push(await loaded(uno.path,'http://localhost:3000/one'));
 await sleep(550);button('Adelante').click();report.navigation.push(await loaded(uno.path,'http://localhost:3000/two'));
 await sleep(550);button('Recargar').click();await sleep(700);report.navigation.push(await loaded(uno.path,'http://localhost:3000/two'));
 // Actual splitter keyboard events, then Workspace compact/restore.
 const splitter=document.querySelector('[aria-label="Divisor entre Workspace y herramienta"]');assert(splitter,'splitter');
 for(const key of ['ArrowLeft','ArrowLeft','ArrowRight','End','Home','Enter']){splitter.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));report.geometry.push(await geometry(uno.path));}
 button('Ocultar chat').click();report.geometry.push(await geometry(uno.path));
 report.compactControls=[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length).map(b=>({aria:b.getAttribute('aria-label'),title:b.title}));
 await selectProject(dos);await openAddress('http://localhost:3000/other');report.navigation.push(await loaded(dos.path,'http://localhost:3000/other'));
 await selectProject(uno);const restored=await loaded(uno.path,'http://localhost:3000/two');assert(restored.canGoBack,'preserved history');report.restored=restored;
 document.querySelector('[aria-label^="Browser ("]').click();await sleep(200);document.querySelector('[aria-label^="Browser ("]').click();await sleep(700);report.reopened=await loaded(uno.path,'http://localhost:3000/two');
 button('Guardar marcador').click();await sleep(500);button('Marcadores').click();await sleep(200);assert([...document.querySelectorAll('.browser-entry')].some(b=>b.title==='http://localhost:3000/two'),'bookmark UI');button('Cerrar lista').click();await sleep(150);
 button('Historial').click();await sleep(200);assert([...document.querySelectorAll('.browser-entry')].some(b=>b.title==='http://localhost:3000/one'),'history UI');button('Cerrar lista').click();await sleep(150);
 await openAddress('http://127.0.0.1:39999/');report.failure=await until(async()=>{const s=await browser.status(uno.path);return s.error?s:false;},'visible navigation failure');await sleep(600);assert(document.querySelector('.browser-problem')?.textContent.includes('WKWebView'),'visible error');
 report.failureVisible=document.querySelector('.browser-problem').textContent;
 return report;
}

export async function runNotifications() {
 const {notificationCenter,pushOperationalError,pushNotification}=await import('../src/trama/notifications');
 notificationCenter.clear();
 pushOperationalError('No se pudo actualizar Codex\nHTTP 503: primer intento',{source:'Actualización de CLI'});
 pushOperationalError('No se pudo actualizar Codex\nEACCES: segundo intento',{source:'Actualización de CLI'});
 pushNotification({level:'warning',title:'Cuota baja',summary:'Queda un 5 % de contexto',details:'Diagnóstico de prueba: cuota del proveedor'});
 pushNotification({level:'info',title:'Herramientas comprobadas',summary:'Todas las herramientas están disponibles'});
 pushNotification({level:'success',title:'Agente finalizado',summary:'Revisión del proyecto terminada',details:'Resultado de prueba del panel'});
 await sleep(150);
 if(!document.querySelector('.attn-menu'))document.querySelector('.tb-attention').click();
 await sleep(300);
 const menu=document.querySelector('.attn-menu');const rect=menu.getBoundingClientRect();
 assert(rect.right<=innerWidth&&rect.bottom<=innerHeight&&rect.top>=0,'popover bounds');
 assert(!menu.textContent.includes('Ver todos los proyectos'),'irrelevant link');
 assert(menu.querySelectorAll('.attn-entry').length===4,'grouped list');
 const before={entries:notificationCenter.getSnapshot().entries.length,unread:notificationCenter.getSnapshot().unreadCount,rect:rect.toJSON(),collapsed:[...menu.querySelectorAll('details')].every(d=>!d.open),technicalVisible:[...menu.querySelectorAll('pre')].some(e=>e.getClientRects().length)};
 assert(before.collapsed&&!before.technicalVisible,'details hidden initially');
 const error=menu.querySelector('.attn-entry.is-error');error.querySelector('summary').click();await sleep(120);
 const expanded={unread:notificationCenter.getSnapshot().unreadCount,details:error.querySelector('pre').textContent,actions:[...error.querySelectorAll('button')].map(b=>b.textContent)};
 assert(expanded.details.includes('HTTP 503')&&expanded.details.includes('EACCES'),'complete diagnostic');
 assert(expanded.unread===3,'read on expansion');
 return {before,expanded};
}

export async function runNotificationActions() {
 const {notificationCenter}=await import('../src/trama/notifications');
 button('Marcar leídas').click();await sleep(100);assert(notificationCenter.getSnapshot().unreadCount===0,'mark all read');
 button('Limpiar historial').click();await sleep(100);assert(notificationCenter.getSnapshot().entries.length===0,'clear history');
 button('Cerrar notificaciones').click();await sleep(100);assert(!document.querySelector('.attn-menu'),'close bell');
 document.querySelector('.tb-attention').click();await sleep(100);assert(document.querySelector('.attn-menu'),'reopen bell');
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await sleep(100);assert(!document.querySelector('.attn-menu'),'Escape');
 document.querySelector('.tb-attention').click();await sleep(100);document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));await sleep(100);assert(!document.querySelector('.attn-menu'),'outside click');
 return {markRead:true,clear:true,close:true,reopen:true,escape:true,outsideClick:true};
}

export async function runPending() {
 const {createElement}=await import('react');const {createRoot}=await import('react-dom/client');
 const {default:Attention}=await import('../src/trama/Attention');
 const {notificationCenter}=await import('../src/trama/notifications');
 // Explicit component fixture: no external agent, real permission, or grant.
 const project=(await api.workspace()).projects[0].path;
 const main=document.querySelector('.attn-wrap');document.querySelector('.tb-attention').click();await sleep(100);main.style.visibility='hidden';
 const host=document.createElement('div');host.style.cssText='position:fixed;top:10px;right:10px;z-index:1000';document.body.append(host);
 const root=createRoot(host);const navigation=[];
 root.render(createElement(Attention,{project,projectName:'Permiso de prueba',projects:[],sessions:[{id:4242,project,name:'Agente de prueba'}],activity:{'4242':'permiso'},onSession:(...args)=>navigation.push(args),onTask:()=>{},onEntrega:()=>{},onHome:()=>{},onTools:()=>{},onSettings:()=>{}}));
 await sleep(250);host.querySelector('.tb-attention').click();await sleep(150);
 assert(host.querySelector('.attn-pending .is-perm'),'permission pinned');
 for(let i=0;i<70;i++)notificationCenter.push({level:'info',title:'Evento '+i,ephemeral:false});await sleep(150);
 notificationCenter.markAllRead();notificationCenter.clear();await sleep(150);
 assert(host.querySelector('.attn-pending .is-perm'),'permission survives clear');
 host.querySelector('.is-perm').click();await sleep(100);
 assert(navigation[0]?.[0]===4242&&navigation[0]?.[1]===project,'owning session and project');
 root.unmount();host.remove();main.style.visibility='';main.querySelector('.tb-attention').click();
 return {fixture:true,pinned:true,survivesHistoryClear:true,navigation};
}

export async function resizeWindow(width,height) {
 const {getCurrentWindow,LogicalSize}=await import('@tauri-apps/api/window');
 await getCurrentWindow().setSize(new LogicalSize(width,height));
 await sleep(450);
 const p=(await api.workspace()).projects.find(p=>p.name==='uno');
 return {window:{width:innerWidth,height:innerHeight},...(await geometry(p.path))};
}

export async function prepareComparison() {
 document.querySelector('.onboarding form')?.requestSubmit();await sleep(600);
 if(!document.querySelector('.browser-panel')||document.querySelector('.browser-panel').hidden)document.querySelector('[aria-label^="Browser ("]').click();
 await sleep(250);await openAddress('https://www.google.com/');
 const status=await until(async()=>{const s=await browser.status(null);return s.loaded&&!s.loading?s:false;},'Google',15000);
 const {notificationCenter,pushOperationalError,pushNotification}=await import('../src/trama/notifications');
 notificationCenter.clear();
 pushOperationalError('No se pudo actualizar Codex\nHTTP 503: prueba de diagnóstico, sin proveedores externos',{source:'Actualización de CLI'});
 pushNotification({level:'info',title:'Agente finalizado',summary:'Revisión del proyecto terminada',details:'Resultado de prueba del panel'});
 notificationCenter.dismissEphemeral();await sleep(100);
 return {status,header:document.querySelector('.tb-left')?.textContent,surface:document.querySelector('.browser-surface').getBoundingClientRect().toJSON()};
}
