import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  createAgent,
  drainOutbox,
  insertMessage,
  loadAgentStatuses,
  NEW_AGENT_DEFAULTS,
  openAgentDm,
  postPersonMessage,
  updateAgent,
} from "../src";
import { tellBudgetPause } from "../src/budget-pause";
import { monthStartUtc } from "../src/usage";
import { addMember, type Fixture, setup } from "./fixtures";

/** An agent's work stopped on its monthly budget is told where people look: the inbox, its origin, #general's line. */

let f: Fixture;
afterEach(() => f?.close());

const BUDGET = 100_000_000_000;

async function spend(fx: Fixture, percent: number) {
  const spentNanoUsd = (BUDGET * percent) / 100;
  await fx.db
    .insert(schema.agentBudgetPeriods)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      periodStart: monthStartUtc(new Date()).toISOString().slice(0, 10),
      spentNanoUsd,
    })
    .onConflictDoUpdate({
      target: [schema.agentBudgetPeriods.agentId, schema.agentBudgetPeriods.periodStart],
      set: { spentNanoUsd },
    });
}

const stepper = (steps: number) => (_: unknown, call: number) =>
  call < steps
    ? { chunks: [], toolUses: [{ name: "search_context", input: { query: `pedido ${call}` } }] }
    : { chunks: ["Pronto."] };

const pausedRows = (fx: Fixture) =>
  fx.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.orgId, fx.org.id), eq(schema.notifications.kind, "budget_paused")));

test("a pause on the budget reaches who manages the agent, waiting, and #general's statuses name it until raised", async () => {
  f = await setup({ contextTools: true, budgetNanoUsd: BUDGET, reply: stepper(12) });
  const admin = await addMember(f.db, f.org.id, "admin", "Ana Admin");
  const member = await addMember(f.db, f.org.id, "member", "Caio Member");
  await spend(f, 99);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev analisa os pedidos",
  });
  await drainOutbox(f.db, f.handlers);
  const rows = await pausedRows(f);
  expect(rows.map((r) => r.userId).sort()).toEqual([admin.id, f.owner.id].sort());
  expect(rows.map((r) => r.userId)).not.toContain(member.id);
  for (const r of rows) {
    expect(r).toMatchObject({ waiting: true, doneAt: null, source: { agentId: f.agent.id, channelId: f.general.id } });
    expect(r.latest).toMatchObject({ percent: 99, text: expect.stringContaining("99%") });
  }
  // Asked in #general itself: its pause card is there, no second line.
  const lines = (await f.db.select().from(schema.messages).where(eq(schema.messages.orgId, f.org.id))).filter(
    (m) => m.meta.budgetPause,
  );
  expect(lines).toEqual([]);
  const status = (await loadAgentStatuses(f.db, f.org.id)).find((s) => s.agentId === f.agent.id);
  expect(status?.budgetPaused).toBe(true);
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { monthlyBudgetNanoUsd: 2 * BUDGET }, { pubsub: f.pubsub });
  expect((await pausedRows(f)).every((r) => r.doneAt !== null)).toBe(true);
});

test("work paused in a DM between agents is said once in the conversation it started from", async () => {
  f = await setup({ budgetNanoUsd: BUDGET });
  const rita = await createAgent(f.db, f.owner.id, f.org.id, { name: "Rita", handle: "rita" }, NEW_AGENT_DEFAULTS);
  const asked = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "@dev prepara o relatório",
  });
  const [first] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  const dm = await openAgentDm(f.db, f.org.id, f.agent.id, rita.id);
  const note = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "agent", agentId: f.agent.id, runId: first?.id ?? "", hop: 1 },
    body: "@rita revisa os números",
  });
  const [second] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: rita.id,
      channelId: dm.id,
      threadRootId: note.id,
      triggerMessageId: note.id,
      trigger: "mention",
      hop: 2,
    })
    .returning();
  if (!second) throw new Error("no run");
  for (let i = 0; i < 2; i++) await tellBudgetPause({ db: f.db, pubsub: f.pubsub }, second, rita, 99, true);
  const lines = (await f.db.select().from(schema.messages).where(eq(schema.messages.orgId, f.org.id))).filter(
    (m) => m.meta.budgetPause,
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    channelId: f.general.id,
    threadId: null,
    authorAgentId: f.agent.id,
    meta: { bodyCode: "usage_paused_budget", bodyParams: { agent: "Rita", percent: "99" } },
  });
  const rows = await pausedRows(f);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ userId: f.owner.id, source: { agentId: rita.id, channelId: f.general.id } });
});
