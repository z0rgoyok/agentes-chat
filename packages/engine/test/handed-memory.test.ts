import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { asc, countQueries, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  type AgentRun,
  addChannelMember,
  askAgentToImplement,
  buildRunContext,
  continueRun,
  createAgent,
  createIssue,
  drainOutbox,
  endWork,
  expireConsultations,
  handedFor,
  insertMessage,
  onConsultedRunFinished,
  openAgentDm,
  openDm,
  postPersonMessage,
  routineRoomKey,
  sendNote,
  type ToolContext,
} from "../src";
import { runReadOutsideById } from "../src/outside";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * Work one agent hands another for a person happens in the two agents' DM, which no person reads. The agent that got
 * it remembers it in its own DM with that person. What came of handed work reaches the person only where they asked
 * (`handOverWork`): never a second time in that DM.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const AGENTS_DM = "A private conversation between agents";

/** Dev hands Ada the October report (or asks her about it), Ada does it; the prompts each run read, in order. */
async function handOff(tool: "tell_agent" | "ask_agent") {
  const prompts: { system: string; last: string }[] = [];
  f = await setup({
    askAgent: true,
    chatTools: true,
    contextTools: true,
    reply: (req: ModelRequest) => {
      const system = systemText(req.system ?? "");
      const last = JSON.stringify(req.messages.at(-1)?.content);
      prompts.push({ system, last });
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (system.includes(AGENTS_DM)) return { chunks: ["Pronto: está no Drive em Vendas/Outubro, subiu 12%."] };
      if (last.includes("procura"))
        return { chunks: [], toolUses: [{ name: "search_context", input: { query: "pronto drive" } }] };
      if (last.includes("relatório de vendas")) {
        return {
          chunks: [],
          toolUses: [
            tool === "tell_agent"
              ? { name: "tell_agent", input: { agent: "@ada", message: "Faz o relatório de vendas de outubro." } }
              : {
                  name: "ask_agent",
                  input: { agent: "@ada", question: "Onde está o relatório de vendas de outubro?" },
                },
          ],
        };
      }
      return { chunks: ["ok"] };
    },
  });
  await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ada", handle: "ada", role: "Vendas", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const deps = { db: f.db, pubsub: f.pubsub };
  await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, {
    body: "@dev pede pra Ada o relatório de vendas de outubro",
  });
  await drainOutbox(f.db, f.handlers);
  const ada = (await f.db.select().from(schema.agents)).find((a) => a.handle === "ada");
  if (!ada) throw new Error("no agent");
  return { prompts, ada, deps };
}

/** A person writes Ada in their DM; the system prompt of her run there. */
async function askInDm(f: Fixture, userId: string, adaId: string, prompts: { system: string; last: string }[]) {
  const dm = await openDm(f.db, userId, f.org.id, { agentId: adaId });
  const before = prompts.length;
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, dm.id, { body: "cadê aquilo?" });
  await drainOutbox(f.db, f.handlers);
  return prompts.slice(before).find((p) => p.last.includes("cadê aquilo"))?.system ?? "";
}

/** A person asks Ada in their DM to look it up: what her `search_context` there returned. */
async function searchInDm(f: Fixture, userId: string, adaId: string, prompts: { system: string; last: string }[]) {
  const dm = await openDm(f.db, userId, f.org.id, { agentId: adaId });
  const before = prompts.length;
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, dm.id, { body: "procura aquilo" });
  await drainOutbox(f.db, f.handlers);
  return prompts.slice(before).find((p) => p.last.includes("tool_result"))?.last ?? "";
}

describe("work handed between agents, for a person", () => {
  test("handed work: remembered in their DM, never in the agents' DM", async () => {
    const { prompts, ada } = await handOff("tell_agent");
    const inAgentsDm = prompts.find((p) => p.system.includes(AGENTS_DM))?.system ?? "";
    expect(inAgentsDm).not.toBe("");
    expect(inAgentsDm).not.toContain("# What other agents asked of you");

    const later = await askInDm(f, f.owner.id, ada.id, prompts);
    expect(later).toContain("# What other agents asked of you for ana");
    expect(later).toContain(
      '- @dev handed you, 0 min ago: "Faz o relatório de vendas de outubro." → you answered "Pronto: está no Drive em Vendas/Outubro, subiu 12%."',
    );
  });

  test("a question: the agent remembers it too", async () => {
    const { prompts, ada } = await handOff("ask_agent");
    const later = await askInDm(f, f.owner.id, ada.id, prompts);
    expect(later).toContain(
      '- @dev asked you, 0 min ago: "Onde está o relatório de vendas de outubro?" → you answered "Pronto: está no Drive em Vendas/Outubro, subiu 12%."',
    );
  });

  test("another person's DM with the same agent never shows it", async () => {
    const { prompts, ada } = await handOff("tell_agent");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const theirs = await askInDm(f, bia.id, ada.id, prompts);
    expect(theirs).not.toBe("");
    expect(theirs).not.toContain("# What other agents asked of you");
    expect(theirs).not.toContain("Vendas/Outubro");
  });

  test("its search in the person's DM finds that work, never in another person's DM", async () => {
    const { prompts, ada } = await handOff("tell_agent");
    expect(await searchInDm(f, f.owner.id, ada.id, prompts)).toContain("Vendas/Outubro, subiu 12%");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const theirs = await searchInDm(f, bia.id, ada.id, prompts);
    expect(theirs).toContain("tool_result");
    expect(theirs).not.toContain("subiu 12%");
  });

  test("another person's exchanges in the agents' DM never take the places of what the search found before", async () => {
    const { prompts, ada } = await handOff("tell_agent");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ada.id });
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "O pronto do drive compartilhado foi aprovado na reunião de segunda.",
    });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const forBia = await devRun(f.general.id, "@dev pede pra Ada umas coisas", bia.id);
    const room = await openAgentDm(f.db, f.org.id, f.agent.id, ada.id);
    for (let i = 0; i < 9; i++)
      await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: room.id,
        author: { type: "agent", agentId: f.agent.id, runId: forBia.id, hop: 1 },
        body: `Pronto, drive: item ${i}.`,
      });
    await drainOutbox(f.db, f.handlers);
    const found = await searchInDm(f, f.owner.id, ada.id, prompts);
    expect(found).toContain("aprovado na reunião de segunda");
    expect(found).toContain("Vendas/Outubro, subiu 12%");
    expect(found).not.toContain("drive: item");
  });
});

/** A run of `agentId` on `personId`'s message in `channelId` (in the thread of `threadId`), as tools run it (no model). */
async function agentRun(
  agentId: string,
  channelId: string,
  body: string,
  personId = f.owner.id,
  more: { threadId?: string; background?: boolean } = {},
) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: personId },
    body,
    threadId: more.threadId,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId,
      threadRootId: more.threadId ?? trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      stretchId: trigger.id,
      background: more.background ?? false,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

/** A run of Dev's on `personId`'s message in `channelId`, as the tool runs it (no model). */
const devRun = (channelId: string, body: string, personId = f.owner.id) =>
  agentRun(f.agent.id, channelId, body, personId);

const invoke = (run: AgentRun, name: string, input: Record<string, unknown>) => {
  if (!f.tools) throw new Error("no tools");
  const ctx: ToolContext = {
    db: f.db,
    orgId: run.orgId,
    agentId: run.agentId,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  };
  return f.tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
};

const tell = (run: AgentRun, agent: string, message: string) => invoke(run, "tell_agent", { agent, message });

const search = async (run: AgentRun, query: string) => JSON.stringify(await invoke(run, "search_context", { query }));

/**
 * Dev asks Ada in `roomId` from `asker` (a run made for a person), at `createdAt`, as `ask_agent` writes it (for the
 * owner unless `more` says otherwise).
 */
async function asked(
  roomId: string,
  asker: AgentRun,
  targetAgentId: string,
  question: string,
  createdAt = new Date(),
  more: Partial<typeof schema.agentConsultations.$inferInsert> = {},
) {
  const note = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: roomId,
    author: { type: "agent", agentId: f.agent.id, runId: asker.id, hop: 1 },
    body: question,
  });
  await f.db.insert(schema.agentConsultations).values({
    orgId: f.org.id,
    kind: "question",
    askerRunId: asker.id,
    askerAgentId: f.agent.id,
    targetAgentId,
    channelId: roomId,
    messageId: note.id,
    waitId: `w-${crypto.randomUUID()}`,
    question,
    chain: [f.agent.id],
    expiresAt: new Date(Date.now() + 60_000),
    createdAt,
    forUserId: f.owner.id,
    ...more,
  });
}

const runOf = async (id: string | null | undefined) => {
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, id ?? ""));
  if (!run) throw new Error("no run");
  return run;
};

const notes = () => f.db.select().from(schema.agentConsultations).orderBy(asc(schema.agentConsultations.createdAt));

/** What a run that read outside content posts carries the mark (the executor's `post`). */
const outsideMark = async (run: AgentRun) =>
  (await runReadOutsideById(f.db, f.org.id, run.id)) ? { readOutside: true } : {};

/** Ada's run ends with its report (`meta.workEnd` and the outside mark, as the executor posts it), then its hooks run. */
async function reports(run: AgentRun, body = "Pronto: está no Drive em Vendas/Outubro.") {
  const said = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: run.channelId,
    author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
    body,
    meta: { workEnd: { id: run.workId, status: "done" }, ...(await outsideMark(run)) },
  });
  await f.db
    .update(schema.agentRuns)
    .set({ status: "done", replyMessageId: said.id })
    .where(eq(schema.agentRuns.id, run.id));
  const ended = await runOf(run.id);
  await endWork({ db: f.db, pubsub: f.pubsub }, ended, "done");
  await onConsultedRunFinished({ db: f.db, pubsub: f.pubsub }, ended, "done");
}

/** A run's reply in its conversation, as the executor posts and records it. */
async function replies(run: AgentRun, body: string) {
  const said = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: run.channelId,
    author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
    body,
    meta: await outsideMark(run),
  });
  await f.db.update(schema.agentRuns).set({ replyMessageId: said.id }).where(eq(schema.agentRuns.id, run.id));
}

/** The person stops Ada's run (its work and note close as canceled). */
async function stops(run: AgentRun) {
  const said = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: run.channelId,
    author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
    body: "Lendo as vendas.",
    meta: { canceled: { byUserId: f.owner.id, text: "Lendo as vendas." } },
  });
  await f.db
    .update(schema.agentRuns)
    .set({
      status: "canceled",
      error: `canceled_by:${f.owner.id}`,
      replyMessageId: said.id,
      transcript: { system: "", messages: [] },
    })
    .where(eq(schema.agentRuns.id, run.id));
  const stopped = await runOf(run.id);
  await endWork({ db: f.db, pubsub: f.pubsub }, stopped, "canceled");
  await onConsultedRunFinished({ db: f.db, pubsub: f.pubsub }, stopped, "canceled");
}

/** A DM of the owner, a second person and an agent. */
async function groupDm(agentId: string, secondId: string) {
  const [group] = await f.db
    .insert(schema.channels)
    .values({
      orgId: f.org.id,
      name: "dm-group",
      visibility: "private",
      kind: "dm",
      dmKey: `a:${agentId}|u:${secondId}|u:${f.owner.id}`,
    })
    .returning();
  if (!group) throw new Error("no group");
  await f.db.insert(schema.channelMembers).values([
    { orgId: f.org.id, channelId: group.id, userId: f.owner.id },
    { orgId: f.org.id, channelId: group.id, userId: secondId },
    { orgId: f.org.id, channelId: group.id, agentId },
  ]);
  return group;
}

/** Dev hands Ada the October report from #general: her run becomes handed work, reporting there. */
async function handedToAda() {
  f = await setup({ askAgent: true });
  const ada = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ada", handle: "ada", role: "Vendas", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const dev = await devRun(f.general.id, "@dev pede pra Ada o relatório de vendas de outubro");
  await tell(dev, "@ada", "Faz o relatório de vendas de outubro.");
  const [c] = await notes();
  const run = await runOf(c?.targetRunId);
  const [work] = await f.db.select().from(schema.agentWorks);
  expect(work).toMatchObject({ how: "handed", consultationId: c?.id });
  const memory = async () => (await handedFor(f.db, f.org.id, ada.id, f.owner.id)).map((h) => [h.status, h.answer]);
  return { ada, dev, run, memory };
}

describe("it follows the handed work, not the note", () => {
  test("stopped, then Continuar, then done: still on it while it runs again, then what it reported", async () => {
    const { run, memory } = await handedToAda();
    expect(await memory()).toEqual([["open", null]]);
    await stops(run);
    expect((await notes())[0]?.status).not.toBe("open");
    expect(await memory()).toEqual([["failed", null]]);
    expect((await handedFor(f.db, f.org.id, run.agentId, f.owner.id))[0]?.stopped).toBe(true);
    const { runId } = await continueRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, run.id);
    // The note stays closed; the work runs again.
    expect((await notes())[0]?.status).not.toBe("open");
    expect(await memory()).toEqual([["open", null]]);
    await reports(await runOf(runId));
    expect(await memory()).toEqual([["answered", "Pronto: está no Drive em Vendas/Outubro."]]);
  });

  test("a report deleted since is never quoted", async () => {
    const { run, memory } = await handedToAda();
    await reports(run);
    expect(await memory()).toEqual([["answered", "Pronto: está no Drive em Vendas/Outubro."]]);
    const [work] = await f.db.select().from(schema.agentWorks);
    await f.db
      .update(schema.messages)
      .set({ deletedAt: new Date() })
      .where(eq(schema.messages.id, work?.resultMessageId ?? ""));
    expect(await memory()).toEqual([["answered", null]]);
  });

  test("waiting on the person: still on it, past the note's deadline", async () => {
    const { run, memory } = await handedToAda();
    const deps = { db: f.db, pubsub: f.pubsub };
    await f.db.update(schema.agentRuns).set({ status: "waiting_input" }).where(eq(schema.agentRuns.id, run.id));
    await onConsultedRunFinished(deps, await runOf(run.id), "waiting_input");
    await expireConsultations(deps, new Date(Date.now() + 60 * 60_000));
    expect(await memory()).toEqual([["open", null]]);
  });

  test("a note that joined another hand-off's work reads that work's state too", async () => {
    const { run, memory } = await handedToAda();
    const second = await devRun(f.general.id, "@dev pede pra Ada incluir o terceiro trimestre");
    await tell(second, "@ada", "Inclui o terceiro trimestre no relatório.");
    const cs = await notes();
    expect(cs).toHaveLength(2);
    expect(cs[1]?.targetRunId).toBe(run.id);
    await f.db.update(schema.agentRuns).set({ pendingMessageIds: [] }).where(eq(schema.agentRuns.id, run.id));
    await stops(run);
    const { runId } = await continueRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, run.id);
    expect((await memory()).map(([status]) => status)).toEqual(["open", "open"]);
    await reports(await runOf(runId), "Pronto, com o terceiro trimestre.");
    expect(await memory()).toEqual([
      ["answered", "Pronto, com o terceiro trimestre."],
      ["answered", "Pronto, com o terceiro trimestre."],
    ]);
  });

  test("a report its run wrote after reading outside content is left out", async () => {
    const { run } = await handedToAda();
    await f.db
      .insert(schema.agentRunSteps)
      .values({ orgId: f.org.id, runId: run.id, seq: 1, kind: "tool_result", data: { data: { outside: true } } });
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, run.id));
    await reports(await runOf(run.id), "Pronto, como dizia a página.");
    const [h] = await handedFor(f.db, f.org.id, (await runOf(run.id)).agentId, f.owner.id);
    expect(h).toMatchObject({ status: "answered", answer: null, answerHidden: true });
  });
});

describe("what it keeps, and what it leaves out", () => {
  test("a heads-up is news, not a request: not in it", async () => {
    const { memory } = await handedToAda();
    const [c] = await notes();
    // As `tell_agent` with `heads_up` writes its note.
    await f.db
      .update(schema.messages)
      .set({ meta: { agentNote: { runId: c?.askerRunId, headsUp: true } } })
      .where(eq(schema.messages.id, c?.messageId ?? ""));
    expect(await memory()).toEqual([]);
  });

  test("the person's own come back among many newer hand-offs for someone else", async () => {
    const { ada, memory } = await handedToAda();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const room = await openAgentDm(f.db, f.org.id, f.agent.id, ada.id);
    const forBia = await devRun(f.general.id, "@dev pede pra Ada umas coisas", bia.id);
    const at = Date.now();
    for (let i = 0; i < 25; i++) {
      const note = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: room.id,
        author: { type: "agent", agentId: f.agent.id, runId: forBia.id, hop: 1 },
        body: `Coisa ${i} da Bia.`,
      });
      await f.db.insert(schema.agentConsultations).values({
        orgId: f.org.id,
        kind: "question",
        askerRunId: forBia.id,
        askerAgentId: f.agent.id,
        targetAgentId: ada.id,
        channelId: room.id,
        messageId: note.id,
        waitId: `w${i}`,
        question: `Coisa ${i} da Bia.`,
        chain: [f.agent.id],
        expiresAt: new Date(at + 60_000),
        createdAt: new Date(at + (i + 1) * 1000),
        forUserId: bia.id,
      });
    }
    expect(await memory()).toEqual([["open", null]]);
    expect((await handedFor(f.db, f.org.id, ada.id, bia.id)).map((h) => h.question)).toEqual(
      [24, 23, 22, 21, 20, 19].map((i) => `Coisa ${i} da Bia.`),
    );
  });

  test("a task the right hand handed it is remembered too, by its work", async () => {
    f = await setup({ askAgent: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const carl = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Carl", handle: "carl", role: "Vendas", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const dev = await devRun(dm.id, "@dev passa o relatório de vendas pro Carl");
    const made = await createIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Relatório de vendas",
    });
    await askAgentToImplement(deps, f.owner.id, f.org.id, made.id, carl.id, {
      agentId: f.agent.id,
      runId: dev.id,
      hop: 1,
    });
    const [work] = await f.db.select().from(schema.agentWorks);
    expect(work).toMatchObject({ how: "handed", agentId: carl.id });
    const [h] = await handedFor(f.db, f.org.id, carl.id, f.owner.id);
    expect(h).toMatchObject({
      kind: "note",
      status: "open",
      question: `Work on task #${made.number}: Relatório de vendas`,
    });
    const [carlRun] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.workId, work?.id ?? ""));
    if (!carlRun) throw new Error("no run");
    await reports(carlRun);
    expect((await handedFor(f.db, f.org.id, carl.id, f.owner.id))[0]).toMatchObject({
      status: "answered",
      answer: "Pronto: está no Drive em Vendas/Outubro.",
    });
  });

  test("an answer from a run a routine feeds is left out, though a person wrote into the run that asked", async () => {
    f = await setup({ askAgent: true });
    const ada = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Vendas", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const routine = await agentRun(f.agent.id, f.general.id, "rotina", f.owner.id, { background: true });
    // What a person decided on the routine's proposal comes back to its run, unmarked, and wakes a run nobody is behind.
    const notice = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body: "Criado.",
      meta: { notice: { kind: "proposal_result", from: "Proposta", text: "Criado.", refs: { runId: routine.id } } },
    });
    const [woken] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: notice.id,
        triggerMessageId: notice.id,
        trigger: "mention",
        hop: 1,
        stretchId: notice.id,
        transcript: { system: "", messages: [], steeredBy: f.owner.id } as never,
      })
      .returning();
    if (!woken) throw new Error("no run");
    await invoke(woken, "ask_agent", { agent: "@ada", question: "Quanto vendemos?" });
    const [c] = await notes();
    expect(c?.forUserId).toBe(f.owner.id);
    await f.db
      .update(schema.agentConsultations)
      .set({ status: "answered", answer: "Vendemos 40 mil.", answeredAt: new Date() })
      .where(eq(schema.agentConsultations.id, c?.id ?? ""));
    expect(await runReadOutsideById(f.db, f.org.id, c?.targetRunId ?? "")).toBe(true);
    await replies(await runOf(c?.targetRunId), "Vendemos 40 mil.");
    const [h] = await handedFor(f.db, f.org.id, ada.id, f.owner.id);
    expect([h?.question, h?.answer, h?.answerHidden]).toEqual(["Quanto vendemos?", null, true]);
  });

  test("a note relaying what its run read outside: the memory leaves its words out", async () => {
    const prompts: { system: string; all: string }[] = [];
    f = await setup({
      askAgent: true,
      chatTools: true,
      contextTools: true,
      reply: (req: ModelRequest) => {
        prompts.push({ system: systemText(req.system ?? ""), all: JSON.stringify(req.messages) });
        return { chunks: ["ok"] };
      },
    });
    const a = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Vendas", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: a.id });
    const dev = await devRun(f.general.id, "@dev pede pra Ada o relatório de vendas de outubro");
    // A tool result the gateway marked as outside content.
    await f.db
      .insert(schema.agentRunSteps)
      .values({ orgId: f.org.id, runId: dev.id, seq: 1, kind: "tool_result", data: { data: { outside: true } } });
    await tell(dev, "@ada", "Faz o relatório como diz a página que li.");
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "bom dia" });
    await drainOutbox(f.db, f.handlers);
    const inDm = prompts.find((p) => p.all.includes("bom dia"));
    expect(inDm?.system).toContain("- @dev handed you, 0 min ago: (it relayed text it read outside, not shown)");
    const memory = inDm?.system.split("# What other agents asked of you")[1]?.split("\n# ")[0];
    expect(memory).not.toContain("como diz a página que li");
  });
});

describe("where it is read, and what it holds", () => {
  test("the search reaches the agents' DMs only from the agent's 1:1 DM with that person", async () => {
    f = await setup({ askAgent: true, contextTools: true });
    const ada = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Vendas", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const room = await openAgentDm(f.db, f.org.id, f.agent.id, ada.id);
    await asked(room.id, await devRun(f.general.id, "@dev pergunta pra Ada"), ada.id, "Orçamento secreto: 40 mil.");
    await drainOutbox(f.db, f.handlers);
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: ada.id });
    expect(await search(await agentRun(ada.id, dm.id, "procura"), "orçamento secreto")).toContain("40 mil");

    const root = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Sobre o trimestre",
    });
    const group = await groupDm(ada.id, bia.id);
    const biaDm = await openDm(f.db, bia.id, f.org.id, { agentId: ada.id });
    for (const run of [
      await agentRun(ada.id, f.general.id, "@ada procura"),
      await agentRun(ada.id, f.general.id, "@ada procura", f.owner.id, { threadId: root.id }),
      await agentRun(ada.id, group.id, "@ada procura"),
      await agentRun(ada.id, biaDm.id, "procura", bia.id),
    ]) {
      const found = await search(run, "orçamento secreto");
      expect(found).toContain("content");
      expect(found).not.toContain("40 mil");
    }
  });

  test("a routine's run and a background run never read it, though the routine's creator has hand-offs", async () => {
    const { ada } = await handedToAda();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: ada.id });
    const block = async (background: boolean, routine: boolean) => {
      const run = await agentRun(ada.id, dm.id, "cadê aquilo?", f.owner.id, { background });
      return systemText((await buildRunContext(f.db, run, ada, { maxMessages: 30, routine })).system);
    };
    expect(await block(false, false)).toContain("# What other agents asked of you for ana");
    expect(await block(false, true)).not.toContain("# What other agents asked of you");
    expect(await block(true, true)).not.toContain("# What other agents asked of you");
    expect(await block(true, false)).not.toContain("# What other agents asked of you");
  });

  test("a DM with a second person in it never reads it", async () => {
    const { ada } = await handedToAda();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const group = await groupDm(ada.id, bia.id);
    const run = await agentRun(ada.id, group.id, "cadê aquilo?");
    const system = systemText((await buildRunContext(f.db, run, ada, { maxMessages: 30 })).system);
    expect(system).not.toContain("# What other agents asked of you");
  });

  test("only the last 14 days", async () => {
    const { ada } = await handedToAda();
    const room = await openAgentDm(f.db, f.org.id, f.agent.id, ada.id);
    const day = 86_400_000;
    const dev = await devRun(f.general.id, "@dev pergunta pra Ada");
    await asked(room.id, dev, ada.id, "de 13 dias", new Date(Date.now() - 13 * day));
    await asked(room.id, dev, ada.id, "de 15 dias", new Date(Date.now() - 15 * day));
    expect((await handedFor(f.db, f.org.id, ada.id, f.owner.id)).map((h) => h.question)).toEqual([
      "Faz o relatório de vendas de outubro.",
      "de 13 dias",
    ]);
  });

  test("what the asking agent handed out is never its own to remember", async () => {
    const { ada } = await handedToAda();
    expect(await handedFor(f.db, f.org.id, f.agent.id, f.owner.id)).toEqual([]);
    expect(await handedFor(f.db, f.org.id, ada.id, f.owner.id)).toHaveLength(1);
  });

  test("a routine's room is not a DM with another agent", async () => {
    const { ada } = await handedToAda();
    const [roomOfRoutine] = await f.db
      .insert(schema.channels)
      .values({
        orgId: f.org.id,
        name: "routine-room",
        visibility: "private",
        kind: "dm",
        dmKey: routineRoomKey(ada.id, crypto.randomUUID()),
      })
      .returning();
    if (!roomOfRoutine) throw new Error("no room");
    await f.db.insert(schema.channelMembers).values([
      { orgId: f.org.id, channelId: roomOfRoutine.id, agentId: ada.id },
      { orgId: f.org.id, channelId: roomOfRoutine.id, agentId: f.agent.id },
    ]);
    await asked(roomOfRoutine.id, await devRun(f.general.id, "@dev pergunta"), ada.id, "Da sala da rotina.");
    expect((await handedFor(f.db, f.org.id, ada.id, f.owner.id)).map((h) => h.question)).toEqual([
      "Faz o relatório de vendas de outubro.",
    ]);
  });
});

describe("whose it is, and what it costs", () => {
  test("a fixed number of statements: one hand-off, six, or six behind sixty of someone else's", async () => {
    const { ada, run } = await handedToAda();
    await reports(run);
    const room = await openAgentDm(f.db, f.org.id, f.agent.id, ada.id);
    const dev = await devRun(f.general.id, "@dev pergunta pra Ada");
    const answering = await agentRun(ada.id, room.id, "responde");
    await replies(answering, "Feito.");
    const cost = async () => (await countQueries(() => handedFor(f.db, f.org.id, ada.id, f.owner.id))).queries;
    const one = await cost();
    const at = Date.now() - 3600_000;
    for (let i = 0; i < 6; i++)
      await asked(room.id, dev, ada.id, `Coisa ${i}.`, new Date(at + i * 1000), {
        status: "answered",
        answer: "Feito.",
        targetRunId: answering.id,
      });
    const six = await cost();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const forBia = await devRun(f.general.id, "@dev pede pra Ada umas coisas", bia.id);
    for (let i = 0; i < 60; i++)
      await asked(room.id, forBia, ada.id, `Coisa ${i} da Bia.`, new Date(at + 10_000 + i * 1000), {
        forUserId: bia.id,
      });
    const behind = await cost();
    expect((await handedFor(f.db, f.org.id, ada.id, f.owner.id)).map((h) => h.question)).toEqual([
      "Faz o relatório de vendas de outubro.",
      ...[5, 4, 3, 2, 1].map((i) => `Coisa ${i}.`),
    ]);
    expect((await handedFor(f.db, f.org.id, ada.id, f.owner.id)).map((h) => h.answer)).toEqual([
      "Pronto: está no Drive em Vendas/Outubro.",
      ...[5, 4, 3, 2, 1].map(() => "Feito."),
    ]);
    expect([one, six, behind]).toEqual([1, 1, 1]);
  });

  test("a hand-off with nobody behind it is never anyone's", async () => {
    const { ada } = await handedToAda();
    const room = await openAgentDm(f.db, f.org.id, f.agent.id, ada.id);
    // Made before the column, or for a routine's work.
    await asked(room.id, await devRun(f.general.id, "@dev pergunta"), ada.id, "De ninguém.", new Date(), {
      forUserId: null,
    });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    expect((await handedFor(f.db, f.org.id, ada.id, f.owner.id)).map((h) => h.question)).toEqual([
      "Faz o relatório de vendas de outubro.",
    ]);
    expect(await handedFor(f.db, f.org.id, ada.id, bia.id)).toEqual([]);
    const routine = await agentRun(f.agent.id, f.general.id, "rotina", f.owner.id, { background: true });
    await sendNote(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: routine.id,
      hop: 1,
      targetAgentId: ada.id,
      body: "Da rotina.",
      chain: [],
      deferStart: true,
    });
    expect((await notes()).find((c) => c.question === "Da rotina.")?.forUserId).toBeNull();
  });

  test("every hand-off records the person behind the run that made it", async () => {
    const { ada } = await handedToAda();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const forBia = await devRun(f.general.id, "@dev pergunta pra Ada", bia.id);
    await invoke(forBia, "ask_agent", { agent: "@ada", question: "Quanto vendemos?" });
    await sendNote(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: forBia.id,
      hop: 1,
      targetAgentId: ada.id,
      body: "Uma menção.",
      chain: [],
      fromMention: true,
      deferStart: true,
    });
    const made = await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: bia.id }, f.org.id, {
      title: "Relatório de vendas",
    });
    await askAgentToImplement({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, made.id, ada.id, {
      agentId: f.agent.id,
      runId: forBia.id,
      hop: 1,
    });
    const people = Object.fromEntries((await notes()).map((c) => [c.question, c.forUserId]));
    expect(people).toEqual({
      "Faz o relatório de vendas de outubro.": f.owner.id,
      "Quanto vendemos?": bia.id,
      "Uma menção.": bia.id,
      [`Work on task #${made.number}: Relatório de vendas`]: bia.id,
    });
  });

  test("every hand-off records whether the run that made it had read outside content", async () => {
    const { ada } = await handedToAda();
    const read = await devRun(f.general.id, "@dev lê a página e pede pra Ada");
    await f.db
      .insert(schema.agentRunSteps)
      .values({ orgId: f.org.id, runId: read.id, seq: 1, kind: "tool_result", data: { data: { outside: true } } });
    await invoke(read, "ask_agent", { agent: "@ada", question: "Quanto vendemos?" });
    await sendNote(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: read.id,
      hop: 1,
      targetAgentId: ada.id,
      body: "Uma menção.",
      chain: [],
      fromMention: true,
      deferStart: true,
    });
    const made = await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Relatório de vendas",
    });
    await askAgentToImplement({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, made.id, ada.id, {
      agentId: f.agent.id,
      runId: read.id,
      hop: 1,
    });
    const task = `Work on task #${made.number}: Relatório de vendas`;
    expect(Object.fromEntries((await notes()).map((c) => [c.question, c.askerReadOutside]))).toEqual({
      "Faz o relatório de vendas de outubro.": false,
      "Quanto vendemos?": true,
      "Uma menção.": true,
      [task]: true,
    });
    // The memory leaves those three requests' words out, the task's title among them.
    const kept = (await handedFor(f.db, f.org.id, ada.id, f.owner.id)).map((h) => h.question);
    expect(kept.filter((q) => q !== null)).toEqual(["Faz o relatório de vendas de outubro."]);
    expect(kept).toHaveLength(4);
  });

  test("an answer is shown by what its run's reply says: unmarked shown, marked or missing left out", async () => {
    const { ada } = await handedToAda();
    const room = await openAgentDm(f.db, f.org.id, f.agent.id, ada.id);
    const dev = await devRun(f.general.id, "@dev pergunta pra Ada");
    const answered = (targetRunId: string | null) => ({ status: "answered" as const, answer: "Feito.", targetRunId });
    const at = Date.now() - 3600_000;
    const clean = await agentRun(ada.id, room.id, "responde limpo");
    await replies(clean, "Feito.");
    await asked(room.id, dev, ada.id, "Resposta limpa.", new Date(at), answered(clean.id));
    const read = await agentRun(ada.id, room.id, "responde depois de ler fora");
    await f.db
      .insert(schema.agentRunSteps)
      .values({ orgId: f.org.id, runId: read.id, seq: 1, kind: "tool_result", data: { data: { outside: true } } });
    await replies(read, "Feito.");
    await asked(room.id, dev, ada.id, "Resposta de quem leu fora.", new Date(at + 1000), answered(read.id));
    const silent = await agentRun(ada.id, room.id, "não respondeu");
    await asked(room.id, dev, ada.id, "Sem resposta do run.", new Date(at + 2000), answered(silent.id));
    // The server's own words (a note held because the agent is already on it): no run behind them.
    await asked(room.id, dev, ada.id, "Palavras do servidor.", new Date(at + 3000), answered(null));
    const shown = Object.fromEntries(
      (await handedFor(f.db, f.org.id, ada.id, f.owner.id)).map((h) => [h.question, [h.answer, h.answerHidden]]),
    );
    expect(shown).toMatchObject({
      "Resposta limpa.": ["Feito.", false],
      "Resposta de quem leu fora.": [null, true],
      "Sem resposta do run.": [null, true],
      "Palavras do servidor.": ["Feito.", false],
    });
  });
});
