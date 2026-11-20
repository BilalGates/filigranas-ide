import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelay } from './server.mjs';

const hostKey = randomBytes(32).toString('base64url');
const relay = createRelay({ hostKey });
let tunnel;
let stopping = false;

function stop() {
  stopping = true;
  tunnel?.kill();
  relay.closeAllConnections();
  relay.close();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(0, '127.0.0.1', resolve);
  });
  tunnel = spawn('cloudflared', [
    'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${relay.address().port}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const recent = [];
  let origin;
  let connected = false;
  let failure;
  let ready = false;
  let lastCheck = 'Cloudflare no anunció la dirección del túnel.';
  const onLine = (line) => {
    origin ??= line.match(/\|\s+(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\s+\|/)?.[1];
    if (line.includes('Registered tunnel connection')) connected = true;
    recent.push(line);
    if (recent.length > 5) recent.shift();
  };
  for (const stream of [tunnel.stdout, tunnel.stderr]) {
    createInterface({ input: stream }).on('line', onLine);
  }
  tunnel.once('error', (error) => {
    failure = error.code === 'ENOENT' ? 'Instala cloudflared y vuelve a ejecutar este comando.' : error.message;
  });
  tunnel.once('exit', () => {
    if (stopping) return;
    failure = 'Cloudflare cerró el túnel HTTPS.';
    if (ready) {
      console.error(failure);
      process.exitCode = 1;
      stop();
    }
  });

  const dns = new Resolver({ timeout: 1500, tries: 1 });
  const deadline = Date.now() + 90_000;
  while (!stopping && !failure && Date.now() < deadline) {
    if (origin && connected) {
      try {
        // Espera a que el nombre nuevo se publique antes de la primera consulta del sistema.
        await dns.resolve4(new URL(origin).hostname);
        const response = await fetch(`${origin}/v1/create`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          redirect: 'error',
          signal: AbortSignal.timeout(4_000),
        });
        lastCheck = `La dirección pública devolvió HTTP ${response.status}.`;
        if (response.status === 403 && (await response.json()).error === 'clave del servicio incorrecta') {
          ready = true;
          console.log(`Dirección HTTPS: ${origin}\nClave del servicio: ${hostKey}`);
          console.log('Usa ambos datos en Compartir proyecto. Mantén esta terminal abierta y pulsa Ctrl+C para cerrar el servicio.');
          break;
        }
      } catch (error) {
        lastCheck = `La comprobación del dominio falló (${error.cause?.code ?? error.name}).`;
      }
    }
    await delay(1_000);
  }

  if (!ready && !stopping) {
    if (recent.length) console.error(recent.join('\n'));
    throw new Error(failure ?? lastCheck);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  stop();
}
