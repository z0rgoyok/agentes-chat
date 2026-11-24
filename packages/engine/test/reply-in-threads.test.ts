import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema, sql } from "@agenteschat/db";
import { runMigration } from "@agenteschat/db/testing";
import { type ModelRequest, ProviderError } from "@agenteschat/providers";
import {
  activeRunsIn,
  addChannelMember,
  answerNow,
  cancelRun,
  continueRun,
  createAgent,
  createAgentRuns,
  createChannel,
  createJobHandlers,
  deliverNoticeToRun,
  drainOutbox,
  EARLY_CHECK_JOB,
  getMessage,
  getThread,
  type Message,
  openDm,
  postPersonMessage,
  refusedAtLimit,
  replyThreadOf,
  restartAfterStopAndSend,
  STRETCH,
  scheduleParkedChecks,
  stretchCardOf,
  type ToolSource,
  updateChannel,
  wakeConversationForTask,
  wakeForAccessDecision,
} from "../src";
import type { Transcript } from "../src/executor";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * A channel that replies in threads (ADR 0214): an agent called in its main timeline answers in the thread under that
 * message, whatever it posts there, and the channel shows one line for it.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const say = (body: string, options: { userId?: string; channelId?: string; threadId?: string } = {}) =>
  postPersonMessage(deps(), options.userId ?? f.owner.id, f.org.id, options.channelId ?? f.general.id, {
    body,
    ...(options.threadId ? { threadId: options.threadId } : {}),
  });
const threadsOn = (on = true, channelId = f.general.id) =>
  updateChannel(f.db, f.owner.id, f.org.id, channelId, { replyInThreads: on });
const runs = () => f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
const postsOf = async (agentId = f.agent.id) =>
  (await f.db.select().from(schema.messages).orderBy(schema.messages.createdAt)).filter(
    (m) => m.authorAgentId === agentId,
  );
const threadRow = async (rootId: string) =>
  (await f.db.select().from(schema.threads).where(eq(schema.threads.rootMessageId, rootId)))[0];
const asked = (req: ModelRequest, words: string) => JSON.stringify(req.messages).includes(words);
const called = (req: ModelRequest, tool: string) => JSON.stringify(req.messages).includes(`"name":"${tool}"`);
/** @dev looks at the stores twice: with `maxToolTurns: 2` its run stops at its step limit, which Continuar goes on from. */
const lookingTwice = () =>
  setup({
    toolSources: [
      {
        name: "work",
        tools: async () => [
          {
            name: "look",
            description: "Look at the stores",
            scope: "context:read",
            inputSchema: { type: "object", properties: {} },
            execute: async () => ({ content: "3 lojas" }),
          },
        ],
      } satisfies ToolSource,
    ],
    reply: (_req, n) =>
      n <= 2 ? { chunks: ["Olhando."], toolUses: [{ name: "look", input: {} }] } : { chunks: ["Pronto."] },
  });
/** The run waits on its budget (a catch-up): it takes the next messages of its conversation. */
const waitOnBudget = (runId: string) =>
  f.db
    .update(schema.agentRuns)
    .set({ status: "waiting_input", transcript: sql`'{"waitingForBrain":{"code":"budget"}}'::jsonb` })
    .where(eq(schema.agentRuns.id, runId));

async function addOps() {
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    {
      name: "Ops",
      handle: "ops",
      role: "Operations",
      instructions: "You run operations.",
      credentialId: f.credential.id,
    },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
  return ops;
}

test("asked in the main timeline: the reply goes under the message, which stays put, and opens its thread", async () => {
  f = await setup({ reply: () => ({ chunks: ["Conferi as lojas."] }) });
  await threadsOn();
  const asking = await say("@dev confere as lojas");
  await drainOutbox(f.db, f.handlers);

  const [run] = await runs();
  expect(run).toMatchObject({ threadRootId: asking.id, triggerMessageId: asking.id, replyInThread: true });
  const [reply] = await postsOf();
  expect(reply).toMatchObject({ body: "Conferi as lojas.", threadId: asking.id });
  const [root] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, asking.id));
  expect(root?.threadId).toBeNull();
  const opened = await threadRow(asking.id);
  expect(opened?.openedByReplyAt?.getTime()).toBe(reply?.createdAt.getTime() as number);
  const view = await getThread(f.db, f.owner.id, f.org.id, asking.id);
  expect(view).toMatchObject({ replyCount: 1, openedByReplyAt: reply?.createdAt.toISOString() });
});

test("off: the reply stays in the main timeline and no thread opens", async () => {
  f = await setup({ reply: () => ({ chunks: ["Conferi."] }) });
  const asking = await say("@dev confere as lojas");
  await drainOutbox(f.db, f.handlers);

  const [run] = await runs();
  expect(run?.replyInThread).toBe(false);
  const [reply] = await postsOf();
  expect(reply?.threadId).toBeNull();
  expect(await threadRow(asking.id)).toBeUndefined();
});

test("on by default: existing and new channels reply in threads, a DM never does", async () => {
  f = await setup({ reply: () => ({ chunks: ["Conferi."] }) });
  const dmBefore = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  // Test databases keep the old default (packages/db/test/pglite.ts); the migration sets production's.
  await runMigration(f.db, "channels_reply_in_threads_by_default");
  const row = async (id: string) => (await f.db.select().from(schema.channels).where(eq(schema.channels.id, id)))[0];
  expect((await row(f.general.id))?.replyInThreads).toBe(true);
  expect((await row(dmBefore.id))?.replyInThreads).toBe(false);

  const vendas = await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas" });
  expect(vendas.replyInThreads).toBe(true);
  await addChannelMember(f.db, f.owner.id, f.org.id, vendas.id, { agentId: f.agent.id });
  const asking = await say("@dev confere as lojas", { channelId: vendas.id });
  await drainOutbox(f.db, f.handlers);
  expect((await postsOf()).at(-1)).toMatchObject({ channelId: vendas.id, threadId: asking.id });

  await threadsOn(false, vendas.id);
  expect((await row(vendas.id))?.replyInThreads).toBe(false);

  await say("oi", { channelId: dmBefore.id });
  await drainOutbox(f.db, f.handlers);
  expect((await postsOf()).at(-1)).toMatchObject({ channelId: dmBefore.id, threadId: null });
});

test("its cards, files, question cards and live events land in the thread too", async () => {
  f = await setup({
    blockTools: true,
    artifactTools: true,
    askUser: true,
    reply: (req) => {
      if (asked(req, "pergunta") && !called(req, "ask_user"))
        return {
          chunks: [],
          toolUses: [
            {
              name: "ask_user",
              input: { why: "Há três lojas abertas e cada uma tem um estoque diferente.", question: "Qual loja?" },
            },
          ],
        };
      if (asked(req, "pergunta")) return { chunks: ["Anotado."] };
      if (!called(req, "show_block"))
        return {
          chunks: [],
          toolUses: [
            {
              name: "show_block",
              input: { title: "Lojas", spec: { parts: [{ type: "stat", label: "Abertas", value: "3" }] } },
            },
          ],
        };
      if (!called(req, "create_artifact"))
        return {
          chunks: [],
          toolUses: [{ name: "create_artifact", input: { title: "Lojas", kind: "document", markdown: "# 3 abertas" } }],
        };
      return { chunks: ["Pronto."] };
    },
  });
  await threadsOn();
  const events = f.listen(f.general.id);
  const board = await say("@dev monta o quadro das lojas");
  await drainOutbox(f.db, f.handlers);
  const [reply] = await postsOf();
  expect(reply).toMatchObject({ body: "Pronto.", threadId: board.id });
  expect(reply?.meta.artifacts).toHaveLength(2);
  const live = events.filter((e) => e.type === "agent.thinking" || e.type === "agent.idle");
  expect(live.length).toBeGreaterThan(0);
  expect(live.every((e) => (e as { threadId?: string | null }).threadId === board.id)).toBe(true);

  const question = await say("@dev me pergunta qual loja");
  await drainOutbox(f.db, f.handlers);
  const [q] = await f.db.select().from(schema.agentQuestions);
  expect(q?.threadId).toBe(question.id);
  const [card] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, q?.messageId as string));
  expect(card?.threadId).toBe(question.id);
});

test("turning it off or on while a run waits never moves that run", async () => {
  f = await setup({ reply: () => ({ chunks: ["Feito."] }) });
  await threadsOn();
  const first = await say("@dev primeira");
  await threadsOn(false);
  await drainOutbox(f.db, f.handlers);
  expect((await postsOf()).at(-1)?.threadId).toBe(first.id);

  const second = await say("@dev segunda");
  await threadsOn();
  await drainOutbox(f.db, f.handlers);
  const last = (await postsOf()).at(-1);
  expect(last?.threadId).toBeNull();
  expect((await runs()).find((r) => r.triggerMessageId === second.id)?.replyInThread).toBe(false);
});

test("@dev @ops in the main timeline: both answer in the same thread under it", async () => {
  f = await setup({ reply: () => ({ chunks: ["Comigo."] }) });
  const ops = await addOps();
  await threadsOn();
  const asking = await say("@dev @ops quem cuida do deploy?");
  await drainOutbox(f.db, f.handlers);

  const started = await runs();
  expect(started.map((r) => [r.agentId, r.threadRootId, r.replyInThread]).sort()).toEqual(
    [
      [f.agent.id, asking.id, true],
      [ops.id, asking.id, true],
    ].sort(),
  );
  const replies = [...(await postsOf()), ...(await postsOf(ops.id))];
  expect(replies).toHaveLength(2);
  expect(replies.every((m) => m.threadId === asking.id)).toBe(true);
});

test("the same person's next message in the main timeline joins the run; someone else's call gets its own thread", async () => {
  f = await setup({ reply: () => ({ chunks: ["Certo."] }) });
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await threadsOn();
  const asking = await say("@dev confere as lojas");
  const [run] = await runs();
  await say("e a de Olinda também");
  await say("@dev e o estoque");
  const other = await say("@dev qual o horário de hoje?", { userId: bia.id });

  const after = await runs();
  expect(after).toHaveLength(2);
  expect(after.find((r) => r.id === run?.id)?.pendingMessageIds).toHaveLength(2);
  expect(after.find((r) => r.id !== run?.id)).toMatchObject({ threadRootId: other.id, replyInThread: true });
  await drainOutbox(f.db, f.handlers);
  const threads = new Set((await postsOf()).map((m) => m.threadId));
  expect(threads).toEqual(new Set([asking.id, other.id]));
});

test("in a thread it works as before; a DM never replies in threads", async () => {
  f = await setup({ reply: () => ({ chunks: ["Ok."] }) });
  await threadsOn();
  const root = await say("raiz sem agente");
  await say("@dev olha isso", { threadId: root.id });
  await drainOutbox(f.db, f.handlers);
  const [inThread] = await runs();
  expect(inThread).toMatchObject({ threadRootId: root.id, replyInThread: false });
  expect((await postsOf()).at(-1)?.threadId).toBe(root.id);

  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await expect(threadsOn(true, dm.id)).rejects.toThrow();
  await say("oi", { channelId: dm.id });
  await drainOutbox(f.db, f.handlers);
  const inDm = (await postsOf()).at(-1);
  expect(inDm).toMatchObject({ channelId: dm.id, threadId: null });
});

test("a post to another channel stays at its top level; a run started on it answers under it", async () => {
  f = await setup({
    chatTools: true,
    reply: (req) => {
      if (asked(req, "avisa no #lojas") && !called(req, "post_message"))
        return { chunks: [], toolUses: [{ name: "post_message", input: { channel: "lojas", text: "Loja aberta." } }] };
      return { chunks: ["Feito."] };
    },
  });
  const ops = await addOps();
  const lojas = await createChannel(f.db, f.owner.id, f.org.id, { name: "lojas", visibility: "public" });
  await addChannelMember(f.db, f.owner.id, f.org.id, lojas.id, { agentId: f.agent.id });
  await addChannelMember(f.db, f.owner.id, f.org.id, lojas.id, { agentId: ops.id });
  await threadsOn(true, lojas.id);
  await say("@dev avisa no #lojas que abriu");
  await drainOutbox(f.db, f.handlers);
  const post = (await postsOf()).find((m) => m.channelId === lojas.id);
  expect(post).toMatchObject({ body: "Loja aberta.", threadId: null });

  // The router (or a routine's report, or a hand-on) starts a run on that post: it answers in the post's thread.
  await f.db.transaction((tx) => createAgentRuns(tx, post as NonNullable<typeof post>, [ops.id], "router"));
  await drainOutbox(f.db, f.handlers);
  const run = (await runs()).find((r) => r.agentId === ops.id);
  expect(run).toMatchObject({ threadRootId: post?.id as string, replyInThread: true });
  expect((await postsOf(ops.id)).at(-1)).toMatchObject({ channelId: lojas.id, threadId: post?.id as string });
});

test("move_here is refused to a run that replies in its thread, and to a channel that replies in threads", async () => {
  f = await setup({
    chatTools: true,
    reply: (req) =>
      asked(req, "continue") && !called(req, "post_message")
        ? {
            chunks: [],
            toolUses: [{ name: "post_message", input: { channel: "lojas", text: "Sigo aqui.", move_here: true } }],
          }
        : { chunks: ["Fico por aqui."] },
  });
  const lojas = await createChannel(f.db, f.owner.id, f.org.id, { name: "lojas", visibility: "public" });
  await addChannelMember(f.db, f.owner.id, f.org.id, lojas.id, { agentId: f.agent.id });
  await threadsOn();
  const asking = await say("@dev continue no #lojas");
  await drainOutbox(f.db, f.handlers);

  const results = (await f.db.select().from(schema.agentRunSteps))
    .filter((s) => s.kind === "tool_result")
    .map((s) => s.data as { content: string; isError?: boolean });
  expect(results.at(-1)?.isError).toBe(true);
  expect(results.at(-1)?.content).toContain("this work stays in the thread under the message that asked you");
  const [run] = await runs();
  expect(run).toMatchObject({ channelId: f.general.id, threadRootId: asking.id });
  expect((await postsOf()).filter((m) => m.channelId === lojas.id)).toEqual([]);

  await threadsOn(false);
  await threadsOn(true, lojas.id);
  await say("@dev continue no #lojas, de novo");
  await drainOutbox(f.db, f.handlers);
  const again = (await f.db.select().from(schema.agentRunSteps))
    .filter((s) => s.kind === "tool_result")
    .map((s) => s.data as { content: string; isError?: boolean })
    .at(-1);
  expect(again?.isError).toBe(true);
  expect(again?.content).toContain("Agents reply in threads in #lojas");
});

test("Continuar on a reply asked before the channel replied in threads goes on where that run was born", async () => {
  f = await lookingTwice();
  const handlers = createJobHandlers({ ...f.jobDeps, maxToolTurns: 2 });
  await say("@dev olha as lojas");
  await drainOutbox(f.db, handlers);
  const [stopped] = await runs();
  const [capped] = await postsOf();
  expect(capped?.meta.stepLimit).toBeDefined();

  await threadsOn();
  const { runId } = await continueRun(deps(), f.owner.id, f.org.id, stopped?.id as string);
  await drainOutbox(f.db, handlers);
  const [next] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  expect(next?.replyInThread).toBe(false);
  const last = (await postsOf()).at(-1);
  expect(last).toMatchObject({ agentRunId: runId, threadId: null });
});

/** A computer brain's run (Claude Code): its turn can't be cut halfway, so "Parar e mandar" stops it. */
const onComputer = (runId: string) =>
  f.db.update(schema.agentRuns).set({ status: "running", brain: "claude_code" }).where(eq(schema.agentRuns.id, runId));
const runOf = async (runId: string | null | undefined) =>
  (await runs()).find((r) => r.id === runId) as NonNullable<Awaited<ReturnType<typeof runs>>[number]>;

for (const on of [false, true]) {
  test(`"Parar e mandar" from the main timeline goes on where the stopped run answers (${on ? "on" : "off"})`, async () => {
    f = await setup();
    if (on) await threadsOn();
    const asking = await say("@dev analisa os logs");
    const [run] = await runs();
    await onComputer(run?.id as string);
    const said = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, {
      body: "na verdade só os 3 primeiros",
      steer: "now",
    });
    const stopped = await runOf(run?.id);
    expect(stopped.status).toBe("canceled");

    const events = f.listen(f.general.id);
    const next = await restartAfterStopAndSend(deps(), stopped.id, { id: null, threadId: replyThreadOf(stopped) }, {
      system: "",
      messages: [],
      postedUpTo: 0,
      postedCount: 0,
    } as unknown as Transcript);
    const restarted = await runOf(next);
    expect(restarted).toMatchObject({ triggerMessageId: said.id, replyInThread: on });
    expect(replyThreadOf(restarted)).toBe(on ? asking.id : null);
    const thinking = events.find((e) => e.type === "agent.thinking" && "runId" in e && e.runId === next);
    expect((thinking as { threadId?: string | null } | undefined)?.threadId).toBe(on ? asking.id : null);
  });
}

for (const on of [false, true]) {
  test(`a follow-up handed on by a stop is answered where the request was (${on ? "on" : "off"})`, async () => {
    f = await setup({ reply: () => ({ chunks: ["Respondi."] }) });
    if (on) await threadsOn();
    const asking = await say("@dev confere as lojas");
    const follow = await say("e a de Olinda também");
    const [run] = await runs();
    expect(run?.pendingMessageIds).toEqual([follow.id]);

    await cancelRun(deps(), f.owner.id, f.org.id, run?.id as string);
    await drainOutbox(f.db, f.handlers);
    const handed = (await runs()).find((r) => r.id !== run?.id);
    expect(handed).toMatchObject({ triggerMessageId: follow.id, replyInThread: on });
    const answer = (await postsOf()).find((m) => m.agentRunId === handed?.id);
    expect(answer?.body).toBe("Respondi.");
    expect(answer?.threadId).toBe(on ? asking.id : null);
  });
}

for (const on of [false, true]) {
  test(`two follow-ups handed on by a stop both reach the run that answers them (${on ? "on" : "off"})`, async () => {
    const requests: ModelRequest[] = [];
    f = await setup({
      reply: (req) => {
        requests.push(req);
        return { chunks: ["Feito."] };
      },
    });
    if (on) await threadsOn();
    await say("@dev confere as lojas");
    const first = await say("inclui a unidade de Olinda, código X5719");
    const second = await say("usa o estoque de ontem, código Y9374");
    const [run] = await runs();
    expect(run?.pendingMessageIds).toEqual([first.id, second.id]);

    await cancelRun(deps(), f.owner.id, f.org.id, run?.id as string);
    await drainOutbox(f.db, f.handlers);
    expect(requests).toHaveLength(1);
    expect([asked(requests[0] as ModelRequest, "X5719"), asked(requests[0] as ModelRequest, "Y9374")]).toEqual([
      true,
      true,
    ]);
  });
}

test("turned on after a run was asked: its follow-up, handed on by a stop, still answers in the main timeline", async () => {
  f = await setup({ reply: () => ({ chunks: ["Respondi."] }) });
  await say("@dev confere as lojas");
  const follow = await say("e a de Olinda também");
  const [run] = await runs();
  expect(run).toMatchObject({ replyInThread: false, pendingMessageIds: [follow.id] });

  await threadsOn();
  await cancelRun(deps(), f.owner.id, f.org.id, run?.id as string);
  await drainOutbox(f.db, f.handlers);
  const handed = (await runs()).find((r) => r.id !== run?.id);
  expect(handed?.replyInThread).toBe(false);
  const answer = (await postsOf()).find((m) => m.agentRunId === handed?.id);
  expect(answer?.body).toBe("Respondi.");
  expect(answer?.threadId).toBeNull();
});

for (const on of [false, true]) {
  test(`after Continuar, the same person's next call in the main timeline joins the continued run (${on ? "on" : "off"})`, async () => {
    f = await lookingTwice();
    if (on) await threadsOn();
    const asking = await say("@dev olha as lojas");
    await drainOutbox(f.db, createJobHandlers({ ...f.jobDeps, maxToolTurns: 2 }));
    const [stopped] = await runs();
    const { runId } = await continueRun(deps(), f.owner.id, f.org.id, stopped?.id as string);

    const next = await say("@dev e confere o estoque também");
    expect(await runs()).toHaveLength(2);
    expect(await runOf(runId)).toMatchObject({ pendingMessageIds: [next.id], replyInThread: on });
    expect(replyThreadOf(await runOf(runId))).toBe(on ? asking.id : null);
  });
}

test("after Continuar, the asker's next message in the main timeline without @ joins the continued run", async () => {
  f = await lookingTwice();
  await threadsOn();
  await say("@dev olha as lojas");
  await drainOutbox(f.db, createJobHandlers({ ...f.jobDeps, maxToolTurns: 2 }));
  const [stopped] = await runs();
  const { runId } = await continueRun(deps(), f.owner.id, f.org.id, stopped?.id as string);

  // Its trigger is @dev's reply now; the thread's root still names who asked.
  const floor = await say("e confere o estoque também");
  expect(await runs()).toHaveLength(2);
  expect((await runOf(runId)).pendingMessageIds).toEqual([floor.id]);
});

for (const on of [false, true]) {
  test(`"@dev @ops" while @dev still works on the same person's earlier ask (${on ? "on" : "off"})`, async () => {
    f = await setup({ reply: () => ({ chunks: ["Comigo."] }) });
    const ops = await addOps();
    if (on) await threadsOn();
    const first = await say("@dev confere as lojas");
    const both = await say("@dev @ops quem cuida do deploy?");
    await drainOutbox(f.db, f.handlers);

    const placed = (await runs()).map((r) => [r.agentId, r.threadRootId, replyThreadOf(r)]);
    const answers = [...(await postsOf()), ...(await postsOf(ops.id))].map((m) => [m.authorAgentId, m.threadId]);
    if (on) {
      // Every agent the message calls answers in the thread under it; the earlier ask keeps its own.
      expect(placed.sort()).toEqual(
        [
          [f.agent.id, first.id, first.id],
          [f.agent.id, both.id, both.id],
          [ops.id, both.id, both.id],
        ].sort(),
      );
      expect(answers.sort()).toEqual(
        [
          [f.agent.id, first.id],
          [f.agent.id, both.id],
          [ops.id, both.id],
        ].sort(),
      );
    } else {
      // As always: @dev's run in the channel takes it, and both answer there.
      expect(placed.sort()).toEqual(
        [
          [f.agent.id, first.id, null],
          [ops.id, both.id, null],
        ].sort(),
      );
      expect(answers.every(([, thread]) => thread === null)).toBe(true);
    }
  });
}

for (const on of [false, true]) {
  test(`the router picking two agents for a message, one of them at work on that person's ask (${on ? "on" : "off"})`, async () => {
    f = await setup({ reply: () => ({ chunks: ["Comigo."] }) });
    const ops = await addOps();
    if (on) await threadsOn();
    await say("@dev confere as lojas");
    const [working] = await runs();
    const asked = await say("@ops vê o deploy");
    // Two agents at work for this person: the floor leaves the next message to the router, which picks both.
    const floor = await say("e quem cuida do backup?");
    expect((await runOf(working?.id)).pendingMessageIds).toEqual([]);
    const message = (await getMessage(f.db, f.org.id, floor.id)) as Message;
    await f.db.transaction((tx) =>
      createAgentRuns(tx, message, [f.agent.id, ops.id], "router", { joinChannelRun: true }),
    );

    const started = (await runs()).filter((r) => r.triggerMessageId === floor.id);
    if (on) {
      expect(started.map((r) => [r.agentId, replyThreadOf(r)]).sort()).toEqual(
        [
          [f.agent.id, floor.id],
          [ops.id, floor.id],
        ].sort(),
      );
    } else {
      // As always: each joins its run in the channel.
      expect(started).toEqual([]);
      expect((await runOf(working?.id)).pendingMessageIds).toEqual([floor.id]);
      expect((await runs()).find((r) => r.triggerMessageId === asked.id)?.pendingMessageIds).toEqual([floor.id]);
    }
  });
}

for (const on of [false, true]) {
  test(`the asker's message to a run waiting on its budget joins it and checks it early (${on ? "on" : "off"})`, async () => {
    f = await setup({ reply: () => ({ chunks: ["Certo."] }) });
    if (on) await threadsOn();
    await say("@dev confere as lojas");
    const [run] = await runs();
    await waitOnBudget(run?.id as string);

    const follow = await say("@dev deixa pra lá, já resolvi");
    expect((await runOf(run?.id)).pendingMessageIds).toEqual([follow.id]);
    await scheduleParkedChecks(f.db, (await getMessage(f.db, f.org.id, follow.id)) as Message);
    const checks = (await f.db.select().from(schema.outbox)).filter(
      (j) => j.kind === EARLY_CHECK_JOB && (j.payload as { runId?: string }).runId === run?.id,
    );
    expect(checks).toHaveLength(1);
  });
}

test('"@dev @ops" from the asker while @dev waits on its budget: it joins no run, and no run checks early', async () => {
  f = await setup({ reply: () => ({ chunks: ["Certo."] }) });
  await addOps();
  await threadsOn();
  await say("@dev confere as lojas");
  const [run] = await runs();
  await waitOnBudget(run?.id as string);

  const both = await say("@dev @ops quem cuida do deploy?");
  expect((await runOf(run?.id)).pendingMessageIds).toEqual([]);
  expect((await runs()).filter((r) => r.triggerMessageId === both.id)).toHaveLength(2);
  await scheduleParkedChecks(f.db, (await getMessage(f.db, f.org.id, both.id)) as Message);
  const checks = (await f.db.select().from(schema.outbox)).filter(
    (j) => j.kind === EARLY_CHECK_JOB && (j.payload as { runId?: string }).runId === run?.id,
  );
  expect(checks).toEqual([]);
});

for (const on of [false, true]) {
  test(`"Tentar de novo" after the channel was turned ${on ? "off" : "on"} answers where the failed run would have`, async () => {
    let broken = true;
    f = await setup({
      reply: () => (broken ? new ProviderError("provider rejected the request (400)", false, 400) : { chunks: ["ok"] }),
    });
    if (on) await threadsOn();
    const asked = await say("@dev resume o canal");
    await drainOutbox(f.db, f.handlers);
    const [failed] = await runs();
    expect(failed).toMatchObject({ status: "failed", replyInThread: on });

    await threadsOn(!on);
    broken = false;
    const { runs: retried } = await answerNow({ ...deps(), gateway: f.gateway }, f.owner.id, f.org.id, asked.id);
    await drainOutbox(f.db, f.handlers);
    expect(await runOf(retried[0]?.runId)).toMatchObject({ triggerMessageId: asked.id, replyInThread: on });
    const answer = (await postsOf()).find((m) => m.agentRunId === retried[0]?.runId);
    expect(answer).toMatchObject({ body: "ok", threadId: on ? asked.id : null });
  });
}

/** @dev's first request fails; the same person's second waits on @dev's budget. */
async function failedBesideWaiting(onFirst: boolean, onSecond: boolean) {
  const broken = { now: true };
  f = await setup({
    reply: () =>
      broken.now ? new ProviderError("provider rejected the request (400)", false, 400) : { chunks: ["ok"] },
  });
  await threadsOn(onFirst);
  const first = await say("@dev resume o canal");
  await drainOutbox(f.db, f.handlers);
  expect((await runs())[0]).toMatchObject({ status: "failed", replyInThread: onFirst });
  await threadsOn(onSecond);
  const second = await say("@dev confere as lojas");
  const waiting = (await runs()).find((r) => r.triggerMessageId === second.id);
  await waitOnBudget(waiting?.id as string);
  broken.now = false;
  return { first, waiting: await runOf(waiting?.id) };
}

for (const on of [false, true]) {
  test(`"Tentar de novo" while the asker's other request waits on its budget (${on ? "on" : "off"})`, async () => {
    const { first, waiting } = await failedBesideWaiting(on, on);
    const { runs: retried } = await answerNow({ ...deps(), gateway: f.gateway }, f.owner.id, f.org.id, first.id);
    const taker = await runOf(retried[0]?.runId);
    // Off, as always: the run in the main timeline waiting on its budget takes it. On: that run answers in another
    // thread, so the retry answers in its own.
    expect(taker.id === waiting.id).toBe(!on);
    expect(replyThreadOf(taker)).toBe(on ? first.id : null);
  });
}

test('"Tentar de novo" on a request asked while on never joins the main-timeline run of one asked after it was off', async () => {
  const { first, waiting } = await failedBesideWaiting(true, false);
  const { runs: retried } = await answerNow({ ...deps(), gateway: f.gateway }, f.owner.id, f.org.id, first.id);
  const taker = await runOf(retried[0]?.runId);
  expect(taker.id).not.toBe(waiting.id);
  expect(taker.replyInThread).toBe(true);
  expect(replyThreadOf(taker)).toBe(first.id);
});

for (const on of [false, true]) {
  test(`Continuar on a stretch's pause card after the channel was turned ${on ? "off" : "on"} goes on where the run answered`, async () => {
    f = await setup({ reply: () => ({ chunks: ["Sigo daqui."] }) });
    if (on) await threadsOn();
    const asking = await say("@dev confira todas as lojas");
    const original = await runOf((await runs())[0]?.id);
    // Its stretch is at its run limit: @dev's next wake-up is held for a pause card.
    await f.db.insert(schema.agentRuns).values(
      Array.from({ length: STRETCH.runs }, () => ({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: asking.id,
        triggerMessageId: Bun.randomUUIDv7(),
        trigger: "mention" as const,
        hop: 2,
        stretchId: asking.id,
        status: "done" as const,
      })),
    );
    expect(await refusedAtLimit(f.db, original, f.agent.id)).not.toBeNull();
    await drainOutbox(f.db, f.handlers);
    const card = (await f.db.select().from(schema.messages)).find((m) => stretchCardOf(m.meta));
    expect(card?.threadId).toBe(on ? asking.id : null);

    await threadsOn(!on);
    const { runs: going } = await answerNow({ ...deps(), gateway: f.gateway }, f.owner.id, f.org.id, card?.id ?? "");
    const resumed = await runOf(going[0]?.runId);
    expect(resumed.replyInThread).toBe(on);
    expect(replyThreadOf(resumed)).toBe(on ? asking.id : null);
  });
}

/** @dev answered a request asked while the channel did (`on`) or didn't reply in threads; then it was switched. */
async function answeredThenSwitched(on: boolean) {
  f = await setup({ reply: () => ({ chunks: ["Ok."] }) });
  if (on) await threadsOn();
  const asking = await say("@dev confere as lojas");
  await drainOutbox(f.db, f.handlers);
  const ended = await runOf((await runs())[0]?.id);
  expect(ended.status).toBe("done");
  await threadsOn(!on);
  return { asking, ended };
}

/** The run that went on from `ended` answers where `ended` did, with its copy; on, the asker's next call joins it. */
async function wentOnWhereItAnswered(on: boolean, asking: { id: string }, woken: { id: string } | undefined) {
  const run = await runOf(woken?.id);
  expect(run.replyInThread).toBe(on);
  expect(replyThreadOf(run)).toBe(on ? asking.id : null);
  if (!on) return;
  const next = await say("@dev e a de Olinda?");
  expect((await runOf(run.id)).pendingMessageIds).toEqual([next.id]);
}

for (const on of [false, true]) {
  test(`a notice for a run that ended, after the channel was turned ${on ? "off" : "on"}, goes on where it answered`, async () => {
    const { asking, ended } = await answeredThenSwitched(on);
    const { runs: woken } = await f.db.transaction((tx) =>
      deliverNoticeToRun(tx, ended, { kind: "follow_up", text: "Hora de conferir de novo." }),
    );
    await wentOnWhereItAnswered(on, asking, woken[0]);
  });
}

for (const on of [false, true]) {
  test(`a computer task's end, after the channel was turned ${on ? "off" : "on"}, goes on where its run answered`, async () => {
    const { asking, ended } = await answeredThenSwitched(on);
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
    const [task] = await f.db
      .insert(schema.machineTasks)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        machineId,
        channelId: f.general.id,
        threadRootId: replyThreadOf(ended),
        runId: ended.id,
        title: "Rodar os testes",
        executor: "shell",
        command: "bun test",
        status: "done",
        exitCode: 0,
        endedAt: new Date(),
      })
      .returning();
    const woke = await wakeConversationForTask({ db: f.db }, task?.id ?? "", { maxHops: 100 });
    await wentOnWhereItAnswered(on, asking, woke?.runs[0]);
  });
}

for (const on of [false, true]) {
  test(`a folder decision, after the channel was turned ${on ? "off" : "on"}, goes on where the run that asked answered`, async () => {
    const { asking, ended } = await answeredThenSwitched(on);
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
    const [request] = await f.db
      .insert(schema.machineAccessRequests)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        machineId,
        channelId: f.general.id,
        threadRootId: replyThreadOf(ended),
        runId: ended.id,
        requestedByUserId: f.owner.id,
        path: "/Users/ana/Documents",
        reason: "ler os contratos",
        status: "granted",
        scope: "agent",
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    const woke = await wakeForAccessDecision({ db: f.db }, request?.id ?? "", { maxHops: 100 });
    await wentOnWhereItAnswered(on, asking, woke?.runs[0]);
  });
}

test("the active-run list says each run's own copy, and its threadId stays the run's root either way", async () => {
  f = await setup({ reply: () => ({ chunks: ["Ok."] }) });
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await threadsOn();
  const asking = await say("@dev confere as lojas");
  await threadsOn(false);
  const other = await say("@dev qual o horário de hoje?", { userId: bia.id });

  const active = await activeRunsIn(f.db, f.org.id, f.general.id);
  expect(active.map((r) => [r.triggerMessageId, r.threadId, r.replyInThread])).toEqual([
    [asking.id, asking.id, true],
    [other.id, other.id, false],
  ]);
});
