import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  ConflictError,
  consolidateItem,
  createAgent,
  getAgent,
  listNotifications,
  listProposals,
  proposeChange,
  proposeFromItem,
  SETTLE_JOB,
  undoProposal,
} from "../src";
import { settleProposals } from "../src/context/proposal-review";
import { addMember, setup as baseSetup, type Fixture } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

interface Verdict {
  apply: boolean;
  why: string;
  rule?: string;
  replaces?: string;
}
/** What the review answers for each change of the next call (`c1`, `c2`…). */
let verdicts: Verdict[] = [];
const isReview = (system: string) => system.includes("You look after how a team of AI agents is set up.");

const setup = () =>
  baseSetup({
    reply: (req) => {
      if (!isReview(systemText(req.system))) return { chunks: ["ok"] };
      const changes = verdicts.map((v, i) => ({ id: `c${i + 1}`, rule: "", replaces: "", ...v }));
      return { chunks: [JSON.stringify({ changes })] };
    },
  });

/** A verified lesson of the fixture's agent, seen twice: strong enough to be promoted. */
const lesson = async (content: string) => {
  const input = {
    orgId: f.org.id,
    kind: "lesson" as const,
    scopeType: "agent" as const,
    agentId: f.agent.id,
    subject: content,
    content,
    trust: "high" as const,
    evidence: [{ type: "human" as const, ref: crypto.randomUUID(), at: new Date().toISOString() }],
    confidence: 0.9,
  };
  await consolidateItem(f.db, input);
  return (await consolidateItem(f.db, input)).item;
};

const LONG_LESSON =
  "When the person asked for the weekly report on Monday, the agent wrote it in English and the person answered that every report for this team must be in Portuguese, including the tables.";

const settle = (ids: string[], origin: Parameters<typeof settleProposals>[1]["origin"]) =>
  settleProposals({ context: f.context }, { orgId: f.org.id, ids, origin });

const row = async (id: string) => {
  const [p] = await f.db.select().from(schema.contextProposals).where(eq(schema.contextProposals.id, id));
  return p;
};
const instructions = async () => (await getAgent(f.db, f.org.id, f.agent.id))?.instructions ?? "";

describe("agents apply their improvements (ADR 0219)", () => {
  test("a lesson the memory keeps seeing becomes one short rule, applied by its agent, and its keeper hears it", async () => {
    f = await setup();
    const item = await lesson(LONG_LESSON);
    const p = await proposeFromItem(f.context, item);
    if (!p) throw new Error("not proposed");
    expect(p.status).toBe("pending");
    // Nobody is asked: the review is queued.
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, SETTLE_JOB));
    expect(jobs.map((j) => j.payload)).toEqual([{ ids: [p.id], origin: "memory" }]);

    verdicts = [
      { apply: true, why: "Os relatórios do time são em português.", rule: "Escreva relatórios em português." },
    ];
    expect(await settle([p.id], "memory")).toEqual({ applied: [p.id], left: [] });

    // The rule, not the lesson's whole text.
    const text = await instructions();
    expect(text).toBe("Answer briefly.\n\n- Escreva relatórios em português.");
    expect(text).not.toContain("weekly report");
    const done = await row(p.id);
    expect(done?.status).toBe("accepted");
    expect(done?.decidedByAgentId).toBe(f.agent.id);
    expect(done?.decidedByUserId).toBeNull();
    expect(done?.review).toBe("Os relatórios do time são em português.");
    // The lesson lives in the instructions now, not twice in the prompt.
    const [kept] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, item.id));
    expect(kept?.status).toBe("archived");

    const audit = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "proposal.accepted")));
    expect(audit.map((a) => [a.actorType, a.actorId, a.onBehalfOfUserId])).toEqual([["agent", f.agent.id, f.owner.id]]);

    const inbox = await listNotifications({ db: f.db }, f.owner.id, f.org.id);
    const notice = inbox.items.find((n) => n.kind === "proposal_applied");
    expect(notice?.waiting).toBe(false);
    expect(notice?.source.proposalId).toBe(p.id);

    // The history says who applied it and offers Desfazer.
    const [view] = await listProposals(f.db, f.owner.id, f.org.id, { ids: [p.id] });
    expect(view?.undoable).toBe(true);
  });

  test("a rule takes the place of the older line it names", async () => {
    f = await setup();
    await f.db
      .update(schema.agents)
      .set({ instructions: "Answer briefly.\n- Escreva relatórios em inglês." })
      .where(eq(schema.agents.id, f.agent.id));
    const p = await proposeFromItem(f.context, await lesson(LONG_LESSON));
    if (!p) throw new Error("not proposed");
    verdicts = [
      {
        apply: true,
        why: "O time trocou para português.",
        rule: "Escreva relatórios em português.",
        replaces: "Escreva relatórios em inglês.",
      },
    ];
    await settle([p.id], "memory");
    expect(await instructions()).toBe("Answer briefly.\n- Escreva relatórios em português.");
  });

  test("left out: nothing changes, the why stays on the row, and the lesson stays in memory", async () => {
    f = await setup();
    const item = await lesson(LONG_LESSON);
    const p = await proposeFromItem(f.context, item);
    if (!p) throw new Error("not proposed");
    verdicts = [{ apply: false, why: "Foi um pedido de uma vez só." }];
    expect(await settle([p.id], "memory")).toEqual({ applied: [], left: [p.id] });
    expect(await instructions()).toBe("Answer briefly.");
    const left = await row(p.id);
    expect(left?.status).toBe("rejected");
    expect(left?.review).toBe("Foi um pedido de uma vez só.");
    expect(left?.decidedByAgentId).toBe(f.agent.id);
    const [kept] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, item.id));
    expect(kept?.status).toBe("active");
    // Never proposed again.
    expect(await proposeFromItem(f.context, kept as typeof item)).toBeNull();
  });

  test("a change someone asked for but can't make is applied as someone who may", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    const ada = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Dev", instructions: "Seja breve." },
      { model: "claude-sonnet-5-5" },
    );
    const { proposals, applied } = await proposeChange(
      { db: f.db, pubsub: f.pubsub, judge: f.context.judge },
      {
        orgId: f.org.id,
        agentId: f.agent.id,
        target: "agent_instructions",
        agentIds: [ada.id],
        change: "Responda em português.",
        rationale: "",
        requesterId: member.id,
      },
    );
    expect(applied).toEqual([]);
    const [p] = proposals;
    if (!p) throw new Error("not proposed");
    expect(p.canDecide).toBe(false);
    verdicts = [{ apply: true, why: "Ajuda o time." }];
    expect(await settle([p.id], "asked_other")).toEqual({ applied: [p.id], left: [] });
    expect((await getAgent(f.db, f.org.id, ada.id))?.instructions).toBe("Seja breve.\n\n- Responda em português.");
    // The member who asked can't put it back: who may make the change can.
    expect((await listProposals(f.db, member.id, f.org.id, { ids: [p.id] }))[0]?.undoable ?? false).toBe(false);
    expect((await listProposals(f.db, f.owner.id, f.org.id, { ids: [p.id] }))[0]?.undoable).toBe(true);
  });

  test("Desfazer puts the text back, the agent keeps it as a lesson, and the rule's lesson returns to memory", async () => {
    f = await setup();
    const item = await lesson(LONG_LESSON);
    const p = await proposeFromItem(f.context, item);
    if (!p) throw new Error("not proposed");
    verdicts = [{ apply: true, why: "Ajuda.", rule: "Escreva relatórios em português." }];
    await settle([p.id], "memory");

    const undone = await undoProposal({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, p.id);
    expect(undone.status).toBe("undone");
    expect(undone.undoneByUserId).toBe(f.owner.id);
    expect(await instructions()).toBe("Answer briefly.");
    const [back] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, item.id));
    expect(back?.status).toBe("active");
    const refused = await f.db
      .select()
      .from(schema.contextItems)
      .where(and(eq(schema.contextItems.orgId, f.org.id), eq(schema.contextItems.kind, "lesson")));
    expect(refused.some((i) => i.content.includes("Escreva relatórios em português."))).toBe(true);
    await expect(undoProposal({ db: f.db }, f.owner.id, f.org.id, p.id)).rejects.toBeInstanceOf(ConflictError);
  });

  test("Desfazer refuses once the text changed since", async () => {
    f = await setup();
    const p = await proposeFromItem(f.context, await lesson(LONG_LESSON));
    if (!p) throw new Error("not proposed");
    verdicts = [{ apply: true, why: "Ajuda.", rule: "Escreva relatórios em português." }];
    await settle([p.id], "memory");
    await f.db.update(schema.agents).set({ instructions: "Outra coisa." }).where(eq(schema.agents.id, f.agent.id));
    const error = await undoProposal({ db: f.db }, f.owner.id, f.org.id, p.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("proposal.changed");
    expect(await instructions()).toBe("Outra coisa.");
  });

  test("without a review: a lesson stays in memory, the agent's own change applies as it was", async () => {
    f = await setup();
    const p = await proposeFromItem(f.context, await lesson(LONG_LESSON));
    if (!p) throw new Error("not proposed");
    const failing = {
      ...f.context,
      gateway: {
        ...f.context.gateway,
        complete: async () => {
          throw new Error("the model refused");
        },
      },
    };
    expect(await settleProposals({ context: failing }, { orgId: f.org.id, ids: [p.id], origin: "memory" })).toEqual({
      applied: [],
      left: [p.id],
    });
    expect(await instructions()).toBe("Answer briefly.");
  });
});
