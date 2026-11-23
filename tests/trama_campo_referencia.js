async function compare() {
  const initial = JSON.parse(sessionStorage.getItem('trama.campo.prueba'));
  sessionStorage.removeItem('trama.campo.prueba');
  F.on = false;
  F.int = 1;
  S.view = 'home';
  AG.forEach((agent) => { agent.state = 'idle'; });
  fieldSize();
  fieldDraw(0);
  const width = F.cv.width, height = F.cv.height;

  async function pixels(data) {
    const img = new Image();
    img.src = data;
    await img.decode();
    if (img.width !== width || img.height !== height) throw new Error('Los lienzos tienen tamaños distintos');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, width, height).data;
  }

  const [native, reference] = await Promise.all([pixels(initial.idlePng), pixels(F.cv.toDataURL())]);
  let differences = 0, maxChannelDelta = 0;
  for (let i = 0; i < native.length; i += 4) {
    const delta = Math.max(
      Math.abs(native[i] - reference[i]), Math.abs(native[i + 1] - reference[i + 1]),
      Math.abs(native[i + 2] - reference[i + 2]), Math.abs(native[i + 3] - reference[i + 3]),
    );
    if (delta) differences++;
    maxChannelDelta = Math.max(maxChannelDelta, delta);
  }
  return { width, height, differences, maxChannelDelta, active: initial.active };
}

let result;
try { result = await compare(); } catch (error) { result = { error: String(error) }; }
await fetch('/__perfil_trama', { method: 'POST', body: JSON.stringify(result) });
