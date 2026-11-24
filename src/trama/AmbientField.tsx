import { useEffect, useRef } from 'react';
import { useUi } from '../ui';
import { ambientEnabled, getMotionState, useMotion } from './motion';

// Retícula de 8 pt y umbral Bayer del Artifact canónico. El reloj se
// detiene en reposo y los pesos gaussianos se calculan por eje.
type Source = { x: number; y: number; r: number; c: [number, number, number]; a: number };
type Pulse = { x: number; c: [number, number, number]; t0: number; dur: number };

const CELL = 8;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => value / 16);
const BASE: Source[] = [
  { x: 0.06, y: -0.2, r: 0.5, c: [52, 86, 210], a: 0.50 },
  { x: 0.97, y: 1.08, r: 0.45, c: [95, 70, 170], a: 0.28 },
];

export default function AmbientField({ dim = 1 }: { dim?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { activity } = useUi();
  const motion = useMotion();
  const state = useRef({ working: 0, thinking: false, waiting: 0, pulses: [] as Pulse[], dim, context: null as CanvasRenderingContext2D | null, w: 0, h: 0, d: 0, timer: 0, frame: 0, running: false });
  const prev = useRef<Record<string, string | null>>({});

  // Traduce la actividad de las vistas a fuentes de luz y transiciones.
  useEffect(() => {
    const s = state.current;
    const values = Object.entries(activity);
    s.thinking = activity.coach === 'trabajando';
    s.working = values.filter(([key, v]) => key !== 'coach' && v === 'trabajando').length;
    s.waiting = values.filter(([, v]) => v === 'permiso').length;
    for (const [key, v] of values) {
      if (prev.current[key] === 'trabajando' && v === null && ambientEnabled())
        s.pulses.push({ x: 0.3 + Math.random() * 0.5, c: [111, 224, 179], t0: performance.now(), dur: 1800 });
    }
    prev.current = { ...activity };
    wake();
  }, [activity]);

  useEffect(() => { state.current.dim = dim; render(performance.now()); }, [dim]);
  useEffect(() => { wake(); }, [motion]);

  const active = () => {
    const s = state.current;
    return ambientEnabled() && !document.hidden && (s.working > 0 || s.thinking || s.waiting > 0 || s.pulses.length > 0);
  };
  const render = (t: number) => {
    const s = state.current, { context, w: W, h: H } = s;
    if (!context || !W || !H) return;
    context.clearRect(0, 0, W * CELL, H * CELL);
    const gain = s.dim * getMotionState().intensity;
    if (gain === 0) return;
    const k = t / 1000, live = ambientEnabled(), asp = W / H;
    const src = [...BASE];
    for (let i = 0; i < Math.min(s.working, 6); i++) {
      const ph = live ? k : i * 3.1;
      src.push({ x: 0.25 + 0.55 * ((i * 0.37 + ph * 0.006 * (1 + (i % 3))) % 1), y: 0.72 + 0.18 * Math.sin(ph * 0.21 + i), r: 0.17, c: i % 2 ? [143, 196, 255] : [176, 156, 255], a: 0.2 });
    }
    if (s.thinking) {
      const ph = live ? k : 0;
      src.push({ x: 0.5 + 0.1 * Math.sin(ph * 0.13), y: 0.32 + 0.06 * Math.cos(ph * 0.17), r: 0.28, c: [150, 125, 255], a: 0.18 + 0.1 * Math.sin(ph * 0.9) });
    }
    if (s.waiting) {
      const b = ((live ? k : 0.3) % 1.9) / 1.9;
      const p = b < 0.12 ? b / 0.12 : b < 0.24 ? 1 - ((b - 0.12) / 0.24) * 0.4 : b < 0.34 ? 0.6 + (b - 0.24) * 3 : Math.max(0, 1 - (b - 0.34) * 2.2);
      src.push({ x: 0.84, y: -0.02, r: 0.17, c: [255, 170, 80], a: 0.25 + 0.35 * p });
    }
    s.pulses = s.pulses.filter((p) => t - p.t0 < p.dur);
    for (const p of s.pulses) {
      const q = (t - p.t0) / p.dur;
      src.push({ x: p.x, y: 0.75, r: 0.1 + q * 0.25, c: p.c, a: 0.42 * Math.sin(Math.PI * Math.min(1, q * 1.4)) * (1 - q) });
    }
    // La distribución gaussiana es separable. Cada fuente necesita W + H
    // exponenciales, incluso si la ventana o la cantidad de agentes crece.
    const light = src.map((source) => ({
      c: source.c,
      x: Float64Array.from({ length: W }, (_, i) => {
        const dx = (i / W - source.x) * asp / source.r;
        return Math.exp(-dx * dx);
      }),
      y: Float64Array.from({ length: H }, (_, j) => {
        const dy = (j / H - source.y) / source.r;
        return source.a * gain * Math.exp(-dy * dy);
      }),
    }));
    let previousColor = -1;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        let r = 0, g = 0, b = 0;
        for (const q of light) {
          const w = q.x[i] * q.y[j];
          r += q.c[0] * w; g += q.c[1] * w; b += q.c[2] * w;
        }
        const l = (r * 0.3 + g * 0.55 + b * 0.15) / 255;
        if (l < 0.018 || (l < 0.09 && l * 11 < BAYER[(j & 3) * 4 + (i & 3)])) continue;
        const size = Math.min(1, Math.sqrt(l) * 1.25) * CELL * 0.78;
        if (size < 1) continue;
        const red = Math.min(255, r * 1.5) | 0;
        const green = Math.min(255, g * 1.5) | 0;
        const blue = Math.min(255, b * 1.5) | 0;
        const color = (red << 16) | (green << 8) | blue;
        if (color !== previousColor) {
          context.fillStyle = `rgb(${red},${green},${blue})`;
          previousColor = color;
        }
        const offset = (CELL - size) / 2;
        context.fillRect(i * CELL + offset, j * CELL + offset, size, size);
      }
    }
  };
  const queueFrame = () => {
    const s = state.current;
    cancelAnimationFrame(s.frame);
    if (!document.hidden) s.frame = requestAnimationFrame(render);
  };
  const step = () => {
    const s = state.current;
    queueFrame();
    if (!active()) { s.running = false; return; }
    s.timer = window.setTimeout(step, 80);
  };
  const wake = () => {
    const s = state.current;
    if (active()) { if (!s.running) { s.running = true; step(); } }
    else { s.running = false; window.clearTimeout(s.timer); queueFrame(); }
  };

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const size = () => {
      const r = cv.parentElement!.getBoundingClientRect();
      const s = state.current;
      const scale = Math.min(2, devicePixelRatio || 1);
      const width = Math.floor(r.width * scale), height = Math.floor(r.height * scale);
      if (cv.width === width && cv.height === height && s.d === scale) return;
      s.w = Math.ceil(r.width / CELL);
      s.h = Math.ceil(r.height / CELL);
      s.d = scale;
      cv.width = width; cv.height = height;
      s.context = cv.getContext('2d');
      s.context?.setTransform(scale, 0, 0, scale, 0, 0);
      render(performance.now());
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(cv.parentElement!);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('resize', size);
    return () => {
      const s = state.current;
      ro.disconnect();
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('resize', size);
      window.clearTimeout(s.timer);
      cancelAnimationFrame(s.frame);
      s.running = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="tr-field" aria-hidden="true"><canvas ref={canvas} /></div>;
}
