import { getIdentifier } from '@tauri-apps/api/app';
import { api, git, health, skills } from '../src/ipc';

const report = { views: {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const button = (name) => [...document.querySelectorAll('button')].find((el) =>
  el.getClientRects().length && (el.textContent.trim() === name || el.getAttribute('aria-label') === name));
async function until(check, description) {
  const expires = Date.now() + 9000;
  while (Date.now() < expires) {
    const value = check();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`No se alcanzó ${description}`);
}

async function record(view) {
  report.ready = view;
  await fetch('/__perfil_trama', { method: 'POST', body: JSON.stringify(report) });
  await sleep(4500);
}

async function run() {
  const identifier = 'com.filigranas.ide.trama-escenas';
  if (await getIdentifier() !== identifier) throw new Error('Se requiere el perfil de escenas');
  const root = import.meta.env.VITE_TRAMA_SCENE_ROOT;
  if (!/^\/(?:private\/)?tmp\/trama-escenas-[^/]+\/repos$/.test(root ?? '')) throw new Error('Raíz de escenas inválida');
  const ws = await api.setRoot(root);
  const project = ws.projects.find((item) => item.name === 'filigranas-ide')?.path;
  if (ws.projects.length !== 1 || !project) throw new Error('Proyecto de escenas inesperado');
  const spec = await fetch('/docs/trama-aceptacion-final/evidencias/fixture-entrega.json').then((res) => res.json());
  const result = spec.findings.map((f) => ({
    ruleId: f.id, level: f.severity, message: { text: f.label },
    locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: f.line } } }],
  }));
  await health.import(project, null, JSON.stringify({
    version: '2.1.0', runs: [{ tool: { driver: { name: 'Trama v2 fixture' } }, results: result }],
  }));
  localStorage.setItem('filigranas.destino', 'inicio');
  localStorage.setItem('filigranas.movimiento', 'reducido');
  localStorage.setItem('filigranas.ajustes', 'skills');
  if (import.meta.env.VITE_TRAMA_WORKSPACE) localStorage.setItem('filigranas.pm', JSON.stringify([project]));
  await import('../src/main.tsx');
  await until(() => button('Abrir filigranas-ide'), 'el proyecto').then((el) => el.click());
  const navigate = async (name) => {
    const el = await until(() => document.querySelector(`.tr-nav button[aria-label^="${name} ("]`), name);
    el.click();
    await until(() => document.querySelector(`main[aria-label="${name}"]`), `la vista ${name}`);
  };

  await navigate('Entrega');
  const file = spec.files.find((item) => item.path.endsWith('git_ops.rs'));
  const texts = await git.diffTexts(project, file.path, null);
  if (texts.old !== file.before || texts.new !== file.after) throw new Error('Git no devolvió el contenido exacto del Artifact');
  const findings = (await health.list(project, null))[0].findings;
  for (const f of spec.findings) {
    if (!findings.some((item) => item.rule === f.id && item.path === f.path && item.line === f.line && item.severity === f.severity)) {
      throw new Error(`No se conservó la localización de ${f.id}`);
    }
  }
  const inline = () => [...document.querySelectorAll('.diff-finding')].map((el) => el.textContent);
  await until(() => ['f1', 'f2'].every((id) => inline().some((line) => line.endsWith(id))), 'ambos hallazgos inline');
  report.views.entrega = { exactFile: file.path, findings: findings.length, inline: inline() };
  await record('entrega');

  await navigate('Ajustes');
  await until(() => button('Skills y reglas'), 'la navegación de Ajustes').then((el) => el.click());
  const roleDefaults = await skills.assignments(null);
  if (roleDefaults.length !== 42 || roleDefaults.filter((cell) => cell.enabled).length !== 11) {
    throw new Error('Matriz predeterminada inesperada');
  }
  if (!(await skills.ruleStatus(project)).linksTrafficReference) throw new Error('Falta el vínculo canónico de la fixture');
  await until(() => document.querySelector('[aria-label="Duplicidades"]')?.textContent.includes('enlaza la norma'), 'el análisis de reglas');
  await until(() => document.querySelector('[aria-label="Catálogo efectivo"]')?.textContent.includes('implement'), 'el catálogo Senior');
  report.views.ajustes = { roles: 7, skills: 6, cells: roleDefaults.length, active: 11, duplicates: 'referencia enlazada' };
  await record('ajustes');

  if (import.meta.env.VITE_TRAMA_WORKSPACE) {
    await until(() => document.querySelector('.tr-nav button[aria-label^="Workspace ("]'), 'Workspace').then((el) => el.click());
    const plan = await until(() => document.querySelector('.co-plan-graph svg'), 'el plan de Workspace');
    const nodes = [...plan.querySelectorAll('g[role="button"]')];
    if (nodes.length !== 8) throw new Error('El plan de Workspace requiere ocho nodos');
    report.views.workspace = { nodes: nodes.map((node) => node.getAttribute('aria-label')), edges: plan.querySelectorAll('path').length };
    await record('workspace');
    nodes[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const selected = await until(() => document.querySelector('.flowg .gn.sel'), 'la tarea seleccionada en Flow');
    if (!selected.getAttribute('aria-label').startsWith(report.views.workspace.nodes[1])) throw new Error('Flow seleccionó una tarea distinta');
    report.views.workspace.keyboardOpensSelection = true;
  }
}

try { await run(); } catch (error) { report.error = String(error); }
report.ready = 'fin';
await fetch('/__perfil_trama', { method: 'POST', body: JSON.stringify(report) });
