/**
 * O painel administrativo é uma função pura: recebe o estado das salas e
 * devolve o que a tela desenha. Tudo o que se testa aqui é agregação — a
 * mesma pessoa em duas salas é uma pessoa, o mesmo servidor visto por três
 * salas é um servidor.
 */
import { describe, expect, it } from 'vitest';
import { buildAdminDashboard } from './admin.js';

function trafego(recebido = 0, transmitido = 0) {
  return {
    receivedBytes: recebido,
    transmittedBytes: transmitido,
    droppedBytes: 0,
    receivedBytesPerSecond: 0,
    transmittedBytesPerSecond: 0,
    droppedBytesPerSecond: 0,
  };
}

function usuario(id, extra = {}) {
  return {
    id,
    name: `Pessoa ${id}`,
    avatar: null,
    roles: ['viewer'],
    connections: 1,
    connectedAt: 1000,
    pingMs: null,
    watching: [],
    broadcasting: false,
    mediaBytesOut: 0,
    bufferedBytes: 0,
    ...extra,
  };
}

function sala(id, extra = {}) {
  return {
    id,
    name: `Sala ${id}`,
    instance: 'canal',
    guildId: null,
    guildName: null,
    channelId: null,
    isCall: false,
    locked: false,
    createdAt: 1000,
    connections: 1,
    viewers: 1,
    broadcasters: 0,
    droppedChunks: 0,
    traffic: trafego(),
    users: [],
    streams: [],
    ...extra,
  };
}

const montar = (rooms, sockets = new Set()) =>
  buildAdminDashboard({
    roomState: { rooms, traffic: trafego(10, 20), startedAt: 500 },
    sockets,
    system: { platform: 'linux' },
    configuration: { discord: true },
  });

describe('buildAdminDashboard', () => {
  it('devolve um painel vazio quando não há sala nenhuma', () => {
    const painel = montar([]);

    expect(painel.summary).toMatchObject({ users: 0, rooms: 0, guilds: 0, streams: 0 });
    expect(painel.summary.pingAverageMs).toBeNull();
    expect(painel.summary.pingMedianMs).toBeNull();
  });

  it('repassa configuração, sistema e tráfego sem mexer', () => {
    const painel = montar([]);

    expect(painel.configuration).toEqual({ discord: true });
    expect(painel.system).toEqual({ platform: 'linux' });
    expect(painel.traffic).toEqual(trafego(10, 20));
    expect(painel.startedAt).toBe(500);
  });

  it('junta a mesma pessoa vista em duas salas', () => {
    const painel = montar([
      sala('a', { users: [usuario('alice', { connections: 2, mediaBytesOut: 100 })] }),
      sala('b', {
        users: [
          usuario('alice', {
            roles: ['broadcaster'],
            broadcasting: true,
            connectedAt: 200,
            mediaBytesOut: 50,
          }),
        ],
      }),
    ]);

    expect(painel.users).toHaveLength(1);
    expect(painel.users[0]).toMatchObject({
      id: 'alice',
      rooms: ['a', 'b'],
      connections: 3,
      // O instante mais antigo é o que vale: é quando ela chegou.
      connectedAt: 200,
      broadcasting: true,
      mediaBytesOut: 150,
    });
    expect(painel.users[0].roles).toEqual(expect.arrayContaining(['viewer', 'broadcaster']));
  });

  it('põe quem transmite no topo, e desempata pelo nome', () => {
    const painel = montar([
      sala('a', {
        users: [
          usuario('c', { name: 'Carla' }),
          usuario('a', { name: 'Ana' }),
          usuario('b', { name: 'Bruno', broadcasting: true }),
        ],
      }),
    ]);

    expect(painel.users.map((u) => u.name)).toEqual(['Bruno', 'Ana', 'Carla']);
  });

  it('tira a média dos pings de cada pessoa', () => {
    const painel = montar([
      sala('a', { users: [usuario('alice', { pingMs: 10 })] }),
      sala('b', { users: [usuario('alice', { pingMs: 30 })] }),
    ]);

    expect(painel.users[0].pingMs).toBe(20);
  });

  it('agrupa as salas por servidor do Discord', () => {
    const painel = montar([
      sala('a', {
        guildId: 'g1',
        guildName: 'Servidor',
        connections: 3,
        traffic: trafego(100, 200),
        users: [usuario('alice')],
        streams: [{ slot: 0, watchers: 2 }],
      }),
      sala('b', {
        guildId: 'g1',
        isCall: true,
        connections: 2,
        traffic: trafego(50, 0),
        users: [usuario('alice'), usuario('bob')],
      }),
      sala('c', { guildId: 'g2', guildName: 'Outro', connections: 1 }),
    ]);

    const [maior, menor] = painel.guilds;
    expect(maior).toMatchObject({ id: 'g1', name: 'Servidor', rooms: 2, calls: 1, connections: 5 });
    // Duas salas, mas duas pessoas: o Set não deixa a Alice contar duas vezes.
    expect(maior.users).toBe(2);
    expect(maior.traffic.receivedBytes).toBe(150);
    expect(menor.id).toBe('g2');
  });

  it('ignora sala sem servidor na hora de agrupar', () => {
    const painel = montar([sala('a', { users: [usuario('alice')] })]);

    expect(painel.guilds).toHaveLength(0);
    expect(painel.users[0].guilds).toEqual([]);
  });

  it('carimba em cada transmissão de onde ela veio', () => {
    const painel = montar([
      sala('a', {
        guildId: 'g1',
        guildName: 'Servidor',
        channelId: 'c1',
        streams: [{ slot: 0, watchers: 3 }],
      }),
    ]);

    expect(painel.streams[0]).toMatchObject({
      slot: 0,
      roomId: 'a',
      roomName: 'Sala a',
      guildId: 'g1',
      guildName: 'Servidor',
      channelId: 'c1',
    });
    expect(painel.summary.activeWatchers).toBe(3);
  });

  it('resume os pings das conexões abertas em média, mediana e p95', () => {
    const sockets = new Set([
      { __rttMs: 10 },
      { __rttMs: 20 },
      { __rttMs: 30 },
      { __rttMs: 40 },
      // Sem medida ainda: não entra na conta em vez de contar como zero.
      { __rttMs: null },
    ]);

    const painel = montar([sala('a')], sockets);

    expect(painel.summary.pingAverageMs).toBe(25);
    expect(painel.summary.pingMedianMs).toBe(30);
    expect(painel.summary.pingP95Ms).toBe(40);
    expect(painel.summary.connections).toBe(5);
  });

  it('soma espectadores e transmissores de todas as salas', () => {
    const painel = montar([
      sala('a', { viewers: 2, broadcasters: 1 }),
      sala('b', { viewers: 3, broadcasters: 2 }),
    ]);

    expect(painel.summary).toMatchObject({
      viewerConnections: 5,
      broadcasterConnections: 3,
      rooms: 2,
    });
  });
});
