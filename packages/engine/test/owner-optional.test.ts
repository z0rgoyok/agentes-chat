import { afterEach, describe, expect, test } from "bun:test";
import { userTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  approverIds,
  createAgent,
  decideProposal,
  getAgent,
  notifyOwnerOnBudget,
  proposeChange,
  queueBudgetEmail,
  setAgentEditors,
  updateAgent,
} from "../src";
import { addMember, type Fixture, queuedReviews, settleQueued, setup, withReview } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const unowned = async () => {
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: null });
  return (await getAgent(f.db, f.org.id, f.agent.id)) ?? f.agent;
};

describe("agents without an owner", () => {
  test("create and update accept ownerUserId: null", async () => {
    f = await setup();
    const a = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", ownerUserId: null },
      { model: "claude-haiku-5-5" },
    );
    expect(a.ownerUserId).toBeNull();
    const b = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Qa", handle: "qa" },
      { model: "claude-haiku-5-5" },
    );
    expect(b.ownerUserId).toBe(f.owner.id); // default: the creator
    expect((await unowned()).ownerUserId).toBeNull();
  });

  test("budget warnings (WebSocket and email) go to the org's admins", async () => {
    f = await setup({ budgetNanoUsd: 10e9 });
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    const member = await addMember(f.db, f.org.id, "member", "caio");
    const got: string[] = [];
    for (const u of [f.owner, admin, member])
      f.pubsub.subscribe(userTopic(f.org.id, u.id), (e) => got.push(`${u.id}:${e.type}`));
    const agent = await unowned();
    await notifyOwnerOnBudget(f.pubsub, f.db)({ agent, level: "warning", spentNanoUsd: 8e9, budgetNanoUsd: 10e9 });
    await Bun.sleep(5);
    expect(got.sort()).toEqual([`${admin.id}:budget.warning`, `${f.owner.id}:budget.warning`].sort());

    await queueBudgetEmail(f.db, "https://x", { agent, level: "warning", spentNanoUsd: 8e9, budgetNanoUsd: 10e9 });
    const [job] = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send");
    const to = (job?.payload as { to: string[] } | undefined)?.to ?? [];
    expect(to).toHaveLength(2);
    const [memberRow] = await f.db.select().from(schema.users).where(eq(schema.users.id, member.id));
    expect(to).not.toContain(memberRow?.email);
  });

  test("with an owner, budget warnings go only to the owner", async () => {
    f = await setup({ budgetNanoUsd: 10e9 });
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    const got: string[] = [];
    for (const u of [f.owner, admin]) f.pubsub.subscribe(userTopic(f.org.id, u.id), () => got.push(u.id));
    await notifyOwnerOnBudget(
      f.pubsub,
      f.db,
    )({ agent: f.agent, level: "exhausted", spentNanoUsd: 1, budgetNanoUsd: 1 });
    await Bun.sleep(5);
    expect(got).toEqual([f.owner.id]);
  });

  test("approvals go to the org's admins", async () => {
    f = await setup();
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    await addMember(f.db, f.org.id, "member", "caio");
    const ids = await approverIds(f.db, { orgId: f.org.id, ownerUserId: null });
    expect(ids.sort()).toEqual([f.owner.id, admin.id].sort());
  });

  test("admins decide its proposals; a refusal is remembered as a lesson", async () => {
    f = await setup();
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    const member = await addMember(f.db, f.org.id, "member", "caio");
    await unowned();
    const {
      proposals: [proposal],
    } = await proposeChange(
      { db: f.db },
      {
        orgId: f.org.id,
        agentId: f.agent.id,
        target: "agent_instructions",
        change: "Always answer in English.",
        rationale: "asked in chat",
        requesterId: member.id,
      },
    );
    expect(proposal?.canDecide).toBe(false);
    await expect(decideProposal(f.db, member.id, f.org.id, proposal?.id ?? "", "reject")).rejects.toThrow();
    const decided = await decideProposal(f.db, admin.id, f.org.id, proposal?.id ?? "", "reject");
    expect(decided.status).toBe("rejected");
    const lessons = await f.db
      .select()
      .from(schema.contextItems)
      .where(and(eq(schema.contextItems.orgId, f.org.id), eq(schema.contextItems.kind, "lesson")));
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ agentId: f.agent.id, scopeType: "agent" });
    expect(lessons[0]?.content).toContain("Always answer in English.");
  });
});

describe("an agent's instructions wait on who looks after it (ADR 0085, addendum of 2026-11-24)", () => {
  const propose = (requesterId: string) =>
    proposeChange(
      { db: f.db },
      {
        orgId: f.org.id,
        agentId: f.agent.id,
        target: "agent_instructions",
        change: "Always answer in English.",
        rationale: "asked in chat",
        requesterId,
      },
    );

  test("with an owner, an admin who isn't one neither decides nor hears it; the review applies it as the owner", async () => {
    f = await setup({ reply: withReview({ apply: true, why: "A lasting preference." }) });
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    const member = await addMember(f.db, f.org.id, "member", "caio");
    const {
      proposals: [proposal],
    } = await propose(member.id);
    const id = proposal?.id ?? "";
    await expect(decideProposal(f.db, admin.id, f.org.id, id, "reject")).rejects.toThrow();
    const kinds = async (kind: string) =>
      (
        await f.db
          .select({ userId: schema.notifications.userId })
          .from(schema.notifications)
          .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, kind)))
      ).map((n) => n.userId);
    // Nobody is asked: the review weighs it, and applies it as who looks after the agent.
    expect(await kinds("proposal_waiting")).toEqual([]);
    expect(await queuedReviews(f)).toEqual([{ ids: [id], origin: "asked_other" }]);
    expect((await settleQueued(f)).applied).toEqual([id]);
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.instructions).toContain("- Always answer in English.");
    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "proposal.accepted")));
    expect(audit?.onBehalfOfUserId).toBe(f.owner.id);
    // The owner hears it was applied; the admin, who doesn't look after it, doesn't.
    expect(await kinds("proposal_applied")).toEqual([f.owner.id]);
  });

  test("someone its editors name decides too, and an admin who asked for the change decides their own", async () => {
    f = await setup();
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    const editor = await addMember(f.db, f.org.id, "member", "caio");
    await setAgentEditors(f.db, f.owner.id, f.org.id, f.agent.id, { userIds: [editor.id], roleIds: [] });
    const {
      proposals: [theirs],
    } = await propose(f.owner.id);
    expect((await decideProposal(f.db, editor.id, f.org.id, theirs?.id ?? "", "reject")).status).toBe("rejected");
    const asked = await propose(admin.id);
    expect(asked.proposals[0]?.canDecide).toBe(true);
  });
});
