import { afterEach, expect, test } from "bun:test";
import type { MachineRequest, ServerFrame } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  auditStream,
  authorizeStream,
  claimHandoff,
  deletedAgentIds,
  desktopStatus,
  ensureRightHand,
  ForbiddenError,
  getHandoff,
  insertMessage,
  listMachines,
  type MachineHub,
  MachineRequestError,
  machineAgents,
  openHandoffOf,
  openPersonAgentDm,
  RIGHT_HAND,
  removeMachine,
  rightHandPrompt,
  rightHandTools,
  runSeat,
  SHARED_SEAT,
  type Stream,
  seatOf,
  seatState,
  setAgentAccess,
  startTakeover,
  stopAgentBrowser,
  type ToolContext,
  UNASKED_SEAT_MESSAGE,
  viewerScope,
  waitIfPersonInControl,
} from "../src";
import { openRoutineRoom } from "../src/routine-room";
import { addMember, type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine } from "./machine-fixtures";

/**
 * The right hand's shared seat (ADR 0175, amended): where others read what it does (a channel, a widget, a routine
 * that reports outside its creator's own conversation) it works in one seat of the workspace's, with its own id. A
 * person's own seat is reached only in their own DM with it by a run they asked for, and a run nobody asked for there
 * has no seat at all.
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

/** The workspace's own computer, each agent its own OS user there, with its runner connected. */
async function home() {
  f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
  const hub = f.machineHub as MachineHub;
  await ensureRightHand(f.db, f.org.id);
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Server" });
  const executors = { desktop: { available: true }, terminal: { available: true }, mode: "system" as const };
  await f.db
    .update(schema.machines)
    .set({ kind: "host", executors, access: ACCESS as never })
    .where(eq(schema.machines.id, paired.machineId));
  const ran: (string | undefined)[] = [];
  const runner = fakeRunner(hub, {
    exec(req) {
      ran.push(req.agent?.id);
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
  });
  await runner.hello(paired.token, { ...executors, access: ACCESS });
  const requests = () => runner.sent.filter((frame): frame is Request => frame.type === "request");
  return { hub, lodi, machineId: paired.machineId, runner, ran, requests };
}

const dmOf = async (lodiId: string, userId: string) => (await openPersonAgentDm(f.db, f.org.id, userId, lodiId)).id;

/** A run of the right hand on a message in `channelId`: a person's (in `threadId` when given), or another agent's. */
async function runOn(
  lodiId: string,
  channelId: string,
  author: { userId: string } | { agentId: string },
  threadId: string | null = null,
): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    threadId,
    author:
      "userId" in author
        ? { type: "person", userId: author.userId }
        : { type: "agent", agentId: author.agentId, runId: null, hop: 1, stretchId: null },
    body: "run it",
  });
  return started(lodiId, channelId, trigger.id, threadId ?? trigger.id, false);
}

/**
 * A routine's own run as it fires: in the routine's room, which nobody reads, on a brief its creator wrote that
 * reports in `reportsTo`. `widget`: it redoes a dashboard widget instead.
 */
async function routineRun(
  lodiId: string,
  creatorId: string,
  reportsTo: string,
  widget = false,
  toDrive = false,
): Promise<ToolContext> {
  const routineId = crypto.randomUUID();
  const room = await openRoutineRoom(f.db, f.org.id, lodiId, routineId);
  const routineBrief = {
    routineId,
    routineRunId: crypto.randomUUID(),
    name: "Morning check",
    creatorUserId: creatorId,
    deliverTo: { channelId: reportsTo, threadId: null },
    access: "act",
    report: "when_new",
    trigger: "schedule",
    dueAt: new Date().toISOString(),
    ...(widget ? { widget: { widgetId: crypto.randomUUID(), dashboardId: crypto.randomUUID() } } : {}),
    ...(toDrive ? { toDrive: true } : {}),
  };
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: room.id,
    author: { type: "person", userId: creatorId },
    body: "Check the morning numbers",
    meta: { background: true, routineBrief },
  });
  return started(lodiId, room.id, trigger.id, trigger.id, true);
}

async function started(
  lodiId: string,
  channelId: string,
  triggerId: string,
  threadRootId: string,
  background: boolean,
) {
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: lodiId,
      channelId,
      threadRootId,
      triggerMessageId: triggerId,
      trigger: "mention",
      hop: 1,
      status: "running",
      background,
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: lodiId,
    runId: run.id,
    channelId,
    threadRootId,
    triggerMessageId: triggerId,
  } satisfies ToolContext;
}

const call = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
  const outcome = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
  if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
  return outcome.output;
};

const runCode = (ctx: ToolContext) => call(ctx, "run_code", { language: "bash", code: "echo hi" });

const seatId = async (owner: string, make = true) => {
  const seat = await seatOf(f.db, f.org.id, owner, make);
  if (!seat) throw new Error("no seat");
  return seat.id;
};

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

const stream = (
  lodiId: string,
  userId: string,
  request: Parameters<typeof authorizeStream>[1]["request"],
  shared = false,
) =>
  authorizeStream(
    { db: f.db, hub: { isLocal: () => true }, pubsub: f.pubsub },
    { userId, orgId: f.org.id, agentId: lodiId, request, ...(shared ? { shared } : {}) },
  );

test("which seat a run works in: a person's own only for what they ask in their own DM, none for the rest there, the shared one where others read", async () => {
  const { lodi, requests } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const mine = await dmOf(lodi.id, f.owner.id);
  const hers = await dmOf(lodi.id, bia.id);

  // Their own DM with it: their own seat.
  expect(await runSeat(await runOn(lodi.id, mine, { userId: f.owner.id }))).toBe(f.owner.id);
  expect(await runSeat(await runOn(lodi.id, hers, { userId: bia.id }))).toBe(bia.id);
  // A channel, and a thread in it a person started: others read there.
  expect(await runSeat(await runOn(lodi.id, f.general.id, { userId: bia.id }))).toBe(SHARED_SEAT);
  const root = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: bia.id },
    body: "a thread of mine",
  });
  expect(await runSeat(await runOn(lodi.id, f.general.id, { userId: bia.id }, root.id))).toBe(SHARED_SEAT);
  // A routine a person made that reports in their own DM has no seat: what it read may come from outside, so it
  // gets no hold of her files and sign-ins, and her routine's work does not go where the workspace reads either.
  // The same when its files go to the Drive. One that reports in a channel: shared.
  const routine = await routineRun(lodi.id, bia.id, hers);
  expect(await runSeat(routine)).toBeNull();
  expect(await runSeat(await routineRun(lodi.id, bia.id, hers, false, true))).toBeNull();
  expect(await runSeat(await routineRun(lodi.id, bia.id, f.general.id))).toBe(SHARED_SEAT);
  // A widget is opened by others, wherever its routine was set up.
  expect(await runSeat(await routineRun(lodi.id, bia.id, hers, true))).toBe(SHARED_SEAT);
  // A run nobody is behind in a person's own DM (another agent's message, an event, a routine's report): no seat,
  // neither hers nor the shared one.
  const unasked = await runOn(lodi.id, hers, { agentId: f.agent.id });
  expect(await runSeat(unasked)).toBeNull();
  // Someone else behind a run there is not her either.
  expect(await runSeat(await runOn(lodi.id, hers, { userId: f.owner.id }))).toBeNull();
  // A private routine's brief gets no seat wherever its run is.
  expect(await runSeat({ ...routine, channelId: f.general.id })).toBeNull();

  // With no seat nothing reaches the computer, no seat is made, and the run reads why.
  const before = requests().length;
  for (const run of [routine, unasked]) {
    const refused = await runCode(run);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain(UNASKED_SEAT_MESSAGE);
    expect(await seatState(f.db, { ...run, id: run.runId })).toBe("none");
  }
  expect(requests().length).toBe(before);
  expect(await f.db.select().from(schema.rightHandSeats)).toEqual([]);

  // Its prompt follows the same choice.
  const channel = await runOn(lodi.id, f.general.id, { userId: bia.id });
  expect(await seatState(f.db, { ...channel, id: channel.runId })).toBe("shared");
  const own = await runOn(lodi.id, hers, { userId: bia.id });
  expect(await seatState(f.db, { ...own, id: own.runId })).toBe("seat");
  expect(rightHandTools("shared")).toContain("shared with the whole workspace");
  expect(rightHandTools("shared")).toContain("nothing private belongs there");
  // Only a run with no computer is told to hand on the work that needs one.
  const said = (computer?: "seat" | "shared" | "none") =>
    rightHandPrompt(
      { db: f.db },
      { orgId: f.org.id, agent: lodi, personId: bia.id, inDm: true, ...(computer ? { computer } : {}) },
    );
  for (const computer of ["seat", "shared"] as const) {
    expect(await said(computer)).toContain("you have a computer");
    expect(await said(computer)).not.toContain("or needs a computer");
  }
  expect(await said("none")).toContain("job or needs a computer: hand it on");
  expect(await said()).toContain("job or needs a computer: hand it on");
});

test("the shared seat is one row with its own id, however many first uses come at once", async () => {
  const { lodi, machineId } = await home();
  const made = await Promise.all(Array.from({ length: 8 }, () => seatOf(f.db, f.org.id, SHARED_SEAT)));
  const ids = new Set(made.map((seat) => seat?.id));
  expect(ids.size).toBe(1);
  expect(made.filter((seat) => seat?.made).length).toBe(1);
  const rows = await f.db.select().from(schema.rightHandSeats);
  expect(rows.map((row) => row.userId)).toEqual([SHARED_SEAT]);
  // No person is "shared": looking one up never answers with it, and it is nobody's own seat.
  expect(rows[0]?.id).not.toBe(lodi.id);
  expect(await viewerScope(f.db, f.org.id, lodi.id, f.owner.id, undefined, false)).toMatchObject({ scope: null });
  // The computer lists it like an agent of its own, named for what it is.
  const listed = await machineAgents(f.db, f.org.id, machineId);
  expect(listed.find((a) => a.id === rows[0]?.id)).toMatchObject({ handle: lodi.handle, name: "Lodi (shared)" });
});

test("a channel run goes out under the shared seat's id: never a person's, never the agent's own", async () => {
  const { lodi, ran, requests } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const own = [await seatId(f.owner.id), await seatId(bia.id)];
  for (const asker of [f.owner.id, bia.id]) {
    expect((await runCode(await runOn(lodi.id, f.general.id, { userId: asker }))).isError).toBeFalsy();
  }
  expect((await runCode(await routineRun(lodi.id, bia.id, f.general.id))).isError).toBeFalsy();
  const shared = await seatId(SHARED_SEAT, false);
  expect(ran).toEqual([shared, shared, shared]);
  expect(own).not.toContain(shared);
  for (const r of requests()) expect(r.agent?.id).not.toBe(lodi.id);
  // In their own DM each still works in their own.
  expect((await runCode(await runOn(lodi.id, await dmOf(lodi.id, bia.id), { userId: bia.id }))).isError).toBeFalsy();
  expect(ran.at(-1)).toBe(own[1]);
});

test("a run nobody asked for never reads or stops a task of a person's seat", async () => {
  const { lodi, runner, requests } = await home();
  const mine = await dmOf(lodi.id, f.owner.id);
  const asked = await runOn(lodi.id, mine, { userId: f.owner.id });
  const starting = call(asked, "start_task", { title: "Build", executor: "shell", command: "make" });
  for (let i = 0; i < 200 && !requests().some((r) => r.op === "task.start"); i++) await Bun.sleep(5);
  const start = requests().find((r) => r.op === "task.start");
  const taskId = (start as { taskId?: string } | undefined)?.taskId as string;
  await runner.frame({
    type: "result",
    id: start?.id,
    ok: true,
    data: { taskId, pid: 101, startedAt: new Date().toISOString(), cwd: "", logPath: "tasks/build.log" },
  });
  expect((await starting).isError).toBeFalsy();
  expect(start?.agent?.id).toBe(await seatId(f.owner.id, false));

  // Another agent's message there starts a run nobody is behind: it has no seat, so nothing of this person's.
  const unattended = await runOn(lodi.id, mine, { agentId: f.agent.id });
  const said = await call(unattended, "cancel_task", { task_id: taskId });
  expect(said.isError).toBe(true);
  expect(said.content).toContain("No such task");
  expect(requests().some((r) => r.op === "task.cancel")).toBe(false);
  // Nor reads it: its lines come from that person's seat.
  expect((await call(unattended, "task_status", { task_id: taskId })).isError).toBe(true);
  expect((await call(unattended, "list_tasks", {})).content).toContain("no background tasks");
  expect((await call(asked, "list_tasks", {})).content).toContain(taskId);
});

test("the shared seat goes with its last computer grant and with the workspace's computer, a person's stays", async () => {
  const { lodi, machineId } = await home();
  const mine = await seatId(f.owner.id);
  const first = await seatId(SHARED_SEAT);
  const noGrants = { all: false, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };

  // One computer grant left keeps it.
  await setAgentAccess(f.db, f.owner.id, f.org.id, lodi.id, {
    ...noGrants,
    scopes: [{ connectionId: null, scope: "browser:use" }],
  });
  expect(await seatId(SHARED_SEAT, false)).toBe(first);
  // So does one tool of a computer left on by name with its scope off: it still runs there.
  await setAgentAccess(f.db, f.owner.id, f.org.id, lodi.id, {
    ...noGrants,
    tools: { allow: [{ connectionId: null, name: "run_code" }], deny: [] },
  });
  expect(await seatId(SHARED_SEAT, false)).toBe(first);
  await setAgentAccess(f.db, f.owner.id, f.org.id, lodi.id, noGrants);
  expect(await seatOf(f.db, f.org.id, SHARED_SEAT, false)).toBeNull();
  // Opening it now is refused without making it again: no screen and no terminal, for it or for a person's own.
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const off = [
    await stream(lodi.id, f.owner.id, { kind: "desktop", mode: "watch" }, true),
    await stream(lodi.id, f.owner.id, { kind: "terminal", cols: 80, rows: 24 }, true),
    await stream(lodi.id, bia.id, { kind: "terminal", cols: 80, rows: 24 }),
  ];
  expect(off.map((refused) => "reason" in refused && refused.reason)).toEqual([
    "no_desktop",
    "not_allowed",
    "not_allowed",
  ]);
  expect(await seatOf(f.db, f.org.id, SHARED_SEAT, false)).toBeNull();
  expect(await seatOf(f.db, f.org.id, bia.id, false)).toBeNull();
  // The computer hears its id is gone (its processes are killed there), and no longer lists it.
  expect(await deletedAgentIds(f.db, f.org.id)).toContain(first);
  expect((await machineAgents(f.db, f.org.id, machineId)).map((a) => a.id)).toEqual([mine]);
  expect(await deletedAgentIds(f.db, f.org.id)).not.toContain(mine);

  // The next use starts another one, with another id (so another OS user and an empty home).
  const second = await seatId(SHARED_SEAT);
  expect(second).not.toBe(first);
  expect(await deletedAgentIds(f.db, f.org.id)).not.toContain(second);

  const [machine] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  if (!machine) throw new Error("no machine");
  await removeMachine({ db: f.db, pubsub: f.pubsub }, machine, { type: "person", id: f.owner.id });
  expect(await seatOf(f.db, f.org.id, SHARED_SEAT, false)).toBeNull();
  expect(await deletedAgentIds(f.db, f.org.id)).toContain(second);
  expect(await seatId(f.owner.id, false)).toBe(mine);
});

test("the hub still refuses the agent's own id, and lets the shared seat's through", async () => {
  const { hub, lodi, machineId, requests, ran } = await home();
  const shared = await seatId(SHARED_SEAT);
  const exec = (id: string): MachineRequest => ({
    op: "exec",
    agent: { id, handle: lodi.handle },
    command: "id",
    timeoutSeconds: 5,
    stream: false,
  });
  const before = requests().length;
  const error = await refusal(hub.call(machineId, exec(lodi.id)));
  expect(error).toBeInstanceOf(MachineRequestError);
  expect((error as MachineRequestError).code).toBe("not_allowed");
  expect(requests().length).toBe(before);
  expect(await hub.call(machineId, exec(shared))).toMatchObject({ exitCode: 0 });
  expect(ran).toEqual([shared]);
});

test("the shared seat opens for whoever may open an agent's computer, and each person's own stays theirs", async () => {
  const { hub, lodi, machineId, requests, runner } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const deps = { db: f.db, pubsub: f.pubsub };
  const WATCH = { kind: "desktop", mode: "watch" } as const;
  const TERMINAL = { kind: "terminal", cols: 80, rows: 24 } as const;

  // Only who may open it is shown it on the computer's page.
  const seen = async (userId: string) => (await listMachines(f.db, userId, f.org.id))[0]?.sharedSeatOf;
  expect(await seen(f.owner.id)).toBe(lodi.id);
  expect(await seen(bia.id)).toBeNull();

  // A member reaches her own seat and never the shared one; an admin reaches both, each by its own id.
  for (const request of [WATCH, TERMINAL]) {
    expect(await stream(lodi.id, bia.id, request, true)).toMatchObject({ reason: "forbidden" });
  }
  expect(await refusal(desktopStatus(deps, bia.id, f.org.id, lodi.id, true))).toBeInstanceOf(ForbiddenError);
  const shared = await seatId(SHARED_SEAT);
  expect(await stream(lodi.id, f.owner.id, TERMINAL, true)).toMatchObject({ machineId, agent: { id: shared } });
  expect(await stream(lodi.id, f.owner.id, TERMINAL)).toMatchObject({
    machineId,
    agent: { id: await seatId(f.owner.id) },
  });
  const before = requests().length;
  const status = desktopStatus({ db: f.db, hub }, f.owner.id, f.org.id, lodi.id, true);
  for (let i = 0; i < 200 && requests().length === before; i++) await Bun.sleep(5);
  const [asked] = requests().slice(before);
  expect(asked).toMatchObject({ op: "desktop.session.status", agent: { id: shared } });
  await runner.frame({ type: "result", id: asked?.id, ok: true, data: { running: false } });
  expect(await status).toMatchObject({ available: true, canControl: true, handoff: null });

  // Stopping its browser there goes to that seat, for the same people.
  expect(await refusal(stopAgentBrowser(f.db, hub, bia.id, f.org.id, lodi.id, f.pubsub, true))).toBeInstanceOf(
    ForbiddenError,
  );
  const sent = requests().length;
  const stopping = stopAgentBrowser(f.db, hub, f.owner.id, f.org.id, lodi.id, f.pubsub, true);
  for (let i = 0; i < 200 && requests().length === sent; i++) await Bun.sleep(5);
  const [stop] = requests().slice(sent);
  expect(stop).toMatchObject({ op: "browser.stop", agent: { id: shared } });
  await runner.frame({ type: "result", id: stop?.id, ok: true, data: {} });
  await stopping;

  // Taking it over holds the shared seat's screen alone: kept under no person, and said to be that seat's.
  const taken = await startTakeover(deps, f.owner.id, f.org.id, lodi.id, null, "desktop", true);
  expect(taken).toMatchObject({ kind: "takeover", status: "active", controllerUserId: f.owner.id, seat: SHARED_SEAT });
  const [row] = await f.db.select().from(schema.browserHandoffs).where(eq(schema.browserHandoffs.id, taken.id));
  expect(row?.seatUserId).toBeNull();
  expect((await openHandoffOf(f.db, f.org.id, lodi.id, "desktop", SHARED_SEAT))?.id).toBe(taken.id);
  for (const person of [f.owner.id, bia.id]) {
    expect(await openHandoffOf(f.db, f.org.id, lodi.id, "desktop", person)).toBeNull();
  }
  expect(await openHandoffOf(f.db, f.org.id, lodi.id, "desktop")).toBeNull();
  // A member can neither read nor take it.
  expect(await refusal(getHandoff(f.db, bia.id, f.org.id, taken.id))).toBeInstanceOf(ForbiddenError);
  expect(await refusal(claimHandoff(deps, bia.id, f.org.id, taken.id))).toBeInstanceOf(ForbiddenError);
  // Her own seat is another screen: watched and taken as before.
  expect(await stream(lodi.id, bia.id, WATCH)).toMatchObject({ machineId, agent: { id: await seatId(bia.id) } });
  const hers = await startTakeover(deps, bia.id, f.org.id, lodi.id, null, "desktop");
  expect(hers.seat).toBeUndefined();

  // A run in the shared seat waits for the person in control of it; a person's own conversation waits for theirs.
  const channel = await runOn(lodi.id, f.general.id, { userId: bia.id });
  const waits = await waitIfPersonInControl(f.db, { ...channel, runId: channel.runId as string }, f.pubsub, "desktop");
  expect(waits?.data).toMatchObject({ handoffId: taken.id });
  // The handoff is now bound to her run, and still she neither watches the shared seat nor reads its handoff.
  const [bound] = await f.db.select().from(schema.browserHandoffs).where(eq(schema.browserHandoffs.id, taken.id));
  expect(bound?.runId).toBe(channel.runId as string);
  expect(await stream(lodi.id, bia.id, WATCH, true)).toMatchObject({ reason: "forbidden" });
  expect(await refusal(desktopStatus(deps, bia.id, f.org.id, lodi.id, true))).toBeInstanceOf(ForbiddenError);
  expect(await refusal(getHandoff(f.db, bia.id, f.org.id, taken.id))).toBeInstanceOf(ForbiddenError);
  const own = await runOn(lodi.id, await dmOf(lodi.id, f.owner.id), { userId: f.owner.id });
  expect(await waitIfPersonInControl(f.db, { ...own, runId: own.runId as string }, f.pubsub, "desktop")).toBeNull();
});

test("the audit log says when it was the shared seat that was opened", async () => {
  const { lodi, machineId } = await home();
  const shared = await seatId(SHARED_SEAT);
  const own = await seatId(f.owner.id);
  const ran = (agentId: string, scopeId: string, sharedAsked: boolean) =>
    auditStream(f.db, {
      orgId: f.org.id,
      userId: f.owner.id,
      agentId,
      machineId,
      request: { kind: "terminal", cols: 80, rows: 24 },
      scope: { id: scopeId, handle: "lodi" },
      openedAt: Date.now(),
      bytesIn: 0,
      bytesOut: 0,
      ...(sharedAsked ? { shared: true } : {}),
    } as unknown as Stream);
  await ran(lodi.id, shared, true);
  await ran(lodi.id, own, false);
  // The flag means nothing for an agent with one screen.
  await ran(f.agent.id, f.agent.id, true);
  const rows = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "terminal.session"));
  const seatOfRow = (agentId: string) =>
    rows.filter((row) => row.targetId === agentId).map((row) => (row.details as { seat?: string }).seat);
  expect(seatOfRow(lodi.id).sort()).toEqual([SHARED_SEAT, undefined].sort());
  expect(seatOfRow(f.agent.id)).toEqual([undefined]);
});
