/**
 * Cuidar dos processos filhos: prefixar a saída e derrubar todos juntos.
 *
 * Vive à parte porque dois comandos precisam da mesma coisa — o `npm run dev`
 * e o `npm run start:fast` sobem servidor e túnel lado a lado — e porque a
 * parte difícil aqui é o encerramento, que não é óbvio e não pode divergir
 * entre os dois.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cor } from './env.mjs';

export const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * O vite é chamado direto, e não por "npm -w client run build".
 *
 * No Windows o npm é um .cmd, e o Node se recusa a executá-lo sem shell desde
 * a correção do CVE-2024-27980 — spawn devolve EINVAL. Passar shell: true
 * resolveria a execução e criaria outro problema: quem morre no Ctrl+C é o
 * shell, e o vite fica rodando órfão. Chamando o arquivo .js com o próprio
 * Node, o processo é um só e o kill alcança.
 */
export const VITE = path.join(RAIZ, 'node_modules', 'vite', 'bin', 'vite.js');

const filhos = new Set();
let encerrando = false;

/**
 * Repassa a saída de um processo com um prefixo, como o concurrently fazia.
 *
 * Por linha inteira, e não por pedaço: o que chega no 'data' é o que coube no
 * buffer, então prefixar direto partiria linhas no meio e grudaria o prefixo
 * em qualquer lugar.
 */
export function acompanhar(nome, tinta, filho) {
  const marca = `${tinta}[${nome}]${cor.fim} `;

  for (const fluxo of [filho.stdout, filho.stderr]) {
    if (!fluxo) continue;
    let resto = '';
    fluxo.on('data', (pedaco) => {
      const linhas = (resto + pedaco.toString()).split('\n');
      resto = linhas.pop() ?? '';
      for (const linha of linhas) process.stdout.write(`${marca}${linha.replace(/\r$/, '')}\n`);
    });
  }

  filho.on('close', (codigo) => {
    filhos.delete(filho);
    if (encerrando) return;
    console.log(`\n${cor.vermelho}  [${nome}] encerrou (código ${codigo}).${cor.fim}`);
    derrubar(codigo ?? 1);
  });

  filhos.add(filho);
  return filho;
}

/**
 * Mata o processo e a descendência dele.
 *
 * O `kill()` do Node alcança só o filho direto, e isso não basta aqui: o
 * `node --watch` roda o servidor num processo separado, então matar o pai
 * deixa o neto vivo segurando a porta — e a próxima execução morre com "porta
 * já está sendo usada" sem que se veja nada rodando. No Windows quem alcança a
 * árvore inteira é o taskkill com /T.
 */
function matar(filho) {
  if (filho.exitCode !== null || filho.signalCode !== null) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(filho.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  filho.kill();
}

export function derrubar(codigo = 0) {
  if (encerrando) return;
  encerrando = true;
  for (const filho of filhos) matar(filho);
  // Uma folga para os filhos saírem antes de o processo morrer — sem ela o
  // cloudflared às vezes sobrevive à janela que o criou.
  setTimeout(() => process.exit(codigo), 300).unref();
}

export const encerrandoAgora = () => encerrando;

for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => derrubar(0));
