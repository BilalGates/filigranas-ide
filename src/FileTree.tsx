import { useEffect, useState } from 'react';
import { api, type Entry } from './ipc';

/** Árbol de archivos con carga perezosa: cada carpeta se lee al abrirla. */
export default function FileTree({ root, selected, onOpen }: { root: string; selected: string | null; onOpen: (path: string) => void }) {
  return (
    <div className="tree" role="tree">
      <Dir path={root} depth={0} selected={selected} onOpen={onOpen} />
    </div>
  );
}

function Dir({ path, depth, selected, onOpen }: { path: string; depth: number; selected: string | null; onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.listDir(path).then(
      (e) => alive && setEntries(e),
      (e) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [path]);

  if (error) return <div className="tree-error" style={{ paddingLeft: pad(depth) }}>{error}</div>;
  if (!entries) return null;
  return (
    <>
      {entries.map((e) => (e.dir ? <DirRow key={e.path} entry={e} depth={depth} selected={selected} onOpen={onOpen} /> : <FileRow key={e.path} entry={e} depth={depth} selected={selected} onOpen={onOpen} />))}
    </>
  );
}

function DirRow({ entry, depth, selected, onOpen }: { entry: Entry; depth: number; selected: string | null; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button role="treeitem" aria-expanded={open} className="tree-row is-dir" style={{ paddingLeft: pad(depth) }} onClick={() => setOpen((v) => !v)}>
        {entry.name}/
      </button>
      {open && <Dir path={entry.path} depth={depth + 1} selected={selected} onOpen={onOpen} />}
    </>
  );
}

function FileRow({ entry, depth, selected, onOpen }: { entry: Entry; depth: number; selected: string | null; onOpen: (path: string) => void }) {
  const isSel = entry.path === selected;
  return (
    <button role="treeitem" aria-selected={isSel} className={`tree-row${isSel ? ' is-selected' : ''}`} style={{ paddingLeft: pad(depth) }} onClick={() => onOpen(entry.path)}>
      {entry.name}
    </button>
  );
}

const pad = (depth: number) => `${22 + depth * 12}px`;
