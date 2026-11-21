import { useState } from 'react';
import { shortcut } from '../ui';
import { Icon } from './icons';

export type Dest = 'inicio' | 'workspace' | 'flow' | 'studio' | 'entrega' | 'brain' | 'ajustes';
export const DESTS: { id: Dest; label: string; icon: string; keys: string }[] = [
  { id: 'inicio', label: 'Inicio', icon: 'home', keys: '⌘⇧1' },
  { id: 'workspace', label: 'Workspace', icon: 'workspace', keys: '⌘⇧2' },
  { id: 'flow', label: 'Flow', icon: 'flow', keys: '⌘⇧3' },
  { id: 'studio', label: 'Studio', icon: 'studio', keys: '⌘⇧4' },
  { id: 'entrega', label: 'Entrega', icon: 'review', keys: '⌘⇧5' },
  { id: 'brain', label: 'Brain', icon: 'brain', keys: '⌘⇧6' },
  { id: 'ajustes', label: 'Ajustes', icon: 'settings', keys: '⌘,' },
];

const KEY = 'filigranas.destino';
export function loadDest(): Dest {
  try {
    const v = localStorage.getItem(KEY) as Dest | null;
    return v && DESTS.some((d) => d.id === v) ? v : 'inicio';
  } catch {
    return 'inicio';
  }
}
export function saveDest(d: Dest) {
  try { localStorage.setItem(KEY, d); } catch { /* sin almacenamiento */ }
}

/** Último punto de trabajo, para «Retomar». Solo guarda lo que existe. */
export type Resume = { project: string; view: 'coach' | 'work' | number; dest: Dest; at: number };
const RESUME = 'filigranas.retomar';
export function loadResume(): Resume | null {
  try { return JSON.parse(localStorage.getItem(RESUME) ?? 'null'); } catch { return null; }
}
export function saveResume(r: Resume) {
  try { localStorage.setItem(RESUME, JSON.stringify(r)); } catch { /* sin almacenamiento */ }
}

/** Columna de destinos. `badges`: recuento real de lo que necesita atención. */
export function DestNav({ dest, onDest, badges, live }: {
  dest: Dest;
  onDest: (d: Dest) => void;
  badges: Partial<Record<Dest, number>>;
  live: Partial<Record<Dest, boolean>>;
}) {
  const [tip, setTip] = useState<{ label: string; keys: string; x: number; y: number } | null>(null);
  const show = (e: { currentTarget: HTMLElement }, label: string, keys: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ label, keys, x: r.right + 10, y: r.top + r.height / 2 - 13 });
  };
  const button = (d: (typeof DESTS)[number]) => (
    <button key={d.id} className="tr-nb" aria-current={dest === d.id ? 'page' : undefined} aria-label={`${d.label} (${shortcut(d.keys)})`}
      onClick={() => onDest(d.id)} onMouseEnter={(e) => show(e, d.label, d.keys)} onMouseLeave={() => setTip(null)}
      onFocus={(e) => show(e, d.label, d.keys)} onBlur={() => setTip(null)}>
      <Icon name={d.icon} size={19} />
      {!!badges[d.id] && <span className="cnt" aria-label={`${badges[d.id]} pendientes`}>{badges[d.id]}</span>}
      {live[d.id] && !badges[d.id] && <span className="live" aria-hidden="true" />}
    </button>
  );
  return (
    <nav className="tr-nav" aria-label="Destinos">
      {DESTS.slice(0, -1).map(button)}
      <span className="sp" />
      {button(DESTS[DESTS.length - 1])}
      {tip && <div className="tr-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">{tip.label}<kbd>{shortcut(tip.keys)}</kbd></div>}
    </nav>
  );
}
