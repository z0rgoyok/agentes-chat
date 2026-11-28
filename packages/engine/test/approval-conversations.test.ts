import { afterEach, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import {
  decideApproval,
  drainOutbox,
  postPersonMessage,
  releaseUnasked,
  runApprovalNow,
  setWorkspaceApprovalsLevel,
  type ToolSource,
  updateAgent,
} from "../src";
import { STALE_HOLD_MS } from "../src/approval-order";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHY = "A cliente pediu o orçamento por mensagem e confirmou os itens e o prazo.";
const CONNECTION = "5b0c7a2e-1d3f-4e6a-9b8c-7d6e5f4a3b2c";

const sent: string[] = [];
const crm: ToolSource = {
  name: "crm",
  tools: async () => [
    {
      name: "crm_send_quote",
      description: "Send a quote to a customer",
      scope: "",
      sensitive: true,
      inputSchema: { type: "object", properties: { customer: { type: "string" } } },
      describe: (input) => ({ title: `Orçamento para ${(input as { customer: string }).customer}` }),
      execute: async (input) => {
        sent.push((input as { customer: string }).customer);
        return { content: "sent" };
      },
    },
  ],
};

const quote = (customer: string) => ({ name: "crm_send_quote", input: { customer, why: WHY } });

/**
 * Two messages to the agent in the main timeline, the second sent while the first one's run waits: two
 * conversations, so two cards. `redo`: what the agent does once a request no longer needs approval.
 */
async function twoTopLevel(options: { redo?: boolean } = {}) {
  sent.length = 0;
  f = await setup({
    toolSources: [crm],
    reply: (req, call) => {
      if (call === 1) return { chunks: ["Primeiro orçamento pronto."], toolUses: [quote("Ana Lima")] };
      if (call === 2) return { chunks: ["Segundo orçamento pronto."], toolUses: [quote("Bia Souza")] };
      if (options.redo && JSON.stringify(req).includes("nobody needs to approve it any more"))
        return { chunks: ["De novo."], toolUses: [quote("Ana Lima")] };
      return { chunks: ["Feito."] };
    },
  });
  const post = (body: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
  await post("@dev manda o orçamento da Ana");
  await drainOutbox(f.db, f.handlers);
  await post("@dev manda o orçamento da Bia");
  await drainOutbox(f.db, f.handlers);
  const [first, second] = await f.db.select().from(schema.approvals).orderBy(asc(schema.approvals.createdAt));
  if (!first || !second) throw new Error("two requests expected");
  return { first, second };
}

const decide = (id: string, decision: "approve" | "refuse") =>
  decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id, { decision });
const row = async (id: string) => (await f.db.select().from(schema.approvals)).find((r) => r.id === id) ?? null;

test("two messages in one channel's main timeline are two conversations: two cards", async () => {
  const { first, second } = await twoTopLevel();
  expect(second.runId).not.toBe(first.runId);
  expect(second.messageId).not.toBe(first.messageId);
  // The second run was told the first one waits here: it runs after it, as asked.
  expect(second.afterIds).toEqual([first.id]);
  expect(first.afterIds).toEqual([]);
});

test("a follow-up's approved action waits for what its run was told already waited, then runs", async () => {
  const { first, second } = await twoTopLevel();
  await decide(second.id, "approve");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual([]);
  await decide(first.id, "approve");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual(["Ana Lima", "Bia Souza"]);
});

test("a request waiting longer than the hold limit holds no other run's approved action", async () => {
  const { first, second } = await twoTopLevel();
  await f.db
    .update(schema.approvals)
    .set({ createdAt: new Date(Date.now() - STALE_HOLD_MS - 60_000) })
    .where(eq(schema.approvals.id, first.id));
  await decide(second.id, "approve");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual(["Bia Souza"]);
  expect((await row(first.id))?.status).toBe("pending");
});

test("'Rodar este agora' runs an approved action held behind another run's request, and is audited", async () => {
  const { first, second } = await twoTopLevel();
  await decide(second.id, "approve");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual([]);
  const view = await runApprovalNow({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, second.id);
  expect(view.afterIds).toEqual([]);
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual(["Bia Souza"]);
  expect((await row(first.id))?.status).toBe("pending");
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "approval.run_now"));
  expect(audit).toHaveLength(1);
  expect(audit[0]?.details).toMatchObject({ after: [first.id] });
  // Nothing left to free: a second press says so.
  await expect(runApprovalNow({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, second.id)).rejects.toThrow(
    "isn't waiting",
  );
});

test("'Rodar este agora' is for who may decide it", async () => {
  const { second } = await twoTopLevel();
  await decide(second.id, "approve");
  await drainOutbox(f.db, f.handlers);
  const stranger = await addMember(f.db, f.org.id, "member", "Caio");
  await expect(runApprovalNow({ db: f.db, pubsub: f.pubsub }, stranger.id, f.org.id, second.id)).rejects.toThrow(
    "Only the agent's owner or an admin",
  );
});

test("set to never ask: its waiting requests are canceled and its runs call them again, without a card", async () => {
  const { first, second } = await twoTopLevel({ redo: true });
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { approvalsLevel: "never" }, { pubsub: f.pubsub });
  expect((await row(first.id))?.status).toBe("canceled");
  expect((await row(second.id))?.status).toBe("canceled");
  await drainOutbox(f.db, f.handlers);
  // Each run read why and asked again; at "never" the call ran with no new card.
  expect(sent).toContain("Ana Lima");
  const pending = (await f.db.select().from(schema.approvals)).filter((a) => a.status === "pending");
  expect(pending).toEqual([]);
});

test("the workspace set to never ask: the agents that follow it let their waiting requests go", async () => {
  const { first } = await twoTopLevel();
  await setWorkspaceApprovalsLevel(f.db, f.owner.id, f.org.id, "never", { pubsub: f.pubsub });
  expect((await row(first.id))?.status).toBe("canceled");
});

test("a tool moved off 'Pede sua aprovação' frees a person's run's request of it", async () => {
  const { first } = await twoTopLevel();
  // As a connected app's tool asks: the connection is on the request.
  await f.db.update(schema.approvals).set({ connectionId: CONNECTION }).where(eq(schema.approvals.id, first.id));
  const freed = await releaseUnasked({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    connectionId: CONNECTION,
    prefix: "crm",
    tools: ["send_quote"],
  });
  expect(freed.map((a) => a.id)).toContain(first.id);
  expect((await row(first.id))?.status).toBe("canceled");
  // Another connection's tool of the same name stays waiting.
  const none = await releaseUnasked({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    connectionId: "0f1e2d3c-4b5a-4968-8776-655443322110",
    prefix: "crm",
    tools: ["send_quote"],
  });
  expect(none).toEqual([]);
});
