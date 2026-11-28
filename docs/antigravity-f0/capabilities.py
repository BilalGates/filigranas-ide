"""Capability configuration, resume and structured headless results; no private APIs."""
import json, os, subprocess
from probe import ACP, ROOT, OUT
from lifecycle import init, prompt

def main():
 sid=json.loads((OUT/'discovery.json').read_text())['new']['result']['sessionId']
 c=ACP(); c.sid=sid; r={}
 try:
  r['initialize']=init(c)
  r['resume']=c.request('session/resume',{'sessionId':sid,'cwd':str(ROOT),'mcpServers':[]})
  r['resume_events']=c.events[:]
  r['invalid_config']=c.request('session/set_config_option',{'sessionId':sid,'configId':'model','value':'filigranas-deliberately-invalid-model'})
  r['model']=c.request('session/set_config_option',{'sessionId':sid,'configId':'model','value':'gemini-3.8-flash'})
  r['reasoning']=c.request('session/set_config_option',{'sessionId':sid,'configId':'thought_level','value':'low'})
  r['after_invalid_config']=prompt(c,sid,'Responde exactamente F0-MODEL-OK sin usar herramientas.')
  print('resume:', 'result' in r['resume'], 'invalid config:',r['invalid_config'],flush=True)
  print('model:', 'result' in r['model'], 'turn:',r['after_invalid_config']['response'],flush=True)
 finally:
  c.close(); (OUT/'capabilities.json').write_text(json.dumps(r,ensure_ascii=False,indent=2))
 schema={'type':'object','properties':{'status':{'type':'string','enum':['F0-STRUCTURED-OK']}},'required':['status'],'additionalProperties':False}
 p=subprocess.run(['agy','--sandbox','--disable-slash-commands','--model','gemini-3.8-flash-low','--print','Return a JSON object with status equal to F0-STRUCTURED-OK. Do not use tools or read files.','--json-schema',json.dumps(schema),'--output-format','json','--print-timeout','45s'],cwd=ROOT,capture_output=True,text=True,timeout=55,env={k:v for k,v in os.environ.items() if k not in ('GEMINI_API_KEY','GOOGLE_API_KEY')})
 try: out=json.loads(p.stdout)
 except ValueError: out={'non_json_output':True,'stdout':p.stdout[:500]}
 (OUT/'structured.json').write_text(json.dumps({'exit_code':p.returncode,'result':out},ensure_ascii=False,indent=2))
 print('structured headless exit:',p.returncode,'result:',out,flush=True)
if __name__=='__main__': main()
