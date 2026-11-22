import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Session } from '../ipc';
import { useUi } from '../ui';
import { Icon } from './icons';
import { useMotion } from './motion';

// Piezas comunes de Trama v2 portadas del Artifact (marcado y clases iguales,
// datos reales). Los estilos viven en artifact.css (ámbito .tv).

export type AgState = 'working' | 'thinking' | 'waiting' | 'idle' | 'done' | 'paused' | 'blocked';
export const STATE_LABEL: Record<AgState, string> = { working: 'trabajando', thinking: 'pensando', waiting: 'espera permiso', idle: 'en espera', done: 'terminado', paused: 'en pausa', blocked: 'bloqueado' };
const HUES = ['#b09cff', '#8fc4ff', '#7fe3c4', '#ffc27a', '#7fd6ff', '#ffd9a0', '#e9b4ff', '#ffa8b8'];

/** Agente real: el PM o una sesión abierta, con su estado de actividad. */
export type Agent = { id: string; session: number | null; name: string; engine: string; h: string; state: AgState; did: string; branch: string | null };

export function sessionAgents(sessions: Session[], activity: Record<string, 'trabajando' | 'permiso' | null>, pm: { engine: string } | null): Agent[] {
  const out: Agent[] = [];
  const st = (key: string): AgState => activity[key] === 'trabajando' ? 'working' : activity[key] === 'permiso' ? 'waiting' : 'idle';
  if (pm) {
    const s = st('coach');
    out.push({ id: 'pm', session: null, name: 'Project manager', engine: pm.engine, h: '#7aa2ff', state: s === 'working' ? 'thinking' : s, did: s === 'idle' ? 'En espera' : STATE_LABEL[s === 'working' ? 'thinking' : s], branch: null });
  }
  sessions.forEach((x, i) => {
    const s = st(String(x.id));
    const engine = x.engine === 'claude' ? 'Claude' : x.engine === 'codex' ? 'Codex' : x.engine;
    out.push({
      id: String(x.id), session: x.id, name: `${x.name} · ${engine}`, engine, h: HUES[i % HUES.length], state: x.paused ? 'paused' : s,
      did: x.paused ? 'En pausa' : s === 'working' ? (x.branch ? `Trabajando en ${x.branch}` : 'Trabajando') : s === 'waiting' ? 'Espera tu permiso' : x.worktree ? `En reposo · ${x.branch ?? 'worktree'}` : 'En reposo',
      branch: x.branch,
    });
  });
  return out;
}

export function AgDot({ a, s = 14 }: { a: Pick<Agent, 'h' | 'state' | 'name'>; s?: number }) {
  return <span className={`ag st-${a.state}`} style={{ '--h': a.h, '--s': `${s}px` } as CSSProperties} role="img" aria-label={`${a.name}: ${STATE_LABEL[a.state]}`}><i /></span>;
}
export function StDot({ st, h = '#9db6ff', s = 12 }: { st: AgState; h?: string; s?: number }) {
  return <span className={`ag st-${st}`} style={{ '--h': h, '--s': `${s}px` } as CSSProperties} aria-hidden="true"><i /></span>;
}
export const I = ({ n, s }: { n: string; s?: number }) => <Icon name={n} size={s ?? 16} />;

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** Sigilo del proyecto: dos manchas de luz tramadas, deterministas por nombre. */
export function Sigil({ name }: { name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const W = (cv.width = 68), H = (cv.height = 68), c = cv.getContext('2d')!, R = rng(hash(name));
    const P = [[91, 134, 255], [233, 180, 255], [255, 190, 140], [120, 228, 190], [150, 210, 255], [255, 150, 170]];
    const a = P[hash(name) % P.length], b = P[(hash(name) >>> 3) % P.length];
    const bl = [{ x: R() * W, y: R() * H, c: a }, { x: R() * W, y: R() * H, c: b }];
    c.fillStyle = '#0b0c0f'; c.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) {
      let r = 0, g = 0, bb = 0;
      for (const p of bl) { const w = Math.exp(-((x - p.x) ** 2 + (y - p.y) ** 2) / (26 * 26)); r += p.c[0] * w; g += p.c[1] * w; bb += p.c[2] * w; }
      const z = Math.min(3.4, ((r + g + bb) / 765) * 5.2);
      if (z < 0.5) continue;
      c.fillStyle = `rgb(${r | 0},${g | 0},${bb | 0})`; c.fillRect(x + (4 - z) / 2, y + (4 - z) / 2, z, z);
    }
    c.fillStyle = 'rgba(255,255,255,.94)'; c.font = '600 22px -apple-system,Inter,sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText((name[0] ?? '?').toUpperCase(), W / 2, H / 2 + 1);
  }, [name]);
  return <canvas ref={ref} aria-hidden="true" />;
}

/** Arte de estado vacío del Artifact: retícula que se apaga hacia los bordes. */
export function EmptyArt() {
  return (
    <svg className="emptyart" viewBox="0 0 160 80" aria-hidden="true">
      {Array.from({ length: 60 }, (_, i) => { const x = 10 + (i % 15) * 10, y = 10 + ((i / 15) | 0) * 20, d = Math.hypot(x - 80, y - 40);
        return <circle key={i} cx={x} cy={y} r={Math.max(0.6, 2.4 - d / 30)} fill={`rgba(200,210,255,${Math.max(0.08, 0.6 - d / 90)})`} />; })}
    </svg>
  );
}

/** Raíz de un destino: clases de tamaño y movimiento del Artifact. */
export function useTv() {
  const m = useMotion();
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => { const on = () => setW(window.innerWidth); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  const reduced = m.systemReduced || m.motion === 'reducido';
  return `tv tr-root${w < 1100 ? ' w-narrow' : ''}${w < 900 ? ' w-tiny' : ''}${reduced ? ' reduced' : ''}${m.motion === 'sin-ambiente' || reduced ? ' calm' : ''}`;
}
export function Root({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  const cls = useTv();
  return <main className={`${cls} ${className}`} aria-label={label}>{children}</main>;
}
export const ambient = () => document.documentElement.dataset.motion === 'completo';
export function useAgentsActivity() { return useUi().activity; }

/** Fecha relativa breve, como en el Artifact. */
export function ago(ms: number) {
  const t = ms < 1e12 ? ms * 1000 : ms;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'ahora';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d`;
  return `${Math.round(s / 604800)} sem`;
}
