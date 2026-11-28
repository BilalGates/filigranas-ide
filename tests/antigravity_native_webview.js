import { getIdentifier } from '@tauri-apps/api/app';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { api, sessions, tasks, tools, providers, coordinator, larry } from '../src/ipc';
const root='/private/tmp/filigranas-agy-acceptance/repos';
const project=root+'/fixture';
const report={date:new Date().toISOString(),native:true,mocks:false,steps:[],events:[],metrics:[]};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const save=()=>fetch('/__antigravity_report',{method:'POST',body:JSON.stringify(report)});
const configs=new Map();
const allowed=new Map();
const captureError=e=>String(e).slice(0,1500);
async function waitRun(task,seconds=120){
 const end=Date.now()+seconds*1000;
 while(Date.now()<end){const runs=await tasks.runs(project,task);if(runs[0]?.durationMs!=null)return runs[0];await pause(400);}
 throw Error('Execution did not finish within bounded acceptance timeout');
}
async function run(){
 if(await getIdentifier()!=='com.filigranas.ide.antigravity-acceptance')return;
 const priorRun=await fetch('/__antigravity_report').then(r=>r.json()).catch(()=>null);
 if(priorRun?.finishedAt)return;
 if(sessionStorage.getItem('antigravity.acceptance.started.v2'))return;
 sessionStorage.setItem('antigravity.acceptance.started.v2','yes');
 const off=await listen('session',({payload:{id,msg}})=>{
  if(msg.type==='ready')configs.set(id,msg.options??[]);
  if(msg.type==='permission'){ const agent=allowed.get(id); const input=msg.toolCall?.rawInput??{}; const accept=agent && input.Path===`${agent.session.worktree}/${agent.file}` && input.Content?.trim()===agent.marker; void sessions.respond(msg.requestId,accept?'accept':'decline'); }
  if(msg.type==='control_request'){
   const input=msg.request?.input??{}; const path=input.file_path;
   const agent=allowed.get(id);
   const accept=agent && path===`${agent.session.worktree}/${agent.file}` && input.content?.trim()===agent.marker;
   void sessions.respond(msg.request_id,accept?'accept':'decline');
  }
  if(['ready','error','paused','turn_end','exit','permission','policy_denied'].includes(msg.type))report.events.push({id,type:msg.type,message:msg.message??msg.reason??null,stopReason:msg.stopReason??null});
 });
 try{
  await api.setRoot(root);
  report.tools=await tools.status();report.health=await providers.health();
  const agents=[];
  for(const engine of ['agy','claude','codex']){
   const task=await tasks.save(project,{id:null,parentId:null,title:`Native ${engine}`,goal:'Create the designated synthetic marker file, with no Git operations.',criteria:'Exact marker in an isolated checkout',priority:'normal',risk:'low',status:'ready',verification:'',tests:null,dependencies:[]});
   const session=await sessions.create(project,engine,task);
   const agent={engine,task,session,file:`result-${engine}.txt`,marker:`NATIVE-${engine.toUpperCase()}`};
   if(!session.worktree||session.worktree===project)throw Error('Task was not isolated');
   agents.push(agent);allowed.set(session.id,agent);
   if(engine==='agy'){
    report.stage=`preparing ${session.id}`;await save();
    await sessions.history(session.id);
    const options=configs.get(session.id)??[];
    const model=options.find(o=>o.category==='model');
    const flash=model?.options.find(o=>/flash/i.test(o.name));
    if(flash){const updated=await sessions.setOption(session.id,model.id,flash.value);report.selectedModel=flash;
     const thought=updated.find(o=>o.category==='thought_level');if(thought?.options.some(o=>o.value==='low'))await sessions.setOption(session.id,thought.id,'low');}
   }
  }
  report.agents=agents;
  report.metrics.push({phase:'before',sample:await invoke('system_metrics')});
  const starts=await Promise.allSettled(agents.map(agent=>sessions.send(agent.session.id,`Prueba nativa autorizada en tu worktree. Crea exclusivamente ${agent.file} con exactamente ${agent.marker}, seguido de un salto de línea. Usa la herramienta de escritura de archivos; no uses terminal, Git, subagentes ni red. Responde HECHO.`,null,agent.task,[],agent.engine)));
  report.starts=starts.map(v=>v.status==='fulfilled'?{status:v.status}:{status:v.status,reason:captureError(v.reason)});
  await save();
  let collecting=true;
  const sample=async()=>{while(collecting){report.metrics.push({phase:'concurrent',sample:await invoke('system_metrics')});await pause(2000);}};
  const sampling=sample();
  report.runs=await Promise.all(agents.map(async agent=>{try{return {engine:agent.engine,run:await waitRun(agent.task)};}catch(e){return {engine:agent.engine,error:captureError(e)};}}));
  collecting=false;await sampling;
  report.files=await Promise.all(agents.map(async a=>{try{const diff=await sessions.diffTexts(a.session.id,a.file,null);return {engine:a.engine,exact:diff.new.trim()===a.marker};}catch(e){return {engine:a.engine,exact:false,error:captureError(e)};}}));
  report.steps.push({name:'three real native isolated turns',passed:report.runs.every(v=>v.run?.outcome==='completed')&&report.files.every(v=>v.exact)});
  const agy=agents[0];
  await emit('sessions-changed',{project,focus:agy.session.id});
  await pause(800);
  report.dom={providerButtons:[...document.querySelectorAll('.eng-usage .eng-btn')].map(b=>({aria:b.getAttribute('aria-label'),text:b.textContent,logos:b.querySelectorAll('svg').length})),cpu:!!document.querySelector('.sysmon')};
  report.healthAfter=await providers.health();
  report.finishedAt=new Date().toISOString();
 }catch(e){report.error=captureError(e);}finally{off();await save();window.__antigravityAcceptance=report;}
}
await pause(1800);await run();

// UI/read-only recovery inspection on an already-run profile does not retry
// quota-blocked executions. Persist actual DOM observations separately.
if(await getIdentifier()==='com.filigranas.ide.antigravity-acceptance'){
 const form=document.querySelector('.onboarding-card');
 const rootInput=document.querySelector('input#root');
 if(form && rootInput?.value===root)form.requestSubmit();
 const until=Date.now()+30000;
 while(!document.querySelector('.eng-btn')&&Date.now()<until)await pause(250);
 const prior=await fetch('/__antigravity_report').then(r=>r.json()).catch(()=>report);
 prior.ui={native:true,bodyExcerpt:document.body.innerText.slice(0,1200),providerButtons:[...document.querySelectorAll('.eng-usage .eng-btn')].map(b=>({aria:b.getAttribute('aria-label'),text:b.textContent,logos:b.querySelectorAll('svg').length})),ready:!!document.querySelector('.eng-btn')};
 await fetch('/__antigravity_report',{method:'POST',body:JSON.stringify(prior)});
}

if(await getIdentifier()==='com.filigranas.ide.antigravity-acceptance') {
 const prior=await fetch('/__antigravity_report').then(r=>r.json());
 if(prior.finishedAt && !prior.followupStartedAt) {
  prior.followupStartedAt=new Date().toISOString();
  const store=()=>fetch('/__antigravity_report',{method:'POST',body:JSON.stringify(prior)});
  await store();
  try {
   const agy=prior.agents.find(a=>a.engine==='agy');
   await sessions.history(agy.session.id);
   prior.recovery={native:true,result:await sessions.result(agy.session.id),sessionId:agy.session.id};
   const input={id:null,parentId:null,title:'Jev native available-provider routing',goal:'Delegate one read-only synthetic task with auto routing and recover its result.',criteria:'The PM delegates and returns the real child result.',priority:'normal',risk:'low',status:'ready',verification:'',tests:null,dependencies:[]};
   const task=await tasks.save(project,input);
   prior.routingTask=task;
   const pm=await coordinator.open(project);
   prior.pmThread=pm.threadId;
   await coordinator.send(project,'Prueba nativa autorizada, SOLO COORDINACIÓN. Usa delegar exactamente una vez con agente auto, rol researcher, titulo Jev native read-only, tarea: Lee spec.txt de tu propia copia y responde NATIVE-ROUTE-OK; no escribas, no uses terminal ni Git ni subdelegues. Recupera el resultado mediante esperar_sesion y concluye con ese marcador si lo recibes. No repitas la delegación si falla. No uses herramientas técnicas directas.', 'low',null,task,[]);
   const end=Date.now()+120000;
   let runs=[];
   while(Date.now()<end){runs=await tasks.runs(project,task);if(runs.length&&runs.every(r=>r.durationMs!=null))break;await pause(500);}
   prior.routingRuns=runs;
   prior.routingPassed=runs.length>=2&&runs.every(r=>r.outcome==='completed')&&runs.some(r=>r.routing?.selectedProvider==='codex');
   const codex=prior.agents.find(a=>a.engine==='codex');
   if(prior.files.find(f=>f.engine==='codex')?.exact) {
    const plan=await larry.proposeSelected(project,codex.session.id,[codex.file],'Confirma únicamente el marcador de la prueba nativa. Conserva los hooks, no añadas coautoría, no publiques.');
    if(plan.commits.some(c=>c.files.some(f=>f!==codex.file)))throw Error('Larry proposed a file outside the authorized fixture marker');
    prior.larryPlan=plan;
    prior.larry=await larry.commit(project,codex.session.id,plan.commits);
   }
   await emit('sessions-changed',{project,focus:agy.session.id});
   await pause(1000);
   const trigger=document.querySelector('.eng-btn[aria-label="Uso de Antigravity"]');
   trigger?.click();await pause(250);
   prior.usagePopup={present:!!document.querySelector('[aria-label="Uso de Antigravity"][role="dialog"]'),text:document.querySelector('[aria-label="Uso de Antigravity"][role="dialog"]')?.textContent};
   prior.followupFinishedAt=new Date().toISOString();
  } catch(e){prior.followupError=captureError(e);}
  await store();
 }
}

if(await getIdentifier()==='com.filigranas.ide.antigravity-acceptance'){
 const prior=await fetch('/__antigravity_report').then(r=>r.json());
 const buttons=[...document.querySelectorAll('.eng-usage .eng-btn')];
 prior.visualChecks={native:true,buttons:buttons.map(b=>({label:b.getAttribute('aria-label'),text:b.textContent.trim(),color:getComputedStyle(b.querySelector('svg')).color,rect:{x:b.getBoundingClientRect().x,y:b.getBoundingClientRect().y,width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height},coloredDots:b.querySelectorAll('.dot,.eng-mark').length})),providerOrder:buttons.map(b=>b.getAttribute('aria-label')),visibleNames:buttons.some(b=>/Claude|Codex|Antigravity/.test(b.textContent))};
 const agy=prior.agents?.find(a=>a.engine==='agy');
 if(agy){await emit('sessions-changed',{project,focus:agy.session.id});await pause(800);}
 document.querySelector('.eng-btn[aria-label="Uso de Antigravity"]')?.click();await pause(200);
 prior.visualChecks.quotaPopup=document.querySelector('[role="dialog"][aria-label="Uso de Antigravity"]')?.textContent??null;
 prior.visualChecks.composer=document.querySelector('[aria-label^="Configuración del modelo"]')?.getAttribute('aria-label')??null;
 await fetch('/__antigravity_report',{method:'POST',body:JSON.stringify(prior)});
}

// Optional read-only presentation controls for reproducible native captures.
// Set visualRequest in the evidence JSON to quota/settings/composer. No turn
// is started and all interactions go through the actual product buttons.
if(await getIdentifier()==='com.filigranas.ide.antigravity-acceptance'){
 let seen='';
 setInterval(async()=>{
  const evidence=await fetch('/__antigravity_report').then(r=>r.json());
  const request=evidence.visualRequest;
  if(!request||request===seen)return;seen=request;
  if(request==='quota'){
   if(!document.querySelector('[role="dialog"][aria-label="Uso de Antigravity"]'))document.querySelector('.eng-btn[aria-label="Uso de Antigravity"]')?.click();
  }else if(request==='settings'){
   if(!document.querySelector('.usage-tools'))document.querySelector('.eng-btn[aria-label="Uso de Antigravity"]')?.click();
   await pause(100);document.querySelector('.usage-tools')?.click();await pause(200);
   [...document.querySelectorAll('.snav button')].find(b=>b.textContent.includes('Modelos y herramientas'))?.click();
  }else if(request==='composer'){
   document.querySelector('.eng-btn[aria-label="Uso de Antigravity"]')?.click();await pause(100);
   document.querySelector('[aria-label^="Configuración del modelo"]')?.click();
  }
  await pause(500);
  evidence.visualPresentation={request,date:new Date().toISOString(),settings:document.querySelector('.sbody')?.textContent??null,quota:document.querySelector('[role="dialog"][aria-label="Uso de Antigravity"]')?.textContent??null};
  await fetch('/__antigravity_report',{method:'POST',body:JSON.stringify(evidence)});
 },1000);
}
