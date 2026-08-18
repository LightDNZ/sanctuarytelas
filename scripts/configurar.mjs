/**
 * Assistente de configuração.
 *
 * O setup tinha três armadilhas que não davam erro na hora: inventar um segredo
 * de assinatura, duplicar o Client ID numa variável do build, e apontar o
 * endereço público para o domínio do proxy do Discord. Nenhuma delas falhava no
 * arranque — todas falhavam depois, longe da causa.
 *
 * Aqui o segredo é gerado, a variável de build deixou de existir e o endereço é
 * validado na hora. O que sobra são as perguntas que só uma pessoa consegue
 * responder, com o texto do site do Discord na frente de cada uma.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import crypto from 'node:crypto';

import { lerEnv, gravarEnv, cor } from './env.mjs';
import { garantirEntryPoint, contarEntryPoint } from './entry-point.mjs';

const linha = (texto = '') => console.log(texto);
const titulo = (texto) => linha(`\n${cor.forte}${texto}${cor.fim}`);
const nota = (texto) => linha(`${cor.fraco}${texto}${cor.fim}`);
const erro = (texto) => linha(`${cor.vermelho}  ${texto}${cor.fim}`);

const rl = createInterface({ input: stdin, output: stdout });

/** Pergunta até receber algo válido. Enter aceita o valor atual, quando existe. */
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

const encurtar = (texto) => (texto.length > 24 ? `${texto.slice(0, 10)}…${texto.slice(-6)}` : texto);

// --------------------------------------------------------------------- fluxo

const atual = lerEnv();

linha();
linha(`${cor.forte}  Sala de Tela · configuração${cor.fim}`);
nota('  Vou criar o arquivo de configuração para você.');
nota('  Pode parar com Ctrl+C e rodar de novo quando quiser — nada se perde.');

titulo('  Como você quer usar?');
linha();
linha(`    ${cor.forte}1${cor.fim}  Só no navegador, para testar agora`);
nota('       Não precisa de nada do Discord. Pronto em 10 segundos.');
linha();
linha(`    ${cor.forte}2${cor.fim}  Dentro do Discord`);
nota('       Uns 5 minutos, e você vai precisar abrir o site do Discord.');
linha();

const modo = await perguntar('Escolha (1 ou 2)', {
  padrao: atual.DISCORD_CLIENT_ID ? '2' : '1',
  valida: (v) => (v === '1' || v === '2' ? null : 'Digite 1 ou 2.'),
});

// O segredo é aleatório e ninguém precisa vê-lo: pedir isso a uma pessoa só
// produz segredos ruins. Um já existente é preservado, senão todo mundo que
// estava numa sala seria desconectado a cada reconfiguração.
const SESSION_SECRET = atual.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (modo === '1') {
  gravarEnv({ SESSION_SECRET, DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '' });

  titulo(`  ${cor.verde}Pronto.${cor.fim}`);
  linha();
  linha(`  Agora rode:   ${cor.forte}npm start${cor.fim}`);
  linha(`  E abra:       ${cor.forte}http://localhost:3001${cor.fim}`);
  linha();
  nota('  Dica: abra em duas janelas do navegador. Compartilhe a tela numa');
  nota('  e assista pela outra — dá para ver tudo funcionando sozinho.');
  linha();
  rl.close();
  process.exit(0);
}

// ------------------------------------------------------------ modo Discord

titulo('  Passo 1 de 3 · Credenciais');
linha();
linha(`  Abra:  ${cor.forte}https://discord.com/developers/applications${cor.fim}`);
linha();
nota('  Clique em "New Application", dê um nome e confirme.');
nota('  Depois, no menu da esquerda, clique em "OAuth2".');
nota('  Os dois valores abaixo estão nessa página. Para ver o Secret,');
nota('  clique em "Reset Secret" — ele só aparece uma vez.');
linha();

const DISCORD_CLIENT_ID = await perguntar('Client ID', {
  padrao: atual.DISCORD_CLIENT_ID,
  valida: (v) =>
    /^[0-9]{15,21}$/.test(v) ? null : 'O Client ID é só números (uns 19). Confira e cole de novo.',
});

const DISCORD_CLIENT_SECRET = await perguntar('Client Secret', {
  padrao: atual.DISCORD_CLIENT_SECRET,
  valida: (v) => (v.length >= 20 ? null : 'O Secret é bem mais longo que isso. Confira e cole de novo.'),
});

titulo('  Passo 2 de 3 · Endereço público');
linha();
nota('  O Discord precisa alcançar o programa que roda no seu computador,');
nota('  e para isso ele precisa de um endereço na internet.');
linha();

const jaTemEndereco = atual.PUBLIC_ORIGIN?.startsWith('https://');

if (jaTemEndereco) {
  linha(`  Já tenho um guardado do ${cor.forte}npm run tunel${cor.fim}:`);
  linha(`      ${cor.verde}${atual.PUBLIC_ORIGIN}${cor.fim}`);
  linha();
  nota('  Se for esse mesmo, é só apertar Enter.');
} else {
  linha(`  Abra ${cor.forte}outro terminal${cor.fim} nesta mesma pasta e rode:`);
  linha();
  linha(`      ${cor.forte}npm run tunel${cor.fim}`);
  linha();
  nota('  Ele mostra um endereço terminado em trycloudflare.com e já o guarda');
  nota('  aqui — depois volte e aperte Enter. Ou cole o endereço abaixo.');
}
linha();

const PUBLIC_ORIGIN = await perguntar('Endereço público', {
  padrao: jaTemEndereco ? atual.PUBLIC_ORIGIN : '',
  valida: (v) => {
    if (!v.startsWith('https://')) return 'Precisa começar com https://';
    // A armadilha clássica: com o domínio do proxy aqui, a página de captura
    // abre dentro do sandbox do Discord e a captura de tela volta a ser negada.
    if (v.includes('discordsays.com')) {
      return 'Esse é o endereço do proxy do Discord. Use o do túnel (trycloudflare.com).';
    }
    return null;
  },
});

const origem = PUBLIC_ORIGIN.replace(/\/+$/, '');
const dominio = origem.replace(/^https:\/\//, '');

gravarEnv({ SESSION_SECRET, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, PUBLIC_ORIGIN: origem });

// Confere aqui, com as credenciais em mão, o atalho que faz a atividade
// aparecer no foguete. Sem isto era uma configuração manual invisível.
contarEntryPoint(await garantirEntryPoint(DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET));

titulo('  Passo 3 de 3 · Volte ao site do Discord');
linha();
nota('  Faltam três coisas lá. Já preenchi com os seus valores — é copiar e colar.');

linha(`\n  ${cor.forte}1.${cor.fim} Menu "Activities" → "Settings" → ligue "Enable Activities".`);
linha(`     Depois "Activities" → "URL Mappings" → "Add Mapping":`);
linha();
linha(`        Prefix:  ${cor.verde}/${cor.fim}`);
linha(`        Target:  ${cor.verde}${dominio}${cor.fim}   ${cor.fraco}(sem o https://)${cor.fim}`);

linha(`\n  ${cor.forte}2.${cor.fim} Menu "OAuth2" → "Redirects" → "Add Redirect":`);
linha();
linha(`        ${cor.verde}${origem}/auth/callback${cor.fim}`);
linha();
nota('     Não esqueça o "Save Changes" no rodapé da página.');

linha(`\n  ${cor.forte}3.${cor.fim} Abra este link para instalar a aplicação no seu servidor:`);
linha();
linha(`        ${cor.verde}https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}${cor.fim}`);

titulo(`  ${cor.verde}Feito o que está acima, é só rodar:${cor.fim}`);
linha();
linha(`      ${cor.forte}npm start${cor.fim}`);
linha();
nota('  No Discord: entre num canal de voz e abra a atividade pelo foguete.');
nota(`  Fora do Discord, o site funciona direto em ${origem}`);
linha();
nota('  O endereço do túnel muda toda vez que você fecha o "npm run tunel".');
nota('  Quando isso acontecer, o .env se atualiza sozinho — só o "Target" do');
nota('  passo 1 precisa ser trocado no site do Discord.');
linha();

rl.close();
