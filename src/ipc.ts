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
export type LogRow = { hash: string; parents: string[]; refs: string; subject: string };
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
  push: (project: string, setUpstream: boolean) => invoke<string>('git_push', { project, setUpstream }),
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
};
export type CoordinatorEvent = { method: string; params: any; requestId: unknown | null };
export type Decision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export const coordinator = {
  open: (project: string) => invoke<Opened>('coordinator_open', { project }),
  send: (project: string, text: string, effort: string | null) => invoke<void>('coordinator_send', { project, text, effort }),
  interrupt: (project: string) => invoke<void>('coordinator_interrupt', { project }),
  respond: (requestId: unknown, decision: Decision) => invoke<void>('coordinator_respond', { requestId, decision }),
  setProfile: (project: string, profile: string) => invoke<void>('coordinator_set_profile', { project, profile }),
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
  create: (project: string, engine: string) => invoke<CreatedSession>('session_create', { project, engine }),
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
  orphans: (project: string) => invoke<Session[]>('session_orphans', { project }),
  reopen: (id: number) => invoke<Session>('session_reopen', { id }),
  resume: (id: number) => invoke<void>('session_resume', { id }),
  handoff: (id: number, engine: string) => invoke<Session>('session_handoff', { id, engine }),
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
export type PrInfo = { url: string; state: string; isDraft: boolean; checks: [number, number, number] };
export type PrDraft = {
  branch: string;
  bases: string[];
  base: string;
  title: string;
  body: string;
  commits: string[];
  dirty: boolean;
  existing: PrInfo | null;
  previous: PrInfo | null;
  blocked: string | null;
};

export const pr = {
  draft: (project: string, session: number | null, base: string | null) => invoke<PrDraft>('pr_draft', { project, session, base }),
  publish: (project: string, session: number | null, base: string, title: string, body: string, draftPr: boolean) =>
    invoke<PrInfo>('pr_publish', { project, session, base, title, body, draftPr }),
  open: (url: string) => invoke<void>('open_pr_url', { url }),
  status: (project: string, session: number | null) => invoke<PrInfo | null>('pr_status', { project, session }),
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
