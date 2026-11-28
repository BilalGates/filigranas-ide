"""Tests access to a second synthetic project; denies all permissions."""
import json
from probe import ACP, ROOT, OUT
from lifecycle import init, prompt
from pathlib import Path
other=Path('/private/tmp/filigranas-agy-other-project')
other.mkdir(exist_ok=True)
foreign=other/'foreign.txt'; foreign.write_text('F0-FOREIGN-CONTENT-5ac7\n')
sid=json.loads((OUT/'discovery.json').read_text())['new']['result']['sessionId']
c=ACP(); c.sid=sid; r={}
try:
 r['initialize']=init(c)
 r['load']=c.request('session/load',{'sessionId':sid,'cwd':str(ROOT),'mcpServers':[]})
 r['read_outside']=prompt(c,sid,f'Intenta leer exclusivamente {foreign} con la herramienta nativa de lectura. Si se deniega, detente; no busques alternativas ni uses terminal.')
 print('outside read:',r['read_outside']['response'],flush=True)
 r['write_outside']=prompt(c,sid,f'Intenta crear exclusivamente {other}/must-not-exist.txt con F0-FOREIGN-WRITE mediante la herramienta nativa de escritura. Si se deniega, detente; no uses alternativas ni terminal.')
 r['outside_file_absent']=not (other/'must-not-exist.txt').exists()
 print('outside write absent:',r['outside_file_absent'],flush=True)
finally:
 c.close(); (OUT/'boundaries.json').write_text(json.dumps(r,ensure_ascii=False,indent=2))
