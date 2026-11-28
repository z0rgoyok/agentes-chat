import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  agentSkillList,
  agentSkillSuggestions,
  describeSkill,
  draftSkill,
  ForbiddenError,
  insertMessage,
  listSkills,
  queueSkillDescribe,
  recordSkillUse,
  rewriteSkill,
  SKILL_DESCRIBE_JOB,
  saveDraftedSkill,
  saveSkill,
  setAgentLearnsSkills,
  setSkillTitle,
  skillHistory,
  skillRecentUses,
  skillZip,
  type ToolContext,
  undoSkillUpdate,
} from "../src";
import { listZip } from "../src/zip";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

type Reply = NonNullable<Parameters<typeof setup>[0]>["reply"];

/** The workspace's summary model, answering each of the library's calls by its system prompt. */
const library =
  (answers: { describe?: object; draft?: object; rewrite?: object; suggest?: (prompt: string) => object }): Reply =>
  (request) => {
    const system = systemText(request.system);
    const last = request.messages.at(-1)?.content;
    const prompt = typeof last === "string" ? last : JSON.stringify(last);
    const json = system.startsWith("You describe a skill")
      ? answers.describe
      : system.startsWith("You write a skill")
        ? answers.draft
        : system.startsWith("You change a skill")
          ? answers.rewrite
          : system.startsWith("You look at what one AI agent")
            ? answers.suggest?.(prompt)
            : undefined;
    return { chunks: [json ? JSON.stringify(json) : "ok"] };
  };

const deps = (fx: Fixture) => ({ db: fx.db, blobs: fx.artifactDeps.blobs });

const weekly = (fx: Fixture) =>
  saveSkill(deps(fx), fx.owner.id, fx.org.id, {
    name: "weekly-report",
    description: "Every Friday, the week's sales.",
    body: "1. Pull the week's sales.\n2. Compare with last week.\n3. Post in #sales.",
    metadata: {},
    source: "manual",
  });

describe("the skill library as people read it (ADR 0020, amendment of 2026-11-25)", () => {
  test("a line and an icon for people, written once from its text; it keeps its own name, or a person's", async () => {
    f = await setup({
      reply: library({ describe: { summary: "Every Friday, the week's sales.", icon: "chart" } }),
    });
    const skill = await weekly(f);
    const [queued] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, SKILL_DESCRIBE_JOB));
    expect(queued?.payload).toEqual({ skillId: skill.id });
    await describeSkill(f.context, f.org.id, skill.id);
    const [row] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skill.id));
    // One line with no end period; the name is the skill's own.
    expect(row).toMatchObject({ title: null, summary: "Every Friday, the week's sales", icon: "chart" });

    await setSkillTitle(deps(f), f.owner.id, f.org.id, skill.id, "Friday report");
    await f.db.update(schema.skills).set({ describedHash: null }).where(eq(schema.skills.id, skill.id));
    await describeSkill(f.context, f.org.id, skill.id);
    const [named] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skill.id));
    expect(named).toMatchObject({ title: "Friday report", titleByPerson: true });
    // Emptied, it goes back to its own name.
    await setSkillTitle(deps(f), f.owner.id, f.org.id, skill.id, "");
    const [own] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skill.id));
    expect(own).toMatchObject({ title: null, titleByPerson: false });
  });

  test("uses: how many times each agent loaded it this week, and where, for whoever is in that conversation", async () => {
    f = await setup({ skillTools: true });
    const skill = await weekly(f);
    await f.db.insert(schema.agentSkills).values({ orgId: f.org.id, agentId: f.agent.id, skillId: skill.id });
    const msg = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "@dev the weekly report, please",
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
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: run.channelId,
      threadRootId: run.triggerMessageId,
      triggerMessageId: run.triggerMessageId,
    };
    const loaded = await f.tools?.invoke(ctx, {
      toolUseId: "tu_1",
      name: "load_skill",
      input: { name: "weekly-report" },
    });
    expect(loaded?.type).toBe("result");
    await recordSkillUse(f.db, ctx, skill.id);

    const [listed] = await listSkills(f.db, f.owner.id, f.org.id);
    expect(listed).toMatchObject({ id: skill.id, weekUses: 2, agentIds: [f.agent.id] });
    const mine = (await agentSkillList(f.db, f.owner.id, f.org.id, f.agent.id)).find((s) => s.id === skill.id);
    expect(mine).toMatchObject({ enabled: true, agentWeekUses: 2 });
    const [last] = await skillRecentUses(f.db, f.owner.id, f.org.id, skill.id);
    expect(last).toMatchObject({ agentId: f.agent.id, channelId: f.general.id, messageId: msg.id });
    expect(last?.excerpt).toContain("the weekly report");
  });

  test("taught in words: the draft names the apps a chosen agent lacks; saved as written and on for the agents", async () => {
    f = await setup({
      reply: library({
        draft: {
          name: "weekly-refunds",
          title: "Weekly refunds",
          summary: "Every Monday, the week's refund requests",
          description: "Refund requests, every Monday.",
          body: "1. Find the week's requests.\n2. Check the 7 days.\n3. Answer each one.",
          icon: "wallet",
          apps: [],
        },
      }),
    });
    const draft = await draftSkill(f.context, f.owner.id, f.org.id, {
      words: "Every Monday, answer the week's refund requests within 7 days.",
      agentIds: [f.agent.id],
    });
    expect(draft).toMatchObject({ name: "weekly-refunds", title: "Weekly refunds", icon: "wallet", apps: [] });

    const saved = await saveDraftedSkill(deps(f), f.owner.id, f.org.id, { ...draft });
    const [row] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, saved.id));
    expect(row).toMatchObject({ slug: "weekly-refunds", title: "Weekly refunds", titleByPerson: true, icon: "wallet" });
    // The same name again is a new skill, never a new version of the first.
    const again = await saveDraftedSkill(deps(f), f.owner.id, f.org.id, { ...draft });
    expect(again.name).toBe("weekly-refunds-2");

    const member = await addMember(f.db, f.org.id, "member", "bruno");
    await expect(
      draftSkill(f.context, member.id, f.org.id, { words: "Anything", agentIds: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("quotes and dashes around a name are read in linear time", async () => {
    f = await setup();
    const started = performance.now();
    const saved = await saveDraftedSkill(deps(f), f.owner.id, f.org.id, {
      name: `${"-".repeat(100_000)}weekly${"-".repeat(100_000)}x`,
      title: `${'"'.repeat(100_000)}Weekly refunds${'"'.repeat(100_000)}x`,
      summary: "Every Monday",
      description: "Refund requests, every Monday.",
      body: "1. Answer them.",
      icon: "wallet",
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(saved.name).toBe("weekly-x");
    const [row] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, saved.id));
    expect(row?.title?.startsWith("Weekly refunds")).toBe(true);
  });

  test("a change asked in words applies at once with Undo, and the history says who asked what", async () => {
    f = await setup({
      reply: library({
        rewrite: {
          description: "Every Friday, the week's sales.",
          body: "1. Pull the week's sales.\n2. Take out the returns.\n3. Compare with last week.\n4. Post in #sales.",
        },
      }),
    });
    const skill = await weekly(f);
    const changed = await rewriteSkill(f.context, deps(f), f.owner.id, f.org.id, skill.id, "Take out the returns");
    expect(changed.version).toBe(2);
    expect(changed.body).toContain("Take out the returns");
    const history = await skillHistory(f.db, changed, f.org.id);
    expect(history[0]).toMatchObject({ kind: "rewritten", words: "Take out the returns", undoable: true });
    expect(history[0]?.after).toContain("returns");

    const back = await undoSkillUpdate(deps(f), f.owner.id, f.org.id, skill.id);
    expect(back.body).not.toContain("returns");
  });

  test("what an agent could learn: the summary model's picks from its week, kept for a day", async () => {
    let asked = 0;
    f = await setup({
      reply: library({
        suggest: (prompt) => {
          asked++;
          const id = /- id ([0-9a-f-]{36}):/.exec(prompt)?.[1];
          return { picks: id ? [{ id, why: "It answered four refund requests this week" }] : [] };
        },
      }),
    });
    const skill = await weekly(f);
    const msg = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "@dev answer the refund requests",
    });
    await f.db.insert(schema.agentRuns).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "done",
    });
    const picks = await agentSkillSuggestions(f.context, f.owner.id, f.org.id, f.agent.id);
    expect(picks).toEqual([{ skillId: skill.id, why: "It answered four refund requests this week" }]);
    expect(await agentSkillSuggestions(f.context, f.owner.id, f.org.id, f.agent.id)).toEqual(picks);
    expect(asked).toBe(1);
  });

  test("a .zip of its folder, and learning on its own switched off by who edits the agent", async () => {
    f = await setup();
    const skill = await weekly(f);
    const { name, data } = await skillZip(deps(f), f.owner.id, f.org.id, skill.id);
    expect(name).toBe("weekly-report");
    expect(listZip(data).map((e) => e.path)).toEqual(["SKILL.md"]);

    await setAgentLearnsSkills(f.db, f.owner.id, f.org.id, f.agent.id, false);
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.learnsSkills).toBe(false);
    const member = await addMember(f.db, f.org.id, "member", "bruno");
    await expect(setAgentLearnsSkills(f.db, member.id, f.org.id, f.agent.id, true)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await queueSkillDescribe(f.db, f.org.id, skill.id);
  });
});
