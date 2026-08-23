/**
 * A conexão de controle sobrevive à sala?
 *
 * Era o bug: a aba de captura não conta para a sala estar viva — certo, senão
 * uma aba esquecida a manteria de pé para sempre — mas também não era fechada
 * quando a sala morria. Ficava aberta contra um objeto que ninguém alcança,
 * sem receber nada e sem `close` para disparar a reconexão.
 */
import WebSocket from 'ws';

const BASE = 'http://localhost:3001';
const WSB = 'ws://localhost:3001';
const api = async (p, b) =>
  (
    await fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    })
  ).json();

let falhas = 0;
const check = (nome, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FALHOU'}  ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

const inst = `ctrl-${Date.now().toString(36)}`;
const me = await api('/api/session-dev', { instance_id: inst, name: 'Ctrl' });
const t = await api('/api/rooms/create', { identity: me.identity, name: 'Sala Ctrl' });
const shareToken = new URL(t.shareUrl).searchParams.get('t');

const ctrl = new WebSocket(`${WSB}/ws?t=${encodeURIComponent(shareToken)}&modo=controle`);
const recebidos = [];
let fechou = false;
ctrl.on('message', (d) => recebidos.push(JSON.parse(d.toString())));
ctrl.on('close', () => {
  fechou = true;
});
await new Promise((r) => ctrl.on('open', r));

check('a aba de controle conecta', ctrl.readyState === WebSocket.OPEN);

// Ninguém assiste e ninguém transmite: a sala está vazia desde que nasceu.
// A carência é de 12s e a varredura roda a cada 4s, então 20s cobre com folga.
console.log('esperando a varredura fechar a sala vazia (20s)…');
await new Promise((r) => setTimeout(r, 20_000));

check(
  'a aba foi avisada de que a sala fechou',
  recebidos.some((m) => m.type === 'room-gone'),
  `recebeu: ${JSON.stringify(recebidos.map((m) => m.type))}`,
);
check(
  'o socket da aba foi fechado',
  fechou,
  fechou ? '' : `readyState=${ctrl.readyState} — ficaria surdo para sempre`,
);

// Uma conexão nova bate numa sala que não existe mais.
const zumbi = new WebSocket(`${WSB}/ws?t=${encodeURIComponent(shareToken)}&modo=controle`);
const doZumbi = [];
zumbi.on('message', (d) => doZumbi.push(JSON.parse(d.toString())));
await new Promise((r) => {
  zumbi.on('close', r);
  zumbi.on('error', r);
  setTimeout(r, 2000);
});
check(
  'reconectar na sala morta responde room-gone',
  doZumbi.some((m) => m.type === 'room-gone'),
  `recebeu: ${JSON.stringify(doZumbi.map((m) => m.type))}`,
);

// ---------------------------------------------------------------------------

/**
 * A transmissao de quem saiu da sala para sozinha?
 *
 * A aba de captura tem conexao propria: fechar a atividade nao a alcanca, e sem
 * isto a tela continuava indo para quem ficou, sem a pessoa saber.
 */
{
  const eu = await api('/api/session-dev', { instance_id: inst, name: 'Sai' });
  const sala = await api('/api/rooms/create', { identity: eu.identity, name: 'Sala Sai' });
  const share = new URL(sala.shareUrl).searchParams.get('t');

  /**
   * A escuta nasce junto com o socket, e nao depois do `open`.
   *
   * Entre um evento e o outro cabe uma mensagem, e a primeira coisa que o
   * servidor manda ao transmissor e justamente o `slot`. Assinando depois, ela
   * as vezes chegava antes de existir quem ouvisse — e nao volta. O teste
   * entao acusava a falta de uma mensagem que tinha sido enviada, o que so
   * acontecia na maquina do CI, que e onde o intervalo entre os dois eventos
   * abre o suficiente.
   */
  const abrir = (tok, sufixo = '') =>
    new Promise((ok, no) => {
      const w = new WebSocket(WSB + '/ws?t=' + encodeURIComponent(tok) + sufixo);
      w.recebidas = [];
      w.fechou = false;
      w.on('message', (d) => {
        try {
          w.recebidas.push(JSON.parse(d.toString()));
        } catch {
          /* quadro binario */
        }
      });
      w.on('close', () => {
        w.fechou = true;
      });
      w.on('open', () => ok(w));
      w.on('error', no);
    });

  const viewer = await abrir(sala.viewerToken);
  const tx = await abrir(share, '&fonte=tela');
  const doTx = tx.recebidas;
  tx.send(JSON.stringify({ type: 'start' }));
  await new Promise((r) => setTimeout(r, 600));

  check(
    'transmissor recebeu slot',
    doTx.some((m) => m.type === 'slot'),
  );

  // Com a pessoa na sala, nada pode cair.
  await new Promise((r) => setTimeout(r, 8000));
  check(
    'com a pessoa na sala, a transmissao continua',
    !tx.fechou && !doTx.some((m) => m.type === 'stop-request'),
  );

  // Sai da atividade. So a aba de captura fica de pe.
  viewer.close();
  console.log('esperando a carencia de presenca (22s)...');
  await new Promise((r) => setTimeout(r, 22000));

  const pedido = doTx.find((m) => m.type === 'stop-request');
  check(
    'quem saiu da sala tem a transmissao encerrada',
    Boolean(pedido),
    'recebeu: ' + JSON.stringify(doTx.map((m) => m.type)),
  );
  check(
    'o pedido explica o motivo',
    Boolean(pedido && pedido.motivo),
    (pedido && pedido.motivo) || '',
  );

  tx.close();
}

console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo passou');
process.exit(falhas ? 1 : 0);
