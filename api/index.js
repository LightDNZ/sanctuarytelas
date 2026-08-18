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

// Mock auth functions
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

const WEB_INSTANCE = 'web';
const REDIRECT_URI = `${PUBLIC_ORIGIN}/auth/callback`;

// Simple in-memory room storage
const rooms = {
  data: {},
  listRooms(instance) {
    return Object.values(this.data).filter(r => r.instance === instance);
  },
  createRoom({ instance, name, ownerId, ownerName, password }) {
    const id = 'room-' + Math.random().toString(36).slice(2, 9);
    const room = { id, instance, name, ownerId, ownerName, password, isCall: false, viewers: [], broadcaster: null, config: null };
    this.data[id] = room;
    return { room, error: null };
  },
  ensureCallRoom(instance, id) {
    let room = Object.values(this.data).find(r => r.instance === instance && r.isCall);
    if (!room) {
      room = { id: 'call-' + Math.random().toString(36).slice(2, 9), instance, name: 'Sala da call', isCall: true, ownerId: null, ownerName: 'a call', password: null, viewers: [], broadcaster: null, config: null };
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
  attachBroadcaster() { return null; },
  detachBroadcaster() {},
  attachViewer() {},
  detachViewer() {},
  rename() {},
  watch() {},
  unwatch() {},
  broadcasterOf() { return null; },
  sendJson() {},
  startStream() {},
  stopStream() {},
  setConfig() {},
  setAudioConfig() {},
  stats() { return { total: Object.keys(this.data).length, rooms: Object.keys(this.data).length, viewers: 0, broadcasters: 0 }; },
};

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

// Main handler - this will be at /api/ in Vercel
export default function handler(req, res) {
  const { method, url } = req;
  
  // Match /api/ENDPOINT or /api/ENDPOINT/params
  const match = url.match(/^\/api\/([^/]+)(?:\/([^/]+))?(?:\/(.+))?$/);
  if (!match) return res.status(404).json({ error: 'Not found' });
  
  const endpoint = match[1];
  const param1 = match[2];
  const param2 = match[3];
  
  try {
    // Auth routes: /api/token, /auth/login, /auth/callback
    if (url.startsWith('/auth/')) {
      return handleAuth(req, res, method, url);
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
        return handleAvatar(req, res, param1, param2);
      case 'rooms':
        return handleRooms(req, res, method, param1);
      default:
        return res.status(404).json({ error: 'Endpoint not found' });
    }
  } catch (err) {
    console.error('[serverless] erro:', err);
    return res.status(500).json({ error: 'erro interno' });
  }
}

function handleAuth(req, res, method, url) {
  // /auth/login -> GET
  // /auth/callback -> GET with code query
  
  const path = url.replace('/auth/', '/');
  
  if (method === 'GET') {
    if (path === 'login') {
      const authUrl = new URL('https://discord.com/oauth2/authorize');
      authUrl.searchParams.set('client_id', DISCORD_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'identify');
      res.redirect(authUrl.toString());
    } else if (path === 'callback') {
      const { code } = new URL(url).query || {};
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

    const presenca = 'ok';
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

function handleAvatar(req, res, id, hash) {
  if (!id || !hash) return res.status(400).end();

  const AVATAR_ID = /^[0-9]{15,21}$/;
  const AVATAR_HASH = /^(a_)?[0-9a-f]{32}$/;

  if (!AVATAR_ID.test(id) || !AVATAR_HASH.test(hash)) return res.status(400).end();

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

  const chave = `${id}/${hash}`;
  // Simple cache using globalThis
  if (globalThis.__avatarCache) {
    const guardado = globalThis.__avatarCache.get(chave);
    if (guardado) return res.end(guardado);
  } else {
    globalThis.__avatarCache = new Map();
  }

  try {
    const fetch = require('node-fetch').default;
    const upstream = await fetch(`https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=128`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!upstream.ok) return res.status(404).end();

    const imagem = Buffer.from(await upstream.arrayBuffer());
    
    if (globalThis.__avatarCache && globalThis.__avatarCache.size >= 200) {
      const firstKey = globalThis.__avatarCache.keys().next().value;
      globalThis.__avatarCache.delete(firstKey);
    }
    if (globalThis.__avatarCache) globalThis.__avatarCache.set(chave, imagem);

    res.end(imagem);
  } catch {
    res.status(502).end();
  }
}

function handleRooms(req, res, method, subPath) {
  if (method === 'POST') {
    switch (subPath) {
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

// Export config for Vercel
export const config = {
  api: {
    bodyParser: true,
    sizeLimit: '4mb',
  },
};