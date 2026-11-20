import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { RUN_STALE_MS, roomGate, signInSlotOf, transitionRun } from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine, RUNNER } from "./machine-fixtures";

/**
 * One Claude plan sign-in works on at most `cap` runs at once: the next waits in its computer's line, in the line's
 * order, and the first waiting for that sign-in looks again the moment a slot frees (done, failed, canceled), or once
 * a dead worker's heartbeat is stale.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const { agentRuns, outbox } = schema;
const ACCOUNT = "0193f1c2-0000-7000-8000-00000000a001";
const OTHER = "0193f1c2-0000-7000-8000-00000000a002";
const slot = (key: string, cap = 1) => ({ key, cap });

async function computer() {
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, RUNNER);
  return machineId;
}

async function insertRun(values: Partial<typeof agentRuns.$inferInsert>) {
  const id = Bun.randomUUIDv7();
  const [run] = await f.db
    .insert(agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: id,
      triggerMessageId: id,
      trigger: "mention",
      hop: 1,
      status: "running",
      ...values,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

/** A run working on `key`'s sign-in now, its heartbeat `beatAgo` old. */
const working = (machineId: string, key: string, beatAgo = 0) =>
  insertRun({
    heartbeatAt: new Date(Date.now() - beatAgo),
    transcript: { roomAsk: { machineId, at: Date.now() - 5_000, signIn: key } },
  });

/** A run in `machineId`'s line waiting for `key`'s sign-in. */
const waiting = (machineId: string, key: string, extra: Record<string, unknown> = {}, sinceAgo = 60_000) =>
  insertRun({
    status: "waiting_input",
    waitingMachineId: machineId,
    transcript: {
      waitingForBrain: { kind: "claude_code", machineId, code: "busy", waitId: Bun.randomUUIDv7() },
      roomWaitSince: Date.now() - sinceAgo,
      signInWait: { key },
      ...extra,
    },
  });

const newcomer = () => ({ id: Bun.randomUUIDv7(), orgId: f.org.id });
/** A person's turn arriving now: `since` must be read per call, or it falls behind runs set up later. */
const person = () => ({ rank: 0, since: Date.now() }) as const;
const kicks = async () =>
  (await f.db.select().from(outbox))
    .filter((j) => j.dedupeKey?.includes(":sign-in-freed:"))
    .map((j) => (j.payload as { runId: string }).runId);

describe("plan sign-in slots", () => {
  test("only Claude Code on a plan sign-in takes a slot, never a key, another brain or a cap of 0", () => {
    expect(signInSlotOf({ kind: "claude_code" }, 2)).toEqual({ key: "own", cap: 2 });
    const account = { id: ACCOUNT, label: "Claude 2", status: "active" as const };
    expect(signInSlotOf({ kind: "claude_code", account }, 1)?.key).toBe(ACCOUNT);
    expect(signInSlotOf({ kind: "claude_code", account: { ...account, provider: "opencode" } }, 1)).toBeUndefined();
    expect(signInSlotOf({ kind: "codex" }, 1)).toBeUndefined();
    expect(signInSlotOf({ kind: "claude_code" }, 0)).toBeUndefined();
  });

  test("a sign-in at its cap queues the next run; another sign-in on the same computer goes on", async () => {
    f = await setup();
    const machineId = await computer();
    await working(machineId, ACCOUNT);
    const behind = await roomGate(f.db, newcomer(), machineId, person(), slot(ACCOUNT));
    expect(behind?.cause).toBe("sign_in");
    // Two slots: the second run goes on.
    expect(await roomGate(f.db, newcomer(), machineId, person(), slot(ACCOUNT, 2))).toBeNull();
    expect(await roomGate(f.db, newcomer(), machineId, person(), slot(OTHER))).toBeNull();
    // Without a sign-in to wait for (an API key), nothing holds it.
    expect(await roomGate(f.db, newcomer(), machineId, person())).toBeNull();
  });

  test("an account's slots are shared by every computer of the workspace; a computer's own sign-in is its own", async () => {
    f = await setup();
    const a = await computer();
    const { machineId: b } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, RUNNER);
    await working(a, ACCOUNT);
    await working(a, "own");
    expect((await roomGate(f.db, newcomer(), b, person(), slot(ACCOUNT)))?.cause).toBe("sign_in");
    expect(await roomGate(f.db, newcomer(), b, person(), { key: "own", cap: 1 })).toBeNull();
  });

  test("the admitted run holds the slot until it leaves running", async () => {
    f = await setup();
    const machineId = await computer();
    const first = await insertRun({ heartbeatAt: new Date() });
    expect(await roomGate(f.db, first, machineId, person(), slot(ACCOUNT))).toBeNull();
    const [row] = await f.db.select().from(agentRuns).where(eq(agentRuns.id, first.id));
    expect((row?.transcript as { roomAsk?: { signIn?: string } } | undefined)?.roomAsk?.signIn).toBe(ACCOUNT);
    expect((await roomGate(f.db, newcomer(), machineId, person(), slot(ACCOUNT)))?.cause).toBe("sign_in");
  });

  for (const end of ["done", "failed", "canceled"] as const) {
    test(`a run that ends ${end} frees its slot and wakes the first waiting for it`, async () => {
      f = await setup();
      const machineId = await computer();
      const holder = await working(machineId, ACCOUNT);
      const next = await waiting(machineId, ACCOUNT);
      expect(await kicks()).toEqual([]);
      await transitionRun(f.db, holder.id, "running", end);
      expect(await kicks()).toEqual([next.id]);
      expect(await roomGate(f.db, next, machineId, { rank: 1, since: Date.now() - 60_000 }, slot(ACCOUNT))).toBeNull();
    });
  }

  test("a run whose worker died stops holding the slot once its heartbeat is stale", async () => {
    f = await setup();
    const machineId = await computer();
    await working(machineId, ACCOUNT, RUN_STALE_MS + 10_000);
    expect(await roomGate(f.db, newcomer(), machineId, person(), slot(ACCOUNT))).toBeNull();
  });

  test("runs waiting for a sign-in keep the line's order; another sign-in's wait holds nobody back", async () => {
    f = await setup();
    const machineId = await computer();
    const holder = await working(machineId, ACCOUNT);
    const agents = await waiting(machineId, ACCOUNT, {}, 300_000);
    const people = await waiting(machineId, ACCOUNT, { roomPeople: true }, 10_000);
    await waiting(machineId, OTHER, {}, 600_000);
    expect(await roomGate(f.db, newcomer(), machineId, person(), slot(ACCOUNT, 5))).not.toBeNull();
    // A person waits on `people`: it is woken first, and `agents` stays behind it.
    await transitionRun(f.db, holder.id, "running", "done");
    expect(await kicks()).toEqual([people.id]);
    expect(
      await roomGate(f.db, agents, machineId, { rank: 2, since: Date.now() - 300_000 }, slot(ACCOUNT)),
    ).not.toBeNull();
    // The run waiting on the other sign-in keeps its place there; a turn with no sign-in passes every such wait.
    expect(await roomGate(f.db, newcomer(), machineId, { rank: 2, since: Date.now() }, slot(OTHER, 2))).not.toBeNull();
    expect(await roomGate(f.db, newcomer(), machineId, { rank: 2, since: Date.now() })).toBeNull();
  });
});
