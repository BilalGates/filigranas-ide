import { useEffect, useState } from 'react';
import { capabilities, type CapabilityUsage } from '../ipc';
import { STATE_NAMES } from './capabilityLabels';

/** Capacidades registradas por ejecución, para la línea temporal de Flow. */
export function useRunCapabilities(runIds: number[]) {
  const [map, setMap] = useState(new Map<number, CapabilityUsage[]>());
  const key = runIds.join(',');
  useEffect(() => {
    if (!key) { setMap(new Map()); return; }
    let alive = true;
    capabilities.runs(key.split(',').map(Number)).then((items) => {
      if (!alive) return;
      const next = new Map<number, CapabilityUsage[]>();
      for (const u of items) next.set(u.runId, [...(next.get(u.runId) ?? []), u]);
      setMap(next);
    }, () => {});
    return () => { alive = false; };
  }, [key]);
  return map;
}

const relevant = (list: CapabilityUsage[] | undefined) => (list ?? []).filter((u) => u.state !== 'skipped');

export function capTitle(list: CapabilityUsage[] | undefined) {
  const items = relevant(list);
  return items.length ? `\nCapacidades: ${items.map((u) => `${u.name} (${STATE_NAMES[u.state].toLowerCase()})`).join(', ')}` : '';
}
