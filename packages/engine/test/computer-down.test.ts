import { afterEach, describe, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, inArray, schema } from "@agenteschat/db";
import {
  COMPUTER_DOWN_JOB,
  createMachineHub,
  DOWN_JOIN_MS,
  DOWN_NOTICE_MS,
  downGroup,
  issueManagedMachine,
  type MachineHub,
  noticeComputerBack,
  noticeComputerDown,
  noticeOn,
  outageStart,
  pollDeviceToken,
  setMachineMoving,
  setMachineStandby,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/** "Computer down" and "back" (ADR 0241): who hears it, when, only in the inbox, and never for a computer away by plan. */

let f: Fixture;
let hub: MachineHub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const MIN = 60_000;
const T0 = Date.parse("2026-11-23T22:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const close = (connectedAt: number, closedAt: number) => ({
  connectedAt: at(connectedAt),
  at: at(closedAt),
  code: 1006,
  reason: "",
});

describe("outageStart", () => {
  test("the last close, joined with the closes before it the computer came back from for under 30 minutes", () => {
    expect(outageStart([])).toBeNull();
    // Up for an hour before it went: an outage of its own.
    expect(outageStart([close(-60 * MIN, 0)])?.toISOString()).toBe(at(0));
    // Back 5 minutes, gone again: one outage since the first close.
    expect(outageStart([close(5 * MIN, 10 * MIN), close(-60 * MIN, 0)])?.toISOString()).toBe(at(0));
    // Back for 30 minutes or more: a new outage.
    expect(outageStart([close(5 * MIN, 5 * MIN + DOWN_JOIN_MS), close(-60 * MIN, 0)])?.toISOString()).toBe(
      at(5 * MIN + DOWN_JOIN_MS),
    );
    // A "back" told at minute 6: what came before it is over.
    expect(outageStart([close(5 * MIN, 10 * MIN), close(-60 * MIN, 0)], T0 + 6 * MIN)?.toISOString()).toBe(
      at(10 * MIN),
    );
    // No close since then: no outage.
    expect(outageStart([close(-60 * MIN, 0)], T0 + MIN)).toBeNull();
  });
});

/** The workspace's own computer, redeemed, that went away at T0 after an hour up. */
async function managedComputer() {
  const issued = await issueManagedMachine({ db: f.db }, f.org.id);
  if (!issued) throw new Error("no org");
  const token = await pollDeviceToken({ db: f.db }, issued.enrollCode);
  if (!token.ok) throw new Error(`enroll failed: ${token.error}`);
  await wentAway(issued.machineId);
  return { machineId: issued.machineId, token: token.token };
}

async function wentAway(machineId: string, disconnects = [close(-60 * MIN, 0)]) {
  await f.db
    .update(schema.machines)
    .set({ online: false, lastSeenAt: new Date(T0), disconnects })
    .where(eq(schema.machines.id, machineId));
}

const deps = (ms: number) => ({ db: f.db, pubsub: f.pubsub, now: () => new Date(T0 + ms) });

/** An hour away: past every wait the notices ever had. */
const HOUR = 60 * MIN;

const notices = (kind: string) =>
  f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, kind)));

/** What left for an inbox or a device: emails and pushes. */
const sent = async () =>
  (
    await f.db
      .select()
      .from(schema.outbox)
      .where(inArray(schema.outbox.kind, ["email.send", "push.send"]))
  ).map((j) => j.kind);

/** The owner has a phone, so a notice that pushes would queue `push.send`. */
const ownerPhone = () =>
  f.db
    .insert(schema.pushDevices)
    .values({ userId: f.owner.id, token: "ExponentPushToken[fake-owner]", platform: "ios", locale: "en" });

describe("computer down", () => {
  test("after 10 minutes who configures the workspace hears it once, in the inbox only; members never", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "Bruno");
    const { machineId } = await managedComputer();
    await ownerPhone();

    await noticeComputerDown(deps(DOWN_NOTICE_MS - MIN), machineId);
    expect(await notices("computer_down")).toHaveLength(0);

    await noticeComputerDown(deps(DOWN_NOTICE_MS), machineId);
    await noticeComputerDown(deps(DOWN_NOTICE_MS + MIN), machineId);
    const down = await notices("computer_down");
    expect(down.map((n) => n.userId)).toEqual([f.owner.id]);
    expect(down.map((n) => n.userId)).not.toContain(member.id);
    expect(down[0]).toMatchObject({
      groupKey: downGroup(machineId, new Date(T0)),
      source: { machineId },
      latest: { since: at(0), runs: 0, calls: 0 },
    });
    // Away an hour: still one row, and no email or push ever, nor a desktop banner.
    await noticeComputerDown(deps(HOUR), machineId);
    expect(await notices("computer_down")).toHaveLength(1);
    expect(await sent()).toEqual([]);
    expect(noticeOn({}, "computer_down", false)).toBe(false);
  });

  test("never for a computer in standby, one moving hosts, or a workspace on hold", async () => {
    f = await setup();
    const { machineId } = await managedComputer();

    await setMachineStandby({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, true);
    await noticeComputerDown(deps(HOUR), machineId);
    await setMachineStandby({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, false);
    // Taken out of standby it is waking: what this test's clock calls the past, so it is cleared here.
    await f.db.update(schema.machines).set({ wakeWantedAt: null }).where(eq(schema.machines.id, machineId));

    expect(await setMachineMoving({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, true)).toEqual({ moving: true });
    await noticeComputerDown(deps(HOUR), machineId);
    expect(await notices("computer_down")).toHaveLength(0);
    expect(await sent()).toEqual([]);

    // A move nobody ended hours ago no longer covers it.
    await f.db
      .update(schema.machines)
      .set({ movingAt: new Date(T0 - 3 * 3600_000) })
      .where(eq(schema.machines.id, machineId));
    await noticeComputerDown(deps(DOWN_NOTICE_MS), machineId);
    expect(await notices("computer_down")).toHaveLength(1);
  });

  test("a computer someone brought counts only while work waits for it", async () => {
    f = await setup();
    const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Laptop" });
    await wentAway(paired.machineId);

    await noticeComputerDown(deps(DOWN_NOTICE_MS), paired.machineId);
    expect(await notices("computer_down")).toHaveLength(0);

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
        status: "waiting_input",
        waitingMachineId: paired.machineId,
      })
      .returning();
    expect(run).toBeDefined();
    await noticeComputerDown(deps(DOWN_NOTICE_MS), paired.machineId);
    expect((await notices("computer_down")).map((n) => n.latest)).toEqual([expect.objectContaining({ runs: 1 })]);
  });
});

describe("computer back", () => {
  test("only after a down was told: to the same people, with how long and what waited; the down is done", async () => {
    f = await setup();
    const { machineId } = await managedComputer();
    const row = async () => {
      const [m] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
      if (!m) throw new Error("no machine");
      return m;
    };

    // Back after 5 minutes: nobody was told it went, nobody hears it is back.
    await noticeComputerBack(deps(5 * MIN), await row());
    expect(await notices("computer_back")).toHaveLength(0);

    await noticeComputerDown(deps(HOUR), machineId);
    await ownerPhone();
    await noticeComputerBack(deps(HOUR + 2 * MIN), await row());
    await noticeComputerBack(deps(HOUR + 3 * MIN), await row());
    const back = await notices("computer_back");
    expect(back.map((n) => [n.userId, n.latest])).toEqual([[f.owner.id, expect.objectContaining({ since: at(0) })]]);
    expect((await notices("computer_down")).every((n) => n.doneAt !== null)).toBe(true);
    // Inbox only: no email or push that it is back either.
    expect(await sent()).toEqual([]);
    expect(noticeOn({}, "computer_back", false)).toBe(false);

    // It goes again 10 minutes after the back: a new outage, told again after its own 10 minutes.
    const back3 = HOUR + 3 * MIN;
    await wentAway(machineId, [close(back3, back3 + 10 * MIN), close(-60 * MIN, 0)]);
    await noticeComputerDown(deps(back3 + 10 * MIN + DOWN_NOTICE_MS), machineId);
    expect((await notices("computer_down")).map((n) => n.latest.since).sort()).toEqual([at(0), at(back3 + 10 * MIN)]);
  });

  test("the hub queues the checks when a socket closes, and tells the back at the next hello", async () => {
    f = await setup();
    const { machineId, token } = await managedComputer();
    hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
    const hello = async () => {
      const conn = hub?.open({ send: () => {}, close: () => {} });
      if (!conn || !hub) throw new Error("no hub");
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
      return conn;
    };
    const conn = await hello();
    await hub.close(conn);
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, COMPUTER_DOWN_JOB));
    // One check, the notice's: no second one for an email.
    expect(jobs.map((j) => j.payload)).toEqual([{ machineId, stage: "down" }]);

    // Away long enough and told: its next hello says it is back.
    await wentAway(machineId, [close(-60 * MIN, -20 * MIN)]);
    await noticeComputerDown(deps(0), machineId);
    expect(await notices("computer_down")).toHaveLength(1);
    await hello();
    expect(await notices("computer_back")).toHaveLength(1);
  });
});
