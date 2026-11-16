// Núcleo simulado para trabajar la interfaz en el navegador (`npm run dev`)
// cuando no se puede compilar Rust. Solo se carga en desarrollo y fuera de
// Tauri; los datos viven en memoria y se pierden al recargar.
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import type { Entry, Group, Project, Workspace } from './ipc';

const ROOT = '/Users/demo/repositorios';

const files: Record<string, string> = {
  'bitacola/package.json': '{\n  "name": "bitacola",\n  "version": "0.4.0",\n  "type": "module"\n}\n',
  'bitacola/README.md': '# Bitàcola\n\nCola de acciones autónomas por cliente.\n',
  'bitacola/src/lib/autonomy.ts': `import { Policy, Client } from './types'
import { enqueue } from './queue'

export function validate(client: Client, action: string) {
  const policy = policies.get(client.id)
  if (!policy) return { ok: false, reason: 'sin política' }

  if (policy.blocked.includes(action)) {
    return { ok: false, reason: 'acción bloqueada' }
  }

  return { ok: true }
}

// valida antes de encolar
export async function run(client: Client, action: string) {
  const check = validate(client, action)
  if (!check.ok) throw new Error(check.reason)
  await enqueue(client.id, action)
}
`,
  'bitacola/src/lib/queue.ts': `const pending: Array<{ client: string; action: string }> = []

export async function enqueue(client: string, action: string) {
  pending.push({ client, action })
}
`,
  'bitacola/src/lib/types.ts': 'export type Client = { id: string }\nexport type Policy = { blocked: string[] }\n',
  'bitacola/tests/queue.test.ts': "import { enqueue } from '../src/lib/queue'\n",
  'vantia/README.md': '# Vantia\n',
  'inventario-it/README.md': '# Inventario IT\n',
  'marbi-bcn/index.html': '<!doctype html>\n<title>Marbi BCN</title>\n',
  'album-boda/README.md': '# Álbum de boda\n',
  'kaza/README.md': '# Kaza\n',
  'calaix/README.md': '# Calaix\n',
  'filigranas/README.md': '# Filigranas\n',
};

let root: string | null = null;
let nextGroup = 5;
let nextPty = 1;
let coachProfile = 'hansi';
let nextSession = 1;
const mockSessions: { id: number; project: string; engine: string; name: string; providerSession: string; effort: string | null }[] = [];
let sessionAnswer: ((decision: string) => void) | null = null;
let pendingApproval: ((decision: string) => void) | null = null;
const ptys = new Map<number, (data: string) => void>();
const groups: Group[] = [
  { id: 1, name: 'asserta' },
  { id: 2, name: 'webs' },
  { id: 3, name: 'aplicaciones' },
  { id: 4, name: 'herramientas' },
];
const meta: Record<string, { groupId: number | null; archived: boolean }> = {
  vantia: { groupId: 1, archived: false },
  'inventario-it': { groupId: 1, archived: false },
  'marbi-bcn': { groupId: 2, archived: false },
  'album-boda': { groupId: 2, archived: true },
  bitacola: { groupId: 3, archived: false },
  kaza: { groupId: 3, archived: false },
  calaix: { groupId: 4, archived: false },
  filigranas: { groupId: null, archived: false },
};

const rel = (p: string) => p.slice(ROOT.length + 1);
const projectNames = () => [...new Set(Object.keys(files).map((f) => f.split('/')[0]))].sort();

function workspace(): Workspace {
  const projects: Project[] = root
    ? projectNames().map((name) => ({ name, path: `${ROOT}/${name}`, groupId: meta[name]?.groupId ?? null, archived: meta[name]?.archived ?? false }))
    : [];
  return { root, groups: [...groups], projects };
}

function listDir(path: string): Entry[] {
  const prefix = rel(path) + '/';
  const seen = new Map<string, boolean>();
  for (const f of Object.keys(files)) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length).split('/');
    seen.set(rest[0], (seen.get(rest[0]) ?? false) || rest.length > 1);
  }
  return [...seen]
    .map(([name, dir]) => ({ name, dir, path: `${path}/${name}` }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

const fail = (msg: string) => {
  throw msg;
};

mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, any>;
    switch (cmd) {
      case 'get_workspace':
        return workspace();
      case 'default_root':
        return ROOT;
      case 'set_root':
        root = ROOT;
        return workspace();
      case 'create_group':
        if (groups.some((g) => g.name === a.name.trim())) fail(`ya existe el grupo «${a.name}»`);
        groups.push({ id: nextGroup++, name: a.name.trim() });
        return workspace();
      case 'rename_group':
        groups.find((g) => g.id === a.id)!.name = a.name.trim();
        return workspace();
      case 'delete_group':
        groups.splice(groups.findIndex((g) => g.id === a.id), 1);
        for (const m of Object.values(meta)) if (m.groupId === a.id) m.groupId = null;
        return workspace();
      case 'move_project':
      case 'set_archived': {
        const name = rel(a.path);
        meta[name] ??= { groupId: null, archived: false };
        if (cmd === 'move_project') meta[name].groupId = a.groupId;
        else meta[name].archived = a.archived;
        return workspace();
      }
      case 'list_dir':
        return listDir(a.path);
      case 'read_text':
        return files[rel(a.path)] ?? fail('archivo no encontrado');
      case 'write_text':
        if (!(rel(a.path) in files)) fail('solo se pueden guardar archivos existentes');
        files[rel(a.path)] = a.content;
        return null;
      case 'git_status':
        return {
          branch: 'main',
          head: '84ab176',
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          changes: rel(a.project) === 'bitacola' ? [{ path: 'src/lib/autonomy.ts', orig: null, status: 'M', adds: 3, dels: 1 }] : [],
        };
      case 'git_log':
        return [
          { hash: '9af2c5a', parents: ['6c4e902'], refs: 'HEAD -> main, origin/main', subject: 'valida antes de encolar' },
          { hash: '3b96e51', parents: ['6c4e902'], refs: 'ide/tests-e27', subject: 'tests de la cola' },
          { hash: '6c4e902', parents: [], refs: '', subject: 'cola con reintentos' },
        ];
      case 'git_diff_texts': {
        const now = files[`${rel(a.project)}/${a.path}`] ?? '';
        return { old: now.replace('// valida antes de encolar\n', ''), new: now };
      }
      case 'git_branches':
        return ['ide/tests-e27', 'main'];
      case 'git_switch':
        return a.branch === 'main' ? null : fail('tus cambios locales se sobrescribirían al cambiar de rama');
      case 'watch_project':
        return null;
      // Terminal de eco: sin shell real, repite lo que se escribe.
      case 'pty_open': {
        const id = nextPty++;
        const send = (data: string) => a.onEvent.onmessage({ kind: 'data', data });
        ptys.set(id, send);
        setTimeout(() => send(`\x1b[2m[núcleo simulado · ${rel(a.project)}]\x1b[0m\r\n$ `));
        return id;
      }
      case 'pty_write':
        ptys.get(a.id)?.(a.data === '\r' ? '\r\n$ ' : a.data === '\x7f' ? '\b \b' : a.data);
        return null;
      case 'pty_resize':
        return null;
      case 'pty_close':
        ptys.delete(a.id);
        return null;
      case 'session_list':
        return mockSessions.filter((x) => x.project === a.project);
      case 'session_create': {
        if (a.engine !== 'claude') fail(`el motor «${a.engine}» todavía no está disponible`);
        const used = mockSessions.filter((x) => x.project === a.project).map((x) => x.name);
        const name = ['xavi', 'iniesta', 'puyol', 'messi'].find((n) => !used.includes(n)) ?? 'kubala';
        const created = { id: nextSession++, project: a.project, engine: 'claude', name, providerSession: crypto.randomUUID(), effort: null };
        mockSessions.push(created);
        return created;
      }
      case 'session_history':
        return [];
      case 'session_send':
        void demoSession(a.id);
        return null;
      case 'session_respond':
        sessionAnswer?.(a.decision);
        return null;
      case 'session_interrupt':
        return null;
      case 'session_close':
        mockSessions.splice(mockSessions.findIndex((x) => x.id === a.id), 1);
        return null;
      case 'coordinator_open':
        return {
          threadId: 'hilo-demo',
          profile: coachProfile,
          model: 'gpt-6-sol',
          effort: 'medium',
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          turns: [],
          rateLimits: { primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 9000 }, secondary: { usedPercent: 47, windowDurationMins: 10080, resetsAt: null }, rateLimitReachedType: null },
          activeTurn: null,
        };
      case 'coordinator_send':
        void demoTurn(a.text);
        return null;
      case 'coordinator_respond':
        pendingApproval?.(a.decision);
        return null;
      case 'coordinator_interrupt':
        return null;
      case 'coordinator_set_profile':
        coachProfile = a.profile;
        return null;
      case 'plugin:dialog|open':
        return ROOT;
      default:
        console.warn('[mock] comando sin simular:', cmd, args);
        return null;
    }
  },
  { shouldMockEvents: true },
);

// Turno de ejemplo del coordinador: razonamiento, respuesta en streaming,
// un comando que pide permiso y un cambio de archivo.
async function demoTurn(text: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ev = (method: string, params: object, requestId: unknown = null) =>
    emit('coordinator', { method, params: { threadId: 'hilo-demo', turnId: 't1', ...params }, requestId });
  const n = Date.now();
  await ev('turn/started', { turn: { id: 't1' } });
  await ev('item/completed', { item: { id: `u${n}`, type: 'userMessage', content: [{ type: 'text', text }] } });
  await ev('item/started', { item: { id: `r${n}`, type: 'reasoning', summary: [], content: [] } });
  await ev('item/reasoning/summaryTextDelta', { itemId: `r${n}`, summaryIndex: 0, delta: 'Reviso la cola y la validación antes de tocar nada.' });
  await ev('item/started', { item: { id: `a${n}`, type: 'agentMessage', text: '' } });
  for (const word of 'Miro primero los tests de la cola para saber de dónde partimos.'.split(' ')) {
    await wait(40);
    await ev('item/agentMessage/delta', { itemId: `a${n}`, delta: word + ' ' });
  }
  const cmd = { id: `c${n}`, type: 'commandExecution', command: 'npm test -- queue', status: 'inProgress', aggregatedOutput: null, exitCode: null };
  await ev('item/started', { item: cmd });
  const decision = await new Promise<string>((resolve) => {
    pendingApproval = resolve;
    void ev('item/commandExecution/requestApproval', { itemId: cmd.id, command: cmd.command, reason: 'ejecutar los tests necesita red para instalar dependencias' }, 7);
  });
  pendingApproval = null;
  if (decision === 'decline') {
    await ev('item/completed', { item: { ...cmd, status: 'declined' } });
  } else {
    await ev('item/commandExecution/outputDelta', { itemId: cmd.id, delta: '✓ queue.test.ts (3 tests)\n' });
    await ev('item/completed', { item: { ...cmd, status: 'completed', exitCode: 0, aggregatedOutput: '✓ queue.test.ts (3 tests)\n' } });
    await ev('item/completed', { item: { id: `f${n}`, type: 'fileChange', status: 'completed', changes: [{ path: `${ROOT}/bitacola/src/lib/autonomy.ts`, kind: { type: 'update', move_path: null }, diff: '' }] } });
  }
  await ev('item/completed', { item: { id: `z${n}`, type: 'agentMessage', text: decision === 'decline' ? 'Sin los tests no sigo. Dime si prefieres otra forma.' : 'Hecho. Los tests pasan:\n```\n✓ queue.test.ts (3 tests)\n```' } });
  await ev('turn/completed', { turn: { id: 't1', error: null } });
}

// Respuesta de ejemplo de una sesión de Claude Code, con los mensajes que
// emite `claude -p --output-format stream-json`.
async function demoSession(id: number) {
  const ev = (msg: object) => emit('session', { id, msg });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await ev({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
  for (const word of 'Voy a añadir el caso de política deshabilitada.'.split(' ')) {
    await wait(40);
    await ev({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: word + ' ' } } });
  }
  const n = Date.now();
  const path = `${ROOT}/bitacola/src/lib/autonomy.ts`;
  await ev({ type: 'assistant', message: { id: `m${n}`, content: [{ type: 'text', text: 'Voy a añadir el caso de política deshabilitada.' }, { type: 'tool_use', id: `t${n}`, name: 'Edit', input: { file_path: path } }] } });
  const decision = await new Promise<string>((resolve) => {
    sessionAnswer = resolve;
    void ev({ type: 'control_request', request_id: `r${n}`, request: { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: path }, tool_use_id: `t${n}` } });
  });
  sessionAnswer = null;
  const ok = decision !== 'decline';
  await ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${n}`, is_error: !ok, content: ok ? 'ok' : 'rechazado' }] } });
  await ev({ type: 'assistant', message: { id: `m${n}b`, content: [{ type: 'text', text: ok ? 'Hecho: la validación rechaza clientes sin política.' : 'Entendido, no toco el archivo.' }] } });
  await ev({ type: 'result', subtype: 'success', is_error: false, result: '' });
}

// Atajo de depuración: simular que aparece un repositorio nuevo.
(window as any).__filigranasNuevoRepo = (name: string) => {
  files[`${name}/README.md`] = `# ${name}\n`;
  void emit('workspace-changed');
};

console.info('[filigranas] núcleo simulado activo');
