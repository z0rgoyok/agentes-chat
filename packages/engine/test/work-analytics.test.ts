import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, rowsOf, schema, sql } from "@agenteschat/db";
import { conditionWords, issuedBy } from "@agenteschat/db/testing";
import { summedCostNanoUsd } from "@agenteschat/providers";
import {
  createAgent,
  createOrganization,
  operatorOrgWorkAnalytics,
  operatorWorkAnalytics,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
let rio: { id: string };
let nova: { id: string };
let novaAgent: { id: string };
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000);
const today = new Date(now).toISOString().slice(0, 10);
const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
const range = { from: yesterday, to: today };
const plan = { input: 1_000, output: 3_000, cacheRead: 466_000, cacheWrite: 46_000 };

beforeAll(async () => {
  f = await setup();
  const { db, org, agent, owner, general } = f;
  rio = await createAgent(
    db,
    owner.id,
    org.id,
    {
      name: "Rio",
      handle: "rio",
      role: "Reviewer",
      instructions: "Review.",
      credentialId: f.credential.id,
    },
    { model: "claude-sonnet-5-5" },
  );
  const made = await createOrganization(db, owner.id, { name: "Nova" });
  nova = made.organization;
  novaAgent = await createAgent(
    db,
    owner.id,
    nova.id,
    { name: "Acme", handle: "acme" },
    { model: "claude-sonnet-5-5" },
  );

  // A trigger is written before its run, a reply after it (the read bounds the messages' partitions by both).
  const message = async (author: "person" | "agent", at: Date, meta: Record<string, unknown> = {}) => {
    const [m] = await db
      .insert(schema.messages)
      .values({
        orgId: org.id,
        channelId: general.id,
        authorType: author,
        ...(author === "person" ? { authorUserId: owner.id } : { authorAgentId: agent.id, hop: 1 }),
        body: "x",
        meta,
        createdAt: at,
      })
      .returning();
    return m as { id: string };
  };
  const run = async (
    trigger: { id: string },
    values: Partial<typeof schema.agentRuns.$inferInsert> & { createdAt: Date },
  ) => {
    const [r] = await db
      .insert(schema.agentRuns)
      .values({
        orgId: org.id,
        agentId: agent.id,
        channelId: general.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        trigger: "mention",
        hop: 1,
        ...values,
      })
      .returning();
    return r as { id: string };
  };
  const step = (runId: string, seq: number, at: Date, data: Record<string, unknown>, orgId = org.id) =>
    db.insert(schema.agentRunSteps).values({ orgId, runId, seq, kind: "error", data, createdAt: at });
  const busy = { reason: "brain_unavailable", code: "busy" };

  // A person's ask answered a minute later, with a plan's tokens and a workspace key's.
  const answered = await run(await message("person", ago(2)), { createdAt: ago(2), status: "done" });
  const reply = await message("agent", ago(1));
  await db.update(schema.agentRuns).set({ replyMessageId: reply.id }).where(eq(schema.agentRuns.id, answered.id));
  // It waited a minute on its provider, then kept its stage profile and how its two computer turns started.
  await step(answered.id, 1, ago(2), { reason: "provider_outage", message: "x", parked: 1 });
  await db
    .insert(schema.agentRunSteps)
    .values({ orgId: org.id, runId: answered.id, seq: 2, kind: "model_call", data: {}, createdAt: ago(1) });
  await db
    .update(schema.agentRuns)
    .set({
      // Read from the column only: the transcript's older copy is never decompressed for analytics.
      transcript: {
        profiles: [{ stages: [{ stage: "transcript", ms: 1, queries: 0 }], total: { ms: 1, queries: 0 } }],
      },
      profiles: [
        {
          stages: [
            { stage: "claim", ms: 10, queries: 1 },
            { stage: "context", ms: 200, queries: 5 },
            { stage: "model#1", ms: 3000, queries: 0 },
            { stage: "model#2", ms: 1000, queries: 0 },
          ],
          total: { ms: 4210, queries: 6 },
          brain: [
            { warm: false, initMs: 4000, firstEventMs: 6000 },
            { warm: true, firstEventMs: 800 },
          ],
        },
      ],
    })
    .where(eq(schema.agentRuns.id, answered.id));
  // Agent to agent, three times: another agent's message, a reply two hops deep, and another agent's answer
  // that the asker posts to itself.
  await run(await message("agent", ago(28)), { agentId: rio.id, createdAt: ago(28), status: "done", hop: 2 });
  await run(await message("person", ago(27)), { agentId: rio.id, createdAt: ago(27), status: "canceled", hop: 3 });
  const answer = await message("agent", ago(26), { notice: { kind: "consult_reply", text: "x" } });
  await run(answer, { createdAt: ago(26), status: "done" });
  // The agent's own follow-up coming due: neither another agent nor a person.
  const due = await message("agent", ago(25), { notice: { kind: "follow_up", text: "x" } });
  await run(due, { createdAt: ago(25), status: "done" });
  // A routine's run waited 8 minutes for room, then gave up; a person's waits since 5 minutes ago.
  const routine = await message("person", ago(20), { routine: { id: "r", name: "r", runId: "r" } });
  const routineRun = await run(routine, {
    createdAt: ago(20),
    status: "failed",
    error: "computer_busy",
    background: true,
    finishedAt: ago(2),
  });
  await step(routineRun.id, 1, ago(10), busy);
  await step(routineRun.id, 2, ago(2), { reason: "other" });
  const waiting = await message("person", ago(6));
  const waitingRun = await run(waiting, { createdAt: ago(6), status: "waiting_input" });
  await step(waitingRun.id, 1, ago(5), busy);
  // No AI, a budget spent, a server error and long work in the background.
  await run(await message("person", ago(4)), { createdAt: ago(4), status: "failed", error: "no_ai" });
  await run(await message("person", ago(4)), { createdAt: ago(4), status: "failed", error: "budget_exceeded" });
  await run(await message("person", ago(3)), {
    createdAt: ago(3),
    status: "failed",
    error: "provider_error: overloaded",
  });
  await run(await message("person", ago(2)), { createdAt: ago(2), status: "running", background: true });
  // Out of the dates.
  await run(await message("person", ago(3 * 1440)), { createdAt: ago(3 * 1440), status: "done" });

  // Nova's two turns wait together while ours does: Nova's peak is 2, everyone's 4.
  for (const min of [7, 6]) {
    // Their trigger is gone.
    const gone = crypto.randomUUID();
    const values: typeof schema.agentRuns.$inferInsert = {
      orgId: nova.id,
      agentId: novaAgent.id,
      channelId: (made as { general: { id: string } }).general.id,
      threadRootId: gone,
      triggerMessageId: gone,
      trigger: "mention",
      hop: 1,
      createdAt: ago(min),
      status: "waiting_input",
    };
    const [r] = await db.insert(schema.agentRuns).values(values).returning();
    await step((r as { id: string }).id, 1, ago(4), busy, nova.id);
  }

  const usage = (values: Partial<typeof schema.usageRecords.$inferInsert>) =>
    db.insert(schema.usageRecords).values({
      orgId: org.id,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      requestedModel: "claude-sonnet-5-5",
      inputTokens: 0,
      outputTokens: 0,
      costNanoUsd: 0,
      createdAt: ago(29),
      ...values,
    });
  await usage({
    agentId: agent.id,
    runId: answered.id,
    billedTo: "plan",
    provider: "claude_code",
    model: "claude-sonnet-5-5[1m]",
    inputTokens: plan.input,
    outputTokens: plan.output,
    cacheReadTokens: plan.cacheRead,
    cacheWriteTokens: plan.cacheWrite,
  });
  await usage({
    agentId: rio.id,
    runId: answered.id,
    credentialId: f.credential.id,
    inputTokens: 100,
    outputTokens: 10,
    costNanoUsd: 2_000_000,
  });
  // The router on this server's key, Nova's agentless call, and usage out of the dates.
  await usage({ kind: "router", inputTokens: 50, outputTokens: 1, costNanoUsd: 1_000 });
  await usage({ orgId: nova.id, kind: "router", inputTokens: 7, costNanoUsd: 10 });
  // This server's own service, paid by the platform.
  await usage({ billedTo: "platform", kind: "embedding", inputTokens: 3 });
  await usage({ agentId: agent.id, inputTokens: 999, createdAt: ago(3 * 1440) });
});
afterAll(() => f?.close());

test("turns by origin and outcome, waits, replies and tokens by who pays, fleet-wide", async () => {
  const got = await operatorWorkAnalytics(f.db, range);
  const equivalent =
    summedCostNanoUsd("claude-sonnet-5-5", {
      inputTokens: plan.input,
      outputTokens: plan.output,
      cacheReadTokens: plan.cacheRead,
      cacheWriteTokens: plan.cacheWrite,
    }) / 1e9;
  expect(got.bucket).toBe("hour");
  expect(got.totals.turns).toEqual({
    total: 13,
    person: 5,
    agent: 3,
    routine: 1,
    longWork: 1,
    followUp: 1,
    // Nova's runs, their trigger gone.
    other: 2,
    done: 4,
    canceled: 1,
    active: 4,
    failed: 4,
    computerBusy: 1,
    noAi: 1,
    paused: 1,
    failedOther: 1,
  });
  expect(got.totals.waits).toEqual({
    waited: 4,
    peakWaiting: 4,
    personReplies: 1,
    personFailed: 3,
    replyMedianSec: 60,
    replyP90Sec: 60,
  });
  expect(got.totals.tokens).toMatchObject({ input: 1_160, output: 3_011, cacheRead: 466_000, cacheWrite: 46_000 });
  expect(got.totals.tokens.costUsd).toBeCloseTo(0.002001, 6);
  expect(got.totals.tokens.apiEquivalentUsd).toBeCloseTo(0.002001 + equivalent, 5);
  expect(got.totals.byPayer.map((p) => p.payer)).toEqual(["plan", "workspace_key", "platform_key", "platform"]);
  expect(got.totals.byPayer[0]?.costUsd).toBe(0);
  expect(got.totals.byPayer[0]?.apiEquivalentUsd).toBeCloseTo(equivalent, 5);
  expect(got.totals.turnsWithUsage).toBe(1);
  expect(got.totals.perTurn.cacheRead).toBe(466_000);
  // Only usage made in a run: not the router's or the embeddings'.
  expect(got.totals.perTurn.input).toBe(1_100);
  expect(got.series.reduce((n, s) => n + s.turns.total, 0)).toBe(13);
  expect(got.series.every((s) => /^\d{4}-\d\d-\d\dT\d\d$/.test(s.at))).toBe(true);
  expect(got.workspaces.map((w) => w.orgId)).toEqual([f.org.id, nova.id]);
  expect(got.workspaces[0]?.agentShare).toBeCloseTo(3 / 11, 3);
  expect(got.workspaces.map((w) => w.waits.peakWaiting)).toEqual([2, 2]);
  expect(got.workspaces[1]?.tokens.input).toBe(7);
  expect(got.more).toBe(false);
});

test("waits by cause, how computer turns started and where a run's time went", async () => {
  const { totals } = await operatorWorkAnalytics(f.db, range);
  const busy = totals.waitsByCause.find((c) => c.cause === "brain_unavailable:busy");
  expect(busy?.waits).toBe(4);
  expect(busy?.medianSec).toBeGreaterThanOrEqual(270);
  expect(totals.waitsByCause.find((c) => c.cause === "provider_outage")).toEqual({
    cause: "provider_outage",
    waits: 1,
    medianSec: 60,
    p90Sec: 60,
  });
  expect(totals.computerStarts).toEqual({
    turns: 2,
    warm: 1,
    initMedianMs: 4000,
    initP90Ms: 4000,
    warmFirstEventMedianMs: 800,
    warmFirstEventP90Ms: 800,
    coldFirstEventMedianMs: 6000,
    coldFirstEventP90Ms: 6000,
  });
  expect(totals.stages).toEqual([
    { stage: "model", runs: 2, medianMs: 2000, p90Ms: 2800 },
    { stage: "context", runs: 1, medianMs: 200, p90Ms: 200 },
    { stage: "claim", runs: 1, medianMs: 10, p90Ms: 10 },
  ]);
  const theirs = await operatorOrgWorkAnalytics(f.db, nova.id, range);
  expect(theirs.totals.computerStarts.turns).toBe(0);
  expect(theirs.totals.stages).toEqual([]);
});

test("a computer's waits and a provider's in one answer, across workspaces and in one", async () => {
  const provider = { cause: "provider_outage", waits: 1, medianSec: 60, p90Sec: 60 };
  expect((await operatorWorkAnalytics(f.db, range)).totals.waitsByCause).toMatchObject([
    { cause: "brain_unavailable:busy", waits: 4 },
    provider,
  ]);
  expect((await operatorOrgWorkAnalytics(f.db, f.org.id, range)).totals.waitsByCause).toMatchObject([
    { cause: "brain_unavailable:busy", waits: 2 },
    provider,
  ]);
  expect((await operatorOrgWorkAnalytics(f.db, nova.id, range)).totals.waitsByCause).toMatchObject([
    { cause: "brain_unavailable:busy", waits: 2 },
  ]);
});

test("each cause's waits are asked for in the words of the index that finds them, every read bounded in time", async () => {
  const issued = await issuedBy(() => operatorWorkAnalytics(f.db, range));
  // The planner reads a run's waits through a partial index only when the statement holds that index's condition.
  const conditions = rowsOf<{ condition: string }>(
    await f.db.execute(
      sql`select pg_get_expr(indpred, indrelid) as condition from pg_index where indexrelid in
        ('agent_run_steps_run_id_index'::regclass, 'agent_run_steps_provider_outage_idx'::regclass)`,
    ),
  ).map((index) => conditionWords(index.condition));
  expect(conditions.length).toBe(2);
  const byCause = issued.filter((statement) => statement.includes(" as cause"));
  expect(byCause.length).toBe(1);
  for (const condition of conditions) expect(conditionWords(byCause[0] ?? "")).toContain(condition);

  const set = (setting: string) => issued.filter((statement) => statement === `set local ${setting}`).length;
  expect([set("jit = off"), set("statement_timeout = '20s'")]).toEqual([6, 6]);
});

test("one workspace, per agent; by day past two days; at most 90 days", async () => {
  const got = await operatorOrgWorkAnalytics(f.db, f.org.id, range);
  expect(got.orgId).toBe(f.org.id);
  expect(got.agents.map((a) => [a.agentId, a.turns.total])).toEqual([
    [f.agent.id, 9],
    [rio.id, 2],
  ]);
  // The router's call is the workspace's, not an agent's.
  expect(got.totals.tokens.input).toBe(1_153);
  expect(got.agents.reduce((n, a) => n + a.tokens.input, 0)).toBe(1_100);
  expect(got.agents[1]?.turns.agent).toBe(2);

  const week = await operatorOrgWorkAnalytics(f.db, f.org.id, {
    from: new Date(now - 6 * 86_400_000).toISOString().slice(0, 10),
    to: today,
  });
  expect(week.bucket).toBe("day");
  expect(week.totals.turns.total).toBe(12);
  const theirs = await operatorOrgWorkAnalytics(f.db, nova.id, range);
  expect(theirs.agents.map((a) => [a.agentId, a.turns.total, a.waits.peakWaiting])).toEqual([[novaAgent.id, 2, 2]]);

  const long = { from: new Date(now - 90 * 86_400_000).toISOString().slice(0, 10), to: today };
  await expect(operatorWorkAnalytics(f.db, long)).rejects.toThrow(ValidationError);
});
