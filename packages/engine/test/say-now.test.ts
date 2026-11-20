import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type RealtimeEvent } from "@agenteschat/adapters";
import { asc, eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  type AgentRun,
  ANSWER_NUDGE,
  absorbToolData,
  addChannelMember,
  addRunStep,
  type Brain,
  bridgeToolsFor,
  buildRunContext,
  createAgent,
  createAgentRuns,
  createJobHandlers,
  createPassToolSource,
  createSayNowToolSource,
  drainOutbox,
  finishWhatYouStart,
  insertMessage,
  isSayNow,
  loadReplyPolicy,
  type MachineStatus,
  mergeToolEffects,
  moveToBackground,
  openAgentDm,
  openDm,
  postPersonMessage,
  queueOnRun,
  quietForPeople,
  runAtWork,
  SAY_NOW_LINE,
  SAY_NOW_MAX,
  SAY_NOW_TOOL,
  sayNowApplies,
  sayNowText,
  type ToolContext,
  type ToolSideEffects,
  type ToolSource,
  WORK_IN_BACKGROUND_LINE,
  withoutSaidNow,
} from "../src";
import { AGENT_MEDIA_JOB, replySkip } from "../src/agent-media";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * `say_now` (ADR 0207): before work that takes a while, the agent tells the person in one short line what it will do,
 * at once, in the conversation it answers. The reply still brings the result. What the line is, where it may go,
 * what it is never taken for (a reply, news, a route, work), and how the run's turns read it.
 */

// PGlite on a slow machine: a run end to end takes a few seconds.
setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const LINE = "Bora! Vou rodar o build e já te mando.";
const BUILT = "Build ok: os 42 testes passaram.";

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const post = (channelId: string, body: string, threadId?: string) =>
  postPersonMessage(deps(), f.owner.id, f.org.id, channelId, { body, ...(threadId ? { threadId } : {}) });
const byPerson = (channelId: string, body: string) =>
  insertMessage(f.db, { orgId: f.org.id, channelId, author: { type: "person", userId: f.owner.id }, body });
const runs = () => f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
const runById = async (id: string) => {
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id));
  if (!run) throw new Error("no run");
  return run;
};
const messages = () => f.db.select().from(schema.messages).orderBy(asc(schema.messages.createdAt));
/** The lines said before slow work (`meta.sayNow`), oldest first. */
const lines = async () => (await messages()).filter((m) => m.meta.sayNow !== undefined);
/** What the agent said in a conversation, oldest first. */
const agentSaid = async (channelId: string) =>
  (await messages()).filter((m) => m.channelId === channelId && m.authorType === "agent").map((m) => m.body);
const answerOwed = (run: AgentRun) => (run.transcript as { answerOwed?: boolean } | null)?.answerOwed;
const saidNowOf = (run: AgentRun) => (run.transcript as { saidNow?: unknown[] } | null)?.saidNow;
const toolNames = (request: ModelRequest | undefined) => (request?.tools ?? []).map((t) => t.name);
/** An event's fields, as the apps read them. */
const fieldsOf = (e: RealtimeEvent) =>
  e as unknown as { type: string; tool?: string | null; said?: string; messageId?: string };

/** What `say_now` answered the run's calls, in order. */
async function sayNowResults() {
  const steps = await f.db.select().from(schema.agentRunSteps).orderBy(asc(schema.agentRunSteps.seq));
  return steps
    .filter((s) => s.kind === "tool_result" && s.data.name === SAY_NOW_TOOL)
    .map((s) => ({ content: String(s.data.content), isError: s.data.isError === true }));
}

const tools = () => {
  if (!f.tools) throw new Error("no tools");
  return f.tools;
};

/** A tool that takes a while; `during` runs while it works. */
function slowTool(name: string, during: () => Promise<unknown> = async () => {}): ToolSource {
  return {
    name: `slow-${name}`,
    tools: async () => [
      {
        name,
        description: "Takes a while.",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          await during();
          return { content: `${name}: ok` };
        },
      },
    ],
  };
}

/** The model's first response: the work, then its line (written after the work), with what it writes before them. */
const workThenLine = (work: string, line = LINE, words: string[] = []) => ({
  chunks: words,
  toolUses: [
    { id: `toolu_${work}`, name: work, input: {} },
    { id: "toolu_say_now", name: SAY_NOW_TOOL, input: { text: line } },
  ],
});

/** Ana's message in #general without a mention, and the router bringing Dev in (`background`: a routine's run). */
async function routed(body: string, options: { background?: boolean } = {}) {
  const message = await byPerson(f.general.id, body);
  const [run] = await f.db.transaction((tx) => createAgentRuns(tx, message, [f.agent.id], "router"));
  if (!run) throw new Error("no run");
  if (options.background)
    await f.db.update(schema.agentRuns).set({ background: true }).where(eq(schema.agentRuns.id, run.id));
  await drainOutbox(f.db, f.handlers);
  return run;
}

/** The run's tool context, as the engine builds it. */
const ctxOf = (run: AgentRun): ToolContext => ({
  db: f.db,
  orgId: run.orgId,
  agentId: run.agentId,
  runId: run.id,
  channelId: run.channelId,
  threadRootId: run.threadRootId,
  triggerMessageId: run.triggerMessageId,
  ...(run.background ? { background: true } : {}),
});

/** `say_now` called in `run` through the Tool Gateway, as the engine and the bridge call it. */
async function sayNow(run: AgentRun, text: string) {
  const result = await tools().invoke(ctxOf(run), {
    toolUseId: `toolu_${crypto.randomUUID()}`,
    name: SAY_NOW_TOOL,
    input: { text },
  });
  if (result.type !== "result") throw new Error(`a result expected, got ${result.type}`);
  return result.output;
}

/**
 * Ana's request in `channelId` (in the thread of `threadId`; `by`: another agent's), and Dev's run over it, at work:
 * its job never runs, the test calls the tool itself.
 */
async function runOver(
  channelId: string,
  options: { threadId?: string; by?: string; background?: boolean; trigger?: "mention" | "router" } = {},
) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    threadId: options.threadId ?? null,
    author: options.by
      ? { type: "agent", agentId: options.by, runId: null, hop: 1, stretchId: null }
      : { type: "person", userId: f.owner.id },
    body: "monta o relatório de outubro",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId,
      threadRootId: options.threadId ?? trigger.id,
      triggerMessageId: trigger.id,
      trigger: options.trigger ?? "mention",
      hop: trigger.hop + 1,
      status: "running",
      startedAt: new Date(),
      background: options.background ?? false,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

/** Dev's runs at work in each kind of place, its background work's included. */
async function places() {
  const qa = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "QA", handle: "qa", role: "Testes", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  const agentsDm = await openAgentDm(f.db, f.org.id, f.agent.id, qa.id);
  const threadRoot = await byPerson(f.general.id, "O deploy de sexta");
  const missionRoot = await byPerson(f.general.id, "Migrar o login");
  await f.db.insert(schema.missions).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    threadRootId: missionRoot.id,
    ownerId: f.owner.id,
    title: "Migrar o login",
    goal: "Trocar a biblioteca de sessão",
    status: "active",
    brain: "model",
    mainSessionId: crypto.randomUUID(),
  });
  const sealedRoot = await byPerson(f.general.id, "O contrato do cliente");
  await f.db
    .insert(schema.confidentialThreads)
    .values({ orgId: f.org.id, channelId: f.general.id, rootMessageId: sealedRoot.id });
  const working = await runOver(dm.id);
  const moved = await moveToBackground(deps(), working.id, {
    how: "agent",
    title: "Relatório de outubro",
    say: "Vou cuidar disso em segundo plano.",
  });
  if (!moved) throw new Error("not moved");
  return {
    dm: await runOver(dm.id),
    channel: await runOver(f.general.id),
    thread: await runOver(f.general.id, { threadId: threadRoot.id }),
    routine: await runOver(f.general.id, { background: true }),
    work: await runById(working.id),
    agentsDm: await runOver(agentsDm.id, { by: qa.id }),
    mission: await runOver(f.general.id, { threadId: missionRoot.id }),
    confidential: await runOver(f.general.id, { threadId: sealedRoot.id }),
  };
}

describe("the line", () => {
  test("one line, no secret, no mention, no longer than SAY_NOW_MAX", () => {
    expect(sayNowText("Vou usar a chave ghp_abcdefghijklmnopqrstuvwxyz0123 e já te mando.")).toBe(
      "Vou usar a chave •••• e já te mando.",
    );
    // An @ before a name would wake someone, accented names too; an address keeps its own.
    expect(sayNowText("@ana, chamo o @Álvaro e já te mando. Copio ana@acme.com.")).toBe(
      "ana, chamo o Álvaro e já te mando. Copio ana@acme.com.",
    );
    expect(sayNowText("  Bora!\nVou abrir\t\to navegador.  ")).toBe("Bora! Vou abrir o navegador.");
    const long = "Vou abrir o navegador e conferir cada voo da semana. ".repeat(8);
    const cut = sayNowText(long);
    expect(cut.length).toBeLessThanOrEqual(SAY_NOW_MAX);
    expect(cut).toEndWith("…");
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(sayNowText(undefined)).toBe("");
    expect(sayNowText(42)).toBe("");
  });

  test("a reply drops the leading sentences that only repeat it, whatever the case, accents, punctuation or emoji", () => {
    const said = [{ text: "Bora! Vou abrir o navegador e já te mando." }];
    expect(withoutSaidNow("Bora! Vou abrir o navegador e já te mando. Achei 3 voos.", said)).toBe("Achei 3 voos.");
    expect(withoutSaidNow("bora, vou abrir o NAVEGADOR e ja te mando 🙂\nAchei.", said)).toBe("Achei.");
    // Part of the line, word for word, is the line too.
    expect(withoutSaidNow("  Vou abrir o navegador! Achei 3 voos.", said)).toBe("Achei 3 voos.");
    // Only the line again: nothing left to post.
    expect(withoutSaidNow("Bora! Vou abrir o navegador e já te mando.", said)).toBe("");
  });

  test("a short answer the line's words hold, or a heading that runs into a list, is never taken for the line", () => {
    const tests = [{ text: "Vou rodar os testes e te digo se passaram." }];
    expect(withoutSaidNow("Passaram.", tests)).toBe("Passaram.");
    expect(withoutSaidNow("Os testes passaram.", [{ text: "Rodo e te digo se os testes passaram." }])).toBe(
      "Os testes passaram.",
    );
    const flights = [{ text: "Vou buscar os voos mais baratos para Lisboa." }];
    const list = "Os voos mais baratos para Lisboa:\n1. TAP, R$ 3.100\n2. Azul, R$ 3.400";
    expect(withoutSaidNow(list, flights)).toBe(list);
  });

  test("a reply that says something else first, opens with a short word, or follows no line stays whole", () => {
    const said = [{ text: "Bora! Vou abrir o navegador e já te mando." }];
    expect(withoutSaidNow("Achei 3 voos. Bora!", said)).toBe("Achei 3 voos. Bora!");
    expect(withoutSaidNow("Vou abrir o nav. Achei 3 voos.", said)).toBe("Vou abrir o nav. Achei 3 voos.");
    const yes = [{ text: "Sim, vou abrir o navegador." }];
    expect(withoutSaidNow("Sim. Achei 3 voos.", yes)).toBe("Sim. Achei 3 voos.");
    expect(withoutSaidNow("Bora! Achei 3 voos.", undefined)).toBe("Bora! Achei 3 voos.");
    expect(withoutSaidNow("Bora! Achei 3 voos.", [])).toBe("Bora! Achei 3 voos.");
  });

  test("a call of it, by our name or by the name a computer brain's bridge gives it", () => {
    expect(isSayNow(SAY_NOW_TOOL)).toBe(true);
    expect(isSayNow(`mcp__agentes__${SAY_NOW_TOOL}`)).toBe(true);
    expect(isSayNow("say_now_later")).toBe(false);
    expect(isSayNow("react")).toBe(false);
  });

  test("it rides the turn's effects, from the loop and from the bridge alike", () => {
    const t: ToolSideEffects = {};
    absorbToolData(t, { saidNow: { text: LINE, messageId: "m-1" } });
    // Not what the tool answers: nothing kept.
    absorbToolData(t, { saidNow: { text: LINE } });
    mergeToolEffects(t, { saidNow: [{ text: "Quase lá.", messageId: "m-2" }] });
    mergeToolEffects(t, {});
    expect(t.saidNow).toEqual([
      { text: LINE, messageId: "m-1" },
      { text: "Quase lá.", messageId: "m-2" },
    ]);
  });

  test("news for nobody, and no light reply to put a sticker after: its reply is", () => {
    expect(quietForPeople({ sayNow: { runId: "r-1" } })).toBe(true);
    expect(quietForPeople({})).toBe(false);
    const reply = {
      authorType: "agent" as const,
      authorAgentId: "a-1",
      agentRunId: "r-1",
      body: LINE,
      meta: {},
      mentionedAgentIds: [],
      deletedAt: null,
    };
    expect(replySkip(reply)).toBeNull();
    expect(replySkip({ ...reply, meta: { sayNow: { runId: "r-1" } } })).toBe("not_reply");
  });
});

describe("the tool", () => {
  test("at once where the run answers: the agent's message with no run of its own, and the run owes its reply", async () => {
    f = await setup({ sayNow: true });
    const run = await runOver(f.general.id, { trigger: "router" });
    // Brought in by the router: it may stay quiet, until it tells them it is on it.
    expect((await loadReplyPolicy(f.db, f.org.id, run.id))?.mayPass).toBe(true);
    const events = f.listen(f.general.id);
    // A key is never a line for people (ADR 0137 §4): refused, not masked, and nothing owed yet.
    const keyed = await sayNow(run, "Vou usar a chave ghp_abcdefghijklmnopqrstuvwxyz0123 e já te mando.");
    expect(keyed.isError).toBe(true);
    expect(await lines()).toEqual([]);
    expect((await loadReplyPolicy(f.db, f.org.id, run.id))?.mayPass).toBe(true);
    const asked = "Valeu @ana! Vou rodar o build   e já te mando.";
    const said = "Valeu ana! Vou rodar o build e já te mando.";
    const output = await sayNow(run, asked);
    const [line, ...more] = await lines();
    if (!line) throw new Error("no line");
    expect(more).toEqual([]);
    expect(output.isError).toBeFalsy();
    expect(output.data).toMatchObject({ saidNow: { text: said, messageId: line.id } });
    expect(line).toMatchObject({
      channelId: f.general.id,
      threadId: null,
      authorType: "agent",
      authorAgentId: f.agent.id,
      agentRunId: null,
      hop: run.hop,
      stretchId: run.stretchId ?? run.triggerMessageId,
      body: said,
      mentionedUserIds: [],
      meta: { sayNow: { runId: run.id } },
    });
    expect(events.some((e) => e.type === "message.created" && fieldsOf(e).messageId === line.id)).toBe(true);
    expect(answerOwed(await runById(run.id))).toBe(true);
    expect((await loadReplyPolicy(f.db, f.org.id, run.id))?.mayPass).toBe(false);
  });

  test("once per run: a second call answers what it said and posts nothing; another run has its own", async () => {
    f = await setup({ sayNow: true });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const run = await runOver(dm.id);
    expect((await sayNow(run, LINE)).isError).toBeFalsy();
    const again = await sayNow(run, "Quase lá: falta só o deploy.");
    expect(again.isError).toBeFalsy();
    expect(again.content).toStartWith(`Already told them: "${LINE}"`);
    expect(again.data).toBeUndefined();
    expect((await lines()).map((m) => m.body)).toEqual([LINE]);
    const next = await runOver(dm.id);
    expect((await sayNow(next, "Bora! Vou abrir o navegador.")).isError).toBeFalsy();
    expect((await lines()).map((m) => m.body)).toEqual([LINE, "Bora! Vou abrir o navegador."]);
  });

  test("words for a person only: code, a tool's name, a path on a computer or the silence word post nothing", async () => {
    f = await setup({ sayNow: true });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const run = await runOver(dm.id);
    for (const text of [
      "Vou rodar `bun test` e já te mando.",
      "Vou usar o browser_do pra abrir o site.",
      "Vou abrir /Users/ana/relatorio.pdf e já te conto.",
      "Vou olhar em ~/projetos/loja e já volto.",
      "NO_REPLY",
      "Nada novo por aqui. NO_REPLY",
    ]) {
      const output = await sayNow(run, text);
      expect(output.isError, text).toBe(true);
      expect(output.content, text).toStartWith("Not posted");
    }
    expect(await sayNow(run, "   ")).toMatchObject({ isError: true, content: "Not posted: the line is empty." });
    expect(await lines()).toEqual([]);
    expect(answerOwed(await runById(run.id))).toBeUndefined();
    // Plain words still go out after them.
    expect((await sayNow(run, LINE)).isError).toBeFalsy();
    expect((await lines()).map((m) => m.body)).toEqual([LINE]);
  });

  test("a person wrote since the run last read: no line for a conversation that moved on (not an error)", async () => {
    f = await setup({ sayNow: true });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const run = await runOver(dm.id);
    const wrote = await byPerson(dm.id, "na verdade, é o de setembro");
    expect(await queueOnRun(f.db, run.id, wrote.id)).toBe(true);
    const output = await sayNow(run, LINE);
    expect(output.isError).toBeFalsy();
    expect(output.content).toStartWith("They wrote again before your line went out");
    expect(await lines()).toEqual([]);
    expect(answerOwed(await runById(run.id))).toBeUndefined();
    // A notice waiting in its inbox is no person writing: the line goes out.
    const other = await runOver(f.general.id);
    const note = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "Lembrete: conferir o deploy.",
      meta: { notice: { kind: "follow_up", text: "Lembrete: conferir o deploy." } },
    });
    expect(await queueOnRun(f.db, other.id, note.id)).toBe(true);
    expect((await sayNow(other, LINE)).isError).toBeFalsy();
    expect((await lines()).map((m) => m.body)).toEqual([LINE]);
  });

  test("where it applies: a person's run in a conversation people read as it goes", async () => {
    f = await setup({ sayNow: true });
    const at = await places();
    const applies: Record<string, boolean> = {};
    for (const [where, run] of Object.entries(at)) applies[where] = await sayNowApplies(f.db, run);
    expect(applies).toEqual({
      dm: true,
      channel: true,
      thread: true,
      routine: false,
      work: false,
      agentsDm: false,
      mission: false,
      confidential: false,
    });
  });

  test("elsewhere it says why and posts nothing; a routine's run doesn't list it at all", async () => {
    f = await setup({ sayNow: true });
    const at = await places();
    const listed = async (run: AgentRun) => (await tools().list(ctxOf(run))).some((t) => t.name === SAY_NOW_TOOL);
    // Listed in every run with an id, so the list stays the same from run to run; never in a background one.
    expect(await listed(at.dm)).toBe(true);
    expect(await listed(at.agentsDm)).toBe(true);
    expect(await listed(at.work)).toBe(true);
    expect(await listed(at.routine)).toBe(false);
    // Nor for a mission task's call through the bridge, which has no run of its own.
    expect(await createSayNowToolSource({}).tools({ ...ctxOf(at.dm), runId: "" })).toEqual([]);
    for (const run of [at.agentsDm, at.mission]) {
      expect(await sayNow(run, LINE)).toMatchObject({
        isError: true,
        content: expect.stringContaining("Nobody reads this conversation as it goes"),
      });
    }
    expect(await sayNow(at.work, LINE)).toMatchObject({
      isError: true,
      content: expect.stringContaining("post_update"),
    });
    // Its own check in a confidential thread (ADR 0190), whatever the thread's lock says first.
    const [tool] = await createSayNowToolSource({ pubsub: f.pubsub }).tools(ctxOf(at.confidential));
    expect(await tool?.execute({ text: LINE }, { ...ctxOf(at.confidential), confidential: true })).toMatchObject({
      isError: true,
      content: expect.stringContaining("Nobody reads this conversation as it goes"),
    });
    // A run that ended has nothing left to announce.
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, at.dm.id));
    expect(await sayNow(at.dm, LINE)).toMatchObject({ isError: true, content: "This run already ended." });
    expect(await lines()).toEqual([]);
    for (const run of await runs()) expect(answerOwed(run)).toBeUndefined();
  });

  test("its message.posted routes it to nobody and queues no sticker, where another agent could chime in", async () => {
    f = await setup({ sayNow: true });
    const infra = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Infra", handle: "infra", role: "Infrastructure", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: infra.id });
    const run = await runOver(f.general.id);
    // The request's own jobs first, routed by nobody here.
    await drainOutbox(f.db, f.handlers);
    const output = await sayNow(run, LINE);
    const lineId = (output.data?.saidNow as { messageId?: string } | undefined)?.messageId;
    expect(lineId).toBeString();
    let asked = 0;
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: {
        enabled: true,
        model: "claude-haiku-5-5",
        strategy: {
          name: "eager",
          async decide() {
            asked++;
            return { agents: [{ agentId: infra.id, score: 1 }], needsAgent: 1 };
          },
        },
      },
    });
    await drainOutbox(f.db, handlers);
    expect(asked).toBe(0);
    expect((await runs()).map((r) => r.id)).toEqual([run.id]);
    expect((await f.db.select().from(schema.routingDecisions)).filter((d) => d.messageId === lineId)).toEqual([]);
    const jobs = await f.db.select().from(schema.outbox);
    expect(jobs.find((j) => j.kind === "message.posted" && j.payload.messageId === lineId)?.status).toBe("done");
    expect(jobs.filter((j) => j.kind === AGENT_MEDIA_JOB)).toEqual([]);
  });

  test("a run that only said its line is still a conversation, not at work (ADR 0112 addendum)", async () => {
    f = await setup();
    const run = await runOver(f.general.id);
    await addRunStep(f.db, run, "tool_call", { toolUseId: "c-1", name: SAY_NOW_TOOL, input: { text: LINE } });
    expect(await runAtWork(f.db, run.id)).toBe(false);
    await addRunStep(f.db, run, "tool_call", { toolUseId: "c-2", name: "build", input: {} });
    expect(await runAtWork(f.db, run.id)).toBe(true);
  });
});

describe("in a run", () => {
  test("the line goes out before the work, whatever order it was called in, and the reply after the work", async () => {
    let seen: string[] = [];
    const build = slowTool("build", async () => {
      seen = (await lines()).map((m) => m.body);
    });
    const first = workThenLine("build", LINE, ["Vou rodar o build."]);
    f = await setup({
      sayNow: true,
      toolSources: [build],
      reply: (_request, call) => (call === 1 ? first : { chunks: [BUILT] }),
    });
    const root = await post(f.general.id, "o deploy de sexta");
    const events = f.listen(f.general.id);
    await post(f.general.id, "@dev roda o build", root.id);
    await drainOutbox(f.db, f.handlers);

    // One run: the line started nobody.
    const [run, ...others] = await runs();
    if (!run) throw new Error("no run");
    expect(others).toEqual([]);
    expect(run.status).toBe("done");
    // Out while the work ran: the agent's own message, with no run of its own, where the run answers.
    expect(seen).toEqual([LINE]);
    const [line] = await lines();
    if (!line) throw new Error("no line");
    expect(line).toMatchObject({
      channelId: f.general.id,
      threadId: root.id,
      authorType: "agent",
      authorAgentId: f.agent.id,
      agentRunId: null,
      meta: { sayNow: { runId: run.id } },
    });
    expect(saidNowOf(run)).toEqual([{ text: LINE, messageId: line.id, at: expect.any(Number) }]);
    // Its steps: the line first. What the model reads back: the results in the order it called them.
    const steps = await f.db
      .select()
      .from(schema.agentRunSteps)
      .where(eq(schema.agentRunSteps.runId, run.id))
      .orderBy(asc(schema.agentRunSteps.seq));
    expect(steps.filter((s) => s.kind === "tool_call").map((s) => s.data.name)).toEqual([SAY_NOW_TOOL, "build"]);
    const results = (f.provider.calls[1]?.request.messages ?? [])
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .flatMap((b) => (b.type === "tool_result" ? [b.toolUseId] : []));
    expect(results).toEqual(["toolu_build", "toolu_say_now"]);
    // Live: the line before the work's chip, and no chip carries the words written before the calls.
    const chips = events.map(fieldsOf).filter((e) => e.type === "agent.tool" && e.tool);
    expect(chips.map((e) => e.tool)).toEqual([SAY_NOW_TOOL, "build"]);
    expect(chips.filter((e) => e.said !== undefined)).toEqual([]);
    const created = events.findIndex((e) => e.type === "message.created" && fieldsOf(e).messageId === line.id);
    expect(created).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(events.findIndex((e) => fieldsOf(e).tool === "build"));
    // The reply after it, the run's own; its card counts the work, not the line.
    expect(await agentSaid(f.general.id)).toEqual([LINE, BUILT]);
    const reply = (await messages()).find((m) => m.id === run.replyMessageId);
    if (!reply) throw new Error("no reply");
    expect(reply).toMatchObject({ threadId: root.id, agentRunId: run.id, body: BUILT });
    expect(reply.meta.work).toMatchObject({ steps: 1, calls: [{ name: "build", n: 1 }] });
    // Nobody hears of the line; the reply tells whoever asked. The line routes to nobody and gets no sticker.
    const notified = await f.db.select().from(schema.notifications);
    expect(notified.filter((n) => n.source.messageId === line.id)).toEqual([]);
    const toldOfReply = notified.filter((n) => n.source.messageId === reply.id);
    expect(toldOfReply.map((n) => [n.userId, n.kind, n.count])).toEqual([[f.owner.id, "agent_reply", 1]]);
    const jobs = await f.db.select().from(schema.outbox);
    expect(jobs.find((j) => j.kind === "message.posted" && j.payload.messageId === line.id)?.status).toBe("done");
    expect(jobs.filter((j) => j.kind === AGENT_MEDIA_JOB && j.payload.messageId === line.id)).toEqual([]);
  });

  test("a reply that opens with the line again doesn't say it twice", async () => {
    const line = "Bora! Vou abrir o navegador e já te mando.";
    const found = "Achei 3 hotéis em Recife para março: o mais barato sai por R$ 412 a diária.";
    const answer = { chunks: [`${line} ${found}`] };
    f = await setup({
      sayNow: true,
      toolSources: [slowTool("search_flights")],
      reply: (_request, call) => (call === 1 ? workThenLine("search_flights", line) : answer),
    });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await post(dm.id, "acha uns hotéis em Recife para março?");
    await drainOutbox(f.db, f.handlers);
    expect(await agentSaid(dm.id)).toEqual([line, found]);
  });

  test("a second line in the same run is answered with the first, and only the reply follows", async () => {
    const again = { id: "toolu_again", name: SAY_NOW_TOOL, input: { text: "Quase lá: falta só o deploy." } };
    const second = { chunks: [], toolUses: [again] };
    f = await setup({
      sayNow: true,
      toolSources: [slowTool("build")],
      reply: (_request, call) => (call === 1 ? workThenLine("build") : call === 2 ? second : { chunks: [BUILT] }),
    });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await post(dm.id, "roda o build");
    await drainOutbox(f.db, f.handlers);
    expect(await agentSaid(dm.id)).toEqual([LINE, BUILT]);
    expect(await sayNowResults()).toEqual([
      { content: expect.stringMatching(/^Posted\./), isError: false },
      { content: expect.stringContaining(`Already told them: "${LINE}"`), isError: false },
    ]);
    const [run] = await runs();
    if (!run) throw new Error("no run");
    expect(saidNowOf(run)).toHaveLength(1);
  });

  test('after its line, a turn that ends without a word closes with "Done." for the work beside the line', async () => {
    const first = workThenLine("build", LINE, ["Primeiro compilo, depois testo."]);
    f = await setup({
      sayNow: true,
      toolSources: [createPassToolSource(), slowTool("build")],
      // What it writes beside its line is no reply either: only its later turns' words can be.
      reply: (_request, call) => (call === 1 ? first : { chunks: [] }),
    });
    const events = f.listen(f.general.id);
    // Brought in by the router: it could have stayed quiet, until it told them it was on it.
    const run = await routed("alguém roda o build?");
    expect(await runById(run.id)).toMatchObject({ status: "done" });
    // The build it called beside its line is work: no nudge, the run closes as any run that worked and wrote nothing.
    const nudged = f.provider.calls.map((c) => JSON.stringify(c.request.messages).includes(ANSWER_NUDGE));
    expect(nudged).toEqual([false, false]);
    // No closing line taken from the words beside its line; the build it called beside it is work, so the run closes
    // with "Done." as any run that worked and wrote nothing after.
    expect(await agentSaid(f.general.id)).toEqual([LINE, "Done."]);
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, run.id));
    expect(steps.filter((s) => s.data.passed !== undefined)).toEqual([]);
    expect(events.some((e) => e.type === "agent.passed")).toBe(false);
  });

  test("after its line it can't pass: it owes the person its reply", async () => {
    const pass = { chunks: [], toolUses: [{ name: "pass", input: { reason: "nada a acrescentar" } }] };
    f = await setup({
      sayNow: true,
      toolSources: [createPassToolSource(), slowTool("build")],
      reply: (_request, call) => (call === 1 ? workThenLine("build") : call === 2 ? pass : { chunks: [BUILT] }),
    });
    const run = await routed("alguém roda o build?");
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, run.id));
    const refused = steps.find((s) => s.kind === "tool_result" && s.data.name === "pass");
    expect(refused?.data).toMatchObject({
      isError: true,
      content: "You were addressed directly: answer the person instead.",
    });
    expect((await runById(run.id)).status).toBe("done");
    expect(await agentSaid(f.general.id)).toEqual([LINE, BUILT]);
  });

  test("on a computer brain: through the bridge, in hand from the first round, and its reply doesn't say it twice", async () => {
    f = await setup({ sayNow: true });
    const paired = await pairMachine(deps(), f.owner.id, f.org.id, {
      name: "MacBook",
      os: "darwin",
      arch: "arm64",
      version: "0.8.0",
      protocol: MACHINE_PROTOCOL_VERSION,
      exec: true,
    });
    await f.db
      .update(schema.agents)
      .set({ machineId: paired.machineId, brain: "claude_code" })
      .where(eq(schema.agents.id, f.agent.id));
    let upFront: string[] = [];
    const brain: Brain = {
      kind: "claude_code",
      async *run(turn, io) {
        const listed = await bridgeToolsFor(
          { db: f.db, pubsub: f.pubsub, tools: f.tools },
          { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId: paired.machineId },
        );
        upFront = listed.filter((t) => t.upFront).map((t) => t.name);
        const input = { text: LINE };
        const executed = await io.executeTool({ id: "say-1", name: SAY_NOW_TOOL, input });
        yield { type: "tool_call", id: "say-1", name: SAY_NOW_TOOL, input, executed };
        const build = { command: "bun run build" };
        yield { type: "tool_call", id: "bash-1", name: "Bash", input: build, executed: { content: "built" } };
        yield { type: "done", text: `${LINE} ${BUILT}` };
      },
    };
    const status = (id: string): MachineStatus => ({
      id,
      orgId: f.org.id,
      name: "MacBook",
      online: true,
      execAllowed: true,
      os: "darwin",
      protocol: 8,
      executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
    });
    const handlers = createJobHandlers({
      ...f.jobDeps,
      brains: { claude_code: () => brain },
      machines: { status: async (id) => status(id) },
    });
    await post(f.general.id, "@dev roda o build");
    await drainOutbox(f.db, handlers);

    expect(upFront).toEqual([SAY_NOW_TOOL]);
    const [run] = await runs();
    const [line] = await lines();
    if (!run || !line) throw new Error("no run, or no line");
    expect(line).toMatchObject({ body: LINE, agentRunId: null, meta: { sayNow: { runId: run.id } } });
    expect(run.status).toBe("done");
    expect(await agentSaid(f.general.id)).toEqual([LINE, BUILT]);
    // The engine heard it from the bridge: its line, never its reply.
    expect(saidNowOf(run)).toEqual([{ text: LINE, messageId: line.id }]);
  });
});

describe("the prompt", () => {
  test("# How you work: the line after finishing what it starts and before the background's, only when told", async () => {
    f = await setup();
    const run = await runOver(f.general.id);
    const base = { maxMessages: 30, toolsAvailable: true };
    const howYouWork = async (options: { sayNow?: boolean; work?: boolean; toolsAvailable?: boolean }) => {
      const built = await buildRunContext(f.db, run, f.agent, { ...base, ...options });
      return built.system.map((b) => b.text).join("\n");
    };
    const inOrder = `${finishWhatYouStart(false)}\n${SAY_NOW_LINE}\n${WORK_IN_BACKGROUND_LINE}`;
    expect(await howYouWork({ sayNow: true, work: true })).toContain(inOrder);
    const without = await howYouWork({ work: true });
    expect(without).toContain(`${finishWhatYouStart(false)}\n${WORK_IN_BACKGROUND_LINE}`);
    expect(without).not.toContain(SAY_NOW_LINE);
    // No tools, no "# How you work".
    expect(await howYouWork({ sayNow: true, toolsAvailable: false })).not.toContain(SAY_NOW_LINE);
  });

  test("a person's DM: the line in # How you work and the tool in hand from the first call; a routine's run: neither", async () => {
    f = await setup({
      sayNow: true,
      handOff: true,
      toolsOnDemand: true,
      reply: () => ({ chunks: ["Oi! Tudo certo por aqui."] }),
    });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await post(dm.id, "oi");
    await drainOutbox(f.db, f.handlers);
    const inDm = f.provider.calls[0]?.request;
    expect(toolNames(inDm)).toContain(SAY_NOW_TOOL);
    expect(systemText(inDm?.system ?? "")).toContain(SAY_NOW_LINE);

    const before = f.provider.calls.length;
    await routed("confere os pedidos de hoje", { background: true });
    const routine = f.provider.calls[before]?.request;
    expect(toolNames(routine)).toContain("hand_off");
    expect(toolNames(routine)).not.toContain(SAY_NOW_TOOL);
    const system = systemText(routine?.system ?? "");
    expect(system).toContain(finishWhatYouStart(false));
    expect(system).not.toContain(SAY_NOW_LINE);
  });
});
