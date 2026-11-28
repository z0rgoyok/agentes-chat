import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, typingTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainTurn,
  createJobHandlers,
  drainOutbox,
  type MachineStatus,
  openDm,
  postPersonMessage,
  publishTyping,
  TYPING_WARM_EVERY_MS,
  warmWhileTyping,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(() => f?.close());

const statusOf = (machineId: string, over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

/** The fixture's agent on Claude Code on a paired computer, a fake brain that keeps its turns and warm starts. */
async function claudeCodeAgent(fx: Fixture, status: Partial<MachineStatus> = {}) {
  const paired = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, fx.agent.id));
  const turns: BrainTurn[] = [];
  const warmed: BrainTurn[] = [];
  const woken: string[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      turns.push(turn);
      yield { type: "done", text: "ok" };
    },
    warm: async (turn) => void warmed.push(turn),
  };
  const deps = {
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id: string) => statusOf(id, status),
      wake: async (id: string) => void woken.push(id),
    },
  };
  return { deps, handlers: createJobHandlers(deps), turns, warmed, woken, machineId: paired.machineId };
}

test("typing in a DM warms the session its next turn takes, once per conversation every two minutes", async () => {
  f = await setup();
  const { deps, handlers, turns, warmed } = await claudeCodeAgent(f);
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  const say = (body: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body });
  const where = { orgId: f.org.id, channelId: dm.id, threadId: null, userId: f.owner.id };
  const now = Date.now();
  // No session here yet: the first turn's is named after its run, so there is nothing to warm.
  await warmWhileTyping(deps, where, now - TYPING_WARM_EVERY_MS);
  expect(warmed).toHaveLength(0);
  await say("oi");
  await drainOutbox(f.db, handlers);
  const before = warmed.length;
  await warmWhileTyping(deps, where, now);
  await warmWhileTyping(deps, where, now + 3000);
  const typed = warmed.slice(before);
  expect(typed).toHaveLength(1);
  expect(typed[0]?.session?.id).toBe(turns[0]?.session?.id);
  expect(typed[0]?.system).toBe("");

  // The message comes: its turn is on the session, model and effort the warm started.
  await say("e agora?");
  await drainOutbox(f.db, handlers);
  expect(turns).toHaveLength(2);
  expect([turns[1]?.session?.id, turns[1]?.model, turns[1]?.effort]).toEqual([
    typed[0]?.session?.id,
    typed[0]?.model,
    typed[0]?.effort,
  ]);

  // Two minutes on, typing there warms it again.
  const later = warmed.length;
  await warmWhileTyping(deps, where, now + TYPING_WARM_EVERY_MS);
  expect(warmed.slice(later).map((t) => t.session?.id)).toEqual([turns[1]?.session?.id]);
});

test("in a thread: the agent that last replied there, only for a person who may talk to it", async () => {
  f = await setup();
  const { deps, handlers, turns, warmed } = await claudeCodeAgent(f);
  const question = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev oi",
  });
  await drainOutbox(f.db, handlers);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev e agora?",
    threadId: question.id,
  });
  await drainOutbox(f.db, handlers);
  const inThread = turns.at(-1)?.session?.id;
  // Only its owner may talk to it: someone else typing there warms nothing.
  await f.db
    .update(schema.agents)
    .set({ audienceMode: "owner", ownerUserId: f.owner.id })
    .where(eq(schema.agents.id, f.agent.id));
  const member = await addMember(f.db, f.org.id, "member");
  const before = warmed.length;
  await warmWhileTyping(deps, { orgId: f.org.id, channelId: f.general.id, threadId: question.id, userId: member.id });
  expect(warmed).toHaveLength(before);
  await warmWhileTyping(deps, { orgId: f.org.id, channelId: f.general.id, threadId: question.id, userId: f.owner.id });
  // The member's frame took the conversation's turn: the owner's comes after it.
  await warmWhileTyping(
    deps,
    { orgId: f.org.id, channelId: f.general.id, threadId: question.id, userId: f.owner.id },
    Date.now() + TYPING_WARM_EVERY_MS,
  );
  expect(warmed.slice(before).map((t) => t.session?.id)).toEqual([inThread]);
});

test("a typing line the server posts (a voice note from a connected app, `meta.via`) warms nothing", async () => {
  f = await setup();
  const { handlers, warmed } = await claudeCodeAgent(f);
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "oi" });
  await drainOutbox(f.db, handlers);
  const before = warmed.length;
  const heard: unknown[] = [];
  f.pubsub.subscribe(typingTopic, (e) => heard.push(e));
  await publishTyping(f.pubsub, { channelId: dm.id, threadId: null, userId: f.owner.id, kind: "voice" });
  await Bun.sleep(20);
  expect(heard).toHaveLength(1);
  expect(warmed).toHaveLength(before);
});

test("a computer in standby is woken, as the message would wake it, and warmed by a frame once it is up", async () => {
  f = await setup();
  const status: Partial<MachineStatus> = {};
  const { deps, handlers, warmed, woken, machineId } = await claudeCodeAgent(f, status);
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "oi" });
  await drainOutbox(f.db, handlers);
  const before = warmed.length;
  const asked = woken.length;
  Object.assign(status, { online: false, standby: true });
  const where = { orgId: f.org.id, channelId: dm.id, threadId: null, userId: f.owner.id };
  await warmWhileTyping(deps, where);
  expect(woken.slice(asked)).toEqual([machineId]);
  expect(warmed).toHaveLength(before);
  Object.assign(status, { online: true, standby: false });
  await warmWhileTyping(deps, where);
  expect(warmed).toHaveLength(before + 1);
});
