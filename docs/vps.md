# Hospedar num VPS

Este é o caminho recomendado para deixar a Sala de Tela no ar sem depender do
computador de ninguém. O programa é um relay de vídeo: a saída é
`bitrate × espectadores`, e isso não cabe bem em hospedagem compartilhada. Um
VPS pequeno — 1 vCPU, 2 GB, tráfego generoso — resolve por poucos euros ao mês.

O que **não** funciona bem, e por que este documento existe: PaaS com borda
própria (Square Cloud, e provavelmente outros) carimba
`X-Frame-Options: SAMEORIGIN` em toda resposta. O Discord embute a Activity num
iframe, o navegador obedece ao header, e o resultado é um retângulo branco sem
erro nenhum no log. Não há conserto pelo código: o proxy do Discord repassa
aquele header e substitui o nosso CSP pelo dele. Num VPS o problema não existe,
porque a borda é sua.

Assume Ubuntu 24.04. Em Debian é igual; em outras distribuições muda só o
gerenciador de pacotes.

## 1. Domínio

Um registro **A** apontando para o IP do VPS.

Se o domínio estiver na Cloudflare, deixe em **DNS only** (nuvem cinza). Não é
capricho: o proxy da Cloudflare no plano gratuito não é para tráfego de vídeo
(seção 2.8 dos termos deles), e ele acrescenta uma borda que você não controla
entre o Discord e o seu servidor — foi exatamente esse tipo de borda que
custou um dia de depuração.

## 2. Node

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node -v   # precisa ser 22 ou mais novo
```

Versão 22 ou superior porque o servidor usa `fetch` nativo e `--watch`.

## 3. Usuário e código

Um usuário de sistema sem shell e sem senha: se um dia alguém escapar do
processo, escapa para um usuário que não pode fazer nada.

```bash
sudo adduser --system --group --home /opt/sala-de-tela sala

sudo -u sala git clone https://github.com/Jc007zZ/discord-screen.git /opt/sala-de-tela
cd /opt/sala-de-tela
sudo -u sala npm ci
sudo -u sala npm run build
```

O home do usuário é a própria pasta do projeto de propósito: sem home, o npm
não tem onde escrever o cache e o `npm ci` falha com um erro sobre
`/nonexistent` que não diz nada a ninguém.

O `npm ci` respeita o `package-lock.json` — em servidor isso importa, porque
`npm install` pode subir uma versão menor sem ninguém pedir.

## 4. Configuração

```bash
sudo -u sala npm run configurar
```

O assistente pergunta o essencial e escreve o `.env`. Confira ao final que
ficou assim:

```
PORT=3001
PUBLIC_ORIGIN=https://seu-dominio
NODE_ENV=production
SESSION_SECRET=<hex de 64 caracteres, gerado pelo assistente>
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
```

`PORT=3001` e não 80: quem atende na 80 e na 443 é o Caddy, no passo 6. E o
`SESSION_SECRET` não é opcional aqui — com `NODE_ENV=production` o servidor
recusa subir sem ele, porque sem segredo os crachás de sala seriam forjáveis.

```bash
sudo chmod 600 /opt/sala-de-tela/.env
```

## 5. Serviço

```bash
sudo cp infra/sala-de-tela.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sala-de-tela
systemctl status sala-de-tela
```

Se o `ExecStart` reclamar, confira o caminho do node com `which node` — o
systemd não tem PATH de shell e precisa do caminho absoluto.

## 6. Caddy

```bash
sudo apt install -y caddy
sudo cp infra/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile      # troque o domínio
sudo systemctl reload caddy
```

O certificado do Let's Encrypt é pedido e renovado sozinho. Para isso as portas
80 e 443 precisam estar abertas e o DNS já apontando — se o certificado falhar,
quase sempre é uma dessas duas coisas.

## 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

A 3001 fica fechada de propósito: só o Caddy fala com ela, pelo localhost.

## 8. Discord

No portal, em https://discord.com/developers/applications:

- **Activities → URL Mappings**: prefixo `/`, target `seu-dominio` (sem o `https://`)
- **OAuth2 → Redirects**: `https://seu-dominio/auth/callback`

Feche e reabra a Activity depois de salvar — o cliente do Discord guarda o
iframe e o mapeamento em cache.

## Atualizar

```bash
cd /opt/sala-de-tela
sudo -u sala git pull
sudo -u sala npm ci
sudo -u sala npm run build
sudo systemctl restart sala-de-tela
```

## Quando algo der errado

```bash
journalctl -u sala-de-tela -f      # o servidor
journalctl -u caddy -f             # certificado e proxy
curl -sI https://seu-dominio | grep -i x-frame   # não deve devolver nada
```

Aquele `curl` é o teste que faltou fazer cedo demais neste projeto: se aparecer
um `x-frame-options`, a Activity vai abrir branca, e o problema está em quem
está na frente do servidor — não no código.
