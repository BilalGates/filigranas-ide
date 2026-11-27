import { useEffect, useRef } from 'react';
import { useUi } from '../ui';
import { AmbientLightField } from './ambientLights';
import { ambientEnabled, getMotionState, useMotion } from './motion';

// Retícula de 8 pt y umbral Bayer del Artifact canónico.
// En reposo el campo permanece apagado; cada agente activo enciende su propia
// sección aleatoria y el reloj se detiene cuando no hay animaciones pendientes.
const CELL = 8;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => value / 16);

export default function AmbientField({ dim = 1 }: { dim?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { activity } = useUi();
  const motion = useMotion();
  const state = useRef({
    field: new AmbientLightField(),
    dim,
    context: null as CanvasRenderingContext2D | null,
    w: 0,
    h: 0,
    d: 0,
    timer: 0,
    frame: 0,
    running: false,
  });

  const active = () => ambientEnabled() && !document.hidden && state.current.field.needsAnimation();

  const render = (t: number) => {
    const s = state.current, { context, w: W, h: H } = s;
    if (!context || !W || !H) return;
    context.clearRect(0, 0, W * CELL, H * CELL);
    const gain = s.dim * getMotionState().intensity;
    if (gain === 0) return;
    const src = s.field.sample(t, ambientEnabled());
    if (src.length === 0) return;
    const asp = W / H;
    // La distribución gaussiana es separable. Cada fuente necesita W + H
    // exponenciales, incluso si la ventana o la cantidad de agentes crece.
    const light = src.map((source) => ({
      c: source.c,
      x: Float64Array.from({ length: W }, (_, i) => {
        const dx = ((i / W - source.x) * asp) / source.r;
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
    state.current.field.sync(activity, performance.now());
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity]);

  useEffect(() => {
    state.current.dim = dim;
    render(performance.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dim]);

  useEffect(() => {
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motion]);

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
