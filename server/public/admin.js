/**
 * Painel administrativo.
 *
 * A tela responde três perguntas, nesta ordem: está funcionando, quem está
 * usando agora, e a máquina aguenta. Tudo que não responde a uma delas ficou
 * de fora — número que só repete outro número não ajuda ninguém a decidir
 * nada.
 */

const $ = (id) => document.getElementById(id);

/** Últimas leituras de banda, para o gráfico. */
const historico = [];
const HISTORICO_MAX = 60;

let timer = null;
let carregando = false;
let ultimo = null;

// ------------------------------------------------------------------ formato

function text(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function formatBytes(value, decimals = 1) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(value)) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? decimals : 0)} ${units[index]}`;
}

function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond)) return '—';
  const bits = bytesPerSecond * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kb/s`;
  return `${bits.toFixed(0)} b/s`;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(0)}%` : '—';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}

/** Plural sem gambiarra de string: "1 sala" e "3 salas". */
function count(value, singular, plural) {
  return `${value} ${value === 1 ? singular : plural}`;
}

// -------------------------------------------------------------------- ciclo

/**
 * O ciclo só corre com a aba à vista.
 *
 * Cada volta varre todas as salas, pessoas e transmissões do servidor. Sem
 * pausar, uma aba esquecida aberta de um dia para o outro pede isso mais de
 * quarenta mil vezes sem ninguém olhando.
 */
function startPolling() {
  if (timer) return;
  timer = setInterval(loadMetrics, 2000);
}

function stopPolling() {
  clearInterval(timer);
  timer = null;
}

function setLive(ok, mensagem) {
  const live = $('live');
  live.className = ok ? 'badge on' : 'badge';
  live.replaceChildren(document.createElement('i'), document.createTextNode(` ${mensagem}`));
}

async function loadMetrics() {
  if (carregando) return;
  carregando = true;
  try {
    const response = await fetch('/api/admin/metrics', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    // A sessão dura 8 horas. Quando vence no meio do uso, recarregar devolve
    // a tela de entrada em vez de deixar o painel piscando erro.
    if (response.status === 401) {
      stopPolling();
      location.reload();
      return;
    }

    if (!response.ok) throw new Error(`servidor respondeu ${response.status}`);

    render(await response.json());
    setLive(true, 'Ao vivo');
    $('errorBanner').hidden = true;
  } catch (error) {
    setLive(false, 'Sem conexão');
    $('errorBanner').textContent = `Não foi possível atualizar: ${error.message}`;
    $('errorBanner').hidden = false;
  } finally {
    carregando = false;
  }
}

// ------------------------------------------------------------------ desenho

function render(data) {
  ultimo = data;
  const { summary, traffic } = data;

  text('statPeople', String(summary.users));
  text(
    'statPeopleSub',
    summary.rooms ? count(summary.rooms, 'sala', 'salas') : 'nenhuma sala aberta',
  );

  text('statStreams', String(summary.streams));
  text('statStreamsSub', count(summary.activeWatchers, 'assistindo', 'assistindo'));

  text(
    'statBandwidth',
    formatRate(traffic.receivedBytesPerSecond + traffic.transmittedBytesPerSecond),
  );
  text(
    'statBandwidthSub',
    `↓ ${formatRate(traffic.receivedBytesPerSecond)} · ↑ ${formatRate(traffic.transmittedBytesPerSecond)}`,
  );

  // Quadro que o servidor deixou de mandar porque a fila daquele espectador
  // estourou. É o único sinal na tela de que alguém não está aguentando
  // receber — sem ele, imagem travando não tem onde ser diagnosticada.
  const descartado = traffic.droppedBytesPerSecond;
  $('statDropped').hidden = !(descartado > 0);
  if (descartado > 0) text('statDropped', `${formatRate(descartado)} descartado`);

  text('statPing', formatMs(summary.pingAverageMs));
  text(
    'statPingSub',
    Number.isFinite(summary.pingP95Ms) ? `p95 ${formatMs(summary.pingP95Ms)}` : ' ',
  );

  renderPeople(data);
  renderRecursos(data.system);
  renderAmbiente(data);

  historico.push({
    inbound: traffic.receivedBytesPerSecond,
    outbound: traffic.transmittedBytesPerSecond,
  });
  if (historico.length > HISTORICO_MAX) historico.shift();
  drawChart();
}

// ------------------------------------------------------------------ pessoas

function renderPeople(data) {
  const nomesDeGuild = new Map(data.guilds.map((guild) => [guild.id, guild.name || guild.id]));
  const nomesDeSala = new Map(data.rooms.map((room) => [room.id, room.name]));
  const pessoas = data.users;

  text('peopleCount', String(pessoas.length));
  $('peopleEmpty').hidden = pessoas.length > 0;
  $('peopleScroll').hidden = pessoas.length === 0;

  const linhas = pessoas.map((pessoa) => {
    const linha = document.createElement('tr');

    // textContent em tudo: nome de usuário e de servidor vêm do Discord, ou
    // seja, são texto que outra pessoa escolhe. Montar isso com innerHTML
    // seria entregar o painel a quem trocar o apelido por uma tag <script>.
    celula(linha, pessoa.name, pessoa.id);
    celula(linha, pessoa.guilds.map((id) => nomesDeGuild.get(id) ?? id).join(', ') || '—');
    celula(linha, pessoa.rooms.map((id) => nomesDeSala.get(id) ?? id).join(', ') || '—');

    const estado = document.createElement('td');
    if (pessoa.broadcasting) {
      const selo = document.createElement('span');
      selo.className = 'badge on';
      selo.append(document.createElement('i'), document.createTextNode(' transmitindo'));
      estado.append(selo);
    } else {
      estado.textContent = '—';
      estado.className = 'muted';
    }
    linha.append(estado);

    const ping = document.createElement('td');
    ping.className = 'num';
    ping.textContent = formatMs(pessoa.pingMs);
    linha.append(ping);

    return linha;
  });

  $('peopleRows').replaceChildren(...linhas);
}

/** Uma célula com uma linha principal e, quando útil, uma segunda apagada. */
function celula(linha, principal, secundaria = null) {
  const td = document.createElement('td');
  const caixa = document.createElement('div');
  caixa.className = 'cell';

  const primeira = document.createElement('span');
  primeira.textContent = principal;
  caixa.append(primeira);

  if (secundaria) {
    const segunda = document.createElement('span');
    segunda.className = 'second';
    segunda.textContent = secundaria;
    caixa.append(segunda);
  }

  td.append(caixa);
  linha.append(td);
  return td;
}

// ------------------------------------------------------- recursos e ambiente

function renderRecursos(system) {
  const memoriaUsada = system.memory.hostTotalBytes - system.memory.hostFreeBytes;
  const disco = system.disk;

  // Processo e máquina lado a lado de propósito: é o que separa "a aplicação
  // está pesada" de "tem outra coisa comendo esta máquina".
  text('cpuProcess', formatPercent(system.cpu.processPercent));
  text('cpuHost', formatPercent(system.cpu.hostPercent));
  text('memProcess', formatBytes(system.memory.process.rss));
  text('memHost', `${formatBytes(memoriaUsada)} / ${formatBytes(system.memory.hostTotalBytes)}`);
  text('disk', disco ? `${formatBytes(disco.usedBytes)} / ${formatBytes(disco.totalBytes)}` : '—');
  text('uptime', formatDuration(system.processUptimeSeconds));
}

function renderAmbiente(data) {
  const { configuration: config, system } = data;
  const container = system.container;

  const linhas = [
    ['Ambiente', config.environment],
    ['Origem pública', config.publicOrigin],
    ['Porta', String(config.port)],
    ['Client ID', config.clientId ?? 'não configurado'],
    ['Bot do Discord', config.botConfigured ? 'configurado' : 'não configurado'],
    ['Sistema', `${system.platform} ${system.release}`],
    ['Node', system.nodeVersion],
    ['Máquina', system.hostname],
    ['Núcleos', `${system.cpu.logicalCores} · ${system.cpu.model}`],
    ['Carga média', system.cpu.loadAverage.map((v) => v.toFixed(2)).join(' · ')],
  ];

  // Limites de container só aparecem quando existem: numa máquina comum eles
  // seriam duas linhas dizendo "sem limite", que não é informação.
  if (Number.isFinite(container?.cpuLimitCores)) {
    linhas.push(['Limite de CPU', `${container.cpuLimitCores} núcleos`]);
  }
  if (Number.isFinite(container?.memoryMax)) {
    linhas.push(['Limite de memória', formatBytes(container.memoryMax)]);
  }

  $('envList').replaceChildren(
    ...linhas.map(([rotulo, valor]) => {
      const par = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = rotulo;
      // textContent: origem pública e nome da máquina são texto de fora.
      dd.textContent = valor;
      dd.title = valor;
      par.append(dt, dd);
      return par;
    }),
  );
}

// ------------------------------------------------------------------ gráfico

function drawChart() {
  const canvas = $('chart');
  const box = canvas.getBoundingClientRect();
  if (!box.width) return;

  // Redimensionar o canvas zera a transformação, então a escala vem depois.
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * ratio);
  canvas.height = Math.round(box.height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);

  const style = getComputedStyle(document.documentElement);
  const cor = (nome) => style.getPropertyValue(nome).trim();

  const pad = { left: 52, right: 4, top: 8, bottom: 18 };
  const larguraPlot = box.width - pad.left - pad.right;
  const alturaPlot = box.height - pad.top - pad.bottom;

  // Piso de 128 KB/s para o gráfico não virar ruído amplificado quando não há
  // ninguém transmitindo.
  const teto = Math.max(128 * 1024, ...historico.flatMap((p) => [p.inbound, p.outbound])) * 1.15;

  ctx.clearRect(0, 0, box.width, box.height);
  ctx.strokeStyle = cor('--border');
  ctx.fillStyle = cor('--dim');
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';

  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (alturaPlot * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(box.width - pad.right, y);
    ctx.stroke();
    ctx.fillText(formatRate(teto * (1 - i / 4)), pad.left - 8, y + 3);
  }

  for (const [chave, nome] of [
    ['inbound', '--brand'],
    ['outbound', '--ok'],
  ]) {
    ctx.beginPath();
    ctx.strokeStyle = cor(nome);
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';

    historico.forEach((ponto, index) => {
      const valor = ponto[chave];
      if (!Number.isFinite(valor)) return;
      const x = pad.left + (index / Math.max(1, HISTORICO_MAX - 1)) * larguraPlot;
      const y = pad.top + alturaPlot - (valor / teto) * alturaPlot;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();
  }

  ctx.textAlign = 'left';
  ctx.fillText('−2 min', pad.left, box.height - 4);
  ctx.textAlign = 'right';
  ctx.fillText('agora', box.width - pad.right, box.height - 4);
}

// --------------------------------------------------------------------- boot

async function boot() {
  try {
    const response = await fetch('/api/admin/me', { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      $('loading').hidden = true;
      $('login').hidden = false;
      if (body.configured === false) {
        text(
          'loginMessage',
          'O painel está desligado. Defina DISCORD_ADMIN_ID no arquivo .env e reinicie.',
        );
        $('loginButton').hidden = true;
      }
      return;
    }

    text('adminName', body.user.name);
    if (body.user.avatar) {
      const img = $('adminAvatar');
      img.src = `/api/avatar/${body.user.id}/${body.user.avatar}`;
      img.hidden = false;
    }

    $('loading').hidden = true;
    $('dashboard').hidden = false;
    await loadMetrics();
    startPolling();
  } catch {
    $('loading').hidden = true;
    $('login').hidden = false;
    text('loginMessage', 'O servidor não respondeu. Tente de novo em alguns segundos.');
  }
}

$('refresh').addEventListener('click', loadMetrics);

$('logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' }).catch(() => null);
  location.reload();
});

window.addEventListener('resize', () => ultimo && drawChart());

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return stopPolling();
  loadMetrics();
  startPolling();
});

boot();
