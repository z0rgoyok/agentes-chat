/**
 * The workspace `scripts/geometry/shifts.ts` opens: one person, two agents, a channel long enough to load older pages, a thread whose
 * last reply asks with a question card, every kind of card on messages (a vote, a live block, a document, a table, a
 * picture alone, two pictures), a long channel of many days to scroll through (agents' long answers, pictures, reactions),
 * and a DM with an agent that holds cards too. Made-up names and example.com addresses.
 */
import { deflateSync } from "node:zlib";
import { schema } from "@agenteschat/db";
import { createArtifact, createConversationArtifact, createFileArtifact, insertMessage } from "@agenteschat/engine";
import { browser, signUp, type TestServer } from "./harness";

export const PERSON = { email: "bia@example.com", name: "bia" };

/** A PNG of `width` × `height`, a soft gradient: decodable, so the picture really loads. */
export function png(width: number, height: number) {
  const row = 1 + width * 3;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 3;
      raw[at] = 90 + Math.round((x / width) * 120);
      raw[at + 1] = 110 + Math.round((y / height) * 90);
      raw[at + 2] = 170;
    }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const head = new Uint8Array(13);
  new DataView(head.buffer).setUint32(0, width);
  new DataView(head.buffer).setUint32(4, height);
  head.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  return new Uint8Array(parts.flatMap((p) => [...p]));
}

const ROOT = `Fechei quase toda a feira do livro, mas a inscrição das editoras ainda está parada por três pontos:

1. **Espaço:** o salão comporta 40 mesas e já temos 46 pedidos. A prefeitura pede a planta com as saídas antes de liberar mais.
2. **Energia:** seis editoras querem tomada para o caixa. O salão só tem quatro pontos livres, e eu não vou prometer extensão.
3. **Seguro** aparece como pendente na lista, mas a apólice já está assinada e guardada. Não precisa de ação.

Minha recomendação para os pontos 1 e 2: usar também o pátio coberto. Aí cabem as 46 mesas e o pátio tem tomadas de sobra.

Depois disso ainda falta conferir o mapa das mesas e a escala dos voluntários, que eu preencho com o que a equipe levantou. Só então a lista fica para você aprovar.`;

const LONG = `Conferi cada pedido na planilha. As editoras pedem 5 placas de sinalização (entrada, caixa, palco, café, saída) e uma faixa grande na fachada. As mesmas placas servem para os dois dias, porque ninguém pediu versões por dia.

Perguntei se dá para imprimir tudo na gráfica do bairro, com o mesmo papel e as cores da feira. Para os dois dias são uns 40 cartazes. Minha sugestão: começar pela entrada, o caixa e o palco e deixar os outros para depois.`;

/** An agent's long answer, as a busy channel holds many: a heading, a list, a code block, a table. */
const REPORT = (n: number) => `## Resumo da semana ${n}

Fechei o levantamento das barracas e das doações. O que mudou desde a última conversa:

- **Barracas:** ${20 + (n % 9)} confirmadas, três esperando o comprovante.
- **Doações:** o banco de alimentos manda as caixas na sexta, às 9h.
- **Voluntários:** faltam duas pessoas para o turno da tarde.

\`\`\`text
turno     manhã  tarde
sábado    6      ${4 + (n % 3)}
domingo   5      3
\`\`\`

| Item | Quantidade |
| --- | ---: |
| Mesas | ${30 + n} |
| Cadeiras | ${120 + n * 2} |

Se ninguém se opuser até amanhã, eu fecho a escala assim e mando para a coordenação.`;

const FILLER = [
  "Bom dia! Alguém viu o relatório de ontem?",
  "Vi sim, está na pasta da equipe. Faltam só os números de outubro.",
  "Fechei os números de outubro agora há pouco. Revisa quando puder?",
  "Revisado. Dois ajustes pequenos na tabela de custos, já corrigi.",
  "Combinado. Vou mandar para o pessoal da operação até o fim do dia.",
  "Lembrete: a reunião de quinta foi para as 15h.",
];

/** Signs the person up and fills the workspace. What `shifts.ts` navigates to. */
export async function seed(t: TestServer, origin: string) {
  const b = browser(t, origin);
  await signUp(b, PERSON.email);
  const json = async <T>(res: Response | Promise<Response>) => {
    const r = await res;
    if (r.status >= 300) throw new Error(`seed: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };
  const created = await json<{ organization: { id: string }; generalChannelId: string }>(
    b("/api/app/organizations", {
      json: { name: "Oficina Exemplo", context: "Uma associação que organiza feiras de bairro." },
    }),
  );
  const orgId = created.organization.id;
  const api = (path: string, init?: Parameters<typeof b>[1]) => b(`/api/app/organizations/${orgId}${path}`, init);
  const credential = await json<{ id: string }>(
    api("/credentials", { json: { provider: "anthropic", label: "main", apiKey: "sk-ant-api-not-a-real-key" } }),
  );
  const agent = async (name: string, handle: string) =>
    (
      await json<{ id: string }>(
        api("/agents", {
          json: { name, handle, model: "claude-sonnet-5-5", credentialId: credential.id, monthlyBudgetUsd: 50 },
        }),
      )
    ).id;
  const nina = await agent("Nina", "nina");
  const otto = await agent("Otto", "otto");
  const channel = await json<{ id: string }>(api("/channels", { json: { name: "lancamento", visibility: "public" } }));
  const channelId = channel.id;
  for (const agentId of [nina, otto]) await api(`/channels/${channelId}/members`, { json: { agentId } });
  const [me] = await t.db.select({ id: schema.users.id }).from(schema.users);
  const userId = me?.id ?? "";

  let clock = Date.now() - 3 * 86_400_000;
  const at = (minutes = 3) => {
    clock += minutes * 60_000;
    return new Date(clock);
  };
  type Extra = { threadId?: string; meta?: Record<string, unknown>; minutes?: number; channelId?: string };
  const say = (body: string, extra: Extra = {}) =>
    insertMessage(t.db, {
      orgId,
      channelId: extra.channelId ?? channelId,
      threadId: extra.threadId ?? null,
      author: { type: "person", userId },
      body,
      meta: extra.meta,
      createdAt: at(extra.minutes),
    });
  const agentSays = (agentId: string, body: string, extra: Extra = {}) =>
    insertMessage(t.db, {
      orgId,
      channelId: extra.channelId ?? channelId,
      threadId: extra.threadId ?? null,
      author: { type: "agent", agentId, runId: null, hop: 0, stretchId: null },
      body,
      meta: extra.meta,
      createdAt: at(extra.minutes),
    });
  // As the server writes them: id, version and title, and a picture's size.
  const ref = (a: { id: string; version: number; title: string; content: unknown }) => {
    const c = a.content as { width?: number; height?: number };
    return {
      id: a.id,
      version: a.version,
      title: a.title,
      ...(c.width && c.height ? { width: c.width, height: c.height } : {}),
    };
  };

  // Older pages: more than one page of messages before what the channel opens on.
  for (let i = 0; i < 130; i++) {
    const text = FILLER[i % FILLER.length] as string;
    if (i % 3 === 2) await agentSays(i % 2 ? nina : otto, `${text} (${i})`, { minutes: 7 });
    else await say(`${text} (${i})`, { minutes: 7 });
  }

  // The thread: a long root, eight replies, the last one an agent's question card.
  const root = await say(ROOT, { minutes: 60 });
  await say("Pode seguir com o pátio. E as placas?", { threadId: root.id });
  await t.db
    .insert(schema.threads)
    .values({ orgId, channelId, rootMessageId: root.id, openedByReplyAt: new Date(clock), createdBy: userId })
    .onConflictDoNothing();
  await agentSays(nina, LONG, { threadId: root.id });
  await say("Faz sentido. Guarda isso para as próximas feiras.", { threadId: root.id });
  await agentSays(nina, "Guardado.", {
    threadId: root.id,
    meta: {
      memoryUpdates: [
        {
          action: "remembered",
          itemId: crypto.randomUUID(),
          text: "As placas da feira saem da gráfica do bairro, com as cores da feira",
          requestedByUserId: userId,
        },
      ],
    },
  });
  await say("E a faixa da fachada?", { threadId: root.id });
  await agentSays(nina, LONG, { threadId: root.id });
  await say("Ok, me manda as decisões que faltam.", { threadId: root.id });
  const card = await createConversationArtifact(
    t.engine.artifacts,
    { type: "agent", agentId: nina, channelId, threadId: root.id },
    orgId,
    {
      title: "Placas da feira",
      content: {
        kind: "choices",
        questions: [
          {
            question: "Quais placas saem primeiro?",
            options: [
              { label: "Só as da entrada e do caixa", description: "Entrada, caixa, palco, café, saída" },
              { label: "Entrada, caixa e palco", description: "As outras ficam para depois" },
              { label: "Todas as 40" },
            ],
          },
          {
            question: "Quem imprime as placas?",
            options: [{ label: "A gráfica do bairro" }, { label: "A equipe, na sede" }],
          },
          {
            question: "Quando pendurar?",
            options: [{ label: "Na véspera da feira" }, { label: "No primeiro dia, cedo" }],
          },
        ],
      },
    },
  );
  await agentSays(nina, "Seguem as três decisões sobre as placas.", {
    threadId: root.id,
    meta: { artifacts: [ref(card)] },
  });

  // Cards on the channel's own messages, newest last.
  const poll = await createConversationArtifact(
    t.engine.artifacts,
    { type: "agent", agentId: otto, channelId },
    orgId,
    {
      title: "Qual dia para o lançamento?",
      content: {
        kind: "poll",
        question: "Qual dia para o lançamento?",
        options: ["Terça", "Quinta", "Segunda que vem"],
        multiple: false,
      },
    },
  );
  await t.db.insert(schema.polls).values({
    artifactId: poll.id,
    orgId,
    runId: crypto.randomUUID(),
    closesAt: new Date(Date.now() + 86_400_000),
  });
  await agentSays(otto, "Vamos votar o dia.", { meta: { artifacts: [ref(poll)] } });
  const block = await createConversationArtifact(
    t.engine.artifacts,
    { type: "agent", agentId: nina, channelId },
    orgId,
    {
      title: "Simulador de mesas",
      content: {
        kind: "block",
        subtitle: "Valores de exemplo",
        spec: {
          data: { preco: 30 },
          compute: { custo: "mesas * preco" },
          parts: [
            { type: "slider", name: "mesas", label: "Mesas", min: 1, max: 60, step: 1, value: 40 },
            { type: "stat", label: "Aluguel das mesas", value: "custo" },
          ],
          send: { label: "Reservar estas mesas", text: "Reservar {mesas} mesas." },
        },
      },
    },
  );
  await agentSays(nina, "Escolha as mesas e veja o aluguel.", { meta: { artifacts: [ref(block)] } });
  const doc = await createArtifact(t.engine.artifacts, { type: "agent", agentId: otto, channelId }, orgId, {
    title: "Mapa das mesas",
    channelId,
    content: {
      kind: "document",
      markdown: "# Mapa das mesas\n\n- Salão: 40 mesas\n- Pátio coberto: 6 mesas",
    },
  });
  const table = await createArtifact(t.engine.artifacts, { type: "agent", agentId: otto, channelId }, orgId, {
    title: "Custos da feira",
    channelId,
    content: {
      kind: "table",
      columns: ["Item", "Valor"],
      rows: [
        ["Mesas", "1.200"],
        ["Placas", "180"],
      ],
    },
  });
  await agentSays(otto, "O mapa e os custos.", { meta: { artifacts: [ref(doc), ref(table)] } });
  const file = (name: string, w: number, h: number) =>
    createFileArtifact(t.engine.artifacts, { type: "person", userId }, orgId, {
      title: name,
      name,
      bytes: png(w, h),
      contentType: "image/png",
      channelId,
    });
  const tall = await file("placa-entrada.png", 360, 720);
  await say("A placa da entrada:", { meta: { artifacts: [ref(tall)] } });
  const wide = await file("faixa.png", 1024, 500);
  const square = await file("selo.png", 512, 512);
  await say("A faixa e o selo:", { meta: { artifacts: [ref(wide), ref(square)] } });
  await say("Fecho a lista de mesas hoje à tarde.");

  // A long channel, as people scroll it: many days, agents' long answers between short lines, pictures alone and in
  // pairs, reactions. Pages of it load as the list goes up.
  const long = await json<{ id: string }>(api("/channels", { json: { name: "historico", visibility: "public" } }));
  for (const agentId of [nina, otto]) await api(`/channels/${long.id}/members`, { json: { agentId } });
  const pictures = await Promise.all([
    file("mapa.png", 1200, 800),
    file("cartaz.png", 600, 900),
    file("palco.png", 800, 800),
  ]);
  const resume = clock;
  clock = Date.now() - 12 * 86_400_000;
  for (let i = 0; i < 260; i++) {
    const inLong = { channelId: long.id, minutes: i % 25 === 24 ? 900 : 11 };
    const text = `${FILLER[i % FILLER.length] as string} (${i})`;
    let message: { id: string };
    if (i % 4 === 1) message = await agentSays(i % 8 === 1 ? nina : otto, REPORT(i), inLong);
    else if (i % 9 === 4) {
      const shown = i % 2 ? [pictures[i % 3]] : [pictures[i % 3], pictures[(i + 1) % 3]];
      message = await say(text, { ...inLong, meta: { artifacts: shown.map((p) => ref(p as typeof tall)) } });
    } else message = await say(text, inLong);
    if (i % 5 === 0)
      await t.db.insert(schema.messageReactions).values({ orgId, messageId: message.id, userId, reaction: "👍" });
  }
  clock = resume;

  // A DM with Nina, with a card of its own.
  const dm = await json<{ channelId: string }>(api("/dms", { json: { agentId: nina } }));
  await say("Oi Nina, um resumo do dia?", { channelId: dm.channelId });
  await agentSays(nina, LONG, { channelId: dm.channelId });
  const dmCard = await createConversationArtifact(
    t.engine.artifacts,
    { type: "agent", agentId: nina, channelId: dm.channelId },
    orgId,
    {
      title: "Próximo passo",
      content: {
        kind: "choices",
        questions: [
          {
            question: "O que faço primeiro?",
            options: [{ label: "As placas" }, { label: "A faixa da fachada", description: "Frente e verso" }],
          },
        ],
      },
    },
  );
  await agentSays(nina, "Me diz por onde começo.", { channelId: dm.channelId, meta: { artifacts: [ref(dmCard)] } });

  // Everything read, and the workspace past its onboarding and first visit (which open the right hand's DM first).
  await json(api("/onboarding", { method: "PATCH", json: { finished: true } }));
  const { dms } = await json<{ dms: { channelId: string }[] }>(api("/dms"));
  for (const id of [channelId, long.id, ...dms.map((d) => d.channelId)])
    await api(`/channels/${id}/read`, { json: {} });
  return {
    orgId,
    channelId,
    longChannelId: long.id,
    threadId: root.id,
    ninaId: nina,
    dmChannelId: dm.channelId,
    cookie: b.cookie(),
  };
}
