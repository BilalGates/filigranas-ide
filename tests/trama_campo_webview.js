import { getIdentifier } from '@tauri-apps/api/app';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measure() {
  if (await getIdentifier() !== 'com.filigranas.ide.trama-escenas') {
    throw new Error('Se requiere el perfil aislado de escenas');
  }
  localStorage.setItem('filigranas.destino', 'inicio');
  localStorage.setItem('filigranas.movimiento', 'completo');
  localStorage.setItem('filigranas.campo', '1');
  await import('../src/main.tsx');
  const deadline = Date.now() + 9000;
  let canvas;
  while (Date.now() < deadline) {
    canvas = document.querySelector('.tr-field canvas');
    if (canvas?.width === innerWidth && canvas?.height === innerHeight) break;
    await sleep(30);
  }
  if (!canvas || canvas.width !== innerWidth || canvas.height !== innerHeight) {
    throw new Error('La prueba de comparación requiere el lienzo nativo a escala 1×');
  }
  await sleep(100);
  const idlePng = canvas.toDataURL();
  const { useReportActivity } = await import('../src/ui');
  const { createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  function Activity() {
    useReportActivity('coach', 'en marcha');
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const fixture = createRoot(host);
  const intervals = [];
  let previous = performance.now(), frame;
  const tick = (now) => {
    intervals.push(now - previous);
    previous = now;
    frame = requestAnimationFrame(tick);
  };
  fixture.render(createElement(Activity));
  frame = requestAnimationFrame(tick);
  try {
    await sleep(3500);
    const livePng = canvas.toDataURL();
    if (livePng === idlePng) throw new Error('El campo no respondió a la actividad');
    const sorted = intervals.toSorted((a, b) => a - b);
    const active = { samples: sorted.length, p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]), maxMs: Math.round(sorted.at(-1)) };
    sessionStorage.setItem('trama.campo.prueba', JSON.stringify({ idlePng, active }));
  } finally {
    fixture.unmount();
    host.remove();
    cancelAnimationFrame(frame);
  }
  location.assign('/__trama_campo_referencia');
}

try { await measure(); }
catch (error) { await fetch('/__perfil_trama', { method: 'POST', body: JSON.stringify({ error: String(error) }) }); }
