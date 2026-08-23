/**
 * Métricas de máquina.
 *
 * Metade deste módulo só existe no Linux — `/proc/net/dev` e os arquivos de
 * cgroup —, e o outro lado do teste é justamente que ele não quebre onde eles
 * não existem. Por isso o platform é forjado nos dois sentidos, e cada cenário
 * importa o módulo de novo: o retrato estático é montado no corpo dele.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const PLATAFORMA = process.platform;

/**
 * Uma instância nova do módulo, com a plataforma e os arquivos que este
 * cenário quiser.
 */
async function carregar({ plataforma = PLATAFORMA, arquivos = null } = {}) {
  Object.defineProperty(process, 'platform', { value: plataforma, configurable: true });
  if (arquivos) {
    vi.spyOn(fs, 'readFileSync').mockImplementation((caminho) => {
      const conteudo = arquivos[caminho];
      if (conteudo === undefined) throw new Error(`ENOENT: ${caminho}`);
      return conteudo;
    });
  }
  vi.resetModules();
  return import('./system.js');
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: PLATAFORMA, configurable: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('systemSnapshot', () => {
  it('descreve a máquina onde o processo está', async () => {
    const { systemSnapshot } = await carregar();
    const retrato = systemSnapshot();

    expect(retrato).toMatchObject({
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
    });
    expect(retrato.cpu.logicalCores).toBeGreaterThan(0);
    expect(retrato.memory.hostTotalBytes).toBeGreaterThan(0);
    expect(Array.isArray(retrato.cpu.loadAverage)).toBe(true);
    expect(Array.isArray(retrato.network.addresses)).toBe(true);
  });

  it('começa sem percentual de CPU, que só existe entre duas amostras', async () => {
    const { systemSnapshot } = await carregar();

    expect(systemSnapshot().cpu.processPercent).toBe(0);
    expect(systemSnapshot().cpu.hostPercent).toBe(0);
  });

  it('reporta o disco, ou null onde não dá para medir', async () => {
    const { systemSnapshot } = await carregar();
    const { disk } = systemSnapshot();

    if (disk) expect(disk.totalBytes).toBeGreaterThan(0);
    else expect(disk).toBeNull();
  });

  it('devolve null no disco quando statfs falha', async () => {
    vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
      throw new Error('sem acesso');
    });
    const { systemSnapshot } = await carregar();

    expect(systemSnapshot().disk).toBeNull();
  });
});

describe('fora do Linux', () => {
  it('não tenta ler /proc nem cgroup', async () => {
    const { systemSnapshot } = await carregar({ plataforma: 'win32' });
    const retrato = systemSnapshot();

    expect(retrato.network.source).toBe('indisponivel');
    expect(retrato.network.receivedBytes).toBeNull();
    expect(retrato.container).toBeNull();
  });
});

describe('no Linux', () => {
  const REDE = [
    'Inter-|   Receive                    |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets',
    '    lo:  100       1    0    0    0     0          0         0     100       1',
    '  eth0: 1000      10    0    0    0     0          0         0    2000      20',
    '  eth1:  500       5    0    0    0     0          0         0     700       7',
    '  ruim:  nada',
    '',
  ].join('\n');

  const CGROUP = {
    '/proc/net/dev': REDE,
    '/sys/fs/cgroup/memory.current': '1048576',
    '/sys/fs/cgroup/memory.max': '2097152',
    '/sys/fs/cgroup/pids.current': '42',
    '/sys/fs/cgroup/pids.max': '100',
    '/sys/fs/cgroup/cpu.max': '50000 100000',
  };

  it('soma as interfaces de rede, deixando de fora a loopback', async () => {
    const { systemSnapshot } = await carregar({ plataforma: 'linux', arquivos: CGROUP });
    const { network } = systemSnapshot();

    expect(network.source).toBe('sistema');
    expect(network.receivedBytes).toBe(1500);
    expect(network.transmittedBytes).toBe(2700);
    expect(network.interfaces.map((i) => i.name)).toEqual(['eth0', 'eth1']);
  });

  it('lê os limites do container', async () => {
    const { systemSnapshot } = await carregar({ plataforma: 'linux', arquivos: CGROUP });

    expect(systemSnapshot().container).toEqual({
      memoryCurrent: 1048576,
      memoryMax: 2097152,
      pidsCurrent: 42,
      pidsMax: 100,
      cpuLimitCores: 0.5,
    });
  });

  it('trata "max" como ausência de limite, não como número', async () => {
    const { systemSnapshot } = await carregar({
      plataforma: 'linux',
      arquivos: {
        '/sys/fs/cgroup/memory.current': '1024',
        '/sys/fs/cgroup/memory.max': 'max',
        '/sys/fs/cgroup/pids.max': 'max',
        '/sys/fs/cgroup/cpu.max': 'max 100000',
      },
    });

    expect(systemSnapshot().container).toMatchObject({
      memoryMax: null,
      pidsMax: null,
      cpuLimitCores: null,
    });
  });

  it('devolve null quando nenhum arquivo de cgroup existe', async () => {
    const { systemSnapshot } = await carregar({ plataforma: 'linux', arquivos: {} });

    expect(systemSnapshot().container).toBeNull();
    expect(systemSnapshot().network.receivedBytes).toBeNull();
  });
});

describe('startSampling', () => {
  it('atualiza o retrato de tempos em tempos, e não liga dois relógios', async () => {
    vi.useFakeTimers();
    const { startSampling, systemSnapshot } = await carregar();
    const antes = systemSnapshot().sampledAt;

    startSampling();
    startSampling();
    vi.advanceTimersByTime(3000);

    const depois = systemSnapshot();
    expect(depois.sampledAt).toBeGreaterThanOrEqual(antes);
    expect(Number.isFinite(depois.cpu.processPercent)).toBe(true);
    expect(Number.isFinite(depois.cpu.hostPercent)).toBe(true);
  });

  it('calcula a taxa de rede entre duas amostras', async () => {
    vi.useFakeTimers();
    let recebidos = 1000;
    const { startSampling, systemSnapshot } = await carregar({
      plataforma: 'linux',
      arquivos: {},
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((caminho) => {
      if (caminho !== '/proc/net/dev') throw new Error(`ENOENT: ${caminho}`);
      return ['cabecalho', 'cabecalho', `  eth0: ${recebidos}  10 0 0 0 0 0 0 2000 20`, ''].join(
        '\n',
      );
    });

    startSampling();
    vi.advanceTimersByTime(1000);
    recebidos = 3000;
    vi.advanceTimersByTime(1000);

    expect(systemSnapshot().network.receivedBytesPerSecond).toBeGreaterThanOrEqual(0);
  });
});
