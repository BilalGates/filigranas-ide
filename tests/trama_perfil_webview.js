import { isTauri } from '@tauri-apps/api/core';
import { api, design, pty, tasks } from '../src/ipc';
import { Channel } from '@tauri-apps/api/core';

const result = { phases: [], hardware: { scale: devicePixelRatio, width: innerWidth, height: innerHeight } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let phase;
Reflect.set(window, '__perfilTrama', {
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
  render(duration) { phase?.renders.push(duration); },
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
  phase = { name, ipc: {}, renders: [], frames: [], input: [] };
  let request = 0;
  let previous = performance.now();
  const tick = (time) => {
    phase.frames.push(time - previous);
    previous = time;
    request = requestAnimationFrame(tick);
  };
  request = requestAnimationFrame(tick);
  const start = performance.now();
  try {
    await act(phase.input);
  } finally {
    cancelAnimationFrame(request);
    const { ipc, renders, frames, input } = phase;
    result.phases.push({
      name, elapsedMs: Math.round(performance.now() - start), ipc, react: sample(renders),
      frames: sample(frames), over50ms: frames.filter((ms) => ms > 50).length,
      over100ms: frames.filter((ms) => ms > 100).length, input: sample(input),
    });
    phase = undefined;
  }
}

async function readyAfter(action, selector, input) {
  const start = performance.now();
  action();
  await until(() => visible(selector));
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  input.push(performance.now() - start);
}

async function verifyMotion() {
  const tab = 'Movimiento y apariencia';
  const modes = [['Completo', 'completo'], ['Sin ambiente', 'sin-ambiente'], ['Reducido', 'reducido']];
  const { useReportActivity } = await import('../src/ui');
  const { createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  function FixtureActivity() {
    useReportActivity('coach', 'en marcha');
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const fixture = createRoot(container);
  fixture.render(createElement(FixtureActivity));
  result.motion = [];
  try {
    for (const [label, value] of modes) {
      destination('Ajustes');
      await until(() => button(tab)).then((el) => el.click());
      await until(() => button(label)).then((el) => el.click());
      const effective = document.documentElement.dataset.motion;
      const saved = localStorage.getItem('filigranas.movimiento');
      if (saved !== value || effective !== value) throw new Error(`Preferencia de movimiento inesperada: ${label}`);
      await until(() => visible('main[aria-label="Ajustes"]')?.classList.contains('reduced') === (value === 'reducido'));
      const animation = (style) => parseFloat(style.animationDuration) > 0.01 ? style.animationName : 'none';
      const working = animation(getComputedStyle(await until(() => visible('.mdemo .st-working')), '::before'));
      const thinking = animation(getComputedStyle(await until(() => visible('.mdemo .st-thinking')), '::after'));
      const permission = animation(getComputedStyle(await until(() => visible('.mdemo .st-waiting i'))));
      const flow = animation(getComputedStyle(await until(() => visible('.mdemo .e-exec'))));
      const canvas = await until(() => visible('.tr-field canvas'));
      await sleep(140);
      const a = canvas.toDataURL();
      await sleep(420);
      const ambient = a !== canvas.toDataURL();
      const expectedAnimations = value === 'reducido'
        ? ['none', 'none', 'none', 'none']
        : ['tv-spin', 'tv-drift', 'tv-beat', 'tv-flowd'];
      if ([working, thinking, permission, flow].some((name, i) => name !== expectedAnimations[i]) || ambient !== (value === 'completo')) {
        throw new Error(`Animación inesperada: ${JSON.stringify({ value, working, thinking, permission, flow, ambient })}`);
      }
      result.motion.push({ value, effective, saved, working, thinking, permission, flow, ambient });
    }
  } finally {
    fixture.unmount();
    container.remove();
  }
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

async function captureStudioState(ws) {
  const path = '/docs/trama-aceptacion-final/evidencias/fixture-studio/';
  const spec = await fetch(`${path}manifest.json`).then((response) => response.json());
  const project = ws.projects.find((item) => item.name === 'fixture-30');
  const readImage = async (name) => {
    const response = await fetch(path + name);
    if (!response.ok) throw new Error(`Imagen de Studio no encontrada: ${name}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };
  const screens = await design.list(project.path);
  let screen = screens.find((item) => item.name === 'Panel de Git');
  if (!screen) {
    const header = spec.header;
    const constraints = `[bloqueo ${header.x},${header.y},${header.w / 6.2},${(header.h / 4.2).toFixed(1)}] ${header.n}`;
    const save = (name, constraints = '') => design.save(project.path, { id: null, name, url: '', constraints, revision: null, approved: null });
    const id = await save('Panel de Git', constraints);
    const versions = [];
    for (const item of spec.versions) versions.push(await design.import(project.path, id, await readImage(item.image), item.note));
    const version3 = (await design.list(project.path)).find((item) => item.id === id);
    await design.review(project.path, id, { shot: versions[2], baseline: null, revision: version3.revision, approve: true, confirmed: true });
    for (const item of spec.references) await design.addReference(project.path, id, item.image, await readImage(item.image));
    await save('Inicio');
    await save('Ajustes');
    screen = (await design.list(project.path)).find((item) => item.id === id);
  }
  const versions = await design.shots(project.path, screen.id);
  const references = await design.references(project.path, screen.id);
  if (versions.length !== 4 || references.length !== 6 || !screen.approved) throw new Error('Fixture de Studio incompleta');
  destination('Inicio');
  await until(() => button('Abrir fixture-30')).then((el) => el.click());
  destination('Studio');
  await until(() => button('Pantallas y versiones')).then((el) => el.click());
  await until(() => [...document.querySelectorAll('.studio .scrn')].find((item) => item.textContent.trim().startsWith('Panel de Git')))
    .then((el) => el.click());
  await until(() => visible('.studio .ver'));
  const cards = [...document.querySelectorAll('.studio .ver')];
  const selected = cards.find((item) => item.textContent.trim().startsWith('v3 '));
  if (!selected) throw new Error('No aparece v3 de Studio');
  selected.click();
  await until(() => visible('.studio-stage img'));
  await sleep(750);
  const controls = (selector) => {
    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
    return { x, y, width, height };
  };
  result.studio = {
    versions: versions.map(({ note, status, width, height }) => ({ note, status, width, height })),
    references: references.map((item) => item.name),
    selected: document.querySelector('.studio .ver.on')?.textContent.trim(),
    dimensions: Object.fromEntries(['.slist', '.canvasw', '.toolbar', '.studio-composer'].map((selector) => [selector, controls(selector)])),
  };
}

async function run() {
  if (!isTauri()) throw new Error('El perfil se ejecuta en WKWebView');
  const url = new URL(location.href);
  const seconds = Number(import.meta.env.VITE_TRAMA_SECONDS ?? url.searchParams.get('segundos') ?? '60');
  if (!Number.isFinite(seconds) || seconds < 15 || seconds > 3600) throw new Error('Duración inválida');
  const tasksPerProject = 240;
  localStorage.setItem('filigranas.destino', 'inicio');
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
    await verifyMotion();
    await captureDemoState();
  }
  if (import.meta.env.VITE_TRAMA_STUDIO) await captureStudioState(ws);
}

try {
  await run();
} catch (error) {
  result.error = String(error);
}
await fetch('/__perfil_trama', { method: 'POST', body: JSON.stringify(result) });
