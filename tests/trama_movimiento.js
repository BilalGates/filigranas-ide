export async function verifyMotion({ button, destination, sleep, until, visible }) {
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
  const observations = [];
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
      observations.push({ value, effective, saved, working, thinking, permission, flow, ambient });
    }
  } finally {
    fixture.unmount();
    container.remove();
  }
  return observations;
}
