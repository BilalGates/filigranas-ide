# Uso (desde la raíz del repo): python3 design/trama-v2/scope.py src/trama/artifact.css
# Convierte el CSS del Artifact en una hoja con ámbito `.tv` para la app.
import re, sys
src = open('design/trama-v2/style.css').read() + '\n' + open('design/trama-v2/v2.css').read()
src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
# Decisión del 25 de noviembre de 2026: Trama usa JetBrains Mono, la fuente con
# la que se ve el HTML aprobado (src/trama/fonts.css). Iosevka queda en Monaco y xterm.
src = src.replace('--mono:Iosevka,"JetBrains Mono",', '--mono:"JetBrains Mono",')

def parse(s, i=0):
    out = []
    buf = ''
    while i < len(s):
        c = s[i]
        if c == '{':
            pre = buf.strip(); buf = ''
            if pre.startswith('@media') or pre.startswith('@supports') or pre.startswith('@container'):
                inner, i = parse(s, i + 1)
                out.append((pre, inner))
            else:
                depth = 1; j = i + 1
                while depth:
                    if s[j] == '{': depth += 1
                    elif s[j] == '}': depth -= 1
                    j += 1
                out.append((pre, s[i + 1:j - 1]))
                i = j
                continue
        elif c == '}':
            return out, i + 1
        else:
            buf += c
        i += 1
    return out, i

rules, _ = parse(src)
frames = set()
def walk(rs):
    for pre, body in rs:
        if isinstance(body, list): walk(body)
        elif pre.startswith('@keyframes'): frames.add(pre.split()[1])
walk(rules)

SHELL = re.compile(r'^(\.win|\.titlebar|\.lights|#field|#fieldc|\.rail\b|\.rbtn|\.status\b|\.crumb|\.projbtn|\.search\b|\.pulse\b|#layer|\.rtip|\.toasts)')
def scope_sel(sel):
    sel = sel.strip()
    if not sel: return None
    if sel in (':root', 'html', 'body', 'html,body'): return '.tv'
    if sel == '*': return '.tv, .tv *'
    m = re.match(r'^body((?:\.[\w-]+)+)(.*)$', sel)
    if m: return '.tv' + m.group(1) + m.group(2)
    m2 = re.match(r'^((?:\.(?:w-narrow|w-tiny|calm|reduced))+)(.*)$', sel)
    if m2: return '.tv' + m2.group(1) + m2.group(2)
    if sel.startswith('html'): return None
    if SHELL.match(sel): return None
    if re.match(r'^(button|input|textarea|select|a|svg|img|code|pre|p|h[1-6]|ul|ol|li|table|th|td|kbd)(:[\w-]+(\([^)]*\))?)*$', sel): return ':where(.tv) ' + sel
    if sel.startswith('::') or sel.startswith(':focus') : return ':where(.tv) ' + sel
    if sel.startswith('.view') or sel.startswith('#view'):
        return '.tv' + sel[len('.view'):] if sel.startswith('.view') else '.tv' + sel[5:]
    return '.tv ' + sel

def split_sel(pre):
    parts, depth, cur = [], 0, ''
    for ch in pre:
        if ch in '([': depth += 1
        if ch in ')]': depth -= 1
        if ch == ',' and depth == 0: parts.append(cur); cur = ''
        else: cur += ch
    parts.append(cur)
    return parts

def fix_body(body):
    def rep(m):
        decl = m.group(0)
        for f in frames:
            decl = re.sub(r'(?<![\w-])' + re.escape(f) + r'(?![\w-])', 'tv-' + f, decl)
        return decl
    return re.sub(r'animation(-name)?\s*:[^;]*', rep, body)

def to_scope(sel):
    sel = sel.replace(':where(.tv)', ':where(:scope)')
    return re.sub(r'^\.tv(?![\w-])', ':scope', sel)

def emit(rs, indent=''):
    out = []
    plain = []
    def flush():
        if plain:
            out.append('@scope (.tv) to (.legacy){\n' + '\n'.join(plain) + '\n}')
            plain.clear()
    for pre, body in rs:
        if isinstance(body, list):
            flush()
            inner = emit(body, indent + '  ')
            if inner: out.append(f'{pre}{{\n{inner}\n}}')
        elif pre.startswith('@keyframes'):
            flush(); out.append('@keyframes tv-' + pre.split()[1] + '{' + body + '}')
        elif pre.startswith('@property') or pre.startswith('@font-face'):
            flush(); out.append(pre + '{' + body + '}')
        elif pre.startswith('@'):
            continue
        else:
            sels = [scope_sel(s) for s in split_sel(pre)]
            sels = [s for s in sels if s]
            if sels: plain.append(','.join(to_scope(x) for x in sels) + '{' + fix_body(body) + '}')
    flush()
    return '\n'.join(out)

head = '/* Generado desde el Artifact Trama v2 (style.css + v2.css) por tools/scope.py. Ámbito: .tv */\n'
open(sys.argv[1], 'w').write(head + emit(rules) + '\n')
print('frames', len(frames))
