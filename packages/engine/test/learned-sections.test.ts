import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, migrationsFolder, schema, sql } from "@agenteschat/db";
import {
  consolidateItem,
  createAgent,
  decideProposal,
  editAgent,
  MOVE_LEARNED_JOB,
  moveLearnedSections,
  NEW_AGENT_DEFAULTS,
  proposeChange,
  proposeFromItem,
  redoAgentAction,
  splitLearned,
  undoAgentAction,
  updateAgent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const { agents, contextItems, contextProposals, outbox } = schema;

describe("splitLearned", () => {
  test("takes the section and its bullets, keeps everything a person wrote around it", () => {
    expect(splitLearned("Seja breve.\n\n## Learned\n- Uma.\n- Duas\n  em duas linhas.\n")).toEqual({
      instructions: "Seja breve.",
      lessons: ["Uma.", "Duas em duas linhas."],
    });
    expect(splitLearned("Seja breve.\n\n## Learned\n- Uma.\n\n## Tom\nFormal.")).toEqual({
      instructions: "Seja breve.\n\n## Tom\nFormal.",
      lessons: ["Uma."],
    });
    expect(splitLearned("Seja breve.\n\n##  Learned\n- Uma.\n- uma.\n\nUm parágrafo depois.")).toEqual({
      instructions: "Seja breve.\n\nUm parágrafo depois.",
      lessons: ["Uma."],
    });
    expect(splitLearned("Seja breve.\n\n## Learned\n")).toEqual({ instructions: "Seja breve.", lessons: [] });
    expect(splitLearned("## Learned things\n- Fica.")).toEqual({
      instructions: "## Learned things\n- Fica.",
      lessons: [],
    });
  });
});

describe("moveLearnedSections", () => {
  test("moves an agent's section into its memory once, with who taught each lesson and when", async () => {
    f = await setup();
    const walter = await addMember(f.db, f.org.id, "member", "Walter");
    const decidedAt = new Date("2026-10-20T12:00:00Z");
    // A lesson a person accepted from memory: its item was archived when it went into the instructions.
    const item = (
      await consolidateItem(f.db, {
        orgId: f.org.id,
        kind: "lesson",
        scopeType: "agent",
        agentId: f.agent.id,
        content: "Rodar os testes antes do PR.",
        trust: "high",
        evidence: [{ type: "human", ref: crypto.randomUUID(), at: decidedAt.toISOString() }],
      })
    ).item;
    await f.db.update(contextItems).set({ status: "archived" }).where(eq(contextItems.id, item.id));
    const instructions =
      "Seja breve.\n\n## Learned\n- Rodar os testes antes do PR.\n- Walter: sempre citar a fonte.\n- Responder em português.";
    await f.db.update(agents).set({ instructions }).where(eq(agents.id, f.agent.id));
    const accepted = { orgId: f.org.id, target: "agent_instructions" as const, agentId: f.agent.id, baseHash: "x" };
    await f.db.insert(contextProposals).values([
      {
        ...accepted,
        proposedText: instructions,
        diff: " Seja breve.\n+\n+## Learned\n+- Rodar os testes antes do PR.",
        rationale: "",
        itemIds: [item.id],
        status: "accepted",
        decidedByUserId: f.owner.id,
        decidedAt,
      },
      {
        ...accepted,
        proposedText: instructions,
        diff: "+- Responder em português.",
        rationale: "",
        requestedByUserId: walter.id,
        status: "accepted",
        decidedByUserId: f.owner.id,
        decidedAt,
      },
    ]);

    // The migration queues the job once per workspace with a section.
    await f.db.execute(sql.raw(readFileSync(join(migrationsFolder, "0310_move_learned_sections.sql"), "utf8")));
    await f.db.execute(sql.raw(readFileSync(join(migrationsFolder, "0310_move_learned_sections.sql"), "utf8")));
    const jobs = await f.db.select().from(outbox).where(eq(outbox.kind, MOVE_LEARNED_JOB));
    expect(jobs.map((j) => j.orgId)).toEqual([f.org.id]);
    // It waits out a deploy's overlap with the version that has no handler for it.
    expect(jobs[0]?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);

    expect(await moveLearnedSections(f.db, f.org.id)).toBe(3);
    const [agent] = await f.db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(agent?.instructions).toBe("Seja breve.");
    const lessons = await f.db
      .select()
      .from(contextItems)
      .where(and(eq(contextItems.agentId, f.agent.id), eq(contextItems.status, "active")));
    expect(lessons.map((i) => i.content).sort()).toEqual([
      "Responder em português.",
      "Rodar os testes antes do PR.",
      "sempre citar a fonte.",
    ]);
    expect(lessons.find((i) => i.id === item.id)).toBeDefined();
    expect(lessons.find((i) => i.content === "sempre citar a fonte.")).toMatchObject({
      kind: "lesson",
      createdByKind: "person",
      createdById: walter.id,
    });
    const asked = lessons.find((i) => i.content === "Responder em português.");
    expect(asked).toMatchObject({ createdByKind: "person", createdById: walter.id, createdAt: decidedAt });
    expect(asked?.proposedAt).not.toBeNull();

    // Once: a second run changes nothing.
    expect(await moveLearnedSections(f.db, f.org.id)).toBe(0);
    expect((await f.db.select().from(contextItems).where(eq(contextItems.agentId, f.agent.id))).length).toBe(3);
  });

  test("a credential stays where a person put it", async () => {
    f = await setup();
    const instructions = "Seja breve.\n\n## Learned\n- Usar a chave sk-fake0000000000000000000000.\n- Ser cordial.";
    await f.db.update(agents).set({ instructions }).where(eq(agents.id, f.agent.id));
    expect(await moveLearnedSections(f.db, f.org.id)).toBe(1);
    const [agent] = await f.db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(agent?.instructions).toBe("Seja breve.\n\n## Learned\n- Usar a chave sk-fake0000000000000000000000.");
  });
});

describe("an agent created or saved with a section", () => {
  const lessonsOf = async (agentId: string) =>
    f.db
      .select()
      .from(contextItems)
      .where(and(eq(contextItems.agentId, agentId), eq(contextItems.status, "active")));

  test("created (a copy, an import): the section becomes its memory, as the creator's lessons", async () => {
    f = await setup();
    const made = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Eva", handle: "eva", instructions: "Seja breve.\n\n## Learned\n- Citar a fonte." },
      NEW_AGENT_DEFAULTS,
    );
    expect(made.instructions).toBe("Seja breve.");
    expect(await lessonsOf(made.id)).toMatchObject([
      { content: "Citar a fonte.", kind: "lesson", createdByKind: "person", createdById: f.owner.id },
    ]);
  });

  test("saved: the section leaves the instructions, a credential stays", async () => {
    f = await setup();
    const instructions = "Seja breve.\n\n## Learned\n- Ser cordial.\n- Usar a chave sk-fake0000000000000000000000.";
    const saved = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { instructions });
    expect(saved.instructions).toBe("Seja breve.\n\n## Learned\n- Usar a chave sk-fake0000000000000000000000.");
    expect((await lessonsOf(f.agent.id)).map((i) => i.content)).toEqual(["Ser cordial."]);
    // The profile's save, one transaction: the same lesson saved again is not a second memory.
    const edited = await editAgent({ db: f.db }, f.owner.id, f.org.id, f.agent.id, {
      fields: { instructions: "Seja breve.\n\n## Learned\n- Ser cordial." },
    });
    expect(edited.instructions).toBe("Seja breve.");
    expect((await lessonsOf(f.agent.id)).map((i) => i.content)).toEqual(["Ser cordial."]);
  });
});

describe("Undo and Redo of an instructions change", () => {
  const withSection = "Seja breve.\n\n## Learned\n- Citar a fonte.";
  // [what the change replaced, what it wrote, the text the agent has now]: the section in the text Undo puts back,
  // then in the text Redo puts back (its write already moved the section, so the agent has the text without it).
  test.each([
    [withSection, "Seja formal.", "Seja formal."],
    ["Seja formal.", withSection, "Seja breve."],
  ])("put a section back into memory again, never twice, and find what they left (%#)", async (from, to, now) => {
    f = await setup();
    await f.db.update(agents).set({ instructions: now }).where(eq(agents.id, f.agent.id));
    if (to === withSection)
      await f.db.insert(contextItems).values({
        orgId: f.org.id,
        agentId: f.agent.id,
        kind: "lesson",
        scopeType: "agent",
        scopeId: f.agent.id,
        content: "Citar a fonte.",
      });
    const [receipt] = await f.db
      .insert(schema.agentActions)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        requestedByUserId: f.owner.id,
        kind: "agent.settings_changed",
        targetType: "agent",
        targetId: f.agent.id,
        params: { agentName: "Dev", fields: ["instructions"] },
        before: { lines: [{ field: "instructions", from, to }] },
        undoableUntil: new Date(Date.now() + 60_000),
      })
      .returning();
    const deps = { db: f.db, pubsub: f.pubsub };
    const state = async () => ({
      instructions: (await f.db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]?.instructions,
      lessons: (
        await f.db
          .select()
          .from(contextItems)
          .where(and(eq(contextItems.agentId, f.agent.id), eq(contextItems.status, "active")))
      ).map((i) => i.content),
    });
    const held = (text: string) => splitLearned(text).instructions;

    await undoAgentAction(deps, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await state()).toEqual({ instructions: held(from), lessons: ["Citar a fonte."] });
    await redoAgentAction(deps, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await state()).toEqual({ instructions: held(to), lessons: ["Citar a fonte."] });
    await undoAgentAction(deps, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await state()).toEqual({ instructions: held(from), lessons: ["Citar a fonte."] });
  });
});

describe("rules added to instructions", () => {
  test("go at their end, never under a Learned heading", async () => {
    f = await setup();
    const { proposals } = await proposeChange(
      { db: f.db, pubsub: f.pubsub, judge: f.context.judge },
      {
        orgId: f.org.id,
        agentId: f.agent.id,
        target: "agent_instructions",
        change: "Responder em português.",
        rationale: "",
        requesterId: f.owner.id,
      },
    );
    for (const p of proposals) await decideProposal(f.db, f.owner.id, f.org.id, p.id, "accept");
    const lesson = (
      await consolidateItem(f.db, {
        orgId: f.org.id,
        kind: "lesson",
        scopeType: "agent",
        agentId: f.agent.id,
        content: "Citar a fonte.",
        trust: "high",
        evidence: [{ type: "human", ref: crypto.randomUUID(), at: new Date().toISOString() }],
        confidence: 0.9,
      })
    ).item;
    const promoted = await proposeFromItem(f, { ...lesson, recurrence: 2 });
    await decideProposal(f.db, f.owner.id, f.org.id, promoted?.id ?? "", "accept");
    const [agent] = await f.db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(agent?.instructions).not.toContain("## Learned");
    expect(agent?.instructions.endsWith("\n\n- Responder em português.\n- Citar a fonte.")).toBe(true);
  });
});
