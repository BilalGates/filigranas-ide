import { design } from '../src/ipc';

export async function captureStudioState(project, { button, destination, until, visible }) {
  const path = '/docs/trama-aceptacion-final/evidencias/fixture-studio/';
  const spec = await fetch(`${path}manifest.json`).then((response) => response.json());
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
  await until(() => button(`Abrir ${project.name}`)).then((el) => el.click());
  await until(() => button(`Proyectos · ${project.name}`));
  destination('Studio');
  const back = await until(() => visible('.studio .slist') || button('Pantallas y versiones'));
  if (back.matches('button')) back.click();
  await until(() => [...document.querySelectorAll('.studio .scrn')].find((item) => item.textContent.trim().startsWith('Panel de Git')))
    .then((el) => el.click());
  await until(() => visible('.studio .ver'));
  const cards = [...document.querySelectorAll('.studio .ver')];
  const selected = cards.find((item) => item.textContent.trim().startsWith('v3 '));
  if (!selected) throw new Error('No aparece v3 de Studio');
  selected.click();
  await until(() => visible('.studio-stage img'));
  await until(() => { const image = visible('.studio-stage img'); return image?.complete && image.naturalWidth; });
  const controls = (selector) => {
    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
    return { x, y, width, height };
  };
  return {
    versions: versions.map(({ note, status, width, height }) => ({ note, status, width, height })),
    references: references.map((item) => item.name),
    selected: document.querySelector('.studio .ver.on')?.textContent.trim(),
    dimensions: Object.fromEntries(['.slist', '.canvasw', '.toolbar', '.studio-composer'].map((selector) => [selector, controls(selector)])),
  };
}

export async function captureLiveStudioState(project, { button, until, visible, navigate, report, read }) {
  const name = 'Panel de Git · En vivo';
  const readScreen = async () => (await design.list(project.path)).find((item) => item.name === name);
  let screen = await readScreen();
  if (!screen) {
    await design.save(project.path, { id: null, name, url: '', constraints: '', revision: null, approved: null });
    screen = await readScreen();
  }
  const path = '/docs/trama-aceptacion-final/evidencias/fixture-studio/manifest.json';
  const spec = await fetch(path).then((response) => response.json());
  let shots = (await design.shots(project.path, screen.id)).toReversed();
  for (let i = shots.length; i < 3; i++) {
    const url = new URL('/__trama_studio/' + (i + 1), location.origin).href;
    await design.save(project.path, { ...screen, url });
    const shot = await design.capture(project.path, screen.id, 620, 420, spec.versions[i].note);
    screen = await readScreen();
    shots = (await design.shots(project.path, screen.id)).toReversed();
    if (!shots.some((item) => item.id === shot && item.url === url)) throw new Error('La captura perdió su URL local');
  }
  if (!screen.constraints) {
    await design.save(project.path, { ...screen, constraints: '[bloqueo 0,0,100,10.5] [componente %23part-hdr] Cabecera' });
    screen = await readScreen();
  }
  if (screen.approved == null) {
    await design.review(project.path, screen.id, { shot: shots[2].id, baseline: null, revision: screen.revision, approve: true, confirmed: true });
  }
  await navigate('Flow');
  await navigate('Studio');
  const index = await until(() => [...document.querySelectorAll('.studio .scrn')].find((item) => item.textContent.trim().startsWith(name)), 'la pantalla local');
  index.click();
  await until(() => [...document.querySelectorAll('.studio .ver')].find((item) => item.textContent.trim().startsWith('v3 ')), 'la versión local aprobada').then((element) => element.click());
  let event;
  const track = (e) => {
    const frame = document.querySelector('iframe.studio-live');
    if (e.source === frame?.contentWindow && e.origin === 'null' && e.data?.tramaStudio) event = e.data;
  };
  window.addEventListener('message', track);
  try {
    await until(() => button('Vista en vivo'), 'el control Vista en vivo').then((element) => element.click());
    const frame = await until(() => visible('iframe.studio-live'), 'el lienzo en vivo');
    await until(() => event?.tramaStudio === 'lista', 'la página de la versión ejecutada dentro del lienzo');
    if (event.ipc !== 'undefined' || frame.contentDocument !== null) throw new Error('La vista local debe estar aislada del documento y del IPC');
    const components = await design.components(project.path, screen.id, shots[2].id);
    const expected = components.find((item) => item.name === 'Lista de cambios');
    if (!expected || expected.width !== 262 || expected.height !== 206) throw new Error('La geometría capturada no coincide con la región local');
    const select = await until(() => visible('.studio-components select'), 'los componentes reconocidos');
    select.value = expected.selector;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => visible('.studio-component-box.selected')?.textContent === 'Lista de cambios', 'el contorno de la lista en el lienzo');
    await until(() => visible('.lockbox[aria-label="Bloqueado · Cabecera"]'), 'la protección de la cabecera');
    report.views['studio-en-vivo'] = { selected: expected.name, rect: [expected.x, expected.y, expected.width, expected.height], isolated: true };
    await read('studio-en-vivo');
    button('Interactuar').click();
    await until(() => getComputedStyle(frame).pointerEvents === 'auto', 'el modo de interacción');
    frame.contentWindow.postMessage('trama:archivos', '*');
    await until(() => event?.tramaStudio === 'Archivos', 'la selección de Archivos con un clic dentro de Studio');
    report.views['studio-en-vivo'].click = event.tramaStudio;
    button('Vista en vivo').click();
    await until(() => !document.querySelector('iframe.studio-live'), 'la vuelta a la versión guardada');
  } finally { window.removeEventListener('message', track); }
}
