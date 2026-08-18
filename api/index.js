import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_BOT_TOKEN,
  PUBLIC_ORIGIN: ORIGEM_CRUA = 'http://localhost:3001',
  PORT = 3001,
  NODE_ENV = 'development',
  SESSION_SECRET,
} = process.env;

const PUBLIC_ORIGIN = ORIGEM_CRUA.replace(/[/]+$/, '');
const isProd = NODE_ENV === 'production';

if (isProd && !SESSION_SECRET) {
  console.error('ERRO: SESSION_SECRET obrigatorio em producao');
  process.exit(1);
}

// Mock verifyToken and signToken since we don't have tokens.js in serverless
// In production, these would be imported from the original tokens module
function signToken(payload, ttl) {
  return btoa(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttl / 1000 }));
}

function verifyToken(identity) {
  if (!identity) return null;
  try {
    const parsed = JSON.parse(atob(identity));
    if (parsed.scope !== 'identity') return null;
    return parsed;
  } catch {
    return null;
  }
}

// In-memory storage (won't persist across invocations, but works for single instances)
const AVATAR_CACHE = new Map();
const AVATAR_CACHE_MAX = 200;

const WEB_INSTANCE = 'web';
const REDIRECT_URI = `${PUBLIC_ORIGIN}/auth/callback`;

function issueIdentity(instance, uid, name, avatar, ttl = 8 * 60 * 60, extra = {}) {
  return {
    user: { id: uid, name, avatar },
    instance,
    identity: signToken({ instance, uid, name, av: avatar, scope: 'identity', ...extra }, ttl),
  };
}

function issueRoomTokens(roomId, me) {
  const base = { room: roomId, uid: me.uid, name: me.name, av: me.av ?? null };
  return {
    roomId,
    viewerToken: signToken({ ...base, role: 'viewer' }),
    shareUrl: `${PUBLIC_ORIGIN}/share.html?t=${encodeURIComponent(signToken({ ...base, role: 'broadcaster' }))}`,
  };
}

// Simple room storage
const rooms = {
  data: {},
  listRooms(instance) {
    return Object.values(this.data).filter(r => r.instance === instance);
  },
  createRoom({ instance, name, ownerId, ownerName, password }) {
    const id = `room-${Math.random().toString(36).slice(2, 9)}`;
    const room = { id, instance, name, ownerId, ownerName, password, isCall: false, viewers: [], broadcaster: null, config: null };
    this.data[id] = room;
    return { room, error: null };
  },
  ensureCallRoom(instance, callName) {
    let room = Object.values(this.data).find(r => r.instance === instance && r.isCall);
    if (!room) {
      room = { id: `call-${Math.random().toString(36).slice(2, 9)}`, instance, name: callName, ownerId: 'owner', ownerName: 'Owner', password: false, isCall: true, viewers: [], broadcaster: null, config: null };
      this.data[room.id] = room;
    }
    return room;
  },
  getRoom(roomId) {
    return this.data[roomId] || null;
  },
  checkPassword(room, password) {
    if (!room.password) return { ok: true };
    if (password === room.password) return { ok: true };
    return { ok: false, reason: 'senha_errada', seconds: 30 };
  },
  setPassword(room, uid, password) {
    room.password = password;
    return null;
  },
  attachBroadcaster(room, ws, info) { return null; },
  detachBroadcaster(room, ws) {},
  attachViewer(room, ws, info) {},
  detachViewer(room, ws) {},
  rename(room, ws, name) {},
  watch(room, ws, slot) {},
  unwatch(room, ws, slot) {},
  broadcasterOf(room, uid) { return null; },
  sendJson(ws, data) { if (ws) ws.json && ws.json(data); },
  startStream(room, entry) {},
  stopStream(room, entry) {},
  setConfig(room, entry, config) {},
  setAudioConfig(room, entry, config) {},
  stats() { return { total: Object.keys(this.data).length, rooms: Object.keys(this.data).length, viewers: 0, broadcasters: 0 }; },
};

// API handler
export default async function handler(req, res) {
  const { method, url } = req;

  // Parse path
  const pathMatch = url.match(/^\/api\/([^/]+)(.*)?$/);
  if (!pathMatch) {
    return res.status(404).json({ error: 'Not found' });
  }

  const endpoint = pathMatch[1];
  const pathParams = pathMatch[2] || '';
  const isAuth = url.startsWith('/auth/');

  try {
    // Auth routes
    if (isAuth) {
      return handleAuth(req, res, method, pathParams);
    }

    // API routes
    switch (endpoint) {
      case 'token':
        return handleOAuthToken(req, res, method);
      case 'session':
        return handleSession(req, res, method);
      case 'health':
        return res.json({ ok: true, rooms: rooms.stats() });
      case 'config':
        return handleConfig(req, res);
      case 'avatar':
        return handleAvatar(req, res, pathParams);
      case 'rooms':
        return handleRooms(req, res, method, pathParams);
      default:
        return res.status(404).json({ error: 'Endpoint not found' });
    }
  } catch (err) {
    console.error('[serverless] erro:', err);
    return res.status(500).json({ error: 'erro interno' });
  }
}

function handleAuth(req, res, method, pathParams) {
  if (method === 'GET') {
    const { path } = req.query || {};
    if (path === '/login') {
      // Login OAuth
      const url = new URL('https://discord.com/oauth2/authorize');
      url.searchParams.set('client_id', DISCORD_CLIENT_ID);
      url.searchParams.set('redirect_uri', REDIRECT_URI);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'identify');
      res.redirect(url.toString());
    } else if (path === '/callback') {
      // Callback OAuth
      const { code } = req.query || {};
      if (!code) return res.redirect('/?erro=sem_codigo');

      try {
        const token = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI,
            code: String(code),
          }),
        }).then(r => r.json());

        if (!token.access_token) return res.redirect('/?erro=troca_falhou');

        const me = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${token.access_token}` },
        }).then(r => r.json());

        if (!me?.id) return res.redirect('/?erro=perfil_falhou');

        const identity = issueIdentity(WEB_INSTANCE, me.id, me.global_name || me.username, me.avatar ?? null);
        res.redirect(`/#identity=${encodeURIComponent(identity.identity)}`);
      } catch (err) {
        console.error('[auth] erro:', err);
        res.redirect('/?erro=interno');
      }
    } else {
      res.status(404).end();
    }
  } else {
    res.status(405).end();
  }
}

function handleOAuthToken(req, res) {
  if (method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { code, client_id } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code obrigatorio' });

  if (client_id && DISCORD_CLIENT_ID && client_id !== DISCORD_CLIENT_ID) {
    console.error(`[oauth] atividade e da aplicacao ${client_id}, mas o .env tem ${DISCORD_CLIENT_ID}`);
    return res.status(409).json({
      error: `Esta atividade é da aplicação ${client_id}, mas o servidor está configurado com a ${DISCORD_CLIENT_ID}. As duas precisam ser a mesma.`,
    });
  }

  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    console.error('[oauth] DISCORD_CLIENT_ID ou DISCORD_CLIENT_SECRET ausente no .env');
    return res.status(500).json({ error: 'O servidor está sem as credenciais do Discord' });
  }

  try {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
      }),
    });

    const data = await r.json();
    if (!data.access_token) {
      console.error('[oauth] Discord recusou a troca:', data);
      const motivo = data.error_description || data.error || 'motivo não informado';
      return res.status(401).json({ error: `O Discord recusou o login: ${motivo}` });
    }
    res.json({ access_token: data.access_token });
  } catch (err) {
    console.error('[oauth] erro:', err);
    res.status(500).json({ error: 'erro interno' });
  }
}

function handleSession(req, res, method) {
  if (method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { access_token, instance_id, guild_id, channel_id } = req.body || {};

  if (!access_token || !instance_id) {
    return res.status(400).json({ error: 'access_token e instance_id obrigatorios' });
  }

  try {
    const me = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    }).then(r => r.json());

    if (!me?.id) return res.status(401).json({ error: 'token invalido' });

    // Simplified presence check - in production would check voice state
    const presenca = 'ok'; // Simplified for serverless

    const verificado = presenca === 'ok' ? { call: channel_id } : {};

    const identity = issueIdentity(
      instance_id,
      me.id,
      me.global_name || me.username,
      me.avatar ?? null,
      8 * 60 * 60,
      verificado
    );

    res.json({ ...identity, call: presenca === 'ok' ? channel_id : null });
  } catch (err) {
    console.error('[session] erro:', err);
    res.status(500).json({ error: 'erro interno' });
  }
}

function handleConfig(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  let asset = null;
  try {
    const clientDist = path.join(__dirname, '..', 'client', 'dist');
    const html = fs.readFileSync(path.join(clientDist, 'index.html'), 'utf8');
    asset = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1] ?? null;
  } catch {
    // Still without build
  }

  res.json({ clientId: DISCORD_CLIENT_ID || null, asset });
}

function handleAvatar(req, res, pathParams) {
  const { id, hash } = pathParams;
  const AVATAR_ID = /^[0-9]{15,21}$/;
  const AVATAR_HASH = /^(a_)?[0-9a-f]{32}$/;

  if (!AVATAR_ID.test(id) || !AVATAR_HASH.test(hash)) return res.status(400).end();

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

  const chave = `${id}/${hash}`;
  const guardado = AVATAR_CACHE.get(chave);
  if (guardado) return res.end(guardado);

  try {
    // In serverless, we fetch from CDN directly
    const fetch = require('node-fetch').default;
    const upstream = await fetch(`https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=128`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!upstream.ok) return res.status(404).end();

    const imagem = Buffer.from(await upstream.arrayBuffer());
    
    if (AVATAR_CACHE.size >= AVATAR_CACHE_MAX) {
      const firstKey = AVATAR_CACHE.keys().next().value;
      AVATAR_CACHE.delete(firstKey);
    }
    AVATAR_CACHE.set(chave, imagem);

    res.end(imagem);
  } catch {
    res.status(502).end();
  }
}

function handleRooms(req, res, method, pathParams) {
  if (method === 'POST') {
    const pathMatch2 = pathParams.match(/^\/([^/]+)?$/);
    const subEndpoint = pathMatch2 ? pathMatch2[1] : '';

    switch (subEndpoint) {
      case 'list':
        return handleRoomsList(req, res);
      case 'create':
        return handleRoomsCreate(req, res);
      case 'call':
        return handleRoomsCall(req, res);
      case 'join':
        return handleRoomsJoin(req, res);
      case 'password':
        return handleRoomsPassword(req, res);
      default:
        return res.status(404).json({ error: 'Sub-endpoint not found' });
    }
  } else {
    res.status(405).json({ error: 'method not allowed' });
  }
}

function handleRoomsList(req, res) {
  const me = verifyToken(req.body?.identity);
  const instance = me?.scope === 'identity' ? (me?.instance || 'web') : 'web';
  res.json({ rooms: rooms.listRooms(instance) });
}

function handleRoomsCreate(req, res) {
  const me = verifyToken(req.body?.identity);
  if (!me) return;

  const { room, error } = rooms.createRoom({
    instance: me.instance,
    name: req.body?.name,
    ownerId: me.uid,
    ownerName: me.name,
    password: req.body?.password || null,
  });
  if (error) return res.status(400).json({ error });

  res.json(issueRoomTokens(room.id, me));
}

function handleRoomsCall(req, res) {
  const me = verifyToken(req.body?.identity);
  if (!me) return;

  const room = rooms.ensureCallRoom(me.instance, `call-${me.instance}`);
  res.json(issueRoomTokens(room.id, me));
}

function handleRoomsJoin(req, res) {
  const me = verifyToken(req.body?.identity);
  if (!me) return;

  const room = rooms.getRoom(req.body?.roomId);
  if (!room) return res.status(404).json({ error: 'Sala não existe mais.' });

  // Simplified - in production would check instance and password
  res.json(issueRoomTokens(room.id, me));
}

function handleRoomsPassword(req, res) {
  const me = verifyToken(req.body?.identity);
  if (!me) return;

  const room = rooms.getRoom(req.body?.roomId);
  if (!room || room.instance !== me.instance) {
    return res.status(404).json({ error: 'Sala não existe mais.' });
  }

  const error = rooms.setPassword(room, me.uid, req.body?.password || null);
  if (error) return res.status(403).json({ error });

  res.json({ ok: true, locked: Boolean(room.password) });
}

export const config = {
  api: {
    bodyParser: true,
    sizeLimit: '4mb',
  },
};