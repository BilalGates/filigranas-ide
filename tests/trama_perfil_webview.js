import { isTauri } from '@tauri-apps/api/core';
import { api, pty, tasks } from '../src/ipc';
import { verifyMotion } from './trama_movimiento.js';
import { captureStudioState } from './trama_studio_escena';
import { Channel } from '@tauri-apps/api/core';

const result = { phases: [], hardware: { scale: devicePixelRatio, width: innerWidth, height: innerHeight } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let phase;
Reflect.set(window, '__perfilTrama', {
  mark(name) {
    phase?.events.push({ name, ms: Math.round(performance.now() - phase.start) });
  },
  ipc(command) {
    if (!phase) return;
    const current = phase;
    const start = performance.now();
    current.ipc[command] ??= { count: 0, totalMs: 0, worstMs: 0 };
    current.ipc[command].count++;
    return () => {
      const elapsed = performance.now() - start;
      current.ipc[command].totalMs += elapsed;
      current.ipc[command].worstMs = Math.max(current.ipc[command].worstMs, elapsed);
    };
  },
  render(duration) {
    phase?.renders.push(duration);
    if (duration > 20) this.mark(`React ${Math.round(duration)} ms`);
  },
});

async function until(read, timeout = 8000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const value = read();
    if (value) return value;
    await sleep(16);
  }
  throw new Error('La vista no alcanzó el estado esperado');
}

const destination = (name) => document.querySelector(`.tr-nav button[aria-label^="${name} ("]`).click();
const visible = (selector) => [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length);
const button = (label) => [...document.querySelectorAll('button')].find((el) =>
  el.getClientRects().length && (el.getAttribute('aria-label') === label || el.textContent.trim() === label));

function sample(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const round = (n) => Number(n.toFixed(2));
  const quantile = (p) => round(sorted[Math.ceil(sorted.length * p) - 1] ?? 0);
  return { count: sorted.length, medianMs: quantile(0.5), p95Ms: quantile(0.95), maxMs: quantile(1) };
}

async function measure(name, act) {
  const start = performance.now();
  phase = { name, start, ipc: {}, renders: [], frames: [], input: [], step: '', events: [], gaps: [] };
  let request = 0;
  let previous = performance.now();
  const tick = (time) => {
    const interval = time - previous;
    phase.frames.push(interval);
    if (interval > 40) phase.gaps.push({ step: phase.step, ms: Math.round(time - start), interval: Math.round(interval) });
    previous = time;
    request = requestAnimationFrame(tick);
  };
  request = requestAnimationFrame(tick);
  try {
    await act(phase.input);
  } finally {
    cancelAnimationFrame(request);
    const { ipc, renders, frames, input, events, gaps } = phase;
    result.phases.push({
      name, elapsedMs: Math.round(performance.now() - start), ipc, react: sample(renders),
      frames: sample(frames), over50ms: frames.filter((ms) => ms > 50).length,
      over100ms: frames.filter((ms) => ms > 100).length, input: sample(input), events, gaps,
    });
    phase = undefined;
  }
}

async function readyAfter(action, selector, input) {
  phase.step = selector;
  window.__perfilTrama.mark(selector);
  const start = performance.now();
  action();
  await until(() => visible(selector));
  let request, timeout;
  try {
    await new Promise((done, reject) => {
      request = requestAnimationFrame(() => { request = requestAnimationFrame(done); });
      timeout = setTimeout(() => reject(new Error(`WebKit no pintó ${selector} con la ventana ${document.visibilityState}`)), 6000);
    });
  } finally {
    cancelAnimationFrame(request);
    clearTimeout(timeout);
  }
  input.push(performance.now() - start);
}


async function captureDemoState() {
  destination('Inicio');
  await until(() => button('Abrir fixture-31')).then((el) => el.click());
  destination('Flow');
  await until(() => visible('.flow-demo')).then((el) => el.click());
  await until(() => button('Ejecución')).then((el) => el.click());
  const svg = await until(() => visible('.flowg'));
  await sleep(750);
  result.scene = {
    view: 'Flow',
    lens: 'exec',
    selected: svg.querySelector('.gn.sel')?.dataset.gid,
    nodes: Array.from(svg.querySelectorAll('.gn[data-gid]')).map((node) => {
      const matrix = node.transform.baseVal.getItem(0).matrix;
      return { id: node.dataset.gid, x: matrix.e, y: matrix.f };
    }).sort((a, b) => a.id.localeCompare(b.id)),
  };
}


async function run() {
  if (!isTauri()) throw new Error('El perfil se ejecuta en WKWebView');
  const url = new URL(location.href);
  const seconds = Number(import.meta.env.VITE_TRAMA_SECONDS ?? url.searchParams.get('segundos') ?? '60');
  if (!Number.isFinite(seconds) || seconds < 15 || seconds > 3600) throw new Error('Duración inválida');
  const tasksPerProject = 240;
  localStorage.setItem('filigranas.destino', 'inicio');
  localStorage.setItem('filigranas.movimiento', 'completo');
  localStorage.setItem('filigranas.campo', '1');
  localStorage.setItem('filigranas.flow.lente', 'exec');
  await measure('arranque', async () => {
    await import('../src/main.tsx');
    await until(() => visible('main[aria-label="Inicio"]'));
    await sleep(2400);
  });
  const ws = await api.workspace();
  const project = ws.projects.find((item) => item.name === 'fixture-00');
  if (!project || !/^\/(?:private\/)?tmp\/trama-perfil-[^/]+\/repos$/.test(ws.root ?? '')) throw new Error('La raíz debe ser una fixture aislada');
  const current = await tasks.list(project.path);
  let previous = current.at(-1)?.id;
  for (let i = current.length; i < tasksPerProject; i++) {
    previous = await tasks.save(project.path, {
      id: null, parentId: null, title: `Tarea de perfil ${i + 1}`, goal: 'Medir WKWebView', criteria: 'Fixture',
      priority: 'normal', risk: 'normal', status: 'ready', verification: '', tests: null,
      dependencies: previous && i % 4 ? [previous] : [],
    });
  }
  result.fixture = { repositories: ws.projects.length, tasks: tasksPerProject };
  await until(() => button('Abrir fixture-00')).then((el) => el.click());
  await measure('navegación y grafo', async (input) => {
    for (let i = 0; i < 5; i++) {
      await readyAfter(() => destination('Inicio'), 'main[aria-label="Inicio"]', input);
      await sleep(400);
      await readyAfter(() => destination('Flow'), '.flowg [data-gid]', input);
      await readyAfter(() => button('Dependencias').click(), '.flowg [data-gid]', input);
      await sleep(500);
      await readyAfter(() => destination('Studio'), 'main[aria-label="Studio"]', input);
      await sleep(200);
      await readyAfter(() => destination('Entrega'), 'main[aria-label="Entrega"] .rev', input);
      await sleep(300);
    }
  });
  if (url.searchParams.get('soloNavegacion') === '1') return;
  await measure('navegación sostenida con PTY', async (input) => {
    const channel = new Channel();
    let bytes = 0;
    channel.onmessage = (event) => { if (event.kind === 'data') bytes += event.data.length; };
    const terminal = await pty.open(project.path, null, 80, 24, channel);
    try {
      await pty.write(terminal, `sleep 1; for i in {1..120}; do printf 'salida nativa %s\\n' "$i"; sleep 0.5; done\n`);
      const start = performance.now();
      while (performance.now() - start < seconds * 1000) {
        await readyAfter(() => destination('Flow'), '.flowg [data-gid]', input);
        await sleep(2850);
        await readyAfter(() => destination('Inicio'), 'main[aria-label="Inicio"]', input);
        await sleep(1200);
      }
      result.terminalBytes = bytes;
      if (!bytes) throw new Error('El terminal no devolvió datos');
    } finally {
      await pty.close(terminal);
    }
  });
  if (import.meta.env.VITE_TRAMA_MOVIMIENTO) {
    result.motion = await verifyMotion({ button, destination, sleep, until, visible });
    await captureDemoState();
  }
  if (import.meta.env.VITE_TRAMA_STUDIO) result.studio = await captureStudioState(ws.projects.find((item) => item.name === 'fixture-30'), { button, destination, until, visible });
}

try {
  await run();
} catch (error) {
  result.error = String(error);
  result.stopped = { visibility: document.visibilityState, focused: document.hasFocus(),
    view: document.querySelector('main[aria-label]')?.getAttribute('aria-label'),
    loading: Boolean(visible('.flow-loading')), failure: visible('.flow-err')?.textContent };
}
await fetch('/__perfil_trama', { method: 'POST', body: JSON.stringify(result) });
