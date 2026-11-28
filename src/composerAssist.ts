// Lógica pura del Compositor inteligente (sin React ni IPC) para poder
// probarla aislada. La sugerencia es texto provisional: nunca se envía sola
// ni sustituye un borrador existente.

export type AssistItem = { type: string; text?: string; content?: { type: string; text?: string }[] };
export type AssistMessage = { role: 'user' | 'assistant'; text: string };

const MAX_MESSAGES = 6;
const MAX_CHARS = 1200;

/** Últimos mensajes de la conversación, recortados, sin herramientas ni salidas. */
export function assistMessages(items: readonly AssistItem[]): AssistMessage[] {
  const out: AssistMessage[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < MAX_MESSAGES; i--) {
    const item = items[i];
    const role = item.type === 'userMessage' ? 'user' : item.type === 'agentMessage' ? 'assistant' : null;
    if (!role) continue;
    const text = (item.text ?? item.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') ?? '').trim();
    if (text) out.unshift({ role, text: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text });
  }
  return out;
}

/** Solo se sugiere sobre un compositor vacío y en reposo. */
export function canSuggest(state: { value: string; attachments: number; queued: number; running: boolean; disabled: boolean; busy: boolean }) {
  return !state.value.trim() && state.attachments === 0 && state.queued === 0 && !state.running && !state.disabled && !state.busy;
}

type Keyish = { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing?: boolean };

/** Qué hace una tecla con una sugerencia visible. `null`: comportamiento normal. */
export function ghostKey(e: Keyish, ghost: string | null, value: string): 'accept' | 'dismiss' | null {
  if (!ghost || e.isComposing || value.trim()) return null;
  if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) return 'accept';
  if (e.key === 'Escape' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) return 'dismiss';
  return null;
}

/** Un resultado solo vale para la petición vigente del mismo borrador. */
export function isCurrent(token: { scope: string; seq: number }, current: { scope: string; seq: number }) {
  return token.scope === current.scope && token.seq === current.seq;
}

/** Decide si mostrar un resultado que llega tarde. */
export function acceptResult(text: string | null | undefined, state: { value: string; dismissed: ReadonlySet<string>; running: boolean }) {
  if (!text || state.running || state.value.trim()) return null;
  return state.dismissed.has(text) ? null : text;
}
