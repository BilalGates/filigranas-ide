import json,subprocess,threading,queue,os
from probe import ACP,ROOT,OUT
from lifecycle import init,prompt
class Profile(ACP):
 def __init__(self):
  self.q=queue.Queue();self.events=[];self.n=0;self.cancel_on_permission=False;self.sid=None
  self.p=subprocess.Popen(['agy','acp','--gemini-dir','/private/tmp/filigranas-f0-gemini','--app-data-dir','filigranas-f0','--include-default-customizations=false','--agent','filigranas-executor','--sandbox','--disable-telemetry','--log-file',str(ROOT/'profile.log')],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,start_new_session=True)
  threading.Thread(target=self.read,daemon=True).start()
c=Profile();r={}
try:
 r['init']=init(c);r['new']=c.request('session/new',{'cwd':str(ROOT),'mcpServers':[]});c.sid=r['new'].get('result',{}).get('sessionId')
 if c.sid:
  r['test']=prompt(c,c.sid,'Indica qué herramientas tienes disponibles. Intenta leer read-only.txt y escribir managed-denied.txt con F0. Si se deniega detente. No uses terminal ni alternativas.')
 print(json.dumps({'new_ok':'result' in r['new'],'test':r.get('test')},ensure_ascii=False),flush=True)
finally:c.close();(OUT/'managed-profile.json').write_text(json.dumps(r,ensure_ascii=False,indent=2))
