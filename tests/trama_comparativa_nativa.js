import { getIdentifier } from '@tauri-apps/api/app';
import { api, brain, git, health, sessions, skills } from '../src/ipc';
import { verifyMotion } from './trama_movimiento.js';
import { captureLiveStudioState, captureStudioState } from './trama_studio_escena';
import { canvasHash, capture, frames, post, sleep, until } from './trama_comparativa';

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
  const kinds = { restriccion: 'constraint', solucion: 'outcome', preferencia: 'preference' };
  const inferred = new Map();
  for (const item of fixture.memory.filter((entry) => !entry.ok)) {
    const id = await brain.propose(project.path, {
      id: null, version: null, global: false, task: null, kind: kinds[item.k], title: item.x,
      body: item.x, source: item.src, sourceTask: null, sourceRun: null, share: false, validUntil: null,
    });
    inferred.set(item.id, { id, title: item.x });
  }
  const spec = await fetch('/docs/trama-aceptacion-final/evidencias/fixture-entrega.json').then((res) => res.json());
  const results = spec.findings.map((f) => ({
    ruleId: f.id, level: f.severity, message: { text: f.label },
    locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: f.line } } }],
  }));
  await health.import(project.path, null, JSON.stringify({
    version: '2.1.0', runs: [{ tool: { driver: { name: 'Trama v2 fixture' } }, results }],
  }));

  localStorage.setItem('filigranas.destino', 'inicio');
  localStorage.setItem('filigranas.disposicion', 'chat');
  localStorage.setItem('filigranas.flow.lente', 'exec');
  localStorage.setItem('filigranas.movimiento', 'reducido');
  localStorage.setItem('filigranas.ajustes', 'skills');
  localStorage.setItem('filigranas.brain.lente', 'map');
  localStorage.setItem('filigranas.pm', JSON.stringify([project.path]));
  localStorage.setItem('filigranas.retomar', JSON.stringify({ project: project.path, view: 'coach', dest: 'workspace', at: Date.now() }));
  await import('../src/main.tsx');
  await until(() => !document.hidden && visible('.tr-nav'), 'la navegación nativa en primer plano', 20000);
  const read = (name) => capture(report, name, name.startsWith('workspace')
    ? ['.threads', 'main.center', ...(name === 'workspace-observar' ? ['#workspace-right-panel'] : [])] : 'main[aria-label]');

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
  const failure = await until(() => [...document.querySelectorAll('.home .aitem')].find((item) =>
    item.textContent.includes('CI fallido en kaza') && item.textContent.includes('PR #16')), 'el CI fallido del SHA actual');
  report.views.inicio.failure = { project: 'kaza', number: 16 };
  await read('inicio');
  failure.querySelector('button').click();
  await until(() => visible('[aria-label="Estado de CI"]')?.textContent.includes('13 correctos · 1 fallidos · 0 pendientes'), 'el CI fallido al abrir Entrega');
  report.views.inicio.failure.actionOpensCi = true;

  await open('filigranas-ide');
  const workspaceFixture = await fetch('/docs/trama-aceptacion-final/evidencias/fixture-workspace.json').then((response) => response.json());
  const savedSessions = await sessions.list(project.path);
  const { useReportActivity } = await import('../src/ui');
  const { createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useState } = await import('react');
  const { useSharedPermissions } = await import('../src/trama/pendingPermissions.ts');
  const decisions = [];
  // Usa el canal real de permisos de la interfaz y una respuesta local.
  function Permission() {
    const [active, setActive] = useState(true);
    useSharedPermissions(project.path, Number.MAX_SAFE_INTEGER, 'Programador · Codex', project.path, active ? [{
      key: 'trama-permiso-editar', title: 'espera tu permiso', command: 'editar src/ipc.ts   # fuera del reparto: src-tauri/',
      decide: (decision) => { decisions.push(decision); setActive(false); },
    }] : []);
    return null;
  }
  function Activity({ id, state }) {
    useReportActivity(String(id), state === 'waiting' ? 'esperando permiso' : 'en marcha');
    return null;
  }
  const activityHost = document.createElement('div');
  document.body.append(activityHost);
  const activity = createRoot(activityHost);
  activity.render([createElement(Permission, { key: 'permission' }), ...workspaceFixture.sessions.map((item) => {
    const session = savedSessions.find((entry) => entry.providerSession === 'trama-fixture-' + item.id);
    if (!session) throw new Error('Falta la sesión sintética ' + item.id);
    return createElement(Activity, { id: session.id, state: item.state, key: session.id });
  })]);
  const permission = await until(() => visible('.coach[aria-label="Coordinador"] .co-approval'), 'el permiso de la sesión en el hilo del PM');
  const plan = await until(() => visible('.co-plan-graph svg'), 'el plan de Workspace');
  const nodes = [...plan.querySelectorAll('g[role="button"]')];
  if (nodes.length !== 8 || plan.querySelectorAll('path').length !== 10) throw new Error('El plan de Workspace requiere 8 tareas y 10 enlaces');
  const architecture = await until(() => visible('[aria-label="Arquitectura propuesta"]'), 'la tarjeta de arquitectura');
  const preview = await until(() => visible('.co-patch'), 'la vista previa del diff');
  await until(() => {
    const rows = [...document.querySelectorAll('.co-team-row')];
    const height = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
    const parentHeight = rows[0]?.parentElement.getBoundingClientRect().height;
    return rows.length === 3 && rows.every((row) => row.getBoundingClientRect().height >= 36)
      && parentHeight <= height + 10 && plan.getBoundingClientRect().height === 120
      && plan.closest('section').getBoundingClientRect().height > 120;
  }, 'el plan y las tres tarjetas sin recorte');
  report.views.workspace = {
    nodes: nodes.map((node) => node.getAttribute('aria-label')), edges: 10,
    architecture: [...architecture.querySelectorAll('svg g > rect')].length,
    changes: [...preview.querySelectorAll('code')].map((line) => line.textContent),
    team: [...document.querySelectorAll('.co-team-status')].map((status) => status.textContent),
    progress: [...document.querySelectorAll('.co-team-row .prog')].map((dots) => ({
      label: dots.getAttribute('aria-label'), ticks: dots.childElementCount,
    })),
  };
  if (document.querySelector('.app.has-panel')) throw new Error('Workspace debe empezar en la disposición de conversación');
  const conversation = document.querySelector('.coach[aria-label="Coordinador"] .co-log');
  conversation.scrollTop = conversation.scrollHeight;
  await read('workspace');
  architecture.scrollIntoView({ block: 'center' });
  report.views['workspace-arquitectura'] = { nodes: 4, edges: 3 };
  await read('workspace-arquitectura');
  const observe = document.querySelector('.co-team-row .co-team-actions button');
  observe.click();
  const observation = await until(() => visible('.workspace-observation-log .co-text'), 'la conversación de Senior en el panel');
  if (!visible('.coach[aria-label="Coordinador"]') || !observation.textContent.includes('Encargo del PM')) {
    throw new Error('Observar cambió la conversación principal o abrió otra sesión');
  }
  const source = await until(() => visible('.workspace-observation-diff .review-code-rows')?.textContent.includes('run_git'), 'el diff de la sesión en observación');
  conversation.scrollTop = conversation.scrollHeight;
  report.views['workspace-observar'] = { agent: 'Senior', pmVisible: true, readOnly: !document.querySelector('.workspace-observation .co-compose'), codeVisible: source };
  await read('workspace-observar');
  button('Cerrar observación').click();
  await until(() => !visible('.workspace-observation') && !document.querySelector('.app.has-panel'), 'la vuelta a la disposición anterior');
  permission.scrollIntoView({ block: 'end' });
  const permissionTitle = permission.querySelector('.co-approval-title b').textContent;
  const permissionCommand = permission.querySelector('.co-approval-command').textContent;
  report.views['workspace-permiso'] = { source: permissionTitle, command: permissionCommand, actions: permission.querySelectorAll('button').length };
  await read('workspace-permiso');
  const reject = permission.querySelector('[aria-label="Ahora no"]');
  reject.click();
  reject.click();
  await until(() => !visible('.coach[aria-label="Coordinador"] .co-approval'), 'la retirada del permiso decidido');
  if (decisions.length !== 1 || decisions[0] !== 'decline') throw new Error('Se decidió un permiso más de una vez');
  report.views['workspace-permiso'].decision = decisions[0];
  activity.unmount();
  activityHost.remove();

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
  report.views.flow.candidates = [...document.querySelectorAll('.insp .cand')].map((row) => row.textContent);
  report.views.flow.timeline = document.querySelectorAll('.route .rt').length;
  await read('flow');
  button('Dependencias').click();
  await until(() => button('Dependencias')?.getAttribute('aria-pressed') === 'true', 'la lente Dependencias');
  report.views['flow-dependencias'] = { selected: 't2' };
  await read('flow-dependencias');
  button('Ejecución').click();

  report.views.studio = await captureStudioState(project, { button, destination, until: wait, visible });
  await read('studio');
  await until(() => [...document.querySelectorAll('.studio .ver')].find((item) => item.textContent.trim().startsWith('v4 ')), 'la v4').then((el) => el.click());
  await until(() => {
    const compare = document.querySelector('.studio .toolbar button[aria-label="Comparar"]');
    return compare && !compare.disabled && compare;
  }, 'el divisor de Studio').then((el) => el.click());
  const comparison = await until(() => visible('.studio-inspector-compare'), 'las versiones en el inspector');
  if (!comparison.textContent.startsWith('v3 ↔ v4')) throw new Error('Se están comparando otras versiones');
  report.views['studio-comparacion'] = { baseline: 3, candidate: 4 };
  await read('studio-comparacion');
  const baselinePicker = comparison.querySelector('select[aria-label="Versión anterior"]');
  const changeBaseline = (label) => {
    baselinePicker.value = [...baselinePicker.options].find((option) => option.textContent === label).value;
    baselinePicker.dispatchEvent(new Event('change', { bubbles: true }));
  };
  changeBaseline('v2');
  await until(() => comparison.textContent.startsWith('v2 ↔ v4'), 'el cambio de versión desde el inspector');
  changeBaseline('v3');
  await until(() => comparison.textContent.startsWith('v3 ↔ v4'), 'el regreso a la versión anterior');
  report.views['studio-comparacion'].inspectorPicker = true;
  const divider = document.querySelector('[aria-label="Divisor antes y después"]');
  divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await until(() => divider.getAttribute('aria-valuenow') === '55', 'el divisor movido con el teclado');

  await captureLiveStudioState(project, { button, until, visible, navigate, report, read });

  await navigate('Entrega');
  const file = spec.files.find((item) => item.path.endsWith('git_ops.rs'));
  const texts = await git.diffTexts(project.path, file.path, null);
  if (texts.old !== file.before || texts.new !== file.after) throw new Error('Diferencia Git distinta del Artifact');
  const inline = () => [...document.querySelectorAll('.diff-finding')].map((el) => el.textContent);
  await until(() => ['f1', 'f2'].every((id) => inline().some((line) => line.endsWith(id))), 'los dos hallazgos inline');
  const tiles = [...document.querySelectorAll('.audit-map .tmap')];
  const ipcTile = tiles.find((tile) => tile.title.endsWith('/ipc.ts'));
  if (!ipcTile || tiles.length < 3) throw new Error('El mapa de auditoría debe incluir archivos sin hallazgos');
  report.views.entrega = { path: file.path, inline: inline(), filesInMap: tiles.map((tile) => tile.title) };
  await read('entrega');
  ipcTile.click();
  await until(() => ipcTile.getAttribute('aria-pressed') === 'true' && visible('.rev-diff .review-code-rows')?.textContent.includes('gitOps'), 'el diff elegido desde el mapa');
  report.views.entrega.mapOpensDiff = true;
  const finding = await until(() => [...document.querySelectorAll('.audit .fitem')].find((item) => item.textContent.startsWith('f1')), 'el hallazgo f1');
  finding.click();
  await until(() => finding.classList.contains('on') && visible('.diff-finding-error')?.textContent.includes('L27'), 'la línea 27 de f1');
  report.views['entrega-hallazgo'] = { id: 'f1', line: 27 };
  await read('entrega-hallazgo');
  // El HTML vuelve a empezar por la primera línea al abrir el escenario de CI.
  await navigate('Flow');
  await navigate('Entrega');
  await until(() => /Operaciones\s+remotas/.test(visible('.rev-diff .review-code-rows')?.textContent ?? ''), 'el diff desde el inicio');
  button('Actualizar').click();
  const ci = await until(() => document.querySelector('[aria-label="Recorrido de la entrega"] [aria-label="CI: 14/14"]'), 'el CI verde del SHA actual');
  ci.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => visible('[aria-label="Estado de CI"]')?.textContent.includes('14 correctos · 0 fallidos · 0 pendientes'), 'el inspector de CI aprobado');
  const codeVisible = /Operaciones\s+remotas/.test(visible('.rev-diff .review-code-rows')?.textContent ?? '');
  if (!codeVisible) throw new Error('El CI cerró el diff que estaba abierto');
  const observations = await health.ci(project.path, null);
  report.views['entrega-ci'] = { number: 17, checks: observations.find((pull) => pull.number === 17).checks, codeVisible };
  await read('entrega-ci');

  await navigate('Brain');
  await until(() => button('Inferidos'), 'el filtro de inferencias').then((el) => el.click());
  const selected = await until(() => visible(`.gn[data-gid="${selectedMemory}"]`), 'el recuerdo m1');
  selected.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  await until(() => selected.classList.contains('sel'), 'la selección del recuerdo m1');
  report.views.brain = { selected: 'm1', confirmed: fixture.memory.filter((entry) => entry.ok).length, inferred: 0 };
  await read('brain');
  await until(() => button('Agrupar'), 'el agrupamiento de Brain').then((el) => el.click());
  const groups = () => document.querySelectorAll('.brg .gn[data-gid^="K-"]').length;
  await until(() => groups() === 5, 'los cinco grupos de recuerdos');
  report.views['brain-agrupado'] = { groups: groups() };
  await read('brain-agrupado');
  button('Agrupar').click();
  button('Inferidos').click();
  const memory = inferred.get('m10');
  const count = () => document.querySelectorAll('.brg .gn[data-gid^="-"]').length;
  await until(() => count() === 3, 'las tres inferencias en el grafo');
  const node = document.querySelector(`.brg .gn[data-gid="-${memory.id}"]`);
  node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  const inference = await until(() => document.querySelector('#binsp textarea[aria-label="Inferencia"]'), 'la inferencia m10 seleccionada');
  document.activeElement?.blur();
  const isApproved = async () => (await brain.search(project.path, 'Botones sin rellenos', null)).find((item) => item.title === memory.title);
  if (await isApproved()) throw new Error('Una inferencia pendiente se indexó como recuerdo confirmado');
  report.views['brain-inferencias'] = { selected: 'm10', count: count() };
  await read('brain-inferencias');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setValue.call(inference, memory.title + ' Revisado.');
  inference.dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => button('Guardar corrección')?.disabled === false, 'la corrección disponible');
  button('Guardar corrección').click();
  await until(async () => (await brain.inferences(project.path)).some((entry) => entry.id === memory.id && entry.draft.title.endsWith(' Revisado.')), 'la corrección de la inferencia en SQLite');
  await until(() => button('Aprobar')?.disabled === false, 'la corrección guardada');
  if (await isApproved()) throw new Error('La corrección aprobó la inferencia');
  report.views['brain-inferencias'].correctedWhilePending = true;
  setValue.call(inference, memory.title);
  inference.dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => button('Guardar corrección')?.disabled === false, 'la restauración de la inferencia de prueba disponible');
  button('Guardar corrección').click();
  await until(() => button('Aprobar')?.disabled === false, 'la aprobación disponible');
  button('Aprobar').click();
  const approved = await until(isApproved, 'el recuerdo aprobado en SQLite');
  if (approved.share) throw new Error('La aprobación activó el envío a los agentes automáticamente');
  report.views['brain-inferencias'].approvedOnlyAfterConfirmation = true;
  await brain.forget(project.path, approved.id, approved.version);

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
  report.motion = await verifyMotion({ button, destination, sleep, until, visible });
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
