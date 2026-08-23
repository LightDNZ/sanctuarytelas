/**
 * Camada WebRTC: o vídeo sai do transmissor direto para quem assiste.
 *
 * O relay por WebSocket continua existindo e continua sendo o caminho padrão —
 * este módulo é o atalho. A diferença que importa não é "P2P é mais curto": é
 * que o WebSocket anda sobre TCP, e TCP não tem como descartar um quadro
 * atrasado. Quando a rede aperta, o socket enfileira; a imagem não fica pior,
 * ela fica no passado, e o que se vê é a transmissão andando aos saltos. O
 * WebRTC roda sobre SRTP/UDP, abaixa o bitrate sozinho quando detecta perda e
 * repõe pacote perdido com NACK — degrada a qualidade em vez do tempo.
 *
 * Nada aqui é obrigatório. Se a negociação não fechar (NAT simétrico sem TURN,
 * sandbox que bloqueia, rede corporativa), quem assiste simplesmente continua
 * no relay. É por isso que o WebCodecs não foi removido: ele é o piso.
 */

// STUN público do Google como piso: descobre o endereço externo e resolve a
// maioria dos NATs domésticos. Não cobre NAT simétrico — para esses só TURN
// resolve, e é o servidor quem diz se existe um (veja `/api/ice`).
const ICE_PADRAO = [{ urls: 'stun:stun.l.google.com:19302' }];

let icePromise = null;

/**
 * Servidores ICE, buscados uma vez e reaproveitados.
 *
 * Vem do servidor porque credencial de TURN é temporária e não pode ser
 * embutida no bundle. Falha de rede aqui não é motivo para desistir do WebRTC:
 * cai no STUN público, que já atende quem está atrás de NAT comum.
 */
export function iceServers(base = '') {
  icePromise ??= fetch(`${base}/api/ice`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (Array.isArray(j?.iceServers) && j.iceServers.length ? j.iceServers : ICE_PADRAO))
    .catch(() => ICE_PADRAO);
  return icePromise;
}

/**
 * Tempo máximo esperando a conexão fechar antes de desistir e ficar no relay.
 *
 * Oito segundos é folgado de propósito: em rede boa fecha em menos de um, e o
 * custo de esperar é zero — quem assiste já está vendo pelo relay o tempo
 * todo. Curto demais desistiria de conexões que só estavam lentas.
 */
export const PRAZO_CONEXAO_MS = 8000;

/** Estados dos quais não se volta: aqui a tentativa acabou. */
export const MORTO = new Set(['failed', 'closed', 'disconnected']);

export function suportaWebRTC() {
  return typeof RTCPeerConnection === 'function';
}

/**
 * Cria a conexão e liga os avisos. Quem chama decide o que fazer com eles —
 * este módulo não conhece nem sala, nem slot, nem sinalização.
 */
export function criarPeer({ ice, onIce, onEstado, onTrack }) {
  const pc = new RTCPeerConnection({
    iceServers: ice ?? ICE_PADRAO,
    // Junta áudio e vídeo num transporte só. Sem isso são duas negociações de
    // ICE para a mesma conexão, e o dobro de tempo até o primeiro quadro.
    bundlePolicy: 'max-bundle',
  });

  pc.addEventListener('icecandidate', (e) => {
    // O candidato nulo é o fim da lista, não um candidato — repassá-lo faria o
    // outro lado tentar addIceCandidate(null) e lançar.
    if (e.candidate) onIce?.(e.candidate.toJSON());
  });

  const estado = () => onEstado?.(pc.connectionState);
  pc.addEventListener('connectionstatechange', estado);
  // Nem todo navegador emite connectionstatechange em falha de ICE; o estado do
  // ICE chega antes e é o que denuncia a negociação que não vai fechar.
  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'failed') onEstado?.('failed');
  });

  if (onTrack) pc.addEventListener('track', (e) => onTrack(e));

  return pc;
}

/**
 * Ajusta como o encoder do WebRTC deve ceder quando a banda não dá.
 *
 * `maintain-resolution` para tela porque texto ilegível é pior que texto que
 * anda a 10 quadros — reduzir a resolução de um terminal apaga a informação.
 * Câmera é o oposto: ninguém lê um rosto, e movimento picado incomoda mais que
 * a imagem mais macia, então lá vale manter o framerate.
 *
 * O teto de bitrate é o mesmo que a pessoa escolheu para o relay: sem ele o
 * WebRTC parte de um chute conservador e leva dezenas de segundos subindo.
 */
export async function ajustarEnvio(pc, { bitrate, fonte = 'tela', fps } = {}) {
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const params = sender.getParameters();
    params.encodings ??= [{}];
    if (!params.encodings.length) params.encodings.push({});

    if (sender.track.kind === 'video') {
      params.degradationPreference =
        fonte === 'camera' ? 'maintain-framerate' : 'maintain-resolution';
      for (const enc of params.encodings) {
        if (bitrate) enc.maxBitrate = bitrate;
        if (fps) enc.maxFramerate = fps;
      }
    }

    try {
      await sender.setParameters(params);
    } catch {
      // Navegador que não aceita o ajuste transmite com o padrão dele. É pior,
      // não é quebrado — e não há nada a fazer além de seguir.
    }
  }
}

/**
 * Descrição curta do que está acontecendo com a conexão, para o diagnóstico.
 *
 * Só o que dá para agir: o ida-e-volta, e se o caminho passa por TURN — que
 * funciona, mas gasta banda do servidor. O resto do `getStats` é ruído.
 */
export async function resumoPeer(pc) {
  let rtt = null;
  let relay = false;

  try {
    const stats = await pc.getStats();
    const porId = new Map();
    for (const s of stats.values()) porId.set(s.id, s);

    for (const s of stats.values()) {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated !== false) {
        if (typeof s.currentRoundTripTime === 'number')
          rtt = Math.round(s.currentRoundTripTime * 1000);
        const local = porId.get(s.localCandidateId);
        if (local?.candidateType === 'relay') relay = true;
      }
    }
  } catch {
    // getStats falha em navegador antigo; o diagnóstico some, a conexão não.
  }

  return { rtt, relay };
}
