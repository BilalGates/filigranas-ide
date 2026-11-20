import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { pathToFileURL } from 'node:url';

const token = () => randomBytes(32).toString('base64url');
const validToken = (value) => typeof value === 'string' && /^[\w-]{43}$/.test(value);
const validRevision = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inviteLifetime = 15 * 60_000;
const sessionLifetime = 8 * 60 * 60_000;
const heartbeatLifetime = 35_000;
const requestTimeout = 20_000;
const pollTimeout = 12_000;
const maxBody = 16 * 1024 * 1024;
const maxText = 2 * 1024 * 1024;

class RelayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new RelayError(413, 'mensaje demasiado grande');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // El cliente siempre envía un objeto JSON.
  }
  throw new RelayError(400, 'mensaje no válido');
}

function send(response, status, data) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}

function settle(waiter, value) {
  if (!waiter) return;
  clearTimeout(waiter.timer);
  waiter.resolve(value);
}

export function createRelay({ hostKey, tls } = {}) {
  if (!validToken(hostKey)) throw new Error('FILIGRANAS_RELAY_KEY debe tener 43 caracteres base64url');
  const key = Buffer.from(hostKey);
  const sessions = new Map();
  let receivingLargeRequests = 0;
  const routes = new Set(['create', 'join', 'next', 'reply', 'close', 'status', 'list', 'read', 'write', 'access', 'leave']);

  function close(id, session) {
    sessions.delete(id);
    settle(session.poll, null);
    settle(session.pending, { closed: true });
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.end <= now || session.lastSeen + 120_000 <= now) close(id, session);
    }
  }, 15_000).unref();

  async function dispatch(action, body, response) {
    const now = Date.now();
    if (action === 'create') {
      if (!validToken(body.key) || !timingSafeEqual(Buffer.from(body.key), key)) {
        throw new RelayError(403, 'clave del servicio incorrecta');
      }
      if (sessions.size >= 100) throw new RelayError(503, 'el servicio está lleno');
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) {
        throw new RelayError(400, 'nombre de proyecto no válido');
      }
      const id = token();
      const host = token();
      const invite = token();
      const expiresAt = now + inviteLifetime;
      sessions.set(id, {
        name: body.name, host, invite, expiresAt, end: now + sessionLifetime, lastSeen: now,
        guest: null, pending: null, poll: null, editable: body.editable === true,
      });
      return { id, host, invite, expiresAt, editable: body.editable === true };
    }

    const session = validToken(body.id) ? sessions.get(body.id) : null;
    if (!session) throw new RelayError(410, 'la sesión compartida ha terminado');
    if (session.end <= now) {
      close(body.id, session);
      throw new RelayError(410, 'la sesión compartida ha terminado');
    }
    const online = session.lastSeen + heartbeatLifetime > now;

    if (action === 'join') {
      if (session.invite === null || session.expiresAt <= now || body.key !== session.invite) {
        throw new RelayError(403, 'la invitación no es válida, ha caducado o ya se usó');
      }
      if (!online) throw new RelayError(503, 'el anfitrión está desconectado');
      session.invite = null;
      session.guest = token();
      return { guest: session.guest, name: session.name, editable: session.editable };
    }

    if (['next', 'reply', 'close', 'access'].includes(action)) {
      if (body.key !== session.host) throw new RelayError(403, 'acceso denegado');
      if (action === 'close') {
        close(body.id, session);
        return {};
      }
      session.lastSeen = now;
      if (action === 'access') {
        if (typeof body.editable !== 'boolean') throw new RelayError(400, 'permiso no válido');
        session.editable = body.editable;
        if (!session.editable && session.pending?.operation.action === 'write' && !session.pending.delivered) {
          settle(session.pending, { error: 'el anfitrión retiró el permiso de edición' });
          session.pending = null;
        }
        return { editable: session.editable };
      }
      if (action === 'reply') {
        const pending = session.pending;
        if (pending?.operation.id === body.request) {
          settle(pending, body.result);
          session.pending = null;
        }
        return {};
      }
      if (session.pending && !session.pending.delivered) {
        session.pending.delivered = true;
        return session.pending.operation;
      }
      if (session.poll) throw new RelayError(409, 'el anfitrión ya está conectado');
      return new Promise((resolve) => {
        const poll = {
          resolve,
          timer: setTimeout(() => {
            session.poll = null;
            resolve(null);
          }, pollTimeout),
        };
        session.poll = poll;
        response.once('close', () => {
          if (session.poll === poll) {
            session.poll = null;
            settle(poll, null);
          }
        });
      });
    }

    if (!session.guest || body.key !== session.guest) throw new RelayError(403, 'acceso denegado');
    if (action === 'status') return { online, editable: session.editable };
    if (action === 'leave') {
      close(body.id, session);
      return {};
    }
    if (!online) throw new RelayError(503, 'el anfitrión está desconectado');
    if (typeof body.path !== 'string' || body.path.length > 4096) throw new RelayError(400, 'ruta no válida');
    if (action === 'read' && body.revision != null && !validRevision(body.revision)) {
      throw new RelayError(400, 'versión del archivo no válida');
    }
    if (action === 'write') {
      if (!session.editable) throw new RelayError(403, 'el proyecto es de solo lectura');
      if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > maxText
          || !validRevision(body.revision)) {
        throw new RelayError(400, 'edición no válida');
      }
    }
    if (session.pending) throw new RelayError(409, 'hay otra operación en curso');

    const result = await new Promise((resolve) => {
      const operation = { id: token(), action, path: body.path };
      if (action === 'read' && body.revision != null) operation.revision = body.revision;
      if (action === 'write') Object.assign(operation, { content: body.content, revision: body.revision });
      const pending = {
        operation,
        delivered: !!session.poll,
        resolve,
        timer: setTimeout(() => {
          session.pending = null;
          resolve(null);
        }, requestTimeout),
      };
      session.pending = pending;
      if (session.poll) {
        settle(session.poll, operation);
        session.poll = null;
      }
      response.once('close', () => {
        if (session.pending === pending) {
          session.pending = null;
          settle(pending, null);
        }
      });
    });
    if (result?.closed) throw new RelayError(410, 'la sesión compartida ha terminado');
    if (!result) throw new RelayError(504, 'el anfitrión no respondió a tiempo');
    return result;
  }

  const handle = async (request, response) => {
    try {
      const action = request.url?.match(/^\/v1\/([a-z]+)$/)?.[1];
      if (request.method !== 'POST' || !routes.has(action)) {
        throw new RelayError(404, 'operación no disponible');
      }
      const large = action === 'reply' || action === 'write';
      if (large && receivingLargeRequests >= 8) throw new RelayError(503, 'el servicio está ocupado');
      const limit = large ? maxBody : 16_384;
      if (Number(request.headers['content-length']) > limit) throw new RelayError(413, 'mensaje demasiado grande');
      if (large) receivingLargeRequests++;
      try {
        const body = await readJson(request, limit);
        send(response, 200, await dispatch(action, body, response));
      } finally {
        if (large) receivingLargeRequests--;
      }
    } catch (error) {
      send(response, error.status || 500, { error: error.status ? error.message : 'error del servicio' });
    }
  };
  const options = { requestTimeout: 25_000, headersTimeout: 10_000, connectionsCheckingInterval: 2_000 };
  const server = tls ? https({ ...options, ...tls }, handle) : http(options, handle);
  server.maxConnections = 256;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  server.once('close', () => clearInterval(sweep));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { FILIGRANAS_RELAY_KEY, TLS_CERT, TLS_KEY, HOST = '127.0.0.1', PORT = '8787' } = process.env;
  if (Boolean(TLS_CERT) !== Boolean(TLS_KEY)) throw new Error('Configura TLS_CERT y TLS_KEY juntos');
  const tls = TLS_CERT && { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) };
  if (!tls && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    throw new Error('Configura TLS para escuchar fuera de loopback');
  }
  createRelay({ hostKey: FILIGRANAS_RELAY_KEY, tls }).listen(Number(PORT), HOST, () => {
    console.log(`Filigranas Relay disponible en ${HOST}:${PORT}`);
  });
}
