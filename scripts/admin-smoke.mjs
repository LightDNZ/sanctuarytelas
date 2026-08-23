import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const TEST_SECRET = 'admin-smoke-secret-with-enough-entropy-for-tests-only';
const TEST_ADMIN = '123456789012345678';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // O processo ainda esta abrindo a porta.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('servidor nao ficou pronto a tempo');
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS  ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    PUBLIC_ORIGIN: base,
    NODE_ENV: 'development',
    SESSION_SECRET: TEST_SECRET,
    DISCORD_ADMIN_ID: TEST_ADMIN,
    // Credenciais de mentira, mas presentes: sem elas o /admin/auth/login
    // devolve um redirect relativo de "nao configurado" e o teste morre em
    // "Invalid URL". Estavam vindo do .env de quem rodava, entao o teste
    // passava na maquina do autor e em lugar nenhum mais.
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'admin-smoke-client-secret',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
child.stdout.on('data', (chunk) => (logs += chunk));
child.stderr.on('data', (chunk) => (logs += chunk));

try {
  await waitFor(`${base}/api/health`);

  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  check(health.ok === true, 'healthcheck responde');
  check(!('rooms' in health), 'healthcheck publico nao expoe salas');

  const page = await fetch(`${base}/admin`).then((response) => response.text());
  // Marcador estrutural, nao a copy: o teste prova que a casca do painel foi
  // servida. Preso a uma frase de tela, ele quebrava a cada ajuste de texto.
  check(page.includes('id="dashboard"'), 'pagina administrativa e servida');

  const login = await fetch(`${base}/admin/auth/login`, { redirect: 'manual' });
  const loginUrl = new URL(login.headers.get('location'));
  check(
    login.status === 302 && loginUrl.hostname === 'discord.com',
    'login redireciona ao Discord',
  );
  check(
    Boolean(loginUrl.searchParams.get('state')),
    'login administrativo usa OAuth state assinado',
  );

  const unauthorized = await fetch(`${base}/api/admin/metrics`);
  check(unauthorized.status === 401, 'metricas recusam acesso sem sessao');

  process.env.SESSION_SECRET = TEST_SECRET;
  const { signToken } = await import('../server/tokens.js');
  const cookieName = 'discord_screen_admin';
  const validToken = signToken({ scope: 'admin', uid: TEST_ADMIN, name: 'Admin' }, 60);
  const authorized = await fetch(`${base}/api/admin/metrics`, {
    headers: { Cookie: `${cookieName}=${validToken}` },
  });
  const metrics = await authorized.json();
  check(authorized.status === 200, 'admin autorizado recebe metricas');
  check(
    Boolean(metrics.summary && metrics.traffic && metrics.system),
    'payload contem app e sistema',
  );
  check(!JSON.stringify(metrics).includes(TEST_SECRET), 'payload nao vaza segredo de sessao');

  const identity = await post(base, '/api/session-dev', {
    instance_id: 'admin-smoke',
    name: 'Alice',
  });
  const room = await post(base, '/api/rooms/create', {
    identity: identity.identity,
    name: 'Sala monitorada',
  });
  const wsBase = `ws://127.0.0.1:${port}/ws?t=`;
  const viewer = await openSocket(`${wsBase}${encodeURIComponent(room.viewerToken)}`);
  const broadcasterToken = new URL(room.shareUrl).searchParams.get('t');
  const broadcaster = await openSocket(`${wsBase}${encodeURIComponent(broadcasterToken)}`);
  broadcaster.send(JSON.stringify({ type: 'start' }));
  await sleep(50);
  viewer.send(JSON.stringify({ type: 'watch', slot: 0 }));
  await sleep(50);
  const frame = Buffer.alloc(256, 7);
  frame[0] = 0;
  frame[1] = 1;
  broadcaster.send(frame);
  await sleep(100);

  const measured = await fetch(`${base}/api/admin/metrics`, {
    headers: { Cookie: `${cookieName}=${validToken}` },
  }).then((response) => response.json());
  check(measured.traffic.receivedBytes >= frame.length, 'dashboard mede bytes recebidos');
  check(measured.traffic.transmittedBytes >= frame.length, 'dashboard mede bytes enviados');
  check(
    measured.streams.some((stream) => stream.watchers === 1),
    'dashboard relaciona stream e espectador',
  );
  viewer.close();
  broadcaster.close();

  const wrongToken = signToken({ scope: 'admin', uid: '999999999999999999' }, 60);
  const wrongAdmin = await fetch(`${base}/api/admin/metrics`, {
    headers: { Cookie: `${cookieName}=${wrongToken}` },
  });
  check(wrongAdmin.status === 401, 'sessao de outro Discord ID e recusada');

  console.log('\nTudo passou');
} catch (error) {
  console.error(`\nFALHOU  ${error.message}`);
  if (logs.trim()) console.error(logs.trim());
  process.exitCode = 1;
} finally {
  child.kill();
}
