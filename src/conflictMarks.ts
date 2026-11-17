// Bloques de conflicto que deja `git merge-file` (marcas <<<<<<< / ======= /
// >>>>>>>, con base opcional |||||||) y su resolución.

export type Segment = { kind: 'text'; text: string } | { kind: 'conflict'; ours: string; theirs: string; oursLabel: string; theirsLabel: string };
export type Choice = 'ours' | 'theirs' | 'both';

/** Divide el texto en tramos normales y bloques en conflicto. */
export function parse(text: string): Segment[] {
  const lines = text.split(/(?<=\n)/); // conserva los saltos de línea
  const out: Segment[] = [];
  let plain = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('<<<<<<< ') && line.replace(/\r?\n$/, '') !== '<<<<<<<') {
      plain += line;
      i++;
      continue;
    }
    // Buscar el cierre; si no lo hay, no es un bloque.
    const end = lines.findIndex((l, j) => j > i && l.startsWith('>>>>>>>'));
    const mid = lines.findIndex((l, j) => j > i && j < end && l.replace(/\r?\n$/, '') === '=======');
    if (end < 0 || mid < 0) {
      plain += line;
      i++;
      continue;
    }
    const base = lines.findIndex((l, j) => j > i && j < mid && l.startsWith('|||||||'));
    if (plain) out.push({ kind: 'text', text: plain });
    plain = '';
    out.push({
      kind: 'conflict',
      ours: lines.slice(i + 1, base >= 0 ? base : mid).join(''),
      theirs: lines.slice(mid + 1, end).join(''),
      oursLabel: line.slice(8).trim() || 'proyecto',
      theirsLabel: lines[end].slice(8).trim() || 'sesión',
    });
    i = end + 1;
  }
  if (plain) out.push({ kind: 'text', text: plain });
  return out;
}

/** Texto con el bloque `index` (entre los conflictos) resuelto. */
export function resolve(segments: Segment[], index: number, choice: Choice): string {
  let n = -1;
  return segments
    .map((s) => {
      if (s.kind === 'text') return s.text;
      n++;
      if (n !== index) return `<<<<<<< ${s.oursLabel}\n${s.ours}=======\n${s.theirs}>>>>>>> ${s.theirsLabel}\n`;
      return choice === 'ours' ? s.ours : choice === 'theirs' ? s.theirs : s.ours + s.theirs;
    })
    .join('');
}

export const conflictCount = (segments: Segment[]) => segments.filter((s) => s.kind === 'conflict').length;
