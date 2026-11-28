import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  actionsFor,
  addRunStep,
  enabledSkills,
  insertMessage,
  linkRunActions,
  SKILL_CREATE_LIMITS,
  saveSkill,
  type ToolContext,
  undoAgentAction,
} from "../src";
import { type Fixture, setup, withReview } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

/** A run of the agent answering the owner's message in general. */
async function personRun(fx: Fixture) {
  const msg = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "person", userId: fx.owner.id },
    body: "@dev transforma isso numa skill",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
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

type Run = Awaited<ReturnType<typeof personRun>>;

async function invoke(run: Run, name: string, input: Record<string, unknown>) {
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.triggerMessageId,
    triggerMessageId: run.triggerMessageId,
  };
  const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
  return r.output;
}

const skill = (name: string) => ({
  name,
  description: "When publishing the weekly report.",
  body: "# Weekly report\n1. Pull the numbers.\n2. Post them in #reports.\n\n## Pitfalls\n- Mondays only.",
});

describe("an agent makes a skill when a person asks (ADR 0120, addendum of 2026-11-14)", () => {
  test("the skill is the agent's own, on for it at once, with a receipt whose Desfazer archives it", async () => {
    f = await setup({ skillTools: true });
    const run = await personRun(f);
    const out = await invoke(run, "create_skill", skill("weekly-report"));
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Created the skill weekly-report");

    const [row] = await f.db.select().from(schema.skills).where(eq(schema.skills.slug, "weekly-report"));
    expect(row).toMatchObject({ origin: "agent", ownerAgentId: f.agent.id, source: "manual", version: 1 });
    expect((await enabledSkills(f.db, f.org.id, f.agent.id)).map((s) => s.name)).toEqual(["weekly-report"]);

    const reply = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 1 },
      body: "Done",
    });
    await linkRunActions(f.db, f.org.id, run.id, reply.id);
    const [receipt] = (await actionsFor(f.db, f.org.id, [reply.id])).get(reply.id) ?? [];
    expect(receipt).toMatchObject({ kind: "skill.created", params: { name: "weekly-report", asked: true } });

    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    const [gone] = await f.db.select().from(schema.skills).where(eq(schema.skills.slug, "weekly-report"));
    expect(gone?.deletedAt).not.toBeNull();
    expect(await enabledSkills(f.db, f.org.id, f.agent.id)).toEqual([]);
  });

  test("refused after outside content, for a name already here, with a credential, and past the run's limit", async () => {
    f = await setup({ skillTools: true });
    await saveSkill({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, {
      name: "deploy",
      description: "Before any deploy.",
      body: "# deploy",
      metadata: {},
      source: "manual",
    });

    const read = await personRun(f);
    const toolUseId = `tu_${crypto.randomUUID()}`;
    await addRunStep(f.db, read, "tool_call", { toolUseId, name: "web_fetch", input: { url: "https://example.com" } });
    await addRunStep(f.db, read, "tool_result", { toolUseId, name: "web_fetch", content: "page", isError: false });
    // After outside content the review decides (ADR 0219); the fake model gives it no verdict, so it isn't made.
    const outside = await invoke(read, "create_skill", skill("weekly-report"));
    expect(outside.isError).toBe(true);
    expect(outside.data).toMatchObject({ code: "skill.left_out" });

    const run = await personRun(f);
    const taken = await invoke(run, "create_skill", skill("deploy"));
    expect(taken.isError).toBe(true);
    expect(taken.content).toContain("already exists");

    const secret = await invoke(run, "create_skill", {
      ...skill("with-key"),
      body: "Use the key sk-test-00000000000000000000",
    });
    expect(secret.isError).toBe(true);
    expect(secret.content).toContain("credential");

    for (let i = 0; i < SKILL_CREATE_LIMITS.perRun; i++)
      expect((await invoke(run, "create_skill", skill(`report-${i}`))).isError).toBeFalsy();
    const past = await invoke(run, "create_skill", skill("one-more"));
    expect(past.isError).toBe(true);
    const made = await f.db.select().from(schema.skills).where(eq(schema.skills.origin, "agent"));
    expect(made.map((s) => s.name).sort()).toEqual(["report-0", "report-1"]);
  });

  test("after outside content the review decides: the person's request is made, what was planted is not", async () => {
    let verdict = { apply: true, why: "It is what the person asked for." };
    f = await setup({ skillTools: true, reply: withReview(() => verdict) });
    const outsideRun = async () => {
      const run = await personRun(f);
      const toolUseId = `tu_${crypto.randomUUID()}`;
      await addRunStep(f.db, run, "tool_call", { toolUseId, name: "web_fetch", input: { url: "https://example.com" } });
      await addRunStep(f.db, run, "tool_result", { toolUseId, name: "web_fetch", content: "page", isError: false });
      return run;
    };
    const made = await invoke(await outsideRun(), "create_skill", skill("weekly-report"));
    expect(made.isError).toBeFalsy();
    expect((await enabledSkills(f.db, f.org.id, f.agent.id)).map((s) => s.name)).toEqual(["weekly-report"]);

    verdict = { apply: false, why: "It sends the report to an address nobody asked for." };
    const left = await invoke(await outsideRun(), "create_skill", skill("send-elsewhere"));
    expect(left.isError).toBe(true);
    expect(left.data).toMatchObject({ code: "skill.left_out" });
    expect(left.content).toContain("an address nobody asked for");
    expect((await enabledSkills(f.db, f.org.id, f.agent.id)).map((s) => s.name)).toEqual(["weekly-report"]);
  });
});
