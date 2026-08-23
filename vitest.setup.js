/**
 * O ambiente antes de qualquer import.
 *
 * `server/tokens.js` lê o SESSION_SECRET na primeira assinatura e o guarda; e
 * `server/index.js` decide no corpo do módulo se sobe o painel, se exige
 * segredo e em que porta escuta. Definir isto dentro de um teste chega tarde:
 * o módulo já foi avaliado. Daí um arquivo de preparação, que o Vitest roda
 * antes de importar o teste.
 */
process.env.NODE_ENV = 'test';

/**
 * O `.env` da máquina não entra no teste.
 *
 * `server/index.js` chama `dotenv.config()` ao ser importado, e dotenv não
 * sobrescreve chave que já exista — então defini-las aqui, vazias, é o que
 * fecha a porta. Sem isto, quem tem uma aplicação do Discord configurada vê o
 * servidor de teste nascer com credencial de verdade e os casos de "nada
 * configurado" falharem só na própria máquina, enquanto o CI, que não tem
 * `.env`, segue verde. Quem precisa de credencial a define no próprio arquivo
 * de teste, antes do import — e aí ganha da linha de baixo, que já rodou.
 */
for (const chave of [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_ADMIN_ID',
  'PUBLIC_ORIGIN',
]) {
  process.env[chave] = '';
}
process.env.SESSION_SECRET ??= 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres';
// Porta 0: o sistema escolhe uma livre, e dois arquivos de teste rodando ao
// mesmo tempo não brigam por ela.
process.env.PORT ??= '0';
