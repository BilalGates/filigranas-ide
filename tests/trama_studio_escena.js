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
  await until(() => button('Pantallas y versiones')).then((el) => el.click());
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
