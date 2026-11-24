import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Ask } from '../Conversation';

type Shared = { project: string; requests: Ask[] };
const empty: Shared[] = [];
let pending = empty;
const observers = new Set<() => void>();
const sources = new Map<number, Shared>();

function publish(session: number, state: Shared | undefined) {
  if (state) sources.set(session, state);
  else if (!sources.delete(session)) return;
  pending = [...sources.values()];
  observers.forEach((observe) => observe());
}

const subscribe = (observe: () => void) => {
  observers.add(observe);
  return () => { observers.delete(observe); };
};

export function useSharedPermissions(project: string, session: number | null, agent: string, root: string, asks: Ask[]) {
  const claimed = useRef(new Set<string>());
  const requests = session == null ? asks : asks.map((ask) => ({
    ...ask,
    decide: (decision: Parameters<Ask['decide']>[0]) => {
      if (claimed.current.has(ask.key)) return;
      claimed.current.add(ask.key);
      ask.decide(decision);
    },
  }));
  useEffect(() => {
    if (session == null) return;
    const active = new Set(asks.map((ask) => ask.key));
    claimed.current.forEach((key) => { if (!active.has(key)) claimed.current.delete(key); });
    publish(session, requests.length ? {
      project,
      requests: requests.map((ask) => ({
        ...ask, key: `${session}:${ask.key}`, agent, root,
      })),
    } : undefined);
  }, [project, session, agent, root, asks, requests]);
  useEffect(() => () => { if (session != null) publish(session, undefined); }, [session]);
  return requests;
}

export function useDelegatedPermissions(project: string, enabled: boolean) {
  const snapshot = useSyncExternalStore(subscribe, () => enabled ? pending : empty);
  return snapshot.flatMap((entry) => entry.project === project ? entry.requests : []);
}
