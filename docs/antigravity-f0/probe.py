"""Bounded official ACP probe. Never reads credential files. Denies all tool permissions."""
import json, os, queue, signal, subprocess, threading, time
from pathlib import Path
ROOT=Path('/private/tmp/filigranas-agy-fixture')
OUT=Path(__file__).parent
class ACP:
 def __init__(self):
  self.q=queue.Queue(); self.events=[]; self.n=0; self.cancel_on_permission=False; self.sid=None
  self.p=subprocess.Popen(['agy','acp','--sandbox','--disable-telemetry','--log-file',str(ROOT/'acp.log')],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,start_new_session=True,env={k:v for k,v in os.environ.items() if k not in ('GEMINI_API_KEY','GOOGLE_API_KEY')})
  threading.Thread(target=self.read,daemon=True).start()
 def read(self):
  for line in self.p.stdout:
   try: self.q.put(json.loads(line))
   except ValueError: pass
 def send(self,v):
  self.p.stdin.write(json.dumps(dict(jsonrpc='2.0',**v))+'\n'); self.p.stdin.flush()
 def request(self,method,params,timeout=75):
  self.n+=1; rid=self.n; self.send(dict(id=rid,method=method,params=params)); end=time.monotonic()+timeout
  while time.monotonic()<end:
   try: v=self.q.get(timeout=min(1,max(.01,end-time.monotonic())))
   except queue.Empty: continue
   if v.get('id')==rid and 'method' not in v: return v
   if 'method' in v:
    self.events.append(v)
    if 'id' in v:
     if v['method']=='session/request_permission':
      self.send(dict(id=v['id'],result={'outcome':{'outcome':'cancelled'}}))
      if self.cancel_on_permission: self.send(dict(method='session/cancel',params={'sessionId':self.sid}))
     else: self.send(dict(id=v['id'],error={'code':-32601,'message':'Not offered by viability probe'}))
  return {'error':{'message':'probe timeout','method':method}}
 def close(self):
  self.p.stdin.close()
  try: self.p.wait(timeout=12)
  except subprocess.TimeoutExpired:
   os.killpg(self.p.pid,signal.SIGTERM)
   try: self.p.wait(timeout=3)
   except subprocess.TimeoutExpired: os.killpg(self.p.pid,signal.SIGKILL); self.p.wait()

def main():
 c=ACP(); result={}
 try:
  result['initialize']=c.request('initialize',{'protocolVersion':1,'clientCapabilities':{'fs':{'readTextFile':False,'writeTextFile':False},'terminal':False},'clientInfo':{'name':'filigranas-f0','version':'0.0.1'}})
  print(json.dumps(result),flush=True)
  result['new']=c.request('session/new',{'cwd':str(ROOT),'mcpServers':[]})
  print(json.dumps({'new':result['new']}),flush=True)
  sid=result['new'].get('result',{}).get('sessionId')
  if sid:
   result['prompt']=c.request('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Responde exactamente F0-ACP-OK. No uses herramientas ni leas archivos.'}]})
   result['events']=c.events
   print(json.dumps({'prompt':result['prompt'],'events':c.events}),flush=True)
 finally:
  c.close(); (OUT/'discovery.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__': main()
