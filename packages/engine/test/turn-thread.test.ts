import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { RealtimeEvent } from "@agenteschat/adapters";
import { and, asc, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  activeRunsIn,
  addChannelMember,
  createChannel,
  drainOutbox,
  listChannels,
  openDm,
  postPersonMessage,
  SAY_NOW_TOOL,
  type ToolSource,
} from "../src";
import { type Fixture, setup } from "./fixtures";

/**
 * A run asked in a channel's main timeline (ADR 0261): its first words stay there, and what it posts after them goes
 * in the thread under them. DMs and threads stay as they were; a run whose one message is its answer ends as before.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const LINE = "Certo, vou levantar os números do mês.";
const ANSWER = "Receita de novembro: 42 assinaturas novas, 3 cancelamentos.";

const say = (body: string, channelId = f.general.id, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, {
    body,
    ...(threadId ? { threadId } : {}),
  });
const runs = () => f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
const posts = async () =>
  (await f.db.select().from(schema.messages).orderBy(asc(schema.messages.createdAt))).filter(
    (m) => m.authorAgentId === f.agent.id,
  );
const asked = (req: ModelRequest | undefined, words: string) => JSON.stringify(req?.messages ?? []).includes(words);
const fields = (e: RealtimeEvent) => e as unknown as { type: string; threadId?: string | null; runId?: string };

/** `numbers` takes a while; `during` runs while it works, after the line went out. */
function numbersTool(during: () => Promise<unknown> = async () => {}): ToolSource {
  return {
    name: "numbers",
    tools: async () => [
      {
        name: "numbers",
        description: "Pulls the month's numbers.",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          await during();
          return { content: "42 novas, 3 canceladas" };
        },
      },
    ],
  };
}

/** The model: its line and the work first, then the answer. */
const lineThenAnswer = (during?: () => Promise<unknown>) =>
  setup({
    sayNow: true,
    toolSources: [numbersTool(during)],
    // Each run calls the model twice.
    reply: (_req, call) =>
      call % 2 === 1
        ? {
            chunks: [],
            toolUses: [
              { id: "toolu_say", name: SAY_NOW_TOOL, input: { text: LINE } },
              { id: "toolu_numbers", name: "numbers", input: {} },
            ],
          }
        : { chunks: [ANSWER] },
  });

test("its first words stay in the channel; the answer goes in their thread, which the asker follows", async () => {
  f = await lineThenAnswer();
  const events = f.listen(f.general.id);
  const asking = await say("@dev puxa os números do mês");
  await drainOutbox(f.db, f.handlers);

  const [line, answer, ...more] = await posts();
  if (!line || !answer) throw new Error("no line, or no answer");
  expect(more).toEqual([]);
  expect(line).toMatchObject({ body: LINE, threadId: null, meta: { turnThread: { askedBy: f.owner.id } } });
  expect(answer).toMatchObject({ body: ANSWER, threadId: line.id });
  const [run] = await runs();
  expect(run).toMatchObject({
    status: "done",
    triggerMessageId: asking.id,
    threadRootId: line.id,
    replyInThread: true,
  });
  // The channel shows one line for it, and the answer is unread for whoever asked.
  const [opened] = await f.db.select().from(schema.threads).where(eq(schema.threads.rootMessageId, line.id));
  expect(opened?.openedByReplyAt).not.toBeNull();
  const [follow] = await f.db
    .select()
    .from(schema.threadFollows)
    .where(and(eq(schema.threadFollows.rootMessageId, line.id), eq(schema.threadFollows.userId, f.owner.id)));
  expect(follow?.following).toBe(true);
  const [general] = (await listChannels(f.db, f.owner.id, f.org.id)).filter((c) => c.id === f.general.id);
  expect(general?.unreadCount).toBe(2);
  // Its news opens the thread.
  const told = (await f.db.select().from(schema.notifications)).filter((n) => n.source.messageId === answer.id);
  expect(told.map((n) => [n.userId, n.kind, n.source.threadId])).toEqual([[f.owner.id, "agent_reply", line.id]]);
  // Live: it stops showing in the channel when the line goes out, and works on in the thread.
  const live = events.map(fields).filter((e) => e.runId === run?.id);
  const moved = live.findIndex((e) => e.type === "agent.thinking" && e.threadId === line.id);
  expect(moved).toBeGreaterThan(0);
  expect(live.slice(0, moved).some((e) => e.type === "agent.idle" && e.threadId === null)).toBe(true);
  expect(live.find((e) => e.type === "agent.tool" && (e as { tool?: string }).tool === "numbers")?.threadId).toBe(
    line.id,
  );
  expect(live.filter((e) => e.type === "run.finished").map((e) => e.threadId)).toEqual([line.id]);
});

test("while it works there, the asker's next message in the channel still reaches it", async () => {
  let followUp = "";
  f = await lineThenAnswer(async () => {
    followUp = (await say("e compara com outubro")).id;
  });
  await say("@dev puxa os números do mês");
  await drainOutbox(f.db, f.handlers);

  const [run, ...others] = await runs();
  expect(others).toEqual([]);
  expect(followUp).not.toBe("");
  expect(asked(f.provider.calls[1]?.request, "e compara com outubro")).toBe(true);
  expect((await posts()).at(-1)).toMatchObject({ body: ANSWER, threadId: run?.threadRootId });
});

test("the active-run list places a working run under its line", async () => {
  let listed: Awaited<ReturnType<typeof activeRunsIn>> = [];
  f = await lineThenAnswer(async () => {
    listed = await activeRunsIn(f.db, f.org.id, f.general.id);
  });
  await say("@dev puxa os números do mês");
  await drainOutbox(f.db, f.handlers);
  const [line] = await posts();
  if (!line) throw new Error("no line");
  expect(listed.map((r) => [r.threadId, r.replyInThread])).toEqual([[line.id, true]]);
});

test("one message, its answer: it stays in the channel and the run ends answering there", async () => {
  f = await setup({ reply: () => ({ chunks: [ANSWER] }) });
  const asking = await say("@dev puxa os números do mês");
  await drainOutbox(f.db, f.handlers);

  expect((await posts()).map((m) => [m.body, m.threadId])).toEqual([[ANSWER, null]]);
  const [run] = await runs();
  expect(run).toMatchObject({ status: "done", threadRootId: asking.id, replyInThread: false });
});

test("in a DM and inside a thread, everything stays where it was asked", async () => {
  f = await lineThenAnswer();
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await say("puxa os números do mês", dm.id);
  await drainOutbox(f.db, f.handlers);
  expect((await posts()).map((m) => [m.channelId, m.threadId])).toEqual([
    [dm.id, null],
    [dm.id, null],
  ]);

  const root = await say("fechamento de novembro");
  await say("@dev puxa os números do mês", f.general.id, root.id);
  await drainOutbox(f.db, f.handlers);
  expect((await posts()).slice(2).map((m) => [m.body, m.threadId])).toEqual([
    [LINE, root.id],
    [ANSWER, root.id],
  ]);
});

test("move_here still takes a run that answers under its line to another channel's top level", async () => {
  f = await setup({
    sayNow: true,
    chatTools: true,
    reply: (_req, call) =>
      call === 1
        ? {
            chunks: [],
            toolUses: [
              { id: "toolu_say", name: SAY_NOW_TOOL, input: { text: LINE } },
              {
                id: "toolu_move",
                name: "post_message",
                input: { channel: "financeiro", text: "Sigo aqui.", move_here: true },
              },
            ],
          }
        : { chunks: [ANSWER] },
  });
  const finance = await createChannel(f.db, f.owner.id, f.org.id, { name: "financeiro", visibility: "public" });
  await addChannelMember(f.db, f.owner.id, f.org.id, finance.id, { agentId: f.agent.id });
  await say("@dev puxa os números no #financeiro");
  await drainOutbox(f.db, f.handlers);

  const moved = (await f.db.select().from(schema.agentRunSteps)).find(
    (s) => s.kind === "tool_result" && s.data.name === "post_message",
  );
  expect(moved?.data.isError).toBeFalsy();
  const [run] = await runs();
  expect(run).toMatchObject({ channelId: finance.id, replyInThread: false });
  expect((await posts()).filter((m) => m.channelId === finance.id).map((m) => [m.body, m.threadId])).toEqual([
    ["Sigo aqui.", null],
    [ANSWER, null],
  ]);
});

test("its own words: the second goes under the first, and its live row moves into that thread", async () => {
  const NEXT = "Achei os números; vou comparar com outubro.";
  f = await setup({
    judge: (kind, _id, state) =>
      kind === "follow_through"
        ? String(state.reply).toLowerCase().includes("vou ")
          ? "continue"
          : "done"
        : undefined,
    reply: (_req, call) => ({ chunks: [call === 1 ? LINE : call === 2 ? NEXT : ANSWER] }),
  });
  const events = f.listen(f.general.id);
  await say("@dev puxa os números do mês");
  await drainOutbox(f.db, f.handlers);

  const [line, ...under] = await posts();
  if (!line) throw new Error("no line");
  expect(line).toMatchObject({ body: LINE, threadId: null });
  expect(under.map((m) => [m.body, m.threadId])).toEqual([
    [NEXT, line.id],
    [ANSWER, line.id],
  ]);
  // From its second message on it works in the thread: the channel's row ends, the thread's starts.
  const [run] = await runs();
  const live = events.map(fields).filter((e) => e.runId === run?.id);
  const moved = live.findIndex((e) => e.type === "agent.thinking" && e.threadId === line.id);
  expect(moved).toBeGreaterThan(0);
  expect(live.slice(0, moved).some((e) => e.type === "agent.idle" && e.threadId === null)).toBe(true);
});
