import { canvasHash, capture, post } from './trama_comparativa.js';

const report = { side: 'artifact', views: {} };
try {
  // Fija la escena de captura. El archivo original y sus recursos conservan sus hashes.
  S.calm = true;
  document.getElementById('view').style.animationDuration = '0s';
  F.on = false;
  document.body.classList.add('calm');
  S.brain.inf = false;
  if (sessionStorage.getItem('trama.comparativa.native') == null) throw new Error('Falta el recorrido nativo');
  const scenes = [
    ['inicio', 'home'],
    ['workspace', 'workspace'],
    ['workspace-arquitectura', 'workspace'],
    ['workspace-observar', 'workspace', () => { S.ws.peek = 'sen'; S.ws.layout = 'split'; }],
    ['flow', 'flow'],
    ['flow-dependencias', 'flow', () => { S.flow.lens = 'deps'; }],
    ['studio', 'studio'],
    ['studio-comparacion', 'studio', () => { S.studio.cmp = true; S.studio.cmpA = 3; S.studio.cmpB = 4; }],
    ['entrega', 'review'],
    ['entrega-hallazgo', 'review'],
    ['brain', 'brain'],
    ['brain-agrupado', 'brain', () => { S.brain.group = true; }],
    ['ajustes', 'ajustes'],
  ];
  for (const [name, route, configure] of scenes) {
    configure?.();
    go(route);
    if (name === 'workspace-arquitectura') document.querySelector('#archsvg').scrollIntoView({ block: 'center' });
    if (name === 'entrega-hallazgo') document.querySelector('[data-find="f1"]').click();
    const states = AG.map((agent) => agent.state);
    AG.forEach((agent) => { agent.state = 'idle'; });
    fieldDraw(0);
    AG.forEach((agent, index) => { agent.state = states[index]; });
    report.views[name] = { route };
    if (name === 'workspace') {
      report.views[name].architecture = document.querySelectorAll('#archsvg rect').length;
      report.views[name].changes = [...document.querySelectorAll('.diffmini div')].map((line) => line.textContent);
      report.views[name].team = document.querySelectorAll('.strip .prog').length;
    }
    if (name === 'flow') {
      report.views[name].candidates = [...document.querySelectorAll('#finsp .cand')].map((row) => row.textContent);
      report.views[name].timeline = document.querySelectorAll('#routesvg [data-rt]').length;
    }
    if (name === 'inicio') report.views.inicio.sigils = Object.fromEntries(
      await Promise.all([...document.querySelectorAll('canvas[data-sigil]')].map(async (canvas) =>
        [canvas.dataset.sigil, await canvasHash(canvas)])),
    );
    await capture(report, name, '#view');
  }
} catch (error) { report.error = String(error); }
report.ready = 'fin';
await post(report);
