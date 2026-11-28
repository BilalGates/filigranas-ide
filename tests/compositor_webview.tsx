// Recorrido nativo del Compositor inteligente en WKWebView (perfil aislado).
// Monta el Composer real contra el núcleo en Rust, con repositorios Git y
// SQLite reales. Véase tests/compositor_nativo.mjs.
import { getIdentifier } from '@tauri-apps/api/app';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import '../src/trama/fonts.css';
import '../src/trama/trama.css';
import '../src/trama/artifact.css';
import '../src/trama/shell.css';
import { Composer, type ComposerAssist } from '../src/Conversation';
import { api, composer, health, tasks, type CItem, type ComposerSettings } from '../src/ipc';
import { setComposerSettings } from '../src/composerStore';

type Check = { name: string; ok: boolean; detail?: unknown };
const checks: Check[] = [];
const timings: Record<string, number> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, detail }); };
const report = (extra: object = {}) => fetch('/__compositor_resultado', { method: 'POST', body: JSON.stringify({ checks, timings, failed: checks.filter((c) => !c.ok).length, ...extra }) });
async function waitFor<T>(fn: () => T, ms = 6000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(40); }
  return null;
}
const msgs = (...pairs: [string, string][]) => pairs.map(([role, text]) => ({ role: role as 'user' | 'assistant', text }));
const items = (...pairs: [string, string][]): CItem[] => pairs.map(([role, text], i) => ({ id: `i${i}${text.length}`, type: role === 'user' ? 'userMessage' : 'agentMessage', text }));

async function run() {
  if (await getIdentifier() !== 'com.filigranas.ide.compositor') throw new Error('Se requiere el perfil aislado com.filigranas.ide.compositor');
  const root = import.meta.env.VITE_COMPOSITOR_ROOT as string;
  if (!/^\/(?:private\/)?tmp\/compositor-[^/]+\/repos$/.test(root ?? '')) throw new Error('Raíz de prueba inválida');
  const ws = await api.setRoot(root);
  const path = (name: string) => ws.projects.find((p) => p.name === name)!.path;
  const [alfa, beta, gamma] = ['alfa', 'beta', 'gamma'].map(path);
  const base: ComposerSettings = await composer.settings();
  check('ajustes por defecto: activado y solo local', base.enabled && base.suggestions && !base.ai && !base.jev, base);
  const configure = async (patch: Partial<ComposerSettings>) => setComposerSettings(await composer.configure({ ...base, ...patch }));
  await configure({ resume: false });

  // Estado real de Flow y Entrega en beta: tarea bloqueada y auditoría con un error.
  await tasks.save(beta, { id: null, parentId: null, title: 'Migrar pagos', goal: 'Migrar el módulo de pagos', criteria: 'pruebas verdes', priority: 'normal', risk: 'low', status: 'blocked', verification: '', tests: null, dependencies: [] });
  await health.import(beta, null, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'lint', rules: [{ id: 'no-eval' }] } }, results: [{ ruleId: 'no-eval', level: 'error', message: { text: 'eval' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'README.md' }, region: { startLine: 1 } } }] }] }] }));

  const suggest = async (project: string, event: 'turn_end' | 'resume', messages: ReturnType<typeof msgs>, scope = `pm:${project}`) => {
    const t = performance.now();
    const s = await composer.suggest({ project, scope, event, session: null, task: null, messages });
    return { s, ms: Math.round(performance.now() - t) };
  };

  // ── Nivel 1: reglas locales sobre el estado real ──
  let r = await suggest(alfa, 'turn_end', msgs(['user', 'Añade la nota'], ['assistant', 'He aplicado los cambios en notas.md.']));
  timings.local = r.ms;
  check('cambios sin verificar → verificar y revisar (PM delega)', r.s?.action === 'verify_and_review' && r.s.source === 'local' && r.s.text.startsWith('Delega'), r);
  r = await suggest(alfa, 'turn_end', msgs(['assistant', 'Hecho. Las pruebas pasan.']));
  check('implementación verificada → Larry prepara el commit', r.s?.action === 'prepare_commit' && r.s.text.includes('Larry'), r);
  r = await suggest(beta, 'turn_end', msgs(['assistant', 'Revisión terminada.']));
  check('auditoría real con error → delegar corrección y nueva auditoría', r.s?.action === 'fix_audit' && r.s.text.includes('nueva auditoría'), r);
  r = await suggest(gamma, 'turn_end', msgs(['user', 'Planifica'], ['assistant', 'Este es el plan:\n1. Crear el esquema\n2. Migrar\n3. Revisar']));
  check('plan del PM → aprobar y delegar', r.s?.action === 'approve_plan', r);
  r = await suggest(gamma, 'turn_end', msgs(['assistant', '¿Prefieres SQLite o Postgres?']));
  check('pregunta abierta → sin sugerencia forzada', r.s === null, r);
  await configure({ resume: true });
  r = await suggest(gamma, 'resume', msgs(['user', 'Seguimos'], ['assistant', 'Quedó a medias el esquema.']));
  await configure({ resume: false });
  check('aislamiento: gamma no ve la tarea ni la auditoría de beta', r.s?.action === 'resume_work' && !r.s.text.includes('Migrar pagos') && !r.s.text.includes('auditoría'), r);
  r = await suggest(gamma, 'turn_end', msgs(['assistant', 'He revisado el README; la sección de instalación está desactualizada.']));
  const before = await composer.usage();
  check('solo local: sin regla no hay sugerencia ni llamada a modelos', r.s === null && before.calls === 0, { r, before });
  await configure({ resume: false, enabled: false });
  r = await suggest(alfa, 'turn_end', msgs(['assistant', 'He aplicado los cambios.']));
  check('desactivado en Ajustes → nada', r.s === null, r);

  // ── Nivel 3: modelo ligero (Claude Haiku, credenciales del usuario) ──
  await configure({ resume: false, ai: true, provider: 'claude' });
  const readme = msgs(['user', 'Revisa la documentación'], ['assistant', 'He revisado el README; la sección de instalación está desactualizada y faltan los pasos de pnpm.']);
  r = await suggest(gamma, 'turn_end', readme);
  timings.claude = r.ms;
  check('sin regla y con IA → redacta Claude', r.s?.source === 'claude' && r.s.text.length > 10, r);
  const usage1 = await composer.usage();
  r = await suggest(gamma, 'turn_end', readme);
  timings.cache = r.ms;
  const usage2 = await composer.usage();
  check('caché contextual: misma situación sin otra llamada', usage2.calls === usage1.calls && r.ms < 400, { ms: r.ms, usage1, usage2 });
  const pending = suggest(gamma, 'turn_end', msgs(['assistant', `He terminado de revisar el changelog ${Date.now()}.`]));
  await sleep(300);
  await composer.cancel(`pm:${gamma}`);
  r = await pending;
  timings.cancel = r.ms;
  check('cancelación de una generación pendiente', r.s === null && r.ms < 3000, r);
  const t = performance.now();
  const improved = await composer.improve({ project: beta, scope: `pm:${beta}`, session: null, task: null, messages: msgs(['assistant', 'La auditoría encontró un error no-eval en README.md.']), text: 'Arregla los errores' });
  timings.improve = Math.round(performance.now() - t);
  check('mejorar prompt: preciso, sin ampliar el alcance', improved.text !== 'Arregla los errores' && !/push|merge|permiso/i.test(improved.text), improved);

  // ── Compositor real en la ventana ──
  const sent: string[] = [];
  let set: (s: { key: string; assist: ComposerAssist; running: boolean }) => void = () => {};
  const assistOf = (project: string, its: CItem[]): ComposerAssist => ({ project, session: null, task: null, items: its });
  function Harness() {
    const [state, setState] = useState({ key: `pm:${alfa}`, assist: assistOf(alfa, items(['user', 'Añade la nota'], ['assistant', 'He aplicado los cambios en notas.md.'])), running: false });
    set = setState;
    return <div className="tv" style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: '#0b0c0f' }}>
      <div style={{ width: 760 }}>
        <Composer draftKey={state.key} assist={state.assist} running={state.running} disabled={false} placeholder="/filigranas"
          onSend={async (text) => { sent.push(text); }} onInterrupt={() => {}} />
      </div>
    </div>;
  }
  await configure({ resume: false, ai: false });
  const host = document.createElement('div');
  document.body.append(host);
  createRoot(host).render(<Harness />);
  await sleep(300);
  const area = () => document.querySelector<HTMLTextAreaElement>('.co-compose textarea')!;
  const ghost = () => document.querySelector('.co-ghost')?.firstChild?.textContent ?? null;
  const key = (k: string, extra: KeyboardEventInit = {}) => area().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  let current = { key: `pm:${alfa}`, assist: assistOf(alfa, items(['user', 'Añade la nota'], ['assistant', 'He aplicado los cambios en notas.md.'])), running: false };
  const show = async (next: Partial<typeof current>) => { current = { ...current, ...next }; set(current); await sleep(60); };
  const turn = async () => { await show({ running: true }); await show({ running: false }); };
  const clear = () => { area().focus(); area().select(); document.execCommand('delete'); };

  await turn();
  const g1 = await waitFor(ghost);
  check('UI: sugerencia automática tras la respuesta', !!g1 && area().value === '' && area().placeholder === '', g1);
  key('Tab');
  await sleep(50);
  check('UI: Tab acepta e incorpora al compositor', area().value === g1 && ghost() === null && sent.length === 0, area().value);
  area().focus(); document.execCommand('insertText', false, ' Después, avísame.');
  check('UI: la sugerencia aceptada se edita libremente', area().value === `${g1} Después, avísame.`, area().value);
  clear();
  await turn();
  await waitFor(ghost);
  key('Escape');
  await sleep(50);
  check('UI: Escape descarta', ghost() === null && area().value === '');
  await turn();
  await sleep(1500);
  check('UI: lo descartado no reaparece', ghost() === null);

  await show({ key: `pm:${gamma}`, assist: assistOf(gamma, items(['user', 'Planifica'], ['assistant', 'Este es el plan:\n1. Crear el esquema\n2. Migrar\n3. Revisar'])) });
  await turn();
  const g2 = await waitFor(ghost);
  area().focus(); document.execCommand('insertText', false, 'Vale');
  await sleep(50);
  check('UI: escribir sustituye la sugerencia', !!g2 && ghost() === null && area().value === 'Vale', { g2, value: area().value });
  await turn();
  await sleep(1500);
  check('UI: un borrador existente no se sobrescribe', ghost() === null && area().value === 'Vale', area().value);
  clear();

  await configure({ resume: false, ai: true, provider: 'claude' });
  await show({ key: `pm:${gamma}`, assist: assistOf(gamma, items(['user', 'Revisa la documentación'], ['assistant', `He revisado la guía de despliegue ${Date.now()}; hay pasos obsoletos.`])) });
  await turn();
  await sleep(700); // generación de Claude en curso
  await show({ key: `pm:${beta}`, assist: assistOf(beta, []) });
  await sleep(4500);
  check('UI: cambio rápido de conversación descarta el resultado anterior', ghost() === null && area().value === '', ghost());

  area().focus(); document.execCommand('insertText', false, 'Arregla los errores');
  area().focus();
  area().dispatchEvent(new KeyboardEvent('keydown', { key: 'I', code: 'KeyI', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  const better = await waitFor(() => area().value !== 'Arregla los errores' && area().value, 20000);
  const restore = await waitFor(() => document.querySelector<HTMLButtonElement>('.co-restore'), 2000);
  check('UI: ⌘⇧I mejora el prompt sin enviarlo', !!better && !!restore && sent.length === 0, better);
  restore?.click();
  await sleep(50);
  check('UI: recuperar el texto original', area().value === 'Arregla los errores', area().value);
  clear();

  // ── Proveedor desconectado y límite agotado ──
  const used = (await composer.usage()).calls;
  await configure({ resume: false, ai: true, provider: 'claude', dailyLimit: Math.max(1, used) });
  r = await suggest(gamma, 'turn_end', msgs(['assistant', `Revisé los logs ${Date.now()}.`]));
  const limited = await composer.improve({ project: beta, scope: `pm:${beta}`, session: null, task: null, messages: [], text: 'Arregla los errores' }).then(() => 'ok', String);
  r = { ...r, s: r.s };
  const local = await suggest(beta, 'turn_end', msgs(['assistant', 'Fin.']));
  check('límite agotado: sin llamadas, la regla local sigue', r.s === null && /límite/.test(limited) && local.s?.source === 'local', { r, limited, local });
  await configure({ resume: false, ai: true, provider: 'claude', model: 'claude-inexistente-9' });
  r = await suggest(gamma, 'turn_end', msgs(['assistant', `Revisé las métricas ${Date.now()}.`]));
  check('proveedor no disponible: sin sugerencia ni error', r.s === null, r);
  const finalUsage = await composer.usage();
  check('consumo separado de las sesiones principales', finalUsage.calls > 0 && finalUsage.providers.some(([p]) => p === 'claude'), finalUsage);

  // Estado final para la captura: sugerencia visible.
  await configure({ resume: false, ai: false });
  await show({ key: `pm:${alfa}:captura`, assist: assistOf(alfa, items(['user', 'Añade la nota'], ['assistant', 'He aplicado los cambios en notas.md.'])) });
  await turn();
  check('UI: estado final con sugerencia visible', !!(await waitFor(ghost)));
  await configure({});
  await report({ sent });
}

run().catch((error) => report({ error: String(error?.stack ?? error) }));
