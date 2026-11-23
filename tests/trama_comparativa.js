export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check, description, timeout = 12000) {
  const expires = performance.now() + timeout;
  while (performance.now() < expires) {
    const result = await check();
    if (result) return result;
    await sleep(40);
  }
  throw new Error(`No se alcanzó ${description}`);
}

export async function post(report) {
  const response = await fetch('/__perfil_trama', { method: 'POST', body: JSON.stringify(report) });
  if (!response.ok) throw new Error('No se pudo guardar el estado de la comparativa');
}

export async function capture(report, view, selector) {
  await document.fonts.ready;
  await sleep(700);
  const elements = [selector].flat().map((part) => document.querySelector(part)).filter((element) => element?.getClientRects().length);
  if (!elements.length) throw new Error(`Superficie no disponible: ${selector}`);
  const rects = elements.map((item) => item.getBoundingClientRect());
  const x = Math.min(...rects.map((rect) => rect.left));
  const y = Math.min(...rects.map((rect) => rect.top));
  const width = Math.max(...rects.map((rect) => rect.right)) - x;
  const height = Math.max(...rects.map((rect) => rect.bottom)) - y;
  report.views[view].viewport = { width: innerWidth, height: innerHeight, scale: devicePixelRatio };
  report.views[view].body = { x, y, width, height };
  if (report.side === 'native' && (view === 'workspace' || view === 'workspace-arquitectura')) {
    const diagram = document.querySelector('.co-architecture').getBoundingClientRect();
    report.views[view].diagram = { x: diagram.x, y: diagram.y, width: diagram.width, height: diagram.height };
  }
  report.ready = view;
  await post(report);
  const name = report.side + '-' + view;
  await until(async () => (await fetch('/__trama_capturada/' + name)).ok, name, 45000);
}

export async function frames(duration) {
  const times = [];
  return new Promise((resolve) => {
    const start = performance.now();
    let previous;
    function frame(now) {
      if (previous !== undefined) times.push(now - previous);
      previous = now;
      if (now - start < duration) requestAnimationFrame(frame);
      else {
        const ordered = times.toSorted((a, b) => a - b);
        resolve({
          frames: times.length,
          elapsedMs: Math.round(now - start),
          p95Ms: Math.round(ordered[Math.ceil(ordered.length * 0.95) - 1]),
          maxMs: Math.round(ordered.at(-1)),
          over50ms: times.filter((ms) => ms > 50).length,
        });
      }
    }
    requestAnimationFrame(frame);
  });
}

export async function canvasHash(canvas) {
  const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
