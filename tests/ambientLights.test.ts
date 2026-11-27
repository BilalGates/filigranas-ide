import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AmbientLightField, COOL_PALETTE, PERMISSION_COLOR } from '../src/trama/ambientLights.ts';

function seeded(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

test('en reposo no emite ninguna luz ni necesita animación', () => {
  const field = new AmbientLightField(seeded(1));
  field.sync({}, 0);
  assert.equal(field.needsAnimation(), false);
  assert.deepEqual(field.sample(0, true), []);
  assert.deepEqual(field.sample(1000, true), []);
});

test('cuatro agentes trabajando encienden cuatro secciones distintas con tonos fríos', () => {
  const field = new AmbientLightField(seeded(7));
  field.sync({ coach: 'trabajando', '1': 'trabajando', '2': 'trabajando', '3': 'trabajando' }, 0);
  assert.equal(field.needsAnimation(), true);

  const sources = field.sample(1500, true);
  assert.equal(sources.length, 4);

  // Todas las luces deben usar tonos fríos de la paleta.
  for (const s of sources) {
    assert.ok(COOL_PALETTE.some((c) => c[0] === s.c[0] && c[1] === s.c[1] && c[2] === s.c[2]));
    assert.ok(s.x >= 0.08 && s.x <= 0.92);
    assert.ok(s.y >= 0.08 && s.y <= 0.92);
  }

  // Las cuatro secciones deben estar razonablemente separadas entre sí.
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const dist = Math.hypot(sources[i].x - sources[j].x, sources[i].y - sources[j].y);
      assert.ok(dist > 0.2, `secciones ${i} y ${j} demasiado juntas (${dist})`);
    }
  }
});

test('un agente trabajando respira, baja de intensidad y reaparece en otra sección aleatoria', () => {
  const field = new AmbientLightField(seeded(19));
  field.sync({ '1': 'trabajando' }, 0);

  const alphas: number[] = [];
  let initialPos: { x: number; y: number } | null = null;
  let sawDarkGap = false;
  let relocatedPos: { x: number; y: number } | null = null;

  for (let t = 0; t <= 22_000; t += 100) {
    const src = field.sample(t, true);
    if (src.length === 1) {
      if (!initialPos && t >= 1500) initialPos = { x: src[0].x, y: src[0].y };
      if (t >= 1200 && t <= 9000) alphas.push(src[0].a);
      if (sawDarkGap && !relocatedPos) relocatedPos = { x: src[0].x, y: src[0].y };
    } else if (initialPos && t > 5000 && src.length === 0) {
      sawDarkGap = true;
    }
  }

  assert.ok(initialPos, 'debe aparecer una luz inicial');
  const maxAlpha = Math.max(...alphas);
  const minAlpha = Math.min(...alphas);
  assert.ok(maxAlpha - minAlpha > 0.15, `la respiración y bajada de intensidad deben apreciarse (min=${minAlpha}, max=${maxAlpha})`);
  assert.ok(sawDarkGap, 'debe apagarse brevemente antes de reaparecer');
  assert.ok(relocatedPos, 'debe reaparecer tras el cambio de sección');
  const moved = Math.hypot(relocatedPos.x - initialPos.x, relocatedPos.y - initialPos.y);
  assert.ok(moved > 0.15, `debe reaparecer en otra zona distinta (distancia=${moved})`);
});

test('cuando un agente pide permiso brilla más intenso en ámbar y sin parpadear', () => {
  const field = new AmbientLightField(seeded(31));
  field.sync({ '1': 'trabajando', '2': 'permiso' }, 0);

  // Deja asentar la transición inicial de permiso (~550ms)
  let workMax = 0;
  for (let t = 0; t <= 1200; t += 100) {
    const src = field.sample(t, true);
    if (src.length >= 1) workMax = Math.max(workMax, src[0].a);
  }

  // Ahora deja solo el agente con permiso y verifica que queda fijo sin parpadear ni moverse
  field.sync({ '2': 'permiso' }, 1300);
  // Espera a que termine el fade-out del agente 1
  for (let t = 1400; t <= 2600; t += 100) field.sample(t, true);

  assert.equal(field.needsAnimation(), false, 'con permiso asentado no debe necesitar bucle de animación');

  const first = field.sample(2700, true);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].c, PERMISSION_COLOR);
  assert.ok(first[0].a > workMax, `la luz de permiso (${first[0].a}) debe brillar más que trabajando (${workMax})`);

  for (let t = 2800; t <= 12_000; t += 500) {
    const next = field.sample(t, true);
    assert.equal(next.length, 1);
    assert.equal(next[0].a, first[0].a, 'la luz de permiso no debe parpadear');
    assert.equal(next[0].x, first[0].x, 'la luz de permiso no debe cambiar de sitio');
    assert.equal(next[0].y, first[0].y, 'la luz de permiso no debe cambiar de sitio');
  }
});

test('cuando un agente termina su luz se apaga suavemente y desaparece', () => {
  const field = new AmbientLightField(seeded(55));
  field.sync({ '1': 'trabajando', '2': 'trabajando' }, 0);
  for (let t = 0; t <= 1500; t += 100) field.sample(t, true);

  // Termina el agente 1; el 2 sigue activo
  field.sync({ '2': 'trabajando' }, 1600);
  const fading = field.sample(1700, true);
  assert.equal(fading.length, 2, 'el agente que termina debe desvanecerse, no desaparecer de golpe');

  for (let t = 1800; t <= 3000; t += 100) field.sample(t, true);
  const remaining = field.sample(3100, true);
  assert.equal(remaining.length, 1, 'solo debe quedar la luz del agente 2');

  // Termina el agente 2; el fondo queda apagado
  field.sync({}, 3200);
  for (let t = 3300; t <= 4600; t += 100) field.sample(t, true);
  assert.deepEqual(field.sample(4700, true), []);
  assert.equal(field.needsAnimation(), false);
});

test('en modo estático no anima ni reubica luces', () => {
  const field = new AmbientLightField(seeded(99));
  field.sync({ coach: 'trabajando' }, 0);
  const a = field.sample(0, false);
  const b = field.sample(15_000, false);
  assert.deepEqual(a, b);
});
