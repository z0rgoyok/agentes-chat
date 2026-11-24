import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import { type ModelRequest, ProviderError, systemText, textOf } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  agentStatuses,
  askAgentToImplement,
  CANCEL_FOLLOW_UP_TOOL,
  canceledReturns,
  cancelFollowUp,
  cancelRun,
  createAgent,
  createAgentRuns,
  createIssue,
  createJobHandlers,
  createPassToolSource,
  createRole,
  drainOutbox,
  FOLLOW_UP_JOB,
  FOLLOW_UP_TOOL,
  insertMessage,
  invokeToolForRun,
  JevOffError,
  joinChannel,
  listThreads,
  openAgentDm,
  openPersonAgentDm,
  openTaskConversation,
  PLATFORM_CAP,
  pendingReturns,
  postPersonMessage,
  RIGHT_HAND,
  removeChannelMember,
  runAuthority,
  STRETCH,
  STRETCH_JOB,
  STRETCH_REFUSAL,
  saveAgentStyle,
  setMemberRoles,
  type ToolSource,
  taskManager,
  toolPolicy,
  wakeFollowUp,
} from "../src";
import { advance, decideTurnEnd, type TurnEnd, toolsNamed } from "../src/continuation";
import { createLlmJudge, JudgeBudgetError, withJudgeFallback } from "../src/judge";
import { personCanPost } from "../src/routine-state";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * Agents follow through (ADR 0037, round 3; ADR 0089): every conversation run's end gets one judge call, in any
 * language, and work it said it would do that nothing keeps gets one more turn, never two; a person's go-ahead
 * they wait for is no unkept promise, nor is one that something the run set up keeps; `follow_up` posts its line,
 * wakes the agent in the same conversation at its time for the same person, and keeps its bounds; a canceled one,
 * or one whose agent or person left the conversation, wakes nobody.
 */

let f: Fixture;
afterEach(async () => {
  // A test without a database leaves the last one's: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastUserText = (request: ModelRequest) => {
  const last = request.messages.at(-1);
  return last ? textOf(last.content) : "";
};

const followThroughCalls = (fx: Fixture) =>
  (fx.context.judge as unknown as { calls: { kind: string }[] }).calls.filter((c) => c.kind === "follow_through");

const agentMessages = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(schema.messages.createdAt)).filter(
    (m) => m.authorType === "agent" && !m.meta.notice,
  );

const ask = (fx: Fixture, body: string, threadId?: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body,
    ...(threadId ? { threadId } : {}),
  });

test("a promise nothing keeps: one more turn to keep it, one to ask, then the reply is its answer, never a card", async () => {
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
    reply: (_request, call) => ({
      chunks: [
        call === 1
          ? "O job de testes ainda está rodando. Vou checar de novo daqui a pouco e te passo os números."
          : "Ainda rodando: vou checar de novo depois.",
      ],
    }),
  });
  await ask(f, "@dev o ci demora tanto assim?");
  await drainOutbox(f.db, f.handlers);

  expect(f.provider.calls.length).toBe(3);
  const nudge = lastUserText(f.provider.calls[1]?.request as ModelRequest);
  expect(nudge).toContain("You ended saying you would do more");
  // No sentence of it is quoted back: the judge read the whole message, in whatever language.
  expect(nudge).not.toContain("Vou checar");
  // Promising again without doing anything: it is told to ask instead, once (ADR 0097).
  expect(lastUserText(f.provider.calls[2]?.request as ModelRequest)).toContain("Ask them now with ask_user");
  expect(followThroughCalls(f).length).toBe(3);
  const steps = await f.db.select().from(schema.agentRunSteps);
  expect(steps.filter((s) => s.data.nudged === "promise").length).toBe(1);
  expect(steps.filter((s) => s.data.nudged === "ask").length).toBe(1);
  // The last reply asks nothing and only repeats the one before: no card that would keep a person on it, and no
  // second copy of it either.
  expect((await agentMessages(f)).map((m) => m.body)).toEqual([
    "O job de testes ainda está rodando. Vou checar de novo daqui a pouco e te passo os números.",
    "Ainda rodando: vou checar de novo depois.",
  ]);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
  expect(await f.db.select().from(schema.agentQuestions)).toEqual([]);
  expect(steps.some((s) => (s.data.continuation as { rule?: string } | undefined)?.rule === "not_a_question")).toBe(
    true,
  );
});

test("a need only a person can fill, asked in the text instead of the card: one nudge to ask, then the reply is the question", async () => {
  const asked = "Pode me mandar o token do Sentry? Com ele eu configuro o alerta.";
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "ask" : undefined),
    reply: () => ({ chunks: [asked] }),
  });
  await ask(f, "@dev configura o alerta do Sentry");
  await drainOutbox(f.db, f.handlers);
  expect(followThroughCalls(f).length).toBe(2);
  expect(f.provider.calls.length).toBe(2);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("waiting_input");
  expect((await f.db.select().from(schema.agentQuestions)).map((q) => q.text)).toEqual([asked]);
});

test("a reply too long for a question card is posted whole, never cut into one", async () => {
  const long = `Corrijo o que falta no Android. ${"Preencher a classificação de conteúdo, o título, o ícone 512x512 e o AAB assinado. ".repeat(14)}Posso fazer isso agora?`;
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "ask" : undefined),
    reply: () => ({ chunks: [long] }),
  });
  await ask(f, "@dev o que falta para o review do android?");
  await drainOutbox(f.db, f.handlers);
  expect(await f.db.select().from(schema.agentQuestions)).toEqual([]);
  expect((await agentMessages(f)).map((m) => m.body)).toEqual([long, long]);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
  const steps = await f.db.select().from(schema.agentRunSteps);
  expect(steps.some((s) => (s.data.continuation as { rule?: string } | undefined)?.rule === "ask_long")).toBe(true);
});

test("every run's end is read once by the judge, in any language: a promise in Japanese is caught, a plain answer isn't", async () => {
  const promised = "CIはまだ実行中です。あとでもう一度確認して数字を送ります。";
  f = await setup({
    // The fake judge reads no words: it answers by the run it is asked about.
    judge: (kind, _id, state) =>
      kind === "follow_through" ? (String(state.reply) === promised ? "continue" : "done") : undefined,
    reply: (_request, call) => ({
      chunks: [call === 1 ? promised : call === 2 ? "数字です: テスト9分、lint 2分。" : "O CI levou 12 minutos."],
    }),
  });
  await ask(f, "@dev CIはどうなっていますか？");
  await drainOutbox(f.db, f.handlers);
  // No word list stood in front of the judge: it read the reply and told the run to do it now; the kept promise
  // is read again (done).
  expect(followThroughCalls(f).length).toBe(2);
  expect(f.provider.calls.length).toBe(2);
  expect(lastUserText(f.provider.calls[1]?.request as ModelRequest)).toContain("You ended saying you would do more");

  await ask(f, "@dev e o tempo do CI?");
  await drainOutbox(f.db, f.handlers);
  // A plain answer: asked once too, done, no more turns.
  expect(followThroughCalls(f).length).toBe(3);
  expect(f.provider.calls.length).toBe(3);
});

test("the prompt asks to finish what it starts, and names follow_up only when the run has it", async () => {
  f = await setup({ followUps: true, reply: () => ({ chunks: ["ok"] }) });
  await ask(f, "@dev oi");
  await drainOutbox(f.db, f.handlers);
  const withTool = systemText(f.provider.calls[0]?.request.system ?? []);
  expect(withTool).toContain("Before you end your turn, reread your reply.");
  expect(withTool).toContain("set a follow_up and say when");
  expect(withTool).toContain("After a person approves or answers what you waited on, go on at once");
  await f.close();

  f = await setup({ react: true, reply: () => ({ chunks: ["ok"] }) });
  await ask(f, "@dev oi");
  await drainOutbox(f.db, f.handlers);
  const without = systemText(f.provider.calls[0]?.request.system ?? []);
  expect(without).toContain("Before you end your turn, reread your reply.");
  expect(without).not.toContain("follow_up");
});

test("follow_up: a line now; at its time the agent wakes in the same thread with its note, for the same person", async () => {
  f = await setup({
    followUps: true,
    // A promise kept by the follow-up just set: nothing to nudge.
    judge: (kind, _id, state) =>
      kind === "follow_through" && String(state.reply).startsWith("Ainda rodando") ? "continue" : undefined,
    reply: (_request, call) =>
      call === 1
        ? {
            chunks: ["O CI ainda está rodando."],
            toolUses: [
              {
                name: FOLLOW_UP_TOOL,
                input: { minutes: 30, note: "Check CI run 42 and give the per-job times.", about: "ver o CI" },
              },
            ],
          }
        : call === 2
          ? { chunks: ["Ainda rodando. Volto em 30 minutos para ver o CI."] }
          : { chunks: ["Terminou: testes 9 min, lint 2 min."] },
  });
  const root = await ask(f, "Deploy de hoje");
  await ask(f, "@dev o CI terminou?", root.id);
  await drainOutbox(f.db, f.handlers);

  const [first] = await f.db.select().from(schema.agentRuns);
  const lines = (await f.db.select().from(schema.messages)).filter(
    (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "follow_up",
  );
  expect(lines.length).toBe(1);
  const line = lines[0];
  expect(line?.threadId).toBe(root.id);
  expect(line?.meta.notice).toMatchObject({
    kind: "follow_up",
    text: "Check CI run 42 and give the per-job times.",
    refs: { runId: first?.id, about: "ver o CI", state: "pending" },
  });
  const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, FOLLOW_UP_JOB));
  expect(job?.status).toBe("pending");
  const ahead = (job?.nextAttemptAt.getTime() ?? 0) - Date.now();
  expect(ahead).toBeGreaterThan(29 * 60_000);
  expect(ahead).toBeLessThanOrEqual(30 * 60_000);
  // The follow-up keeps the promise: what the run set up brings it back, so the judge isn't asked.
  expect(followThroughCalls(f).length).toBe(0);
  expect(f.provider.calls.length).toBe(2);

  // Its time comes.
  await f.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date() })
    .where(eq(schema.outbox.id, job?.id ?? ""));
  await drainOutbox(f.db, f.handlers);

  const runs = await f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
  expect(runs.length).toBe(2);
  const woken = runs[1];
  const [trigger] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, woken?.triggerMessageId ?? ""));
  expect(trigger?.threadId).toBe(root.id);
  expect(trigger?.meta.notice).toMatchObject({ kind: "follow_up", refs: { wake: "1", followUpId: line?.id } });
  expect(woken?.status).toBe("done");
  if (!woken) throw new Error("no woken run");
  expect(await runAuthority(f.db, woken)).toEqual({ kind: "person", personId: f.owner.id });
  // It read its note as the current message, with what to do now.
  const read = lastUserText(f.provider.calls[2]?.request as ModelRequest);
  expect(read).toContain("Check CI run 42 and give the per-job times.");
  expect(read).toContain("Do what you came back for now");
  const answer = (await agentMessages(f)).at(-1);
  expect(answer?.body).toBe("Terminou: testes 9 min, lint 2 min.");
  expect(answer?.threadId).toBe(root.id);
  const [settled] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, line?.id ?? ""));
  expect(settled?.meta.notice).toMatchObject({ refs: { state: "done" } });
  // The lines notify nobody: the reply they bring does.
  const notified = (await f.db.select().from(schema.notifications)).map((n) => n.source.messageId);
  expect(notified).not.toContain(line?.id);
  expect(notified).not.toContain(trigger?.id);
  expect(notified).toContain(answer?.id);
});

test("a follow-up a person asked for comes at its time even when the agent's last word was a side question", async () => {
  f = await setup({
    followUps: true,
    reply: (_request, call) =>
      call === 1
        ? {
            chunks: ["Combinado."],
            toolUses: [{ name: FOLLOW_UP_TOOL, input: { minutes: 10, note: "Check the deploy.", about: "deploy" } }],
          }
        : call === 2
          ? { chunks: ["Combinado, volto em 10 min. Quer que eu também rode os testes?"] }
          : { chunks: ["Deploy ok."] },
  });
  await ask(f, "@dev confere o deploy em 10 min");
  await drainOutbox(f.db, f.handlers);
  const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, FOLLOW_UP_JOB));
  await f.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date() })
    .where(eq(schema.outbox.id, job?.id ?? ""));
  await drainOutbox(f.db, f.handlers);
  expect((await f.db.select().from(schema.agentRuns)).length).toBe(2);
  const [line] = (await f.db.select().from(schema.messages)).filter(
    (m) =>
      (m.meta.notice as { kind?: string } | undefined)?.kind === "follow_up" &&
      !(m.meta.notice as { refs?: { wake?: string } }).refs?.wake,
  );
  expect(line?.meta.notice).toMatchObject({ refs: { state: "done" } });
});

test("follow_up bounds: a day ahead at most, two per run, three per conversation, none past the stretch's limit", async () => {
  f = await setup({ followUps: true });
  await ask(f, "@dev acompanha o deploy");
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const deps = { db: f.db, pubsub: f.pubsub, tools: f.tools };
  let n = 0;
  const call = (runId: string, input: Record<string, unknown>) =>
    invokeToolForRun(
      deps,
      { orgId: f.org.id, agentId: f.agent.id, runId, machineId: "" },
      {
        id: `fu-${++n}`,
        name: FOLLOW_UP_TOOL,
        input: { note: "Check the deploy.", about: "ver o deploy", ...input },
      },
    );

  expect((await call(run.id, { minutes: 25 * 60 })).result).toMatchObject({ isError: true });
  expect((await call(run.id, { at: new Date(Date.now() + 25 * 3600_000).toISOString() })).result.content).toContain(
    "At most 24 hours ahead",
  );
  expect((await call(run.id, { at: new Date(Date.now() - 60_000).toISOString() })).result.isError).toBe(true);
  expect((await call(run.id, {})).result.isError).toBe(true);
  // A time without its offset would be read in the server's zone, not the person's: refused, a bare date too.
  const local = new Date(Date.now() + 3600_000).toISOString().slice(0, 19);
  expect((await call(run.id, { at: local })).result.content).toContain("offset");
  expect((await call(run.id, { at: local.slice(0, 10) })).result.content).toContain("offset");
  expect((await call(run.id, { minutes: 10 })).result.isError).toBeUndefined();
  expect((await call(run.id, { at: new Date(Date.now() + 3600_000).toISOString() })).result.isError).toBeUndefined();
  expect((await call(run.id, { minutes: 20 })).result.content).toContain("already set 2 follow-ups");

  // Another run of the agent in the same conversation (the channel's timeline): one more fits, then it is full.
  const later = await ask(f, "e o de staging?");
  const [other] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: later.id,
      triggerMessageId: later.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!other) throw new Error("no run");
  expect((await call(other.id, { minutes: 5 })).result.isError).toBeUndefined();
  expect((await call(other.id, { minutes: 6 })).result.content).toContain("3 follow-ups already wait");

  // Its wake is one more run agents start on their own: with the stretch at its limit (ADR 0089), it is refused
  // and the pause card goes out, whatever the hop.
  await f.db.insert(schema.agentRuns).values(
    Array.from({ length: STRETCH.runs }, () => ({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: later.id,
      triggerMessageId: Bun.randomUUIDv7(),
      trigger: "mention" as const,
      hop: 2,
      stretchId: later.id,
      status: "done" as const,
    })),
  );
  const refusedAtLimit = await call(other.id, { minutes: 5 });
  expect(refusedAtLimit.result).toMatchObject({ content: STRETCH_REFUSAL, isError: true });
  expect((await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, STRETCH_JOB))).length).toBe(1);

  // A routine's background work may set its own resume, for work it is blocked on (`routine-room.test.ts`).
  const tool = { name: FOLLOW_UP_TOOL, scope: "" };
  expect(toolPolicy({ kind: "routine", personId: null, brief: null }, tool).action).toBe("allow");
  expect(toolPolicy({ kind: "person", personId: f.owner.id }, tool).action).toBe("allow");
});

test("canceled by the agent or by a person, a follow-up wakes nobody; a second cancel is refused", async () => {
  f = await setup({ followUps: true });
  await ask(f, "@dev me avisa quando o deploy terminar");
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const deps = { db: f.db, pubsub: f.pubsub, tools: f.tools };
  const id = { orgId: f.org.id, agentId: f.agent.id, runId: run.id, machineId: "" };
  const set = async (minutes: number) => {
    const out = await invokeToolForRun(deps, id, {
      id: `fu-${minutes}`,
      name: FOLLOW_UP_TOOL,
      input: { minutes, note: "Check the deploy.", about: "ver o deploy" },
    });
    return out.result.content.match(/Follow-up (\S+) set/)?.[1] ?? "";
  };
  const byAgent = await set(10);
  const byPerson = await set(20);

  const canceled = await invokeToolForRun(deps, id, { id: "c-1", name: CANCEL_FOLLOW_UP_TOOL, input: { id: byAgent } });
  expect(canceled.result.content).toBe("Canceled 1 follow-up.");
  await cancelFollowUp({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, byPerson);
  await expect(cancelFollowUp({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, byPerson)).rejects.toMatchObject({
    code: "follow_up.not_pending",
  });
  const states = (await f.db.select().from(schema.messages))
    .filter((m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "follow_up")
    .map((m) => (m.meta.notice as { refs: { state: string; canceledBy?: string } }).refs);
  expect(states).toEqual(
    expect.arrayContaining([
      {
        runId: run.id,
        at: expect.any(String),
        about: "ver o deploy",
        state: "canceled",
        personId: f.owner.id,
        canceledBy: `agent:${f.agent.id}`,
        canceledAt: expect.any(String),
      },
      {
        runId: run.id,
        at: expect.any(String),
        about: "ver o deploy",
        state: "canceled",
        personId: f.owner.id,
        canceledBy: f.owner.id,
        canceledAt: expect.any(String),
      },
    ]),
  );

  // Their time comes: nothing is delivered and no run starts.
  await f.db.update(schema.outbox).set({ nextAttemptAt: new Date() }).where(eq(schema.outbox.kind, FOLLOW_UP_JOB));
  await drainOutbox(f.db, f.handlers);
  const wakes = (await f.db.select().from(schema.messages)).filter(
    (m) => (m.meta.notice as { refs?: { wake?: string } } | undefined)?.refs?.wake,
  );
  expect(wakes).toEqual([]);
  const runs = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.orgId, f.org.id), eq(schema.agentRuns.agentId, f.agent.id)));
  expect(runs.length).toBe(1);
});

/** Sets a follow-up from a run, as its tool call would. Returns the line's id. */
async function setFollowUp(fx: Fixture, runId: string, minutes: number) {
  const out = await invokeToolForRun(
    { db: fx.db, pubsub: fx.pubsub, tools: fx.tools },
    { orgId: fx.org.id, agentId: fx.agent.id, runId, machineId: "" },
    {
      id: `fu-${runId}-${minutes}`,
      name: FOLLOW_UP_TOOL,
      input: { minutes, note: "Check the deploy.", about: "ver o deploy" },
    },
  );
  return out.result.content.match(/Follow-up (\S+) set/)?.[1] ?? "";
}

const lineState = async (fx: Fixture, id: string) => {
  const [line] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, id));
  return (line?.meta.notice as { refs?: { state?: string } } | undefined)?.refs?.state;
};

test("at its time, an agent no longer in the conversation, or for a person who left it, wakes nobody", async () => {
  f = await setup({ followUps: true });
  await ask(f, "@dev acompanha o deploy");
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const forPerson = await setFollowUp(f, run.id, 10);
  const forAgent = await setFollowUp(f, run.id, 20);

  // The person who asked is no longer in the channel (nobody leaves #general on their own: their row goes).
  await f.db
    .delete(schema.channelMembers)
    .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.userId, f.owner.id)));
  expect(await wakeFollowUp({ db: f.db, pubsub: f.pubsub }, f.org.id, forPerson)).toBeNull();
  expect(await lineState(f, forPerson)).toBe("canceled");

  // Back in it, but the agent was removed.
  await joinChannel(f.db, f.owner.id, f.org.id, f.general.id);
  await removeChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: f.agent.id });
  expect(await wakeFollowUp({ db: f.db, pubsub: f.pubsub }, f.org.id, forAgent)).toBeNull();
  expect(await lineState(f, forAgent)).toBe("canceled");
  expect((await f.db.select().from(schema.agentRuns)).length).toBe(1);
});

test("in a task's conversation, read by people who are never its members, a follow-up still comes at its time", async () => {
  f = await setup({ followUps: true });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const asBia = { type: "person" as const, userId: bia.id };
  const issue = await createIssue({ db: f.db, pubsub: f.pubsub }, asBia, f.org.id, {
    title: "Migrate the build cache",
    assignees: [{ type: "agent", id: f.agent.id }],
  });
  const at = await openTaskConversation(f.db, asBia, f.org.id, issue.id);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, at.channelId, {
    body: "@dev keep an eye on the migration and tell me",
    threadId: at.rootId,
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const id = await setFollowUp(f, run.id, 5);
  expect(id).not.toBe("");

  expect(await wakeFollowUp({ db: f.db, pubsub: f.pubsub }, f.org.id, id)).not.toBeNull();
  expect(await lineState(f, id)).toBe("done");
  await drainOutbox(f.db, f.handlers);
  const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
  expect(runs.length).toBe(2);
});

test("a task's reader may post in its conversation; a non-reader, an archived one or a post denied may not", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const ana = { type: "person" as const, userId: f.owner.id };
  const open = await createIssue({ db: f.db, pubsub: f.pubsub }, ana, f.org.id, { title: "Rotate the staging keys" });
  const shut = await createIssue({ db: f.db, pubsub: f.pubsub }, ana, f.org.id, {
    title: "Plan the offsite",
    audience: { mode: "people", userIds: [f.owner.id] },
  });
  const openAt = await openTaskConversation(f.db, ana, f.org.id, open.id);
  const shutAt = await openTaskConversation(f.db, ana, f.org.id, shut.id);

  expect(await personCanPost(f.db, f.org.id, bia.id, openAt.channelId)).toBe(true);
  expect(await personCanPost(f.db, f.org.id, bia.id, shutAt.channelId)).toBe(false);
  expect(await personCanPost(f.db, f.org.id, f.owner.id, shutAt.channelId)).toBe(true);

  await f.db
    .insert(schema.channelPermissionOverrides)
    .values({ orgId: f.org.id, channelId: openAt.channelId, userId: bia.id, deny: ["post"] });
  expect(await personCanPost(f.db, f.org.id, bia.id, openAt.channelId)).toBe(false);

  await f.db.update(schema.channels).set({ archivedAt: new Date() }).where(eq(schema.channels.id, shutAt.channelId));
  expect(await personCanPost(f.db, f.org.id, f.owner.id, shutAt.channelId)).toBe(false);
});

test("in a channel's timeline the follow-ups are each person's: cancel_follow_up and the limit count only theirs", async () => {
  f = await setup({ followUps: true });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await joinChannel(f.db, bia.id, f.org.id, f.general.id);
  // One run each (a message while the agent works in the timeline joins its run there).
  await ask(f, "@dev acompanha o deploy");
  await drainOutbox(f.db, f.handlers);
  await ask(f, "@dev e o de staging?");
  await drainOutbox(f.db, f.handlers);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
    body: "@dev me avisa do build",
  });
  await drainOutbox(f.db, f.handlers);
  const [ana1, ana2, biaRun] = await f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
  if (!ana1 || !ana2 || !biaRun) throw new Error("no runs");
  await setFollowUp(f, ana1.id, 10);
  await setFollowUp(f, ana1.id, 11);
  const anaThird = await setFollowUp(f, ana2.id, 12);
  expect(anaThird).not.toBe("");
  // Ana's three fill her conversation with @dev here; Bia's is her own.
  const biaLine = await setFollowUp(f, biaRun.id, 13);
  expect(biaLine).not.toBe("");

  const canceled = await invokeToolForRun(
    { db: f.db, pubsub: f.pubsub, tools: f.tools },
    { orgId: f.org.id, agentId: f.agent.id, runId: biaRun.id, machineId: "" },
    { id: "c-bia", name: CANCEL_FOLLOW_UP_TOOL, input: {} },
  );
  expect(canceled.result.content).toBe("Canceled 1 follow-up.");
  expect(await lineState(f, biaLine)).toBe("canceled");
  expect(await lineState(f, anaThird)).toBe("pending");
});

test("a reminder it set to do the work itself keeps the promise: no judgment, no nudge", async () => {
  f = await setup({
    scheduleTools: true,
    judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
    reply: (request) =>
      JSON.stringify(request.messages.at(-1)?.content).includes("tool_result")
        ? { chunks: ["Agendado: daqui a 2 horas eu confiro o deploy e te passo como ficou."] }
        : {
            chunks: [],
            toolUses: [
              {
                name: "schedule_reminder",
                input: { when: "em 2 horas", message: "verifique o deploy e conte aqui", ask_agent: true },
              },
            ],
          },
  });
  await ask(f, "@dev daqui a 2 horas verifica o deploy");
  await drainOutbox(f.db, f.handlers);
  expect(followThroughCalls(f).length).toBe(0);
  expect(f.provider.calls.length).toBe(2);
});

test("asked to implement an issue: an answer posted before a nudge lands in the task's conversation too", async () => {
  const first = "Fixed in PR #7. CI is running: I'll check it once it finishes.";
  const second = "CI passed: PR #7 is ready to merge.";
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
    reply: (_request, call) => ({ chunks: [call === 1 ? first : second] }),
  });
  const deps = { db: f.db, pubsub: f.pubsub };
  const person = { type: "person" as const, userId: f.owner.id };
  const issue = await createIssue(deps, person, f.org.id, { title: "Login breaks on Safari" });
  const at = (await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id)).conversation;
  await drainOutbox(f.db, f.handlers);
  // Written there once each (ADR 0145: the conversation is where it works, nothing mirrored).
  const said = (await f.db.select().from(schema.messages))
    .filter((m) => m.authorType === "agent" && m.channelId === at?.channelId && !m.meta.questionId)
    .map((m) => m.body);
  expect(said).toEqual([first, second]);
});

test("a promise is kept by work handed off from this conversation still out, by any run; not another conversation's or a closed one", async () => {
  f = await setup({
    judge: (kind, _id, state) =>
      kind === "follow_through" ? (String(state.reply).startsWith("A Rita") ? "continue" : "done") : undefined,
    reply: (request) => ({
      chunks: [
        lastUserText(request).includes("You ended saying")
          ? "Ok, vou ver agora."
          : "A Rita ainda está nisso, te aviso quando terminar.",
      ],
    }),
  });
  const fx = f;
  const rita = await createAgent(
    fx.db,
    fx.owner.id,
    fx.org.id,
    { name: "Rita", handle: "rita", role: "Operations", credentialId: fx.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  /** An earlier run of Dev in #general, done: on a message of its own, or in a thread. */
  const earlier = async (thread?: string) => {
    const m = await insertMessage(fx.db, {
      orgId: fx.org.id,
      channelId: fx.general.id,
      ...(thread ? { threadId: thread } : {}),
      author: { type: "person", userId: fx.owner.id },
      body: "pedido",
    });
    const [run] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: fx.general.id,
        threadRootId: thread ?? m.id,
        triggerMessageId: m.id,
        trigger: "mention",
        hop: 1,
        status: "done",
      })
      .returning();
    if (!run) throw new Error("no run");
    return run;
  };
  const handedOff = (run: { id: string }, over: Partial<typeof schema.agentConsultations.$inferInsert> = {}) =>
    fx.db.insert(schema.agentConsultations).values({
      orgId: fx.org.id,
      kind: "note",
      askerRunId: run.id,
      askerAgentId: fx.agent.id,
      targetAgentId: rita.id,
      channelId: fx.general.id,
      messageId: Bun.randomUUIDv7(),
      waitId: `async:${Bun.randomUUIDv7()}`,
      question: "Passa a pasta ao Diogo.",
      chain: [fx.agent.id],
      expiresAt: new Date(Date.now() + 60_000),
      ...over,
    });
  const nudges = async () =>
    (await fx.db.select().from(schema.agentRunSteps)).filter((s) => s.data.nudged === "promise").length;

  const thread = await earlier();
  await handedOff(await earlier(thread.triggerMessageId));
  await handedOff(await earlier(), { status: "answered", answer: "Feito.", answeredAt: new Date() });
  await ask(fx, "@dev e a Rita?");
  await drainOutbox(fx.db, fx.handlers);
  expect(await nudges()).toBe(1);

  // Still out from here, handed off by an earlier run: what comes of it wakes the agent here, keeping "te aviso".
  await handedOff(await earlier());
  await ask(fx, "@dev e agora?");
  await drainOutbox(fx.db, fx.handlers);
  expect(followThroughCalls(fx).length).toBe(2);
  expect(await nudges()).toBe(1);
});

describe("between agents (ADR 0095)", () => {
  /** Whose model call it is: its prompt says which agent it is. */
  const youAre = (request: ModelRequest, name: string) =>
    systemText(request.system).includes(`You are ${name} (@${name.toLowerCase()})`);
  const addAgent = (fx: Fixture, name: string) =>
    createAgent(
      fx.db,
      fx.owner.id,
      fx.org.id,
      { name, handle: name.toLowerCase(), role: "Operations", credentialId: fx.credential.id },
      { model: "claude-sonnet-5-5" },
    );
  /** Dev hands Infra the queue when Ana asks; Infra answers with `infra` (by its call), Ops with "Fila limpa.". */
  const handing = (infra: (request: ModelRequest, call: number) => FakeReply) => {
    let infraCalls = 0;
    return (request: ModelRequest): FakeReply => {
      if (youAre(request, "Infra")) return infra(request, ++infraCalls);
      if (youAre(request, "Ops")) return { chunks: ["Fila limpa."] };
      const last = lastUserText(request);
      if (last.includes("did with the work you handed it") || last.includes("Note from @infra"))
        return { chunks: ["Pronto."] };
      if (JSON.stringify(request.messages.at(-1)?.content).includes("tool_result"))
        return { chunks: ["Passei a fila ao Infra."] };
      return {
        chunks: [],
        toolUses: [{ name: "tell_agent", input: { agent: "@infra", message: "Limpa a fila de jobs de staging." } }],
      };
    };
  };
  /** The judge reads Infra's replies as an unkept promise, and every note's reply as one the sender needs. */
  let infraId = "";
  const judge = (
    kind: string,
    _id: string,
    state: Record<string, unknown>,
    _q: unknown,
    request: { agentId?: string | null },
  ) =>
    kind === "follow_through" && request.agentId === infraId
      ? String(state.reply).startsWith("Fila limpa")
        ? "done"
        : "continue"
      : kind === "note_reply"
        ? 0.9
        : undefined;
  const infraJudged = (fx: Fixture) =>
    (fx.context.judge as unknown as { calls: { kind: string; agentId?: string }[] }).calls.filter(
      (c) => c.kind === "follow_through" && c.agentId === infraId,
    );
  const dmNudges = (fx: Fixture) =>
    fx.provider.calls.filter((c) => lastUserText(c.request).includes("your answer goes back as it is"));

  test("a run that owes an answer and ends on a promise gets the DM nudge once; one answering nothing gets no check", async () => {
    f = await setup({
      askAgent: true,
      judge,
      reply: handing((_request, call) => ({
        chunks: [call === 1 ? "Vou limpar a fila e te digo." : "Fila limpa: 0 jobs pendentes."],
      })),
    });
    const fx = f;
    const infra = await addAgent(fx, "Infra");
    infraId = infra.id;
    await ask(fx, "@dev pede ao infra para limpar a fila");
    await drainOutbox(fx.db, fx.handlers);
    expect(infraJudged(fx)).toHaveLength(2);
    expect(dmNudges(fx)).toHaveLength(1);
    expect(await fx.db.select().from(schema.agentConsultations)).toMatchObject([
      { status: "answered", answer: "Fila limpa: 0 jobs pendentes." },
    ]);

    // A note from before notes were rows: its run owes no answer, and isn't read.
    const [dev] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, fx.agent.id));
    if (!dev) throw new Error("no run");
    const dm = await openAgentDm(fx.db, fx.org.id, fx.agent.id, infra.id);
    await fx.db.transaction(async (tx) => {
      const m = await insertMessage(tx, {
        orgId: fx.org.id,
        channelId: dm.id,
        author: { type: "agent", agentId: fx.agent.id, runId: dev.id, hop: dev.hop },
        body: "A fila voltou a encher.",
        meta: { agentNote: { runId: dev.id } },
      });
      await createAgentRuns(tx, m, [infra.id], "dm");
    });
    await drainOutbox(fx.db, fx.handlers);
    expect(infraJudged(fx)).toHaveLength(2);
  });

  test("a run that handed part on and ends saying it will come back gets no nudge: what it handed on goes back with its answer", async () => {
    f = await setup({
      askAgent: true,
      judge,
      reply: handing((request) =>
        JSON.stringify(request.messages.at(-1)?.content).includes("tool_result")
          ? { chunks: ["Passei a fila ao Ops; te digo quando ele terminar."] }
          : {
              chunks: [],
              toolUses: [{ name: "tell_agent", input: { agent: "@ops", message: "Limpa a fila de staging." } }],
            },
      ),
    });
    const fx = f;
    const infra = await addAgent(fx, "Infra");
    infraId = infra.id;
    await addAgent(fx, "Ops");
    await ask(fx, "@dev pede ao infra para limpar a fila");
    await drainOutbox(fx.db, fx.handlers);
    // What it handed on brings it back: not judged.
    expect(infraJudged(fx)).toHaveLength(0);
    expect(dmNudges(fx)).toEqual([]);
    const [handed] = (await fx.db.select().from(schema.agentConsultations)).filter((c) => c.targetAgentId === infra.id);
    expect(handed).toMatchObject({
      status: "answered",
      answer:
        "Passei a fila ao Ops; te digo quando ele terminar.\n\n[@ops, to whom @infra handed part of it]: Fila limpa.",
    });
  });
});

describe("returns, as the apps list them (ADR 0037, amended 2026-11-13)", () => {
  /** Bia asks @dev in #general and its run ends: the run whose follow-ups are hers. */
  const biaAsks = async (fx: Fixture, body = "@dev me avisa do build", threadId?: string) => {
    const bia = await addMember(fx.db, fx.org.id, "member", "bia");
    await joinChannel(fx.db, bia.id, fx.org.id, fx.general.id);
    await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, bia.id, fx.org.id, fx.general.id, {
      body,
      ...(threadId ? { threadId } : {}),
    });
    await drainOutbox(fx.db, fx.handlers);
    const [run] = await fx.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
    if (!run) throw new Error("no run");
    return { bia, run };
  };

  test("who may cancel: the person it is for, the agent's owner and admins; anyone else who reads it is refused", async () => {
    f = await setup({ followUps: true });
    const { bia, run } = await biaAsks(f);
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await joinChannel(f.db, caio.id, f.org.id, f.general.id);
    const first = await setFollowUp(f, run.id, 10);
    const second = await setFollowUp(f, run.id, 20);
    const deps = { db: f.db, pubsub: f.pubsub };

    await expect(cancelFollowUp(deps, caio.id, f.org.id, first)).rejects.toMatchObject({ code: "follow_up.not_yours" });
    expect(await lineState(f, first)).toBe("pending");
    // The lists say the same, per person: Caio sees them without the control.
    const mine = async (userId: string) =>
      (await pendingReturns(f.db, userId, f.org.id)).map((r) => [r.messageId, r.canCancel]);
    expect(await mine(caio.id)).toEqual([
      [first, false],
      [second, false],
    ]);
    expect(await mine(bia.id)).toEqual([
      [first, true],
      [second, true],
    ]);
    expect(await mine(f.owner.id)).toEqual([
      [first, true],
      [second, true],
    ]);
    // "Edit agents" cancels for an agent whose audience takes them (ADR 0085 addendum of 2026-11-17), never for
    // someone's private agent.
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["manage_agents"] });
    const dani = await addMember(f.db, f.org.id, "member", "dani");
    await joinChannel(f.db, dani.id, f.org.id, f.general.id);
    await setMemberRoles(f.db, f.owner.id, f.org.id, dani.id, [leads.id]);
    expect(await mine(dani.id)).toEqual([
      [first, true],
      [second, true],
    ]);
    await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, f.agent.id));
    expect(await mine(dani.id)).toEqual([
      [first, false],
      [second, false],
    ]);
    await expect(cancelFollowUp(deps, dani.id, f.org.id, first)).rejects.toMatchObject({ code: "follow_up.not_yours" });
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    // The agent's owner.
    await f.db.update(schema.agents).set({ ownerUserId: caio.id }).where(eq(schema.agents.id, f.agent.id));
    expect(await mine(caio.id)).toEqual([
      [first, true],
      [second, true],
    ]);
    await cancelFollowUp(deps, caio.id, f.org.id, first);
    await cancelFollowUp(deps, bia.id, f.org.id, second);
    expect(await pendingReturns(f.db, bia.id, f.org.id)).toEqual([]);
    // "Terminadas hoje": canceled, when and by whom.
    const ended = await canceledReturns(f.db, bia.id, f.org.id, new Date(Date.now() - 3600_000));
    expect(ended.map((r) => [r.messageId, r.canceledBy])).toEqual([
      [second, { kind: "person", userId: bia.id, name: "bia" }],
      [first, { kind: "person", userId: caio.id, name: "caio" }],
    ]);
    expect(ended.every((r) => r.canceledAt && r.about === "ver o deploy")).toBe(true);
  });

  test("a return is listed where it lands, to who reads that conversation; a wake only late isn't held", async () => {
    f = await setup({ followUps: true });
    const { bia, run } = await biaAsks(f);
    const line = await setFollowUp(f, run.id, 30);
    const [r] = await pendingReturns(f.db, bia.id, f.org.id);
    expect(r).toMatchObject({
      messageId: line,
      agentId: f.agent.id,
      channelId: f.general.id,
      channelKind: "channel",
      channelName: "general",
      threadId: null,
      about: "ver o deploy",
      runId: run.id,
      replyMessageId: run.replyMessageId,
      held: false,
    });
    expect(Date.parse(r?.at ?? "") - Date.now()).toBeGreaterThan(29 * 60_000);
    expect((await pendingReturns(f.db, bia.id, f.org.id, { channelId: f.general.id })).length).toBe(1);
    // The owner's own DM with the agent: nobody else reads it, so nobody else lists what lands there.
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "me avisa depois" });
    await drainOutbox(f.db, f.handlers);
    const dmRun = (await f.db.select().from(schema.agentRuns)).find((x) => x.channelId === dm.id);
    if (!dmRun) throw new Error("no DM run");
    const inDm = await setFollowUp(f, dmRun.id, 40);
    expect((await pendingReturns(f.db, f.owner.id, f.org.id)).map((x) => x.messageId)).toEqual([line, inDm]);
    expect((await pendingReturns(f.db, bia.id, f.org.id)).map((x) => x.messageId)).toEqual([line]);
    // Due 2 min ago, its wake only late (a queue backlog, a retry): it still comes, and waits on nobody's answer.
    const past = new Date(Date.now() - 2 * 60_000).toISOString();
    await f.db.execute(
      sql`update ${schema.messages} set meta = jsonb_set(meta, '{notice,refs,at}', to_jsonb(${past}::text)) where id = ${line}::uuid`,
    );
    expect((await pendingReturns(f.db, bia.id, f.org.id))[0]).toMatchObject({ messageId: line, held: false });
  });

  test("the agent's line says 'later' with its time where you read, the thread's chip its time, the task manager its row", async () => {
    f = await setup({ followUps: true });
    const root = await ask(f, "Build de produção");
    const { bia, run } = await biaAsks(f, "@dev acompanha o build", root.id);
    const line = await setFollowUp(f, run.id, 30);
    const [r] = await pendingReturns(f.db, bia.id, f.org.id);

    const work = (await agentStatuses(f.db, bia.id, f.org.id)).find((x) => x.agentId === f.agent.id)?.work;
    expect(work).toMatchObject({ state: "later", at: r?.at, channelId: f.general.id, threadId: root.id, count: 0 });
    const { threads } = await listThreads(f.db, bia.id, { orgId: f.org.id, channelId: f.general.id });
    expect(threads.find((x) => x.id === root.id)?.laterAt).toBe(r?.at ?? "missing");
    const view = await taskManager(f.db, bia.id, f.org.id);
    expect(view.followUps.map((x) => [x.messageId, x.canCancel])).toEqual([[line, true]]);

    // Someone who can't read #general hears nothing of it.
    const outsider = await addMember(f.db, f.org.id, "member", "zeca");
    await f.db
      .delete(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.userId, outsider.id)));
    const theirs = (await agentStatuses(f.db, outsider.id, f.org.id)).find((x) => x.agentId === f.agent.id);
    expect(theirs?.work ?? null).toBeNull();
    expect((await taskManager(f.db, outsider.id, f.org.id)).followUps).toEqual([]);
  });

  test("set, canceled and come: the agent's status moves (agent.status), so the lists read again", async () => {
    f = await setup({ followUps: true });
    const { bia, run } = await biaAsks(f);
    const heard: string[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
      const ev = (e as { event?: { type: string; agentId?: string } }).event;
      if (ev?.type === "agent.status" && ev.agentId === f.agent.id) heard.push("agent.status");
    });
    const first = await setFollowUp(f, run.id, 10);
    expect(heard.length).toBe(1);
    await cancelFollowUp({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, first);
    expect(heard.length).toBe(2);
    const second = await setFollowUp(f, run.id, 20);
    expect(heard.length).toBe(3);
    await wakeFollowUp({ db: f.db, pubsub: f.pubsub }, f.org.id, second);
    expect(heard.length).toBeGreaterThanOrEqual(4);
  });
});

describe("a reply that names its own tools to a person", () => {
  const tools = ["request_secret", "vault_list", "remember", "github_createPullRequest", "web-search_query"];

  test("found bare, in backticks or behind the bridge's prefix; never a one-word tool, a longer name or one the person wrote", () => {
    expect(toolsNamed("Salve no Vault (vault_list) ou me envie por `request_secret`.", tools, "")).toEqual([
      "request_secret",
      "vault_list",
    ]);
    expect(toolsNamed("Pedi com mcp__agentes__request_secret.", tools, "")).toEqual(["request_secret"]);
    expect(toolsNamed("I opened it with github_createPullRequest.", tools, "")).toEqual(["github_createPullRequest"]);
    expect(toolsNamed("Searched with web-search_query.", tools, "")).toEqual(["web-search_query"]);
    expect(toolsNamed("I remember: request_secrets and request_secret_card are other names.", tools, "")).toEqual([]);
    expect(toolsNamed("Use my_request_secret or pre-request_secret.", tools, "")).toEqual([]);
    expect(toolsNamed("Vou lembrar disso (remember).", tools, "")).toEqual([]);
    const asked = "pra que serve o request_secret?";
    expect(toolsNamed("O `request_secret` abre um campo seguro.", tools, asked)).toEqual([]);
    // Only that name is the person's: another one still counts.
    expect(toolsNamed("O `request_secret` e o vault_list.", tools, asked)).toEqual(["vault_list"]);
  });

  test("never a name in code or in an address: code a person asked for uses the same words", () => {
    const own = ["read_file", "run_code", "task_status", "request_secret"];
    const code =
      "Assim:\n```python\ndef read_file(path):\n    return open(path).read()\n```\nDepois chame read_file(path).";
    expect(toolsNamed(code, own, "como leio um arquivo em python?")).toEqual([]);
    expect(toolsNamed("```sql\nSELECT task_status, count(*) FROM tasks GROUP BY 1;\n```", own, "")).toEqual([]);
    expect(toolsNamed("See github.com/example/repo/blob/main/run_code.py for it.", own, "")).toEqual([]);
    expect(toolsNamed("Docs at https://example.com/api/request_secret and www.example.com/run_code.", own, "")).toEqual(
      [],
    );
    expect(toolsNamed("Write to ops_team@example.com or task_status@example.com.", own, "")).toEqual([]);
    // Outside the code, still a name.
    expect(toolsNamed("```\nls\n```\nThen I run it with `run_code`.", own, "")).toEqual(["run_code"]);
    // A file, the person's own code in inline code, or an address's path with no host.
    const mine = ["send_email", "create_issue", "request_secret"];
    expect(toolsNamed("Rode o send_email.py de novo e veja o log.", mine, "")).toEqual([]);
    expect(toolsNamed("Na sua função `client.send_email(to)`, o send_email recebe o destinatário.", mine, "")).toEqual(
      [],
    );
    expect(toolsNamed("O endpoint /api/create_issue respondeu 500, e /v2/send_email/ também.", mine, "")).toEqual([]);
    expect(toolsNamed("Use request_secret to send me the password.", mine, "")).toEqual(["request_secret"]);
    expect(toolsNamed("Chamei `request_secret()` e `create_issue`.", mine, "")).toEqual([
      "create_issue",
      "request_secret",
    ]);
  });

  const turn = (over: Partial<TurnEnd> = {}): TurnEnd => ({
    state: { count: 0 },
    kind: "conversation",
    executed: 0,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: "Me envie por `request_secret`.",
    mission: false,
    namedTools: ["request_secret"],
    wakesLater: async () => false,
    verdict: async () => "done",
    ...over,
  });

  test("written again once, judge or not, not counted against the nudges; never between agents nor past a bound", async () => {
    const d = await decideTurnEnd(turn());
    expect(d).toMatchObject({ outcome: "continue", rule: "tool_names" });
    expect(d.nudge).toStartWith("Not posted: your reply names your tools (`request_secret`)");
    const next = advance({ count: 0 }, d, 0);
    expect(next).toEqual({ count: 0, toolsNudged: true });
    // Told to ask, it still owes that question: the hold keeps it.
    expect(advance({ count: 1, askNudged: true, askPending: true }, d, 0)).toEqual({
      count: 1,
      askNudged: true,
      askPending: true,
      toolsNudged: true,
    });
    expect(await decideTurnEnd(turn({ state: next }))).toMatchObject({ outcome: "done", rule: "judged" });
    expect(await decideTurnEnd(turn({ verdict: null }))).toMatchObject({ rule: "tool_names" });
    expect(await decideTurnEnd(turn({ state: { count: 2 } }))).toMatchObject({ rule: "tool_names" });
    expect(await decideTurnEnd(turn({ kind: "agents_dm" }))).toMatchObject({ outcome: "done", rule: "judged" });
    expect(await decideTurnEnd(turn({ kind: "routine" }))).toMatchObject({ outcome: "done", rule: "judged" });
    expect(await decideTurnEnd(turn({ bound: "stuck" }))).toMatchObject({ outcome: "done", rule: "stuck" });
  });

  /** Only its name matters here: the secure card's tool. */
  const secrets: ToolSource = {
    name: "secrets",
    tools: async () => [
      {
        name: "request_secret",
        description: "Ask a person for a password or a key on a secure card.",
        scope: "",
        inputSchema: { type: "object" },
        execute: async () => ({ content: "asked" }),
      },
    ],
  };

  test("in a plain chat it is written again in plain words, and only that reply is posted", async () => {
    f = await setup({
      toolSources: [secrets],
      // Told to, the next call uses the tool first, then says what it did.
      reply: (_request, call): FakeReply =>
        call === 1
          ? { chunks: ["Manda a senha do painel. Salve no Vault ou me envie por `request_secret`."] }
          : call === 2
            ? { chunks: [], toolUses: [{ name: "request_secret", input: {} }] }
            : { chunks: ["Te mandei um campo seguro para a senha do painel."] },
    });
    await ask(f, "@dev entra no painel da Northwind e baixa o relatório de outubro");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(3);
    expect(lastUserText(f.provider.calls[1]?.request as ModelRequest)).toStartWith(
      "Not posted: your reply names your tools (`request_secret`)",
    );
    expect((await agentMessages(f)).map((m) => m.body)).toEqual(["Te mandei um campo seguro para a senha do painel."]);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.filter((s) => s.data.nudged === "tool_names").length).toBe(1);
  });

  const NAMED = "Me envie a senha do painel por `request_secret`.";
  const bodiesOf = async (fx: Fixture) => (await agentMessages(fx)).map((m) => m.body);
  const runRow = async (fx: Fixture) => (await fx.db.select().from(schema.agentRuns))[0];
  /** The secure way asked by a judge that reads a secret asked in the chat (`secret`), anything else as done. */
  const secretJudge = (asksInChat: string) => (kind: string, _id: string, state: Record<string, unknown>) =>
    kind === "follow_through" ? (String(state.reply).includes(asksInChat) ? "secret" : "done") : undefined;

  test("held for its wording, it is the answer when its rewrite only calls a tool and writes nothing", async () => {
    f = await setup({
      toolSources: [secrets],
      reply: (_request, call): FakeReply =>
        call === 1
          ? { chunks: [NAMED] }
          : call === 2
            ? { chunks: [], toolUses: [{ name: "request_secret", input: {} }] }
            : { chunks: [] },
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(await bodiesOf(f)).toEqual([NAMED]);
    expect((await runRow(f))?.transcript).not.toHaveProperty("heldWording");
  });

  test("held for its wording, it is the answer when its rewrite is empty: no nudge to answer on top", async () => {
    f = await setup({ toolSources: [secrets], reply: (_request, call) => ({ chunks: call === 1 ? [NAMED] : [] }) });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect(await bodiesOf(f)).toEqual([NAMED]);
  });

  test("held for its wording, it is the answer when its rewrite passes", async () => {
    f = await setup({
      toolSources: [secrets, createPassToolSource()],
      reply: (_request, call): FakeReply =>
        call === 1
          ? { chunks: [NAMED] }
          : { chunks: [], toolUses: [{ name: "pass", input: { reason: "já respondi" } }] },
    });
    await ask(f, "@dev entra no painel da Northwind");
    // Brought in by the router: it may stay quiet.
    await f.db.update(schema.agentRuns).set({ trigger: "router" });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect(await bodiesOf(f)).toEqual([NAMED]);
  });

  test("held for its wording, it goes out before the step limit's line when the rewrite runs out of steps", async () => {
    f = await setup({
      toolSources: [secrets],
      reply: (_request, call): FakeReply =>
        call === 1 ? { chunks: [NAMED] } : { chunks: [], toolUses: [{ name: "request_secret", input: {} }] },
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, createJobHandlers({ ...f.jobDeps, maxToolTurns: 3 }));
    const messages = await agentMessages(f);
    expect(messages.map((m) => m.body)).toEqual([NAMED, "I ran out of steps before finishing."]);
    expect(messages[1]?.meta.stepLimit).toBeDefined();
  });

  test("held for its wording, it is part of what a run stopped during its rewrite wrote", async () => {
    f = await setup({
      toolSources: [secrets],
      reply: (_request, call) => {
        if (call === 2) {
          const stopped = f.db
            .select()
            .from(schema.agentRuns)
            .then(([run]) => run && cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, run.id));
          return { chunks: ["Vou te mandar ", "um campo seguro."], hold: stopped };
        }
        return { chunks: [NAMED] };
      },
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(f))?.status).toBe("canceled");
    const stopped = (await agentMessages(f)).filter((m) => m.meta.canceled);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.body).toStartWith(NAMED);
    expect((stopped[0]?.meta.canceled as { text?: string } | undefined)?.text).toStartWith(NAMED);
  });

  /** Drains `rounds` times, each retry and resume due at once. */
  const drainDue = async (fx: Fixture, rounds: number) => {
    for (let i = 0; i < rounds; i++) {
      await drainOutbox(fx.db, fx.handlers);
      await fx.db
        .update(schema.outbox)
        .set({ nextAttemptAt: new Date(0) })
        .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")));
    }
  };

  test("held for its wording, it waits out an outage on the run: the rewrite is posted on resume, never both", async () => {
    const rewrite = "Te mandei um campo seguro para a senha do painel.";
    let down = true;
    f = await setup({
      toolSources: [secrets],
      reply: (_request, call) =>
        call === 1 ? { chunks: [NAMED] } : down ? new ProviderError("overloaded", true, 529) : { chunks: [rewrite] },
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainDue(f, 5);
    const parked = await runRow(f);
    expect(parked?.status).toBe("waiting_input");
    expect((parked?.transcript as { heldWording?: string } | undefined)?.heldWording).toBe(NAMED);
    expect(await bodiesOf(f)).not.toContain(NAMED);

    down = false;
    await drainDue(f, 2);
    expect((await runRow(f))?.status).toBe("done");
    const bodies = await bodiesOf(f);
    expect(bodies.filter((b) => b === rewrite)).toHaveLength(1);
    expect(bodies).not.toContain(NAMED);
  });

  test("held for its wording on a parked run, it is what the person gets when they stop it", async () => {
    f = await setup({
      toolSources: [secrets],
      reply: (_request, call) => (call === 1 ? { chunks: [NAMED] } : new ProviderError("overloaded", true, 529)),
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainDue(f, 5);
    const parked = await runRow(f);
    expect(parked?.status).toBe("waiting_input");
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, parked?.id ?? "");
    const run = await runRow(f);
    expect(run?.status).toBe("canceled");
    expect(run?.transcript).not.toHaveProperty("heldWording");
    const stopped = (await agentMessages(f)).filter((m) => m.meta.canceled);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.body).toStartWith(NAMED);
    expect((await bodiesOf(f)).filter((b) => b.startsWith(NAMED))).toHaveLength(1);
  });

  test("held for its wording on a parked run, stopped by the right hand at the person's word: the reply names both", async () => {
    f = await setup({
      rightHand: true,
      toolSources: [secrets],
      reply: (_request, call) => (call === 1 ? { chunks: [NAMED] } : new ProviderError("overloaded", true, 529)),
    });
    const [lodi] = await f.db.select().from(schema.agents).where(eq(schema.agents.builtin, RIGHT_HAND));
    if (!lodi) throw new Error("no right hand");
    await ask(f, "@dev entra no painel da Northwind");
    await drainDue(f, 5);
    const parked = await runRow(f);
    expect(parked?.status).toBe("waiting_input");
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, parked?.id ?? "", { byAgentId: lodi.id });
    const [stopped] = (await agentMessages(f)).filter((m) => m.meta.canceled);
    expect(stopped?.meta.canceled).toEqual({ byUserId: f.owner.id, byAgentId: lodi.id, text: NAMED });
    expect(stopped?.body).toBe(`${NAMED}\n\n_Stopped by ${lodi.name} for ${f.owner.name}._`);
  });

  test("stopped to read a message while parked, the held reply sits just before that message, with no stop said", async () => {
    f = await setup({
      toolSources: [secrets],
      reply: (_request, call) => (call === 1 ? { chunks: [NAMED] } : new ProviderError("overloaded", true, 529)),
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainDue(f, 5);
    const parked = await runRow(f);
    expect(parked?.status).toBe("waiting_input");
    const sent = await ask(f, "na verdade, usa a conta de vendas");
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, parked?.id ?? "", { sendMessageId: sent.id });
    const timeline = await f.db.select().from(schema.messages).orderBy(schema.messages.createdAt);
    const at = timeline.findIndex((m) => m.id === sent.id);
    expect(timeline[at - 1]?.body).toBe(NAMED);
    expect(timeline[at - 1]?.meta.canceled).toBeUndefined();
    expect((await bodiesOf(f)).filter((b) => b.includes("Stopped"))).toEqual([]);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.some((s) => s.kind === "message" && s.data.messageId === timeline[at - 1]?.id)).toBe(true);
  });

  describe("the right hand's held reply with a key in it", () => {
    const key = `sk-ant-oat01-${"x".repeat(24)}`;
    const note = "[removido: parecia um login ou uma chave]";
    const said = `Aqui está: ${key} e {"refresh_token": "abcdefgh12345678"}. Me mande a senha por \`request_secret\`.`;
    const shown = `Aqui está: ${note} e {"refresh_token": ${note}}. Me mande a senha por \`request_secret\`.`;
    const inRightHandDm = async (rewrite: () => FakeReply | Error) => {
      f = await setup({
        rightHand: true,
        toolSources: [secrets],
        reply: (_request, call) => (call === 1 ? { chunks: [said] } : rewrite()),
      });
      const [lodi] = await f.db.select().from(schema.agents).where(eq(schema.agents.builtin, RIGHT_HAND));
      if (!lodi) throw new Error("no right hand");
      await f.db.update(schema.users).set({ locale: "pt-BR" }).where(eq(schema.users.id, f.owner.id));
      const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
      await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
        body: "me ajuda a entrar no painel",
      });
      return lodi;
    };
    const lodiBodies = async (agentId: string) =>
      (await f.db.select().from(schema.messages).orderBy(schema.messages.createdAt))
        .filter((m) => m.authorAgentId === agentId)
        .map((m) => m.body);

    test("held, parked and stopped by the person: what is posted has the key taken out", async () => {
      const lodi = await inRightHandDm(() => new ProviderError("overloaded", true, 529));
      await drainDue(f, 5);
      const [parked] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, lodi.id));
      expect(parked?.status).toBe("waiting_input");
      expect((parked?.transcript as { heldWording?: string } | undefined)?.heldWording).toBe(shown);
      await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, parked?.id ?? "");
      const bodies = await lodiBodies(lodi.id);
      expect(bodies.join("\n")).not.toContain("sk-ant-");
      expect(bodies.join("\n")).not.toContain("abcdefgh12345678");
      expect(bodies.filter((b) => b.startsWith(shown))).toHaveLength(1);
    });

    test("held, then posted when its rewrite fails: taken out once, still readable", async () => {
      const lodi = await inRightHandDm(() => new ProviderError("overloaded", false, 529));
      await drainOutbox(f.db, f.handlers);
      expect(await lodiBodies(lodi.id)).toEqual([shown]);
    });
  });

  test("held for its wording, an emoji that only repeats the rewrite's reaction doesn't replace it", async () => {
    f = await setup({
      react: true,
      toolSources: [secrets],
      reply: (_request, call): FakeReply =>
        call === 1
          ? { chunks: [NAMED] }
          : call === 2
            ? { chunks: [], toolUses: [{ name: "react", input: { emoji: "👍" } }] }
            : { chunks: ["👍"] },
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(await bodiesOf(f)).toEqual([NAMED]);
  });

  test("a card is its next step: a reply held for its wording no longer stands in for an answer", async () => {
    f = await setup({
      askUser: true,
      toolSources: [secrets],
      reply: (_request, call): FakeReply =>
        call === 1
          ? { chunks: [NAMED] }
          : {
              chunks: [],
              toolUses: [
                {
                  name: "ask_user",
                  input: {
                    why: "I need a person's answer before I go on: only they know which account to use.",
                    question: "Qual conta do painel?",
                    choices: ["financeiro", "vendas"],
                  },
                },
              ],
            },
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, f.handlers);
    const run = await runRow(f);
    expect(run?.status).toBe("waiting_input");
    expect(run?.transcript).not.toHaveProperty("heldWording");
    expect(await bodiesOf(f)).not.toContain(NAMED);
  });

  test("a reply held as a secret asked in the chat is never posted, even when the rewrite writes nothing", async () => {
    const inChat = "Cole aqui a senha do painel, ou use `request_secret`.";
    f = await setup({
      judge: secretJudge("Cole aqui"),
      toolSources: [secrets],
      reply: (_request, call): FakeReply =>
        call === 1
          ? { chunks: [inChat] }
          : call === 2
            ? { chunks: [], toolUses: [{ name: "request_secret", input: {} }] }
            : { chunks: [] },
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect((await bodiesOf(f)).join("\n")).not.toContain("Cole aqui");
    expect((await f.db.select().from(schema.agentRunSteps)).filter((s) => s.data.nudged === "secret")).toHaveLength(1);
  });

  test("a secret asked in the chat that also names a tool is held as a secret, never as wording a failure would post", async () => {
    const inChat = "Cole aqui a senha do painel, ou use `request_secret`.";
    f = await setup({
      judge: secretJudge("Cole aqui"),
      toolSources: [secrets],
      reply: (_request, call) => (call === 1 ? { chunks: [inChat] } : new ProviderError("overloaded", false, 529)),
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect((await bodiesOf(f)).join("\n")).not.toContain("Cole aqui");
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.filter((s) => s.data.nudged === "secret")).toHaveLength(1);
    expect(steps.filter((s) => s.data.nudged === "tool_names")).toEqual([]);
  });

  test("held for its wording, then its rewrite held as a secret, then a failure: only the first reply is posted", async () => {
    const inChat = "Cole aqui a senha do painel.";
    f = await setup({
      judge: secretJudge("Cole aqui"),
      toolSources: [secrets],
      reply: (_request, call) =>
        call === 1
          ? { chunks: [NAMED] }
          : call === 2
            ? { chunks: [inChat] }
            : new ProviderError("overloaded", false, 529),
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(3);
    expect(await bodiesOf(f)).toEqual([NAMED]);
  });

  test("its rewrite failing, the held reply is still the answer: posted, never lost", async () => {
    const answer = "Me envie a senha do painel por `request_secret`.";
    f = await setup({
      toolSources: [secrets],
      reply: (_request, call) => (call === 1 ? { chunks: [answer] } : new ProviderError("overloaded", false, 529)),
    });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBeGreaterThanOrEqual(2);
    expect((await agentMessages(f)).map((m) => m.body)).toEqual([answer]);
  });

  test("at the turn cap it has no turn left: the reply is posted as written", async () => {
    const answer = "Me envie a senha do painel por `request_secret`.";
    f = await setup({ toolSources: [secrets], reply: () => ({ chunks: [answer] }) });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, createJobHandlers({ ...f.jobDeps, maxToolTurns: 1 }));
    expect(f.provider.calls.length).toBe(1);
    expect((await agentMessages(f)).map((m) => m.body)).toEqual([answer]);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.filter((s) => s.data.nudged === "tool_names")).toEqual([]);
  });

  test("between agents it is posted as it is: another agent can use the name", async () => {
    const answer = "Use `request_secret` com o nome da chave do painel.";
    f = await setup({
      askAgent: true,
      toolSources: [secrets],
      reply: (request) => {
        if (systemText(request.system).includes("You are Infra (@infra)")) return { chunks: [answer] };
        if (JSON.stringify(request.messages.at(-1)?.content).includes("tool_result")) return { chunks: ["Perguntei."] };
        return {
          chunks: [],
          toolUses: [{ name: "tell_agent", input: { agent: "@infra", message: "Como peço a senha do painel?" } }],
        };
      },
    });
    const infra = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Infra", handle: "infra", role: "Operations", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await ask(f, "@dev pergunta ao infra como pedir a senha do painel");
    await drainOutbox(f.db, f.handlers);
    const infraBodies = (await agentMessages(f)).filter((m) => m.authorAgentId === infra.id).map((m) => m.body);
    expect(infraBodies).toContain(answer);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.filter((s) => s.data.nudged === "tool_names")).toEqual([]);
  });

  test("once per run: a rewrite that still names it is posted as written", async () => {
    const answer = "Me envie a senha por `request_secret`.";
    f = await setup({ toolSources: [secrets], reply: () => ({ chunks: [answer] }) });
    await ask(f, "@dev entra no painel da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect((await agentMessages(f)).map((m) => m.body)).toEqual([answer]);
  });

  test("a person who wrote the name, or chose technical replies, gets the reply as it is", async () => {
    const answer = "O `request_secret` abre um campo seguro: você digita a senha ali e eu nunca a vejo.";
    f = await setup({ toolSources: [secrets], reply: () => ({ chunks: [answer] }) });
    await ask(f, "@dev pra que serve o request_secret?");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(1);

    await saveAgentStyle(f.db, f.org.id, f.owner.id, "technical");
    await ask(f, "@dev e como você me pede uma senha?");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect((await agentMessages(f)).map((m) => m.body)).toEqual([answer, answer]);
  });
});

describe("a turn end's reads and judgment", () => {
  const WAIT = 250;
  const slowly = <T>(value: T) => Bun.sleep(WAIT).then(() => value);
  const turn = (over: Partial<TurnEnd> = {}): TurnEnd => ({
    state: { count: 0 },
    kind: "conversation",
    executed: 0,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: "Vou checar o deploy e já volto.",
    mission: false,
    wakesLater: () => slowly(false),
    comesBack: () => slowly(false),
    verdict: () => slowly("continue" as const),
    ...over,
  });
  const timed = async (t: TurnEnd) => {
    const started = performance.now();
    const d = await decideTurnEnd(t);
    return { d, ms: performance.now() - started };
  };

  test("overlap: what the judgment reads starts beside `wakes_later`; `comes_back` is read only after a continue", async () => {
    let prepared = 0;
    let judgedAt = 0;
    const started = performance.now();
    const { d, ms } = await timed(
      turn({
        prepare: () => {
          prepared++;
        },
        verdict: () => {
          judgedAt = performance.now() - started;
          return slowly("continue" as const);
        },
      }),
    );
    expect(d).toMatchObject({ outcome: "continue", rule: "promise" });
    expect(prepared).toBe(1);
    expect(judgedAt).toBeGreaterThanOrEqual(WAIT - 5);
    // wakes_later, the judgment, then comes_back: a read most turn ends (a done) never pay for.
    expect(ms).toBeGreaterThanOrEqual(3 * WAIT - 5);
    expect(ms).toBeLessThan(4 * WAIT);
  });

  test("the rules keep their order, and something that brings it back still spares the judgment", async () => {
    let judged = 0;
    const counted = () => {
      judged++;
      return slowly("continue" as const);
    };
    expect((await timed(turn({ wakesLater: () => slowly(true), verdict: counted }))).d).toMatchObject({
      outcome: "waiting",
      rule: "wakes_later",
    });
    expect(judged).toBe(0);
    // A promise something keeps here rests on it.
    expect((await timed(turn({ comesBack: () => slowly(true) }))).d).toMatchObject({
      outcome: "waiting",
      rule: "comes_back",
    });
    // Read only for a promise in a person's conversation.
    expect(
      (await timed(turn({ comesBack: () => slowly(true), verdict: () => slowly("done" as const) }))).d,
    ).toMatchObject({ outcome: "done", rule: "judged" });
    expect((await timed(turn({ kind: "agents_dm", comesBack: () => slowly(true) }))).d).toMatchObject({
      outcome: "continue",
      rule: "promise",
    });
    // A failed judgment, or a failed read, is what it always was (only the platform cap checks itself: below).
    expect((await timed(turn({ verdict: () => Promise.reject(new Error("down")) }))).d).toMatchObject({
      outcome: "done",
      rule: "judge_error",
    });
    expect((await timed(turn({ wakesLater: () => Promise.reject(new Error("db")) }))).d).toMatchObject({
      outcome: "continue",
      rule: "promise",
    });
  });

  test("a check refused past the platform cap: once per run the agent checks itself, held in an agents' DM; then done", async () => {
    const down = () => Promise.reject(new Error(PLATFORM_CAP));
    const evidence = { means: ["terminal (run_code)"], tried: ["github_get_issue #12 → ok"] };
    const first = await decideTurnEnd(turn({ verdict: down, evidence }));
    expect(first).toMatchObject({ outcome: "continue", rule: "untried", judgeError: true });
    // A person's conversation got the reply already (the executor posts it and wraps this in `shownNudge`).
    expect(first.nudge).not.toContain("Not posted yet");
    expect((await decideTurnEnd(turn({ kind: "agents_dm", verdict: down, evidence }))).nudge).toStartWith(
      "Not posted yet",
    );
    expect(first.nudge).toContain("check it yourself");
    expect(first.nudge).toContain("terminal (run_code)");
    expect(first.nudge).toContain("github_get_issue #12");
    const state = advance({ count: 0 }, first, 1);
    expect(state).toMatchObject({ count: 1, uncheckedNudged: true });
    // Bounded: the next failure ends the run as before, even with a nudge left.
    expect(await decideTurnEnd(turn({ state, verdict: down }))).toMatchObject({
      outcome: "done",
      rule: "judge_error",
    });
    // A routine's record isn't posted: nothing to hold.
    const routine = await decideTurnEnd(turn({ kind: "routine", verdict: down }));
    expect(routine).toMatchObject({ outcome: "continue", rule: "untried", judgeError: true });
    expect(routine.nudge).not.toContain("Not posted yet");
    // Out of the turn end's wait (a slow judge), or no judge at all (no Jev key, no small model): done at once.
    expect(await decideTurnEnd(turn({ verdict: () => Promise.reject(new JudgeBudgetError()) }))).toMatchObject({
      outcome: "done",
      rule: "judge_error",
    });
    const noJudge = withJudgeFallback(
      {
        name: "jev",
        ask: () => Promise.reject(new JevOffError()),
      },
      createLlmJudge({
        gateway: { complete: () => Promise.reject(new Error("unused")) },
        resolveModel: async () => null,
      }),
    );
    const askNoJudge = () => noJudge.ask({ orgId: "org-1", kind: "continuation", state: {}, questions: {} });
    expect(await askNoJudge().catch((e: unknown) => e)).toBeInstanceOf(JevOffError);
    expect(await decideTurnEnd(turn({ verdict: () => askNoJudge().then(() => "done" as const) }))).toMatchObject({
      outcome: "done",
      rule: "judge_error",
    });
  });
});
