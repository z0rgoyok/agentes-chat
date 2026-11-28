import { afterEach, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { runMigration } from "@agenteschat/db/testing";
import {
  enqueue,
  MachineOfflineError,
  openPersonAgentDm,
  postPersonMessage,
  RIGHT_HAND,
  removeMachineAccount,
  retimeLine,
  setAgentBrain,
  syncMachineAccounts,
  takeBackPlan,
  usageWaitKey,
  wakeAgentUsageWaits,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/*
 * A run parked at a plan's limit goes on as soon as what it would think with changes: its person picks another plan
 * for the right hand, the plan it waits on is disconnected, its agent moves to another account. None of those wakes
 * may sleep until the old plan's reset.
 */

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const ANAS = "0193ffff-0000-4000-8000-0000000000a1";
const BIAS = "0193ffff-0000-4000-8000-0000000000b1";

async function world() {
  const fx = await setup({ rightHand: true });
  f = fx;
  const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "Mac",
    protocol: ACCOUNTS_PROTOCOL,
    exec: true,
  });
  await fx.db
    .update(schema.machines)
    .set({
      pairedByUserId: null,
      executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() },
    })
    .where(eq(schema.machines.id, machineId));
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const caio = await addMember(fx.db, fx.org.id, "member", "caio");
  for (const [id, createdBy] of [
    [ANAS, fx.owner.id],
    [BIAS, bia.id],
  ] as const) {
    await fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: id,
      status: "active",
      createdBy,
      shared: true,
    });
  }
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  /** `userId`'s DM with the right hand, its run parked at the limit of `accountId`'s plan. */
  const parkedIn = async (userId: string, accountId: string) => {
    const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, lodi.id);
    const m = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, { body: "oi" });
    const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, m.id));
    if (!run) throw new Error("no run");
    const waitKey = usageWaitKey({ code: "plan_limit", machineId, kind: "claude_code", accountId });
    await fx.db
      .update(schema.agentRuns)
      .set({
        status: "waiting_input",
        transcript: {
          messages: [],
          waitingForBrain: {
            kind: "claude_code",
            machineId: "",
            code: "plan_limit",
            waitId: Bun.randomUUIDv7(),
            waitKey,
            resetsAt: "2099-01-01T00:00:00.000Z",
          },
        },
      })
      .where(eq(schema.agentRuns.id, run.id));
    return run.id;
  };
  return { fx, machineId, bia, caio, lodi, parkedIn };
}

const switchedWakes = async (fx: Fixture, runId: string) =>
  (await fx.db.select().from(schema.outbox)).filter((j) =>
    j.dedupeKey?.startsWith(`agent_run.execute:${runId}:switched:`),
  );

test("a person picks another plan for the right hand: their parked run goes on now, someone else's keeps waiting", async () => {
  const { fx, bia, caio, lodi, parkedIn } = await world();
  const theirs = await parkedIn(bia.id, ANAS);
  const others = await parkedIn(caio.id, ANAS);
  const before = Date.now();
  await setAgentBrain({ db: fx.db }, bia.id, fx.org.id, lodi.id, {
    scope: "mine",
    brain: "claude_code",
    account: BIAS,
  });
  const wakes = await switchedWakes(fx, theirs);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]?.nextAttemptAt.getTime()).toBeLessThan(before + 60_000);
  expect(await switchedWakes(fx, others)).toEqual([]);
});

test("the plan a run is parked on is disconnected: the run goes on, though its agent never pointed at that plan", async () => {
  const { fx, machineId, bia, parkedIn } = await world();
  // The right hand thinks with the workspace's AI; the plan that served bia's DM is the owner's.
  const parked = await parkedIn(bia.id, ANAS);
  const hub = {
    status: async () => null,
    call: async () => {
      throw new MachineOfflineError("Mac", null);
    },
  };
  await removeMachineAccount(
    { db: fx.db, pubsub: fx.pubsub, hub: hub as never },
    fx.owner.id,
    fx.org.id,
    machineId,
    ANAS,
  );
  expect(await switchedWakes(fx, parked)).toHaveLength(1);
});

test("the computer no longer has the plan a run is parked on: the run goes on", async () => {
  const { fx, machineId, bia, parkedIn } = await world();
  const parked = await parkedIn(bia.id, ANAS);
  await syncMachineAccounts({ db: fx.db, pubsub: fx.pubsub }, fx.org.id, machineId, []);
  expect(await switchedWakes(fx, parked)).toHaveLength(1);
});

test("the owner takes back the plan a person gave the right hand: that person's parked run goes on", async () => {
  const { fx, bia, lodi, parkedIn } = await world();
  await setAgentBrain({ db: fx.db }, bia.id, fx.org.id, lodi.id, {
    scope: "mine",
    brain: "claude_code",
    account: ANAS,
  });
  const parked = await parkedIn(bia.id, ANAS);
  await takeBackPlan({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, ANAS);
  expect(await fx.db.select().from(schema.rightHandBrains).where(eq(schema.rightHandBrains.userId, bia.id))).toEqual(
    [],
  );
  expect(await switchedWakes(fx, parked)).toHaveLength(1);
});

test("a line retimed to its plan's reset keeps a run's wake for its agent's new account where it was", async () => {
  const { fx, bia, lodi, parkedIn } = await world();
  const parked = await parkedIn(bia.id, ANAS);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, parked));
  const waitId = String((run?.transcript as { waitingForBrain?: { waitId: string } } | null)?.waitingForBrain?.waitId);
  await enqueue(fx.db, {
    orgId: fx.org.id,
    kind: "agent_run.execute",
    payload: { runId: parked, wait: waitId },
    dedupeKey: `agent_run.execute:${parked}:usage:${waitId}`,
    runAt: new Date(Date.now() + 3600_000),
  });
  await wakeAgentUsageWaits(fx.db, fx.org.id, lodi.id);
  const [woken] = await switchedWakes(fx, parked);
  const reset = new Date(Date.now() + 4 * 24 * 3600_000);
  await retimeLine(fx.db, [parked], () => reset, reset.toISOString());
  const jobs = await fx.db.select().from(schema.outbox);
  const timer = jobs.find((j) => j.dedupeKey === `agent_run.execute:${parked}:usage:${waitId}`);
  expect(timer?.nextAttemptAt.getTime()).toBe(reset.getTime());
  expect((await switchedWakes(fx, parked))[0]?.nextAttemptAt.getTime()).toBe(woken?.nextAttemptAt.getTime());
});

test("the migration: a brain-change wake a retime pushed to a reset is due now; one queued for now stays", async () => {
  const { fx } = await world();
  const run = crypto.randomUUID();
  const later = new Date(Date.now() + 4 * 24 * 3600_000);
  const soon = new Date(Date.now() + 120_000);
  for (const [key, runAt] of [
    [`agent_run.execute:${run}:switched:pushed`, later],
    [`agent_run.execute:${run}:switched:fresh`, soon],
    [`agent_run.execute:${run}:usage:timer`, later],
  ] as const) {
    await enqueue(fx.db, {
      orgId: fx.org.id,
      kind: "agent_run.execute",
      payload: { runId: run },
      dedupeKey: key,
      runAt,
    });
  }
  await runMigration(fx.db, "switched_wakes_due");
  const at = async (key: string) =>
    (
      await fx.db
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.dedupeKey, `agent_run.execute:${run}:${key}`))
    )[0]?.nextAttemptAt.getTime();
  expect(await at("switched:pushed")).toBeLessThanOrEqual(Date.now());
  expect(await at("switched:fresh")).toBe(soon.getTime());
  expect(await at("usage:timer")).toBe(later.getTime());
});
