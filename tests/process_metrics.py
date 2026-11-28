"""CPU y RAM atribuibles a Filigranas en macOS, separadas por motor.

Uso: python3 -I tests/process_metrics.py [--pid PID] [--seconds 60] [--interval 2] [--out salida.json]

Incluye el árbol de descendientes del proceso principal (claude, codex, agy,
terminales…) y los procesos de WebKit cuya responsabilidad recae en la app,
que macOS lanza desde launchd y no cuelgan del árbol. Solo lee `ps`; no envía
señales ni modifica nada.
"""
import argparse, ctypes, json, subprocess, sys, time

lib = ctypes.CDLL(None)
try:
    responsible = lib.responsibility_get_pid_responsible_for_pid
    responsible.argtypes, responsible.restype = [ctypes.c_int], ctypes.c_int
except AttributeError:  # pragma: no cover - fuera de macOS
    responsible = lambda pid: -1


def snapshot():
    out = subprocess.run(['/bin/ps', '-A', '-o', 'pid=,ppid=,%cpu=,rss=,comm='], capture_output=True, text=True, check=True).stdout
    rows = {}
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5:
            pid, ppid, cpu, rss, comm = parts
            rows[int(pid)] = (int(ppid), float(cpu), int(rss), comm)
    return rows


def find_app(rows):
    for pid, (_, _, _, comm) in rows.items():
        if comm.endswith('/MacOS/filigranas') or comm.endswith('/debug/filigranas') or comm.endswith('/release/filigranas'):
            return pid
    return None


def group(comm, chain):
    """Motor al que pertenece un proceso: el primer ancestro reconocible."""
    for name in [comm] + chain:
        base = name.rsplit('/', 1)[-1].lower()
        if 'webkit' in name.lower():
            return 'webview'
        for engine in ('claude', 'codex', 'agy', 'antigravity'):
            if base.startswith(engine) or f'/{engine}' in name.lower():
                return 'agy' if engine == 'antigravity' else engine
    return 'filigranas'


def attribute(rows, root):
    children = {}
    for pid, (ppid, *_rest) in rows.items():
        children.setdefault(ppid, []).append(pid)
    owned, stack = {}, [(root, [])]
    while stack:
        pid, chain = stack.pop()
        if pid not in rows:
            continue
        comm = rows[pid][3]
        owned[pid] = group(comm, chain) if pid != root else 'filigranas'
        stack.extend((child, [comm] + chain) for child in children.get(pid, []))
    for pid, (_, _, _, comm) in rows.items():
        if pid not in owned and 'WebKit' in comm and responsible(pid) == root:
            owned[pid] = 'webview'
    totals = {}
    for pid, name in owned.items():
        _, cpu, rss, _ = rows[pid]
        t = totals.setdefault(name, {'cpu': 0.0, 'rss_mib': 0.0, 'procs': 0})
        t['cpu'] += cpu
        t['rss_mib'] += rss / 1024
        t['procs'] += 1
    for t in totals.values():
        t['cpu'], t['rss_mib'] = round(t['cpu'], 1), round(t['rss_mib'], 1)
    return totals


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pid', type=int)
    ap.add_argument('--seconds', type=float, default=60)
    ap.add_argument('--interval', type=float, default=2)
    ap.add_argument('--out')
    a = ap.parse_args()
    rows = snapshot()
    root = a.pid or find_app(rows)
    if not root or root not in rows:
        sys.exit('No hay ningún proceso de Filigranas en marcha')
    samples, end = [], time.monotonic() + a.seconds
    while True:
        rows = snapshot()
        if root not in rows:
            break
        samples.append({'t': round(time.time(), 1), 'groups': attribute(rows, root)})
        if time.monotonic() >= end:
            break
        time.sleep(a.interval)
    names = sorted({g for s in samples for g in s['groups']})
    summary = {}
    for name in names + ['total']:
        cpu = [sum(g['cpu'] for g in s['groups'].values()) if name == 'total' else s['groups'].get(name, {}).get('cpu', 0) for s in samples]
        rss = [sum(g['rss_mib'] for g in s['groups'].values()) if name == 'total' else s['groups'].get(name, {}).get('rss_mib', 0) for s in samples]
        summary[name] = {'cpu_avg': round(sum(cpu) / len(cpu), 1), 'cpu_max': max(cpu), 'rss_mib_avg': round(sum(rss) / len(rss), 1), 'rss_mib_max': max(rss)}
    report = {'pid': root, 'app': rows.get(root, (0, 0, 0, '?'))[3], 'samples': len(samples), 'interval_s': a.interval,
              'note': '%CPU de ps: 100 = un núcleo, media decaída por el kernel. RSS incluye memoria compartida.',
              'summary': summary, 'series': samples}
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if a.out:
        open(a.out, 'w').write(text + '\n')
    print(json.dumps({k: report[k] for k in ('pid', 'app', 'samples', 'summary')}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
