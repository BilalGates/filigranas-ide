// Presentación de los adjuntos de un mensaje: el proveedor recibe un bloque
// de texto con nombres y rutas locales; el hilo lo pinta como miniaturas y chips.

export const ATTACHMENTS_HEADER = 'Adjuntos del mensaje:';

export type ShownAttachment = { kind: 'image' | 'file' | 'link'; name: string; path?: string };

const IMAGE_NAME = /\.(png|jpe?g|webp|gif)$/i;
const readJson = (value: string) => {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
};

function parseLine(line: string): ShownAttachment | null {
  if (!line.startsWith('- ')) return null;
  const body = line.slice(2).trim();
  // Formato del backend: - Imagen "nombre" · ruta local: "ruta"
  const backend = /^(Imagen|Archivo) ("(?:[^"\\]|\\.)*") · ruta local: ("(?:[^"\\]|\\.)*")$/.exec(body);
  if (backend) {
    const name = readJson(backend[2]);
    const path = readJson(backend[3]);
    if (name === null || path === null) return null;
    return { kind: backend[1] === 'Imagen' ? 'image' : 'file', name, path };
  }
  if (!body) return null;
  if (/^https?:\/\//i.test(body)) return { kind: 'link', name: body };
  return { kind: IMAGE_NAME.test(body) ? 'image' : 'file', name: body };
}

/** Separa el bloque final de adjuntos del texto que escribió el usuario. */
export function splitAttachments(text: string): { text: string; attachments: ShownAttachment[] } {
  const at = text.lastIndexOf(ATTACHMENTS_HEADER);
  if (at < 0 || (at > 0 && !text.slice(0, at).endsWith('\n\n'))) return { text, attachments: [] };
  const lines = text.slice(at + ATTACHMENTS_HEADER.length).split('\n').filter((line, i) => i > 0 || line.trim());
  const attachments: ShownAttachment[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const item = parseLine(line);
    if (!item) return { text, attachments: [] };
    attachments.push(item);
  }
  if (!attachments.length) return { text, attachments: [] };
  return { text: text.slice(0, at).trimEnd(), attachments };
}

/** Mensaje encolado mientras el agente trabaja. */
export type Queued<A> = { id: number; text: string; attachments: A[] };

/**
 * Mensajes que se envían juntos al terminar el turno: el prefijo más largo de
 * la cola que respeta los límites de adjuntos (siempre al menos el primero).
 */
export function takeBatch<A>(queue: Queued<A>[], sizeOf: (a: A) => number, maxCount = 8, maxBytes = 20 * 1024 * 1024) {
  let count = 0, bytes = 0, end = 0;
  for (const item of queue) {
    const nextCount = count + item.attachments.length;
    const nextBytes = bytes + item.attachments.reduce((total, a) => total + sizeOf(a), 0);
    if (end > 0 && (nextCount > maxCount || nextBytes > maxBytes)) break;
    count = nextCount;
    bytes = nextBytes;
    end++;
  }
  const batch = queue.slice(0, end);
  return {
    batch,
    rest: queue.slice(end),
    text: batch.map((item) => item.text).filter(Boolean).join('\n\n'),
    attachments: batch.flatMap((item) => item.attachments),
  };
}
