import { design, type ChatEngine } from './ipc';
import { canvasPrompt, readCanvasReply, saveCanvas, type CanvasFrame, type CanvasPair } from './designCanvasModel';

export const CANVAS_ENGINES: Record<ChatEngine, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' };
export const canvasRuns = new Map<string, { engine: ChatEngine; result: Promise<CanvasPair> }>();

export function generateCanvas(project: string, reference: CanvasFrame, request: string, engine: ChatEngine) {
  const running = canvasRuns.get(project);
  if (running) return running;
  const result = design.generate(project, canvasPrompt(reference, request), engine).then((reply) => {
    const pair = readCanvasReply(reply, reference);
    saveCanvas(project, pair);
    return pair;
  }).finally(() => canvasRuns.delete(project));
  const run = { engine, result };
  canvasRuns.set(project, run);
  return run;
}
