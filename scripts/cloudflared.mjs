/**
 * Garante o cloudflared na máquina, para que "instale o cloudflared" nunca seja
 * um pré-requisito.
 *
 * Antes isto era `npx -y cloudflared`, um pacote intermediário do npm que baixa
 * o mesmo binário — mas depende do registro do npm estar no ar, pergunta antes
 * de instalar na primeira vez e esconde onde o arquivo foi parar. Aqui o
 * binário vem do release oficial da Cloudflare e mora em .cache/ dentro do
 * projeto: trocar de versão é apagar o arquivo, e apagar o projeto leva tudo
 * junto.
 *
 * A ordem é cache → o que já existe na máquina → download. Quem já tem
 * cloudflared instalado não baixa 50 MB de novo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { RAIZ, cor } from './env.mjs';

export const PASTA = path.join(RAIZ, '.cache');

const BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

/**
 * Qual arquivo do release serve para este sistema.
 *
 * Windows em ARM cai no binário amd64 de propósito: a Cloudflare não publica
 * windows-arm64, e o Windows 11 roda x64 por emulação sem que se perceba.
 * macOS é o único que vem empacotado (.tgz); no resto o release já é o
 * executável solto.
 *
 * @returns {{asset: string, binario: string, tgz?: boolean} | null} null quando
 * não existe binário publicado para a combinação — aí só resta instalar à mão.
 */
function alvo() {
  const { platform, arch } = process;

  if (platform === 'win32') {
    const asset = arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
    return { asset, binario: 'cloudflared.exe' };
  }

  if (platform === 'darwin') {
    const asset =
      arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
    return { asset, binario: 'cloudflared', tgz: true };
  }

  if (platform === 'linux') {
    const sufixo = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch];
    if (sufixo) return { asset: `cloudflared-linux-${sufixo}`, binario: 'cloudflared' };
  }

  return null;
}

/** Um cloudflared que responda `--version`, se já houver algum no PATH. */
function doPath() {
  // Os dois nomes porque no Windows a resolução de extensão depende de como o
  // executável foi instalado; testar os dois custa nada e evita um falso "não
  // tenho" que dispara um download desnecessário.
  for (const nome of ['cloudflared', 'cloudflared.exe']) {
    const r = spawnSync(nome, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return nome;
  }
  return null;
}

async function baixar(url, destino) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`o download respondeu ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length')) || 0;
  let lidos = 0;

  const corpo = Readable.fromWeb(res.body);
  corpo.on('data', (pedaco) => {
    lidos += pedaco.length;
    if (!total || !process.stdout.isTTY) return;
    const pct = String(Math.floor((lidos / total) * 100)).padStart(3, ' ');
    process.stdout.write(`\r${cor.fraco}  baixando cloudflared… ${pct}%${cor.fim}`);
  });

  // Grava num arquivo temporário e só então renomeia: um download interrompido
  // pela metade não pode virar um binário quebrado em cache, que falharia toda
  // vez sem nunca tentar baixar de novo.
  const parcial = `${destino}.parcial`;
  await pipeline(corpo, fs.createWriteStream(parcial));
  fs.renameSync(parcial, destino);

  if (total && process.stdout.isTTY) process.stdout.write(`\r${' '.repeat(40)}\r`);
}

/**
 * Caminho de um cloudflared pronto para usar. Baixa se precisar.
 * @returns {Promise<string>}
 */
export async function garantirCloudflared() {
  const t = alvo();
  const local = t && path.join(PASTA, t.binario);

  if (local && fs.existsSync(local)) return local;

  const jaInstalado = doPath();
  if (jaInstalado) return jaInstalado;

  if (!t) {
    throw new Error(
      `a Cloudflare não publica binário para ${process.platform}/${process.arch}. ` +
        'Instale o cloudflared à mão e rode de novo.',
    );
  }

  fs.mkdirSync(PASTA, { recursive: true });

  console.log(
    `${cor.fraco}  Primeira vez: buscando o cloudflared (uns 50 MB, fica guardado).${cor.fim}`,
  );

  if (t.tgz) {
    const pacote = path.join(PASTA, t.asset);
    await baixar(`${BASE}/${t.asset}`, pacote);
    // tar existe em qualquer macOS; é só este caso que precisa dele.
    const r = spawnSync('tar', ['-xzf', pacote, '-C', PASTA], { stdio: 'inherit' });
    fs.rmSync(pacote, { force: true });
    if (r.status !== 0) throw new Error('não consegui extrair o pacote do cloudflared.');
  } else {
    await baixar(`${BASE}/${t.asset}`, local);
  }

  if (process.platform !== 'win32') fs.chmodSync(local, 0o755);

  const versao = spawnSync(local, ['--version'], { encoding: 'utf8' });
  if (versao.status !== 0) {
    // Cache quebrado é pior que cache vazio: some com ele para a próxima
    // execução ter uma chance limpa.
    fs.rmSync(local, { force: true });
    throw new Error('o binário baixado não executou. Rode de novo.');
  }

  const linha = versao.stdout.trim().split('\n')[0];
  console.log(`  ${cor.verde}cloudflared pronto${cor.fim} ${cor.fraco}(${linha})${cor.fim}`);
  return local;
}
