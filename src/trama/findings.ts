import type { HealthFinding, HealthRun } from '../ipc';

/** Hallazgo con los revisores que lo señalan en la misma importación. */
export type ReviewNote = HealthFinding & { who?: string[] };

const SEVERITY: Record<string, number> = { error: 0, warning: 1 };

/** Hallazgos abiertos de la última importación. Un mismo informe SARIF puede
 * traer una ejecución por revisor: se agrupan por archivo, línea y regla y se
 * conserva quién los señala. */
export function openFindings(runs: HealthRun[] | null): ReviewNote[] {
  const last = runs?.[0];
  if (!last) return [];
  const batch = last.digest?.split(':')[0];
  const latest = batch && last.digest?.includes(':') ? runs!.filter((run) => run.digest?.split(':')[0] === batch) : [last];
  const merged = new Map<string, ReviewNote>();
  for (const run of [...latest].reverse()) for (const item of run.findings) {
    if (item.status !== 'open') continue;
    const key = JSON.stringify([item.path, item.line, item.rule]);
    const seen = merged.get(key);
    if (!seen) merged.set(key, { ...item, who: [run.tool] });
    else {
      if (!seen.who!.includes(run.tool)) seen.who!.push(run.tool);
      if ((SEVERITY[item.severity] ?? 2) < (SEVERITY[seen.severity] ?? 2)) seen.severity = item.severity;
      seen.title ??= item.title;
    }
  }
  return [...merged.values()].sort((a, b) => (SEVERITY[a.severity] ?? 2) - (SEVERITY[b.severity] ?? 2)
    || ((a.path ?? '') < (b.path ?? '') ? -1 : (a.path ?? '') > (b.path ?? '') ? 1 : 0) || (a.line ?? 0) - (b.line ?? 0));
}
