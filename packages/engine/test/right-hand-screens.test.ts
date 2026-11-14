import { afterEach, expect, spyOn, test } from "bun:test";
import type { MachineRequest, ServerFrame } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  authorizeStream,
  cancelHandoff,
  claimHandoff,
  computerDriving,
  createBrowserHandoffToolSource,
  createDesktopControl,
  createSandboxToolSource,
  createToolGateway,
  desktopPicture,
  desktopStatus,
  ensureRightHand,
  ForbiddenError,
  finishHandoff,
  getHandoff,
  insertMessage,
  type MachineHub,
  openHandoffOf,
  openPersonAgentDm,
  RIGHT_HAND,
  removeMember,
  requirePageRead,
  type Stream,
  seatOf,
  seatState,
  setAgentHold,
  startTakeover,
  stopAgentBrowser,
  stopOrgWork,
  type ToolContext,
  waitIfPersonInControl,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine } from "./machine-fixtures";

/**
 * The right hand's screens and who reaches them (ADR 0175): a person watches, drives and is asked onto their own
 * seat only, with the role keys and grants any agent's computer takes, and nothing of one person's seat (a handoff,
 * a wait, a hold's reach) crosses to another's.
 */

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

type Request = Extract<ServerFrame, { type: "request" }>;

const ACCESS = {
  folders: [],
  tools: { claude: true, codex: true, commands: true, browser: true, desktop: true, terminal: true },
};

async function rightHand() {
  await ensureRightHand(f.db, f.org.id);
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
}

/** The workspace's own computer with its runner connected; `system`: each agent is its own OS user there. */
async function home(system = true) {
  f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
  const hub = f.machineHub as MachineHub;
  const lodi = await rightHand();
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Server" });
  const executors = {
    desktop: { available: true },
    terminal: { available: true },
    browser: { available: true },
    ...(system ? { mode: "system" as const } : {}),
  };
  await f.db
    .update(schema.machines)
    .set({ kind: "host", executors, access: ACCESS as never })
    .where(eq(schema.machines.id, paired.machineId));
  const runner = fakeRunner(hub, { exec: () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }) });
  await runner.hello(paired.token, { ...executors, access: ACCESS });
  const requests = () => runner.sent.filter((frame): frame is Request => frame.type === "request");
  /** Answers each request of `op` not answered yet, as the computer would. */
  const answered = new Set<string>();
  const answer = async (op: string, data: unknown) => {
    for (const r of requests().filter((r) => r.op === op && !answered.has(r.id))) {
      answered.add(r.id);
      await runner.frame({ type: "result", id: r.id, ok: true, data });
    }
  };
  return { hub, lodi, machineId: paired.machineId, runner, requests, answer };
}

/** A run of the right hand on what `userId` wrote in their own DM with it. */
async function lodiRun(lodiId: string, userId: string): Promise<ToolContext> {
  const place = (await openPersonAgentDm(f.db, f.org.id, userId, lodiId)).id;
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: place,
    author: { type: "person", userId },
    body: "run it",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: lodiId,
      channelId: place,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: lodiId,
    runId: run.id,
    channelId: place,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

const seatId = async (userId: string) => {
  const seat = await seatOf(f.db, f.org.id, userId);
  if (!seat) throw new Error("no seat");
  return seat.id;
};

const stream = (lodiId: string, userId: string, request: Parameters<typeof authorizeStream>[1]["request"]) =>
  authorizeStream(
    { db: f.db, hub: { isLocal: () => true }, pubsub: f.pubsub },
    { userId, orgId: f.org.id, agentId: lodiId, request },
  );

const TERMINAL = { kind: "terminal", cols: 80, rows: 24 } as const;
const WATCH = { kind: "desktop", mode: "watch" } as const;
const CONTROL = { kind: "desktop", mode: "control" } as const;

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

/** The base role loses every key that gives a person a computer or a browser. */
async function everyoneLosesComputers() {
  const roles = await f.db.select().from(schema.orgRoles).where(eq(schema.orgRoles.orgId, f.org.id));
  for (const role of roles.filter((r) => r.kind === "everyone")) {
    await f.db
      .update(schema.orgRoles)
      .set({ permissions: role.permissions.filter((p) => !/computers|browsers/.test(p)) })
      .where(eq(schema.orgRoles.id, role.id));
  }
}

test("a person takes control of their own seat's desktop, and nothing of it reaches another person's", async () => {
  const { lodi, machineId } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const deps = { db: f.db, pubsub: f.pubsub };
  // Control needs a take over first.
  expect(await stream(lodi.id, bia.id, CONTROL)).toMatchObject({ reason: "not_in_control" });

  const taken = await startTakeover(deps, bia.id, f.org.id, lodi.id, null, "desktop");
  expect(taken).toMatchObject({ kind: "takeover", status: "active", controllerUserId: bia.id, machineId });
  const hers = await seatId(bia.id);
  expect(await stream(lodi.id, bia.id, CONTROL)).toMatchObject({ machineId, agent: { id: hers } });

  // The owner's own seat is another screen: watched as before, with nobody in control of it and no handoff on it.
  expect(await stream(lodi.id, f.owner.id, WATCH)).toMatchObject({
    machineId,
    agent: { id: await seatId(f.owner.id) },
  });
  const theirs = await desktopStatus({ db: f.db }, f.owner.id, f.org.id, lodi.id);
  expect(theirs).toMatchObject({ controllerUserId: null, handoff: null, canControl: true });
  expect(await openHandoffOf(f.db, f.org.id, lodi.id, "desktop", f.owner.id)).toBeNull();
  // A caller that names nobody sees nothing of anyone's seat.
  expect(await openHandoffOf(f.db, f.org.id, lodi.id, "desktop")).toBeNull();
  expect((await openHandoffOf(f.db, f.org.id, lodi.id, "desktop", bia.id))?.id).toBe(taken.id);

  // Her handoff is never the owner's (an admin) to read, take or end.
  for (const attempt of [
    getHandoff(f.db, f.owner.id, f.org.id, taken.id),
    claimHandoff(deps, f.owner.id, f.org.id, taken.id),
    finishHandoff(deps, f.owner.id, f.org.id, taken.id, { result: "done" }),
    cancelHandoff(deps, f.owner.id, f.org.id, taken.id),
  ]) {
    expect(await refusal(attempt)).toBeInstanceOf(ForbiddenError);
  }

  // Only her own conversation's run waits for her; the owner's goes on, and her handoff stays hers.
  const mine = await lodiRun(lodi.id, f.owner.id);
  const herRun = await lodiRun(lodi.id, bia.id);
  expect(await waitIfPersonInControl(f.db, mine, f.pubsub, "desktop")).toBeNull();
  expect(await waitIfPersonInControl(f.db, mine, f.pubsub, "browser")).toBeNull();
  const waits = await waitIfPersonInControl(f.db, herRun, f.pubsub, "desktop");
  expect(waits?.data).toMatchObject({ handoffId: taken.id });
  const [row] = await f.db.select().from(schema.browserHandoffs).where(eq(schema.browserHandoffs.id, taken.id));
  expect(row).toMatchObject({ runId: herRun.runId, seatUserId: bia.id });

  // Both may hold their own at once.
  const own = await startTakeover(deps, f.owner.id, f.org.id, lodi.id, null, "desktop");
  expect(own.id).not.toBe(taken.id);
  expect(await stream(lodi.id, bia.id, CONTROL)).toHaveProperty("machineId");

  // Handed back: only her conversation's run reads its screen again first.
  await finishHandoff(deps, bia.id, f.org.id, taken.id, { result: "done" });
  expect((await requirePageRead(f.db, herRun, "desktop"))?.isError).toBe(true);
  await cancelHandoff(deps, f.owner.id, f.org.id, own.id);
  expect(await requirePageRead(f.db, await lodiRun(lodi.id, bia.id), "desktop")).not.toBeNull();
  const another = await addMember(f.db, f.org.id, "member", "Caio");
  expect(await requirePageRead(f.db, await lodiRun(lodi.id, another.id), "desktop")).toBeNull();
});

test("a seat's handoff changing hands switches only its own person's streams", async () => {
  const { hub, lodi } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const deps = { db: f.db, pubsub: f.pubsub };
  const open = [bia.id, f.owner.id].map(
    (userId) => ({ orgId: f.org.id, agentId: lodi.id, userId, request: CONTROL }) as unknown as Stream,
  );
  const changes: string[] = [];
  const note = (is: (s: Stream) => boolean, what: string) => {
    const hit = open.filter(is);
    changes.push(...hit.map((s) => `${s.userId} ${what}`));
    return hit.length;
  };
  const control = createDesktopControl({
    ...deps,
    hub,
    streams: {
      some: (is) => open.some(is),
      closeWhere: (is, _code, reason) => note(is, reason ?? ""),
      switchWhere: note,
      switches: () => true,
    },
  });
  try {
    const hers = await startTakeover(deps, bia.id, f.org.id, lodi.id, null, "desktop");
    await startTakeover(deps, f.owner.id, f.org.id, lodi.id, null, "desktop");
    for (let i = 0; i < 200 && changes.length < 2; i++) await Bun.sleep(5);
    // Each take over put only its own person in control: nobody was shut out of their own seat.
    expect([...changes].sort()).toEqual([`${bia.id} control`, `${f.owner.id} control`].sort());
    changes.length = 0;
    await finishHandoff(deps, bia.id, f.org.id, hers.id, { result: "done" });
    for (let i = 0; i < 200 && changes.length < 1; i++) await Bun.sleep(5);
    await Bun.sleep(50);
    expect(changes).toEqual([`${bia.id} watch`]);
  } finally {
    control.close();
  }
});

test("its browser has no handoff of its own, and it asks a person onto their own seat's desktop", async () => {
  const { hub, lodi, machineId } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  // What its first browser call in anyone's conversation writes.
  await f.db.update(schema.agents).set({ browserMachineId: machineId }).where(eq(schema.agents.id, lodi.id));
  const deps = { db: f.db, pubsub: f.pubsub };
  expect(await refusal(startTakeover(deps, bia.id, f.org.id, lodi.id, null, "browser"))).toBeInstanceOf(ForbiddenError);
  expect(await f.db.select().from(schema.browserHandoffs)).toEqual([]);

  const source = createBrowserHandoffToolSource({ pubsub: f.pubsub, machines: { hub } });
  const gateway = createToolGateway({ sources: [source] });
  const herRun = await lodiRun(lodi.id, bia.id);
  const offered = (await gateway.granted(herRun)).map((t) => t.name);
  expect(offered).toContain("desktop_ask_person");
  expect(offered).not.toContain("browser_ask_person");

  const tools = await source.tools(herRun);
  const ask = (name: string) =>
    tools.find((t) => t.name === name)?.execute({ instructions: "Sign in to the shop" }, herRun);
  const browser = await ask("browser_ask_person");
  expect(browser?.isError).toBe(true);
  expect(browser?.content).toContain("desktop_ask_person");

  const asked = await ask("desktop_ask_person");
  expect(asked?.isError).toBeFalsy();
  const [row] = await f.db.select().from(schema.browserHandoffs);
  expect(row).toMatchObject({
    kind: "ask",
    screen: "desktop",
    machineId,
    requestedForUserId: bia.id,
    seatUserId: bia.id,
    runId: herRun.runId,
  });
  // Its card is in her conversation, and the request is hers alone to read and to take.
  const [card] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, row?.id as string));
  expect(card?.channelId).toBe(herRun.channelId);
  expect(await refusal(getHandoff(f.db, f.owner.id, f.org.id, row?.id as string))).toBeInstanceOf(ForbiddenError);
  expect(await claimHandoff(deps, bia.id, f.org.id, row?.id as string)).toMatchObject({
    status: "active",
    controllerUserId: bia.id,
  });
  expect(await stream(lodi.id, bia.id, CONTROL)).toMatchObject({ agent: { id: await seatId(bia.id) } });
});

test("a member's roles and the right hand's grants decide whether they get its computer", async () => {
  const { lodi } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  expect(await stream(lodi.id, bia.id, TERMINAL)).toHaveProperty("machineId");

  // Its commands turned off on its page: no shell for anyone, while its desktop is still theirs to watch.
  const commands = and(eq(schema.agentScopes.agentId, lodi.id), eq(schema.agentScopes.scope, "sandbox:run"));
  await f.db.delete(schema.agentScopes).where(commands);
  expect(await stream(lodi.id, bia.id, TERMINAL)).toMatchObject({ reason: "not_allowed" });
  expect(await stream(lodi.id, f.owner.id, TERMINAL)).toMatchObject({ reason: "not_allowed" });
  expect(await stream(lodi.id, bia.id, WATCH)).toHaveProperty("machineId");
  await f.db
    .insert(schema.agentScopes)
    .values({ orgId: f.org.id, agentId: lodi.id, connectionId: null, scope: "sandbox:run" });
  expect(await stream(lodi.id, bia.id, TERMINAL)).toHaveProperty("machineId");

  // The role key that gives a person their own agents' computers gives them this one, and nothing else does.
  await everyoneLosesComputers();
  expect((await computerDriving(f.db, bia.id, f.org.id, lodi.id)).refusal).toBe("role");
  for (const request of [TERMINAL, WATCH, CONTROL]) {
    expect(await stream(lodi.id, bia.id, request)).toMatchObject({ reason: "forbidden" });
  }
  const taken = startTakeover({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, lodi.id, null, "desktop");
  expect(await refusal(taken)).toBeInstanceOf(ForbiddenError);
  expect(await refusal(desktopStatus({ db: f.db }, bia.id, f.org.id, lodi.id))).toBeInstanceOf(ForbiddenError);
  // The owner's own roles still give them theirs.
  expect(await stream(lodi.id, f.owner.id, TERMINAL)).toHaveProperty("machineId");
});

test("asking how its screen is makes no seat and asks the computer nothing", async () => {
  const { hub, lodi, requests } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const before = requests().length;
  const status = await desktopStatus({ db: f.db, hub }, bia.id, f.org.id, lodi.id);
  expect(status).toMatchObject({ available: true, running: false, reason: null, canControl: true });
  expect(await desktopPicture({ db: f.db, hub }, bia.id, f.org.id, lodi.id)).toEqual({
    picture: null,
    reason: "stopped",
  });
  expect(await f.db.select().from(schema.rightHandSeats)).toEqual([]);
  expect(requests().length).toBe(before);
  // Opening it is what makes one.
  expect(await stream(lodi.id, bia.id, WATCH)).toHaveProperty("machineId");
  expect((await f.db.select().from(schema.rightHandSeats)).map((s) => s.userId)).toEqual([bia.id]);
});

test("why it has no computer is told apart: no computer of the workspace's own, or one user for every agent", async () => {
  f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
  const lodi = await rightHand();
  const none = await desktopStatus({ db: f.db }, f.owner.id, f.org.id, lodi.id);
  expect(none).toMatchObject({ available: false, reason: "no_home", canControl: false });
  expect(await stream(lodi.id, f.owner.id, TERMINAL)).not.toHaveProperty("machineId");
  await f.close();

  const single = await home(false);
  const shared = await desktopStatus({ db: f.db, hub: single.hub }, f.owner.id, f.org.id, single.lodi.id);
  expect(shared).toMatchObject({ available: false, reason: "not_system" });
  expect(await stream(single.lodi.id, f.owner.id, TERMINAL)).toMatchObject({ reason: "not_system" });
  expect(await f.db.select().from(schema.rightHandSeats)).toEqual([]);
});

test("its prompt names a computer only while a tool of one is on for it", async () => {
  const { lodi } = await home();
  const mine = await lodiRun(lodi.id, f.owner.id);
  const state = () => seatState(f.db, { ...mine, id: mine.runId });
  expect(await state()).toBe("seat");
  await f.db
    .delete(schema.agentScopes)
    .where(and(eq(schema.agentScopes.agentId, lodi.id), eq(schema.agentScopes.scope, "sandbox:run")));
  expect(await state()).toBe("seat");
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.agentId, lodi.id));
  expect(await state()).toBe("none");
});

test("a held right hand works on no seat, and stopping it ends every seat's desktop", async () => {
  const { hub, lodi, machineId, requests, answer } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const seats = [await seatId(f.owner.id), await seatId(bia.id)];
  const exec = (id: string): MachineRequest => ({
    op: "exec",
    agent: { id, handle: lodi.handle },
    command: "id",
    timeoutSeconds: 5,
    stream: false,
  });
  expect(await hub.call(machineId, exec(seats[1] as string))).toMatchObject({ exitCode: 0 });

  await setAgentHold(f.db, f.org.id, lodi.id, { held: true, reason: "abuse" }, f.pubsub);
  const before = requests().length;
  const held = await refusal(hub.call(machineId, exec(seats[1] as string)));
  expect((held as { code?: string } | null)?.code).toBe("agent.paused");
  expect(requests().length).toBe(before);

  const stopped = stopOrgWork({ db: f.db, pubsub: f.pubsub, hub }, f.org.id, "held", "org_suspended", lodi.id);
  const stops = () => requests().filter((r) => r.op === "desktop.session.stop");
  for (let i = 0; i < 400 && stops().length < seats.length; i++) await Bun.sleep(5);
  await answer("desktop.session.stop", { stopped: true });
  await stopped;
  expect(
    stops()
      .map((r) => r.agent?.id)
      .sort(),
  ).toEqual([...seats].sort());
});

test("a request whose agent can't be read is not sent", async () => {
  const { hub, lodi, machineId, requests } = await home();
  const before = requests().length;
  const status: MachineRequest = { op: "desktop.session.status", agent: { id: lodi.id, handle: lodi.handle } };
  // The database fails while who the id is gets read: nothing goes out, the right hand's own id least of all.
  const down = spyOn(f.db, "select").mockImplementation(() => {
    throw new Error("the database is away");
  });
  const unread = await refusal(hub.call(machineId, status));
  down.mockRestore();
  expect((unread as Error | null)?.message).toBe("the database is away");
  expect(requests().length).toBe(before);
});

test("an interrupted task of a seat starts again only while the seat is still its person's", async () => {
  const { lodi, runner, requests } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const starts = () => requests().filter((r) => r.op === "task.start");
  /** Bia's shell task, running, then cut by its computer. */
  const cutTask = async () => {
    const ctx = await lodiRun(lodi.id, bia.id);
    const had = starts().length;
    const started = f.tools?.invoke(ctx, {
      toolUseId: crypto.randomUUID(),
      name: "start_task",
      input: { title: "Serve", executor: "shell", command: "make serve" },
    });
    for (let i = 0; i < 400 && starts().length === had; i++) await Bun.sleep(5);
    const start = starts().at(-1) as Request & { taskId: string };
    const running = { taskId: start.taskId, pid: 7, startedAt: new Date().toISOString(), cwd: "", logPath: "t.log" };
    await runner.frame({ type: "result", id: start.id, ok: true, data: running });
    await started;
    return start.taskId;
  };
  const cut = (taskId: string) =>
    runner.frame({ type: "task.done", taskId, exitCode: null, seconds: 5, interrupted: true });

  const first = await cutTask();
  const had = starts().length;
  const settled = cut(first);
  for (let i = 0; i < 400 && starts().length === had; i++) await Bun.sleep(5);
  const again = starts().at(-1) as Request & { taskId: string };
  expect(starts().length).toBe(had + 1);
  expect(again.agent?.id).toBe(await seatId(bia.id));
  await runner.frame({
    type: "result",
    id: again.id,
    ok: true,
    data: { taskId: again.taskId, pid: 8, startedAt: new Date().toISOString(), cwd: "", logPath: "t.log" },
  });
  await settled;

  // She left: what was cut after that is not started for her again.
  await removeMember(f.db, f.owner.id, f.org.id, bia.id, { pubsub: f.pubsub });
  const afterLeaving = starts().length;
  await cut(again.taskId);
  await Bun.sleep(150);
  expect(starts().length).toBe(afterLeaving);
});

test("a new seat's id never starts like an agent's or another seat's", async () => {
  const { lodi } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const taken = await seatId(f.owner.id);
  const clash = (id: string) => `${id.slice(0, 8)}-0000-4000-8000-000000000000` as ReturnType<typeof crypto.randomUUID>;
  const free = "0f0f0f0f-0000-4000-8000-000000000000" as ReturnType<typeof crypto.randomUUID>;
  const ids = [clash(lodi.id), clash(taken), free];
  const random = spyOn(crypto, "randomUUID").mockImplementation(() => ids.shift() ?? free);
  try {
    expect(await seatId(bia.id)).toBe(free);
  } finally {
    random.mockRestore();
  }
});

test("a password made on its computer is made in the asker's seat", async () => {
  const { hub, lodi, runner, requests } = await home();
  const mine = await lodiRun(lodi.id, f.owner.id);
  const sandbox = { db: f.db, machines: { hub }, publicUrl: "http://localhost:3000", vault: { db: f.db } };
  const source = createSandboxToolSource(sandbox as unknown as Parameters<typeof createSandboxToolSource>[0]);
  const tool = (await source.tools(mine)).find((t) => t.name === "vault_make_password");
  const making = tool?.execute({ name: "DB_ADMIN" }, mine);
  const asked = () => requests().find((r) => r.op === "vault.password");
  for (let i = 0; i < 400 && !asked(); i++) await Bun.sleep(5);
  expect(asked()?.agent?.id).toBe(await seatId(f.owner.id));
  await runner.frame({ type: "result", id: asked()?.id, ok: false, error: { code: "internal", message: "stop" } });
  expect((await making)?.isError).toBe(true);
  expect(requests().some((r) => r.agent?.id === lodi.id)).toBe(false);
});

test("Parar on its browser stops the asker's own seat's, and nothing where they have none", async () => {
  const { hub, lodi, requests, answer } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const stops = () => requests().filter((r) => r.op === "browser.stop");
  // No seat yet: nothing of hers runs there, and nothing is asked of the computer.
  await stopAgentBrowser(f.db, hub, bia.id, f.org.id, lodi.id, f.pubsub);
  expect(stops()).toEqual([]);
  const hers = await seatId(bia.id);
  const stopping = stopAgentBrowser(f.db, hub, bia.id, f.org.id, lodi.id, f.pubsub);
  for (let i = 0; i < 400 && stops().length === 0; i++) await Bun.sleep(5);
  await answer("browser.stop", { stopped: true });
  await stopping;
  expect(stops().map((r) => r.agent?.id)).toEqual([hers]);
});

test("a tool that can't act in a seat is not offered, and a CLI job says what to do instead", async () => {
  const { lodi, requests } = await home();
  const mine = await lodiRun(lodi.id, f.owner.id);
  const offered = (await f.tools?.granted(mine))?.map((t) => t.name) ?? [];
  expect(offered).toContain("run_code");
  expect(offered).toContain("start_task");
  expect(offered).not.toContain("request_folder_access");
  // Keeping something running goes out under the agent's own id, which reaches no computer.
  expect(offered).not.toContain("keep_running");
  const before = requests().length;
  const outcome = await f.tools?.invoke(mine, {
    toolUseId: crypto.randomUUID(),
    name: "start_task",
    input: { title: "Refactor", prompt: "Tidy the parser" },
  });
  if (outcome?.type !== "result") throw new Error("expected a result");
  expect(outcome.output.isError).toBe(true);
  expect(outcome.output.content).toContain('executor "shell"');
  expect(requests().length).toBe(before);
  const folder = await f.tools?.invoke(mine, {
    toolUseId: crypto.randomUUID(),
    name: "request_folder_access",
    input: { path: "/srv/data", reason: "read the export" },
  });
  expect(folder?.type === "result" && folder.output.isError).toBe(true);
  expect(requests().length).toBe(before);
});
