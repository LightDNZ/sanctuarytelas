/**
 * Página de captura externa.
 *
 * Só existe como alternativa: quando o Discord não concede `display-capture` ao
 * iframe da Activity, a transmissão precisa nascer numa página top-level, onde
 * getDisplayMedia funciona sem restrição.
 *
 * Toda a lógica de captura e codificação vive em /shared/broadcaster.js, a mesma
 * usada dentro da Activity — aqui é só a interface.
 */
import { createBroadcaster, supportError } from '/shared/broadcaster.js?v=4';

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const token = query.get('t');

let broadcaster = null;

// Quantas leituras seguidas ficaram bem abaixo do alvo. Uma sozinha não diz
// nada: o primeiro segundo sempre sai curto, e uma engasgada pontual também.
let curtas = 0;
let ritmoAvisado = false;

/**
 * Avisa quando o computador não está entregando os quadros pedidos.
 *
 * O encoder por software (vp8, quando não há H264 por hardware) não acompanha
 * 60 fps em tela grande. O backpressure então descarta quadros — o que é a
 * decisão certa, porque fila no encoder vira atraso que nunca mais sai — mas
 * sem este aviso a pessoa escolhe 60, recebe 35 e não fica sabendo.
 */
function conferirRitmo({ fps, seconds }) {
  const alvo = Number($('fps').value);
  if (ritmoAvisado || seconds < 4) return;

  curtas = fps < alvo * 0.7 ? curtas + 1 : 0;
  if (curtas < 4) return;

  ritmoAvisado = true;
  setStatus(
    `Seu computador está entregando ~${fps} dos ${alvo} quadros pedidos. ` +
      'Para uma imagem mais estável, pare e escolha uma taxa menor.',
    'aviso'
  );
}

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

function fail(title, msg) {
  $('roomLine').textContent = title;
  $('setup').hidden = true;
  setStatus(msg, 'error');
}

function readTokenPayload() {
  try {
    return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ arranque

const payload = token && readTokenPayload();
// requireChromium: nos demais navegadores a captura sai visivelmente pior.
const missing = supportError({ requireChromium: true });

if (!payload) {
  fail('Link inválido.', 'Volte à atividade no Discord e clique em compartilhar novamente.');
  // `exp` é opcional: tokens de sala não expiram, a sala é que fecha.
} else if (payload.exp && payload.exp * 1000 < Date.now()) {
  fail('Link expirado.', 'Gere um novo pela atividade.');
} else if (missing) {
  fail('Navegador sem suporte.', missing);
} else {
  $('roomLine').textContent = `Transmitindo como ${payload.name}`;
  applyPresets();
  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', () => broadcaster?.stop('Transmissão encerrada.'));
}

/**
 * Aplica as opções escolhidas no modal da Activity, que chegam pela URL.
 *
 * Com elas definidas, os seletores saem de cena: repetir a mesma escolha aqui
 * só confundiria. Sem elas, a página segue mostrando os controles.
 */
function applyPresets() {
  const q = query.get('q');
  const fps = query.get('fps');
  const som = query.get('som');

  // A opção de som veio decidida da atividade, então a caixa some junto com os
  // seletores — repetir a mesma escolha aqui só confundiria.
  if (som !== null) {
    $('withAudio').checked = som === '1';
    document.querySelector('.check').hidden = true;
  }

  if (!q && !fps) return;

  if (q) $('quality').value = q;
  if (fps) $('fps').value = fps;

  for (const row of document.querySelectorAll('#setup .row')) row.hidden = true;

  const mbps = (Number($('quality').value) / 1e6).toFixed(1).replace('.', ',');
  const comSom = $('withAudio').checked ? ' · com som' : '';
  $('presetLine').textContent = `${mbps} Mb/s · ${$('fps').value} fps${comSom}`;
  $('presetLine').hidden = false;
}

// -------------------------------------------------------------------- ações

async function start() {
  curtas = 0;
  ritmoAvisado = false;
  $('start').disabled = true;
  setStatus('Aguardando você escolher a tela…');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';

  broadcaster = createBroadcaster({
    wsUrl: `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}`,
    bitrate: Number($('quality').value),
    fps: Number($('fps').value),
    audio: $('withAudio').checked,
    onStatus: (s) =>
      setStatus(
        `Codec: ${s.codec} · ${s.width}×${s.height} · captura ${s.direct ? 'direta' : 'via <video>'}`
      ),
    onStats: (s) => {
      $('viewers').textContent = s.viewers;
      $('fpsOut').textContent = `${s.fps} fps`;
      $('bitrate').textContent = `${s.mbps.toFixed(1)} Mb/s`;
      $('elapsed').textContent =
        `${String(Math.floor(s.seconds / 60)).padStart(2, '0')}:${String(s.seconds % 60).padStart(2, '0')}`;
      conferirRitmo(s);
    },
    onAviso: (msg) => {
      setStatus(msg, 'aviso');
      // O aviso sozinho é um beco: o botão é a saída dele.
      $('somAba').hidden = false;
    },
    onEnd: (reason) => {
      broadcaster = null;
      $('preview').srcObject = null;
      $('live').hidden = true;
      $('setup').hidden = false;
      $('start').disabled = false;
      setStatus(reason);
    },
  });

  try {
    const stream = await broadcaster.start();
    $('preview').srcObject = stream;
    $('preview').play().catch(() => {});
    $('setup').hidden = true;
    $('live').hidden = false;
  } catch (err) {
    broadcaster = null;
    $('start').disabled = false;
    setStatus(
      err.name === 'NotAllowedError' ? 'Você cancelou a seleção de tela.' : err.message,
      'error'
    );
  }
}

// Mantém o vídeo como está e troca só de onde vem o som — a única fonte que
// não carrega o Discord junto é uma aba.
$('somAba').addEventListener('click', async () => {
  if (!broadcaster) return;
  try {
    await broadcaster.trocarSom();
    setStatus('Som ligado, vindo da aba escolhida.', 'ok');
    $('somAba').textContent = 'Trocar a aba do som';
  } catch (err) {
    if (err.name !== 'NotAllowedError') setStatus(err.message, 'error');
  }
});

window.addEventListener('beforeunload', () => broadcaster?.stop());
