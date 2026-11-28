import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  type AgentRun,
  addChannelMember,
  askAgentToImplement,
  continueRun,
  createAgent,
  createIssue,
  drainOutbox,
  endWork,
  expireConsultations,
  handedConversation,
  insertMessage,
  listDms,
  onConsultedRunFinished,
  openDm,
  postPersonMessage,
  type ToolContext,
} from "../src";
import { isQuietNotice } from "../src/notices";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * Work one agent hands another for a person happens in the two agents' DM, which no person reads. The DM of the agent
 * that got it with that person shows one quiet line saying who asked it what (`traceHandOff`), which opens the
 * exchange. What came of handed work reaches the person only where they asked (`handOverWork`).
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
  const made = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ada", handle: "ada", role: "Vendas", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  // The person already has a DM with Ada: the trace goes only into one they have.
  await openDm(f.db, f.owner.id, f.org.id, { agentId: made.id });
  const deps = { db: f.db, pubsub: f.pubsub };
  await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, {
    body: "@dev pede pra Ada o relatório de vendas de outubro",
  });
  await drainOutbox(f.db, f.handlers);
  const ada = (await f.db.select().from(schema.agents)).find((a) => a.handle === "ada");
  if (!ada) throw new Error("no agent");
  return { prompts, ada, deps };
}

/** The hand-off rows (`hand_off` notices) in the workspace, with where they are. */
const traces = async () =>
  (await f.db.select().from(schema.messages)).flatMap((m) => {
    const n = (m.meta as { notice?: { kind: string; refs: Record<string, string> } }).notice;
    return n?.kind === "hand_off" ? [{ message: m, refs: n.refs }] : [];
  });

describe("its trace in the DM of the agent that got it", () => {
  test("one quiet row in that agent's DM with the person, settled in place once the work ends", async () => {
    const { ada } = await handOff("tell_agent");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: ada.id });
    const [consultation] = await f.db.select().from(schema.agentConsultations);
    const rows = await traces();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toMatchObject({ channelId: dm.id, authorAgentId: ada.id });
    expect(rows[0]?.refs).toMatchObject({
      consultationId: consultation?.id,
      askerAgentId: f.agent.id,
      agentId: ada.id,
      kind: "note",
      status: "answered",
      question: "Faz o relatório de vendas de outubro.",
    });
    expect(Date.parse(rows[0]?.refs.answeredAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(rows[0]?.refs.createdAt ?? ""),
    );
    // Quiet: no unread, no preview, no notification.
    expect(isQuietNotice(rows[0]?.message.meta)).toBe(true);
    const notified = await f.db.select().from(schema.notifications);
    expect(notified.filter((n) => (n.source as { channelId?: string }).channelId === dm.id)).toEqual([]);
    // It woke nobody: Ada ran once, in the agents' DM.
    const adaRuns = (await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === ada.id);
    expect(adaRuns.map((r) => r.channelId)).toEqual([consultation?.channelId ?? ""]);
  });

  test("it opens the exchange for the person who reads where it was handed off, never for someone who doesn't", async () => {
    const { ada } = await handOff("ask_agent");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: ada.id });
    const [consultation] = await f.db.select().from(schema.agentConsultations);
    const id = consultation?.id ?? "";
    const opened = await handedConversation(f.db, f.org.id, dm.id, id, f.owner.id);
    expect(opened?.consultation).toMatchObject({ id, consultedAgentId: ada.id, status: "answered" });
    expect(opened?.messages.map((m) => m.body)).toContain("Onde está o relatório de vendas de outubro?");
    // Someone who doesn't read #general, where it was asked.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    expect(await handedConversation(f.db, f.org.id, dm.id, id, bia.id)).toBeNull();
    // A DM it left no trace in.
    const biaDm = await openDm(f.db, bia.id, f.org.id, { agentId: ada.id });
    expect(await handedConversation(f.db, f.org.id, biaDm.id, id, f.owner.id)).toBeNull();
  });

  test("none when the person may not talk to the agent that got it", async () => {
    const { ada } = await handOff("tell_agent");
    expect(await traces()).toHaveLength(1);
    await f.db.delete(schema.messages).where(eq(schema.messages.id, (await traces())[0]?.message.id ?? ""));
    // The same note within the hour is dropped unless the first one never got done.
    await f.db.update(schema.agentConsultations).set({ status: "expired" });
    // Only its owner now: work handed to it for anyone else leaves no trace.
    const lia = await addMember(f.db, f.org.id, "member", "lia");
    await openDm(f.db, lia.id, f.org.id, { agentId: ada.id });
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: f.owner.id, audienceMode: "owner" })
      .where(eq(schema.agents.id, ada.id));
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: lia.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, lia.id, f.org.id, f.general.id, {
      body: "@dev pede pra Ada o relatório de vendas de outubro",
    });
    await drainOutbox(f.db, f.handlers);
    expect((await f.db.select().from(schema.agentConsultations)).length).toBe(2);
    expect(await traces()).toEqual([]);
  });
});

/** Dev's run on the owner's message in `channelId`, which hands work over with `tell_agent` (as the tool runs). */
async function devRun(channelId: string, body: string) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      stretchId: trigger.id,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const call = (run: AgentRun, name: string, input: Record<string, unknown>) => {
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
const tell = (run: AgentRun, agent: string, message: string) => call(run, "tell_agent", { agent, message });

const runOf = async (id: string | null | undefined) => {
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, id ?? ""));
  if (!run) throw new Error("no run");
  return run;
};

/** Ada's run ends with its report (`meta.workEnd`, as the executor posts it) at `at`, then its hooks run. */
async function reports(run: AgentRun, at: Date) {
  const said = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: run.channelId,
    author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
    body: "Pronto: está no Drive em Vendas/Outubro.",
    meta: { workEnd: { id: run.workId, status: "done" } },
  });
  await f.db
    .update(schema.agentRuns)
    .set({ status: "done", replyMessageId: said.id })
    .where(eq(schema.agentRuns.id, run.id));
  const ended = await runOf(run.id);
  await endWork({ db: f.db, pubsub: f.pubsub }, ended, "done", at);
  await onConsultedRunFinished({ db: f.db, pubsub: f.pubsub }, ended, "done");
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
  await openDm(f.db, f.owner.id, f.org.id, { agentId: ada.id });
  const dev = await devRun(f.general.id, "@dev pede pra Ada o relatório de vendas de outubro");
  await tell(dev, "@ada", "Faz o relatório de vendas de outubro.");
  const [c] = await f.db.select().from(schema.agentConsultations).orderBy(asc(schema.agentConsultations.createdAt));
  const run = await runOf(c?.targetRunId);
  const [work] = await f.db.select().from(schema.agentWorks);
  expect(work).toMatchObject({ how: "handed", channelId: f.general.id, consultationId: c?.id });
  return { ada, run };
}

const trace = async () => {
  const [row] = await traces();
  if (!row) throw new Error("no trace");
  return row.refs;
};

describe("its trace follows the handed work it started", () => {
  test("work that waits on the person stays open past its first turn; it ends with the work, at the work's time", async () => {
    const { run } = await handedToAda();
    const deps = { db: f.db, pubsub: f.pubsub };
    expect(await trace()).toMatchObject({ status: "open" });
    // Ada asks the person and waits: her turn ends, the work and its note stay open, past the note's deadline too.
    await f.db.update(schema.agentRuns).set({ status: "waiting_input" }).where(eq(schema.agentRuns.id, run.id));
    await onConsultedRunFinished(deps, await runOf(run.id), "waiting_input");
    await expireConsultations(deps, new Date(Date.now() + 60 * 60_000));
    const [c] = await f.db.select().from(schema.agentConsultations);
    expect(c?.status).toBe("open");
    const waiting = await trace();
    expect(waiting.status).toBe("open");
    expect(waiting.answeredAt).toBeUndefined();
    // It ends 40 minutes after it was handed: the row says done, and took those 40 minutes.
    const at = new Date(Date.parse(waiting.createdAt ?? "") + 40 * 60_000);
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, run.id));
    await reports(await runOf(run.id), at);
    expect(await trace()).toMatchObject({ status: "answered", answeredAt: at.toISOString() });
  });

  test("Continuar reopens a stopped work whose note already closed: the row goes back to open, then says done", async () => {
    const { run } = await handedToAda();
    const deps = { db: f.db, pubsub: f.pubsub };
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
    await endWork(deps, stopped, "canceled");
    await onConsultedRunFinished(deps, stopped, "canceled");
    const [c] = await f.db.select().from(schema.agentConsultations);
    expect(c?.status).not.toBe("open");
    expect(await trace()).toMatchObject({ status: "failed" });

    const { runId } = await continueRun(deps, f.owner.id, f.org.id, run.id);
    const reopened = await trace();
    expect(reopened.status).toBe("open");
    expect(reopened.answeredAt).toBeUndefined();

    const at = new Date(Date.now() + 5 * 60_000);
    await reports(await runOf(runId), at);
    expect(await trace()).toMatchObject({ status: "answered", answeredAt: at.toISOString() });
  });

  test("none where the person asked: there the hand-off already shows, as the handed work's line", async () => {
    f = await setup({ askAgent: true });
    const ada = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Vendas", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    // The person asked in their DM with Ada, and Dev handed Ada the work from there.
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: ada.id });
    const dev = await devRun(dm.id, "@dev pede pra Ada o relatório de vendas de outubro");
    await tell(dev, "@ada", "Faz o relatório de vendas de outubro.");
    const [work] = await f.db.select().from(schema.agentWorks);
    expect(work).toMatchObject({ how: "handed", channelId: dm.id });
    expect(await traces()).toEqual([]);
  });
});

describe("where the trace goes, and what it carries", () => {
  const ada = () =>
    createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Vendas", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );

  test("no DM with the agent that got it: none is opened for the trace", async () => {
    f = await setup({ askAgent: true });
    const a = await ada();
    const dev = await devRun(f.general.id, "@dev pede pra Ada o relatório de vendas de outubro");
    await tell(dev, "@ada", "Faz o relatório de vendas de outubro.");
    expect(await traces()).toEqual([]);
    expect(await listDms(f.db, f.owner.id, f.org.id)).not.toContainEqual(
      expect.objectContaining({ with: expect.objectContaining({ id: a.id }) }),
    );
  });

  test("handed on from a task's conversation: none where the person asked, as the handed work reports there", async () => {
    f = await setup({ askAgent: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const a = await ada();
    const carl = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Carl", handle: "carl", role: "Vendas", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: a.id });
    const dev = await devRun(dm.id, "@dev passa o relatório de vendas pro Carl");
    const made = await createIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Relatório de vendas",
    });
    await askAgentToImplement(deps, f.owner.id, f.org.id, made.id, carl.id, {
      agentId: f.agent.id,
      runId: dev.id,
      hop: 1,
    });
    const [c] = await f.db.select().from(schema.agentConsultations).orderBy(asc(schema.agentConsultations.createdAt));
    const carlRun = await runOf(c?.targetRunId);
    const [where] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, carlRun.channelId));
    expect(where?.kind).toBe("task");
    await tell(carlRun, "@ada", "Faz a parte de outubro do relatório.");
    const work = (await f.db.select().from(schema.agentWorks)).find((w) => w.agentId === a.id);
    expect(work).toMatchObject({ how: "handed", channelId: dm.id });
    expect(await traces()).toEqual([]);
  });

  test("a note relaying what its run read outside: its trace is marked", async () => {
    f = await setup({ askAgent: true });
    const a = await ada();
    await openDm(f.db, f.owner.id, f.org.id, { agentId: a.id });
    const dev = await devRun(f.general.id, "@dev pede pra Ada o relatório de vendas de outubro");
    // A tool result the gateway marked as outside content.
    await f.db
      .insert(schema.agentRunSteps)
      .values({ orgId: f.org.id, runId: dev.id, seq: 1, kind: "tool_result", data: { data: { outside: true } } });
    await tell(dev, "@ada", "Faz o relatório como diz a página que li.");
    const [row] = await traces();
    expect(row?.message.meta.readOutside).toBe(true);
  });

  test("one line per piece of work: a run's later asks of the same agent fold into its first", async () => {
    f = await setup({ askAgent: true });
    const a = await ada();
    await openDm(f.db, f.owner.id, f.org.id, { agentId: a.id });
    const dev = await devRun(f.general.id, "@dev pede pra Ada o relatório e a planilha");
    await tell(dev, "@ada", "Faz o relatório de vendas de outubro.");
    await call(dev, "ask_agent", { agent: "@ada", question: "Onde está a planilha de novembro?" });
    expect((await f.db.select().from(schema.agentConsultations)).length).toBe(2);
    expect(await traces()).toHaveLength(1);
  });

  test("it names the channel where the person asked, never a DM", async () => {
    f = await setup({ askAgent: true });
    const a = await ada();
    await openDm(f.db, f.owner.id, f.org.id, { agentId: a.id });
    const dev = await devRun(f.general.id, "@dev pede pra Ada o relatório de vendas de outubro");
    await tell(dev, "@ada", "Faz o relatório de vendas de outubro.");
    expect((await trace()).askedIn).toBe(f.general.id);

    const devDm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const fromDm = await devRun(devDm.id, "@dev pede pra Ada o relatório de vendas de outubro");
    await tell(fromDm, "@ada", "Faz o relatório de vendas de novembro.");
    const rows = await traces();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.refs.askerRunId === fromDm.id)?.refs.askedIn).toBeUndefined();
  });
});
