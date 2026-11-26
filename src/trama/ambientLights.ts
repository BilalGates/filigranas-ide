export type AgentActivity = 'trabajando' | 'permiso' | null;
export type Rgb = readonly [number, number, number];

export type LightSource = {
  x: number;
  y: number;
  r: number;
  c: Rgb;
  a: number;
};

type AgentLight = {
  key: string;
  mode: 'trabajando' | 'permiso' | 'saliendo';
  x: number;
  y: number;
  r: number;
  coolColor: Rgb;
  /** Mezcla 0 = tono frío, 1 = ámbar de permiso/duda. */
  alertMix: number;
  /** Brillo actual suavizado para evitar saltos entre estados. */
  alpha: number;
  /** Tiempo en que empezó la estancia actual en esta sección. */
  stayStart: number;
  /** Duración total de la estancia (fade-in + respiración + fade-out). */
  stayDuration: number;
  /** Pausa breve a oscuras antes de reaparecer en otra sección. */
  darkPause: number;
  /** Periodo de respiración principal en ms. */
  breathPeriod: number;
  /** Fase inicial de respiración en radianes. */
  breathPhase: number;
  /** Momento relativo (0..1 de la estancia) en el que baja de intensidad. */
  dipAt: number;
  /** Profundidad de la bajada ocasional de intensidad (0..1). */
  dipDepth: number;
  /** Ancho relativo de la bajada de intensidad. */
  dipWidth: number;
};

export const COOL_PALETTE: readonly Rgb[] = [
  [68, 108, 240],  // azul índigo Trama
  [118, 168, 255], // celeste (--skyhi)
  [146, 122, 248], // violeta frío (--violet)
  [92, 134, 245],  // azul (--sky)
  [126, 148, 255], // azul lavanda
  [104, 186, 242], // azul glaciar
];

export const PERMISSION_COLOR: Rgb = [255, 178, 94]; // --amber

const MARGIN = 0.08;
const CANDIDATES = 16;
const FADE_IN_MS = 1100;
const FADE_OUT_MS = 1300;
const LEAVE_MS = 900;
const PERMISSION_SETTLE_MS = 550;
const ALERT_TRANSITION_MS = 450;

const WORKING_PEAK_ALPHA = 0.50;
const WORKING_STATIC_ALPHA = 0.36;
const PERMISSION_ALPHA = 0.64;
const PERMISSION_RADIUS = 0.32;
const EPSILON = 0.004;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function moveToward(current: number, target: number, maxDelta: number) {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

function pickColor(key: string, used: Set<number>, rand: () => number): Rgb {
  const free: number[] = [];
  for (let i = 0; i < COOL_PALETTE.length; i++) {
    if (!used.has(i)) free.push(i);
  }
  if (free.length > 0) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    const index = free[Math.abs(hash + Math.floor(rand() * free.length)) % free.length];
    return COOL_PALETTE[index];
  }
  return COOL_PALETTE[Math.floor(rand() * COOL_PALETTE.length)];
}

function pickSection(
  others: readonly { x: number; y: number }[],
  previous: { x: number; y: number } | null,
  rand: () => number,
): { x: number; y: number } {
  const span = 1 - MARGIN * 2;
  let best = { x: MARGIN + rand() * span, y: MARGIN + rand() * span };
  let bestScore = -1;
  for (let i = 0; i < CANDIDATES; i++) {
    const x = MARGIN + rand() * span;
    const y = MARGIN + rand() * span;
    let score = Infinity;
    for (const o of others) {
      const d = Math.hypot(x - o.x, y - o.y);
      if (d < score) score = d;
    }
    if (previous) {
      // Penaliza reaparecer demasiado cerca de la sección anterior.
      const prevDist = Math.hypot(x - previous.x, y - previous.y);
      const weighted = prevDist * 0.85;
      if (weighted < score) score = weighted;
    }
    if (!Number.isFinite(score)) return { x, y };
    if (score > bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  return best;
}

function randomStay(now: number, rand: () => number) {
  return {
    stayStart: now,
    stayDuration: 10_000 + rand() * 8_000,
    darkPause: 280 + rand() * 320,
    breathPeriod: 3_600 + rand() * 1_800,
    breathPhase: rand() * Math.PI * 2,
    dipAt: 0.28 + rand() * 0.44,
    dipDepth: 0.48 + rand() * 0.24,
    dipWidth: 0.14 + rand() * 0.08,
    r: 0.26 + rand() * 0.08,
  };
}

/**
 * Estado del campo ambiental por agente:
 * - En reposo (0 agentes) no emite ninguna luz.
 * - Cada agente trabajando ilumina una sección aleatoria con respiración,
 *   bajadas ocasionales de intensidad y reaparición periódica en otra zona.
 * - Cada agente con duda o esperando permiso brilla algo más intenso y fijo
 *   (sin parpadear ni cambiar de sitio) en tono ámbar.
 * - Al terminar, su luz se desvanece suavemente hasta desaparecer.
 */
export class AmbientLightField {
  private lights = new Map<string, AgentLight>();
  private lastTick: number | null = null;
  private rand: () => number;

  constructor(rand: () => number = Math.random) {
    this.rand = rand;
  }

  private otherPositions(excludeKey?: string) {
    const out: { x: number; y: number }[] = [];
    for (const light of this.lights.values()) {
      if (light.key !== excludeKey && light.mode !== 'saliendo') {
        out.push({ x: light.x, y: light.y });
      }
    }
    return out;
  }

  private usedColorIndices() {
    const used = new Set<number>();
    for (const light of this.lights.values()) {
      if (light.mode === 'saliendo') continue;
      const idx = COOL_PALETTE.indexOf(light.coolColor);
      if (idx >= 0) used.add(idx);
    }
    return used;
  }

  sync(activity: Record<string, AgentActivity>, now: number) {
    const activeKeys = new Set<string>();
    for (const [key, value] of Object.entries(activity)) {
      if (value !== 'trabajando' && value !== 'permiso') continue;
      activeKeys.add(key);
      const existing = this.lights.get(key);
      if (!existing) {
        const pos = pickSection(this.otherPositions(), null, this.rand);
        const stay = randomStay(now, this.rand);
        const coolColor = pickColor(key, this.usedColorIndices(), this.rand);
        this.lights.set(key, {
          key,
          mode: value,
          x: pos.x,
          y: pos.y,
          r: value === 'permiso' ? PERMISSION_RADIUS : stay.r,
          coolColor,
          alertMix: value === 'permiso' ? 1 : 0,
          alpha: 0,
          stayStart: stay.stayStart,
          stayDuration: stay.stayDuration,
          darkPause: stay.darkPause,
          breathPeriod: stay.breathPeriod,
          breathPhase: stay.breathPhase,
          dipAt: stay.dipAt,
          dipDepth: stay.dipDepth,
          dipWidth: stay.dipWidth,
        });
      } else if (existing.mode !== value) {
        const wasLeaving = existing.mode === 'saliendo';
        existing.mode = value;
        if (value === 'trabajando') {
          const stay = randomStay(now, this.rand);
          existing.stayStart = now - (wasLeaving ? 0 : FADE_IN_MS);
          existing.stayDuration = stay.stayDuration;
          existing.darkPause = stay.darkPause;
          existing.breathPeriod = stay.breathPeriod;
          existing.breathPhase = stay.breathPhase;
          existing.dipAt = stay.dipAt;
          existing.dipDepth = stay.dipDepth;
          existing.dipWidth = stay.dipWidth;
        }
      }
    }

    for (const light of this.lights.values()) {
      if (!activeKeys.has(light.key) && light.mode !== 'saliendo') {
        light.mode = 'saliendo';
      }
    }
  }

  /** Indica si el campo necesita seguir avanzando fotogramas en modo animado. */
  needsAnimation(): boolean {
    for (const light of this.lights.values()) {
      if (light.mode === 'trabajando' || light.mode === 'saliendo') return true;
      if (light.mode === 'permiso' && (Math.abs(light.alpha - PERMISSION_ALPHA) > EPSILON || light.alertMix < 0.999)) {
        return true;
      }
    }
    return false;
  }

  /** Calcula las fuentes gaussianas actuales y avanza las transiciones. */
  sample(now: number, live: boolean): LightSource[] {
    const dt = this.lastTick == null ? 0 : Math.max(0, Math.min(250, now - this.lastTick));
    this.lastTick = now;

    const sources: LightSource[] = [];
    const remove: string[] = [];

    for (const light of this.lights.values()) {
      if (light.mode === 'saliendo') {
        if (!live) {
          remove.push(light.key);
          continue;
        }
        const maxDelta = dt > 0 ? (WORKING_PEAK_ALPHA * dt) / LEAVE_MS : 0;
        light.alpha = Math.max(0, light.alpha - maxDelta);
        if (light.alpha <= EPSILON) {
          remove.push(light.key);
          continue;
        }
        const color = mixColor(light.coolColor, PERMISSION_COLOR, light.alertMix);
        sources.push({ x: light.x, y: light.y, r: light.r, c: color, a: light.alpha });
        continue;
      }

      const targetAlert = light.mode === 'permiso' ? 1 : 0;
      if (!live) {
        light.alertMix = targetAlert;
      } else {
        const mixStep = dt > 0 ? dt / ALERT_TRANSITION_MS : 0;
        light.alertMix = moveToward(light.alertMix, targetAlert, mixStep);
      }

      if (light.mode === 'permiso') {
        // Luz fija y algo más intensa: sin parpadeo ni cambio de sección.
        if (!live) {
          light.alpha = PERMISSION_ALPHA;
        } else {
          const step = dt > 0 ? (PERMISSION_ALPHA * dt) / PERMISSION_SETTLE_MS : PERMISSION_ALPHA * 0.15;
          light.alpha = moveToward(light.alpha, PERMISSION_ALPHA, step);
        }
        const color = mixColor(light.coolColor, PERMISSION_COLOR, light.alertMix);
        const radius = lerp(light.r, PERMISSION_RADIUS, light.alertMix);
        if (light.alpha > EPSILON) {
          sources.push({ x: light.x, y: light.y, r: radius, c: color, a: light.alpha });
        }
        continue;
      }

      // Modo trabajando: respiración + bajada ocasional + reaparición en nueva sección.
      if (!live) {
        light.alpha = WORKING_STATIC_ALPHA;
        sources.push({ x: light.x, y: light.y, r: light.r, c: light.coolColor, a: light.alpha });
        continue;
      }

      let elapsed = now - light.stayStart;
      const cycleTotal = light.stayDuration + light.darkPause;
      if (elapsed >= cycleTotal) {
        // Al acabar la pausa a oscuras, reaparece en una sección aleatoria distinta.
        const pos = pickSection(this.otherPositions(light.key), { x: light.x, y: light.y }, this.rand);
        const stay = randomStay(now, this.rand);
        light.x = pos.x;
        light.y = pos.y;
        light.r = stay.r;
        light.stayStart = now;
        light.stayDuration = stay.stayDuration;
        light.darkPause = stay.darkPause;
        light.breathPeriod = stay.breathPeriod;
        light.breathPhase = stay.breathPhase;
        light.dipAt = stay.dipAt;
        light.dipDepth = stay.dipDepth;
        light.dipWidth = stay.dipWidth;
        elapsed = 0;
      }

      if (elapsed >= light.stayDuration) {
        // Breve silencio a oscuras justo antes de reaparecer en otra zona.
        light.alpha = 0;
        continue;
      }

      let stayEnvelope = 1;
      if (elapsed < FADE_IN_MS) {
        stayEnvelope = smoothstep(elapsed / FADE_IN_MS);
      } else if (elapsed > light.stayDuration - FADE_OUT_MS) {
        stayEnvelope = smoothstep((light.stayDuration - elapsed) / FADE_OUT_MS);
      }

      // Respiración suave (0.52 .. 1.0)
      const breathWave = 0.5 + 0.5 * Math.sin((elapsed / light.breathPeriod) * Math.PI * 2 + light.breathPhase);
      const breath = 0.52 + 0.48 * breathWave;

      // Bajada ocasional de intensidad dentro de la estancia
      const progress = elapsed / light.stayDuration;
      const dipDist = (progress - light.dipAt) / light.dipWidth;
      const dip = 1 - light.dipDepth * Math.exp(-dipDist * dipDist);

      const targetAlpha = WORKING_PEAK_ALPHA * stayEnvelope * breath * dip;
      // Si viene de permiso (más alto), converge sin salto brusco.
      if (light.alertMix > 0 && dt > 0) {
        light.alpha = moveToward(light.alpha, targetAlpha, (PERMISSION_ALPHA * dt) / ALERT_TRANSITION_MS);
      } else {
        light.alpha = targetAlpha;
      }

      if (light.alpha > EPSILON) {
        const color = mixColor(light.coolColor, PERMISSION_COLOR, light.alertMix);
        sources.push({ x: light.x, y: light.y, r: light.r, c: color, a: light.alpha });
      }
    }

    for (const key of remove) this.lights.delete(key);
    return sources;
  }

  /** Solo para pruebas e inspección. */
  snapshot() {
    return [...this.lights.values()].map((l) => ({
      key: l.key,
      mode: l.mode,
      x: l.x,
      y: l.y,
      r: l.r,
      alertMix: l.alertMix,
      alpha: l.alpha,
    }));
  }
}

function mixColor(a: Rgb, b: Rgb, t: number): Rgb {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}
