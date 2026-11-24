import { getIdentifier } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { api, coordinator, sessions, tasks, workSessions } from '../src/ipc';

const report = { scope: 'aislamiento de tareas con proveedores autenticados' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const file = 'marca.txt';

async function run() {
  const identifier = 'com.filigranas.ide.trama-agentes';
  if (await getIdentifier() !== identifier) throw new Error('Se requiere el perfil aislado de agentes');
  const root = import.meta.env.VITE_TRAMA_AGENT_ROOT;
  if (!/^\/(?:private\/)?tmp\/trama-agentes-[^/]+\/repos$/.test(root ?? '')) throw new Error('Raíz de prueba inválida');
  const sent = `trama.agentes.enviado:${root}`;
  if (sessionStorage.getItem(sent)) throw new Error('Esta ventana ya envió la prueba. Usa el resultado anterior.');
  const ws = await api.setRoot(root);
  const project = ws.projects.find((item) => item.name === 'trama-agentes-fixture')?.path;
  if (ws.projects.length !== 1 || !project) throw new Error('Proyecto de prueba inesperado');
  const before = await workSessions.current(project);
  if (!before) await workSessions.start(project, 'Validar el aislamiento', 'test', 'agentes-aislados', true);
  localStorage.setItem('filigranas.destino', 'inicio');
  await import('../src/main.tsx');

  const agents = [];
  const permission = [];
  const offClaude = await listen('session', ({ payload }) => {
    const agent = agents.find((item) => item.session.engine === 'claude' && payload.id === item.session.id);
    const { msg } = payload;
    if (!agent || msg.type !== 'control_request' || msg.request?.subtype !== 'can_use_tool') return;
    const { input, tool_name: tool } = msg.request;
    const allowed = (tool === 'Write' || tool === 'Edit') && input?.file_path === `${agent.session.worktree}/${file}`
      && (input.content ?? input.new_string)?.trim() === agent.marker;
    permission.push({ provider: 'claude', tool, decision: allowed ? 'accept' : 'decline' });
    void sessions.respond(msg.request_id, allowed ? 'accept' : 'decline');
  });
  const offCodex = await listen('coordinator', ({ payload }) => {
    if (!payload.requestId || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(payload.method)) return;
    permission.push({ provider: 'codex', tool: payload.method, decision: 'decline' });
    void coordinator.respond(payload.requestId, 'decline');
  });
  let frame;
  try {
    for (const [engine, marker] of [['claude', 'TRAMA-CLAUDE'], ['codex', 'TRAMA-CODEX']]) {
      const id = await tasks.save(project, { id: null, parentId: null, title: `Prueba ${engine}`,
        goal: 'Validar el aislamiento de una edición sintética', criteria: 'Cambiar una sola línea',
        priority: 'normal', risk: 'normal', status: 'ready', verification: '', tests: null, dependencies: [] });
      const session = await sessions.create(project, engine, id);
      if (!session.worktree || !session.branch?.startsWith('ide/') || session.worktree === project) {
        throw new Error('La tarea se abrió sin copia aislada');
      }
      await workSessions.assign(project, session.id, [file]);
      agents.push({ id, session, marker });
    }
    if (agents[0].session.worktree === agents[1].session.worktree) throw new Error('Los agentes comparten una copia');

    const frames = [];
    let previous = performance.now();
    const tick = (time) => {
      frames.push(time - previous);
      previous = time;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const start = (agent) => sessions.send(agent.session.id, [
      'Prueba local autorizada con datos sintéticos.',
      `Edita únicamente el archivo ${file} de tu carpeta de trabajo actual.`,
      `Sustituye la línea TRAMA-BASE por exactamente ${agent.marker}, seguida de un salto de línea.`,
      'Usa la herramienta de edición de archivos. Evita comandos de terminal, red y Git.',
      'Al terminar, responde solo HECHO.',
    ].join(' '), null, agent.id, [], agent.session.engine);

    sessionStorage.setItem(sent, "1");
    await start(agents[0]);
    await start(agents[1]);
    const open = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Abrir trama-agentes-fixture');
    open?.click();
    const navigation = [];
    const expires = Date.now() + 120_000;
    let runs;
    while (Date.now() < expires) {
      const snapshot = await tasks.flow(project);
      runs = agents.map((agent) => snapshot.runs[agent.id]?.[0]);
      if (runs.every((item) => item?.durationMs != null)) break;
      for (const [name, selector] of [['Flow', 'main[aria-label="Flow"]'], ['Inicio', 'main[aria-label="Inicio"]']]) {
        const target = document.querySelector(`.tr-nav button[aria-label^="${name} ("]`);
        if (!target) continue;
        const start = performance.now();
        target.click();
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        if (document.querySelector(selector)) navigation.push(performance.now() - start);
      }
      await sleep(750);
    }
    cancelAnimationFrame(frame);
    const intervals = runs.map((item) => item && { provider: item.provider, startedMs: item.startedMs, durationMs: item.durationMs, outcome: item.outcome });
    report.turns = intervals;
    report.permissions = permission;
    const quantile = (values, p) => Math.round(values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? 0);
    report.animation = { samples: frames.length, p95Ms: quantile(frames, 0.95), maxMs: quantile(frames, 1) };
    report.navigation = { samples: navigation.length, p95Ms: quantile(navigation, 0.95), maxMs: quantile(navigation, 1) };
    if (intervals.some((turn) => turn?.outcome !== 'completed' || turn.durationMs == null)) {
      throw new Error('Un agente no terminó correctamente');
    }
    const [a, b] = intervals;
    report.overlapMs = Math.max(0, Math.min(a.startedMs + a.durationMs, b.startedMs + b.durationMs) - Math.max(a.startedMs, b.startedMs));
    const changes = await Promise.all(agents.map((agent) => sessions.diffTexts(agent.session.id, file, null)));
    report.independentContent = changes.every((change, i) => change.old.trim() === 'TRAMA-BASE' && change.new.trim() === agents[i].marker);
    if (!report.overlapMs || !report.independentContent) throw new Error('La concurrencia o el contenido aislado no coinciden');
  } finally {
    if (frame !== undefined) cancelAnimationFrame(frame);
    offClaude();
    offCodex();
  }
}

try {
  await run();
} catch (error) {
  report.error = String(error);
}
await fetch('/__perfil_trama', { method: 'POST', body: JSON.stringify(report) });
