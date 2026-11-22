// Núcleo simulado para trabajar la interfaz en el navegador (`pnpm dev`)
// cuando no se puede compilar Rust. Solo se carga en desarrollo y fuera de
// Tauri; los datos viven en memoria y se pierden al recargar.
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import type { BrainGraphData, BrainGraphFilter, BrainEntry, Entry, GithubLoginStatus, Group, HealthRun, HostedShare, LocalService, Project, WorkSession, Workspace } from './ipc';

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
let nextSession = 1;
const mockServices = new Map<string, LocalService[]>();
const mockBranches = new Map<string, string>();
const mockSessions: any[] = [
  { id: 900, project: '/Users/demo/repositorios/calaix', engine: 'claude', name: 'diseño', providerSession: 'm', effort: null, worktree: '/tmp/wt/diseno', branch: 'ide/diseno', base: 'main', baseCommit: '84ab176', integrated: null, task: null, handoffFrom: null, paused: null },
];
const mockManagers = new Map<string, any>();
let mockShare: (HostedShare & { project: string }) | null = null;
let mockShareGuest = false;
let mockGithub: GithubLoginStatus | null = null;
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

// Datos sintéticos de Brain, solo para la vista de desarrollo en navegador.
const mockBrainEntries: Array<BrainEntry & { project: string | null }> = [];
const mockLinks: any[] = [];
const mockSeeded = new Set<number>();
function mockBrainGraph(filter: BrainGraphFilter): BrainGraphData {
  const nodes: BrainGraphData['nodes'] = [];
  const edges: BrainGraphData['edges'] = [];
  const now = Math.floor(Date.now() / 1000);
  const themes = ['Arquitectura y decisiones', 'Contexto compartido', 'Validación de cambios', 'Continuidad entre sesiones'];
  projectNames().forEach((name, i) => {
    const project = `${ROOT}/${name}`;
    if (filter.project && filter.project !== project) return;
    const hub = `project:${project}`;
    nodes.push({ key: hub, id: 0, kind: 'project', title: name, project, date: now, url: null, body: null, source: null, matched: true });
    if (name === 'bitacola') {
      const task = 'task:bitacola:1', pull = 'pull:bitacola:7';
      nodes.push(
        { key: task, id: 1, kind: 'task', title: 'Revisar la cola', date: now, project, url: null, body: null, source: null, matched: true },
        { key: pull, id: 7, kind: 'pr', title: 'Integrar mejoras de la cola', date: now, project, url: 'https://github.com/demo/bitacola/pull/7', body: null, source: null, matched: true },
      );
      edges.push({ from: task, to: hub, kind: 'project_member' }, { from: task, to: pull, kind: 'pull' });
    }
    themes.forEach((title, j) => {
      const id = i * 10 + j + 1;
      const entry: BrainEntry & { project: string } = { id, version: 1, global: false, task: null, kind: j === 0 ? 'decision' : j === 3 ? 'outcome' : 'fact',
        title: `${title} · ${name}`, body: `Memoria de ejemplo de ${name}. Conserva las decisiones y sus fuentes para continuar el trabajo.`, source: `Nota de diseño · ${name}`,
        sourceTask: null, sourceRun: null, share: false, validUntil: null, created: now, updated: now - j * 86400, project };
      if (!mockSeeded.has(id)) { mockSeeded.add(id); mockBrainEntries.push(entry); }
    });
    for (const cur of mockBrainEntries.filter((e) => e.project === project)) {
      const key = `m:${cur.id}`;
      nodes.push({ key, id: cur.id!, kind: cur.kind, title: cur.title, date: cur.updated, project, url: null, body: cur.body, source: cur.source,
        validUntil: cur.validUntil, sourceTask: cur.sourceTask, sourceRun: cur.sourceRun,
        validity: cur.validUntil != null && cur.validUntil <= now ? 'caducado' : 'vigente', matched: true });
      edges.push({ from: key, to: hub, kind: 'project_member' });
    }
  });
  const global: BrainEntry & { project: null } = { id: 999, version: 1, task: null,
    kind: 'preference', title: 'Priorizar la continuidad', body: 'Conservar el contexto entre proyectos y sesiones.',
    source: 'Preferencia de ejemplo', project: null, global: true, share: false, sourceTask: null,
    sourceRun: null, validUntil: null, created: now, updated: now };
  if (!mockSeeded.has(global.id!)) {
    mockSeeded.add(global.id!);
    mockBrainEntries.push(global);
  }
  if (!filter.project) {
    for (const entry of mockBrainEntries.filter((entry) => entry.global)) {
      nodes.push({ ...entry, key: `m:${entry.id}`, id: entry.id!, date: entry.updated, url: null, matched: true,
        validity: entry.validUntil != null && entry.validUntil <= now ? 'caducado' : 'vigente' });
    }
  }
  const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
  const terms = fold(filter.query ?? '').split(/\s+/).filter(Boolean);
  const matches = new Set(nodes.filter(n => n.key === `m:${filter.focusId}` ||
    ((!filter.memoryOnly || n.key.startsWith('m:')) && (!filter.validity || filter.validity === n.validity)
    && (!filter.kind || n.kind === filter.kind) && (!filter.from || n.date >= filter.from) && (!filter.until || n.date < filter.until)
    && terms.every((term) => fold(`${n.title} ${n.body ?? ''} ${n.source ?? ''}`).includes(term)))).map(n => n.key));
  const visible = new Set(matches);
  for (const edge of edges) { if (matches.has(edge.from)) visible.add(edge.to); if (matches.has(edge.to)) visible.add(edge.from); }
  return { nodes: nodes.filter(n => visible.has(n.key)).map(n => ({ ...n, matched: matches.has(n.key) })), edges: edges.filter(e => visible.has(e.from) && visible.has(e.to)), limited: false };
}

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

const mockWorks = new Map<string, WorkSession>();
let nextWork = 1;

let mockJevSettings = { mode: 'local', policy: 'balanced', timeoutSecs: 3, model: null, lightModel: null };
const mockJevStatus = () => ({ settings: mockJevSettings, supported: false, service: 'Filigranas IDE TypeSafe', account: 'jev', codexModels: [] });
let mockCliAuto = true;
let mockCodexVersion = 'codex-cli 0.169.0';
/** Simula el aviso del bucle automático: `__mockCliUpdates()` en la consola. */
(window as any).__mockCliUpdates = (failed = false) => emit('cli-updates', failed
  ? [{ id: 'codex', name: 'Codex', outcome: 'failed', from: 'codex-cli 0.169.0', to: 'codex-cli 0.169.0', detail: 'EBUSY: resource busy or locked' }]
  : [{ id: 'claude', name: 'Claude Code', outcome: 'updated', from: '2.1.325 (Claude Code)', to: '2.1.328 (Claude Code)', detail: '2.1.325 (Claude Code) → 2.1.328 (Claude Code)' },
     { id: 'agy', name: 'Antigravity', outcome: 'updated', from: '1.5.9', to: '1.6.0', detail: '1.5.9 → 1.6.0' }]);

mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, any>;
    switch (cmd) {
      case 'work_current':
        return mockWorks.get(a.project) ?? null;
      case 'work_start': {
        if (mockWorks.get(a.project)?.state && mockWorks.get(a.project)?.state !== 'finished') return fail('ya hay una sesión de trabajo abierta');
        const slug = String(a.description).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0,72).replace(/-$/, '');
        const work: WorkSession = { id: nextWork++, objective: a.objective, branch: `${a.kind}/${slug}`, baseCommit: '84ab176', state: 'active', tests: null, evidence: null, reviewedHead: null, prUrl: null,
          agents: mockSessions.filter(s => s.project === a.project && !s.worktree).map(s => ({sessionId:s.id,name:s.name,paths:['.'],running:false,closed:false})) };
        mockWorks.set(a.project, work);
        mockBranches.set(a.project, work.branch);
        void emit('project-changed');
        void emit('tasks-changed');
        return work;
      }
      case 'work_assign': {
        const agent = mockWorks.get(a.project)?.agents.find(s => s.sessionId === a.session);
        if (agent) agent.paths = a.paths;
        void emit('tasks-changed');
        return null;
      }
      case 'work_prepare': {
        const work = mockWorks.get(a.project);
        if (work) { work.state = 'review'; work.tests = a.tests; work.evidence = a.evidence; work.reviewedHead = '9af2c5a462f7618732f102a1f12442411c737cb3'; }
        void emit('tasks-changed');
        return null;
      }
      case 'work_resume': {
        const work = mockWorks.get(a.project);
        if (work) { work.state = 'active'; work.tests = null; work.evidence = null; }
        void emit('tasks-changed');
        return null;
      }
      case 'get_workspace':
        return workspace();
      case 'home_summary':
        return (a.paths as string[]).map((path) => ({
          path,
          tasks: rel(path) === 'kaza' ? [] : mockTasks().filter((task) => task.status !== 'done' && task.status !== 'cancelled'),
          sessions: path === a.focus ? mockSessions.filter((session) => session.project === path) : [],
          work: mockWorks.get(path) ?? null,
          branch: mockBranches.get(path) ?? 'main',
          dates: ['2026-11-19T22:14:00+01:00', '2026-11-19T21:45:00+01:00', '2026-11-18T17:40:00+01:00'],
        }));
      case 'default_root':
        return ROOT;
      case 'set_root':
        root = ROOT;
        return workspace();
      case 'create_project': {
        const name = String(a.name).trim();
        if (!name || name.includes('/')) fail(`«${name}» no vale como nombre de carpeta`);
        if (projectNames().includes(name)) fail(`ya existe ${ROOT}/${name}`);
        files[`${name}/README.md`] = `# ${name}\n`;
        return workspace();
      }
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
      case 'reveal_project':
        return null;
      case 'share_start':
        mockShare = { project: a.project, name: rel(a.project), editable: a.editable,
          invitation: 'filigranas-demo', expiresAt: Date.now() + 900_000 };
        return mockShare;
      case 'share_current':
        return mockShare;
      case 'share_access':
        if (!mockShare) return fail('la sesión compartida ha terminado');
        mockShare = { ...mockShare, editable: a.editable };
        return mockShare;
      case 'share_stop':
        mockShare = null;
        return null;
      case 'share_join':
        if (mockShareGuest || !mockShare || a.code !== mockShare.invitation) return fail('invitación no válida');
        mockShareGuest = true;
        return { name: mockShare.name, editable: mockShare.editable };
      case 'share_status':
        return { online: !!mockShare, closed: !mockShare, editable: mockShare?.editable ?? false };
      case 'share_list':
        if (!mockShare) return fail('la sesión compartida ha terminado');
        return listDir(a.path ? `${mockShare.project}/${a.path}` : mockShare.project)
          .map((entry) => ({ ...entry, path: entry.path.slice(mockShare!.project.length + 1) }));
      case 'share_read': {
        if (!mockShare) return fail('la sesión compartida ha terminado');
        const text = files[`${rel(mockShare.project)}/${a.path}`] ?? fail('archivo no compartido');
        return a.revision === text ? null : { text, revision: text };
      }
      case 'share_write': {
        if (!mockShare?.editable) return fail('el proyecto es de solo lectura');
        const file = `${rel(mockShare.project)}/${a.path}`;
        if (files[file] !== a.previous && files[file] !== a.content) return fail('El archivo cambió en el equipo anfitrión.');
        files[file] = a.content;
        void emit('project-changed');
        return null;
      }
      case 'share_leave':
        mockShareGuest = false;
        mockShare = null;
        return null;
      case 'github_login_start':
        mockGithub = { state: 'waiting', code: 'DEMO-1234' };
        return mockGithub;
      case 'github_login_status':
        return mockGithub;
      case 'github_login_cancel':
        mockGithub = { state: 'cancelled' };
        return null;
      case 'github_login_open':
        mockGithub = { state: 'complete' };
        return null;
      case 'list_dir':
        return listDir(a.path);
      case 'read_text':
        return files[rel(a.path)] ?? fail('archivo no encontrado');
      case 'write_text':
        if (!(rel(a.path) in files)) fail('solo se pueden guardar archivos existentes');
        if (a.previous != null && files[rel(a.path)] !== a.previous) return fail('El archivo cambió en disco.');
        files[rel(a.path)] = a.content;
        return null;
      case 'git_head':
        return mockBranches.get(a.project) ?? 'main';
      case 'git_status':
        return {
          branch: mockBranches.get(a.project) ?? 'main',
          head: '84ab176',
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          changes: rel(a.project) === 'bitacola' ? [{ path: 'src/lib/autonomy.ts', orig: null, status: 'M', adds: 3, dels: 1 }] : [],
        };
      case 'git_log':
        return [
          { hash: '9af2c5a', parents: ['6c4e902', '3b96e51'], refs: 'HEAD -> main, origin/main', subject: 'integra las pruebas de la cola', author: 'Bilal', date: '2026-11-19T22:14:00+01:00' },
          { hash: '3b96e51', parents: ['6c4e902'], refs: 'ide/tests-e27', subject: 'prueba los reintentos', author: 'Bilal', date: '2026-11-19T21:45:00+01:00' },
          { hash: '6c4e902', parents: [], refs: '', subject: 'valida antes de encolar', author: 'Bilal', date: '2026-11-18T17:40:00+01:00' },
        ];
      case 'git_diff_texts': {
        const now = files[`${rel(a.project)}/${a.path}`] ?? '';
        return { old: now.replace('// valida antes de encolar\n', ''), new: now };
      }
      case 'git_branches':
        return ['ide/tests-e27', 'main'];
      case 'git_switch':
        if (rel(a.project) === 'bitacola' && a.branch !== 'main') fail('tus cambios locales se sobrescribirían al cambiar de rama');
        mockBranches.set(a.project, a.branch);
        void emit('project-changed');
        return null;
      case 'watch_project':
        return null;
      case 'git_fetch':
        return 'From github.com:demo/bitacola\n   84ab176..9af2c5a  main -> origin/main';
      case 'git_pull':
        return 'Already up to date.';
      case 'git_push':
        return 'To github.com:demo/bitacola.git\n   84ab176..9af2c5a  main -> main';
      case 'git_review_push':
      case 'pr_review_publish':
      case 'pr_review_merge':
        return { id: 'revision-demo', message: 'Revisión de la operación de ejemplo', code: '9af2c5a462f7' };
      case 'cancel_review':
        return null;
      case 'git_stash':
        mockStashes.unshift({ name: `stash@{${mockStashes.length}}`, subject: `On main: ${a.message ?? 'cambios guardados'}` });
        return 'Saved working directory and index state WIP on main';
      case 'git_stash_pop':
        return mockStashes.shift() ? 'Dropped refs/stash@{0}' : fail('No stash entries found.');
      case 'git_stash_list':
        return mockStashes;
      case 'git_commit_detail':
        return {
          hash: a.hash,
          author: 'Bilal',
          date: 'hace 2 horas',
          body: 'Valida la política de autonomía antes de encolar la tarea.\n\nSin política, la cola rechazaba en silencio.',
          files: [
            { status: 'M', path: 'src/lib/autonomy.ts', adds: 14, dels: 3 },
            { status: 'A', path: 'tests/autonomy.test.ts', adds: 42, dels: 0 },
          ],
        };
      case 'git_undo_commit':
        return 'HEAD is now at 6c4e902';
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
      case 'chat_pm':
        return mockManagers.get(a.project) ?? null;
      case 'chat_history':
        return [];
      case 'chat_switch': {
        if (a.session != null) {
          const at = mockSessions.findIndex((session) => session.id === a.session);
          const next = { ...mockSessions[at], engine: a.engine, providerSession: '' };
          mockSessions[at] = next;
          return next;
        }
        if (a.engine === 'codex') {
          mockManagers.delete(a.project);
          return null;
        }
        const manager = { id: nextSession++, project: a.project, engine: 'claude', name: 'Project manager',
          providerSession: crypto.randomUUID(), worktree: null, effort: null };
        mockManagers.set(a.project, manager);
        return manager;
      }
      case 'session_list':
        return mockSessions.filter((x) => x.project === a.project);
      case 'session_create': {
        const used = mockSessions.filter((x) => x.project === a.project).map((x) => x.name);
        const name = Array.from({ length: 99 }, (_, i) => `sesión ${i + 1}`).find((n) => !used.includes(n))!;
        const id = nextSession++;
        const created = {
          id,
          project: a.project,
          engine: a.engine,
          name,
          providerSession: crypto.randomUUID(),
          effort: null,
          worktree: null,
          branch: mockWorks.get(a.project)?.branch ?? null,
          base: 'main',
          baseCommit: '84ab176',
          integrated: null,
          task: null,
          handoffFrom: null,
          paused: null,
          skillRole: a.skillRole ?? 'senior',
        };
        mockSessions.push(created);
        mockWorks.get(a.project)?.agents.push({sessionId:id,name,paths:['.'],running:false,closed:false});
        void emit('tasks-changed');
        return { ...created, notice: 'Comparte la rama y el checkout de la sesión de trabajo.' };
      }
      case 'session_history':
        return [];
      case 'claude_chat_options':
        return { models: [], pinnedModel: null };
      case 'session_send':
        void demoSession(a.id);
        return null;
      case 'session_respond':
        sessionAnswer?.(a.decision);
        return null;
      case 'session_interrupt':
        return null;
      case 'session_changes':
        return { branch: 'ide/demo', head: '84ab176', upstream: null, ahead: 0, behind: 0, changes: [{ path: 'src/lib/autonomy.ts', orig: null, status: 'M', adds: 4, dels: 1 }] };
      case 'session_diff_texts': {
        const now = files['bitacola/src/lib/autonomy.ts'] ?? '';
        return { old: now, new: now.replace('// valida antes de encolar\n', '// valida antes de encolar (política obligatoria)\n') };
      }
      case 'session_integrate':
        return ['src/lib/autonomy.ts'];
      case 'session_integrate_merging':
        return { files: ['src/lib/autonomy.ts'], conflicts: [] };
      case 'session_cleanup':
        mockSessions.splice(mockSessions.findIndex((x) => x.id === a.id), 1);
        void emit('sessions-changed', { project: mockSessions[0]?.project ?? `${ROOT}/bitacola` });
        return null;
      case 'session_pause':
        void emit('session', { id: a.id, msg: { type: 'paused', reason: 'pausa manual' } });
        return null;
      case 'session_resume':
        void demoSession(a.id);
        return null;
      case 'session_handoff': {
        const from = mockSessions.find((x) => x.id === a.id);
        const used = mockSessions.filter((x) => x.project === from.project).map((x) => x.name);
        const name = ['laudrup', 'romario', 'koeman', 'rivaldo', 'migueli'].find((n) => !used.includes(n)) ?? 'samitier';
        const to = { ...from, id: nextSession++, engine: a.engine, name, providerSession: '', handoffFrom: from.id, paused: null };
        mockSessions.splice(mockSessions.indexOf(from), 1, to);
        void emit('sessions-changed', { project: from.project, focus: to.id });
        return to;
      }
      case 'session_orphans':
        return rel(a.project) === 'bitacola'
          ? [
              {
                id: 90,
                project: a.project,
                engine: 'opencode',
                name: 'zubizarreta',
                providerSession: 'ses_demo',
                effort: null,
                worktree: '/Users/demo/Library/Application Support/filigranas/worktrees/bitacola/zubizarreta-90',
                branch: 'ide/zubizarreta-90',
                base: 'main',
                baseCommit: '84ab176',
                integrated: null,
                task: 'Encargo del coordinador del proyecto:\n\nAñade reintentos con espera exponencial a la cola.',
                handoffFrom: null,
                paused: null,
              },
            ]
          : [];
      case 'session_reopen':
        return null;
      case 'session_set_option':
        return [{ id: 'model', name: 'Model', category: 'model', currentValue: a.value, options: [{ value: 'opencode/big-pickle', name: 'Big Pickle (gratis)' }, { value: 'openai/gpt-5', name: 'GPT-5' }] }];
      case 'session_close':
        mockSessions.splice(mockSessions.findIndex((x) => x.id === a.id), 1);
        return null;
      case 'coordinator_open':
        return {
          threadId: a.session == null ? 'hilo-demo' : `hilo-demo-${a.session}`,
          model: 'gpt-6-sol',
          models: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['low', 'medium', 'high'] }],
          effort: 'medium',
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          turns: [],
          rateLimits: { primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 9000 }, secondary: { usedPercent: 47, windowDurationMins: 10080, resetsAt: null }, rateLimitReachedType: null },
          activeTurn: null,
        };
      case 'coordinator_send':
        void demoTurn(a.text, a.session);
        return null;
      case 'coordinator_respond':
        pendingApproval?.(a.decision);
        return null;
      case 'codex_pin_model':
      case 'coordinator_interrupt':
        return null;
      case 'codex_rate_limits':
        return { primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 9000 }, secondary: { usedPercent: 47, windowDurationMins: 10080, resetsAt: null }, rateLimitReachedType: null };
      case 'larry_propose':
        return {
          branch: 'main',
          commits: [{ message: 'fix(lib): valida la política antes de encolar', files: ['src/lib/autonomy.ts'] }],
          notes: null,
          fallback: false,
        };
      case 'larry_groups':
        return { branch: 'main', commits: [{ message: 'fix(lib): describe el cambio', files: ['src/lib/autonomy.ts'] }], notes: 'Grupos del script de Filigranas: completa los mensajes.', fallback: true };
      case 'larry_commit':
        return { created: ['9af2c5b fix(lib): valida la política antes de encolar'], stopped: null };
      case 'pr_draft':
        return {
          branch: mockWorks.get(a.path)?.branch ?? 'feat/autonomia',
          head: '9af2c5a462f7618732f102a1f12442411c737cb3',
          repository: 'demo/bitacola',
          bases: ['main', 'develop'],
          base: a.base ?? 'main',
          title: mockWorks.get(a.path)?.objective ?? 'fix(lib): valida la política antes de encolar',
          body: '## Cambios\n\n- fix(lib): valida la política antes de encolar\n\n## Pruebas\n\n- [ ] (describe cómo se ha comprobado)\n',
          commits: ['fix(lib): valida la política antes de encolar'],
          dirty: false,
          existing: null,
          previous: null,
          blocked: null,
          remoteError: null,
          taskId: null,
          larryChecked: true,
          workSession: mockWorks.get(a.path)?.state !== 'finished' ? mockWorks.get(a.path)?.id ?? null : null,
        };
      case 'pr_publish': {
        const work = mockWorks.get(a.path);
        if (work?.state === 'review') { work.state = 'finished'; work.prUrl = 'https://github.com/demo/bitacola/pull/7'; void emit('tasks-changed'); }
        return { number: 7, url: 'https://github.com/demo/bitacola/pull/7', state: 'OPEN', isDraft: a.edit?.draftPr ?? true,
          branch: a.edit?.expectedBranch, base: a.edit?.base ?? 'main', head: a.edit?.expectedHead,
          checks: [2, 0, 1], checksState: 'pending', checksKnown: true, review: null, mergeState: 'BLOCKED', observedAt: Date.now() / 1000 };
      }
      case 'pr_status':
        return { number: 7, url: 'https://github.com/demo/bitacola/pull/7', state: 'OPEN', isDraft: a.edit?.draftPr ?? true,
          branch: 'feat/autonomia', base: a.edit?.base ?? 'main', head: '9af2c5a462f7618732f102a1f12442411c737cb3',
          checks: [2, 0, 1], checksState: 'pending', checksKnown: true, review: null, mergeState: 'BLOCKED', observedAt: Date.now() / 1000 };
      case 'open_pr_url':
        return null;
      case 'brain_graph':
        return mockBrainGraph(a.filter);
      case 'brain_entry':
        return mockBrainEntries.find(e => e.id === a.id && (e.project === a.project || e.global)) ?? fail('Recuerdo no disponible');
      case 'brain_search':
        return mockBrainEntries.filter(e => (e.project === a.project || e.global) && (!a.kind || e.kind === a.kind) && e.title.toLocaleLowerCase().includes(a.query.toLocaleLowerCase()));
      case 'task_parallel_limit':
        return a.limit ?? 2;
      case 'design_save': {
        const scr = a.screen;
        if (scr.id == null) { const id = mockDesign.next++; mockDesign.screens.push({ ...scr, id, project: a.project, revision: 1, approved: null }); return id; }
        const at = mockDesign.screens.findIndex((x) => x.id === scr.id);
        mockDesign.screens[at] = { ...mockDesign.screens[at], name: scr.name, url: scr.url, constraints: scr.constraints, revision: (mockDesign.screens[at].revision ?? 0) + 1 };
        return scr.id;
      }
      case 'tasks_list':
        // kaza queda sin tareas para revisar los estados vacíos
        return rel(a.project) === 'kaza' ? [] : mockTasks();
      case 'task_flow':
        return rel(a.project) === 'kaza' ? { tasks: [], runs: {} } : { tasks: mockTasks(), runs: { 2: mockRuns(2) } };
      case 'task_runs':
        return mockRuns(Number(a.task));
      case 'health_list':
        return rel(a.project) === 'bitacola' && a.session == null ? mockHealth() : [];
      case 'brain_preview':
      case 'health_ci':
        return [];
      case 'design_list':
        return mockDesign.screens.filter((x) => x.project === a.project).map(({ project: _p, ...x }) => x);
      case 'design_shots':
        return mockDesign.shots.filter((x) => x.screen === a.screen).map(({ screen: _s, ...x }) => x).reverse();
      case 'design_components':
        return mockDesign.shots.find((x) => x.id === a.shot && x.screen === a.screen)?.source === 'captura' ? [
          { selector: 'header', name: 'Cabecera', kind: 'header', radius: '0px', x: 0, y: 0, width: 1280, height: 96 },
          { selector: '#acceder', name: 'Acceder', kind: 'button', radius: '8px', x: 480, y: 440, width: 320, height: 52 },
        ] : [];
      case 'design_references':
        return mockDesign.references.filter((x) => x.screen === a.screen);
      case 'design_reference_add': {
        const id = mockDesign.next++;
        mockDesign.references.push({ id, screen: a.screen, name: a.name, mime: 'image/png', data: a.data });
        return id;
      }
      case 'design_reference_remove':
        mockDesign.references = mockDesign.references.filter((x) => x.screen !== a.screen || x.id !== a.reference);
        return null;
      case 'design_image':
        return mockPng(Number(a.shot));
      case 'design_review': {
        const scr = mockDesign.screens.find((x) => x.id === a.screen)!;
        if (scr.revision !== a.review.revision || scr.approved !== a.review.baseline) fail('la referencia o las restricciones cambiaron. Compara de nuevo');
        const shot = mockDesign.shots.find((x) => x.id === a.review.shot)!;
        if (a.review.approve) { if (!a.review.confirmed) fail('confirma la revisión'); shot.status = 'approved'; scr.approved = shot.id; } else shot.status = 'discarded';
        return null;
      }
      case 'design_capture':
      case 'design_import': {
        const id = mockDesign.next++;
        mockDesign.shots.push({ id, screen: a.screen, width: 1280, height: 800, source: cmd === 'design_capture' ? 'captura' : 'importada', url: null, note: a.note ?? '', status: 'candidate', observed: Date.now() });
        return id;
      }
      case 'design_send':
        if (!a.brief.confirmed) fail('confirma el envío');
        return null;
      case 'design_preview':
        return null;
      case 'brain_save': {
        if (!a.confirmed) fail('confirma el contenido y la procedencia del recuerdo');
        const d = a.draft;
        if (d.id != null) {
          const at = mockBrainEntries.findIndex((e) => e.id === d.id);
          if (at < 0 || mockBrainEntries[at].version !== d.version) fail('el recuerdo cambió');
          mockBrainEntries[at] = { ...mockBrainEntries[at], ...d, version: d.version + 1, updated: Math.floor(Date.now() / 1000) };
          return d.id;
        }
        const id = 5000 + mockBrainEntries.length;
        mockBrainEntries.push({ ...d, id, version: 1, project: d.global ? null : a.project, created: Math.floor(Date.now() / 1000), updated: Math.floor(Date.now() / 1000) });
        return id;
      }
      case 'brain_forget': {
        const at = mockBrainEntries.findIndex((e) => e.id === a.id && e.version === a.version);
        if (at < 0) fail('el recuerdo cambió o está fuera de este ámbito');
        mockBrainEntries.splice(at, 1);
        mockLinks.splice(0, mockLinks.length, ...mockLinks.filter((l) => l.from !== a.id && l.to !== a.id));
        return null;
      }
      case 'brain_links':
        return mockLinks.filter((l) => l.project === a.project);
      case 'brain_link_save': {
        if (!a.confirmed) fail('confirma la relación');
        if (a.link.from === a.link.to) fail('un recuerdo no puede relacionarse consigo mismo');
        const id = mockLinks.length + 1;
        mockLinks.push({ ...a.link, id, project: a.project, created: Math.floor(Date.now() / 1000) });
        return id;
      }
      case 'brain_link_remove':
        mockLinks.splice(mockLinks.findIndex((l) => l.id === a.id), 1);
        return null;
      case 'skills_list':
        return mockSkillCatalog.map(({ name, description }) => ({ name, description }));
      case 'skills_assignments':
        return mockSkillCatalog.flatMap(({ name: skill, roles }) => mockSkillRoles.map((role) => {
          const global = mockSkillAssignments.get(JSON.stringify([null, skill, role])) ?? roles.includes(role);
          const local = mockSkillAssignments.get(JSON.stringify([a.project, skill, role]));
          return { skill, role, enabled: local ?? global, inherited: !!a.project && local == null };
        }));
      case 'skills_set_assignment': {
        const key = JSON.stringify([a.project, a.skill, a.role]);
        if (a.enabled == null) mockSkillAssignments.delete(key); else mockSkillAssignments.set(key, a.enabled);
        return null;
      }
      case 'skills_set_session_role': {
        const session = mockSessions.find((item) => item.id === a.session && item.project === a.project);
        if (!session) fail('Sesión desconocida');
        session.skillRole = a.role;
        void emit('sessions-changed', { project: a.project });
        return null;
      }
      case 'health_run':
      case 'health_import':
        return fail('Este flujo necesita la app de escritorio de Filigranas');
      case 'jev_usage':
        return { tokens: 0, costUsd: 0 };
      case 'jev_statusbar':
        return { mode: mockJevSettings.mode, used: 0, limit: 100 };
      case 'jev_status':
        return mockJevStatus();
      case 'jev_configure':
        if (a.change.mode !== 'local') fail('Jev requiere un almacén de credenciales del sistema');
        mockJevSettings = { mode: 'local', policy: a.change.policy, timeoutSecs: a.change.timeoutSecs, model: null, lightModel: null };
        return mockJevStatus();
      case 'tools_status':
        return [
          { id: 'codex', name: 'Codex', role: 'coordinador y Larry', installed: true, loggedIn: true, detail: mockCodexVersion, login: 'codex login' },
          { id: 'claude', name: 'Claude Code', role: 'agente ejecutor', installed: true, loggedIn: true, detail: '2.1.325 (Claude Code)', login: 'claude auth login' },
          { id: 'opencode', name: 'OpenCode', role: 'agente ejecutor', installed: true, loggedIn: false, detail: '0 credentials', login: 'opencode auth login' },
          { id: 'agy', name: 'Antigravity', role: 'agente ejecutor', installed: true, loggedIn: null, detail: '1.5.9', login: 'agy' },
          { id: 'devin', name: 'Devin', role: 'agente ejecutor', installed: false, loggedIn: null, detail: 'no está instalada o no está en el PATH', login: 'devin auth login' },
          { id: 'gh', name: 'GitHub', role: 'publicar ramas y PR', installed: true, loggedIn: mockGithub?.state === 'complete', account: mockGithub?.state === 'complete' ? 'demo' : null, detail: 'gh version 2.101.0', login: null },
          { id: 'node', name: 'Node.js', role: 'agrupar commits (Larry)', installed: true, loggedIn: null, detail: 'v26.0.0', login: null },
        ];
      case 'tools_update': {
        const from = mockCodexVersion;
        mockCodexVersion = 'codex-cli 0.170.0';
        return new Promise((done) => setTimeout(done, 900)).then(() => [
          { id: 'codex', name: 'Codex', outcome: from === mockCodexVersion ? 'current' : 'updated', from, to: mockCodexVersion, detail: from === mockCodexVersion ? from : `${from} → ${mockCodexVersion}` },
          { id: 'claude', name: 'Claude Code', outcome: 'busy', from: '', to: null, detail: 'se actualizará cuando quede libre' },
          { id: 'agy', name: 'Antigravity', outcome: 'current', from: '1.5.9', to: '1.5.9', detail: '1.5.9' },
          { id: 'opencode', name: 'OpenCode', outcome: 'failed', from: '0.9.2', to: '0.9.2', detail: 'EBUSY: resource busy or locked' },
        ]);
      }
      case 'tools_auto_update':
        if (typeof a.enabled === 'boolean') mockCliAuto = a.enabled;
        return mockCliAuto;
      case 'services_list':
        return (mockServices.get(a.project) ?? []).map((service) =>
          ({ ...service, logs: service.id === a.logsFor ? service.logs : null }));
      case 'service_save': {
        const services = mockServices.get(a.project) ?? [];
        const id = a.form.id ?? crypto.randomUUID();
        const existing = services.find((s) => s.id === id);
        if (existing) Object.assign(existing, a.form);
        else services.push({ ...a.form, id, state: 'stopped', pid: null, exitCode: null, logs: null });
        mockServices.set(a.project, services);
        return id;
      }
      case 'service_action': {
        const services = mockServices.get(a.project) ?? [];
        const service = services.find((s) => s.id === a.id);
        if (!service) return fail('Servicio desconocido');
        if (a.action === 'remove') mockServices.set(a.project, services.filter((s) => s.id !== a.id));
        else {
          service.state = a.action === 'stop' ? 'stopped' : 'running';
          service.pid = a.action === 'stop' ? null : Math.floor(Math.random() * 5000) + 100;
          service.logs = a.action === 'stop' ? service.logs : 'Servicio de demostración en marcha.';
        }
        return null;
      }
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
async function demoTurn(text: string, session: number | null) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ev = (method: string, params: object, requestId: unknown = null) =>
    emit('coordinator', { method, params: { threadId: session == null ? 'hilo-demo' : `hilo-demo-${session}`, turnId: 't1', ...params }, requestId });
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
  const cmd = { id: `c${n}`, type: 'commandExecution', command: 'pnpm test -- queue', status: 'inProgress', aggregatedOutput: null, exitCode: null };
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
  await ev('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 48200, cachedInputTokens: 31000, outputTokens: 2400 } } });
  await ev('turn/completed', { turn: { id: 't1', error: null } });
}

const mockStashes: { name: string; subject: string }[] = [{ name: 'stash@{0}', subject: 'On main: prueba de la cola' }];

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
  await ev({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.31, resetsAt: Date.now() / 1000 + 9000 },
    seven_day: { utilization: 0.58, resetsAt: Date.now() / 1000 + 450000 },
  } } });
  await ev({ type: 'result', subtype: 'success', is_error: false, result: '', modelUsage: { 'claude-opus-5-5': { inputTokens: 1200, cacheCreationInputTokens: 9000, cacheReadInputTokens: 64000, outputTokens: 3100 } } });
}

// Atajo de depuración: simular que aparece un repositorio nuevo.
(window as any).__filigranasNuevoRepo = (name: string) => {
  files[`${name}/README.md`] = `# ${name}\n`;
  void emit('workspace-changed');
};

console.info('[filigranas] núcleo simulado activo');

// Tareas de ejemplo solo para el modo navegador (desarrollo y pruebas visuales).
function mockTasks() {
  const now = Date.now();
  const base = { parentId: null, goal: '', criteria: '', risk: 'medio', verification: 'pruebas', tests: null, waitingFor: [] as number[], sessions: [] as unknown[] };
  const t = (id: number, title: string, status: string, priority: string, dependencies: number[], extra: Record<string, unknown> = {}) =>
    ({ ...base, id, title, status, priority, dependencies, createdAt: now - id * 3600e3, updatedAt: now - id * 600e3, ...extra });
  return [
    t(1, 'Esquema de la cola de reintentos', 'done', 'high', [], { goal: 'Tabla y migración de la cola.' }),
    t(2, 'Worker de reintentos con backoff', 'running', 'high', [1], { goal: 'Reintentar envíos con espera exponencial.', criteria: 'Reintenta 5 veces y registra el fallo.', sessions: [{ id: 1, name: 'sesión 1', engine: 'codex', branch: 'ide/reintentos', worktree: null, baseCommit: null, closed: false, github: null }] }),
    t(3, 'Pruebas de la cola', 'waiting_approval', 'normal', [2], { waitingFor: [2] }),
    t(4, 'Panel de estado de envíos', 'ready', 'normal', [1]),
    t(5, 'Migrar alertas al nuevo canal', 'blocked', 'low', [2, 4], { waitingFor: [2, 4] }),
    t(6, 'Documentar la API de reintentos', 'backlog', 'low', [2]),
    t(7, 'Revisión de seguridad del worker', 'review', 'high', [2]),
  ];
}
function mockHealth(): HealthRun[] {
  const observed = Math.floor(Date.now() / 1000);
  return [
    {
      id: 101, task: null, tool: 'git', version: '2.50', source: 'diff --check · árbol de trabajo',
      revision: '84ab176', digest: null, outcome: 'findings', observed,
      findings: [
        { fingerprint: 'example-whitespace', path: 'src/lib/autonomy.ts', line: 11, rule: 'Espacios al final de línea', severity: 'error', previous: false, status: 'open', resolution: '' },
        { fingerprint: 'example-queue', path: 'src/lib/queue.ts', line: 3, rule: 'Cobertura de la cola', severity: 'warning', previous: false, status: 'open', resolution: '' },
      ],
    },
    {
      id: 100, task: null, tool: 'pnpm', version: '11.13.1', source: 'pnpm run test',
      revision: '84ab176', digest: null, outcome: 'passed', observed: observed - 120, findings: [],
    },
  ];
}

function mockRuns(task: number) {
  if (task !== 2) return [];
  return [{ id: 11, sessionId: 1, provider: 'codex', model: 'gpt-6-sol', startedMs: Date.now() - 900e3, durationMs: null, outcome: 'running', retry: false, inputTokens: 18200, cachedInputTokens: 9000, outputTokens: 2100, costEstimateUsd: null, quotaShort: null, quotaLong: null, contextTokens: 41000, memory: [],
    routing: { source: 'jev', reason: 'Cambio acotado con pruebas existentes', effort: 'medio', recommendedEffort: 'medio', confidence: 0.82, model: 'gpt-6-sol', inputTokens: null, outputTokens: null, costEstimateUsd: null, durationMs: null, complexity: 'media', review: null, context: null } }];
}

const mockSkillCatalog = [
  { name: 'implement', description: 'Implementa un encargo con pruebas.', roles: ['senior', 'junior'] },
  { name: 'design-loop', description: 'Bucle de diseño con capturas.', roles: ['designer', 'senior'] },
  { name: 'debug', description: 'Diagnóstico de problemas.', roles: ['senior', 'junior'] },
  { name: 'research', description: 'Investigación y fuentes.', roles: ['pm', 'researcher'] },
  { name: 'code-review', description: 'Revisión de código.', roles: ['auditor', 'auditor2'] },
  { name: 'github-flow', description: 'Flujo de trabajo en GitHub.', roles: ['pm'] },
];
const mockSkillRoles = ['pm', 'researcher', 'designer', 'senior', 'junior', 'auditor', 'auditor2'];
const mockSkillAssignments = new Map<string, boolean>();

const mockDesign = {
  references: [] as { id: number; screen: number; name: string; mime: string; data: string }[],
  next: 10,
  screens: [{ id: 1, project: '/Users/demo/repositorios/calaix', name: 'Inicio de sesión', url: 'http://localhost:5173/login', constraints: '[bloqueo 0,0,100,12] Cabecera y logotipo\nTipografía SF Pro en toda la pantalla', revision: 3, approved: 2 as number | null }] as any[],
  shots: [
    { id: 2, screen: 1, width: 1280, height: 800, source: 'captura', url: 'http://localhost:5173/login', note: 'referencia', status: 'approved', observed: Date.now() - 86400e3 },
    { id: 3, screen: 1, width: 1280, height: 800, source: 'captura', url: 'http://localhost:5173/login', note: 'botón principal más grande', status: 'candidate', observed: Date.now() - 3600e3 },
  ] as any[],
};
function mockPng(seed: number) {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 800;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f5f7'; g.fillRect(0, 0, 1280, 800);
  g.fillStyle = '#1d2330'; g.fillRect(0, 0, 1280, 96);
  g.fillStyle = '#fff'; g.font = '600 30px sans-serif'; g.fillText('calaix', 48, 60);
  g.fillStyle = '#fff'; g.fillRect(440, 200, 400, 380);
  g.strokeStyle = '#d6d9df'; g.strokeRect(440, 200, 400, 380);
  g.fillStyle = '#222'; g.font = '600 26px sans-serif'; g.fillText('Inicia sesión', 480, 260);
  g.fillStyle = '#eceef2'; g.fillRect(480, 300, 320, 44); g.fillRect(480, 360, 320, 44);
  g.fillStyle = seed % 2 ? '#2b5fd9' : '#3a3f4b';
  const h = seed % 2 ? 60 : 44; g.fillRect(480, 440, 320, h);
  return c.toDataURL('image/png').split(',')[1];
}
