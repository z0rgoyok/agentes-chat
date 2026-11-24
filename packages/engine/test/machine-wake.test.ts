import { afterEach, describe, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, orgTopic } from "@agenteschat/adapters";
import { asc, eq, schema } from "@agenteschat/db";
import {
  awakeForPerson,
  callWhenBack,
  computerBackSoon,
  createMachineHub,
  enableOperatorEvents,
  issueManagedMachine,
  listDevices,
  listMachines,
  type MachineHub,
  MachineOfflineError,
  type MachineStatus,
  machineActivity,
  operatorMachines,
  pollDeviceToken,
  revokeManagedMachine,
  setMachineEgressWaiting,
  setMachineStandby,
  shownOnline,
  TASK_OFFLINE_GRACE_MS,
  WAKE_OVERDUE_JOB,
  WAKE_WANTED_EVERY_MS,
  WAKING_LOOK_MS,
  WANTED_BUSY_MS,
  WANTED_WRITE_MS,
  wakeOverdue,
  wantMachine,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { until } from "./stream-fixtures";

/**
 * The workspace's computer asleep while nobody uses it (ADR 0161): the operator's standby, what wants the computer
 * (`wanted_at`, `machine.wake_wanted`), what the operator decides with, and a run's quiet wait while it wakes.
 */

let f: Fixture;
let hub: MachineHub | null = null;
afterEach(async () => {
  enableOperatorEvents(false);
  await hub?.stop();
  hub = null;
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const machineRow = async (id: string) => {
  const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, id));
  if (!row) throw new Error("no machine");
  return row;
};
const wakeEvents = async () =>
  (
    await f.db
      .select()
      .from(schema.operatorEvents)
      .orderBy(asc(schema.operatorEvents.xactId), asc(schema.operatorEvents.id))
  )
    .filter((e) => e.type === "machine.wake_wanted")
    .map((e) => ({ orgId: e.orgId, data: e.data }));

/** The workspace's own computer, issued and redeemed: offline until its runner says hello. */
async function managedComputer() {
  const issued = await issueManagedMachine(deps(), f.org.id);
  if (!issued) throw new Error("no org");
  const token = await pollDeviceToken(deps(), issued.enrollCode);
  if (!token.ok) throw new Error(`enroll failed: ${token.error}`);
  return { machineId: issued.machineId, token: token.token };
}

/** Its runner says hello over an in-memory socket. */
async function hello(token: string) {
  hub ??= createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  const conn = hub.open({ send: () => {}, close: () => {} });
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token,
      hostname: "vm-7f3a",
      os: "linux",
      arch: "x64",
      version: "1.0.0",
      protocol: MACHINE_PROTOCOL_VERSION,
      workspace: "/var/lib/agentes-runner/work",
      exec: true,
    }),
  );
  return hub;
}

describe("standby", () => {
  test("only the workspace's own computer, the first time kept, its people told; its hello clears it", async () => {
    f = await setup();
    const { machineId, token } = await managedComputer();
    const heard: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
      const event = (e as { event?: { type?: string } }).event;
      if (e.type === "org.broadcast" && event?.type === "machine.updated") heard.push(event);
    });

    expect(await setMachineStandby(deps(), f.org.id, machineId, true)).toEqual({ standby: true });
    const first = (await machineRow(machineId)).standbyAt;
    expect(first).toBeInstanceOf(Date);
    expect(await setMachineStandby(deps(), f.org.id, machineId, true)).toEqual({ standby: true });
    expect((await machineRow(machineId)).standbyAt).toEqual(first);
    expect(heard).toEqual([
      { type: "machine.updated", machineId, standby: true },
      { type: "machine.updated", machineId, standby: true },
    ]);
    // Asleep, it reads as online and ready to its people: never offline (ADR 0161).
    expect((await listMachines(f.db, f.owner.id, f.org.id))[0]).toMatchObject({
      id: machineId,
      standby: true,
      online: true,
    });

    // A computer someone connected, another workspace's id, or no such computer: nothing.
    const paired = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Laptop" });
    expect(await setMachineStandby(deps(), f.org.id, paired.machineId, true)).toBeNull();
    expect((await machineRow(paired.machineId)).standbyAt).toBeNull();
    expect(await setMachineStandby(deps(), crypto.randomUUID(), machineId, false)).toBeNull();
    expect(await setMachineStandby(deps(), f.org.id, crypto.randomUUID(), true)).toBeNull();
    expect((await listMachines(f.db, f.owner.id, f.org.id)).find((m) => m.id === paired.machineId)?.standby).toBe(
      false,
    );

    // Its runner's hello: awake, out of standby.
    const awake = await hello(token);
    expect((await machineRow(machineId)).standbyAt).toBeNull();
    expect(await awake.status(machineId)).toMatchObject({ online: true, standby: false });

    // Said again, then taken back by the operator itself.
    await setMachineStandby(deps(), f.org.id, machineId, true);
    expect((await awake.status(machineId))?.standby).toBe(true);
    expect(await setMachineStandby(deps(), f.org.id, machineId, false)).toEqual({ standby: false });
    // Awake already: nothing starting, no wake's clock.
    expect(await machineRow(machineId)).toMatchObject({ standbyAt: null, wakeWantedAt: null });

    // Removed: no longer the workspace's, and not asleep when it is issued again.
    await setMachineStandby(deps(), f.org.id, machineId, true);
    await revokeManagedMachine(deps(), f.org.id, machineId);
    expect((await machineRow(machineId)).standbyAt).toBeNull();
    expect(await setMachineStandby(deps(), f.org.id, machineId, true)).toBeNull();
  });
});

describe("agents waiting for their way out", () => {
  test("the operator's word on the workspace's own computer: shown while it is online, kept, told, ended", async () => {
    f = await setup();
    const { machineId, token } = await managedComputer();
    const heard: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
      const event = (e as { event?: { type?: string } }).event;
      if (e.type === "org.broadcast" && event?.type === "machine.updated") heard.push(event);
    });
    const shown = async () => (await listMachines(f.db, f.owner.id, f.org.id)).find((m) => m.id === machineId);

    expect(await setMachineEgressWaiting(deps(), f.org.id, machineId, true)).toEqual({ waiting: true });
    const first = (await machineRow(machineId)).egressWaitingAt;
    expect(first).toBeInstanceOf(Date);
    expect(await setMachineEgressWaiting(deps(), f.org.id, machineId, true)).toEqual({ waiting: true });
    expect((await machineRow(machineId)).egressWaitingAt).toEqual(first);
    expect(heard).toEqual([
      { type: "machine.updated", machineId, egressWaiting: true },
      { type: "machine.updated", machineId, egressWaiting: true },
    ]);
    // Offline, there is nothing to wait on there: no line.
    expect((await shown())?.egressWaiting).toBe(false);
    await hello(token);
    expect((await shown())?.egressWaiting).toBe(true);

    // A computer someone connected, another workspace's id, or no such computer: nothing.
    const paired = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Laptop" });
    expect(await setMachineEgressWaiting(deps(), f.org.id, paired.machineId, true)).toBeNull();
    expect(await setMachineEgressWaiting(deps(), crypto.randomUUID(), machineId, false)).toBeNull();
    expect(await setMachineEgressWaiting(deps(), f.org.id, crypto.randomUUID(), true)).toBeNull();

    expect(await setMachineEgressWaiting(deps(), f.org.id, machineId, false)).toEqual({ waiting: false });
    expect((await machineRow(machineId)).egressWaitingAt).toBeNull();
    expect((await shown())?.egressWaiting).toBe(false);

    // Removed: issued again, its agents wait for nothing.
    await setMachineEgressWaiting(deps(), f.org.id, machineId, true);
    await revokeManagedMachine(deps(), f.org.id, machineId);
    expect((await machineRow(machineId)).egressWaitingAt).toBeNull();
  });
});

describe("what wants it", () => {
  test("wanted_at at most every 30 s; machine.wake_wanted only in standby, at most every 10 s, never while off", async () => {
    f = await setup();
    const { machineId } = await managedComputer();
    const t = Date.now();
    await wantMachine(f.db, machineId, "view", t);
    expect((await machineRow(machineId)).wantedAt?.getTime()).toBe(t);
    await wantMachine(f.db, machineId, "view", t + WANTED_WRITE_MS - 1);
    expect((await machineRow(machineId)).wantedAt?.getTime()).toBe(t);

    await setMachineStandby(deps(), f.org.id, machineId, true);
    // The operator API off (a self-hosted server): nothing is told.
    await wantMachine(f.db, machineId, "run", t + 1);
    expect(await wakeEvents()).toEqual([]);

    enableOperatorEvents();
    await wantMachine(f.db, machineId, "run", t + WANTED_WRITE_MS);
    expect((await machineRow(machineId)).wantedAt?.getTime()).toBe(t + WANTED_WRITE_MS);
    await wantMachine(f.db, machineId, "view", t + WANTED_WRITE_MS + WAKE_WANTED_EVERY_MS - 1);
    await wantMachine(f.db, machineId, "call", t + WANTED_WRITE_MS + WAKE_WANTED_EVERY_MS);
    expect(await wakeEvents()).toEqual([
      { orgId: f.org.id, data: { machineId, why: "run" } },
      { orgId: f.org.id, data: { machineId, why: "call" } },
    ]);

    // Awake again: wanted, nothing to tell.
    await setMachineStandby(deps(), f.org.id, machineId, false);
    await wantMachine(f.db, machineId, "view", t + 2 * WANTED_WRITE_MS + WAKE_WANTED_EVERY_MS);
    expect(await wakeEvents()).toHaveLength(2);

    // A computer someone connected never sleeps here: nothing written, nothing told.
    const paired = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Laptop" });
    await f.db.update(schema.machines).set({ standbyAt: new Date() }).where(eq(schema.machines.id, paired.machineId));
    await wantMachine(f.db, paired.machineId, "view", t);
    expect((await machineRow(paired.machineId)).wantedAt).toBeNull();
    expect(await wakeEvents()).toHaveLength(2);
  });

  test("the hub: its status says standby, and a request to it asleep asks for a wake and fails at once", async () => {
    f = await setup();
    enableOperatorEvents();
    const { machineId } = await managedComputer();
    hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
    expect((await hub.status(machineId))?.standby).toBe(false);
    // Offline and awake as far as anyone knows: a plain failure, nothing told.
    await expect(hub.call(machineId, { op: "list", path: "", depth: 1 })).rejects.toBeInstanceOf(MachineOfflineError);

    await setMachineStandby(deps(), f.org.id, machineId, true);
    expect(await hub.status(machineId)).toMatchObject({ online: false, standby: true, kind: "managed" });
    // Who waits for the wake does it once, outside the hub (`callWhenBack`, `awakeForPerson`): a job never waits.
    const asked = Date.now();
    await expect(hub.call(machineId, { op: "list", path: "", depth: 1 })).rejects.toBeInstanceOf(MachineOfflineError);
    expect(Date.now() - asked).toBeLessThan(1_000);
    await until(async () => (await wakeEvents()).length > 0, "the wake");
    expect(await wakeEvents()).toEqual([{ orgId: f.org.id, data: { machineId, why: "call" } }]);
    expect((await machineRow(machineId)).wantedAt).toBeInstanceOf(Date);
  });

  test("standby said again keeps the wake's clock; taken out asleep, it reads waking until its hello, for one grace", async () => {
    f = await setup();
    const { machineId, token } = await managedComputer();
    const heard: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
      const event = (e as { event?: { type?: string } }).event;
      if (e.type === "org.broadcast" && event?.type === "machine.updated") heard.push(event);
    });
    await setMachineStandby(deps(), f.org.id, machineId, true);
    const t = Date.now();
    await wantMachine(f.db, machineId, "view", t);
    // Said again while it wakes: the clock goes on.
    await setMachineStandby(deps(), f.org.id, machineId, true);
    expect((await machineRow(machineId)).wakeWantedAt?.getTime()).toBe(t);
    // Said again once the wake is overdue: still down to people, and their apps hear so.
    const old = new Date(t - TASK_OFFLINE_GRACE_MS - 1_000);
    await f.db.update(schema.machines).set({ wakeWantedAt: old }).where(eq(schema.machines.id, machineId));
    heard.length = 0;
    await setMachineStandby(deps(), f.org.id, machineId, true);
    expect(heard).toEqual([{ type: "machine.updated", machineId, standby: false }]);
    expect((await listMachines(f.db, f.owner.id, f.org.id))[0]).toMatchObject({ online: false, standby: false });

    // Taken out of standby while asleep: it is starting, and reads waking until its runner's hello.
    await f.db.update(schema.machines).set({ wakeWantedAt: null }).where(eq(schema.machines.id, machineId));
    heard.length = 0;
    await setMachineStandby(deps(), f.org.id, machineId, false);
    const row = await machineRow(machineId);
    expect(row.standbyAt).toBeNull();
    expect(row.wakeWantedAt).toBeInstanceOf(Date);
    expect(heard).toEqual([{ type: "machine.updated", machineId, standby: true }]);
    expect((await listMachines(f.db, f.owner.id, f.org.id))[0]).toMatchObject({ online: true, standby: true });
    hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
    // What waits for it waits on; operators see it out of standby.
    expect(await hub.status(machineId)).toMatchObject({ online: false, standby: true });
    expect((await operatorMachines(f.db, f.org.id))?.machines.find((m) => m.id === machineId)?.standby).toBe(false);
    const at = row.wakeWantedAt?.getTime() ?? 0;
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, WAKE_OVERDUE_JOB));
    expect(jobs.map((j) => j.nextAttemptAt.getTime())).toContain(at + TASK_OFFLINE_GRACE_MS);
    // Never started: down after one grace, and the apps hear so.
    expect(shownOnline(row, new Date(at + TASK_OFFLINE_GRACE_MS))).toBe(false);
    heard.length = 0;
    await wakeOverdue(deps(), machineId, new Date(at + TASK_OFFLINE_GRACE_MS));
    expect(heard).toEqual([{ type: "machine.updated", machineId, standby: false }]);

    await hello(token);
    expect(await machineRow(machineId)).toMatchObject({ standbyAt: null, wakeWantedAt: null });
  });

  test("a wake that never comes: online to people for one grace from the first want, then down; hello clears it", async () => {
    f = await setup();
    const { machineId, token } = await managedComputer();
    const heard: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
      const event = (e as { event?: { type?: string } }).event;
      if (e.type === "org.broadcast" && event?.type === "machine.updated") heard.push(event);
    });
    await setMachineStandby(deps(), f.org.id, machineId, true);
    heard.length = 0;
    // Asleep and nobody wants it: ready to people however long it sleeps.
    const later = new Date(Date.now() + 10 * TASK_OFFLINE_GRACE_MS);
    expect(shownOnline(await machineRow(machineId), later)).toBe(true);

    const t = Date.now();
    await wantMachine(f.db, machineId, "view", t);
    await wantMachine(f.db, machineId, "run", t + 1_000);
    // The first want starts the clock, and only it schedules the check.
    expect((await machineRow(machineId)).wakeWantedAt?.getTime()).toBe(t);
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, WAKE_OVERDUE_JOB));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.nextAttemptAt.getTime()).toBe(t + TASK_OFFLINE_GRACE_MS);

    const row = await machineRow(machineId);
    expect(shownOnline(row, new Date(t + TASK_OFFLINE_GRACE_MS - 1))).toBe(true);
    expect(shownOnline(row, new Date(t + TASK_OFFLINE_GRACE_MS))).toBe(false);
    // The check before its time says nothing; at it, the apps hear it is no longer in standby to them.
    await wakeOverdue(deps(), machineId, new Date(t + TASK_OFFLINE_GRACE_MS - 1));
    expect(heard).toEqual([]);
    await wakeOverdue(deps(), machineId, new Date(t + TASK_OFFLINE_GRACE_MS));
    expect(heard).toEqual([{ type: "machine.updated", machineId, standby: false }]);
    // Operators still see the standby.
    expect((await operatorMachines(f.db, f.org.id))?.machines.find((m) => m.id === machineId)?.standby).toBe(true);

    // Settings > Devices too, while it wakes as it should and once it didn't.
    await f.db.update(schema.machines).set({ wakeWantedAt: new Date() }).where(eq(schema.machines.id, machineId));
    const device = async (now?: Date) =>
      (await listDevices(f.db, f.org.id, f.owner.id, now)).devices.find((d) => d.id === machineId)?.status;
    expect(await device()).toEqual({ kind: "ready" });
    expect((await device(new Date(Date.now() + TASK_OFFLINE_GRACE_MS + 1_000)))?.kind).toBe("offline");

    // Its hello: awake, the clock gone with the standby.
    await hello(token);
    expect(await machineRow(machineId)).toMatchObject({ standbyAt: null, wakeWantedAt: null });
  });
});

describe("what the operator decides with", () => {
  test("busy: runs queued or running, one waiting for it, a task or a live hold on it, someone in control, wanted lately", async () => {
    f = await setup();
    const { machineId } = await managedComputer();
    const m = { id: machineId, orgId: f.org.id };
    const busy = async () => (await machineActivity(f.db, m)).busy;
    expect(await machineActivity(f.db, m)).toEqual({ busy: false, lastUsedAt: null });

    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
      })
      .returning();
    if (!run) throw new Error("no run");
    const setRun = (values: Partial<typeof schema.agentRuns.$inferInsert>) =>
      f.db.update(schema.agentRuns).set(values).where(eq(schema.agentRuns.id, run.id));
    expect(await busy()).toBe(true);
    await setRun({ status: "running" });
    expect(await busy()).toBe(true);
    // Waiting for a person, or for another computer: not this one's work.
    await setRun({ status: "waiting_input" });
    expect(await busy()).toBe(false);
    await setRun({ waitingMachineId: crypto.randomUUID() });
    expect(await busy()).toBe(false);
    await setRun({ waitingMachineId: machineId });
    expect(await busy()).toBe(true);
    await setRun({ status: "done", waitingMachineId: null, finishedAt: new Date() });
    expect(await busy()).toBe(false);

    const [task] = await f.db
      .insert(schema.machineTasks)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        machineId,
        channelId: f.general.id,
        title: "Build",
        executor: "shell",
        status: "running",
      })
      .returning();
    if (!task) throw new Error("no task");
    expect(await busy()).toBe(true);
    await f.db.update(schema.machineTasks).set({ status: "done" }).where(eq(schema.machineTasks.id, task.id));
    expect(await busy()).toBe(false);

    // What an agent keeps running on it (ADR 0176), until the hold ends or its time passes.
    const [hold] = await f.db
      .insert(schema.machineHolds)
      .values({ orgId: f.org.id, agentId: f.agent.id, machineId, what: "Telegram bot", why: "answers", pid: 4242 })
      .returning();
    if (!hold) throw new Error("no hold");
    const setHold = (values: Partial<typeof schema.machineHolds.$inferInsert>) =>
      f.db.update(schema.machineHolds).set(values).where(eq(schema.machineHolds.id, hold.id));
    expect(await busy()).toBe(true);
    await setHold({ pid: null, until: new Date(Date.now() - 1_000) });
    expect(await busy()).toBe(false);
    await setHold({ until: new Date(Date.now() + 60_000) });
    expect(await busy()).toBe(true);
    await setHold({ endedAt: new Date(), endReason: "stopped_by_person" });
    expect(await busy()).toBe(false);

    const [handoff] = await f.db
      .insert(schema.browserHandoffs)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        machineId,
        screen: "desktop",
        kind: "takeover",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!handoff) throw new Error("no handoff");
    // Asked of a person who hasn't opened it yet: nobody is on it.
    expect(await busy()).toBe(false);
    await f.db
      .update(schema.browserHandoffs)
      .set({ status: "active", controllerUserId: f.owner.id })
      .where(eq(schema.browserHandoffs.id, handoff.id));
    expect(await busy()).toBe(true);
    await f.db.update(schema.browserHandoffs).set({ status: "done" }).where(eq(schema.browserHandoffs.id, handoff.id));
    expect(await busy()).toBe(false);

    // An open view of it asks every few seconds: wanted lately is busy.
    const now = Date.now();
    const wanted = (ago: number) =>
      f.db
        .update(schema.machines)
        .set({ wantedAt: new Date(now - ago) })
        .where(eq(schema.machines.id, machineId));
    await wanted(WANTED_BUSY_MS - 10_000);
    expect(await busy()).toBe(true);
    await wanted(WANTED_BUSY_MS + 1);
    expect(await busy()).toBe(false);
  });

  test("last used: the latest of its workspace's runs and its tasks of the last week, wanted_at and its people's visits", async () => {
    f = await setup();
    const { machineId } = await managedComputer();
    const m = { id: machineId, orgId: f.org.id };
    const now = Date.now();
    const ago = (minutes: number) => new Date(now - minutes * 60_000);
    const lastUsed = async () => (await machineActivity(f.db, m, new Date(now))).lastUsedAt?.getTime() ?? null;
    const run = (values: Partial<typeof schema.agentRuns.$inferInsert>) =>
      f.db.insert(schema.agentRuns).values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
        status: "done",
        ...values,
      });

    // A run ended an hour ago: then. One changed since without an end counts by its last change.
    await run({ createdAt: ago(62), finishedAt: ago(60), updatedAt: ago(60) });
    expect(await lastUsed()).toBe(ago(60).getTime());
    await run({ status: "waiting_input", createdAt: ago(55), updatedAt: ago(50) });
    expect(await lastUsed()).toBe(ago(50).getTime());
    // Older than a week: never read, however recently it changed.
    await run({ createdAt: ago(8 * 24 * 60), updatedAt: ago(1) });
    expect(await lastUsed()).toBe(ago(50).getTime());

    await f.db
      .update(schema.organizationMembers)
      .set({ lastSeenAt: ago(40) })
      .where(eq(schema.organizationMembers.userId, f.owner.id));
    expect(await lastUsed()).toBe(ago(40).getTime());

    await f.db.insert(schema.machineTasks).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      machineId,
      channelId: f.general.id,
      title: "Build",
      executor: "shell",
      status: "done",
      createdAt: ago(35),
      updatedAt: ago(30),
    });
    expect(await lastUsed()).toBe(ago(30).getTime());

    await f.db
      .update(schema.machines)
      .set({ wantedAt: ago(5) })
      .where(eq(schema.machines.id, machineId));
    expect(await lastUsed()).toBe(ago(5).getTime());

    // As the operator reads it: the workspace's own computer only.
    const paired = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Laptop" });
    const listed = (await operatorMachines(f.db, f.org.id))?.machines;
    expect(listed?.find((x) => x.id === machineId)).toMatchObject({
      managed: true,
      standby: false,
      busy: false,
      lastUsedAt: ago(5),
    });
    expect(listed?.find((x) => x.id === paired.machineId)).toMatchObject({
      managed: false,
      standby: false,
      busy: false,
      lastUsedAt: null,
    });
  });
});

describe("a run's wait while it wakes", () => {
  const SLEPT = new Date(Date.now() - 6 * 3600_000).toISOString();
  const statusOf = (over: Partial<MachineStatus>): MachineStatus => ({
    id: "m1",
    orgId: "o1",
    name: "Acme's computer",
    kind: "managed",
    online: false,
    lastSeenAt: SLEPT,
    execAllowed: true,
    os: "other",
    protocol: MACHINE_PROTOCOL_VERSION,
    executors: {},
    ...over,
  });

  test("in standby: asked to wake once, waited for past the outage grace, back", async () => {
    let looks = 0;
    const woke: string[] = [];
    const machines = {
      status: async () => statusOf(++looks >= 3 ? { online: true } : { standby: true }),
      wake: async (id: string, why: string) => {
        woke.push(`${id}:${why}`);
      },
    };
    expect(await computerBackSoon(machines, "m1", { waitMs: 50, wakeWaitMs: 10_000 })).toBe(true);
    expect(looks).toBe(3);
    expect(woke).toEqual(["m1:run"]);
  });

  test("a computer it woke: seen back within a short look of its hello, not on the next whole second", async () => {
    const started = Date.now();
    const machines = {
      status: async () => statusOf(Date.now() - started >= 300 ? { online: true } : { standby: true }),
      wake: async () => {},
    };
    expect(await computerBackSoon(machines, "m1", { waitMs: 50, wakeWaitMs: 10_000 })).toBe(true);
    expect(Date.now() - started).toBeLessThan(300 + WAKING_LOOK_MS + 150);
  });

  test("still asleep after its wait, gone for good, or just gone on a look that doesn't wait for that: not back", async () => {
    const asleep = { status: async () => statusOf({ standby: true }), wake: async () => {} };
    const started = Date.now();
    expect(await computerBackSoon(asleep, "m1", { waitMs: 50, wakeWaitMs: 300 })).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);

    let looks = 0;
    const gone = (lastSeenAt: string) => ({
      status: async () => {
        looks++;
        return statusOf({ lastSeenAt });
      },
    });
    expect(await computerBackSoon(gone(SLEPT), "m1", { waitMs: 10_000 })).toBe(false);
    expect(looks).toBe(1);
    const justNow = new Date(Date.now() - 5_000).toISOString();
    expect(await computerBackSoon(gone(justNow), "m1", { waitMs: 10_000, justGone: false })).toBe(false);
    expect(looks).toBe(2);
  });

  test("a person's request: waits once for a computer in standby to wake; any other offline one fails at once", async () => {
    const woke: string[] = [];
    let looks = 0;
    const waking = {
      status: async () => statusOf(++looks >= 2 ? { online: true } : { standby: true }),
      wake: async (id: string, why: string) => {
        woke.push(`${id}:${why}`);
      },
    };
    expect(await awakeForPerson(waking, statusOf({ standby: true }))).toBe(true);
    expect(woke).toEqual(["m1:call"]);
    expect(await awakeForPerson(waking, statusOf({ online: true }))).toBe(true);
    const started = Date.now();
    expect(await awakeForPerson(waking, statusOf({ lastSeenAt: new Date().toISOString() }))).toBe(false);
    expect(await awakeForPerson(waking, null)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("callWhenBack: a request to a computer asleep goes again once it woke", async () => {
    let awake = false;
    let sent = 0;
    const machines = {
      status: async () => statusOf(awake ? { online: true } : { standby: true }),
      wake: async () => {
        awake = true;
      },
    };
    const reply = await callWhenBack(machines, "m1", async () => {
      sent++;
      if (!awake) throw new MachineOfflineError("Acme's computer", "managed");
      return "listed";
    });
    expect(reply).toBe("listed");
    expect(sent).toBe(2);
  });
});
