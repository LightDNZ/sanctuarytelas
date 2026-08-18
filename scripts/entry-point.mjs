/**
 * Garante que a atividade tenha como ser aberta.
 *
 * Uma Activity não abre sozinha: ela precisa de um comando do tipo
 * PRIMARY_ENTRY_POINT (4) com o handler DISCORD_LAUNCH_ACTIVITY (2). É esse
 * comando que coloca a aplicação no foguete do canal de voz.
 *
 * O Discord cria um chamado "Launch" quando você liga Activities no portal, mas
 * ele nem sempre está lá — e o jeito mais fácil de perdê-lo é registrar comandos
 * com sobrescrita em lote (`PUT /applications/{id}/commands`), que substitui a
 * lista global inteira e leva o entry point junto. O sintoma é o aviso amarelo
 * do portal: "has enabled Activities but has no commands registered".
 *
 * Depender de o Discord ter criado é uma configuração manual escondida. Aqui a
 * conferência é automática, dentro do fluxo que já pede as credenciais — quem
 * clona o projeto não precisa saber que PRIMARY_ENTRY_POINT existe.
 *
 * O token sai das credenciais que já temos, por client_credentials: não é
 * preciso token de bot só para isto.
 */
import { cor } from './env.mjs';

const API = 'https://discord.com/api/v10';
const PRIMARY_ENTRY_POINT = 4;
const DISCORD_LAUNCH_ACTIVITY = 2;

async function pegarToken(clientId, clientSecret) {
  const r = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'applications.commands.update',
    }),
  });

  if (!r.ok) throw new Error(`o Discord recusou as credenciais (${r.status})`);
  return (await r.json()).access_token;
}

/**
 * @returns {Promise<'existia'|'criado'|'falhou'>}
 *
 * Nunca lança: falhar aqui não pode derrubar a configuração. Sem o entry point
 * a atividade ainda abre para quem é dono da aplicação, então o certo é avisar
 * e seguir, não parar tudo.
 */
export async function garantirEntryPoint(clientId, clientSecret) {
  if (!clientId || !clientSecret) return 'falhou';

  try {
    const token = await pegarToken(clientId, clientSecret);
    const rota = `${API}/applications/${clientId}/commands`;
    const auth = { Authorization: `Bearer ${token}` };

    const lista = await fetch(rota, { headers: auth });
    if (!lista.ok) throw new Error(`não deu para ler os comandos (${lista.status})`);

    const comandos = await lista.json();
    if (comandos.some((c) => c.type === PRIMARY_ENTRY_POINT)) return 'existia';

    // integration_types e contexts ficam de fora de propósito: são opcionais, e
    // mandá-los aqui sobrescreveria a escolha feita no portal — inclusive a de
    // instalar na conta da pessoa em vez de no servidor.
    const criar = await fetch(rota, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'abrir',
        description: 'Abrir a Sala de Tela nesta call',
        type: PRIMARY_ENTRY_POINT,
        handler: DISCORD_LAUNCH_ACTIVITY,
      }),
    });

    if (!criar.ok) throw new Error(`${criar.status} ${await criar.text()}`);
    return 'criado';
  } catch (err) {
    console.log(`${cor.amarelo}  Não deu para conferir o atalho da atividade: ${err.message}${cor.fim}`);
    console.log(
      `${cor.fraco}  Sem ele, a atividade pode não aparecer no foguete para outras pessoas.${cor.fim}`
    );
    return 'falhou';
  }
}

/** Uma linha no relatório da configuração, no lugar de silêncio. */
export function contarEntryPoint(resultado) {
  if (resultado === 'criado') {
    console.log(`${cor.verde}  Atalho da atividade criado no Discord.${cor.fim}`);
  } else if (resultado === 'existia') {
    console.log(`${cor.fraco}  Atalho da atividade: já estava registrado.${cor.fim}`);
  }
}
