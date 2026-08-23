# Sanctuary Telas

Compartilhamento de tela com áudio para o Discord — roda como Activity dentro de canais de voz ou como site standalone.

## Visão geral

- **Activity do Discord**: abre direto no canal de voz (ícone 🚀), sem lista de salas — quem entra cai na sala daquela call.
- **Site standalone**: `https://seu-dominio.com` — lobby com lista de salas, criação de salas públicas/privadas, convite por link.
- **Relay WebSocket**: vídeo/audio passam pelo servidor (não é P2P puro), o que permite fallback via TURN e controle de banda.
- **Sem banco de dados**: tudo em memória (salas, usuários, tokens). Quando a sala esvazia, some em ~12s.
- **Privacidade**: nada é gravado. Vídeo/áudio passam pelo servidor apenas em trânsito.

## Requisitos

- **Node.js 22+** (usa `fetch` nativo, `--watch`, ES modules)
- **Navegador compatível** para compartilhar: Chrome, Edge, Brave, Opera (precisa `getDisplayMedia`)
- **Para assistir**: qualquer navegador moderno
- **Celular**: não funciona para *compartilhar* (limitação do navegador). Assistir costuma falhar.

## Instalação rápida (desenvolvimento)

```bash
# 1. Clone e entre na pasta
git clone https://github.com/LightDNZ/sanctuarytelas.git
cd sanctuarytelas

# 2. Instale dependências
npm install

# 3. Configure (roda assistente interativo)
npm run configurar
# - Escolha "Só no navegador" para testar localmente
# - Ou "Dentro do Discord" e siga o passo a passo do portal

# 4. Suba tudo (build + túnel + servidor)
npm run start:fast
# Abre http://localhost:3001
```

## Comandos principais

| Comando | Descrição |
|---------|-----------|
| `npm install` | Baixa dependências (só na 1ª vez) |
| `npm run configurar` | Assistente interativo (credenciais Discord, túnel, etc.) |
| `npm run start:fast` | **Liga tudo**: configura se precisar, builda, abre túnel, sobe servidor |
| `npm run tunel` | Abre túnel Cloudflare descartável (endereço novo a cada vez) |
| `npm run tunel:criar` | **Uma vez só**: cria túnel fixo na Cloudflare (DNS próprio, não muda mais) |
| `npm start` | Build + servidor (sem túnel) — para produção atrás de proxy |
| `npm run dev` | Dev mode: Vite + servidor + túnel, hot reload |
| `npm run dev:rapido` | Dev mode com túnel descartável, sem mexer no `.env` |
| `npm run build` | Builda só o client (Vite) |
| `npm run smoke` | Teste rápido de integração (healthcheck, WS, auth) |

## Uso no Discord (Activity)

1. No portal: https://discord.com/developers/applications
2. **New Application** → nome → confirmar
3. **OAuth2** → copie **Client ID** e **Client Secret** (Reset Secret para ver)
3. **Activities** → Settings → **Enable Activities**
4. **URL Mappings** → Add Mapping:
   - Prefix: `/`
   - Target: `seu-dominio.com` (sem `https://`)
5. **OAuth2 → Redirects** → Add Redirect:
   - `https://seu-dominio.com/auth/callback`
6. **Save Changes**
7. Instale no servidor: abra `https://discord.com/oauth2/authorize?client_id=SEU_CLIENT_ID`
8. No Discord: canal de voz → ícone 🚀 → escolha a Activity

### Endereço fixo (recomendado)

Por padrão o túnel Cloudflare é descartável (muda a cada reinício). Para fixar:

```bash
npm run tunel:criar
# Abre login Cloudflare → escolha domínio → cria túnel + DNS → escreve .env
```

Depois disso o endereço **nunca mais muda** e você não mexe mais no portal do Discord.

## Deploy em produção (VPS)

### 1. Servidor (Ubuntu 24.04)

```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git

# Usuário dedicado
sudo adduser --system --group --home /opt/sanctuarytelas sanctuarytelas

# Código
sudo -u sanctuarytelas git clone https://github.com/LightDNZ/sanctuarytelas.git /opt/sanctuarytelas
cd /opt/sanctuarytelas
sudo -u sanctuarytelas npm ci
sudo -u sanctuarytelas npm run build

# Config
sudo -u sanctuarytelas npm run configurar
# Preencha .env com:
# NODE_ENV=production
# PUBLIC_ORIGIN=https://seu-dominio.com
# SESSION_SECRET=... (gerado pelo configurar)
# DISCORD_CLIENT_ID=...
# DISCORD_CLIENT_SECRET=...
# DISCORD_BOT_TOKEN=... (opcional, para verificação de voz)
sudo chmod 600 /opt/sanctuarytelas/.env
sudo chown sanctuarytelas:sanctuarytelas /opt/sanctuarytelas/.env

# Systemd
sudo cp infra/sanctuarytelas.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sanctuarytelas
systemctl status sanctuarytelas

# Caddy (HTTPS automático)
sudo apt install -y caddy
sudo cp infra/Caddyfile /etc/caddy/Caddyfile
# Edite /etc/caddy/Caddyfile → troque o domínio
sudo systemctl reload caddy

# Firewall
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

### 2. Discord (produção)

No portal do Discord, aponte para `https://seu-dominio.com`:
- **Activities → URL Mappings**: Prefix `/`, Target `seu-dominio.com`
- **OAuth2 → Redirects**: `https://seu-dominio.com/auth/callback`

### 3. Atualizar

```bash
cd /opt/sanctuarytelas
sudo -u sanctuarytelas git pull
sudo -u sanctuarytelas npm ci
sudo -u sanctuarytelas npm run build
sudo systemctl restart sanctuarytelas
```

### 4. Logs e troubleshooting

```bash
# Servidor
journalctl -u sanctuarytelas -f

# Caddy (certificados, proxy)
journalctl -u caddy -f

# Teste rápido de X-Frame-Options (deve voltar vazio)
curl -sI https://seu-dominio.com | grep -i x-frame
```

## Variáveis de ambiente (.env)

| Variável | Obrigatória? | Descrição |
|----------|--------------|-----------|
| `SESSION_SECRET` | Sim (prod) | Chave HMAC para tokens (64 chars hex). Gerado pelo `npm run configurar`. |
| `PORT` | Não (padrão 3001) | Porta local do servidor. |
| `PUBLIC_ORIGIN` | Sim | Endereço público HTTPS (ex: `https://tela.seusite.com`). Atualizado auto pelo túnel. |
| `DISCORD_CLIENT_ID` | Para Discord | Client ID da Application no portal Discord. |
| `DISCORD_CLIENT_SECRET` | Para Discord | Client Secret da Application. |
| `DISCORD_BOT_TOKEN` | Opcional | Token do Bot (para verificação de voz nas "Salas da call"). |
| `DISCORD_BOT_TOKEN` | Opcional | IDs de admins do painel (separados por vírgula). |
| `TURN_URL` | Opcional | URL do servidor TURN (ex: `turn:seu-turn.com:3478?transport=udp`). |
| `TURN_USER` / `TURN_PASS` | Se TURN | Credenciais do TURN. |
| `NODE_ENV` | Prod | `production` ativa validações estritas (SESSION_SECRET obrigatório). |
| `LOG_FORMAT` | Não | `json` para logs estruturados (Loki, Grafana). |
| `TURN_URL` | Não | URL do TURN (formato: `turn:host:port?transport=udp`). |

## Estrutura do projeto

```
sanctuarytelas/
├── client/          # Frontend (Vite, vanilla JS)
│   ├── src/
│   │   ├── main.js      # Entry point (Activity + standalone)
│   │   ├── style.css    # Estilos (dark mode, grid, dock, fullscreen)
│   │   ├── player.js    # Player WebRTC/relay (decode, render, stats)
│   │   └── audio.js     # Audio encoding/decoding
│   └── index.html
├── server/          # Backend (Node, Express, WS)
│   ├── index.js         # Servidor principal (Express, WS, auth, rooms)
│   ├── rooms.js         # Gerenciamento de salas/usuários
│   ├── tokens.js        # JWT signing/verification
│   ├── system.js        # Métricas de sistema (CPU, mem, disco, rede)
│   ├── admin.js         # Painel admin (/api/admin/*)
│   └── public/          # HTMLs estáticos (privacidade, termos, admin)
├── shared/          # Código compartilhado (client + server)
│   ├── rtc.js           # WebRTC helpers (codecs, ICE, bandwidth)
│   └── broadcaster.js   # Broadcaster (captura, encode, WebRTC peers)
├── infra/           # Configs de infra
│   ├── sanctuarytelas.service  # systemd unit
│   └── Caddyfile              # Reverse proxy + HTTPS
├── scripts/         # CLI tools
│   ├── configurar.mjs       # Assistente interativo
│   ├── tunel.mjs            # Túnel Cloudflare descartável
│   ├── tunel-criar.mjs      # Túnel fixo Cloudflare (DNS)
│   ├── start-fast.mjs       # start:fast (config + build + túnel + server)
│   └── ...
├── docs/            # Documentação extra
└── package.json
```

## Painel administrativo (`/admin`)

Requer `DISCORD_ADMIN_ID` no `.env` (seu User ID numérico do Discord, ative Developer Mode → botão direito → Copy ID).

- Métricas em tempo real: usuários, salas, streams, banda, ping (avg/p50/p95)
- Por servidor (guild): conexões, salas, calls, usuários únicos, tráfego
- Por usuário: nome, avatar, servidores, salas, roles, ping, se está transmitindo
- Sistema: CPU processo/host, memória, disco, uptime, limites de container
- Gráfico de banda (2 min, inbound/outbound)
- Export: não implementado (pode adicionar botão CSV/JSON no `admin.js`)

## Fullscreen e controles

- **Tecla `I`**: toggle overlay de stats (ping, bitrate, resolução, FPS, descartados, transporte)
- **Tecla `Espaço`**: play/pause (quando implementado)
- **Tecla `M`**: mute/unmute
- **Tecla `F`**: fullscreen
- **Botão 🔗 no dock**: copia link da sala (formato `/?room=ID`)
- **Sidebar recolhível**: botão ◀/▶ na lateral + aba flutuante quando recolhida
- **Fullscreen API**: entra em fullscreen real do navegador quando permitido; fallback para modo "cheia" interno (remove sidebar, expande tile)
- **Esc**: sai do fullscreen e restaura layout

## TURN (opcional, para NATs difíceis)

Sem TURN, o relay WebSocket já garante que todos assistem. TURN melhora: tira carga do seu servidor e usa banda de terceiros.

Provedores gratuitos/baixo custo:
- **Metered.ca**: 2 GB/mês grátis
- **Twilio Network Traversal**: ~$0.004/GB
- **Xirsys**: 1 GB/mês grátis
- **Auto-hospedado (coturn)**: VPS separada

```env
TURN_URL=turn:seu-turn.com:3478?transport=udp
TURN_USER=usuario
TURN_PASS=senha
```

## Verificação de voz (opcional)

Sem `DISCORD_BOT_TOKEN`, a "Sala da call" usa `instance_id` da Activity como escopo (menos seguro: cliente pode falsificar).

Com Bot Token:
1. Portal Discord → Bot → Add Bot → **Reset Token** → copie
2. OAuth2 → URL Generator → `bot` + `applications.commands` → autorize no servidor
3. `.env`: `DISCORD_BOT_TOKEN=seu-token`
4. Reinicia: `sudo systemctl restart sanctuarytelas`

O servidor consulta `GET /guilds/{guildId}/voice-states/{userId}` no Discord para confirmar presença no canal de voz.

## Métricas Prometheus (`/metrics`)

Admin-only (requer login `/admin` + cookie `discord_screen_admin`).

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'sanctuary-telas'
    static_configs:
      - targets: ['seu-dominio.com']
    scheme: https
    metrics_path: /metrics
    authorization:
      credentials: SEU_COOKIE_AQUI
```

Métricas principais:
- `sanctuary_up` (1/0)
- `sanctuary_rooms_total`, `sanctuary_users_total`, `sanctuary_connections_total`
- `sanctuary_traffic_in_bytes_per_sec`, `sanctuary_traffic_out_bytes_per_sec`
- `sanctuary_ping_avg_ms`, `sanctuary_ping_p95_ms`
- `sanctuary_cpu_process_percent`, `sanctuary_memory_process_rss_bytes`
- `sanctuary_disk_used_bytes`, `sanctuary_disk_total_bytes`

## Segurança

- **CSP**: `frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com`
- **X-Frame-Options**: `ALLOWALL` (desarma header da hospedagem)
- **Rate limit**: 10 req/s por IP em `/api/token` e `/api/ice`
- **Acesso web direto bloqueado**: retorna 403 com página customizada (só libera via Discord Activity)
- **Cookies admin**: `HttpOnly`, `SameSite=Lax`, 8h, assinados com `SESSION_SECRET`
- **Tokens de sala**: JWT assinados, sem expiração (morrem com a sala)
- **Senhas de sala**: scrypt + salt, rate limit de tentativas

## Testes

```bash
# Unit + integração
npm test

# Com cobertura (threshold: 86% lines/statements/functions, 84% branches)
npx vitest run --coverage
```

## Licença

MIT — uso livre, modificação livre, distribuição livre. Sem garantias.

## Contato / Issues

- GitHub: https://github.com/LightDNZ/sanctuarytelas/issues
- Email: contato@exemplo.com (atualize no `privacidade.html` e `termos.html`)

---

**Não é afiliado ao Discord Inc.** Discord é marca registrada da Discord Inc.