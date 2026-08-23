/**
 * Sobe o túnel que deixa este computador acessível de fora.
 *
 * Dois modos, e quem decide é o `.env`:
 *
 * - Com `TUNEL_CONFIG` apontando para um túnel próprio, o endereço é fixo. É o
 *   que evita ter que trocar o "Target" no portal do Discord a cada reinício —
 *   o último passo manual que sobrava.
 * - Sem ele, um túnel descartável, com endereço novo a cada execução. O
 *   endereço é gravado no `.env` na hora: copiá-lo à mão era o passo mais fácil
 *   de esquecer, e com o sintoma mais enganoso de todos — tudo abre normalmente
 *   e só o botão de compartilhar leva a uma aba morta.
 *
 * O binário é resolvido por ./cloudflared.mjs, que baixa o release oficial se
 * ainda não houver nenhum. Ninguém precisa instalar nada antes.
 *
 * Serve como comando (`npm run tunel`) e como peça do `npm run dev`, que
 * precisa saber o endereço antes de subir o servidor — daí a função exportada.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { lerEnv, gravarEnv, cor } from './env.mjs';
import { garantirCloudflared, PASTA } from './cloudflared.mjs';

const ENDERECO = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * Abre o túnel e devolve o processo do cloudflared.
 *
 * `aoEndereco` é chamado uma vez, com o endereço público — imediatamente no
 * modo de endereço fixo, e assim que o cloudflared o anuncia no modo
 * descartável. Recebe `null` quando não há endereço a informar, o que só
 * acontece com `TUNEL_CONFIG` definido e `PUBLIC_ORIGIN` vazio.
 *
 * Quem chama é que decide o que fazer com a saída do cloudflared: os dois
 * comandos a mostram, mas o `npm run dev` a prefixa para não se confundir com
 * a do servidor e a do build.
 *
 * `rapido` ignora o `TUNEL_CONFIG` e força o túnel descartável.
 *
 * `gravar` diz se o endereço vai para o `.env`. Os dois são separados porque
 * servem a comandos com intenções opostas: o `dev --rapido` só quer ver o que
 * o túnel descartável faz, sem desconfigurar a instalação de quem testa; o
 * `start:fast` quer justamente deixar o endereço registrado. Por padrão grava,
 * menos quando o rápido foi forçado por cima de uma configuração existente —
 * e nesse caso nem um `gravar: true` explícito passa por cima, porque apagar
 * o endereço fixo de quem tem túnel nomeado nunca é o que se quis pedir.
 *
 * @param {{aoEndereco?: (origem: string | null) => void, rapido?: boolean, gravar?: boolean}} opcoes
 */
export async function abrirTunel({ aoEndereco = () => {}, rapido = false, gravar } = {}) {
  const env = lerEnv();
  const porta = env.PORT || '3001';
  const config = rapido ? '' : env.TUNEL_CONFIG || '';

  // Um túnel descartável nunca sobrescreve o endereço de quem tem túnel
  // nomeado, nem quando quem pediu foi o `start:fast`. O fixo é a configuração
  // da pessoa; o descartável vale só enquanto a janela estiver aberta — e o
  // endereço chega a quem chamou por `aoEndereco`, então nada se perde por não
  // gravar.
  const escrever = (gravar ?? !rapido) && !(rapido && env.TUNEL_CONFIG);

  // --no-autoupdate: o cloudflared se atualiza sozinho e reinicia no meio do
  // caminho, derrubando o túnel sem explicação. Quem manda na versão aqui é o
  // ./cloudflared.mjs.
  const args = config
    ? ['--config', config, 'tunnel', '--no-autoupdate', 'run']
    : [
        '--config',
        configNeutro(),
        'tunnel',
        '--no-autoupdate',
        '--url',
        `http://localhost:${porta}`,
      ];

  const cloudflared = await garantirCloudflared();

  // Sem shell: o caminho do binário vem resolvido, então não há .cmd no meio.
  const tunel = spawn(cloudflared, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  tunel.porta = porta;
  tunel.fixo = Boolean(config);

  if (config) {
    // Endereço fixo: quem sabe qual é ele é o arquivo de configuração do
    // túnel, não o `.env`. Ali o endereço é só uma cópia, e cópia sai de
    // sincronia — bastava um `start:fast` no meio do caminho para o
    // `PUBLIC_ORIGIN` virar o endereço descartável daquela execução, e o túnel
    // nomeado passar a subir anunciando um endereço que já morreu. Lendo o
    // hostname do ingress, o modo fixo se corrige sozinho.
    const doArquivo = hostnameDoConfig(config);
    const origem = doArquivo || env.PUBLIC_ORIGIN || '';

    if (origem && origem !== env.PUBLIC_ORIGIN) {
      gravarEnv({ PUBLIC_ORIGIN: origem });
      console.log(
        `${cor.amarelo}  O .env apontava para outro endereço — corrigi para o do túnel.${cor.fim}`,
      );
    }

    console.log(`${cor.verde}  ${origem || '(endereço definido no config do túnel)'}${cor.fim}\n`);
    aoEndereco(origem || null);
    return tunel;
  }

  let achado = null;
  const procurar = (pedaco) => {
    const url = pedaco.toString().match(ENDERECO)?.[0];
    if (!url || url === achado) return;

    achado = url;
    if (escrever) gravarEnv({ PUBLIC_ORIGIN: url });
    anunciar(url, escrever, env.DISCORD_CLIENT_ID);
    aoEndereco(url);
  };

  tunel.stdout.on('data', procurar);
  tunel.stderr.on('data', procurar);
  return tunel;
}

/**
 * O endereço público declarado no config de um túnel nomeado.
 *
 * Um parser de YAML inteiro seria exagero para uma linha: o que interessa é a
 * primeira regra de ingress com hostname, que é por onde o mundo chega aqui.
 * As outras, quando existem, são o catch-all de 404.
 *
 * @returns {string} vazio quando o arquivo sumiu ou não declara hostname — um
 * túnel roteado só por DNS, por exemplo. Aí vale o que estiver no `.env`.
 */
function hostnameDoConfig(caminho) {
  try {
    const host = fs
      .readFileSync(caminho, 'utf8')
      .split('\n')
      .map((linha) => linha.replace(/#.*/, '').trim())
      .find((linha) => /^-?\s*hostname:\s*\S/.test(linha))
      ?.split(':')
      .slice(1)
      .join(':')
      .trim();

    return host ? `https://${host.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : '';
  } catch {
    return '';
  }
}

/**
 * Um arquivo de configuração vazio, só para o túnel descartável não herdar o
 * `~/.cloudflared/config.yml` da máquina.
 *
 * Sem isto, quem já usa cloudflared para outra coisa tem o `tunnel:` e as
 * credenciais daquele outro túnel injetados num túnel que, por definição, não
 * tem dono nem credencial. O registro sai pela metade e o endereço anunciado
 * responde 404 — sem erro no log, sem nada que aponte para a causa. Foram
 * horas até achar isto: com o arquivo isolado, o mesmo comando responde 200.
 */
function configNeutro() {
  const caminho = path.join(PASTA, 'tunel-rapido.yml');
  fs.mkdirSync(PASTA, { recursive: true });
  // Uma chave inócua, e não um arquivo só com comentário: vazio o cloudflared
  // reclama com um ERR no log, que assusta sem significar nada. Esta repete o
  // que a linha de comando já diz.
  fs.writeFileSync(
    caminho,
    [
      '# Vazio de propósito — ver configNeutro() em scripts/tunel.mjs.',
      'no-autoupdate: true',
      '',
    ].join('\n'),
  );
  return caminho;
}

function anunciar(url, escreveu, clientId) {
  const dominio = url.replace('https://', '');
  console.log(`\n${cor.verde}${cor.forte}  Endereço do túnel: ${url}${cor.fim}`);
  console.log(
    escreveu
      ? `${cor.fraco}  Já guardei no .env — não precisa copiar.${cor.fim}\n`
      : `${cor.fraco}  Modo de teste: não mexi no .env, vale só nesta execução.${cor.fim}\n`,
  );

  // Sem credencial do Discord o programa é só um site: falar de URL Mappings
  // ali seria instrução para um lugar onde a pessoa não tem o que fazer.
  if (!clientId) {
    console.log(
      `${cor.fraco}  Abra esse endereço no navegador para usar de qualquer lugar.${cor.fim}\n`,
    );
    return;
  }

  // O link leva direto à aplicação certa, que é o que ninguém consegue montar
  // de cabeça. As telas de dentro ficam por escrito: o portal não expõe caminho
  // estável para elas, e um link adivinhado que caia em 404 seria pior do que
  // "Activities → URL Mappings", que continua valendo quando eles mexerem na
  // navegação.
  console.log('  Abra a sua aplicação no portal do Discord:');
  console.log(
    `\n      ${cor.verde}https://discord.com/developers/applications/${clientId}${cor.fim}\n`,
  );

  console.log('  Lá, em Activities → URL Mappings, o "Target" é:');
  console.log(`\n      ${cor.verde}${dominio}${cor.fim}\n`);
  console.log('  E em OAuth2 → Redirects:');
  console.log(`\n      ${cor.verde}${url}/auth/callback${cor.fim}\n`);
  console.log(`${cor.fraco}  (esse endereço muda toda vez que este comando reinicia)${cor.fim}\n`);

  // O link de instalação fica por último porque é o único que não muda — e é
  // também o passo que mais some de vista. Sem a aplicação instalada em algum
  // servidor, o comando de entry point existe, o Target está certo, e a
  // atividade continua fora do seletor sem nada explicando por quê.
  console.log('  E, se ainda não instalou a aplicação num servidor — uma vez só:');
  console.log(
    `\n      ${cor.verde}https://discord.com/oauth2/authorize?client_id=${clientId}${cor.fim}\n`,
  );
}

// ------------------------------------------------------------------ comando

// Só quando chamado direto. Importado pelo dev.mjs, nada disto roda.
if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  const porta = lerEnv().PORT || '3001';
  console.log(`\n${cor.fraco}  Abrindo o túnel para localhost:${porta}…${cor.fim}`);
  console.log(`${cor.fraco}  Deixe esta janela aberta enquanto estiver usando.${cor.fim}\n`);

  let tunel;
  try {
    tunel = await abrirTunel({ rapido: process.argv.includes('--rapido') });
  } catch (err) {
    console.log(`\n${cor.vermelho}  ${err.message}${cor.fim}\n`);
    process.exit(1);
  }

  // O cloudflared escreve o essencial no stderr; sem repassar, um erro de rede
  // aqui vira uma janela parada sem explicação nenhuma.
  tunel.stdout.on('data', (p) => process.stderr.write(p));
  tunel.stderr.on('data', (p) => process.stderr.write(p));

  tunel.on('error', (err) => {
    console.log(
      `\n${cor.vermelho}  Não consegui executar o cloudflared: ${err.message}${cor.fim}\n`,
    );
    process.exit(1);
  });

  tunel.on('close', (codigo) => {
    if (!tunel.fixo) {
      console.log(`\n${cor.vermelho}  O túnel fechou (código ${codigo}).${cor.fim}`);
      console.log(
        `${cor.fraco}  Verifique sua conexão e rode "npm run tunel" de novo.${cor.fim}\n`,
      );
    }
    process.exit(codigo ?? 0);
  });

  // Ctrl+C fecha os dois juntos; sem isto o cloudflared fica rodando escondido.
  for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, () => tunel.kill());
  }
}
