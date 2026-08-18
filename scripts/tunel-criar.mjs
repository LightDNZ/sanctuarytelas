/**
 * Cria um túnel de endereço fixo, do login até o `.env`.
 *
 * O túnel descartável era o caminho de quem só quer testar: zero configuração,
 * endereço na hora. Só que ele é um serviço sem conta e sem garantia — a
 * própria Cloudflare avisa isso no arranque — e quando ele falha, falha em
 * silêncio: o endereço aparece, tudo parece ter dado certo, e o que responde é
 * 404.
 *
 * Este comando troca cinco minutos de configuração por um endereço que é seu e
 * não muda. Ele abre o login da Cloudflare no navegador, cria o túnel, aponta o
 * DNS, escreve o arquivo de configuração e preenche o `.env`. O que sobra para
 * a pessoa é escolher o endereço.
 *
 * Exige um domínio já ativo na Cloudflare: o túnel nomeado precisa de uma zona
 * onde criar o registro, e a Cloudflare não dá subdomínio para isso.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { lerEnv, gravarEnv, cor } from './env.mjs';
import { garantirCloudflared } from './cloudflared.mjs';

const CASA = path.join(os.homedir(), '.cloudflared');
const CERT = path.join(CASA, 'cert.pem');

const linha = (t = '') => console.log(t);
const nota = (t) => linha(`${cor.fraco}${t}${cor.fim}`);
const erro = (t) => linha(`\n${cor.vermelho}  ${t}${cor.fim}\n`);

const rl = createInterface({ input: stdin, output: stdout });

/** Roda o cloudflared e devolve a saída; `mostrar` entrega o terminal a ele. */
function cf(cloudflared, args, { mostrar = false } = {}) {
  const r = spawnSync(cloudflared, args, {
    encoding: 'utf8',
    stdio: mostrar ? 'inherit' : 'pipe',
  });
  return { ok: r.status === 0, saida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// --------------------------------------------------------------------- fluxo

linha();
linha(`${cor.forte}  Sala de Tela · endereço fixo${cor.fim}`);
nota('  Vou criar um túnel seu na Cloudflare, com endereço que não muda.');
nota('  Você precisa de um domínio já ativo na conta da Cloudflare.');
linha();

const cloudflared = await garantirCloudflared().catch((err) => {
  erro(err.message);
  process.exit(1);
});

// ------------------------------------------------------------------- login

if (fs.existsSync(CERT)) {
  nota('  Você já está autenticado na Cloudflare — pulando o login.');
} else {
  linha(`${cor.forte}  Passo 1 · Entrar na Cloudflare${cor.fim}`);
  nota('  Vou abrir o navegador. Faça login e escolha o domínio que quer usar.');
  nota('  Se o navegador não abrir sozinho, use o endereço que aparecer abaixo.');
  linha();

  // stdio herdado: o cloudflared imprime a URL e fica esperando o clique. Sem
  // entregar o terminal a ele, a pessoa espera diante de uma tela parada.
  cf(cloudflared, ['tunnel', 'login'], { mostrar: true });

  if (!fs.existsSync(CERT)) {
    erro('O login não terminou. Rode de novo quando estiver pronto.');
    rl.close();
    process.exit(1);
  }
  linha(`\n${cor.verde}  Autenticado.${cor.fim}`);
}

// ---------------------------------------------------------------- endereço

/** Endereço válido, ou null. Aceita colado com https:// e barra no fim. */
function normalizar(bruto) {
  const limpo = (bruto ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

  // Precisa ser subdomínio: o registro é criado dentro de uma zona sua, e
  // "seudominio.com" sozinho costuma já estar apontando para outra coisa.
  return /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/.test(limpo) ? limpo : null;
}

// Os dois valores também vêm por argumento — é o que permite repetir o comando
// sem responder tudo de novo depois de um erro no meio.
const [argEndereco, argNome] = process.argv.slice(2);

let hostname = normalizar(argEndereco);

if (hostname) {
  nota(`\n  Endereço: ${hostname}`);
} else {
  if (argEndereco) erro('Endereço inválido. Use algo como tela.seudominio.com.br');

  linha();
  linha(`${cor.forte}  Passo 2 · O endereço${cor.fim}`);
  nota('  Um subdomínio do seu domínio, que será o endereço da sala.');
  nota('  Exemplo: tela.seudominio.com.br');
  linha();

  while (!hostname) {
    hostname = normalizar(await rl.question(`  ${cor.azul}Endereço${cor.fim}: `));
    if (!hostname) erro('Use um subdomínio completo, como tela.seudominio.com.br');
  }
}

const nomeSugerido = hostname.split('.')[0];
const nome =
  argNome?.trim() ||
  (argEndereco
    ? nomeSugerido
    : (
        await rl.question(
          `  ${cor.azul}Nome do túnel${cor.fim} ${cor.fraco}[${nomeSugerido}]${cor.fim}: `
        )
      ).trim() || nomeSugerido);

rl.close();

// ------------------------------------------------------------------- túnel

linha();
linha(`${cor.forte}  Passo 3 · Criando${cor.fim}`);
linha();

const existentes = (() => {
  const r = cf(cloudflared, ['tunnel', 'list', '--output', 'json']);
  try {
    return JSON.parse(r.saida.slice(r.saida.indexOf('[')));
  } catch {
    return [];
  }
})();

let tunel = existentes.find((t) => t.name === nome);

if (tunel) {
  nota(`  Já existe um túnel chamado "${nome}" — vou reaproveitá-lo.`);
} else {
  const r = cf(cloudflared, ['tunnel', 'create', nome]);
  if (!r.ok) {
    erro(`Não consegui criar o túnel:\n  ${r.saida.trim().split('\n').pop()}`);
    process.exit(1);
  }
  // O id sai na saída do create, mas a lista é a fonte que não depende do
  // formato da mensagem mudar entre versões.
  const depois = cf(cloudflared, ['tunnel', 'list', '--output', 'json']);
  try {
    tunel = JSON.parse(depois.saida.slice(depois.saida.indexOf('['))).find((t) => t.name === nome);
  } catch {
    /* tratado abaixo */
  }
  if (!tunel) {
    erro('O túnel foi criado mas não consegui achar o id dele. Rode o comando de novo.');
    process.exit(1);
  }
  linha(`  ${cor.verde}Túnel criado${cor.fim} ${cor.fraco}(${tunel.id})${cor.fim}`);
}

const credenciais = path.join(CASA, `${tunel.id}.json`);
if (!fs.existsSync(credenciais)) {
  erro(
    `O arquivo de credenciais não está em ${credenciais}.\n` +
      '  Isso acontece quando o túnel foi criado em outro computador.\n' +
      '  Escolha outro nome, ou copie o arquivo para cá.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------- arquivos

const porta = lerEnv().PORT || '3001';
const configPath = path.join(CASA, `${nome}.yml`);

// Regra catch-all obrigatória no fim: sem ela o cloudflared recusa a subir.
fs.writeFileSync(
  configPath,
  [
    `# Túnel da Sala de Tela. Criado por "npm run tunel:criar".`,
    '#',
    '# O alvo é a porta do servidor, e não a do Vite: a página de captura',
    '# precisa estar acessível fora do proxy do Discord, senão a captura de',
    '# tela volta a ser bloqueada.',
    '',
    `tunnel: ${tunel.id}`,
    `credentials-file: ${credenciais}`,
    '',
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: http://localhost:${porta}`,
    '  - service: http_status:404',
    '',
  ].join('\n')
);

// --------------------------------------------------------------------- DNS

/**
 * O `--config` aqui não é zelo: é obrigatório, e a falta dele estraga o DNS de
 * outra pessoa em silêncio.
 *
 * Sem ele o cloudflared lê o `~/.cloudflared/config.yml`, que existe em quem
 * já usa túnel para outra coisa — e o campo `tunnel:` de lá vence o nome
 * passado por argumento. O registro acaba apontando para o túnel errado, o
 * comando diz "já está configurado", e o endereço passa a responder 530 sem
 * que nada no nosso lado pareça errado.
 */
const rota = cf(cloudflared, [
  '--config',
  configPath,
  'tunnel',
  'route',
  'dns',
  '--overwrite-dns',
  nome,
  hostname,
]);

if (!rota.ok) {
  erro(`Não consegui apontar o DNS:\n  ${rota.saida.trim().split('\n').pop()}`);
  process.exit(1);
}
linha(`  ${cor.verde}DNS apontado${cor.fim} ${cor.fraco}(${hostname})${cor.fim}`);

gravarEnv({ TUNEL_CONFIG: configPath.replace(/\\/g, '/'), PUBLIC_ORIGIN: `https://${hostname}` });

// -------------------------------------------------------------------- fim

linha();
linha(`${cor.verde}${cor.forte}  Pronto. Seu endereço é https://${hostname}${cor.fim}`);
nota('  Ele não muda mais — nem quando você reinicia.');
linha();
linha(`  Agora rode:   ${cor.forte}npm run dev${cor.fim}`);
linha();
nota('  No portal do Discord, em Activities → URL Mappings, o "Target" é:');
linha(`\n      ${cor.verde}${hostname}${cor.fim}\n`);
nota('  E em OAuth2 → Redirects:');
linha(`\n      ${cor.verde}https://${hostname}/auth/callback${cor.fim}\n`);
nota('  Como o endereço é fixo, isso é uma vez só.');
linha();
