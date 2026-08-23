/**
 * Faxina: o fechamento de sala vazia e a poda dos baldes de tráfego.
 *
 * Os dois são movidos pelo relógio, e o intervalo que fecha sala nasce junto
 * com o módulo. Por isso este arquivo é separado: o relógio falso precisa
 * estar de pé *antes* do import, senão o `setInterval` já capturado é o de
 * verdade e nada aqui adianta o tempo dele.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.useFakeTimers();
const R = await import('./rooms.js');

const SWEEP = 4 * 1000;
const CARENCIA = 12 * 1000;
const SEM_PRESENCA = 15 * 1000;

let sequencia = 0;
const instancia = () => `faxina-${++sequencia}`;

function socket() {
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    recebidas: [],
    send(data) {
      if (typeof data === 'string') this.recebidas.push(JSON.parse(data));
    },
  };
}

function sala() {
  return R.createRoom({ instance: instancia(), ownerId: 'u1', ownerName: 'Alice' }).room;
}

beforeEach(() => {
  // O fechamento se anuncia no log; o teste é sobre a sala, não sobre o texto.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('sala vazia', () => {
  it('sobrevive à carência, e some depois dela', () => {
    const { id } = sala();

    vi.advanceTimersByTime(SWEEP);
    expect(R.getRoom(id)).not.toBeNull();

    vi.advanceTimersByTime(CARENCIA + SWEEP);
    expect(R.getRoom(id)).toBeNull();
  });

  it('não fecha enquanto houver alguém dentro', () => {
    const room = sala();
    R.attachViewer(room, socket(), { id: 'espectador', name: 'Quem fica' });

    vi.advanceTimersByTime(CARENCIA * 3);

    expect(R.getRoom(room.id)).toBe(room);
  });

  it('não fecha enquanto quem transmite continuar na sala', () => {
    const room = sala();
    const quem = { id: 'transmissor', name: 'Quem transmite' };
    R.attachBroadcaster(room, socket(), quem);
    // A aba de captura tem conexão própria; quem segura a sala é a presença
    // dessa pessoa na atividade.
    R.attachViewer(room, socket(), quem);

    vi.advanceTimersByTime(CARENCIA * 3);

    expect(R.getRoom(room.id)).toBe(room);
  });

  it('derruba a transmissão de quem saiu da atividade, e aí a sala fecha', () => {
    const room = sala();
    const captura = socket();
    R.attachBroadcaster(room, captura, { id: 'transmissor', name: 'Quem transmite' });

    // Ninguém com esse id está na sala: passada a carência, a aba de captura é
    // avisada e a transmissão encerrada.
    vi.advanceTimersByTime(SEM_PRESENCA + SWEEP * 2);

    expect(captura.recebidas.some((m) => m.type === 'stop-request')).toBe(true);
    expect(room.broadcasters.size).toBe(0);

    vi.advanceTimersByTime(CARENCIA + SWEEP);
    expect(R.getRoom(room.id)).toBeNull();
  });

  it('a carência recomeça quando a última pessoa sai', () => {
    const room = sala();
    const viewer = socket();
    R.attachViewer(room, viewer, { id: 'espectador', name: 'Alguém' });
    vi.advanceTimersByTime(CARENCIA * 2);

    R.detachViewer(room, viewer);
    // Sai agora: a primeira varredura só marca o instante em que esvaziou.
    vi.advanceTimersByTime(SWEEP);
    expect(R.getRoom(room.id)).toBe(room);

    vi.advanceTimersByTime(CARENCIA + SWEEP);
    expect(R.getRoom(room.id)).toBeNull();
  });
});

describe('baldes de tráfego', () => {
  it('guardam só o último minuto', () => {
    const room = sala();
    const ws = socket();
    const entry = R.attachBroadcaster(room, ws, { id: 'transmissor', name: 'T' });
    R.startStream(room, entry);
    const chunk = Buffer.alloc(64);
    chunk[0] = entry.slot;
    chunk[1] = 1;

    R.pushChunk(room, entry, chunk);
    const primeiroSegundo = Math.floor(Date.now() / 1000);
    expect(room.traffic.buckets.has(primeiroSegundo)).toBe(true);

    vi.advanceTimersByTime(90 * 1000);
    R.pushChunk(room, entry, chunk);

    expect(room.traffic.buckets.has(primeiroSegundo)).toBe(false);
    // O acumulado não some junto: o que é podado é a série por segundo.
    expect(room.traffic.receivedBytes).toBe(128);
  });
});
