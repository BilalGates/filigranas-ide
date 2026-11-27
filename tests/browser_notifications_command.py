"""Send one opt-in acceptance command to the isolated WKWebView driver."""
import argparse
import json
from pathlib import Path
import sys
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('evidence', type=Path)
parser.add_argument('case', help='name for the captured JSON result')
args = parser.parse_args()
if not args.case.replace('-', '').replace('_', '').isalnum():
    parser.error('invalid case name')
path = args.evidence / 'result.json'
previous = path.stat().st_mtime_ns if path.exists() else 0
request = urllib.request.Request(
    'http://127.0.0.1:14620/__acceptance',
    data=json.dumps({'command': sys.stdin.read()}).encode(), method='POST',
    headers={'x-acceptance-token': Path('/tmp/filigranas-browser-acceptance-token').read_text()},
)
urllib.request.urlopen(request, timeout=5).read()
for _ in range(180):
    time.sleep(.25)
    if not path.exists() or path.stat().st_mtime_ns == previous:
        continue
    try:
        result = json.loads(path.read_text())
    except json.JSONDecodeError:
        continue
    if result.get('ready'):
        continue
    (args.evidence / (args.case + '.json')).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(1 if 'error' in result else 0)
raise SystemExit('Native command timed out')
