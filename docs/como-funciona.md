# Como funciona (para quem mexe no código)

Este arquivo existe só para explicar as decisões que não se adivinham lendo o
código. Para instalar e usar, veja o [README](../README.md).

## Por que a tela é capturada numa aba separada

Duas restrições do Discord definiram o desenho inteiro:

1. **A atividade roda num iframe de outro domínio.** Nesse contexto o navegador
   nega `getDisplayMedia()` — a função que pede a tela — a menos que o Discord
   marque o iframe com `allow="display-capture"`, o que ele não faz.
2. **WebRTC não existe em atividades.** A documentação do Discord diz que só
   WebSocket é suportado. Sem P2P, sem SFU.

Então a captura acontece **fora** do sandbox, numa aba normal do navegador, e os
quadros vão por WebSocket para o servidor, que os repassa para quem assiste:

```
QUEM MOSTRA                        SERVIDOR              QUEM ASSISTE
aba normal do navegador                                  atividade (iframe)
  getDisplayMedia  ✅                                          │
  VideoEncoder                                                 │
  └──── WebSocket binário ────►  repassa sem                   │
                                  abrir o quadro ───────────────►
                                                          VideoDecoder → canvas
```

Quem assiste nunca sai do Discord. Só quem mostra passa por uma aba.

Se um dia o Discord conceder `display-capture`, o botão **"Testar captura no
iframe"** (no painel de detalhes) passa a funcionar — e aí a aba externa pode
sumir. A atividade já tenta capturar internamente antes de cair para a aba.

### O ciclo completo da captura

1. Usuário clica **"Compartilhar tela"** → abre `share.html?t=<token>` em nova aba
2. Aba pede `getDisplayMedia({ video: true, audio: { systemAudio: 'include' } })`
3. Stream chega em `broadcaster.js` → `VideoEncoder` (WebCodecs) + `AudioEncoder` (Opus)
3. Quadros via WebSocket binário → servidor (`server/rooms.js`) → repasse para espectadores
4. Espectadores recebem via WebSocket → `VideoDecoder` + `AudioDecoder` → canvas + audio

Se um dia o Discord conceder `display-capture`, o botão **"Testar captura no
iframe"** (no painel de detalhes) passa a funcionar — e aí a aba externa pode
sumir. A atividade já tenta capturar internamente antes de cair para a aba.

## Por que WebCodecs e não MediaRecorder

A primeira versão usava `MediaRecorder` + Media Source Extensions e ficava em
~3 segundos de atraso. O formato de container impõe um piso: o pedaço só sai
depois de fechado, e o player precisa acumular buffer para não engasgar.

WebCodecs elimina os dois. Cada quadro é codificado, enviado e desenhado
individualmente, sem container. E, ao contrário de `display-capture`, WebCodecs
não é bloqueado dentro do iframe.

## Keyframe sob demanda

Quem chega no meio de uma transmissão não consegue decodificar nada até receber
um quadro completo. Em vez de guardar um antigo, o servidor **pede um novo** ao
transmissor quando alguém começa a assistir — a tela aparece em ~1 quadro.

O servidor também barra quadros incompletos para quem ainda não recebeu um
completo: alimentar um decodificador frio com eles só produz erro.

## Assistir é opt-in

O servidor não manda os quadros de uma tela para ninguém que não tenha pedido
explicitamente. É o que segura a banda: filtrar só na exibição gastaria a mesma
saída de rede. Por isso cada tela aparece primeiro como um convite
("Assistir tela") em vez de já começar a tocar.

## Salas

- **No Discord:** não há lista. A atividade entra direto na sala daquela call.
  Com `DISCORD_BOT_TOKEN` configurado, o servidor confirma com o Discord quem
  está no canal de voz; sem ele, o escopo é a instância da atividade.
- **No site:** não existe call para herdar, então a lista de salas é a única
  forma de as pessoas se encontrarem. Salas podem ter senha.

Salas vivem em memória e fecham sozinhas 12 segundos depois de esvaziar — a
carência existe porque recarregar a página desconecta e reconecta.

## Som

O áudio vai pelo mesmo socket e pelo mesmo cabeçalho do vídeo, distinguido só
pelo byte de tipo. Opus a 96 kbps, capturado junto com a tela por
`getDisplayMedia({ audio: { systemAudio: 'include' } })`.

**O som só sai de aba.** Compartilhar a tela inteira entrega a mistura do
sistema, com a saída do Discord dentro — e a call inteira passa a se ouvir de
volta. Não existe API para tirar um processo dessa mistura: o áudio é capturado
por processo e a relação com uma janela não é um-para-um. O que dá para saber é
o `displaySurface` escolhido, e isso basta — `browser` significa som daquela
aba só. Nos outros casos a faixa é parada antes de sair da máquina.

Junto vai `restrictOwnAudio` quando o navegador suporta: ele tira da captura o
que a própria página está tocando, senão quem transmite enquanto assiste devolve
o som da outra tela para a sala, em laço.

Três coisas que o desenho assume:

- **Áudio não tem keyframe.** Cada pacote Opus se decodifica sozinho, então ele
  não passa pelo bloqueio que barra vídeo sem ponto de partida. Se passasse,
  quem entra no meio ficaria mudo até o próximo keyframe.
- **Buraco em áudio é audível.** Um quadro de vídeo perdido não se nota; um
  intervalo sem amostra é um estalo. Por isso a reprodução mantém um colchão de
  80 ms — o som toca um pouco atrás do vivo, e essa folga absorve o solavanco
  da rede. Passando de 320 ms acumulados, corta e volta ao vivo: atraso somado
  não se recupera sozinho.
- **Sincronia é aceitável, não exata.** O vídeo é desenhado assim que chega; o
  som carrega o colchão. A diferença fica em algumas dezenas de milissegundos,
  abaixo do que se percebe em tela de computador. Casar os dois exigiria
  atrasar o vídeo até o áudio — mais latência para resolver um problema que não
  aparece fora de rosto falando.

A reprodução agenda cada pedaço num `AudioBufferSourceNode`, sem AudioWorklet.
O worklet daria precisão por amostra, mas exige um arquivo carregado por URL, e
dentro da atividade toda URL passa pelo proxy do Discord — um caminho a mais
para dar errado, em troca de precisão que pacotes de 20 ms não pedem.

## Protocolo

Cada pacote trafega como binário puro:

```
[1B slot][1B tipo: 1=vídeo completo 2=vídeo parcial 3=som][8B tempo][8B relógio][payload]
```

O `slot` é o número do transmissor, carimbado na origem: o servidor repassa o
buffer sem tocar nele, e quem assiste sabe para qual decodificador mandar. Até
4 transmissores por sala.

O relógio de envio serve só para medir atraso. É exato na mesma máquina; entre
máquinas diferentes, aproximado.

Controle vai em JSON: `start`, `config`, `audio-config`, `stop`, `rtc`
(transmissor → servidor); `state`, `stream-start`, `config`, `audio-config`,
`stream-stop`, `need-keyframe`, `rtc-want`, `rtc`, `rtc-bye`, `chunks`,
`error` (servidor → clientes); `watch`, `unwatch`, `rtc`, `rtc-ativo`
(espectador → servidor).

## WebRTC por cima do relay

O relay acima é o piso, e continua sendo o caminho de todo mundo no primeiro
segundo. Por cima dele, cada espectador ganha uma tentativa de conexão direta
com quem transmite.

A diferença que importa não é o número de saltos — é o transporte. O WebSocket
anda sobre TCP, e TCP não sabe descartar um quadro atrasado: quando a rede
aperta, ele entrega tudo, em ordem, mais tarde. A imagem não fica pior, ela
fica no passado, e o que se vê é a transmissão andando aos saltos. O WebRTC
anda sobre SRTP/UDP: abaixa o bitrate sozinho quando detecta perda, repõe
pacote perdido com NACK e, no limite, deixa o quadro velho para trás. Ele
degrada a qualidade em vez de degradar o tempo.

Como funciona a troca:

1. Alguém pede `watch`. O relay começa a entregar na hora, como sempre fez, e
   o servidor manda um `rtc-want` ao transmissor com o nome daquele espectador.
2. O transmissor abre um `RTCPeerConnection`, pendura as faixas do stream que
   já está capturando e manda a oferta. Quem tem a mídia é quem oferece.
3. Offer, answer e candidatos ICE viajam como envelopes opacos pelo mesmo
   socket do relay — ele já existe e já está autenticado.
4. Quando o primeiro quadro **aparece de fato** no `<video>` do espectador — e
   não quando a conexão diz "connected" —, ele avisa `rtc-ativo`. Só então o
   servidor para de mandar os bytes daquela tela para ele.
5. Se todo mundo que assiste chegou nesse ponto, o servidor manda `chunks:
false` e o transmissor para de codificar para o relay: aqueles quadros não
   teriam para onde ir, e a subida dele agora é disputada pelas conexões
   diretas.

E quando não fecha — NAT simétrico sem TURN, sandbox que bloqueia, rede
corporativa — nada acontece. Passados 8 segundos sem quadro, ou na primeira
falha de ICE, o espectador desiste em silêncio e segue no relay, que nunca foi
desligado para ele. É por isso que o WebCodecs não saiu do código: ele é o que
garante que ninguém fica sem imagem por causa de um roteador.

`TURN_URL`, `TURN_USER` e `TURN_PASS` no `.env` (opcionais) alimentam o
`/api/ice`. Sem eles fica só o STUN público, que resolve a maioria das casas
mas não quem está atrás de CGNAT. Um TURN encaminha o vídeo de verdade — custa
banda, e por isso é escolha de quem hospeda, não padrão.

## Detalhes que não são acidentais

- **`latencyMode: 'realtime'`** no codificador e **`optimizeForLatency: true`**
  no decodificador. Sem eles, ambos acumulam quadros antes de emitir — comprime
  melhor, mas é atraso que nunca mais sai.
- **`frame.close()`** depois de desenhar. `VideoFrame` segura memória de GPU;
  sem isso a aba trava em segundos.
- **Descartar quadro quando a fila do codificador passa de 2.** Fila vira
  atraso permanente. Melhor perder um quadro do que carregar o atraso.
- **`track.contentHint = 'text'`.** Avisa que é tela, não vídeo — mantém texto
  nítido em vez de suavizar bordas.
- **Backpressure no relay.** Se o socket de alguém acumula mais de 2 MB, o
  servidor descarta quadros para essa pessoa em vez de enfileirar. Sem isso, um
  espectador com internet ruim derruba o processo por consumo de memória.
- **A troca de transporte é decidida pelo primeiro quadro, não pelo
  `connectionState`.** Um peer "connected" que não entrega nada é
  indistinguível de um travamento — e desligar o relay confiando nele deixaria
  a tela preta com a conexão reportando sucesso.
- **`degradationPreference`.** Tela usa `maintain-resolution`: texto ilegível é
  pior que texto a 10 quadros. Câmera usa `maintain-framerate`, porque ninguém
  lê um rosto e movimento picado incomoda mais que imagem macia.
- **`/.proxy/`** em todo fetch e WebSocket feito de dentro da atividade — é
  assim que o Discord roteia para o seu servidor.
- **Client ID vem do servidor, não do build.** Embutir no bundle obrigava a
  rebuildar a cada troca de credencial, e esquecer disso não dava erro: a
  atividade abria e só quebrava no login.

## Estrutura

```
server/
  index.js        HTTP + WebSocket, login do Discord, emissão de tokens
  rooms.js        salas e repasse dos quadros
  tokens.js       tokens assinados (sem biblioteca externa)
  public/share.*  a aba de captura, que roda FORA do Discord
client/
  src/main.js     interface da sala e conexão
  src/player.js   decodifica os quadros e desenha no canvas
  src/audio.js    decodifica o som e agenda a reprodução
shared/
  broadcaster.js  captura + codificação, usada pela aba e pela atividade
  rtc.js          conexão direta por WebRTC, por cima do relay
scripts/
  configurar.mjs  assistente de configuração
  tunel.mjs       sobe o túnel e grava o endereço no .env
  smoke.mjs       teste do servidor ponta a ponta, sem navegador
```

## Autenticação e tokens

### Fluxo Discord (Activity)

```
USUÁRIO                    SERVIDOR                    DISCORD
   │                          │                          │
   ├─ Abre Activity ────────► │                          │
   │                          ├─ /api/token (code) ─────► │
   │                          │        access_token ◄─────│
   │                          │                          │
   ├─ /api/session (access_token, instance_id, guild_id, channel_id)
   │                          ├─ /users/@me (access_token) ◄──┤
   │                          │         user info ◄──────────┤
   │                          ├─ /guilds/{id}/voice-states/{uid} (Bot) ◄──┤ (se BOT)
   │                          │                    │           │
   │                          │         em call?    │           │
   │                          │◄───────────────────┘           │
   │                          │                                 │
   ├─ identity { token, user, instance, call? } ◄────────────┤
   │                          │                                 │
```

### Tokens

| Token | Expiração | Uso |
|-------|-----------|-----|
| `identity` | 8h | JWT assinado (scope=identity). Prova quem é a pessoa sem bater no Discord. |
| `viewerToken` | sem expiração | scope=viewer. Permite `watch`/`unwatch` numa sala. |
| `broadcasterToken` | sem expiração | scope=broadcaster. Permite `start`/`stop`/`config` na sala. |
| `shareUrl` | mesma sala | URL com `broadcasterToken` embutido → abre aba de captura. |
| `admin` (cookie) | 8h | Painel `/admin`, scope=admin, HttpOnly. |

### Geração de tokens

```js
// server/tokens.js
signToken(payload, ttl) // HMAC-SHA256 com SESSION_SECRET
verifyToken(token)      // retorna payload ou null
```

- `SESSION_SECRET` é obrigatório em produção (64 chars hex). Gerado pelo `npm run configurar`.
- Sem secret, tokens seriam forjáveis → servidor recusa subir em produção.

### Fluxo web (fora do Discord)

1. `/auth/login` → redirect Discord OAuth (`scope=identify`)
2. `/auth/callback` → troca `code` por `access_token` → busca perfil
3. Emite `identity` com `instance='web'` (mesmo formato, scope=identity)
4. Redireciona para `/#identity=<token>` (fragmento não vai ao servidor)

### Identidade de convidado

Sem Discord: `POST /api/session-guest { name? }` → `identity` com `uid=guest-...`, `instance='web'`, validade 30 dias. Permite criar/entrar em salas públicas.

---

## Salas

### Tipos

| Tipo | Criação | Acesso | Escopo |
|------|---------|--------|--------|
| Normal | `POST /api/rooms/create` | Link/senha | `instance` (web) ou `guild` (Discord) |
| Call | Automática (`/api/rooms/call`) | Entrada na call | `call-{channelId}` + `guild` (se bot) |

### Ciclo de vida

```
CRIADA → ATIVA (transmissão?) → VAZIA → 12s → DELETADA
                          ↑
                    12s sem ninguém → limpeza
```

- `carência de 12s` existe porque recarregar a página desconecta/reconecta.
- Salas vivem em memória (`Map` em `rooms.js`). Não há banco de dados.
- `carência` evita que recarregar a página apague a sala no meio da transmissão.

### Senhas

- `scrypt` com salt único por sala + `setTimeout` para bloqueio temporário (exponencial).
- Máx 4 transmissores por sala (slots 0-3).

---

## Som (detalhes)

### Captura

```js
getDisplayMedia({
  video: true,
  audio: { systemAudio: 'include' } // ou 'browser' para som de aba
})
```

- `systemAudio: 'include'` → tela inteira + mistura do sistema (inclui Discord)
- `browser` → som da aba escolhida (isolado, não pega Discord)

### Pipeline

```
getDisplayMedia (AudioTrack)
       │
       ▼
AudioEncoder (Opus 96kbps, 48kHz, 20ms frames)
       │
       ▼
WebSocket (tipo=3) ──► Servidor ──► Espectadores
       │
       ▼
AudioDecoder (Opus) ──► AudioBufferSourceNode (agendado)
```

### Buffer de reprodução (colchão 80ms)

```js
// player.js
const MIN_BUFFER_MS = 80;
// Agenda cada chunk em AudioBufferSourceNode
// Se buffer < 80ms → para e espera
// Se buffer > 320ms → corta e resync
```

- Áudio sem keyframe → cada pacote Opus decodifica sozinho
- Buraco em áudio = estalo audível → colchão de 80ms absorve jitter
- Se buffer > 320ms → corta e resync (atraso acumulado não se recupera)

### `restrictOwnAudio`

Quando disponível, remove da captura o que a **própria página** está tocando. Evita laço: quem transmite enquanto assiste devolve o som da outra tela para a sala.

---

## WebRTC por cima do relay (detalhado)

### Por que não só relay?

| Relay (WebSocket/TCP) | WebRTC (SRTP/UDP) |
|----------------------|-------------------|
| TCP não descarta quadro atrasado | UDP descarta o que está velho |
| Entrega tudo, em ordem, mais tarde | Descarte = qualidade cai, tempo mantido |
| Imagem no passado (saltos) | Qualidade degrada, tempo mantido |

### Estado da troca

```
1. WATCH     ──► Relay imediato + RTC_WANT ao transmissor
2. OFFER     ◄── Transmissor cria PC, pendura tracks, envia offer
3. ANSWER    ◄── Servidor via WS para espectador
4. ICE       ◄── Candidatos via WS (mesmo socket)
5. RTC-ATIVO ◄── Primeiro quadro no <video> (não "connected")
6. CHUNKS=F  ◄── Se todos ativos, transmissor para relay
```

### Falhas silenciosas

- NAT simétrico sem TURN → falha ICE → relay (nunca desliga)
- Sandbox bloqueia WebRTC → relay
- 8s sem quadro ou falha ICE → desiste silencioso → relay

---

## Rate limiting

| Rota | Limite | Janela |
|------|--------|--------|
| `/api/token` | 10 req/s | 1s |
| `/api/ice` | 10 req/s | 1s |
| `/api/health` | sem limite | - |

- Por IP (usa `req.ip` ou `x-forwarded-for`)
- Contadores separados por path
- Retorna `429` + `Retry-After`

---

## Métricas (`/metrics`)

Formato Prometheus, admin-only (cookie `discord_screen_admin`).

```
sanctuary_up 1
sanctuary_rooms_total 3
sanctuary_users_total 12
sanctuary_connections_total 18
sanctuary_viewers_total 15
sanctuary_broadcasters_total 3
sanctuary_active_watchers_total 24
sanctuary_streams_total 3
sanctuary_guilds_total 2
sanctuary_ping_avg_ms 42.5
sanctuary_ping_p95_ms 89
sanctuary_traffic_in_bytes_per_sec 2516582
sanctuary_traffic_out_bytes_per_sec 7549746
sanctuary_traffic_dropped_bytes_per_sec 0
sanctuary_cpu_process_percent 12.3
sanctuary_memory_process_rss_bytes 145231872
sanctuary_process_uptime_seconds 3642
```

---

## Rate limiting (interno)

```js
// server/index.js
const RATE_LIMIT = new Map();
function rateLimit(maxReq = 10, windowMs = 1000) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    // ... sliding window log
  };
}
```

- Contadores por `(ip, path)`
- Limpeza periódica (quando mapa > 10k entradas)
- Retorna `429` + `Retry-After` em segundos

---

## Logs estruturados

```bash
LOG_FORMAT=json npm start
```

```json
{"level":"info","msg":"Sanctuary Telas no ar em  http://localhost:3001","ts":"2026-08-24T..."}
{"level":"info","msg":"[room abc123] stream iniciada por usuario","ts":"2026-08-24T..."}
{"level":"warn","msg":"[voz] o bot nao esta neste servidor — escopo cai para a instancia","ts":"2026-08-24T..."}
{"level":"error","msg":"[oauth] erro: {...}","ts":"2026-08-24T..."}
```

---

## Testes

```bash
# Unit + integração
npm test

# Com cobertura
npx vitest run --coverage

# Thresholds (vitest.config.js)
# lines: 86%, statements: 86%, functions: 86%, branches: 84%
```

### Smoke test (integração ponta a ponta)

```bash
npm start        # janela 1
npm run smoke    # janela 2
```

Cobre: auth, senha de sala, keyframe, opt-in, múltiplos transmissores, isolamento entre salas/instâncias.

---

## Estrutura de arquivos (resumo)

```
sanctuarytelas/
├── client/          # Frontend (Vite)
│   ├── src/
│   │   ├── main.js      # Entry point (Activity + standalone)
│   │   ├── style.css    # Grid, dock, fullscreen, sidebar
│   │   ├── player.js    # Decode/render/stats
│   │   └── audio.js     # Audio decode/agenda
│   └── index.html
├── server/          # Backend (Node, Express, WS)
│   ├── index.js         # HTTP + WS, auth, rooms, metrics
│   ├── rooms.js         # Salas, repasse, keyframe, opt-in
│   ├── tokens.js        # JWT sign/verify
│   ├── system.js        # Métricas CPU/mem/disco/rede
│   ├── admin.js         # Painel /api/admin/*
│   └── public/          # HTMLs estáticos
├── shared/
│   ├── rtc.js           # WebRTC helpers (codecs, ICE)
│   └── broadcaster.js   # Captura + encode + WebRTC peers
├── scripts/           # CLI
│   ├── configurar.mjs   # Assistente interativo
│   ├── tunel.mjs        # Túnel descartável
│   ├── tunel-criar.mjs  # Túnel fixo Cloudflare
│   ├── start-fast.mjs   # start:fast (config+build+túnel+server)
│   └── ...
├── infra/             # Infra
│   ├── sanctuarytelas.service
│   └── Caddyfile
└── docs/
    ├── como-funciona.md
    └── vps.md
```

---

## Rodando enquanto mexe no código

```bash
npm run dev          # Vite (5173) + Server (3001) + Túnel, hot reload
npm run dev:rapido   # Mesmo, mas túnel descartável, não mexe no .env
npm start            # Build + server (3001) - reconstrói a cada execução
npm run dev:rapido   # Recomendado para desenvolvimento
```

---

## Referências rápidas

| Onde mexer | Para que |
|------------|----------|
| `server/rooms.js` | Lógica de salas, keyframe, opt-in, repasse |
| `server/index.js` | HTTP, WS, auth, metrics, rate limit, CSP |
| `client/src/player.js` | Decode, render, stats overlay, jitter |
| `client/src/main.js` | UI, sidebar, fullscreen, dock, WebRTC |
| `shared/broadcaster.js` | Captura, encode, WebRTC peers |
| `shared/rtc.js` | Codecs, ICE, bandwidth estimation |
| `scripts/configurar.mjs` | Assistente interativo |
| `scripts/tunel-criar.mjs` | Túnel fixo Cloudflare |
| `infra/sanctuarytelas.service` | systemd unit |
| `infra/Caddyfile` | Reverse proxy + HTTPS |

```
npm start        # numa janela
npm run smoke    # noutra
```

Cobre autenticação, senha de sala e bloqueio por tentativas, a máquina de
estados do keyframe, "assistir é opt-in", vários transmissores sem misturar os
streams, e isolamento entre salas e instâncias.

## Rodando enquanto mexe no código

`npm start` reconstrói o site a cada execução. Para recarregar sozinho a cada
salvamento, use `npm run dev` — ele sobe o servidor na 3001 e o site na 5173,
e é a 5173 que você abre.
