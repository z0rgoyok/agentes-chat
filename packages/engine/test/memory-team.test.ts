import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createAgent,
  ForbiddenError,
  insertContextItem,
  insertMessage,
  makeTeamMemory,
  NotFoundError,
  retrieveForRun,
  type ToolContext,
  teamMemoryForPrompt,
  teamMemoryKind,
  ValidationError,
} from "../src";
import { addMember, type Fixture, queuedReviews, settleQueued, setup, withReview } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** @dev's run in #general answering a message by `author` (a person, or an agent). */
async function runOn(author: { userId: string } | { agentId: string }, body: string): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author:
      "userId" in author
        ? { type: "person", userId: author.userId }
        : { type: "agent", agentId: author.agentId, runId: null, hop: 1, stretchId: null },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

async function remember(ctx: ToolContext, input: Record<string, unknown>) {
  if (!f.tools) throw new Error("no tools");
  const res = await f.tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: "remember", input });
  if (res.type !== "result") throw new Error(res.type);
  return res.output as { content: string; isError?: boolean };
}

const ops = () =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );

describe("team memory every agent reads (ADR 0167)", () => {
  test("'everyone, remember' from someone who reviews memory is one team item, in every run's cached prompt", async () => {
    f = await setup({ contextTools: true });
    const out = await remember(await runOn({ userId: f.owner.id }, "pessoal, lembrem: relatórios em português"), {
      for: "team",
      kind: "preference",
      content: "Reports go out in Portuguese.",
    });
    expect(out.content).toContain("Saved for the team");
    const [item] = await f.db.select().from(schema.contextItems);
    expect([item?.agentId, item?.createdByKind, item?.createdById, item?.channelIds]).toEqual([
      null,
      "person",
      f.owner.id,
      [],
    ]);
    const prompt = await teamMemoryForPrompt(f.db, f.org.id);
    expect(prompt).toContain("# Team memory");
    expect(prompt).toContain(
      `[preference · ana, ${new Date().toISOString().slice(0, 10)}] Reports go out in Portuguese.`,
    );
    // Not twice: the per-run memory leaves it to the cached prompt.
    const other = await ops();
    const memory = await retrieveForRun(f.context, {
      orgId: f.org.id,
      agentId: other.id,
      channelId: f.general.id,
      text: "reports portuguese",
    });
    expect(memory.text).not.toContain("Reports go out in Portuguese.");
  });

  test("one kept for a single conversation comes in every run there, whatever it is about", async () => {
    f = await setup({ contextTools: true });
    await remember(await runOn({ userId: f.owner.id }, "pessoal, aqui no #general respondam curto"), {
      for: "team",
      kind: "preference",
      content: "In #general, answers stay short.",
      everywhere: false,
    });
    expect(await teamMemoryForPrompt(f.db, f.org.id)).toBe("");
    const other = await ops();
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: other.id });
    const memory = await retrieveForRun(f.context, {
      orgId: f.org.id,
      agentId: other.id,
      channelId: f.general.id,
      text: "",
    });
    expect(memory.text).toContain("In #general, answers stay short.");
  });

  test("a member's team save is a card the review adds to the team context", async () => {
    f = await setup({ contextTools: true, reply: withReview({ apply: true, why: "A fact the team relies on." }) });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const out = await remember(await runOn({ userId: bia.id }, "pessoal, lembrem: a reunião é às 9"), {
      for: "team",
      kind: "fact",
      content: "The weekly meeting is at 9.",
    });
    expect(out.content).toContain("Sent for the team: a quick review adds it");
    expect(await f.db.select().from(schema.contextItems)).toEqual([]);
    const [card] = await f.db.select().from(schema.contextProposals);
    expect([card?.target, card?.requestedByUserId, card?.status]).toEqual(["org_context", bia.id, "pending"]);
    // Bia can't change the team context herself: the review weighs it for whoever may.
    expect(await queuedReviews(f)).toEqual([{ ids: [card?.id ?? ""], origin: "asked_other" }]);
    expect((await settleQueued(f)).applied).toEqual([card?.id ?? ""]);
    const [org] = await f.db.select().from(schema.organizations).where(eq(schema.organizations.id, f.org.id));
    expect(org?.context).toContain("The weekly meeting is at 9.");
  });

  test("asked by another agent, a save points to the team save instead of a copy only that DM reads", async () => {
    f = await setup({ contextTools: true });
    const other = await ops();
    const out = await remember(
      await runOn({ agentId: other.id }, "a Ana pediu: todos salvem que relatórios são em pt"),
      {
        kind: "preference",
        content: "Ana wants reports in Portuguese.",
      },
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain('for: "team"');
    expect(await f.db.select().from(schema.contextItems)).toEqual([]);
  });

  test("every save says where it holds", async () => {
    f = await setup({ contextTools: true });
    const out = await remember(await runOn({ userId: f.owner.id }, "lembra que o deploy é às sextas"), {
      kind: "fact",
      content: "Deploys happen on Fridays.",
    });
    expect(out.content).toContain("it holds in all your conversations");
  });

  test("Tornar do time: one team item, and the copies agents kept of it are archived behind it", async () => {
    f = await setup();
    const other = await ops();
    const copy = (agentId: string) =>
      insertContextItem(f.db, {
        orgId: f.org.id,
        kind: "preference",
        scopeType: "agent",
        scopeId: agentId,
        agentId,
        subject: "reports language",
        content: "Reports go out in Portuguese.",
        channelIds: [f.general.id],
        createdByKind: "agent",
        createdById: agentId,
      });
    const mine = await copy(f.agent.id);
    const theirs = await copy(other.id);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(makeTeamMemory(f.db, bia.id, f.org.id, mine.id)).rejects.toBeInstanceOf(ForbiddenError);

    const team = await makeTeamMemory(f.db, f.owner.id, f.org.id, mine.id);
    expect([team.agentId, team.createdByKind, team.channelIds]).toEqual([null, "person", []]);
    const rows = await f.db
      .select()
      .from(schema.contextItems)
      .where(and(eq(schema.contextItems.orgId, f.org.id), eq(schema.contextItems.supersededBy, team.id)));
    expect(rows.map((r) => r.id).sort()).toEqual([mine.id, theirs.id].sort());
  });
});

test("sharing a person's note preserves its words, author and sources, and concurrent retries reuse the fact", async () => {
  f = await setup();
  const author = await addMember(f.db, f.org.id, "member", "bia");
  const sourceIds = [crypto.randomUUID()];
  const note = await insertContextItem(f.db, {
    orgId: f.org.id,
    agentId: f.agent.id,
    kind: "note",
    scopeType: "channel",
    scopeId: f.general.id,
    channelIds: [f.general.id],
    title: "Release checklist",
    content: "First check the migrations.\nThen publish the release notes.",
    sourceIds,
    evidence: [{ type: "human", ref: author.id, at: new Date().toISOString() }],
    createdByKind: "person",
    createdById: author.id,
  });
  expect(teamMemoryKind(note)).toBe("fact");
  const [first, retry] = await Promise.all([
    makeTeamMemory(f.db, f.owner.id, f.org.id, note.id),
    makeTeamMemory(f.db, f.owner.id, f.org.id, note.id),
  ]);
  expect(retry.id).toBe(first.id);
  expect(first).toMatchObject({
    kind: "fact",
    title: note.title,
    content: note.content,
    sourceIds,
    evidence: expect.arrayContaining(note.evidence),
    createdByKind: "person",
    createdById: author.id,
    agentId: null,
    scopeType: "org",
  });
  const rows = await f.db.select().from(schema.contextItems);
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.id === note.id)).toMatchObject({ status: "archived", supersededBy: first.id });
});

test("private, internal and summary records cannot become team memory or be archived as matching copies", async () => {
  f = await setup();
  const base = {
    orgId: f.org.id,
    agentId: f.agent.id,
    kind: "note" as const,
    scopeType: "channel" as const,
    scopeId: f.general.id,
    channelIds: [f.general.id],
    subject: "release steps",
    content: "Check migrations before publishing.",
    createdByKind: "person" as const,
    createdById: f.owner.id,
  };
  const shareable = await insertContextItem(f.db, base);
  const excluded = await Promise.all([
    insertContextItem(f.db, { ...base, scopeType: "person", scopeId: f.owner.id }),
    insertContextItem(f.db, { ...base, scopeType: "agent", scopeId: f.agent.id, createdByKind: "agent" }),
    insertContextItem(f.db, { ...base, subject: "howto release steps" }),
    insertContextItem(f.db, { ...base, kind: "thread_summary" }),
  ]);
  for (const item of excluded) {
    expect(teamMemoryKind(item)).toBeNull();
    await expect(makeTeamMemory(f.db, f.owner.id, f.org.id, item.id)).rejects.toBeInstanceOf(ValidationError);
  }
  await makeTeamMemory(f.db, f.owner.id, f.org.id, shareable.id);
  const rows = await f.db.select().from(schema.contextItems);
  for (const item of excluded)
    expect(rows.find((r) => r.id === item.id)).toMatchObject({ status: "active", supersededBy: null });
});

test("concurrent promotions of two agents' copies produce one team record", async () => {
  f = await setup();
  const other = await ops();
  const base = {
    orgId: f.org.id,
    kind: "fact" as const,
    scopeType: "channel" as const,
    scopeId: f.general.id,
    channelIds: [f.general.id],
    content: "Deploys require a migration check.",
  };
  const first = await insertContextItem(f.db, { ...base, agentId: f.agent.id });
  const second = await insertContextItem(f.db, { ...base, agentId: other.id });
  const results = await Promise.all([first, second].map((item) => makeTeamMemory(f.db, f.owner.id, f.org.id, item.id)));
  expect(results[0]?.id).toBe(results[1]?.id);
  const rows = await f.db.select().from(schema.contextItems);
  expect(rows.filter((r) => !r.agentId)).toHaveLength(1);
});

test("sharing cannot cross organizations or reveal a memory from an unreadable channel", async () => {
  f = await setup();
  const note = await insertContextItem(f.db, {
    orgId: f.org.id,
    agentId: f.agent.id,
    kind: "note",
    scopeType: "channel",
    scopeId: crypto.randomUUID(),
    channelIds: [crypto.randomUUID()],
    content: "Private channel note.",
  });
  await expect(makeTeamMemory(f.db, f.owner.id, f.org.id, note.id)).rejects.toBeInstanceOf(NotFoundError);
  await expect(makeTeamMemory(f.db, f.owner.id, crypto.randomUUID(), note.id)).rejects.toBeInstanceOf(ForbiddenError);
  const rows = await f.db.select().from(schema.contextItems);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("active");
});
