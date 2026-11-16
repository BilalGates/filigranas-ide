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
  readText: (path: string) => invoke<string>('read_text', { path }),
  writeText: (path: string, content: string) => invoke<void>('write_text', { path, content }),
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
  watch: (path: string | null) => invoke<void>('watch_project', { path }),
};

// Terminales. La salida llega por el canal que se pasa al abrir.
export type PtyEvent = { kind: 'data'; data: string } | { kind: 'exit' };

export const pty = {
  open: (project: string, cols: number, rows: number, onEvent: Channel<PtyEvent>) =>
    invoke<number>('pty_open', { project, cols, rows, onEvent }),
  write: (id: number, data: string) => invoke<void>('pty_write', { id, data }),
  resize: (id: number, cols: number, rows: number) => invoke<void>('pty_resize', { id, cols, rows }),
  close: (id: number) => invoke<void>('pty_close', { id }),
};
