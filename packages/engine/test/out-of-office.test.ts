import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  availabilityNow,
  clearPlanLimits,
  createAgent,
  createSetStatusToolSource,
  DEFAULT_ROUTER_POLICY,
  insertMessage,
  listMembers,
  loadAgentStatuses,
  memberPresence,
  monthStartUtc,
  notePlanLimit,
  outOfOfficeIds,
  type RouterStrategy,
  routeMessage,
  setMyStatus,
} from "../src";
import type { ToolContext } from "../src/tools/types";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  clearPlanLimits();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const statusOf = async (fx: Fixture, agentId: string) =>
  (await loadAgentStatuses(fx.db, fx.org.id, new Date())).find((s) => s.agentId === agentId);

/** Spends `agentId`'s whole budget for this month. */
async function spendBudget(fx: Fixture, agentId: string) {
  await fx.db.update(schema.agents).set({ monthlyBudgetNanoUsd: 1_000 }).where(eq(schema.agents.id, agentId));
  await fx.db
    .insert(schema.agentBudgetPeriods)
    .values({
      orgId: fx.org.id,
      agentId,
      periodStart: monthStartUtc(new Date()).toISOString().slice(0, 10),
      spentNanoUsd: 1_000,
      reservedNanoUsd: 0,
    })
    .onConflictDoUpdate({
      target: [schema.agentBudgetPeriods.agentId, schema.agentBudgetPeriods.periodStart],
      set: { spentNanoUsd: 1_000 },
    });
}

/** Puts `agentId` on Claude Code on a new computer of the workspace. */
async function onPlan(fx: Fixture, agentId: string) {
  const [machine] = await fx.db
    .insert(schema.machines)
    .values({ orgId: fx.org.id, name: "MacBook" })
    .returning({ id: schema.machines.id });
  if (!machine) throw new Error("no machine");
  await fx.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId: machine.id })
    .where(eq(schema.agents.id, agentId));
  return machine.id;
}

test("an agent whose monthly budget is spent is out of office until the next month", async () => {
  f = await setup();
  // Just made: online, not out.
  expect((await statusOf(f, f.agent.id))?.presence).toBe("online");
  await spendBudget(f, f.agent.id);
  const s = await statusOf(f, f.agent.id);
  expect(s?.presence).toBe("out");
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  expect(s?.status).toMatchObject({ by: "auto", kind: "out_of_budget", until: next });
  expect([...(await outOfOfficeIds(f.db, f.org.id, [f.agent.id]))]).toEqual([f.agent.id]);
});

test("a plan at its limit: out, though the workspace has a key (the API never stands in), and back at the reset", async () => {
  f = await setup();
  const machineId = await onPlan(f, f.agent.id);
  const reset = new Date(Date.now() + 2 * 3600_000).toISOString();
  notePlanLimit(machineId, "claude_code", reset);
  expect(await statusOf(f, f.agent.id)).toMatchObject({
    presence: "out",
    status: { kind: "out_of_plan", until: new Date(Date.parse(reset)).toISOString() },
  });

  expect([...(await outOfOfficeIds(f.db, f.org.id, [f.agent.id]))]).toEqual([f.agent.id]);

  clearPlanLimits();
  expect((await statusOf(f, f.agent.id))?.presence).toBe("online");
});

test("at its account's limit, an agent with another account of the order that has room is not out", async () => {
  f = await setup();
  const fx = f;
  const machineId = await onPlan(fx, fx.agent.id);
  const walter = await addMember(fx.db, fx.org.id, "member", "walter");
  const soon = Date.now() + 3600_000;
  const later = Date.now() + 5 * 3600_000;
  const reading = (used: number, at: number) => ({
    windows: [{ kind: "five_hour", usedPercent: used, resetsAt: new Date(at).toISOString() }],
    source: "turn",
    at: new Date().toISOString(),
  });
  const account = (id: string, createdBy: string, usage: unknown, more: Record<string, unknown> = {}) =>
    fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: `Conta ${id.slice(-1)}`,
      status: "active",
      createdBy,
      shared: true,
      usage: usage as never,
      ...more,
    });
  const own = "0193eeee-0000-4000-8000-00000000c001";
  const theirs = "0193eeee-0000-4000-8000-00000000c002";
  await account(own, fx.owner.id, reading(100, later));
  await account(theirs, walter.id, reading(30, later));
  await fx.db.update(schema.agents).set({ brainAccountId: own }).where(eq(schema.agents.id, fx.agent.id));
  // Walter's account serves everyone and has room: the run would move there.
  expect((await statusOf(fx, fx.agent.id))?.presence).toBe("online");
  expect([...(await outOfOfficeIds(fx.db, fx.org.id, [fx.agent.id]))]).toEqual([]);

  // Pinned to its own account ("Só esta conta"), it waits for it again.
  await fx.db.update(schema.agents).set({ brainAccountPinned: true }).where(eq(schema.agents.id, fx.agent.id));
  expect([...(await outOfOfficeIds(fx.db, fx.org.id, [fx.agent.id]))]).toEqual([fx.agent.id]);
  await fx.db.update(schema.agents).set({ brainAccountPinned: false }).where(eq(schema.agents.id, fx.agent.id));

  // Set to serve only Walter, it never serves this agent.
  await fx.db.update(schema.machineAccounts).set({ serves: "owner" }).where(eq(schema.machineAccounts.id, theirs));
  expect([...(await outOfOfficeIds(fx.db, fx.org.id, [fx.agent.id]))]).toEqual([fx.agent.id]);

  // A login for one agent never takes another's run, even unused.
  await fx.db
    .update(schema.machineAccounts)
    .set({ serves: "everyone", shared: false })
    .where(eq(schema.machineAccounts.id, theirs));
  expect([...(await outOfOfficeIds(fx.db, fx.org.id, [fx.agent.id]))]).toEqual([fx.agent.id]);
  await fx.db.update(schema.machineAccounts).set({ shared: true }).where(eq(schema.machineAccounts.id, theirs));

  // Every account limited: out until the earliest reset of the chain.
  await fx.db
    .update(schema.machineAccounts)
    .set({ serves: "everyone", usage: reading(100, soon) as never })
    .where(eq(schema.machineAccounts.id, theirs));
  expect(await statusOf(fx, fx.agent.id)).toMatchObject({
    presence: "out",
    status: { kind: "out_of_plan", until: new Date(soon).toISOString() },
  });
});

test("out of office keeps the agent's own words, and a held agent still reads offline", async () => {
  f = await setup();
  await spendBudget(f, f.agent.id);
  const [tool] = await createSetStatusToolSource().tools({} as ToolContext);
  if (!tool) throw new Error("no tool");
  const ctx = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: "",
    channelId: f.general.id,
    threadRootId: "",
    triggerMessageId: "",
  } as ToolContext;
  await tool.execute({ text: "De volta segunda", minutes: 60 }, ctx);
  expect(await statusOf(f, f.agent.id)).toMatchObject({
    presence: "out",
    status: { by: "self", text: "De volta segunda" },
  });

  await f.db.update(schema.agents).set({ operatorHoldAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
  expect((await statusOf(f, f.agent.id))?.presence).toBe("offline");
});

test("the router leaves an agent out of office out of a message nobody mentioned it in", async () => {
  f = await setup();
  const theo = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Theo", handle: "theo" },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: theo.id });
  await spendBudget(f, f.agent.id);
  const seen: string[][] = [];
  const strategy: RouterStrategy = {
    name: "fixed",
    async decide(input) {
      seen.push(input.candidates.map((c) => c.handle));
      return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 0.9 })), reason: "test" };
    },
  };
  const m = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "alguém consegue revisar o relatório de vendas?",
  });
  const routed = await routeMessage(
    {
      db: f.db,
      strategy,
      policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 },
      outOfOffice: (orgId, ids) => outOfOfficeIds(f.db, orgId, ids),
    },
    { orgId: f.org.id, messageId: m.id },
  );
  expect(seen).toEqual([["theo"]]);
  expect(routed.selected).toEqual([theo.id]);
});

test("a person out of office shows it to everyone, connected or not, until their line's end", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  const back = new Date("2026-11-10T12:00:00Z");
  const out = { availability: "out" as const, statusUntil: back };
  expect(memberPresence(out, false, false, now)).toBe("out");
  expect(memberPresence(out, true, true, now)).toBe("out");
  expect(memberPresence({ availability: "out" as const }, false, false, now)).toBe("out");
  // Back: online while connected again, offline otherwise, and the picker reads "auto".
  const later = new Date("2026-11-10T12:00:01Z");
  expect(memberPresence(out, true, false, later)).toBe("online");
  expect(memberPresence(out, false, false, later)).toBe("offline");
  expect(availabilityNow(out, later)).toBe("auto");
});

test("a person picks out of office with a line that ends when they are back", async () => {
  f = await setup();
  const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await setMyStatus({ db: f.db }, f.owner.id, f.org.id, {
    availability: "out",
    status: { text: "De férias", emoji: "🏖️", until },
  });
  const me = (await listMembers(f.db, f.org.id)).find((m) => m.userId === f.owner.id);
  expect(me).toMatchObject({ availability: "out", statusText: "De férias" });
  expect(memberPresence(me as NonNullable<typeof me>, false, false)).toBe("out");
});
