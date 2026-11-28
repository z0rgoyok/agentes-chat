import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  ASK_TARGET_MS,
  type AskRow,
  askKindOf,
  askMeasures,
  askRunStatus,
  askSpeedOf,
  createAgent,
  createJevJudge,
  drainOutbox,
  JudgeGroup,
  judgeAskKind,
  openDm,
  operatorAskTimes,
  postPersonMessage,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close?.();
  f = undefined;
});

const now = new Date("2026-11-26T12:00:00Z");
const row = (over: Partial<AskRow> = {}): AskRow => ({
  asked: new Date("2026-11-26T11:00:00Z"),
  kind: null,
  chars: 40,
  runs: 1,
  agents: 1,
  tools: 0,
  brain: "claude_code",
  model: "claude-opus-5-5",
  activityMs: 3_000,
  replyMs: 4_000,
  doneMs: 4_500,
  open: false,
  lastStatus: "done",
  lastError: null,
  ...over,
});

test("an ask Jev didn't read takes its kind from what its work did", () => {
  expect(askKindOf(row({ chars: 2 }))).toBe("chat");
  expect(askKindOf(row({ chars: 40 }))).toBe("question");
  expect(askKindOf(row({ tools: 3 }))).toBe("lookup");
  expect(askKindOf(row({ tools: 4 }))).toBe("task");
  expect(askKindOf(row({ kind: "action", tools: 9 }))).toBe("action");
  // A kind this release doesn't know falls back too.
  expect(askKindOf(row({ kind: "poem", tools: 0, chars: 3 }))).toBe("chat");
});

test("the speed index weighs each reply by its kind's target; setups, stops and passes don't count", () => {
  const chat = ASK_TARGET_MS.chat;
  expect(askSpeedOf(row({ chars: 2, replyMs: chat }), now)).toBe("satisfied");
  expect(askSpeedOf(row({ chars: 2, replyMs: chat + 1 }), now)).toBe("tolerating");
  expect(askSpeedOf(row({ chars: 2, replyMs: 4 * chat + 1 }), now)).toBe("frustrated");
  // The same 30 s is fine for a task.
  expect(askSpeedOf(row({ kind: "task", replyMs: 30_000 }), now)).toBe("satisfied");
  expect(askSpeedOf(row({ replyMs: null, lastStatus: "failed", lastError: "cli_failed: boom" }), now)).toBe(
    "frustrated",
  );
  expect(askSpeedOf(row({ replyMs: null, lastStatus: "failed", lastError: "no_ai" }), now)).toBeNull();
  expect(askSpeedOf(row({ replyMs: null, lastStatus: "canceled" }), now)).toBeNull();
  expect(askSpeedOf(row({ replyMs: null }), now)).toBeNull();
  // Still without a reply: within four times its target it may yet come, past it frustrates.
  const fresh = new Date(now.getTime() - 10_000);
  expect(askSpeedOf(row({ asked: fresh, replyMs: null, open: true, lastStatus: "running" }), now)).toBeNull();
  expect(askSpeedOf(row({ replyMs: null, open: true, lastStatus: "running" }), now)).toBe("frustrated");

  const m = askMeasures(
    [
      row({ replyMs: 1_000 }),
      row({ replyMs: 20_000 }),
      row({ replyMs: 90_000, agents: 2, runs: 3 }),
      row({ replyMs: null, lastStatus: "failed", lastError: "no_ai" }),
    ],
    now,
  );
  expect(m).toMatchObject({
    asks: 4,
    index: 50,
    satisfied: 1,
    tolerating: 1,
    frustrated: 1,
    multiAgent: 1,
    runsPerAsk: 1.5,
    outcomes: { done: 3, setup: 1 },
  });
  // The setup is no wait: it stays out of the times.
  expect(m.firstReply).toEqual({ p50Ms: 20_000, p90Ms: 90_000 });
});

test("the ask's kind goes to Jev in the run's start request, with the status line, and nothing waits on it alone", async () => {
  const sent: { questions: Record<string, unknown> }[] = [];
  const jev = createJevJudge({
    key: "tk",
    gateway: { recordExternalUsage: async () => null },
    fetch: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      sent.push(body);
      return Response.json({
        answers: {
          ask_kind__kind: { choice: "action", probabilities: { action: 0.7, task: 0.2 } },
          agent_status__status_line: { choice: "none", probabilities: {} },
        },
      });
    }) as unknown as typeof fetch,
  });
  const input = {
    orgId: "o",
    agentId: "a",
    runId: "r",
    agent: { name: "Ada", role: "Ops", instructions: "" },
    message: "manda o link pro time",
    recent: [],
  };
  const group = new JudgeGroup(["agent_status", "ask_kind"], 10_000);
  const [kind] = await Promise.all([
    judgeAskKind(jev, { ...input, group }),
    askRunStatus(jev, { ...input, group, candidates: [{ key: "c0", kind: "channel", subject: "geral", text: "x" }] }),
  ]);
  expect(sent).toHaveLength(1);
  expect(Object.keys(sent[0]?.questions ?? {})).toContain("ask_kind__kind");
  expect(kind).toEqual({ kind: "action", p: 0.7 });
  // Not sure enough: no kind is kept, and the read falls back to what the work did.
  const unsure = createJevJudge({
    key: "tk",
    gateway: { recordExternalUsage: async () => null },
    fetch: (async () =>
      Response.json({
        answers: { kind: { choice: "task", probabilities: { task: 0.4 } } },
      })) as unknown as typeof fetch,
  });
  expect(await judgeAskKind(unsure, input)).toBeNull();
});

test("a person's ask is read by Jev as its run starts, and its stretch is timed as one task", async () => {
  f = await setup({
    judge: (kind, id) =>
      kind === "ask_kind" && id === "kind" ? { choice: "lookup", probabilities: { lookup: 0.8 } } : undefined,
  });
  const { db, org, owner, agent } = f;
  const dm = await openDm(db, owner.id, org.id, { agentId: agent.id });
  const asked = await postPersonMessage({ db, pubsub: f.pubsub }, owner.id, org.id, dm.id, {
    body: "qual o status do pedido 4512?",
  });
  await drainOutbox(db, f.handlers);
  const kinds = await db.select().from(schema.askKinds);
  expect(kinds).toMatchObject([{ messageId: asked.id, orgId: org.id, kind: "lookup" }]);
  expect(kinds[0]?.p).toBeCloseTo(0.8);
  // Another agent the first one handed work to, in the same stretch: the same ask.
  const rio = await createAgent(
    db,
    owner.id,
    org.id,
    { name: "Rio", handle: "rio", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const [first] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked.id));
  const [note] = await db
    .insert(schema.messages)
    .values({
      orgId: org.id,
      channelId: dm.id,
      authorType: "agent",
      authorAgentId: agent.id,
      body: "@rio olha isso",
      hop: 1,
      stretchId: asked.id,
      agentRunId: first?.id,
    })
    .returning();
  await db.insert(schema.agentRuns).values({
    orgId: org.id,
    agentId: rio.id,
    channelId: dm.id,
    threadRootId: note?.id as string,
    triggerMessageId: note?.id as string,
    trigger: "mention",
    hop: 2,
    stretchId: asked.id,
    status: "done",
    finishedAt: new Date(Date.now() + 60_000),
  });

  const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
  const read = await operatorAskTimes(db, { from: day(-1), to: day(1) });
  expect(read.totals).toMatchObject({ asks: 1, judged: 1, multiAgent: 1, runsPerAsk: 2 });
  const lookup = read.kinds.find((k) => k.kind === "lookup");
  expect(lookup).toMatchObject({ asks: 1, targetMs: ASK_TARGET_MS.lookup, satisfied: 1 });
  expect(lookup?.firstReply.p50Ms).toBeGreaterThanOrEqual(0);
  // Done when the last run of the stretch ended, a minute later.
  expect(lookup?.done.p50Ms).toBeGreaterThan(55_000);
  expect(read.series.map((s) => s.kind)).toEqual(["all", "lookup"]);
  // Only that workspace's, when asked for one.
  const other = await operatorAskTimes(db, { from: day(-1), to: day(1), orgId: crypto.randomUUID() });
  expect(other.totals.asks).toBe(0);
});

test("an agent's own message (a routine's report) starts no ask, and a window too long is refused", async () => {
  f = await setup({
    judge: (kind) => (kind === "ask_kind" ? { choice: "task", probabilities: { task: 0.9 } } : undefined),
  });
  const { db, org, agent, general } = f;
  const [report] = await db
    .insert(schema.messages)
    .values({ orgId: org.id, channelId: general.id, authorType: "agent", authorAgentId: agent.id, body: "relatório" })
    .returning();
  const id = report?.id as string;
  await db.insert(schema.agentRuns).values({
    orgId: org.id,
    agentId: agent.id,
    channelId: general.id,
    threadRootId: id,
    triggerMessageId: id,
    trigger: "mention",
    hop: 1,
    status: "done",
  });
  const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
  expect((await operatorAskTimes(db, { from: day(-1), to: day(1) })).totals.asks).toBe(0);
  expect(operatorAskTimes(db, { from: day(-40), to: day(0) })).rejects.toBeInstanceOf(ValidationError);
});
