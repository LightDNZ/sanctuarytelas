# Configuração de deploy da Square Cloud.
#
# É este arquivo que responde ao "defina um arquivo principal válido" do
# painel: sem ele a plataforma não tem como saber o que executar num
# repositório com três package.json (raiz, client e server).
#
# O site precisa escutar na porta 80 — exigência da Square Cloud, não do
# programa. Ela chega pela variável PORT, junto com o resto da configuração,
# em "Variáveis de ambiente" no painel.

DISPLAY_NAME=Sala de Tela
DESCRIPTION=Compartilhamento de tela com som para o Discord

# O caminho é a partir da raiz do que sobe: o servidor mora em server/.
MAIN=server/index.js

# O mesmo "npm start" que sobe o programa em qualquer lugar: build do site e
# depois o servidor. Sem esta linha a Square Cloud só executa o MAIN, e um
# servidor sem build é um servidor sem site — "Cannot GET /" na raiz e uma
# Activity em branco no Discord, com o log reportando tudo certo. O client/dist
# está no .gitignore justamente para ser montado aqui, a cada deploy.
#
# É por isso também que o vite saiu de devDependencies: a Square Cloud não
# instala devDependencies, e sem ele o build para em "vite: not found".
START=npm start

MEMORY=512
VERSION=recommended
SUBDOMAIN=tela-discord
AUTORESTART=true
