import { getIdentifier } from '@tauri-apps/api/app';
import { api, brain, git, health, skills } from '../src/ipc';
import { captureStudioState } from './trama_studio_escena';
import { canvasHash, capture, frames, post, until } from './trama_comparativa';

const report = { side: 'native', views: {} };
const visible = (selector) => [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length);
const button = (name) => [...document.querySelectorAll('button')].find((el) =>
  el.getClientRects().length && (el.textContent.trim() === name || el.getAttribute('aria-label') === name));
const wait = (check) => until(check, 'el control de Studio');
const scene = Object.entries({ Inicio: 'inicio', Workspace: 'workspace', Flow: 'flow', Studio: 'studio', Entrega: 'entrega', Brain: 'brain', Ajustes: 'ajustes' });

function destination(name) {
  const item = document.querySelector(`.tr-nav button[aria-label^="${name} ("]`);
  if (!item) throw new Error(`Falta el destino ${name}`);
  item.click();
}
async function navigate(name) {
  destination(name);
  await until(() => visible(name === 'Workspace' ? '.app:not(.is-dest) main.center' : `main[aria-label="${name}"]`), name);
}
async function open(name) {
  await navigate('Inicio');
  const project = await until(() => button(`Abrir ${name}`), name);
  project.click();
  await until(() => button(`Proyectos · ${name}`) && visible('.app:not(.is-dest) main.center'), `Workspace · ${name}`);
}
async function seedMemory(project, memory) {
  const types = { decision: 'decision', convencion: 'fact', preferencia: 'preference', restriccion: 'constraint', solucion: 'outcome' };
  const confirmed = memory.filter((entry) => entry.ok);
  const existing = await brain.search(project, '', null);
  const ids = new Map();
  for (const entry of confirmed.toReversed()) {
    const saved = existing.find((item) => item.title === entry.x);
    const id = saved?.id ?? await brain.save(project, {
      id: null, version: null, global: false, task: null, kind: types[entry.k], title: entry.x, body: entry.x, source: entry.src,
      sourceTask: null, sourceRun: null, share: false, validUntil: null,
    }, true);
    ids.set(entry.id, id);
  }
  const links = await brain.links(project);
  for (const entry of confirmed) {
    const from = ids.get(entry.id);
    for (const target of entry.rel.filter((id) => ids.has(id) && entry.id < id)) {
      const to = ids.get(target);
      if (!links.some((link) => link.from === from && link.to === to)) {
        await brain.link(project, { id: null, from, to, kind: 'relacionado', note: '' }, true);
      }
    }
  }
  return String(ids.get('m1'));
}

async function run() {
  if (await getIdentifier() !== 'com.filigranas.ide.trama-escenas') throw new Error('Se requiere el perfil aislado de escenas');
  const root = import.meta.env.VITE_TRAMA_SCENE_ROOT;
  if (!/^\/(?:private\/)?tmp\/trama-escenas-[^/]+\/repos$/.test(root ?? '')) throw new Error('Raíz de escenas inválida');
  const fixture = await fetch('/__trama_fixtures').then((response) => response.json());
  const ws = await api.setRoot(root);
  const project = ws.projects.find((item) => item.name === 'filigranas-ide');
  if (!project || ws.projects.length !== fixture.projects.length || !fixture.projects.every((item) => ws.projects.some((p) => p.name === item.n))) {
    throw new Error('Repositorios sintéticos inesperados');
  }
  for (const group of new Set(fixture.projects.map((p) => p.g))) {
    const current = await api.workspace();
    const grouped = current.groups.some((g) => g.name === group) ? current : await api.createGroup(group);
    const id = grouped.groups.find((g) => g.name === group).id;
    for (const item of fixture.projects.filter((p) => p.g === group)) {
      const repo = grouped.projects.find((p) => p.name === item.n);
      if (repo.groupId !== id) await api.moveProject(repo.path, id);
    }
  }
  const selectedMemory = await seedMemory(project.path, fixture.memory);
  const spec = await fetch('/docs/trama-aceptacion-final/evidencias/fixture-entrega.json').then((res) => res.json());
  const results = spec.findings.map((f) => ({
    ruleId: f.id, level: f.severity, message: { text: f.label },
    locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: f.line } } }],
  }));
  await health.import(project.path, null, JSON.stringify({
    version: '2.1.0', runs: [{ tool: { driver: { name: 'Trama v2 fixture' } }, results }],
  }));

  localStorage.setItem('filigranas.destino', 'inicio');
  localStorage.setItem('filigranas.movimiento', 'reducido');
  localStorage.setItem('filigranas.ajustes', 'skills');
  localStorage.setItem('filigranas.brain.lente', 'map');
  localStorage.setItem('filigranas.pm', JSON.stringify([project.path]));
  localStorage.setItem('filigranas.retomar', JSON.stringify({ project: project.path, view: 'coach', dest: 'workspace', at: Date.now() }));
  await import('../src/main.tsx');
  await until(() => !document.hidden && visible('.tr-nav'), 'la navegación nativa en primer plano', 20000);
  const read = (name) => capture(report, name, name === 'workspace' ? ['.threads', 'main.center'] : 'main[aria-label]');

  await open('filigranas-ide');
  await navigate('Inicio');
  await until(() => fixture.projects.every((item) => button(`Abrir ${item.n}`)), 'los nueve proyectos de Inicio');
  await until(() => visible('.prow .br')?.textContent, 'las ramas del resumen de Inicio');
  report.views.inicio = {
    projects: fixture.projects.length,
    groups: new Set(fixture.projects.map((p) => p.g)).size,
    sigils: Object.fromEntries(await Promise.all(fixture.projects.map(async ({ n }) =>
      [n, await canvasHash(button(`Abrir ${n}`).querySelector('canvas'))]))),
  };
  await read('inicio');

  await open('filigranas-ide');
  const plan = await until(() => visible('.co-plan-graph svg'), 'el plan de Workspace');
  const nodes = [...plan.querySelectorAll('g[role="button"]')];
  if (nodes.length !== 8 || plan.querySelectorAll('path').length !== 10) throw new Error('El plan de Workspace requiere 8 tareas y 10 enlaces');
  report.views.workspace = { nodes: nodes.map((node) => node.getAttribute('aria-label')), edges: 10 };
  await read('workspace');

  await open('bitacora');
  await navigate('Flow');
  const demo = await until(() => {
    const error = visible('.flow-err');
    if (error) throw new Error(error.textContent);
    return visible('.flow-demo');
  }, 'la demostración de Flow');
  demo.click();
  await until(() => button('Ejecución'), 'la lente Ejecución').then((el) => el.click());
  const flow = await until(() => visible('.flowg .gn[data-gid="t2"].sel'), 'la tarea t2');
  report.views.flow = { lens: 'exec', selected: flow.dataset.gid, nodes: document.querySelectorAll('.flowg .gn').length };
  await read('flow');

  report.views.studio = await captureStudioState(project, { button, destination, until: wait, visible });
  await read('studio');

  await navigate('Entrega');
  const file = spec.files.find((item) => item.path.endsWith('git_ops.rs'));
  const texts = await git.diffTexts(project.path, file.path, null);
  if (texts.old !== file.before || texts.new !== file.after) throw new Error('Diferencia Git distinta del Artifact');
  const inline = () => [...document.querySelectorAll('.diff-finding')].map((el) => el.textContent);
  await until(() => ['f1', 'f2'].every((id) => inline().some((line) => line.endsWith(id))), 'los dos hallazgos inline');
  report.views.entrega = { path: file.path, inline: inline() };
  await read('entrega');

  await navigate('Brain');
  const selected = await until(() => visible(`.gn[data-gid="${selectedMemory}"]`), 'el recuerdo m1');
  selected.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  await until(() => selected.classList.contains('sel'), 'la selección del recuerdo m1');
  report.views.brain = { selected: 'm1', confirmed: fixture.memory.filter((entry) => entry.ok).length, inferred: 0 };
  await read('brain');

  await navigate('Ajustes');
  await until(() => button('Skills y reglas'), 'Skills y reglas').then((el) => el.click());
  const assignments = await skills.assignments(null);
  if (assignments.length !== 42 || assignments.filter((item) => item.enabled).length !== 11) throw new Error('Matriz inesperada');
  await until(() => visible('[aria-label="Duplicidades"]')?.textContent.includes('enlaza la norma'), 'el análisis de reglas');
  report.views.ajustes = { cells: assignments.length, activeAssignments: 11 };
  await read('ajustes');

  const { setMotion, setFieldIntensity } = await import('../src/trama/motion.ts');
  setFieldIntensity(1);
  setMotion('completo');
  for (let pass = 0; pass < 3; pass++) {
    for (const [label, name] of scene) {
      const start = performance.now();
      await navigate(label);
      const main = name === 'workspace' ? '.app:not(.is-dest) main.center' : `main[aria-label="${label}"]`;
      const painted = until(() => Number(getComputedStyle(document.querySelector(main)).opacity) >= 0.99,
        `la opacidad final de ${label}`, 3500).then(() => Math.round(performance.now() - start), () => null);
      const [routeMs, cadence] = await Promise.all([painted, frames(3500)]);
      (report.views[name].active ??= []).push({ routeMs, ...cadence });
    }
  }
}

try { await run(); } catch (error) {
  report.error = String(error);
  report.failedState = {
    visibility: document.visibilityState,
    project: document.querySelector('.tb-proj')?.getAttribute('aria-label'),
    view: document.querySelector('main[aria-label]')?.textContent.slice(0, 550),
  };
}
report.ready = 'fin';
await post(report);
if (!report.error) {
  sessionStorage.setItem('trama.comparativa.native', '1');
  location.assign('/__trama_referencia');
}
