import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';

import { signToken, verifyToken } from './tokens.js';
import * as R from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_BOT_TOKEN,
  PUBLIC_ORIGIN: ORIGEM_CRUA = 'http://localhost:3001',
  PORT = 3001,
  NODE_ENV = 'development',
} = process.env;

// Uma barra sobrando no fim se propaga: o shareUrl vira "//share.html" e o
// redirect do OAuth vira "//auth/callback", que não bate com o endereço
// cadastrado no portal. O login falha sem explicar nada.
const PUBLIC_ORIGIN = ORIGEM_CRUA.replace(/[/]+$/, '');

const isProd = NODE_ENV === 'production';

// Falha no arranque, não no primeiro pedido: subir sem segredo significa
// assinar todos os tokens com o padrão público, e um servidor assim de pé é
// pior do que um servidor que não sobe.
if (isProd && !process.env.SESSION_SECRET) {
  console.error('ERRO: SESSION_SECRET obrigatorio em producao — sem ele os tokens sao forjaveis.');
  process.exit(1);
}

const app = express();
app.use(express.json());

// Uma Activity roda dentro de um iframe em <id>.discordsays.com, que por sua
// vez está dentro do discord.com. Declarar essa cadeia é o que autoriza o
// navegador a desenhar a página ali.
//
// Vale dizer o que aprendemos tentando hospedar isto num PaaS: se a borda da
// hospedagem carimbar "X-Frame-Options: SAMEORIGIN" nas respostas, não há nada
// a fazer daqui. O proxy do Discord repassa o X-Frame-Options da origem e
// substitui o CSP pelo dele — então o frame-ancestors abaixo nem chega ao
// navegador, e o que sobra é o carimbo da hospedagem barrando o iframe. O
// sintoma é cruel: retângulo branco no Discord, log limpo, e o mesmo endereço
// funcionando quando aberto direto. Se isso reaparecer, o problema é a borda
// de quem hospeda, não este arquivo.
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com"
  );
  next();
});

// Página de captura (broadcaster). Servida como página normal, fora do proxy.
// Nomes fixos (share.html/js/css), então nunca cachear: senão uma correção
// fica presa no navegador de quem transmite, sem jeito óbvio de perceber.
// extensions: o portal do Discord pede as URLs de termos e privacidade, e
// "/termos" se lê melhor do que "/termos.html" — sem isto o catch-all lá
// embaixo devolveria a Activity para esses dois caminhos.
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

// Pipeline de transmissão compartilhado com a Activity. Ela o recebe pelo
// bundle do Vite; a página de captura importa daqui.
app.use(
  '/shared',
  express.static(path.join(__dirname, '..', 'shared'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

// ------------------------------------------------------------------ OAuth

/** Troca o code do OAuth pelo access_token. O secret nunca sai do servidor. */
app.post('/api/token', async (req, res) => {
  const { code, client_id } = req.body ?? {};
  if (!code) return res.status(400).json({ error: 'code obrigatorio' });

  // A metade que autoriza é a aplicação que abriu a atividade; a metade que
  // troca o código é este servidor. Se forem aplicações diferentes, o Discord
  // recusa — e o erro dele não diz qual das duas está errada.
  if (client_id && DISCORD_CLIENT_ID && client_id !== DISCORD_CLIENT_ID) {
    console.error(
      `[oauth] atividade e da aplicacao ${client_id}, mas o .env tem ${DISCORD_CLIENT_ID}`
    );
    return res.status(409).json({
      error:
        `Esta atividade é da aplicação ${client_id}, mas o servidor está configurado ` +
        `com a ${DISCORD_CLIENT_ID}. As duas precisam ser a mesma.`,
    });
  }

  // Sem credencial não há troca possível, e o erro que o Discord devolve nesse
  // caso não deixa isso óbvio para ninguém. Dizer aqui poupa a caçada.
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    console.error('[oauth] DISCORD_CLIENT_ID ou DISCORD_CLIENT_SECRET ausente no .env');
    return res.status(500).json({
      error: 'O servidor está sem as credenciais do Discord. Rode: npm run configurar',
    });
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
      // O motivo do Discord vai junto: "invalid_client" é secret errado,
      // "invalid_grant" é código já usado ou expirado. Sem isso, quem vê a
      // tela não tem como saber qual dos dois é.
      const motivo = data.error_description || data.error || 'motivo não informado';
      return res.status(401).json({ error: `O Discord recusou o login: ${motivo}` });
    }
    res.json({ access_token: data.access_token });
  } catch (err) {
    console.error('[oauth] erro:', err);
    res.status(500).json({ error: 'erro interno' });
  }
});

/**
 * Identidade da pessoa nesta instância da Activity.
 *
 * Separada das salas de propósito: cada operação de sala valida este token
 * assinado em vez de bater no Discord de novo, o que custaria uma ida à rede a
 * cada clique.
 */
app.post('/api/session', async (req, res) => {
  const { access_token, instance_id, guild_id, channel_id } = req.body ?? {};
  if (!access_token || !instance_id) {
    return res.status(400).json({ error: 'access_token e instance_id obrigatorios' });
  }

  try {
    const me = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    }).then((r) => r.json());

    if (!me?.id) return res.status(401).json({ error: 'token invalido' });

    const presenca = await inVoiceChannel(guild_id, channel_id, me.id);
    if (presenca === 'fora') {
      return res.status(403).json({ error: 'Entre na call antes de abrir a atividade.' });
    }

    // O canal entra no token assinado, não fica só na resposta: é o que permite
    // ao endpoint da sala da call confiar sem consultar o Discord de novo.
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
});

/**
 * Identidade de convidado: entra sem conta.
 *
 * O login do Discord é uma melhoria opcional, não um pedágio — exigir conta só
 * para assistir uma tela afastaria justamente quem recebeu um link.
 *
 * Validade longa de propósito: o id do convidado é o que amarra a posse das
 * salas que ele criou, e perder isso no meio do uso seria pior que o risco de
 * um token de convidado antigo, que não dá acesso a nada além do lobby público.
 */
/**
 * Identidade de teste com instância à escolha. Fora do ar em produção: poder
 * escolher a instância permitiria espiar as salas de qualquer canal de voz.
 */
app.post('/api/session-dev', (req, res) => {
  if (isProd) return res.status(404).end();
  const { instance_id = 'dev', name = 'Dev', call = null } = req.body ?? {};
  res.json(issueIdentity(instance_id, `dev-${name}`, name, null, 8 * 60 * 60, call ? { call } : {}));
});

app.post('/api/session-guest', (req, res) => {
  const raw = String(req.body?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
  const name = raw || `Convidado ${Math.floor(Math.random() * 9000 + 1000)}`;
  const uid = `guest-${crypto.randomBytes(8).toString('base64url')}`;
  res.json(issueIdentity(WEB_INSTANCE, uid, name, null, 30 * 24 * 60 * 60));
});

function issueIdentity(instance, uid, name, avatar, ttl = 8 * 60 * 60, extra = {}) {
  return {
    user: { id: uid, name, avatar },
    instance,
    identity: signToken({ instance, uid, name, av: avatar, scope: 'identity', ...extra }, ttl),
  };
}

/**
 * Confirma pelo Discord que a pessoa está mesmo naquela call.
 *
 * Sem isto o escopo por canal é obscuridade, não segurança: o `instance_id`
 * vem do cliente, e um cliente adulterado pode alegar qualquer canal. Aqui
 * quem responde é o Discord, com o token do bot.
 *
 * @returns {'ok'|'fora'|'indisponivel'}
 */
async function inVoiceChannel(guildId, channelId, userId) {
  if (!DISCORD_BOT_TOKEN || !guildId || !channelId) return 'indisponivel';

  try {
    const r = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/voice-states/${userId}`,
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
    );

    if (r.status === 404) {
      // Dois 404 bem diferentes chegam aqui, e tratá-los igual trancava a
      // atividade para fora.
      //
      // "Unknown Guild" (10004) quer dizer que o BOT não está neste servidor —
      // o caso de quem instalou a atividade na própria conta, sem adicionar bot
      // nenhum. Isso não diz nada sobre a pessoa estar em call: é falta de
      // visibilidade nossa, não ausência dela. Antes virava "fora", o que
      // devolvia 403 e a atividade abria em "Não foi possível entrar".
      //
      // Qualquer outro 404 é o que o nome sugere: não há estado de voz para
      // essa pessoa neste servidor, então ela está fora da call.
      const erro = await r.json().catch(() => ({}));
      if (erro?.code === 10004) {
        console.warn('[voz] o bot nao esta neste servidor — escopo cai para a instancia');
        return 'indisponivel';
      }
      return 'fora';
    }
    if (!r.ok) {
      console.warn(`[voz] Discord respondeu ${r.status} — verificação ignorada`);
      return 'indisponivel';
    }

    const state = await r.json();
    return state?.channel_id === channelId ? 'ok' : 'fora';
  } catch (err) {
    // Falha de rede não pode trancar todo mundo para fora.
    console.warn('[voz] falhou:', err.message);
    return 'indisponivel';
  }
}

/**
 * Espelho do avatar do Discord.
 *
 * O CSP da Activity bloqueia cdn.discordapp.com, e o proxy do Discord só
 * repassa domínios mapeados no portal do desenvolvedor. Servindo pelo nosso
 * próprio /api, a mesma URL funciona dentro e fora da Activity, sem depender
 * de configuração que ninguém lembra de fazer.
 *
 * O id e o hash são validados no formato exato do Discord: sem isso a rota
 * viraria um proxy aberto, com o servidor buscando qualquer URL que pedissem.
 */
const AVATAR_ID = /^[0-9]{15,21}$/;
const AVATAR_HASH = /^(a_)?[0-9a-f]{32}$/;

// Cache em memória: o hash muda quando a pessoa troca a foto, então a chave
// nunca fica velha. Sem ele, montar a grade numa sala cheia vira uma ida ao
// CDN do Discord por avatar, e a espera aparece como a sala demorando a abrir.
// Teto pequeno de propósito — são poucos KB por imagem e uma sala tem dezenas
// de pessoas, não milhares.
const AVATAR_CACHE = new Map();
const AVATAR_CACHE_MAX = 200;

app.get('/api/avatar/:id/:hash', async (req, res) => {
  const { id, hash } = req.params;
  if (!AVATAR_ID.test(id) || !AVATAR_HASH.test(hash)) return res.status(400).end();

  // Tipo fixo, não o que o upstream disser: pedimos .png e é png que sai.
  res.setHeader('Content-Type', 'image/png');
  // O hash muda quando a pessoa troca a foto, então a URL é imutável.
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

  const chave = `${id}/${hash}`;
  const guardado = AVATAR_CACHE.get(chave);
  if (guardado) return res.end(guardado);

  try {
    const upstream = await fetch(`https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=128`, {
      // O CDN fora do ar não pode virar uma sala que não abre.
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok) return res.status(404).end();

    const imagem = Buffer.from(await upstream.arrayBuffer());
    // Descarta o mais antigo primeiro; a ordem de inserção do Map basta.
    if (AVATAR_CACHE.size >= AVATAR_CACHE_MAX) {
      AVATAR_CACHE.delete(AVATAR_CACHE.keys().next().value);
    }
    AVATAR_CACHE.set(chave, imagem);

    res.end(imagem);
  } catch {
    res.status(502).end();
  }
});

/** Valida o token de identidade que acompanha toda operação de sala. */
function identityOf(req, res) {
  const payload = verifyToken(req.body?.identity);
  if (!payload || payload.scope !== 'identity') {
    res.status(401).json({ error: 'identidade invalida ou expirada' });
    return null;
  }
  return payload;
}

/**
 * Tokens de acesso a uma sala, emitidos depois de passar pela senha.
 *
 * Sem prazo de validade: quem entrou fica. A sala fecha ao esvaziar e o id é
 * aleatório, então o token morre junto com ela.
 */
function issueRoomTokens(roomId, me) {
  const base = { room: roomId, uid: me.uid, name: me.name, av: me.av ?? null };
  return {
    roomId,
    viewerToken: signToken({ ...base, role: 'viewer' }),
    shareUrl: `${PUBLIC_ORIGIN}/share.html?t=${encodeURIComponent(
      signToken({ ...base, role: 'broadcaster' })
    )}`,
  };
}

// ---------------------------------------------------------------------- salas

/**
 * Listar não exige login: dá para ver o lobby antes de entrar.
 *
 * Criar e entrar continuam exigindo identidade — sem isso não haveria dono de
 * sala nem nome de participante.
 */
app.post('/api/rooms/list', (req, res) => {
  const me = verifyToken(req.body?.identity);
  const instance = me?.scope === 'identity' ? me.instance : WEB_INSTANCE;
  res.json({ rooms: R.listRooms(instance) });
});

app.post('/api/rooms/create', (req, res) => {
  const me = identityOf(req, res);
  if (!me) return;

  const { room, error } = R.createRoom({
    instance: me.instance,
    name: req.body?.name,
    ownerId: me.uid,
    ownerName: me.name,
    password: req.body?.password || null,
  });
  if (error) return res.status(400).json({ error });

  console.log(`[room ${room.id}] criada por ${me.name}: "${room.name}"`);
  res.json(issueRoomTokens(room.id, me));
});

/**
 * A sala desta call. É a única sala que existe dentro do Discord: a atividade
 * abre nela direto, sem lista, porque escolher entre uma opção só não é escolha.
 *
 * Com o token do bot configurado, a porta é a presença no canal de voz,
 * confirmada pelo próprio Discord. Sem ele, a porta é a instância da atividade
 * — o mesmo escopo que a lista de salas sempre usou, então nada se afrouxa, e a
 * atividade continua funcionando para quem não quer criar um bot.
 */
const salaDaCall = (me) => (me.call ? `call-${me.call}` : `atividade-${me.instance}`);

app.post('/api/rooms/call', (req, res) => {
  const me = identityOf(req, res);
  if (!me) return;

  const room = R.ensureCallRoom(me.instance, salaDaCall(me));
  res.json(issueRoomTokens(room.id, me));
});

app.post('/api/rooms/join', (req, res) => {
  const me = identityOf(req, res);
  if (!me) return;

  const room = R.getRoom(req.body?.roomId);
  if (!room) return res.status(404).json({ error: 'Sala não existe mais.' });

  // A sala da call é avaliada antes da instância: quem manda nela é a presença
  // no canal, confirmada pelo Discord. Checar instância aqui recusaria por
  // motivo errado, já que o id dela vem do canal e não da instância.
  if (room.isCall) {
    if (room.id !== salaDaCall(me)) {
      return res.status(403).json({ error: 'Entre na call para acessar esta sala.' });
    }
    return res.json(issueRoomTokens(room.id, me));
  }

  // Salas comuns: as de um canal de voz não aparecem nem abrem em outro.
  if (room.instance !== me.instance) {
    return res.status(404).json({ error: 'Sala não existe mais.' });
  }

  const check = R.checkPassword(room, req.body?.password);
  if (!check.ok) {
    return res.status(check.reason === 'bloqueado' ? 429 : 403).json({
      error:
        check.reason === 'bloqueado'
          ? `Muitas tentativas. Tente de novo em ${check.seconds}s.`
          : 'Senha incorreta.',
      reason: check.reason,
    });
  }

  res.json(issueRoomTokens(room.id, me));
});

app.post('/api/rooms/password', (req, res) => {
  const me = identityOf(req, res);
  if (!me) return;

  const room = R.getRoom(req.body?.roomId);
  if (!room || room.instance !== me.instance) {
    return res.status(404).json({ error: 'Sala não existe mais.' });
  }

  const error = R.setPassword(room, me.uid, req.body?.password || null);
  if (error) return res.status(403).json({ error });

  res.json({ ok: true, locked: Boolean(room.password) });
});

// ------------------------------------------------- login web (fora do Discord)

// Quem entra pelo site não tem canal de voz, então todas essas pessoas
// compartilham um lobby só.
const WEB_INSTANCE = 'web';
const REDIRECT_URI = `${PUBLIC_ORIGIN}/auth/callback`;

app.get('/auth/login', (_req, res) => {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
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
    }).then((r) => r.json());

    if (!token.access_token) return res.redirect('/?erro=troca_falhou');

    const me = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    }).then((r) => r.json());

    if (!me?.id) return res.redirect('/?erro=perfil_falhou');

    const identity = issueIdentity(
      WEB_INSTANCE,
      me.id,
      me.global_name || me.username,
      me.avatar ?? null
    );

    // No fragmento, não na query: o fragmento não é enviado ao servidor nem
    // aparece em log de proxy. O cliente lê e limpa da barra de endereço.
    res.redirect(`/#identity=${encodeURIComponent(identity.identity)}`);
  } catch (err) {
    console.error('[auth] erro:', err);
    res.redirect('/?erro=interno');
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: R.stats() }));

/**
 * O que o cliente precisa saber e só o servidor sabe, em tempo de execução.
 *
 * `clientId` vinha embutido no bundle (VITE_DISCORD_CLIENT_ID). Isso obrigava a
 * rebuildar a cada troca de credencial, e esquecer o build não dava erro nenhum:
 * a Activity abria normalmente e só quebrava na hora do login, longe da causa.
 * O Client ID é público por natureza — aparece em toda URL de OAuth —, então
 * servi-lo aqui não expõe nada. O secret continua sem sair do servidor.
 *
 * `asset` é o nome do bundle atual, para a Activity perceber que está rodando
 * uma versão velha. O index.html vai com no-store, mas o cliente do Discord
 * pode entregar uma cópia antiga assim mesmo, e o iframe fica preso num build
 * anterior sem nenhum sinal visível.
 */
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  let asset = null;
  try {
    const html = fs.readFileSync(path.join(clientDist, 'index.html'), 'utf8');
    asset = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1] ?? null;
  } catch {
    // Ainda sem build; em desenvolvimento quem serve o cliente é o Vite.
  }

  // || e nao ??: uma variavel vazia no .env chega como string vazia, e o
  // contrato aqui e "null significa nao configurado".
  res.json({ clientId: DISCORD_CLIENT_ID || null, asset });
});

// Activity buildada (produção). Em dev o Vite serve o client na 5173.
const clientDist = path.join(__dirname, '..', 'client', 'dist');

app.use(
  express.static(clientDist, {
    setHeaders: (res, filePath) => {
      // Arquivos em /assets levam hash de conteúdo no nome — o Vite gera um
      // nome novo a cada build, então cachear para sempre é seguro.
      // O index.html aponta para eles e precisa ser sempre fresco.
      const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
      res.setHeader(
        'Cache-Control',
        hashed ? 'public, max-age=31536000, immutable' : 'no-store'
      );
    },
  })
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(clientDist, 'index.html'), (err) => err && next());
});

// -------------------------------------------------------------- WebSocket

const server = createServer(app);
// maxPayload: o relay repassa o buffer intacto para todos os espectadores, então
// um quadro gigante de um transmissor adulterado sairia multiplicado por N. Um
// keyframe 1080p a 5 Mbps não passa de algumas centenas de KB.
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  // O proxy do Discord entrega o caminho com o prefixo /.proxy/.
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/^\/\.proxy/, '');

  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const payload = verifyToken(url.searchParams.get('t'));
  // scope 'identity' não dá acesso a sala nenhuma: só os tokens de sala servem.
  if (!payload || !payload.room) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, payload);
  });
});

wss.on('connection', (ws, _req, auth) => {
  const room = R.getRoom(auth.room);

  // A sala pode ter fechado entre a emissão do token e a conexão.
  if (!room) {
    R.sendJson(ws, { type: 'room-gone' });
    ws.close();
    return;
  }

  if (auth.role === 'broadcaster') {
    handleBroadcaster(ws, room, { id: auth.uid, name: auth.name, avatar: auth.av ?? null });
  } else {
    handleViewer(ws, room, auth);
  }
});

function handleBroadcaster(ws, room, info) {
  const entry = R.attachBroadcaster(room, ws, info);

  if (typeof entry === 'string') {
    R.sendJson(ws, { type: 'error', message: entry });
    ws.close();
    return;
  }

  console.log(`[room ${room.id}] broadcaster conectado: ${info.name} (slot ${entry.slot})`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      R.pushChunk(room, entry, data);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'start') {
      R.startStream(room, entry);
      console.log(`[room ${room.id}] stream iniciada por ${info.name}`);
    } else if (msg.type === 'config' && msg.config) {
      R.setConfig(room, entry, msg.config);
      console.log(`[room ${room.id}] codec de ${info.name}: ${msg.config.codec}`);
    } else if (msg.type === 'audio-config' && msg.config) {
      R.setAudioConfig(room, entry, msg.config);
      console.log(`[room ${room.id}] audio de ${info.name}: ${msg.config.codec}`);
    } else if (msg.type === 'stop') {
      R.stopStream(room, entry);
      console.log(`[room ${room.id}] stream parada por ${info.name}`);
    }
  });

  ws.on('close', () => {
    R.detachBroadcaster(room, ws);
    console.log(`[room ${room.id}] broadcaster saiu: ${info.name}`);
  });
}

function handleViewer(ws, room, auth) {
  R.attachViewer(room, ws, { id: auth.uid, name: auth.name, avatar: auth.av ?? null });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Nome exibido escolhido pela pessoa. Nada é persistido: vale enquanto a
    // conexão durar, e some quando ela reabre a atividade.
    if (msg.type === 'rename') {
      R.rename(room, ws, msg.name);
      return;
    }

    if (msg.type === 'watch' && Number.isInteger(msg.slot)) {
      R.watch(room, ws, msg.slot);
      return;
    }

    if (msg.type === 'unwatch' && Number.isInteger(msg.slot)) {
      R.unwatch(room, ws, msg.slot);
      return;
    }

    // Encerrar a própria transmissão de dentro da Activity, sem ter que achar
    // a aba de captura. Cada um só encerra a sua.
    if (msg.type === 'stop-broadcast') {
      const entry = R.broadcasterOf(room, auth.uid);
      if (entry) {
        R.sendJson(entry.ws, { type: 'stop-request' });
        console.log(`[room ${room.id}] parada pedida por ${auth.name}`);
      }
    }
  });

  ws.on('close', () => R.detachViewer(room, ws));
  ws.on('error', () => R.detachViewer(room, ws));
}

// Derruba sockets mortos — sem isso o contador de viewers fica mentindo.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.__alive === false) {
      ws.terminate();
      continue;
    }
    ws.__alive = false;
    ws.ping();
  }
}, 30_000);

wss.on('connection', (ws) => {
  ws.__alive = true;
  ws.on('pong', () => {
    ws.__alive = true;
  });
});

wss.on('close', () => clearInterval(heartbeat));

// Porta ocupada e o tropeco mais comum aqui: basta um "npm start" esquecido
// numa janela. Sem isto, o Node cospe um stack trace de vinte linhas que nao
// diz nem qual e o problema nem o que fazer.
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;

  console.error('');
  console.error(`  A porta ${PORT} já está sendo usada.`);
  console.error('  Quase sempre é outra janela deste mesmo programa aberta.');
  console.error('  Feche a outra janela e tente de novo.');
  console.error('');
  console.error('  Se precisar rodar os dois, mude PORT no arquivo .env.');
  console.error('');
  process.exit(1);
});

/** Data da modificação mais recente dentro de um caminho. */
function maisRecente(alvo) {
  const s = fs.statSync(alvo);
  if (!s.isDirectory()) return s.mtimeMs;
  return fs
    .readdirSync(alvo)
    .reduce((maior, nome) => Math.max(maior, maisRecente(path.join(alvo, nome))), 0);
}

/**
 * Avisa quando o que está no ar foi montado antes da última mudança no código.
 *
 * Quem roda "npm run dev" vê as mudanças no localhost:5173, mas o Discord entra
 * por esta porta — que serve o último build. A mudança parece não ter
 * acontecido, e não há nada na tela que explique por quê.
 */
function avisarBuildVelho() {
  const raiz = path.join(__dirname, '..');
  try {
    const build = fs.statSync(path.join(clientDist, 'index.html')).mtimeMs;
    const fonte = Math.max(
      maisRecente(path.join(raiz, 'client', 'src')),
      maisRecente(path.join(raiz, 'client', 'index.html')),
      maisRecente(path.join(raiz, 'shared'))
    );
    if (fonte <= build) return;

    console.log('');
    console.log('  Aviso: o site no ar foi montado antes da sua última mudança no código.');
    console.log('  Pelo Discord as pessoas ainda veem a versão antiga.');
    console.log('  Rode "npm start" para montar de novo — "npm run dev" atualiza só o 5173.');
  } catch {
    // Ainda sem build; o proprio arranque ja diz o que fazer.
  }
}

server.listen(PORT, () => {
  const local = `http://localhost:${PORT}`;

  console.log('');
  console.log(`  Sala de Tela no ar em  ${local}`);
  console.log(`  Abra esse endereço no navegador para usar fora do Discord.`);
  console.log('');

  if (DISCORD_CLIENT_ID) {
    console.log(`  Discord: ligado · aplicação ${DISCORD_CLIENT_ID}`);
    console.log(`  Endereço público: ${PUBLIC_ORIGIN}`);
    console.log(`  Redirect que precisa estar no portal: ${PUBLIC_ORIGIN}/auth/callback`);
  } else {
    console.log('  Discord: desligado (só navegador).');
    console.log('  Para usar dentro do Discord, rode: npm run configurar');
  }

  // Erro fácil de cometer e difícil de diagnosticar: com PUBLIC_ORIGIN
  // apontando para o proxy, a página de captura abre dentro do sandbox do
  // Discord e getDisplayMedia volta a ser bloqueado.
  if (PUBLIC_ORIGIN.includes('discordsays.com')) {
    console.error('');
    console.error('  ERRO: o endereço público aponta para o proxy do Discord.');
    console.error('  A tela de captura precisa abrir fora do Discord, senão a');
    console.error('  captura é bloqueada. Rode: npm run tunel');
  }

  avisarBuildVelho();

  if (DISCORD_CLIENT_ID && PUBLIC_ORIGIN.startsWith('http://localhost')) {
    console.log('');
    console.log('  Aviso: o Discord não alcança localhost. Rode: npm run tunel');
  }

  console.log('');
});
