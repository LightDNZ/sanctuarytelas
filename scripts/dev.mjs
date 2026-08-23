/**
 * Sobe as três peças do desenvolvimento — site, túnel e servidor — na ordem
 * que funciona.
 *
 * A ordem não é detalhe. Antes as três subiam juntas, e com túnel de endereço
 * fixo isso não tem consequência: o `PUBLIC_ORIGIN` já está no `.env` e não
 * muda. Mas quem clona o repositório cai no túnel descartável, cujo endereço
 * só nasce alguns segundos depois de o cloudflared conectar — e o servidor lê
 * `PUBLIC_ORIGIN` uma única vez, no arranque. Ele partia com o endereço da
 * execução anterior, que já estava morto, e não tinha como se corrigir: o
 * `--watch` do Node acompanha os módulos, não o `.env`.
 *
 * O sintoma era cruel de tão discreto. Tudo abria normalmente; só o botão de
 * compartilhar levava a uma aba que não existia mais.
 *
 * Aqui o servidor só nasce quando já existe endereço, e o recebe pelo próprio
 * ambiente — o dotenv não sobrepõe variável já definida, então o `.env`
 * continua valendo para quem roda o servidor sozinho.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { cor, lerEnv } from './env.mjs';
import { garantirEntryPoint, contarEntryPoint } from './entry-point.mjs';
import { abrirTunel } from './tunel.mjs';
import { RAIZ, VITE, acompanhar, derrubar, encerrandoAgora } from './processos.mjs';

console.log(`\n${cor.fraco}  Subindo o site, o túnel e o servidor…${cor.fim}`);
console.log(`${cor.fraco}  Ctrl+C derruba os três juntos.${cor.fim}\n`);

if (!fs.existsSync(VITE)) {
  console.log(`\n${cor.vermelho}  Faltam as dependências. Rode: npm install${cor.fim}\n`);
  process.exit(1);
}

// O build em watch, e não o servidor do Vite: o túnel aponta para a porta do
// servidor, que serve o build. Com o Vite na 5173 as duas pontas veriam
// coisas diferentes, e a do Discord seria sempre a antiga.
acompanhar(
  'site',
  cor.verde,
  spawn(process.execPath, [VITE, 'build', '--watch'], {
    cwd: path.join(RAIZ, 'client'),
    stdio: 'pipe',
  }),
);

// -------------------------------------------------------------- entry point

// A mesma checagem do `start:fast`, pelo mesmo motivo: sem o comando
// PRIMARY_ENTRY_POINT a atividade não aparece no seletor do Discord, e nem o
// portal nem o terminal dizem por quê. Aqui ela vem depois do build começar,
// para a ida ao Discord acontecer enquanto o vite compila.
//
// Sem credenciais no `.env` é um no-op silencioso: quem roda só no navegador
// não tem atividade nenhuma para registrar.
const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } = lerEnv();
contarEntryPoint(await garantirEntryPoint(DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET));

// -------------------------------------------------------------------- túnel

let servidorIniciado = false;

function iniciarServidor(origem) {
  // O endereço pode ser anunciado de novo se o cloudflared reconectar; o
  // servidor é um só.
  if (servidorIniciado) return;
  servidorIniciado = true;

  const env = { ...process.env };
  if (origem) env.PUBLIC_ORIGIN = origem;

  acompanhar(
    'servidor',
    cor.azul,
    spawn(process.execPath, ['--watch', 'server/index.js'], { cwd: RAIZ, stdio: 'pipe', env }),
  );
}

// --rapido força o túnel descartável mesmo com TUNEL_CONFIG definido, para dar
// para ver o que quem acabou de baixar o repositório vê sem desconfigurar a
// própria instalação.
const rapido = process.argv.includes('--rapido');
if (rapido)
  console.log(`${cor.amarelo}  Modo de teste: túnel descartável, .env intacto.${cor.fim}\n`);

let tunel;
try {
  tunel = await abrirTunel({ aoEndereco: iniciarServidor, rapido });
} catch (err) {
  console.log(`\n${cor.vermelho}  ${err.message}${cor.fim}\n`);
  derrubar(1);
}

if (tunel) {
  acompanhar('tunel', cor.amarelo, tunel);

  // Se o endereço não vier, o servidor nunca sobe e a janela fica parada sem
  // dizer por quê. Melhor falar e subir mesmo assim: sem túnel o site ainda
  // funciona em localhost.
  setTimeout(() => {
    if (servidorIniciado || encerrandoAgora()) return;
    console.log(
      `\n${cor.amarelo}  O túnel demorou a responder — subindo o servidor mesmo assim.${cor.fim}`,
    );
    console.log(
      `${cor.fraco}  Em localhost tudo funciona; só o acesso de fora depende do túnel.${cor.fim}\n`,
    );
    iniciarServidor(null);
  }, 45_000).unref();
}
