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
  for (const [name, route] of Object.entries({ inicio: 'home', workspace: 'workspace', flow: 'flow', studio: 'studio', entrega: 'review', brain: 'brain', ajustes: 'ajustes' })) {
    go(route);
    const states = AG.map((agent) => agent.state);
    AG.forEach((agent) => { agent.state = 'idle'; });
    fieldDraw(0);
    AG.forEach((agent, index) => { agent.state = states[index]; });
    report.views[name] = { route };
    if (name === 'inicio') report.views.inicio.sigils = Object.fromEntries(
      await Promise.all([...document.querySelectorAll('canvas[data-sigil]')].map(async (canvas) =>
        [canvas.dataset.sigil, await canvasHash(canvas)])),
    );
    await capture(report, name, '#view');
  }
} catch (error) { report.error = String(error); }
report.ready = 'fin';
await post(report);
