import { afterEach, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { cancelRun, decideApproval, drainOutbox, postPersonMessage, type ToolSource } from "../src";
import { heldBehind } from "../src/approval-order";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHY = "A pessoa pediu para responder os e-mails de feedback.";
const FIRST = "3f2a9c1e-5b7d-4e8f-a1c2-d3e4f5a6b7c8";
const SECOND = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const THIRD = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";

const sent: string[] = [];
const mail: ToolSource = {
  name: "mail",
  tools: async () => [
    {
      name: "reply_to_received_email",
      description: "Reply to a received email",
      scope: "",
      sensitive: true,
      inputSchema: {
        type: "object",
        properties: { email_id: { type: "string" }, subject: { type: "string" }, text: { type: "string" } },
      },
      execute: async (input) => {
        sent.push((input as { text: string }).text);
        return { content: "sent" };
      },
    },
  ],
};

const reply = (emailId: string, text: string) => ({
  name: "reply_to_received_email",
  input: { email_id: emailId, subject: "Re: Feedback", text, why: WHY },
});

/** What each model call got, in order: a resumed run reads there why its action didn't run. */
const prompts: string[] = [];

/** Two runs of the agent in one conversation, each asking for one reply: both requests on the same card. */
async function twoRuns() {
  sent.length = 0;
  prompts.length = 0;
  f = await setup({
    toolSources: [mail],
    reply: (req, call) => {
      prompts.push(JSON.stringify(req));
      if (call === 1) return { chunks: ["Primeira resposta pronta."], toolUses: [reply(FIRST, "Primeira")] };
      if (call === 2) return { chunks: ["Segunda resposta pronta."], toolUses: [reply(SECOND, "Segunda")] };
      return { chunks: ["Feito."] };
    },
  });
  const post = (body: string, threadId?: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
  const ask = await post("@dev responde o primeiro feedback");
  await drainOutbox(f.db, f.handlers);
  // Sent while the first run waits on its approval: a run of its own, whose request joins the same card.
  await post("@dev e responde o segundo também", ask.id);
  await drainOutbox(f.db, f.handlers);
  const rows = await f.db.select().from(schema.approvals).orderBy(asc(schema.approvals.createdAt));
  const [first, second] = rows;
  if (!first || !second) throw new Error("two requests expected");
  expect(second.messageId).toBe(first.messageId);
  expect(second.runId).not.toBe(first.runId);
  return { first, second };
}

const decide = (id: string, decision: "approve" | "refuse") =>
  decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id, { decision });

const row = async (id: string) => (await f.db.select().from(schema.approvals)).find((r) => r.id === id) ?? null;
const runStatus = async (id: string | null) =>
  (await f.db.select().from(schema.agentRuns)).find((r) => r.id === id)?.status;

test("decided out of order, the actions still run in the order the agent asked", async () => {
  const { first, second } = await twoRuns();
  await decide(second.id, "approve");
  await drainOutbox(f.db, f.handlers);
  // Approved, but asked after a request still waiting: its run keeps waiting, nothing went out.
  expect(sent).toEqual([]);
  expect((await row(second.id))?.executedAt).toBeNull();
  expect(await runStatus(second.runId)).toBe("waiting_approval");

  await decide(first.id, "approve");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual(["Primeira", "Segunda"]);
  expect((await row(second.id))?.executedAt).not.toBeNull();
});

test("approved before the request asked ahead of it was refused: it doesn't run, and the agent reads why", async () => {
  const { first, second } = await twoRuns();
  await decide(second.id, "approve");
  await drainOutbox(f.db, f.handlers);
  await decide(first.id, "refuse");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual([]);
  const kept = await row(second.id);
  expect(kept?.status).toBe("approved");
  expect(kept?.executedAt).toBeNull();
  expect(kept?.result).toMatchObject({ isError: true, notRunAfter: first.id });
  // The earlier request named with its values: two requests of one tool tell apart.
  expect((kept?.result as { content?: string } | null)?.content).toContain("text=Primeira");
  expect(prompts.some((p) => p.includes("Not done:") && p.includes("was refused after this one was approved"))).toBe(
    true,
  );
  expect(await runStatus(second.runId)).toBe("done");
});

test("approved after the earlier one was refused: the person knew, and it runs", async () => {
  const { first, second } = await twoRuns();
  await decide(first.id, "refuse");
  await drainOutbox(f.db, f.handlers);
  await decide(second.id, "approve");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual(["Segunda"]);
});

test("decided in the order asked: each runs as soon as it is approved", async () => {
  const { first, second } = await twoRuns();
  await decide(first.id, "approve");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual(["Primeira"]);
  await decide(second.id, "approve");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual(["Primeira", "Segunda"]);
});

test("an earlier action claimed but not done yet still holds the later one", async () => {
  const { first, second } = await twoRuns();
  await decide(second.id, "approve");
  await drainOutbox(f.db, f.handlers);
  // The first run claimed its action (as `executeApproved` does before the tool returns): not done yet.
  await f.db
    .update(schema.approvals)
    .set({ status: "approved", decidedAt: new Date(), executedAt: new Date() })
    .where(eq(schema.approvals.id, first.id));
  expect((await heldBehind(f.db, second.runId ?? ""))?.id).toBe(first.id);
  // Its result in: done, and nothing holds the second any more.
  await f.db
    .update(schema.approvals)
    .set({ result: { content: "sent", isError: false } })
    .where(eq(schema.approvals.id, first.id));
  expect(await heldBehind(f.db, second.runId ?? "")).toBeNull();
});

test("a run held behind two earlier requests is woken by the second one settling too", async () => {
  sent.length = 0;
  prompts.length = 0;
  f = await setup({
    toolSources: [mail],
    reply: (req, call) => {
      prompts.push(JSON.stringify(req));
      if (call === 1)
        return { chunks: ["Duas respostas prontas."], toolUses: [reply(FIRST, "a1"), reply(SECOND, "a2")] };
      if (call === 2) return { chunks: ["Terceira pronta."], toolUses: [reply(THIRD, "b3")] };
      return { chunks: ["Feito."] };
    },
  });
  const post = (body: string, threadId?: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
  const ask = await post("@dev responde os dois primeiros feedbacks");
  await drainOutbox(f.db, f.handlers);
  await post("@dev e o terceiro também", ask.id);
  await drainOutbox(f.db, f.handlers);
  const [a1, a2, b3] = await f.db.select().from(schema.approvals).orderBy(asc(schema.approvals.createdAt));
  if (!a1 || !a2 || !b3) throw new Error("three requests expected");
  expect(new Set([a1.messageId, a2.messageId, b3.messageId]).size).toBe(1);
  // The first refused wakes the later run once; it still waits for a2.
  await decide(a1.id, "refuse");
  await drainOutbox(f.db, f.handlers);
  await decide(b3.id, "approve");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual([]);
  // a2 done by its run: that wakes the later run again, and b3 (approved after the refusal) goes out.
  await decide(a2.id, "approve");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual(["a2", "b3"]);
  expect(await runStatus(b3.runId)).toBe("done");
});

test("the run before it stopped: the later approved action goes", async () => {
  const { first, second } = await twoRuns();
  await decide(second.id, "approve");
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual([]);
  await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, first.runId ?? "");
  await drainOutbox(f.db, f.handlers);
  expect((await row(first.id))?.status).toBe("canceled");
  expect(sent).toEqual(["Segunda"]);
});
