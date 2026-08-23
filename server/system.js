import fs from 'node:fs';
import os from 'node:os';

const startedAt = Date.now();

let previousProcessCpu = process.cpuUsage();
let previousSampleNs = process.hrtime.bigint();
let previousHostCpu = hostCpuTimes();
let previousNetwork = linuxNetworkTotals();

let cached = collectStaticSnapshot();

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  // Number(null) e Number('') sao 0, e 0 e finito: sem esta guarda um arquivo
  // de cgroup ausente virava "0 bytes de memoria" no painel, indistinguivel de
  // uma medida de verdade — e a saida antecipada de cgroupSnapshot, que existe
  // para dizer "nao ha cgroup aqui", nunca disparava fora de um container.
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hostCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function linuxNetworkTotals() {
  if (process.platform !== 'linux') return null;
  const raw = readText('/proc/net/dev');
  if (!raw) return null;

  let receivedBytes = 0;
  let transmittedBytes = 0;
  const interfaces = [];

  for (const line of raw.split('\n').slice(2)) {
    const [rawName, rawValues] = line.split(':');
    if (!rawName || !rawValues) continue;
    const name = rawName.trim();
    if (!name || name === 'lo') continue;

    const values = rawValues.trim().split(/\s+/).map(Number);
    if (values.length < 9 || values.some((value) => !Number.isFinite(value))) continue;

    const received = values[0];
    const transmitted = values[8];
    receivedBytes += received;
    transmittedBytes += transmitted;
    interfaces.push({ name, receivedBytes: received, transmittedBytes: transmitted });
  }

  return { receivedBytes, transmittedBytes, interfaces };
}

function cgroupSnapshot() {
  if (process.platform !== 'linux') return null;

  // cgroup v2. Em Docker moderno estes arquivos representam o proprio
  // container; fora dele normalmente representam a maquina inteira.
  const memoryCurrent = finiteNumber(readText('/sys/fs/cgroup/memory.current'));
  const rawMemoryMax = readText('/sys/fs/cgroup/memory.max');
  const memoryMax = rawMemoryMax && rawMemoryMax !== 'max' ? finiteNumber(rawMemoryMax) : null;
  const pidsCurrent = finiteNumber(readText('/sys/fs/cgroup/pids.current'));
  const rawPidsMax = readText('/sys/fs/cgroup/pids.max');
  const pidsMax = rawPidsMax && rawPidsMax !== 'max' ? finiteNumber(rawPidsMax) : null;

  let cpuLimitCores = null;
  const cpuMax = readText('/sys/fs/cgroup/cpu.max');
  if (cpuMax) {
    const [quota, period] = cpuMax.split(/\s+/);
    if (quota !== 'max' && finiteNumber(quota) !== null && finiteNumber(period)) {
      cpuLimitCores = Number(quota) / Number(period);
    }
  }

  if (
    memoryCurrent === null &&
    memoryMax === null &&
    pidsCurrent === null &&
    pidsMax === null &&
    cpuLimitCores === null
  ) {
    return null;
  }

  return { memoryCurrent, memoryMax, pidsCurrent, pidsMax, cpuLimitCores };
}

function diskSnapshot() {
  try {
    const stat = fs.statfsSync(process.cwd());
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
  } catch {
    return null;
  }
}

function networkAddresses() {
  const result = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue;
      result.push({ name, address: address.address, family: address.family });
    }
  }
  return result;
}

function collectStaticSnapshot() {
  const cpus = os.cpus();
  return {
    sampledAt: Date.now(),
    startedAt,
    platform: process.platform,
    architecture: process.arch,
    release: os.release(),
    hostname: os.hostname(),
    nodeVersion: process.version,
    cpu: {
      model: cpus[0]?.model ?? 'desconhecido',
      logicalCores: cpus.length,
      processPercent: 0,
      hostPercent: 0,
      loadAverage: os.loadavg(),
    },
    memory: {
      hostTotalBytes: os.totalmem(),
      hostFreeBytes: os.freemem(),
      process: process.memoryUsage(),
    },
    disk: diskSnapshot(),
    network: {
      source: process.platform === 'linux' ? 'sistema' : 'indisponivel',
      receivedBytes: previousNetwork?.receivedBytes ?? null,
      transmittedBytes: previousNetwork?.transmittedBytes ?? null,
      receivedBytesPerSecond: null,
      transmittedBytesPerSecond: null,
      interfaces: previousNetwork?.interfaces ?? [],
      addresses: networkAddresses(),
    },
    container: cgroupSnapshot(),
    uptimeSeconds: os.uptime(),
    processUptimeSeconds: process.uptime(),
  };
}

function sample() {
  const nowNs = process.hrtime.bigint();
  const elapsedMicros = Number(nowNs - previousSampleNs) / 1000;

  const processCpu = process.cpuUsage();
  const processCpuDelta =
    processCpu.user - previousProcessCpu.user + processCpu.system - previousProcessCpu.system;
  const processPercent = elapsedMicros > 0 ? (processCpuDelta / elapsedMicros) * 100 : 0;

  const hostCpu = hostCpuTimes();
  const totalDelta = hostCpu.total - previousHostCpu.total;
  const idleDelta = hostCpu.idle - previousHostCpu.idle;
  const hostPercent = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;

  const network = linuxNetworkTotals();
  const elapsedSeconds = elapsedMicros / 1_000_000;
  const networkRate =
    network && previousNetwork && elapsedSeconds > 0
      ? {
          receivedBytesPerSecond: Math.max(
            0,
            (network.receivedBytes - previousNetwork.receivedBytes) / elapsedSeconds,
          ),
          transmittedBytesPerSecond: Math.max(
            0,
            (network.transmittedBytes - previousNetwork.transmittedBytes) / elapsedSeconds,
          ),
        }
      : { receivedBytesPerSecond: null, transmittedBytesPerSecond: null };

  cached = {
    ...cached,
    sampledAt: Date.now(),
    cpu: {
      ...cached.cpu,
      processPercent,
      hostPercent,
      loadAverage: os.loadavg(),
    },
    memory: {
      hostTotalBytes: os.totalmem(),
      hostFreeBytes: os.freemem(),
      process: process.memoryUsage(),
    },
    disk: diskSnapshot(),
    network: {
      source: network ? 'sistema' : 'indisponivel',
      receivedBytes: network?.receivedBytes ?? null,
      transmittedBytes: network?.transmittedBytes ?? null,
      ...networkRate,
      interfaces: network?.interfaces ?? [],
      addresses: networkAddresses(),
    },
    container: cgroupSnapshot(),
    uptimeSeconds: os.uptime(),
    processUptimeSeconds: process.uptime(),
  };

  previousProcessCpu = processCpu;
  previousSampleNs = nowNs;
  previousHostCpu = hostCpu;
  previousNetwork = network;
}

let sampler = null;

/**
 * Liga a amostragem periódica. Só quem abre o painel precisa dela.
 *
 * Antes o intervalo subia junto com o import, e todo mundo que roda o programa
 * pagava um timer de 1 em 1 segundo — lendo /proc e varrendo os núcleos — por
 * um painel que, sem DISCORD_ADMIN_ID, nem liga. Quem não usa não paga.
 *
 * unref para o timer não segurar o processo de pé no encerramento.
 */
export function startSampling() {
  if (sampler) return;
  sampler = setInterval(sample, 1000);
  sampler.unref?.();
}

export function systemSnapshot() {
  return cached;
}
