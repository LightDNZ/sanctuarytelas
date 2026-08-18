/**
 * Um comando só, do zero ao ar: configura se precisar, monta o site, abre o
 * túnel e sobe o servidor.
 *
 * A diferença para o `npm run dev` não é técnica, é de público. O `dev` supõe
 * que a pessoa já sabe o que tem configurado e o que falta. Aqui a pergunta
 * "e agora?" não deveria existir: ou faltam as credenciais, e ele as pede na
 * hora, ou está tudo pronto, e ele só confirma antes de subir.
 *
 * O túnel é sempre o descartável, e o endereço vai para o `.env` a cada
 * execução — é o que dispensa qualquer conta na Cloudflare.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { lerEnv, gravarEnv, cor } from './env.mjs';
import { garantirEntryPoint, contarEntryPoint } from './entry-point.mjs';
import { abrirTunel } from './tunel.mjs';
import { RAIZ, VITE, acompanhar, derrubar, encerrandoAgora } from './processos.mjs';

const linha = (t = '') => console.log(t);
const nota = (t) => linha(`${cor.fraco}${t}${cor.fim}`);
const erro = (t) => linha(`${cor.vermelho}  ${t}${cor.fim}`);

if (!fs.existsSync(VITE)) {
  linha(`\n${cor.vermelho}  Faltam as dependências. Rode: npm install${cor.fim}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- configurar

const rl = createInterface({ input: stdin, output: stdout });

async function perguntar(rotulo, { padrao = '', valida } = {}) {
  for (;;) {
    const dica = padrao ? ` ${cor.fraco}[${encurtar(padrao)}]${cor.fim}` : '';
    const resposta = (await rl.question(`  ${cor.azul}${rotulo}${cor.fim}${dica}: `)).trim();
    const valor = resposta || padrao;

    const problema = valida?.(valor);
    if (!problema) return valor;
    erro(problema);
  }
}

const encurtar = (t) => (t.length > 24 ? `${t.slice(0, 10)}…${t.slice(-6)}` : t);

/**
 * Pede só o Client ID e o Secret.
 *
 * O `npm run configurar` também pergunta o endereço público, e aqui isso seria
 * pedir o que o próprio comando vai descobrir daqui a dez segundos — o túnel
 * sobe logo depois e grava o endereço sozinho.
 */
async function configurar(atual) {
  linha();
  linha(`${cor.forte}  Credenciais do Discord${cor.fim}`);
  linha();
  linha(`  Abra:  ${cor.forte}https://discord.com/developers/applications${cor.fim}`);
  linha();
  nota('  Clique em "New Application", dê um nome e confirme.');
  nota('  Depois, no menu da esquerda, clique em "OAuth2" — os dois valores');
  nota('  estão nessa página. Para ver o Secret, use "Reset Secret";');
  nota('  ele só aparece uma vez.');
  linha();

  const DISCORD_CLIENT_ID = await perguntar('Client ID', {
    padrao: atual.DISCORD_CLIENT_ID,
    valida: (v) =>
      /^[0-9]{15,21}$/.test(v) ? null : 'O Client ID é só números (uns 19). Confira e cole de novo.',
  });

  const DISCORD_CLIENT_SECRET = await perguntar('Client Secret', {
    padrao: atual.DISCORD_CLIENT_SECRET,
    valida: (v) =>
      v.length >= 20 ? null : 'O Secret é bem mais longo que isso. Confira e cole de novo.',
  });

  gravarEnv({
    // Preservado quando já existe: trocá-lo desconectaria todo mundo que está
    // numa sala agora.
    SESSION_SECRET: atual.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET,
  });

  // Confere aqui, com as credenciais em mao, o atalho que faz a atividade
  // aparecer no foguete. Sem isto era uma configuracao manual invisivel.
  contarEntryPoint(await garantirEntryPoint(DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET));

  linha(`\n${cor.verde}  Guardado.${cor.fim}`);
  nota('  O que falta colar no portal do Discord aparece junto com o endereço,');
  nota('  logo abaixo — ele só existe depois que o túnel sobe.');
}

// --------------------------------------------------------------------- menu

linha();
linha(`${cor.forte}  Sala de Tela${cor.fim}`);

const atual = lerEnv();
const configurado = Boolean(atual.DISCORD_CLIENT_ID && atual.DISCORD_CLIENT_SECRET);

/**
 * Sem terminal de verdade não há como perguntar nada.
 *
 * O `readline` simplesmente nunca resolve quando o stdin fecha, e o Node morre
 * com um "unsettled top-level await" que não diz nada a ninguém. Melhor
 * reconhecer a situação: sem configuração, avisa e sai; com ela, segue direto,
 * que é o comportamento útil para quem chama isto de dentro de outro script.
 */
const interativo = Boolean(stdin.isTTY);

if (!configurado && !interativo) {
  linha();
  erro('Faltam as credenciais do Discord, e não há terminal para perguntar.');
  nota('  Rode "npm run start:fast" direto no terminal, ou "npm run configurar".');
  linha();
  rl.close();
  process.exit(1);
}

if (!configurado) {
  nota('  Primeira vez por aqui — vamos configurar o Discord.');
  nota('  (Ctrl+C a qualquer momento; nada se perde.)');
  await configurar(atual);
} else if (!interativo) {
  nota(`  Aplicação ${atual.DISCORD_CLIENT_ID} — subindo direto (sem terminal para o menu).`);
} else {
  linha();
  linha(`    ${cor.forte}1${cor.fim}  Continuar`);
  nota(`       Sobe tudo agora, com a aplicação ${atual.DISCORD_CLIENT_ID}.`);
  linha();
  linha(`    ${cor.forte}2${cor.fim}  Configurar de novo`);
  nota('       Trocar o Client ID e o Secret.');
  linha();

  const escolha = await perguntar('Escolha (1 ou 2)', {
    padrao: '1',
    valida: (v) => (v === '1' || v === '2' ? null : 'Digite 1 ou 2.'),
  });

  if (escolha === '2') await configurar(atual);
}

rl.close();

// -------------------------------------------------------------------- build

linha();
nota('  Montando o site…');

const build = spawnSync(process.execPath, [VITE, 'build'], {
  cwd: path.join(RAIZ, 'client'),
  stdio: 'ignore',
});

if (build.status !== 0) {
  linha(`\n${cor.vermelho}  O site não compilou. Rode "npm run build" para ver o erro.${cor.fim}\n`);
  process.exit(1);
}

// ------------------------------------------------------------- túnel e servidor

linha(`${cor.fraco}  Abrindo o túnel…${cor.fim}`);
nota('  Ctrl+C derruba tudo junto.');

let servidorIniciado = false;

function iniciarServidor(origem) {
  if (servidorIniciado) return;
  servidorIniciado = true;

  // Pelo ambiente, e não só pelo .env: o servidor lê PUBLIC_ORIGIN uma vez, no
  // arranque, e o endereço acabou de nascer.
  const env = { ...process.env };
  if (origem) env.PUBLIC_ORIGIN = origem;

  acompanhar(
    'servidor',
    cor.azul,
    spawn(process.execPath, ['server/index.js'], { cwd: RAIZ, stdio: 'pipe', env })
  );
}

let tunel;
try {
  // rapido: nunca usa o túnel de endereço fixo, mesmo se houver um configurado.
  // gravar: o endereço fica registrado, que é o que este comando promete.
  tunel = await abrirTunel({ aoEndereco: iniciarServidor, rapido: true, gravar: true });
} catch (err) {
  linha(`\n${cor.vermelho}  ${err.message}${cor.fim}\n`);
  derrubar(1);
}

if (tunel) {
  acompanhar('tunel', cor.amarelo, tunel);

  setTimeout(() => {
    if (servidorIniciado || encerrandoAgora()) return;
    linha(`\n${cor.amarelo}  O túnel demorou a responder — subindo o servidor mesmo assim.${cor.fim}`);
    nota('  Em localhost tudo funciona; só o acesso de fora depende do túnel.');
    iniciarServidor(null);
  }, 45_000).unref();
}
