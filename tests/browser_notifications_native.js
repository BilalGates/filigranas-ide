import { tools } from '../src/ipc';
import { getIdentifier } from '@tauri-apps/api/app';
if(await getIdentifier() !== 'com.filigranas.ide.browser-acceptance') throw new Error('Use the isolated browser acceptance profile');
const headers={'x-acceptance-token':globalThis.__browserAcceptanceToken};
// Opt-in driver runs only in the isolated native acceptance page.
await tools.autoUpdate(false);
const report = { errors: [] };
window.addEventListener('error', e => report.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => report.errors.push(String(e.reason)));
window.__browserAcceptance = report;
const post = data => fetch('/__acceptance', {method:'POST',headers,body:JSON.stringify(data)});
await post({ready:true});
setInterval(async () => {
 const command = await fetch('/__acceptance',{headers}).then(r=>r.json());
 if(!command) return;
 try {
  const value=await new Function(`return (async()=>{${command}})()`)();
  await post({value,errors:report.errors});
 } catch(e) { await post({error:String(e),stack:e.stack,errors:report.errors}); }
},400);
