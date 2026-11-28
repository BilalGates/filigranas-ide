"""Real lifecycle and denied-permission probes in the fixture only."""
from probe import ACP, ROOT, OUT
import json, time

def init(c):
 return c.request('initialize',{'protocolVersion':1,'clientCapabilities':{'fs':{'readTextFile':False,'writeTextFile':False},'terminal':False},'clientInfo':{'name':'filigranas-f0','version':'0.0.1'}})
def prompt(c,sid,text):
 c.events=[]; start=time.monotonic()
 r=c.request('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':text}]},90)
 return {'response':r,'events':c.events[:],'seconds':round(time.monotonic()-start,3)}
def main():
 prior=json.loads((OUT/'discovery.json').read_text()); sid=prior['new']['result']['sessionId']
 result={'api_keys_removed_from_environment':True}; c=ACP(); c.sid=sid
 try:
  result['initialize']=init(c)
  c.events=[]; result['load']=c.request('session/load',{'sessionId':sid,'cwd':str(ROOT),'mcpServers':[]})
  result['replay']=c.events[:]
  print('load:', 'error' not in result['load'],flush=True)
  result['reasoning']=c.request('session/set_config_option',{'sessionId':sid,'configId':'thought_level','value':'low'})
  result['continue']=prompt(c,sid,'¿Qué marcador exacto respondiste en el primer turno? Responde solo ese marcador. No uses herramientas.')
  print('continuation:',result['continue']['response'],flush=True)
  (ROOT/'read-only.txt').write_text('F0-READ-ONLY-94\n')
  result['read']=prompt(c,sid,'Lee exclusivamente read-only.txt con la herramienta de lectura nativa e indica el contenido. No uses terminal, no escribas archivos ni leas otros archivos.')
  print('read:',result['read']['response'],flush=True)
  denied=ROOT/'must-not-exist.txt'
  assert not denied.exists()
  result['denied_write']=prompt(c,sid,'Intenta crear must-not-exist.txt en esta carpeta con F0-DENIED usando la herramienta de edición nativa. Si se rechaza el permiso, detente y comunícalo. No uses terminal ni alternativas.')
  result['denied_file_absent']=not denied.exists()
  print('denied write, file absent:',result['denied_file_absent'],flush=True)
  c.cancel_on_permission=True
  result['cancel']=prompt(c,sid,'Intenta crear cancel-must-not-exist.txt con F0-CANCEL usando la herramienta de edición nativa. Si se rechaza el permiso detente, no uses terminal ni alternativas.')
  result['cancel_file_absent']=not (ROOT/'cancel-must-not-exist.txt').exists()
  print('cancel:',result['cancel']['response'],flush=True)
  result['recovery']=prompt(c,sid,'Responde exactamente F0-RECOVERED. No uses herramientas.')
  print('recovery:',result['recovery']['response'],flush=True)
 finally:
  c.close(); (OUT/'lifecycle.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__': main()
