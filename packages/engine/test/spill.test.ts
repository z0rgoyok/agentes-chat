import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import {
  type Brain,
  type BrainEvent,
  type BrainTurn,
  COMPUTER_BUSY_RETRY_MS,
  clearPlanLimits,
  createAgent,
  createJobHandlers,
  drainOutbox,
  enqueue,
  getAgent,
  insertMessage,
  installHelpClis,
  type MachineHub,
  type MachineStatus,
  postPersonMessage,
  resolveBrain,
  setDevicesHelp,
  updateComputerDevice,
} from "../src";
import { SPILL_AFTER_MS } from "../src/spill";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { channelRoutine, fire } from "./routine-fixtures";

/**
 * Devices as extra capacity (ADR 0233): while the agent's own computer is full or away, a fresh turn thinks on another
 * online computer of the workspace that helps, in a fresh session there, and later turns at home never resume that
 * session. A person's reply looks at once; an agent's ask or a routine once it waited `SPILL_AFTER_MS`.
 */

let f: Fixture;
afterEach(() => {
  clearPlanLimits();
  return f?.close();
});

const RUNNER = { os: "darwin" as const, arch: "arm64", version: "0.8.0", protocol: MACHINE_PROTOCOL_VERSION };

const statusOf = (id: string): MachineStatus => ({
  id,
  orgId: "org",
  name: "Mac",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
});

async function pair(userId: string, name: string) {
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, {
    name,
    hostname: name,
    ...RUNNER,
    exec: true,
  });
  await f.db
    .update(schema.machines)
    .set({ online: true, lastSeenAt: new Date() })
    .where(eq(schema.machines.id, machineId));
  return machineId;
}

/** Rio, `fullHome`'s other agent on the same computer. */
let rioId = "";

/** The agent thinks with Claude Code on `home`, where a person's turn already waits for room. */
async function fullHome() {
  const home = await pair(f.owner.id, "home");
  await f.db
    .update(schema.agents)
    .set({ machineId: home, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  // Another agent's: a person's message for ours would join a run of its own in the conversation.
  const rio = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Rio", handle: "rio", role: "Dev", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.update(schema.agents).set({ machineId: home, brain: "claude_code" }).where(eq(schema.agents.id, rio.id));
  rioId = rio.id;
  // No key the API could answer with: nothing stands in.
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const id = Bun.randomUUIDv7();
  await f.db.insert(schema.agentRuns).values({
    orgId: f.org.id,
    agentId: rio.id,
    channelId: f.general.id,
    threadRootId: id,
    triggerMessageId: id,
    trigger: "mention",
    hop: 1,
    status: "waiting_input",
    waitingMachineId: home,
    transcript: {
      waitingForBrain: { kind: "claude_code", machineId: home, code: "busy", waitId: Bun.randomUUIDv7() },
      roomPeople: true,
      roomWaitSince: Date.now() - 60_000,
    },
  });
  return home;
}

function brainSeeing() {
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      seen.push(turn);
      yield { type: "usage", input: 10, output: 2, source: "plan" } as BrainEvent;
      yield { type: "done", text: "Pronto." } as BrainEvent;
    },
  };
  return { brain, seen };
}

const handlersSeeing = (status: (id: string) => MachineStatus = statusOf) => {
  const { brain, seen } = brainSeeing();
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => status(id) },
  });
  return { handlers, seen };
};

/** The run waited in its computer's line `SPILL_AFTER_MS` and more: its next look may go elsewhere. */
const waitedLong = (runId: string) =>
  f.db
    .update(schema.agentRuns)
    .set({
      transcript: sql`jsonb_set(${schema.agentRuns.transcript}, '{roomWaitSince}', to_jsonb(${Date.now() - SPILL_AFTER_MS - 60_000}::bigint))`,
    })
    .where(eq(schema.agentRuns.id, runId));

const runOf = async (id: string) => (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];

const ask = async (status?: (id: string) => MachineStatus) => {
  const { handlers, seen } = handlersSeeing(status);
  const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev oi",
  });
  await drainOutbox(f.db, handlers);
  const all = await f.db.select().from(schema.agentRuns);
  const run = all.find((r) => r.triggerMessageId === asked.id);
  return { run, seen, handlers };
};

test("a full computer: the person's turn thinks on their own laptop, fresh there; home never resumes that session", async () => {
  f = await setup();
  const home = await fullHome();
  const laptop = await pair(f.owner.id, "laptop");
  const { run, seen } = await ask();
  expect(run?.status).toBe("done");
  expect(seen.map((t) => t.session?.machineId)).toEqual([laptop]);
  expect(seen[0]?.session?.resume).toBe(false);
  expect(run?.transcript).toMatchObject({ spill: { from: home, to: laptop } });

  // Another run in that conversation, at home: a session of its own, not the one on the laptop.
  const [next] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: run?.threadRootId as string,
      triggerMessageId: Bun.randomUUIDv7(),
      trigger: "mention",
      hop: 1,
    })
    .returning();
  const agent = await getAgent(f.db, f.org.id, f.agent.id);
  if (!agent || !next) throw new Error("no agent");
  const plan = await resolveBrain(
    { db: f.db, machines: { status: async (id) => statusOf(id) } },
    agent,
    next,
    run?.threadRootId as string,
  );
  expect(plan.session?.machineId).toBe(home);
  expect(plan.session?.id).not.toBe(run?.brainSessionId);
});

test("no spill-over where its owner turned it off, nor to someone else's own computer: only to one marked the workspace's", async () => {
  f = await setup();
  const home = await fullHome();
  const laptop = await pair(f.owner.id, "laptop");
  await f.db.update(schema.machines).set({ spillOwn: false }).where(eq(schema.machines.id, laptop));
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  // Rui's own computer helps and lets everyone in, and the agent's owner has a sign-in on it: still not for her agents.
  const theirs = await pair(rui.id, "theirs");
  await f.db.update(schema.machines).set({ audienceMode: "everyone" }).where(eq(schema.machines.id, theirs));
  await f.db.insert(schema.machineAccounts).values({
    orgId: f.org.id,
    machineId: theirs,
    id: Bun.randomUUIDv7(),
    kind: "claude_code",
    label: "Ana's Claude",
    createdBy: f.owner.id,
  });
  const first = await ask();
  expect(first.run?.status).toBe("waiting_input");
  expect(first.run?.waitingMachineId).toBe(home);
  expect(first.seen).toEqual([]);

  // Marked the workspace's, the turn waiting behind the other agent's looks again and thinks there, on the owner's sign-in.
  await f.db.update(schema.machines).set({ belongsToWorkspace: true }).where(eq(schema.machines.id, theirs));
  await drainOutbox(f.db, first.handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000) });
  expect((await runOf(first.run?.id ?? ""))?.status).toBe("done");
  expect(first.seen.map((t) => t.session?.machineId)).toEqual([theirs]);
  expect(first.seen[0]?.account?.label).toBe("Ana's Claude");
});

test("an admin's workspace switch keeps every computer from helping, whatever its owner's switch", async () => {
  f = await setup();
  const home = await fullHome();
  await pair(f.owner.id, "laptop");
  await setDevicesHelp({ db: f.db }, f.owner.id, f.org.id, false);
  const { run, seen } = await ask();
  expect(run?.status).toBe("waiting_input");
  expect(run?.waitingMachineId).toBe(home);
  expect(seen).toEqual([]);
});

test("a routine waits in line first, and once it waited long thinks on its owner's laptop", async () => {
  f = await setup();
  const home = await fullHome();
  const laptop = await pair(f.owner.id, "laptop");
  const { handlers, seen } = handlersSeeing();
  const fired = await fire(f, (await channelRoutine(f)).id, new Date());
  await drainOutbox(f.db, handlers);
  const id = fired.agentRunId ?? "";
  expect((await runOf(id))?.waitingMachineId).toBe(home);
  expect(seen).toEqual([]);

  await waitedLong(id);
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000) });
  expect((await runOf(id))?.status).toBe("done");
  expect(seen.map((t) => t.session?.machineId)).toEqual([laptop]);
  expect((await runOf(id))?.transcript).toMatchObject({ spill: { from: home, to: laptop, cause: "full" } });
});

test("a run that looked for another computer and found none looks again only once it waited that long again", async () => {
  f = await setup();
  const home = await fullHome();
  // Rui's own computer helps, but never with someone else's agents: a look finds nothing.
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const theirs = await pair(rui.id, "theirs");
  await f.db.update(schema.machines).set({ audienceMode: "everyone" }).where(eq(schema.machines.id, theirs));
  await f.db.insert(schema.machineAccounts).values({
    orgId: f.org.id,
    machineId: theirs,
    id: Bun.randomUUIDv7(),
    kind: "claude_code",
    label: "Ana's Claude",
    createdBy: f.owner.id,
  });
  const { handlers, seen } = handlersSeeing();
  const fired = await fire(f, (await channelRoutine(f)).id, new Date());
  await drainOutbox(f.db, handlers);
  const id = fired.agentRunId ?? "";
  await waitedLong(id);
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000) });
  expect((await runOf(id))?.waitingMachineId).toBe(home);
  expect((await runOf(id))?.transcript).toHaveProperty("spillLookedAt");

  // Marked the workspace's, it could take the routine now; the next retries of the line don't look yet.
  await f.db.update(schema.machines).set({ belongsToWorkspace: true }).where(eq(schema.machines.id, theirs));
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 2 * COMPUTER_BUSY_RETRY_MS + 1_000) });
  expect((await runOf(id))?.waitingMachineId).toBe(home);
  expect(seen).toEqual([]);

  await f.db
    .update(schema.agentRuns)
    .set({
      transcript: sql`jsonb_set(${schema.agentRuns.transcript}, '{spillLookedAt}', to_jsonb(${Date.now() - SPILL_AFTER_MS - 1_000}::bigint))`,
    })
    .where(eq(schema.agentRuns.id, id));
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 3 * COMPUTER_BUSY_RETRY_MS + 1_000) });
  expect((await runOf(id))?.status).toBe("done");
  expect(seen.map((t) => t.session?.machineId)).toEqual([theirs]);
});

test("another agent's ask waits in line first, and once it waited long thinks on the laptop", async () => {
  f = await setup();
  const home = await fullHome();
  const laptop = await pair(f.owner.id, "laptop");
  const { handlers, seen } = handlersSeeing();
  const [rioRun] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, rioId));
  const asked = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId: rioId, runId: rioRun?.id ?? "", hop: 1 },
    body: "@dev quantos pedidos hoje?",
  });
  const [mine] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
      trigger: "mention",
      hop: 2,
    })
    .returning();
  const id = mine?.id ?? "";
  await enqueue(f.db, { orgId: f.org.id, kind: "agent_run.execute", payload: { runId: id } });
  await drainOutbox(f.db, handlers);
  expect((await runOf(id))?.hop).toBe(2);
  expect((await runOf(id))?.waitingMachineId).toBe(home);
  expect(seen).toEqual([]);

  await waitedLong(id);
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000) });
  expect((await runOf(id))?.status).toBe("done");
  expect(seen.map((t) => t.session?.machineId)).toEqual([laptop]);
});

test("its computer away: the reply thinks on the laptop at once, and says where and why", async () => {
  f = await setup();
  const home = await pair(f.owner.id, "Team computer");
  await f.db
    .update(schema.agents)
    .set({ machineId: home, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const laptop = await pair(f.owner.id, "Ana's MacBook");
  const away = new Date(Date.now() - 3_600_000).toISOString();
  const { run, seen } = await ask((id) =>
    id === home ? { ...statusOf(id), online: false, lastSeenAt: away } : statusOf(id),
  );
  expect(run?.status).toBe("done");
  expect(seen.map((t) => t.session?.machineId)).toEqual([laptop]);
  const [reply] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.agentRunId, run?.id ?? ""));
  expect(reply?.meta).toMatchObject({ spilled: { to: "Ana's MacBook", from: "Team computer", cause: "away" } });
});

test("turning its help on starts installing the CLIs its owner's agents think with that it lacks", async () => {
  f = await setup();
  await f.db.update(schema.agents).set({ brain: "claude_code" }).where(eq(schema.agents.id, f.agent.id));
  const laptop = await pair(f.owner.id, "laptop");
  const calls: unknown[] = [];
  const hub = {
    status: async (id: string) => statusOf(id),
    call: async (_id: string, op: { tool?: unknown }) => {
      calls.push(op);
      return { install: { tool: op.tool, state: "running" } };
    },
  } as unknown as Pick<MachineHub, "call" | "status">;
  expect(await installHelpClis({ db: f.db, hub }, f.owner.id, f.org.id, laptop)).toEqual(["claude"]);
  expect(calls).toEqual([{ op: "cli.install", action: "start", tool: "claude" }]);
  // Someone else's computer: nothing.
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  expect(await installHelpClis({ db: f.db, hub }, rui.id, f.org.id, laptop)).toEqual([]);
});

test("a computer its owner uses for their agents' work takes their routine at once, while a person's reply stays home", async () => {
  f = await setup();
  const home = await pair(f.owner.id, "Team computer");
  await f.db
    .update(schema.agents)
    .set({ machineId: home, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const pc = await pair(f.owner.id, "Ana's PC");
  await updateComputerDevice({ db: f.db }, f.owner.id, f.org.id, pc, { spill: { first: true } });

  // Home has room: the routine still starts on the computer its owner chose, and says why.
  const { handlers, seen } = handlersSeeing();
  const fired = await fire(f, (await channelRoutine(f)).id, new Date());
  await drainOutbox(f.db, handlers);
  const id = fired.agentRunId ?? "";
  expect((await runOf(id))?.status).toBe("done");
  expect(seen.map((t) => t.session?.machineId)).toEqual([pc]);
  expect((await runOf(id))?.transcript).toMatchObject({ spill: { from: home, to: pc, cause: "chosen" } });

  // A person's reply starts on the agent's own computer while it has room.
  const reply = await ask();
  expect(reply.run?.status).toBe("done");
  expect(reply.seen.map((t) => t.session?.machineId)).toEqual([home]);
});

test("a computer used for its owner's agents' work that can't take the routine never keeps it from a computer that helps", async () => {
  f = await setup();
  const home = await fullHome();
  // The chosen PC has no Claude Code: it can't take the routine.
  const pc = await pair(f.owner.id, "pc");
  await updateComputerDevice({ db: f.db }, f.owner.id, f.org.id, pc, { spill: { first: true } });
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const shared = await pair(rui.id, "shared");
  await f.db
    .update(schema.machines)
    .set({ belongsToWorkspace: true, audienceMode: "everyone" })
    .where(eq(schema.machines.id, shared));
  await f.db.insert(schema.machineAccounts).values({
    orgId: f.org.id,
    machineId: shared,
    id: Bun.randomUUIDv7(),
    kind: "claude_code",
    label: "Owner's Claude",
    createdBy: f.owner.id,
  });
  const { handlers, seen } = handlersSeeing((id) =>
    id === pc ? { ...statusOf(id), executors: { detectedAt: new Date().toISOString() } } : statusOf(id),
  );
  const fired = await fire(f, (await channelRoutine(f)).id, new Date());
  await drainOutbox(f.db, handlers);
  const id = fired.agentRunId ?? "";
  expect((await runOf(id))?.waitingMachineId).toBe(home);

  await waitedLong(id);
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000) });
  expect((await runOf(id))?.status).toBe("done");
  expect(seen.map((t) => t.session?.machineId)).toEqual([shared]);
  expect((await runOf(id))?.transcript).toMatchObject({ spill: { from: home, to: shared, cause: "full" } });
});

test("used for its owner's agents' work turns its help on, and help off turns both off; only its owner chooses it", async () => {
  f = await setup();
  const pc = await pair(f.owner.id, "Ana's PC");
  await f.db.update(schema.machines).set({ spillOwn: false }).where(eq(schema.machines.id, pc));
  const on = await updateComputerDevice({ db: f.db }, f.owner.id, f.org.id, pc, { spill: { first: true } });
  expect(on.spill).toEqual({ own: true, first: true });
  const off = await updateComputerDevice({ db: f.db }, f.owner.id, f.org.id, pc, { spill: { own: false } });
  expect(off.spill).toEqual({ own: false, first: false });
  const admin = await addMember(f.db, f.org.id, "admin", "rui");
  await expect(
    updateComputerDevice({ db: f.db }, admin.id, f.org.id, pc, { spill: { first: true } }),
  ).rejects.toMatchObject({ code: "device.spill_owner_only" });
});
