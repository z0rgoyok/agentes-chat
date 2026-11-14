import { afterEach, expect, test } from "bun:test";
import type { MachineRequest, ServerFrame } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  authorizeStream,
  deletedAgentIds,
  desktopStatus,
  ensureRightHand,
  insertMessage,
  listMachines,
  type MachineHub,
  MachineRequestError,
  machineAgents,
  openPersonAgentDm,
  RIGHT_HAND,
  removeMember,
  SHARED_SEAT,
  seatOf,
  seatState,
  type ToolContext,
  UNASKED_SEAT_MESSAGE,
  viewerScope,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine } from "./machine-fixtures";

/**
 * The right hand's computer (ADR 0175): one agent answers everyone, so each person has their own seat on the
 * workspace's computer, and nothing reaches a computer under the agent's own id but its locked chat turn.
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

/** The workspace's own computer with its runner connected; `system`: each agent is its own OS user there. */
async function home(system = true) {
  f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
  const hub = f.machineHub as MachineHub;
  await ensureRightHand(f.db, f.org.id);
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Server" });
  const executors = {
    desktop: { available: true },
    terminal: { available: true },
    ...(system ? { mode: "system" as const } : {}),
  };
  await f.db
    .update(schema.machines)
    .set({ kind: "host", executors, access: ACCESS as never })
    .where(eq(schema.machines.id, paired.machineId));
  const ran: { command: string; agent: string | undefined }[] = [];
  const runner = fakeRunner(hub, {
    exec(req) {
      ran.push({ command: req.command, agent: req.agent?.id });
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
  });
  await runner.hello(paired.token, { ...executors, access: ACCESS });
  const requests = () => runner.sent.filter((frame): frame is Request => frame.type === "request");
  return { hub, lodi, machineId: paired.machineId, runner, ran, requests };
}

/** A run of the right hand on what `userId` wrote in `channelId` (their own DM with it when left out). */
async function lodiRun(
  lodiId: string,
  userId: string,
  options: { channelId?: string; routine?: boolean } = {},
): Promise<ToolContext> {
  const place = options.channelId ?? (await openPersonAgentDm(f.db, f.org.id, userId, lodiId)).id;
  const routineBrief = {
    routineId: crypto.randomUUID(),
    routineRunId: crypto.randomUUID(),
    name: "Morning check",
    creatorUserId: userId,
    deliverTo: { channelId: place, threadId: null },
    access: "act",
    report: "when_new",
    trigger: "webhook",
    dueAt: new Date().toISOString(),
  };
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: place,
    author: { type: "person", userId },
    body: "run it",
    ...(options.routine ? { meta: { background: true, routineBrief } } : {}),
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
      background: options.routine === true,
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

const call = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
  const outcome = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
  if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
  return outcome.output;
};

const runCode = (ctx: ToolContext) => call(ctx, "run_code", { language: "bash", code: "echo hi" });

const seatId = async (userId: string) => {
  const seat = await seatOf(f.db, f.org.id, userId);
  if (!seat) throw new Error("no seat");
  return seat.id;
};

/** What the runner names an OS user from (`agentId8`): the first 8 letters and digits of the id. */
const id8 = (id: string) => id.replace(/[^a-z0-9]/gi, "").slice(0, 8);

test("one seat per person, and two people's OS user names differ", async () => {
  const { lodi, machineId } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const first = await seatOf(f.db, f.org.id, f.owner.id);
  expect(first?.made).toBe(true);
  expect(await seatOf(f.db, f.org.id, f.owner.id)).toEqual({ id: first?.id as string, made: false });
  const hers = await seatId(bia.id);
  expect(id8(hers)).not.toBe(id8(first?.id as string));
  expect(id8(hers)).not.toBe(id8(lodi.id));
  // Nobody outside the workspace has one.
  expect(await seatOf(f.db, f.org.id, crypto.randomUUID())).toBeNull();

  // The computer lists each like an agent of its own, named for its person.
  const listed = await machineAgents(f.db, f.org.id, machineId);
  expect(listed.find((a) => a.id === hers)).toMatchObject({
    handle: lodi.handle,
    name: "Lodi (Bia)",
    containers: true,
  });
  expect(listed.some((a) => a.id === first?.id)).toBe(true);
  expect(listed.some((a) => a.id === lodi.id)).toBe(false);
  // The apps find its computer where any agent's is: on that computer's list.
  const [server] = await listMachines(f.db, bia.id, f.org.id);
  expect(server?.agents.map((a) => a.id)).toContain(lodi.id);
});

test("a person's own DM sends their own seat's id, never another's and never the agent's", async () => {
  const { lodi, ran } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const mine = await lodiRun(lodi.id, f.owner.id);
  const hers = await lodiRun(lodi.id, bia.id);
  expect((await runCode(mine)).isError).toBeFalsy();
  expect((await runCode(hers)).isError).toBeFalsy();
  expect(ran.map((r) => r.agent)).toEqual([await seatId(f.owner.id), await seatId(bia.id)]);
  expect(ran.some((r) => r.agent === lodi.id)).toBe(false);
  expect(await seatState(f.db, { ...mine, id: mine.runId })).toBe("seat");
});

test("a background task runs in the asker's seat, and what follows it names that seat too", async () => {
  const { lodi, runner, requests } = await home();
  const mine = await lodiRun(lodi.id, f.owner.id);
  const seat = await seatId(f.owner.id);
  const before = requests().length;
  const started = call(mine, "start_task", { title: "Build", executor: "shell", command: "make" });
  for (let i = 0; i < 200 && !requests().some((r) => r.op === "task.start"); i++) await Bun.sleep(5);
  const start = requests().find((r) => r.op === "task.start");
  expect(start?.agent?.id).toBe(seat);
  const taskId = (start as { taskId?: string } | undefined)?.taskId as string;
  await runner.frame({
    type: "result",
    id: start?.id,
    ok: true,
    data: { taskId, pid: 101, startedAt: new Date().toISOString(), cwd: "", logPath: "tasks/build.log" },
  });
  expect((await started).isError).toBeFalsy();
  const [row] = await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, taskId));
  expect(row).toMatchObject({ agentId: lodi.id, scopeId: seat });

  const stopped = call(mine, "cancel_task", { task_id: taskId });
  for (let i = 0; i < 200 && !requests().some((r) => r.op === "task.cancel"); i++) await Bun.sleep(5);
  const cancel = requests().find((r) => r.op === "task.cancel");
  expect(cancel?.agent?.id).toBe(seat);
  await runner.frame({ type: "result", id: cancel?.id, ok: true, data: { canceled: true } });
  await stopped;
  for (const r of requests().slice(before)) expect(r.agent?.id).not.toBe(lodi.id);
});

test("a channel mention works in the shared seat, and a routine in its creator's own DM has no seat", async () => {
  const { lodi, ran, requests } = await home();
  const channel = await lodiRun(lodi.id, f.owner.id, { channelId: f.general.id });
  expect((await runCode(channel)).isError).toBeFalsy();
  expect(await seatState(f.db, { ...channel, id: channel.runId })).toBe("shared");
  // Nothing was made for the person: the shared seat is the workspace's.
  expect((await f.db.select().from(schema.rightHandSeats)).map((s) => s.userId)).toEqual([SHARED_SEAT]);
  const shared = await seatId(SHARED_SEAT);
  expect(ran.map((r) => r.agent)).toEqual([shared]);

  // A routine's run may carry what it read from outside: it gets neither its creator's seat nor the shared one.
  const routine = await lodiRun(lodi.id, f.owner.id, { routine: true });
  const before = requests().length;
  const said = await runCode(routine);
  expect(said.isError).toBe(true);
  expect(said.content).toContain(UNASKED_SEAT_MESSAGE);
  expect(requests().length).toBe(before);
  expect(await seatState(f.db, { ...routine, id: routine.runId })).toBe("none");
  expect(await seatOf(f.db, f.org.id, f.owner.id, false)).toBeNull();
  expect(ran.some((r) => r.agent === lodi.id)).toBe(false);
});

test("a computer that runs every agent as one user gives it no seat: refused, nothing sent", async () => {
  const { lodi, ran, requests } = await home(false);
  const before = requests().length;
  const ctx = await lodiRun(lodi.id, f.owner.id);
  const said = await runCode(ctx);
  expect(said.isError).toBe(true);
  expect(said.content).toContain("it runs every agent as one user");
  expect(ran).toEqual([]);
  expect(requests().length).toBe(before);
  expect(await seatState(f.db, { ...ctx, id: ctx.runId })).toBe("none");
  const [server] = await listMachines(f.db, f.owner.id, f.org.id);
  expect(server?.agents.map((a) => a.id)).not.toContain(lodi.id);
});

test("the hub refuses the agent's own id for anything but its locked chat turn", async () => {
  const { hub, lodi, machineId, requests } = await home();
  const agent = { id: lodi.id, handle: lodi.handle };
  const before = requests().length;
  const refused: MachineRequest[] = [
    { op: "exec", agent, command: "id", timeoutSeconds: 5, stream: false },
    { op: "read", agent, path: "notes.txt", maxBytes: 10 },
    { op: "browser.stop", agent },
    { op: "desktop.look", agent },
    { op: "task.status", agent },
    { op: "task.cancel", agent, taskId: crypto.randomUUID() },
    { op: "brain.turn", agent, permissions: { mode: "work" } } as never,
  ];
  for (const request of refused) {
    const error = await hub.call(machineId, request as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MachineRequestError);
    expect((error as MachineRequestError).code).toBe("not_allowed");
  }
  expect(requests().length).toBe(before);

  // Its locked turn, and what follows it, go out under its own id as before.
  const passes = [
    { op: "brain.turn", agent, permissions: { mode: "chat" }, mcp: { token: "not-a-real-token" } },
    { op: "brain.steer", agent },
  ];
  for (const request of passes) {
    const error = await hub.call(machineId, request as never, { timeoutMs: 100 }).catch((e: unknown) => e);
    expect((error as { code?: string } | undefined)?.code).not.toBe("not_allowed");
  }
  expect(
    requests()
      .slice(before)
      .map((r) => r.op),
  ).toEqual(["brain.turn", "brain.steer"]);
});

test("a removed member's seat reaches the computer's deleted list, and coming back starts a new one", async () => {
  const { machineId } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const hers = await seatId(bia.id);
  expect(await deletedAgentIds(f.db, f.org.id)).not.toContain(hers);

  await removeMember(f.db, f.owner.id, f.org.id, bia.id, { pubsub: f.pubsub });
  expect(await deletedAgentIds(f.db, f.org.id)).toContain(hers);
  expect((await machineAgents(f.db, f.org.id, machineId)).some((a) => a.id === hers)).toBe(false);
  expect(await seatOf(f.db, f.org.id, bia.id)).toBeNull();

  await f.db.insert(schema.organizationMembers).values({ orgId: f.org.id, userId: bia.id, role: "member" });
  const again = await seatId(bia.id);
  expect(again).not.toBe(hers);
  expect(await deletedAgentIds(f.db, f.org.id)).toContain(hers);
});

test("what a person opens of its computer is their own seat, whoever they are", async () => {
  const { hub, lodi, machineId, requests, runner } = await home();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const mine = await seatId(f.owner.id);
  const hers = await seatId(bia.id);

  // The one function every person's request goes through: it takes who asks, never whose seat.
  for (const [viewer, seat] of [
    [f.owner.id, mine],
    [bia.id, hers],
  ] as const) {
    const scope = await viewerScope(f.db, f.org.id, lodi.id, viewer);
    expect(scope).toMatchObject({ machineId, seat: true, scope: { id: seat } });
  }

  // Watching, driving and a terminal: a member reaches her own, and the owner (an admin) only theirs.
  const stream = (userId: string, request: Parameters<typeof authorizeStream>[1]["request"]) =>
    authorizeStream(
      { db: f.db, hub: { isLocal: () => true }, pubsub: f.pubsub },
      { userId, orgId: f.org.id, agentId: lodi.id, request },
    );
  for (const request of [
    { kind: "terminal", cols: 80, rows: 24 },
    { kind: "desktop", mode: "watch" },
  ] as const) {
    expect(await stream(bia.id, request)).toMatchObject({ machineId, agent: { id: hers } });
    expect(await stream(f.owner.id, request)).toMatchObject({ machineId, agent: { id: mine } });
  }

  // Its screen's state is asked of the asker's own seat.
  const before = requests().length;
  const status = desktopStatus({ db: f.db, hub }, bia.id, f.org.id, lodi.id);
  for (let i = 0; i < 200 && requests().length === before; i++) await Bun.sleep(5);
  const [asked] = requests().slice(before);
  expect(asked).toMatchObject({ op: "desktop.session.status", agent: { id: hers } });
  await runner.frame({ type: "result", id: asked?.id, ok: true, data: { running: false } });
  expect((await status).available).toBe(true);

  // Someone outside the workspace reaches nothing.
  const outsider = await stream(crypto.randomUUID(), { kind: "terminal", cols: 80, rows: 24 });
  expect(outsider).not.toHaveProperty("machineId");
});
