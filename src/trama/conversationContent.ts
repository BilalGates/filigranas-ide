/** Reconoce cadenas horizontales de Mermaid y conserva el bloque original para el resto. */
export function readArchitecture(source: string) {
  const lines = source.trim().split(/\r?\n/);
  if (lines.length < 2 || lines.length > 7 || !/^(?:flowchart|graph) LR$/.test(lines.shift()?.trim() ?? '')) return null;
  const title = lines[0].trim().match(/^accTitle:\s*(.{1,90})$/)?.[1];
  if (title) lines.shift();
  if (!lines.length || lines.length > 5) return null;
  const nodes: { id: string; label: string; detail: string }[] = [];
  const edges: string[] = [];
  const end = /^(\w+)(?:\["([^"\r\n]{1,75})"\])?$/;
  const insert = (id: string, label: string | undefined) => {
    const [title, detail = ''] = (label ?? id).split(/<br\s*\/?>/i, 2);
    nodes.push({ id, label: title, detail });
  };
  for (const line of lines) {
    const edge = line.trim().match(/^(.+?)\s*-->\s*(?:\|([^|]{1,50})\|\s*)?(.+)$/);
    if (!edge) return null;
    const from = end.exec(edge[1]), to = end.exec(edge[3]);
    if (!from || !to || nodes.some((node) => node.id === to[1])) return null;
    const previous = nodes.at(-1);
    if (previous && (previous.id !== from[1] || from[2])) return null;
    if (!previous) insert(from[1], from[2]);
    if (from[1] === to[1]) return null;
    insert(to[1], to[2]);
    edges.push(edge[2] ?? '');
  }
  return { nodes, edges, title };
}

export function readDiffPreview(patch: string | undefined) {
  if (!patch || patch.length > 160_000) return null;
  const lines: { kind: 'add' | 'del'; text: string }[] = [];
  let adds = 0, dels = 0, inHunk = false, firstBlock = true;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      if (lines.length) firstBlock = false;
    } else if (line.startsWith('diff --git ')) {
      inHunk = false;
    } else if (inHunk && (line[0] === '+' || line[0] === '-')) {
      const kind = line[0] === '+' ? 'add' : 'del';
      if (kind === 'add') adds++;
      else dels++;
      if (firstBlock && lines.length < 6) lines.push({ kind, text: line.slice(1) });
    } else if (lines.length && line[0] === ' ') {
      firstBlock = false;
    }
  }
  return lines.length ? { adds, dels, lines } : null;
}
