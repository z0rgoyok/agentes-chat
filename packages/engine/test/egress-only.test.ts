import { afterEach, expect, test } from "bun:test";
import { EGRESS_ONLY_PROTOCOL, EGRESS_SHARE_PROTOCOL, type MachineRequest, STREAM_CLOSE } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  createEgressFetch,
  createEgressRelay,
  issueManagedMachine,
  listDevices,
  listMachines,
  type MachineHub,
  MachineRequestError,
  type MachineStatus,
  postPersonMessage,
  resolveBrain,
  setServerLending,
  updateComputerDevice,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine, RUNNER } from "./machine-fixtures";
import { fakeSocket, until } from "./stream-fixtures";

let f: Fixture;
afterEach(async () => {
  setServerLending(false);
  await f?.close();
});

const pair = async (userId: string, name: string, protocol = EGRESS_ONLY_PROTOCOL) =>
  (await pairMachine({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, { name, ...RUNNER, protocol })).machineId;
const hello = (egress: { host: string; port: number }) => ({
  type: "stream.hello" as const,
  token: "agm_unused",
  streamId: "o".repeat(43),
  egress,
});

test('"use only this computer\'s internet": its owner turns it on while it lends, the borrowers hear it at once', async () => {
  f = await setup();
  const sam = await addMember(f.db, f.org.id, "admin", "sam");
  const laptop = await pair(f.owner.id, "Laptop");
  const managed = await issueManagedMachine({ db: f.db }, f.org.id);
  if (!managed) throw new Error("no managed computer");
  await f.db
    .update(schema.machines)
    .set({ protocol: EGRESS_ONLY_PROTOCOL })
    .where(eq(schema.machines.id, managed.machineId));
  const told: { machineId: string; request: MachineRequest }[] = [];
  const hub = {
    status: async () => null,
    agentsChanged: async () => {},
    call: async (machineId: string, request: MachineRequest) => {
      told.push({ machineId, request });
      return { on: true } as never;
    },
  };
  const update = (who: string, input: Parameters<typeof updateComputerDevice>[4]) =>
    updateComputerDevice({ db: f.db, pubsub: f.pubsub, hub }, who, f.org.id, laptop, input);

  expect((await update(f.owner.id, { internetOnly: true })).shareInternet).toEqual({
    on: true,
    inUse: false,
    only: true,
  });
  await until(() => told.length > 0, "egress.only");
  expect(told).toEqual([{ machineId: managed.machineId, request: { op: "egress.only", on: true } }]);
  // An admin may only turn it off, as the switch above it.
  await update(f.owner.id, { internetOnly: false });
  await expect(update(sam.id, { internetOnly: true })).rejects.toMatchObject({ code: "device.share_owner_only" });
  await update(f.owner.id, { internetOnly: true });
  expect((await update(sam.id, { internetOnly: false })).shareInternet?.only).toBe(false);
  // Lending off turns it off too, and it can't go on while nothing is lent.
  await update(f.owner.id, { internetOnly: true });
  // Each change told them once (an admin's refused one never).
  await until(() => told.length === 5, "five changes told");
  told.length = 0;
  expect((await update(f.owner.id, { shareInternet: false })).shareInternet).toEqual({
    on: false,
    inUse: false,
    only: false,
  });
  await until(() => told.length > 0, "egress.only off");
  expect(told).toEqual([{ machineId: managed.machineId, request: { op: "egress.only", on: false } }]);
  await expect(update(f.owner.id, { internetOnly: true })).rejects.toMatchObject({ code: "device.share_off" });
});

test("lent only: only that computer carries, its being offline is no internet, never the usual way", async () => {
  f = await setup();
  const desk = await pair(f.owner.id, "Desk");
  const laptop = await pair(f.owner.id, "Laptop");
  const managed = await issueManagedMachine({ db: f.db }, f.org.id);
  if (!managed) throw new Error("no managed computer");
  let online = [desk, laptop];
  let failing = false;
  const asked: string[] = [];
  const relay = createEgressRelay({
    db: f.db,
    hub: {
      status: async (id) => ({ online: online.includes(id) }) as never,
      call: async (machineId) => {
        asked.push(machineId);
        if (failing) throw new MachineRequestError("timeout", "no answer");
        throw new MachineRequestError("not_found", "no such site");
      },
    },
  });
  const ask = async () => {
    const s = fakeSocket();
    relay.claim(hello({ host: "api.anthropic.com", port: 443 }), managed.machineId, s.socket);
    await until(() => s.closed !== null, "close");
    return s.closed;
  };
  await f.db.update(schema.machines).set({ egressOnly: true }).where(eq(schema.machines.id, desk));

  // The laptop is the newer pick, yet only the desk carries.
  await ask();
  expect(asked).toEqual([desk]);
  // The desk offline with the laptop online: no internet, said as "not found" so no borrower goes its usual way.
  online = [laptop];
  expect(await ask()).toEqual({ code: STREAM_CLOSE.notFound, reason: "Desk is offline" });
  expect(asked).toEqual([desk]);
  // A dial that fails on it is no internet either, not "none lends".
  online = [desk];
  failing = true;
  expect((await ask())?.code).toBe(STREAM_CLOSE.notFound);
  // The server's own reads go through it even on the Cloud, and say why while it is away.
  online = [];
  const lent = await createEgressFetch(relay).lentFetch(f.org.id);
  expect(lent?.only).toBe(true);
  expect(lent?.fetch("https://shop.example/")).rejects.toThrow("No internet: Desk is offline");
  // Turned off: every lending computer again, and none online is the usual way.
  await f.db.update(schema.machines).set({ egressOnly: false }).where(eq(schema.machines.id, desk));
  const again = createEgressRelay({
    db: f.db,
    hub: { status: async () => ({ online: false }) as never, call: async () => ({}) as never },
  });
  const s = fakeSocket();
  again.claim(hello({ host: "api.anthropic.com", port: 443 }), managed.machineId, s.socket);
  await until(() => s.closed !== null, "close");
  expect(s.closed?.code).toBe(STREAM_CLOSE.unreachable);
  expect(await createEgressFetch(again).lentFetch(f.org.id)).toBeNull();
});

test("the workspace's computer's agents wait for the computer lent only, and its page says why", async () => {
  f = await setup();
  const laptop = await pair(f.owner.id, "Ana's laptop", EGRESS_SHARE_PROTOCOL);
  const managed = await issueManagedMachine({ db: f.db }, f.org.id);
  if (!managed) throw new Error("no managed computer");
  // The agent's computer stands for the workspace's (its own sign-in is its owner's): it borrows, as `kind` says.
  const own = await pair(f.owner.id, "Workspace");
  await f.db.update(schema.machines).set({ egressShare: false }).where(eq(schema.machines.id, own));
  await f.db.update(schema.agents).set({ machineId: own, brain: "claude_code" });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!agent || !run) throw new Error("missing rows");
  let lenderOnline = false;
  const machines = {
    status: async (id: string): Promise<MachineStatus> => ({
      id,
      orgId: f.org.id,
      name: id === laptop ? "Ana's laptop" : "Workspace",
      kind: id === laptop ? "connected" : "managed",
      online: id === laptop ? lenderOnline : true,
      execAllowed: true,
      os: "linux",
      protocol: EGRESS_ONLY_PROTOCOL,
      executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
    }),
  };

  expect((await resolveBrain({ db: f.db, machines }, agent, run, run.channelId)).unavailable).toBeUndefined();
  await f.db.update(schema.machines).set({ egressOnly: true }).where(eq(schema.machines.id, laptop));
  expect((await resolveBrain({ db: f.db, machines }, agent, run, run.channelId)).unavailable).toMatchObject({
    code: "lent_offline",
    lent: { machineId: laptop, name: "Ana's laptop" },
  });
  const view = (await listMachines(f.db, f.owner.id, f.org.id)).find((m) => m.id === managed.machineId);
  expect(view?.egressOffline).toMatchObject({ machineId: laptop, name: "Ana's laptop" });
  expect((await listDevices(f.db, f.org.id, f.owner.id)).devices.find((d) => d.id === laptop)?.shareInternet).toEqual({
    on: true,
    inUse: false,
    only: true,
  });
  lenderOnline = true;
  expect((await resolveBrain({ db: f.db, machines }, agent, run, run.channelId)).unavailable).toBeUndefined();
});

test("a borrowing computer hears it in its welcome and at once when it changes; an older app never", async () => {
  f = await setup({ machines: true });
  setServerLending(true);
  const laptop = await pair(f.owner.id, "Laptop");
  const vps = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Build VPS", ...RUNNER });
  await f.db
    .update(schema.machines)
    .set({ belongsToWorkspace: true, egressShare: false })
    .where(eq(schema.machines.id, vps.machineId));
  await f.db.update(schema.machines).set({ egressOnly: true }).where(eq(schema.machines.id, laptop));
  const hub = f.machineHub as MachineHub;
  const runner = fakeRunner(hub);
  await runner.hello(vps.token);
  expect(runner.sent.find((frame) => frame.type === "welcome")).toMatchObject({ egressProxy: true, egressOnly: true });
  await updateComputerDevice({ db: f.db, pubsub: f.pubsub, hub }, f.owner.id, f.org.id, laptop, {
    internetOnly: false,
  });
  const told = () =>
    runner.sent.flatMap((frame) => (frame.type === "request" && frame.op === "egress.only" ? [frame.on] : []));
  await until(() => told().length > 0, "egress.only");
  expect(told()).toEqual([false]);
  const old = fakeRunner(hub);
  await f.db.update(schema.machines).set({ egressOnly: true }).where(eq(schema.machines.id, laptop));
  await old.hello(vps.token, { protocol: EGRESS_ONLY_PROTOCOL - 1 });
  expect(old.sent.find((frame) => frame.type === "welcome")).not.toHaveProperty("egressOnly");
});
