# Imagem do servidor da Sala de Tela.
#
# Duas etapas de propósito. A primeira monta o site — o que exige o vite e o
# código do cliente inteiro; a segunda leva só o que roda: servidor, shared,
# client/dist e as dependências de produção. O que compila não precisa viajar
# junto, e a imagem final fica com uma fração do tamanho.

# ------------------------------------------------------------------ build

FROM node:22-slim AS build

WORKDIR /app

# Os package.json antes do resto do código: enquanto as dependências não
# mudarem, o Docker reaproveita esta camada e o deploy pula o npm ci inteiro.
# Os três arquivos porque isto é um workspace — sem os dois de baixo, o npm
# recusa a instalação.
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/

RUN npm ci

COPY . .

RUN npm run build

# ---------------------------------------------------------------- runtime

FROM node:22-slim

# Antes do npm ci: com NODE_ENV=production o npm já pula as devDependencies
# sozinho, e o servidor lê esta mesma variável para exigir o SESSION_SECRET.
ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/

RUN npm ci --omit=dev && npm cache clean --force

COPY server/ server/
COPY shared/ shared/
COPY --from=build /app/client/dist client/dist

# Usuário sem privilégio, já existente na imagem oficial.
USER node

# Só o Traefik do Dokploy fala com esta porta; ela não fica exposta na rede.
EXPOSE 3001

# O health serve ao Docker e ao Dokploy: um container que responde 200 aqui
# está com servidor, salas e build no lugar.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
