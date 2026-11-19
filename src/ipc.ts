import { invoke, type Channel } from '@tauri-apps/api/core';

// Contrato tipado con el núcleo en Rust (src-tauri/src). La interfaz no
// accede al sistema de archivos ni ejecuta comandos por su cuenta.

export type Group = { id: number; name: string };
export type Project = { name: string; path: string; groupId: number | null; archived: boolean };
export type Workspace = { root: string | null; groups: Group[]; projects: Project[] };
export type Entry = { name: string; path: string; dir: boolean };

export const api = {
  workspace: () => invoke<Workspace>('get_workspace'),
  defaultRoot: () => invoke<string>('default_root'),
  setRoot: (path: string) => invoke<Workspace>('set_root', { path }),
  createProject: (name: string) => invoke<Workspace>('create_project', { name }),
  createGroup: (name: string) => invoke<Workspace>('create_group', { name }),
  renameGroup: (id: number, name: string) => invoke<Workspace>('rename_group', { id, name }),
  deleteGroup: (id: number) => invoke<Workspace>('delete_group', { id }),
  moveProject: (path: string, groupId: number | null) => invoke<Workspace>('move_project', { path, groupId }),
  setArchived: (path: string, archived: boolean) => invoke<Workspace>('set_archived', { path, archived }),
  listDir: (path: string) => invoke<Entry[]>('list_dir', { path }),
  // `session`: archivo del worktree de una sesión aislada.
  readText: (path: string, session: number | null = null) => invoke<string>('read_text', { path, session }),
  writeText: (path: string, content: string, session: number | null = null) => invoke<void>('write_text', { path, content, session }),
};

// Git (solo lectura). `project` es la ruta del proyecto; `path`, relativa a él.
export type Change = { path: string; orig: string | null; status: string; adds: number | null; dels: number | null };
export type GitStatus = { branch: string | null; head: string | null; upstream: string | null; ahead: number; behind: number; changes: Change[] };
export type LogRow = { hash: string; parents: string[]; refs: string; subject: string; author: string; date: string };
export type DiffTexts = { old: string; new: string };

export const git = {
  status: (project: string) => invoke<GitStatus>('git_status', { project }),
  log: (project: string) => invoke<LogRow[]>('git_log', { project }),
  diffTexts: (project: string, path: string, orig: string | null) => invoke<DiffTexts>('git_diff_texts', { project, path, orig }),
  branches: (project: string) => invoke<string[]>('git_branches', { project }),
  switch: (project: string, branch: string) => invoke<void>('git_switch', { project, branch }),
  watch: (path: string | null, session: number | null) => invoke<void>('watch_project', { path, session }),
};

// Acciones de git que cambian el repositorio o hablan con el remoto. Cada
// una devuelve el texto que imprime git, para mostrarlo tal cual.
export type Stash = { name: string; subject: string };
export const gitOps = {
  fetch: (project: string) => invoke<string>('git_fetch', { project }),
  pull: (project: string) => invoke<string>('git_pull', { project }),
  reviewPush: (project: string, setUpstream: boolean) => invoke<Review>('git_review_push', { project, setUpstream }),
  push: (project: string, setUpstream: boolean, proof: Proof) => invoke<string>('git_push', { project, setUpstream, proof }),
  stash: (project: string, message: string | null) => invoke<string>('git_stash', { project, message }),
  stashPop: (project: string) => invoke<string>('git_stash_pop', { project }),
  stashList: (project: string) => invoke<Stash[]>('git_stash_list', { project }),
  undoCommit: (project: string) => invoke<string>('git_undo_commit', { project }),
  detail: (project: string, hash: string) => invoke<CommitDetail>('git_commit_detail', { project, hash }),
};
export type CommitDetail = { hash: string; author: string; date: string; body: string; files: { status: string; path: string; adds: number | null; dels: number | null }[] };

// Terminales. La salida llega por el canal que se pasa al abrir.
export type PtyEvent = { kind: 'data'; data: string } | { kind: 'exit' };

export const pty = {
  open: (project: string, session: number | null, cols: number, rows: number, onEvent: Channel<PtyEvent>) =>
    invoke<number>('pty_open', { project, session, cols, rows, onEvent }),
  write: (id: number, data: string) => invoke<void>('pty_write', { id, data }),
  resize: (id: number, cols: number, rows: number) => invoke<void>('pty_resize', { id, cols, rows }),
  close: (id: number) => invoke<void>('pty_close', { id }),
};

// Coordinador (Codex app-server). Tipos reducidos a lo que se pinta.
export type CItem = {
  id: string;
  type: string;
  text?: string;
  content?: { type: string; text?: string }[];
  summary?: string[];
  command?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: { path: string; kind: { type: string } }[];
  server?: string;
  tool?: string;
  // Herramientas dinámicas del IDE (delegar, estado_sesiones, esperar_sesion).
  arguments?: any;
  contentItems?: { type: string; text?: string }[] | null;
  success?: boolean | null;
  /** Quién firma la respuesta, si se sabe (p. ej. el perfil de Hansi al escribirla). */
  by?: string;
};
export type CTurn = { id: string; items: CItem[]; status: string; error: { message: string } | null };
export type RateWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
export type RateLimits = { primary: RateWindow | null; secondary: RateWindow | null; rateLimitReachedType: string | null };
export type Opened = {
  threadId: string;
  profile: string;
  model: string | null;
  effort: string | null;
  efforts: string[];
  turns: CTurn[];
  rateLimits: RateLimits | null;
  activeTurn: string | null;
  models?: { id: string; label: string; efforts: string[] }[];
  pinnedModel?: string | null;
};
export type CoordinatorEvent = { method: string; params: any; requestId: unknown | null };
export type Decision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export const coordinator = {
  open: (project: string, session: number | null = null) => invoke<Opened>('coordinator_open', { project, session }),
  send: (project: string, text: string, effort: string | null, session: number | null, task: number | null) => invoke<void>('coordinator_send', { project, text, effort, session, task }),
  interrupt: (project: string, session: number | null) => invoke<void>('coordinator_interrupt', { project, session }),
  respond: (requestId: unknown, decision: Decision) => invoke<void>('coordinator_respond', { requestId, decision }),
  setProfile: (project: string, profile: string) => invoke<void>('coordinator_set_profile', { project, profile }),
  pinModel: (project: string, session: number, model: string | null) => invoke<void>('codex_pin_model', { project, session, model }),
};

// Sesiones de agentes ejecutores (Claude Code en este tramo). Los mensajes
// llegan tal como los emite el motor; Session.tsx los traduce.
export type Session = {
  id: number;
  project: string;
  engine: string;
  name: string;
  providerSession: string;
  effort: string | null;
  // Aislamiento: rama y worktree propios (null si trabaja en el proyecto).
  worktree: string | null;
  branch: string | null;
  base: string | null;
  baseCommit: string | null;
  integrated: string | null;
  // Continuidad: primer encargo, sesión de la que viene y motivo de pausa.
  task: string | null;
  handoffFrom: number | null;
  paused: string | null;
};
export type CreatedSession = Session & { notice: string | null };
/** Archivo a comparar: del proyecto, o de una sesión aislada. */
export type DiffTarget = Change & { session?: number; label?: string };
export type SessionEvent = { id: number; msg: any };
/** Opción editable de un agente ACP (modelo o nivel de razonamiento). */
export type AcpOption = { id: string; name: string; category: string; currentValue: string; options: { value: string; name: string }[] };

export const sessions = {
  list: (project: string) => invoke<Session[]>('session_list', { project }),
  create: (project: string, engine: string, task: number | null = null) => invoke<CreatedSession>('session_create', { project, engine, task }),
  history: (id: number) => invoke<any[]>('session_history', { id }),
  send: (id: number, text: string, effort: string | null) => invoke<void>('session_send', { id, text, effort }),
  interrupt: (id: number) => invoke<void>('session_interrupt', { id }),
  respond: (requestId: string, decision: Decision) => invoke<void>('session_respond', { requestId, decision }),
  close: (id: number) => invoke<void>('session_close', { id }),
  changes: (id: number) => invoke<GitStatus>('session_changes', { id }),
  diffTexts: (id: number, path: string, orig: string | null) => invoke<DiffTexts>('session_diff_texts', { id, path, orig }),
  integrate: (id: number) => invoke<string[]>('session_integrate', { id }),
  integrateMerging: (id: number) => invoke<{ files: string[]; conflicts: string[] }>('session_integrate_merging', { id }),
  cleanup: (id: number) => invoke<void>('session_cleanup', { id }),
  pause: (id: number) => invoke<void>('session_pause', { id }),
  setOption: (id: number, key: string, value: string) => invoke<AcpOption[]>('session_set_option', { id, key, value }),
  claudeOptions: (id: number) => invoke<{ models: { id: string; label: string }[]; pinnedModel: string | null }>('claude_chat_options', { id }),
  orphans: (project: string) => invoke<Session[]>('session_orphans', { project }),
  reopen: (id: number) => invoke<Session>('session_reopen', { id }),
  resume: (id: number) => invoke<void>('session_resume', { id }),
  handoff: (id: number, engine: string) => invoke<Session>('session_handoff', { id, engine }),
};

export type TaskEdit = {
  id: number | null;
  parentId: number | null;
  title: string;
  goal: string;
  criteria: string;
  priority: string;
  risk: string;
  status: string;
  verification: string;
  tests: string | null;
  dependencies: number[];
};
export type Task = Omit<TaskEdit, 'id'> & {
  id: number;
  createdAt: number;
  updatedAt: number;
  waitingFor: number[];
  sessions: (Pick<Session, 'id' | 'name' | 'engine' | 'branch' | 'worktree' | 'baseCommit'> & {
    closed: boolean;
    github: { commits: { oid: string; subject: string }[]; pulls: PrInfo[] } | null;
  })[];
};
export type TaskRun = {
  id: number;
  sessionId: number | null;
  provider: string;
  model: string | null;
  startedMs: number;
  durationMs: number | null;
  outcome: string;
  retry: boolean;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costEstimateUsd: number | null;
  quotaShort: [number, number] | null;
  quotaLong: [number, number] | null;
  contextTokens: number | null;
  memory: BrainReference[];
  routing: {
    source: 'local' | 'shadow' | 'jev';
    reason: string | null;
    effort: string | null;
    recommendedEffort: string | null;
    confidence: number | null;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costEstimateUsd: number | null;
    durationMs: number | null;
    complexity: string | null;
    review: string | null;
    context: string | null;
    eventAdvice: string | null;
    executionModel: string | null;
  } | null;
};
export type JevSettings = {
  mode: 'local' | 'active' | 'shadow';
  policy: 'economy' | 'balanced' | 'quality';
  timeoutSecs: number;
  model: string | null;
  lightModel: string | null;
};
export type JevStatus = { settings: JevSettings; supported: boolean; service: string; account: string; codexModels: string[] };
export const jev = {
  status: () => invoke<JevStatus>('jev_status'),
  configure: (change: Omit<JevSettings, 'model'> & { consent: boolean }) => invoke<JevStatus>('jev_configure', { change }),
};
export const tasks = {
  list: (project: string) => invoke<Task[]>('tasks_list', { project }),
  save: (project: string, input: TaskEdit) => invoke<number>('task_save', { project, input }),
  link: (project: string, task: number, session: number) => invoke<void>('task_link', { project, task, session }),
  runs: (project: string, task: number) => invoke<TaskRun[]>('task_runs', { project, task }),
  parallelLimit: (project: string, limit: number | null = null) => invoke<number>('task_parallel_limit', { project, limit }),
};

// Larry: propuesta y creación de commits locales.
export type LarryCommit = { message: string; files: string[] };
export type LarryPlan = { branch: string; commits: LarryCommit[]; notes: string | null; fallback: boolean };
export type LarryOutcome = { created: string[]; stopped: string | null };

export const larry = {
  propose: (project: string, session: number | null) => invoke<LarryPlan>('larry_propose', { project, session }),
  groups: (project: string, session: number | null) => invoke<LarryPlan>('larry_groups', { project, session }),
  commit: (project: string, session: number | null, commits: LarryCommit[]) => invoke<LarryOutcome>('larry_commit', { project, session, commits }),
};

// Publicar la rama y abrir la PR (gh). Siempre por acción explícita.
export type PrInfo = {
  number: number; url: string; state: string; isDraft: boolean; branch: string; base: string; head: string;
  checks: [number, number, number]; checksState: 'success' | 'pending' | 'failure' | 'unknown';
  checksKnown: boolean;
  review: string | null; mergeState: string; observedAt: number;
};
export type PrDraft = {
  branch: string;
  head: string;
  repository: string | null;
  bases: string[];
  base: string;
  title: string;
  body: string;
  commits: string[];
  dirty: boolean;
  existing: PrInfo | null;
  previous: PrInfo | null;
  blocked: string | null;
  remoteError: string | null;
  taskId: number | null;
  larryChecked: boolean;
};

export type Review = { id: string; message: string; code: string };
export type Proof = { id: string; typed: string };
export const cancelReview = (id: string) => invoke<void>('cancel_review', { id });

const publicationEdit = (draft: PrDraft, title: string, body: string, draftPr: boolean) => ({
  expectedBranch: draft.branch, expectedHead: draft.head, expectedRepository: draft.repository, base: draft.base, title, body, draftPr,
});
const mergeEdit = (pull: PrInfo, method: string) => ({ number: pull.number, head: pull.head, base: pull.base, method });

export const pr = {
  draft: (path: string, session: number | null, base: string | null) => invoke<PrDraft>('pr_draft', { path, session, base }),
  reviewPublish: (path: string, session: number | null, draft: PrDraft, title: string, body: string, draftPr: boolean) =>
    invoke<Review>('pr_review_publish', { path, session, edit: publicationEdit(draft, title, body, draftPr) }),
  publish: (path: string, session: number | null, draft: PrDraft, title: string, body: string, draftPr: boolean, proof: Proof) =>
    invoke<PrInfo>('pr_publish', { path, session, edit: publicationEdit(draft, title, body, draftPr), proof }),
  reviewMerge: (path: string, session: number | null, pull: PrInfo, method: string) =>
    invoke<Review>('pr_review_merge', { path, session, edit: mergeEdit(pull, method) }),
  merge: (path: string, session: number | null, pull: PrInfo, method: string, proof: Proof) =>
    invoke<PrInfo>('pr_merge', { path, session, edit: mergeEdit(pull, method), proof }),
  open: (url: string) => invoke<void>('open_pr_url', { url }),
  status: (path: string, session: number | null, number: number) => invoke<PrInfo>('pr_status', { path, session, number }),
};

// Herramientas externas que usa el IDE.
export type Tool = { id: string; name: string; role: string; installed: boolean; loggedIn: boolean | null; detail: string; login: string | null };
export const tools = { status: () => invoke<Tool[]>('tools_status') };

// Contenedores Docker del proyecto (solo lectura).
export type Container = { id: string; name: string; image: string; state: string; health: string | null; ports: string[]; service: string | null };
export type ContainersView = {
  status: 'ok' | 'absent' | 'stopped' | 'denied' | 'error';
  message: string | null;
  compose: Container[];
  linked: Container[];
  unlinked: Container[];
};
export const containers = {
  list: (project: string) => invoke<ContainersView>('containers_list', { project }),
  link: (project: string, id: string, name: string) => invoke<void>('container_link', { project, id, name }),
  unlink: (id: string) => invoke<void>('container_unlink', { id }),
};

export type HealthFinding = {
  fingerprint: string; path: string | null; line: number | null; rule: string; severity: string;
  previous: boolean; status: string; resolution: string;
};
export type HealthRun = {
  id: number; task: number | null; tool: string; version: string | null; source: string; revision: string | null;
  digest: string | null; outcome: string; observed: number; findings: HealthFinding[];
};
export type HealthCheck = 'diff' | 'build' | 'typecheck' | 'lint' | 'test' | 'cargo_check' | 'cargo_test' | 'cargo_clippy';
export const health = {
  list: (project: string, session: number | null) => invoke<HealthRun[]>('health_list', { project, session }),
  file: (project: string, session: number | null, path: string) => invoke<string>('health_file', { project, session, path }),
  ci: (project: string, session: number | null) => invoke<PrInfo[]>('health_ci', { project, session }),
  run: (project: string, session: number | null, check: HealthCheck) => invoke<void>('health_run', { project, session, check }),
  import: (project: string, session: number | null, report: string) => invoke<void>('health_import', { project, session, report }),
  resolve: (project: string, session: number | null, run: number, fingerprint: string, status: string, resolution: string) =>
    invoke<void>('health_resolve', { project, session, run, fingerprint, status, resolution }),
};

export type DesignScreen = { id: number | null; name: string; url: string; constraints: string; revision: number | null; approved: number | null };
export type DesignShot = { id: number; width: number; height: number; source: string; url: string | null; note: string; status: string; observed: number };
export type DesignRegion = { x: number; y: number; width: number; height: number };
export const design = {
  list: (project: string) => invoke<DesignScreen[]>('design_list', { project }),
  save: (project: string, screen: DesignScreen) => invoke<number>('design_save', { project, screen }),
  shots: (project: string, screen: number) => invoke<DesignShot[]>('design_shots', { project, screen }),
  image: (project: string, screen: number, shot: number) => invoke<string>('design_image', { project, screen, shot }),
  preview: (project: string, screen: number) => invoke<void>('design_preview', { project, screen }),
  capture: (project: string, screen: number, width: number, height: number, note: string) =>
    invoke<number>('design_capture', { project, screen, width, height, note }),
  import: (project: string, screen: number, png: string, note: string) => invoke<number>('design_import', { project, screen, png, note }),
  review: (project: string, screen: number, review: { shot: number; baseline: number | null; revision: number; approve: boolean; confirmed: boolean }) =>
    invoke<void>('design_review', { project, screen, review }),
  send: (project: string, brief: { session: number; screen: number; shot: number; region: DesignRegion; request: string; compare: boolean; confirmed: boolean }) =>
    invoke<void>('design_send', { project, brief }),
};

export type BrainKind = 'fact' | 'decision' | 'preference' | 'constraint' | 'evidence' | 'outcome';
export type BrainDraft = {
  id: number | null; version: number | null; global: boolean; task: number | null; kind: BrainKind;
  title: string; body: string; source: string; sourceTask: number | null; sourceRun: number | null;
  share: boolean; validUntil: number | null;
};
export type BrainEntry = BrainDraft & { created: number; updated: number };
export type BrainNodeKind = BrainKind | 'task' | 'pr';
export type BrainNode = { key: string; kind: BrainNodeKind; title: string; date: number; id: number; url: string | null; matched: boolean };
export type BrainEdge = { from: string; to: string; kind: 'scope' | 'task_source' | 'run_source' | 'pull_source' | 'parent' | 'dependency' | 'pull' };
export type BrainGraphData = { nodes: BrainNode[]; edges: BrainEdge[]; limited: boolean };
export type BrainGraphFilter = { project: string | null; kind: BrainNodeKind | null; from: number | null; until: number | null };
export type BrainReference = { id: number; version: number; source: string };
export const brain = {
  graph: (filter: BrainGraphFilter) => invoke<BrainGraphData>('brain_graph', { filter }),
  entry: (project: string, id: number) => invoke<BrainEntry>('brain_entry', { project, id }),
  search: (project: string, query: string, kind: BrainKind | null) => invoke<BrainEntry[]>('brain_search', { project, query, kind }),
  preview: (project: string, task: number, query: string) => invoke<BrainEntry[]>('brain_preview', { project, task, query }),
  save: (project: string, draft: BrainDraft, confirmed: boolean) => invoke<number>('brain_save', { project, draft, confirmed }),
  forget: (project: string, id: number, version: number) => invoke<void>('brain_forget', { project, id, version }),
};
