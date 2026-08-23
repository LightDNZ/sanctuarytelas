/**
 * O mesmo servidor, agora com tudo configurado: aplicação do Discord, token de
 * bot e painel administrativo ligado.
 *
 * Arquivo separado do `index.test.js` porque essas decisões são tomadas no
 * corpo do módulo, uma vez: com o painel ligado ou desligado, é outro servidor.
 * O endereço público é https aqui de propósito — é o que faz o cookie de sessão
 * sair com `Secure`, e isso não dá para testar na mesma instância que o testa
 * sem.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '123456789012345678';
const SEGUNDO = '222222222222222222';
const OUTRO = '987654321098765432';

// Dois IDs separados por vírgula: o painel costuma ter mais de um dono, e por
// muito tempo só o primeiro entrava.
process.env.DISCORD_ADMIN_ID = `${ADMIN}, ${SEGUNDO}`;
process.env.DISCORD_CLIENT_ID = '111111111111111111';
process.env.DISCORD_CLIENT_SECRET = 'segredo-da-aplicacao';
process.env.DISCORD_BOT_TOKEN = 'token-do-bot';
process.env.PUBLIC_ORIGIN = 'https://exemplo.test';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const fetchReal = globalThis.fetch;
const { server, wss } = await import('./index.js');
const { signToken } = await import('./tokens.js');
if (!server.listening) await new Promise((pronto) => server.once('listening', pronto));
const base = `http://127.0.0.1:${server.address().port}`;

/** Rotas externas fingidas, na ordem em que foram registradas. */
let externas = [];
const finge = (padrao, responder) => externas.push([padrao, responder]);

vi.stubGlobal('fetch', async (url, init) => {
  const alvo = String(url);
  for (const [padrao, responder] of externas) {
    const bate = padrao instanceof RegExp ? padrao.test(alvo) : alvo.startsWith(padrao);
    if (bate) return responder(alvo, init);
  }
  if (alvo.startsWith(base)) return fetchReal(url, init);
  throw new Error(`chamada externa não prevista: ${alvo}`);
});

const json = (corpo, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

const post = (caminho, corpo, init = {}) =>
  fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo ?? {}),
    redirect: 'manual',
    ...init,
  });

const get = (caminho, init) => fetch(`${base}${caminho}`, { redirect: 'manual', ...init });

const comoAdmin = (uid = ADMIN) => ({
  Cookie: `discord_screen_admin=${signToken({ scope: 'admin', uid, name: 'Admin' }, 3600)}`,
});

/** O perfil que o Discord devolveria para o access_token deste teste. */
const perfil =
  (id, extra = {}) =>
  () =>
    json({ id, global_name: 'Alice', ...extra });

beforeEach(() => {
  externas = [];
});

afterAll(async () => {
  wss.close();
  await new Promise((pronto) => server.close(pronto));
});

describe('/api/token', () => {
  it('troca o código pelo access_token, sem o secret sair daqui', async () => {
    let corpoEnviado = null;
    finge('https://discord.com/api/oauth2/token', (_url, init) => {
      corpoEnviado = String(init.body);
      return json({ access_token: 'tok', refresh_token: 'nao-deveria-vazar' });
    });

    const resposta = await post('/api/token', { code: 'abc' });

    expect(await resposta.json()).toEqual({ access_token: 'tok' });
    expect(corpoEnviado).toContain('client_secret=segredo-da-aplicacao');
  });

  it('recusa quando a atividade é de outra aplicação', async () => {
    const resposta = await post('/api/token', { code: 'abc', client_id: '222222222222222222' });

    expect(resposta.status).toBe(409);
    expect((await resposta.json()).error).toMatch(/precisam ser a mesma/);
  });

  it('repassa o motivo do Discord, que separa secret errado de código usado', async () => {
    finge('https://discord.com/api/oauth2/token', () =>
      json({ error: 'invalid_client', error_description: 'client credentials invalid' }),
    );

    const resposta = await post('/api/token', { code: 'abc' });

    expect(resposta.status).toBe(401);
    expect((await resposta.json()).error).toContain('client credentials invalid');
  });

  it('devolve erro interno quando a chamada explode', async () => {
    finge('https://discord.com/api/oauth2/token', () => {
      throw new Error('rede fora');
    });

    expect((await post('/api/token', { code: 'abc' })).status).toBe(500);
  });
});

describe('presença na call, confirmada pelo bot', () => {
  const GUILD = '100000000000000001';
  const CANAL = '200000000000000001';

  function comVoz(resposta, guild = GUILD) {
    finge(new RegExp(`/guilds/${guild}/voice-states/`), resposta);
    finge(new RegExp(`/guilds/${guild}$`), () => json({ name: 'Servidor' }));
    finge('https://discord.com/api/users/@me', perfil(ADMIN));
  }

  const abrir = (guild = GUILD, channel = CANAL) =>
    post('/api/session', {
      access_token: 'tok',
      instance_id: 'i',
      guild_id: guild,
      channel_id: channel,
    });

  it('carimba a call no token quando o Discord confirma', async () => {
    comVoz(() => json({ channel_id: CANAL }));

    const corpo = await (await abrir()).json();

    expect(corpo.call).toBe(CANAL);
    expect(corpo.guildName).toBe('Servidor');
  });

  it('barra quem não está na call', async () => {
    const guild = '100000000000000002';
    comVoz(() => json({ channel_id: 'outro-canal' }), guild);

    const resposta = await abrir(guild);

    expect(resposta.status).toBe(403);
    expect((await resposta.json()).error).toMatch(/Entre na call/);
  });

  it('404 sem estado de voz é ausência: barra', async () => {
    const guild = '100000000000000003';
    comVoz(() => json({ code: 10026 }, 404), guild);

    expect((await abrir(guild)).status).toBe(403);
  });

  it('mas "bot fora do servidor" não é ausência: deixa entrar sem confirmar', async () => {
    const guild = '100000000000000004';
    comVoz(() => json({ code: 10004 }, 404), guild);

    const corpo = await (await abrir(guild)).json();

    expect(corpo.call).toBeNull();
    expect(corpo.guild).toBe(guild);
  });

  it('erro do Discord não tranca todo mundo para fora', async () => {
    const guild = '100000000000000005';
    comVoz(() => json({}, 500), guild);

    const corpo = await (await abrir(guild)).json();

    expect(corpo.call).toBeNull();
  });

  it('falha de rede também não tranca', async () => {
    const guild = '100000000000000006';
    comVoz(() => {
      throw new Error('sem resposta');
    }, guild);

    expect((await abrir(guild)).status).toBe(200);
  });
});

describe('nome do servidor', () => {
  it('é perguntado uma vez e guardado por uma hora', async () => {
    const guild = '300000000000000001';
    let idas = 0;
    finge(new RegExp(`/guilds/${guild}/voice-states/`), () => json({ channel_id: 'x' }));
    finge(new RegExp(`/guilds/${guild}$`), () => {
      idas++;
      return json({ name: 'Servidor' });
    });
    finge('https://discord.com/api/users/@me', perfil(ADMIN));

    const abrir = () =>
      post('/api/session', { access_token: 'tok', instance_id: 'i', guild_id: guild });
    await abrir();
    await abrir();

    expect(idas).toBe(1);
  });

  it('vira null quando o bot não enxerga o servidor', async () => {
    const guild = '300000000000000002';
    finge(new RegExp(`/guilds/${guild}$`), () => json({ message: 'Unknown Guild' }, 403));
    finge('https://discord.com/api/users/@me', perfil(ADMIN));

    const corpo = await (
      await post('/api/session', { access_token: 'tok', instance_id: 'i', guild_id: guild })
    ).json();

    expect(corpo.guildName).toBeNull();
  });

  it('vira null quando a chamada falha', async () => {
    const guild = '300000000000000003';
    finge(new RegExp(`/guilds/${guild}$`), () => {
      throw new Error('sem resposta');
    });
    finge('https://discord.com/api/users/@me', perfil(ADMIN));

    const corpo = await (
      await post('/api/session', { access_token: 'tok', instance_id: 'i', guild_id: guild })
    ).json();

    expect(corpo.guildName).toBeNull();
  });
});

describe('login administrativo', () => {
  it('manda ao Discord com um state assinado', async () => {
    const destino = new URL((await get('/admin/auth/login')).headers.get('location'));

    expect(destino.hostname).toBe('discord.com');
    expect(destino.searchParams.get('redirect_uri')).toBe('https://exemplo.test/auth/callback');
    expect(destino.searchParams.get('state')).toBeTruthy();
  });

  const stateAdmin = () => signToken({ scope: 'oauth-state', target: 'admin' }, 600);

  it('recusa uma conta que não é a do painel', async () => {
    finge('https://discord.com/api/oauth2/token', () => json({ access_token: 'tok' }));
    finge('https://discord.com/api/users/@me', perfil(OUTRO));

    const resposta = await get(`/auth/callback?code=abc&state=${stateAdmin()}`);

    expect(resposta.headers.get('location')).toBe('/admin?error=forbidden');
  });

  it('emite o cookie de sessão, marcado Secure em https', async () => {
    finge('https://discord.com/api/oauth2/token', () => json({ access_token: 'tok' }));
    finge('https://discord.com/api/users/@me', perfil(ADMIN));

    const resposta = await get(`/auth/callback?code=abc&state=${stateAdmin()}`);
    const cookie = resposta.headers.get('set-cookie');

    expect(resposta.headers.get('location')).toBe('/admin');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
  });

  it('erros do fluxo voltam para o painel, não para a página inicial', async () => {
    finge('https://discord.com/api/oauth2/token', () => json({ error: 'invalid_grant' }));

    const resposta = await get(`/auth/callback?code=abc&state=${stateAdmin()}`);

    expect(resposta.headers.get('location')).toBe('/admin?error=troca_falhou');
  });

  it('perfil que não vem também volta para o painel', async () => {
    finge('https://discord.com/api/oauth2/token', () => json({ access_token: 'tok' }));
    finge('https://discord.com/api/users/@me', () => json({}));

    const resposta = await get(`/auth/callback?code=abc&state=${stateAdmin()}`);

    expect(resposta.headers.get('location')).toBe('/admin?error=perfil_falhou');
  });
});

describe('/api/admin/me', () => {
  it('recusa sem cookie', async () => {
    const resposta = await get('/api/admin/me');

    expect(resposta.status).toBe(401);
    expect(await resposta.json()).toMatchObject({ configured: true });
  });

  it('recusa a sessão de outra conta do Discord', async () => {
    expect((await get('/api/admin/me', { headers: comoAdmin(OUTRO) })).status).toBe(401);
  });

  it('aceita o segundo ID da lista, não só o primeiro', async () => {
    const resposta = await get('/api/admin/me', { headers: comoAdmin(SEGUNDO) });

    expect(resposta.status).toBe(200);
    expect((await resposta.json()).user.id).toBe(SEGUNDO);
  });

  it('recusa um cookie que não é sessão de painel', async () => {
    const disfarce = signToken({ scope: 'identity', uid: ADMIN }, 600);

    const resposta = await get('/api/admin/me', {
      headers: { Cookie: `discord_screen_admin=${disfarce}` },
    });

    expect(resposta.status).toBe(401);
  });

  it('identifica quem está no painel', async () => {
    const corpo = await (await get('/api/admin/me', { headers: comoAdmin() })).json();

    expect(corpo).toMatchObject({ configured: true, user: { id: ADMIN, name: 'Admin' } });
  });

  it('atravessa um cabeçalho com vários cookies', async () => {
    const { Cookie } = comoAdmin();

    const resposta = await get('/api/admin/me', {
      headers: { Cookie: `outro=1; ${Cookie}; mais=2` },
    });

    expect(resposta.status).toBe(200);
  });

  it('ignora um cookie sem valor', async () => {
    expect((await get('/api/admin/me', { headers: { Cookie: 'sozinho' } })).status).toBe(401);
  });
});

describe('/api/admin/metrics', () => {
  it('recusa sem sessão, e não deixa a resposta ser cacheada', async () => {
    const resposta = await get('/api/admin/metrics');

    expect(resposta.status).toBe(401);
    expect(resposta.headers.get('cache-control')).toBe('no-store');
  });

  it('entrega o painel inteiro, sem o segredo de sessão dentro', async () => {
    const resposta = await get('/api/admin/metrics', { headers: comoAdmin() });
    const painel = await resposta.json();

    expect(painel.configuration).toMatchObject({
      environment: 'test',
      adminIds: [ADMIN, SEGUNDO],
      botConfigured: true,
      sessionSecretConfigured: true,
      publicOrigin: 'https://exemplo.test',
    });
    expect(painel.summary).toHaveProperty('connections');
    expect(painel.system).toHaveProperty('platform');
    expect(JSON.stringify(painel)).not.toContain(process.env.SESSION_SECRET);
  });
});

describe('/api/config', () => {
  it('entrega o Client ID, que é público, e nunca o secret', async () => {
    const corpo = await (await get('/api/config')).json();

    expect(corpo.clientId).toBe('111111111111111111');
    expect(JSON.stringify(corpo)).not.toContain('segredo-da-aplicacao');
  });
});

describe('/api/admin/logout', () => {
  it('apaga o cookie, também marcado Secure em https', async () => {
    const cookie = (await post('/api/admin/logout')).headers.get('set-cookie');

    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Secure');
  });
});
