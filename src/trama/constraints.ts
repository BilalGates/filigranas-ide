// Bloqueos de Studio serializados en las restricciones de la pantalla.
export type Region = { x: number; y: number; width: number; height: number };
export type Lock = { region: Region; text: string };
const LOCK = /^\[bloqueo ([\d.]+),([\d.]+),([\d.]+),([\d.]+)\]\s*(.*)$/;

export function parseConstraints(text: string) {
  const locks: Lock[] = [];
  const rest: string[] = [];
  for (const line of text.split('\n')) {
    const m = LOCK.exec(line.trim());
    if (m) locks.push({ region: { x: +m[1], y: +m[2], width: +m[3], height: +m[4] }, text: m[5] });
    else if (line.trim()) rest.push(line);
  }
  return { locks, rest: rest.join('\n') };
}
export function joinConstraints(locks: Lock[], rest: string) {
  const r = (n: number) => Math.round(n * 10) / 10;
  return [...locks.map((l) => `[bloqueo ${r(l.region.x)},${r(l.region.y)},${r(l.region.width)},${r(l.region.height)}] ${l.text.trim()}`), rest.trim()].filter(Boolean).join('\n');
}
