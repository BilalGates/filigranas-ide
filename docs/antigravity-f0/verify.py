"""Validate captured real-provider evidence; does not replace a native acceptance test."""
import json
from pathlib import Path
ROOT=Path(__file__).parent
load=lambda name: json.loads((ROOT/(name+'.json')).read_text())
d,l,c,s,b=[load(x) for x in ['discovery','lifecycle','capabilities','structured','boundaries']]
def updates(events,kind): return [v['params']['update'] for v in events if v.get('method')=='session/update' and v.get('params',{}).get('update',{}).get('sessionUpdate')==kind]
def text(events): return ''.join(u.get('content',{}).get('text','') for u in updates(events,'agent_message_chunk'))
def permissions(events): return [v for v in events if v.get('method')=='session/request_permission']
checks={
 'ACP protocol version 1':d['initialize']['result']['protocolVersion']==1,
 'installed server 1.5.18':d['initialize']['result']['agentInfo']['version']=='1.5.18',
 'created real session':bool(d['new']['result']['sessionId']),
 'dynamic model catalogue':len(d['new']['result']['models']['availableModels'])>0,
 'streamed assistant text':text(d['events'])=='F0-ACP-OK',
 'turn usage reported':d['prompt']['result']['usage']['inputTokens']>0,
 'context distinct from usage':bool(updates(d['events'],'usage_update')),
 'API keys removed on subsequent probes':l['api_keys_removed_from_environment'],
 'load in a new process':'result' in l['load'],
 'replayed user history':bool(updates(l['replay'],'user_message_chunk')),
 'replayed assistant history':text(l['replay'])=='F0-ACP-OK',
 'continuation recalled original marker':text(l['continue']['events'])=='F0-ACP-OK',
 'reasoning configuration':'result' in l['reasoning'],
 'read native tool events':bool(updates(l['read']['events'],'tool_call')),
 'read synthetic content':'F0-READ-ONLY-94' in text(l['read']['events']),
 'write required permission':bool(permissions(l['denied_write']['events'])),
 'denied write absent':l['denied_file_absent'],
 'cancelled pending tool turn':l['cancel']['response']['result']['stopReason']=='cancelled' and l['cancel_file_absent'],
 'recovered after cancellation':text(l['recovery']['events'])=='F0-RECOVERED',
 'resume supported':'result' in c['resume'],
 'invalid model rejected':c['invalid_config']['error']['code']==-32602,
 'model changed using offered option':'result' in c['model'],
 'recovered after invalid configuration':text(c['after_invalid_config']['events'])=='F0-MODEL-OK',
 'headless JSON schema result':s['exit_code']==0 and s['result']['structured_output']=={'status':'F0-STRUCTURED-OK'},
 'external read required permission':bool(permissions(b['read_outside']['events'])),
 'external content not returned':'F0-FOREIGN-CONTENT-5ac7' not in text(b['read_outside']['events']),
 'external write required permission':bool(permissions(b['write_outside']['events'])),
 'external denied write absent':b['outside_file_absent'],
}
for label,ok in checks.items(): print(('PASS' if ok else 'FAIL')+' '+label)
(ROOT/'checks.json').write_text(json.dumps({'source':'real agy 1.5.18, official stdio ACP and one headless invocation','checks':checks,'native_tauri_acceptance':False},indent=2))
assert all(checks.values()),'Some evidence checks failed'
print(f'{len(checks)} real-evidence assertions passed; native Tauri integration remains untested.')
