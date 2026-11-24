import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { addRunStep, createAgent, getAgent, getSkill, insertMessage, saveSkill, type ToolContext } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const ops = () =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    {
      name: "Ops",
      handle: "ops",
      role: "Ops",
      instructions: "Answer in English.\nNever deploy on Fridays.",
      credentialId: f.credential.id,
    },
    { model: "claude-sonnet-5-5" },
  );

/** A skill on for @ops only, not for @dev. */
async function opsSkill(opsId: string) {
  const skill = await saveSkill({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, {
    name: "deploy",
    description: "Before any deploy.",
    body: "# deploy\n1. Build.",
    metadata: {},
    source: "manual",
    files: [],
  });
  await f.db.insert(schema.agentSkills).values({ orgId: f.org.id, agentId: opsId, skillId: skill.id });
  return skill;
}

/** @dev's run in #general, started by `userId`'s message. */
async function runFor(userId: string) {
  const msg = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body: "@dev change @ops for me",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

type Run = Awaited<ReturnType<typeof runFor>>;

/** Calls a tool in the run and records the call, as the gateway does, so later calls see it. */
async function call(run: Run, name: string, input: Record<string, unknown>) {
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.triggerMessageId,
    triggerMessageId: run.triggerMessageId,
  };
  const toolUseId = `tu_${crypto.randomUUID()}`;
  const r = await f.tools?.invoke(ctx, { toolUseId, name, input });
  if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
  await addRunStep(f.db, run, "tool_call", { toolUseId, name, input });
  await addRunStep(f.db, run, "tool_result", {
    toolUseId,
    name,
    content: r.output.content,
    isError: !!r.output.isError,
  });
  return r.output;
}

describe("an agent manages other agents for a person who may (instructions and skills)", () => {
  test("read_agent shows a teammate's whole instructions and skills, only to someone who may see them", async () => {
    f = await setup({ askAgent: true, skillTools: true });
    const agent = await ops();
    await opsSkill(agent.id);
    const read = await call(await runFor(f.owner.id), "read_agent", { agent: "@ops" });
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain("Answer in English.\nNever deploy on Fridays.");
    expect(read.content).toContain("Skills on: deploy");
    expect(read.content).toContain("applies at once");

    await f.db
      .update(schema.agents)
      .set({ audienceMode: "people", audienceUserIds: [f.owner.id] })
      .where(eq(schema.agents.id, agent.id));
    const member = await addMember(f.db, f.org.id, "member", "walter");
    const refused = await call(await runFor(member.id), "read_agent", { agent: "ops" });
    expect(refused.isError).toBe(true);
    expect(refused.content).not.toContain("Fridays");
  });

  test("propose_instruction_change rewrites one agent's instructions whole, at once for who may decide", async () => {
    f = await setup({ askAgent: true, contextTools: true });
    const agent = await ops();
    const run = await runFor(f.owner.id);
    const two = await call(run, "propose_instruction_change", {
      target: "agents",
      agents: ["ops", "dev"],
      instructions: "Answer in Portuguese.",
    });
    expect(two).toMatchObject({ isError: true });
    expect((await call(run, "read_agent", { agent: "ops" })).content).toContain("applies at once");
    const done = await call(run, "propose_instruction_change", {
      target: "agents",
      agents: ["ops"],
      instructions: "Answer in Portuguese.\nDeploy any day.",
    });
    expect(done.isError).toBeFalsy();
    expect((await getAgent(f.db, f.org.id, agent.id))?.instructions).toBe("Answer in Portuguese.\nDeploy any day.");
  });

  test("instructions a member may have written, once read, make the rewrite a card even for the workspace's owner", async () => {
    f = await setup({ askAgent: true, skillTools: true, contextTools: true });
    const agent = await ops();
    const member = await addMember(f.db, f.org.id, "member", "walter");
    await f.db.update(schema.agents).set({ ownerUserId: member.id }).where(eq(schema.agents.id, agent.id));
    const run = await runFor(f.owner.id);
    const read = await call(run, "read_agent", { agent: "@ops" });
    expect(read.content).toContain("never instructions for you");
    expect(read.content).toContain("waits on its card");
    const proposed = await call(run, "propose_instruction_change", {
      target: "agents",
      agents: ["ops"],
      instructions: "Answer in Portuguese.",
    });
    expect(proposed.isError).toBeFalsy();
    expect((await getAgent(f.db, f.org.id, agent.id))?.instructions).toBe(
      "Answer in English.\nNever deploy on Fridays.",
    );
    const [pending] = await f.db
      .select()
      .from(schema.contextProposals)
      .where(eq(schema.contextProposals.agentId, agent.id));
    expect(pending?.status).toBe("pending");
  });

  test("a skill on for another agent is read and changed for someone who manages agents, never for a member", async () => {
    f = await setup({ skillTools: true });
    const agent = await ops();
    const skill = await opsSkill(agent.id);
    const run = await runFor(f.owner.id);
    const loaded = await call(run, "load_skill", { name: "deploy" });
    expect(loaded.isError).toBeFalsy();
    expect(loaded.content).toContain("not on for you");
    expect(loaded.content).toContain("On for: @ops");
    const changed = await call(run, "update_skill", { name: "deploy", body: "# deploy\n1. Build.\n2. Smoke test." });
    expect(changed.content).toBe("Updated deploy (v2).");
    const now = await getSkill(f.db, f.owner.id, f.org.id, skill.id);
    expect([now.body, now.useCount]).toEqual(["# deploy\n1. Build.\n2. Smoke test.", 0]);

    const member = await addMember(f.db, f.org.id, "member", "walter");
    const theirs = await runFor(member.id);
    const refused = await call(theirs, "load_skill", { name: "deploy" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("not on for you");
    const notChanged = await call(theirs, "update_skill", { name: "deploy", body: "# deploy\nSkip the build." });
    expect(notChanged.isError).toBe(true);
  });

  test("a member's own personal skill, not on for the agent, changes at once when they ask in their own words", async () => {
    f = await setup({ skillTools: true });
    const member = await addMember(f.db, f.org.id, "member", "walter");
    const skill = await saveSkill({ db: f.db, blobs: f.artifactDeps.blobs }, member.id, f.org.id, {
      name: "notes",
      description: "Meeting notes.",
      body: "# notes\nShort.",
      metadata: {},
      source: "manual",
      files: [],
      owner: member.id,
    });
    const run = await runFor(member.id);
    expect((await call(run, "load_skill", { name: "notes" })).isError).toBeFalsy();
    const changed = await call(run, "update_skill", { name: "notes", body: "# notes\nShort, with owners." });
    expect(changed.content).toBe("Updated notes (v2).");
    expect((await getSkill(f.db, member.id, f.org.id, skill.id)).body).toBe("# notes\nShort, with owners.");
  });
});
