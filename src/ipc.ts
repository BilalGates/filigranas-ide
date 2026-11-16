import { invoke } from '@tauri-apps/api/core';

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
