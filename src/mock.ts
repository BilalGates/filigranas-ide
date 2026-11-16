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
      case 'plugin:dialog|open':
        return ROOT;
      default:
        console.warn('[mock] comando sin simular:', cmd, args);
        return null;
    }
  },
  { shouldMockEvents: true },
);

// Atajo de depuración: simular que aparece un repositorio nuevo.
(window as any).__filigranasNuevoRepo = (name: string) => {
  files[`${name}/README.md`] = `# ${name}\n`;
  void emit('workspace-changed');
};

console.info('[filigranas] núcleo simulado activo');
