import { afterEach, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import {
  CONFIDENTIAL_KEEP_DAYS,
  CONFIDENTIAL_REMOVED_CODE,
  CONFIDENTIAL_REMOVED_TEXT,
  CONFIDENTIAL_STUB,
  continueRun,
  decideApproval,
  ensureThreadSummary,
  messageView,
  pruneConfidential,
  stopError,
} from "../src";
import { closeWorlds } from "./autonomy/harness";
import { CANARY, type VaultWorld, vaultWorld } from "./confidential-fixtures";

// ADR 0190: what the product kept of a confidential thread goes after `CONFIDENTIAL_KEEP_DAYS`: every message of the
// thread, and what its ended runs kept. The rows stay, and nothing outside such a thread is touched.

afterEach(closeWorlds);

const DAY_MS = 86_400_000;
/** What a person pasted in the thread's root, and wrote under it. */
const ROOT = "quokkaplan";
const REPLY = "ibexnote";

const READ = { name: "vault_read_record", input: { id: "r1" } };
const typed = (what: string) => `${what} ${CANARY}`;

/**
 * A thread whose run read the record, showed a block and a poll, asked for an approval that was given, asked a
 * question, and was stopped; a person's reply under it; and beside it a thread with no confidential result. Then a
 * later run of the thread that a person stopped (`stopped`), and one stopped the same way in the plain thread
 * (`twin`): "Continuar" takes either.
 */
async function scenario() {
  const w: VaultWorld = await vaultWorld({
    agents: ["kai", "mira"],
    changeAsks: true,
    setup: { blockTools: true },
    script: {
      mira: [{ text: "The plain thread says plainwords." }],
      kai: ({ n }) => {
        if (n === 1) return { calls: [READ] };
        if (n === 2)
          return {
            text: typed("I read it:"),
            calls: [
              {
                name: "show_block",
                input: {
                  title: typed("block"),
                  spec: { parts: [{ type: "stat", label: typed("label"), value: "1" }] },
                },
              },
              { name: "start_poll", input: { question: typed("poll"), options: [typed("yes"), typed("no")] } },
              {
                name: "vault_change_record",
                input: {
                  id: "r1",
                  note: typed("note"),
                  why: typed("the customer asked for this change in their own words, which were"),
                },
              },
            ],
          };
        if (n === 3)
          return {
            calls: [
              {
                name: "ask_user",
                input: {
                  question: typed("is that right?"),
                  why: typed("I need the person to confirm what the record says before going on, it said"),
                },
              },
            ],
          };
        return { text: typed("It said") };
      },
    },
  });
  const plain = await w.say("@mira say something plain");
  await w.settle();
  const asked = await w.say(`@kai a customer pasted this: ${ROOT}. Read record r1.`);
  await w.settle();
  const [approval] = await w.db.select().from(schema.approvals);
  await decideApproval({ db: w.db, pubsub: w.f.pubsub }, w.owner.id, w.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await w.settle();
  const [question] = await w.db.select().from(schema.agentQuestions);
  await w.say(`yes, and it also said ${REPLY}`, { threadId: asked.id });
  await w.settle();
  // However the reply landed, the run is over, with an error whose words another program wrote.
  await w.db
    .update(schema.agentRuns)
    .set({ status: "failed", error: `cli_failed: the program said ${CANARY}` })
    .where(eq(schema.agentRuns.threadRootId, asked.id));
  const [run] = (await w.runs("kai")).filter((r) => r.threadRootId === asked.id);
  await w.say("@kai and then?", { threadId: asked.id });
  await w.settle();
  const stopped = (await w.runs("kai")).filter((r) => r.threadRootId === asked.id).at(-1);
  const [twin] = await w.runs("mira");
  if (!run || !question || !stopped || stopped.id === run.id || !twin) throw new Error("the scenario did not run");
  for (const r of [stopped, twin]) await stopByHand(w, r);
  return { w, asked, plain, run, stopped, twin };
}

/** A run as a person's stop leaves it: canceled by them, its reply marked as the one they stopped. */
async function stopByHand(w: VaultWorld, run: { id: string; replyMessageId: string | null }) {
  if (!run.replyMessageId) throw new Error("the run posted no reply");
  await w.db
    .update(schema.agentRuns)
    .set({ status: "canceled", error: stopError({ type: "person", id: w.owner.id }) })
    .where(eq(schema.agentRuns.id, run.id));
  const canceled = JSON.stringify({ canceled: { byUserId: w.owner.id, text: "" } });
  await w.db
    .update(schema.messages)
    .set({ meta: sql`${schema.messages.meta} || ${canceled}::jsonb` })
    .where(eq(schema.messages.id, run.replyMessageId));
}

/** Moves a thread's mark, and its runs, `days` into the past. */
async function age(w: VaultWorld, days: number) {
  const then = new Date(Date.now() - days * DAY_MS);
  await w.db.update(schema.confidentialThreads).set({ markedAt: then });
  await w.db.update(schema.agentRuns).set({ createdAt: then });
}

test(`after ${CONFIDENTIAL_KEEP_DAYS} days the thread's messages, its run's steps, transcript, error, question, approval, block and poll lose their words; the rows stay and each message goes to the apps again`, async () => {
  const { w, asked, plain, run, stopped, twin } = await scenario();
  const words = [CANARY, ROOT, REPLY];
  const count = async () => ({
    messages: (await w.stored()).length,
    steps: (await w.steps([run.id])).length,
    questions: (await w.db.select().from(schema.agentQuestions)).length,
    approvals: (await w.db.select().from(schema.approvals)).length,
    artifacts: (await w.db.select().from(schema.artifacts)).length,
  });
  const before = await count();
  expect(before.steps).toBeGreaterThan(4);
  expect([before.questions, before.approvals]).toEqual([1, 1]);
  expect(before.artifacts).toBeGreaterThanOrEqual(2);
  for (const word of words) expect((await w.tablesHolding(word)).length).toBeGreaterThan(0);

  // A day short of it: everything is there.
  await age(w, CONFIDENTIAL_KEEP_DAYS - 1);
  expect(await pruneConfidential({ db: w.db, pubsub: w.f.pubsub })).toEqual({ sealed: 0, messages: 0, runs: 0 });
  expect(await w.tablesHolding(CANARY)).toEqual(expect.arrayContaining(["agent_run_steps", "agent_runs", "approvals"]));

  // A day past it.
  await age(w, CONFIDENTIAL_KEEP_DAYS + 1);
  const sent: { id: string; body: string }[] = [];
  const unsubscribe = w.f.pubsub.subscribe(channelTopic(w.channelId), (event) => {
    const e = event as { type?: string; message?: { id: string; body: string } };
    if (e.type === "message.created" && e.message) sent.push({ id: e.message.id, body: e.message.body });
  });
  const pruned = await pruneConfidential({ db: w.db, pubsub: w.f.pubsub });
  unsubscribe();
  const inThread = (await w.stored()).filter((m) => m.id === asked.id || m.threadId === asked.id);
  const ofThread = (await w.runs()).filter((r) => r.threadRootId === asked.id);
  expect(pruned).toEqual({ sealed: 0, messages: inThread.length, runs: ofThread.length });
  expect(inThread.length).toBeGreaterThanOrEqual(4);

  // No table holds a word of it any more: the root's and a person's reply's included.
  for (const word of words) expect(await w.tablesHolding(word)).toEqual([]);
  // The rows remain.
  expect(await count()).toEqual(before);
  // Every message of the thread reads as removed, to people and to whatever reads its body.
  for (const m of inThread) {
    expect(m.body).toBe(CONFIDENTIAL_STUB);
    // What the apps get: the removed line, worded by its code in the reader's language, and nothing it carried.
    expect(messageView(m)).toMatchObject({
      body: CONFIDENTIAL_REMOVED_TEXT,
      meta: {
        confidential: true,
        pruned: true,
        bodyCode: CONFIDENTIAL_REMOVED_CODE,
        bodyParams: { days: CONFIDENTIAL_KEEP_DAYS },
      },
    });
  }
  // Each was sent to the apps as a message written again in place.
  expect(sent.map((m) => m.id).sort()).toEqual(inThread.map((m) => m.id).sort());
  expect(new Set(sent.map((m) => m.body))).toEqual(new Set([CONFIDENTIAL_REMOVED_TEXT]));

  // The run: what its steps were stays, what they held goes.
  const steps = await w.steps([run.id]);
  expect(steps.every((s) => s.data.pruned === true)).toBe(true);
  expect(steps.filter((s) => s.kind === "tool_result").map((s) => s.data.name)).toEqual(
    expect.arrayContaining(["vault_read_record", "show_block", "ask_user"]),
  );
  const [after] = (await w.runs("kai")).filter((r) => r.id === run.id);
  // Its error keeps the server's own code and loses the words after it.
  expect([after?.transcript, after?.status, after?.error]).toEqual([null, "failed", "cli_failed"]);
  const [question] = await w.db.select().from(schema.agentQuestions);
  expect([question?.text, question?.choices, question?.answer]).toEqual(["", null, null]);
  const [approval] = await w.db.select().from(schema.approvals);
  expect([approval?.title, approval?.why, approval?.detail, approval?.params, approval?.result]).toEqual([
    "",
    "",
    "",
    {},
    null,
  ]);
  for (const a of await w.db.select().from(schema.artifacts)) {
    expect([a.title, a.excerpt, a.deletedAt !== null]).toEqual(["", "", true]);
  }

  // "Continuar" on the run a person stopped: nothing to go on from once it was emptied. Its twin, as old and stopped
  // the same way in a thread with no confidential result, goes on.
  const deps = { db: w.db, pubsub: w.f.pubsub };
  await expect(continueRun(deps, w.owner.id, w.org.id, stopped.id)).rejects.toMatchObject({
    code: "run.not_continuable",
  });
  expect((await continueRun(deps, w.owner.id, w.org.id, twin.id)).runId).toBeString();

  // The thread and the run that hold no confidential result are as they were.
  const untouched = (await w.stored()).filter(
    (m) => m.id === plain.id || m.threadId === plain.id || m.body.includes("plainwords"),
  );
  expect(untouched.map((m) => [m.body, m.meta.pruned])).toEqual([
    ["@mira say something plain", undefined],
    ["The plain thread says plainwords.", undefined],
  ]);
  const [other] = await w.runs("mira");
  expect(other?.transcript).not.toBeNull();
  expect((await w.steps([other?.id ?? ""])).some((s) => s.data.pruned)).toBe(false);

  // A second pass finds nothing left; a message written in the thread afterwards goes at the next.
  expect(await pruneConfidential({ db: w.db })).toEqual({ sealed: 0, messages: 0, runs: 0 });
  await w.say(`one more thing: ${REPLY}`, { threadId: asked.id });
  expect((await pruneConfidential({ db: w.db })).messages).toBe(1);
  expect(await w.tablesHolding(REPLY)).toEqual([]);
});

test("a run still at work is left alone until it ends", async () => {
  const w = await vaultWorld({
    agents: ["kai"],
    script: {
      kai: [
        { calls: [READ] },
        {
          calls: [
            {
              name: "ask_user",
              input: { question: typed("go on?"), why: "Only the person can say whether to go on." },
            },
          ],
        },
      ],
    },
  });
  await w.say("@kai read record r1 and ask me");
  await w.settle();
  await age(w, CONFIDENTIAL_KEEP_DAYS + 1);
  expect((await pruneConfidential({ db: w.db })).runs).toBe(0);
  const [run] = await w.runs("kai");
  expect([run?.status, run?.transcript === null]).toEqual(["waiting_input", false]);
  await w.db.update(schema.agentRuns).set({ status: "canceled" });
  expect((await pruneConfidential({ db: w.db })).runs).toBe(1);
  expect(await w.tablesHolding(CANARY)).toEqual([]);
});

test("the summaries made of the thread before its mark go with it, every version; another thread's stays", async () => {
  const w = await vaultWorld({
    agents: ["kai", "mira"],
    script: {
      mira: [{ text: "The plain thread says plainwords." }],
      kai: ({ n }) => (n < 3 ? { text: "Noted." } : n === 3 ? { calls: [READ] } : { text: typed("It says") }),
    },
  });
  const plain = await w.say("@mira say something plain");
  await w.settle();
  const asked = await w.say(`@kai a customer pasted this: ${ROOT}`);
  await w.settle();
  const summarize = (rootId: string, text: string) => ensureThreadSummary(w.f.context, w.org.id, rootId, { text });
  await summarize(plain.id, "Mira said plainwords.");
  await summarize(asked.id, `A customer pasted ${ROOT}.`);
  await w.say("@kai keep that in mind", { threadId: asked.id });
  await w.settle();
  await summarize(asked.id, `A customer pasted ${ROOT}, and asked to keep it in mind.`);
  await w.say("@kai now read record r1", { threadId: asked.id });
  await w.settle();
  const summaries = async () =>
    (await w.db.select().from(schema.contextItems)).map((i) => `${i.scopeId} ${i.status}`).sort();
  // The mark archived the current one; the version before it was archived when it was replaced.
  expect(await summaries()).toEqual([`${asked.id} archived`, `${asked.id} archived`, `${plain.id} active`].sort());
  expect(await w.tablesHolding(ROOT)).toContain("context_items");
  await age(w, CONFIDENTIAL_KEEP_DAYS + 1);
  await pruneConfidential({ db: w.db });
  expect(await summaries()).toEqual([`${plain.id} active`]);
  expect(await w.tablesHolding(ROOT)).toEqual([]);
});

test("what a run of the thread reported outside it goes with the thread: its long work's report, wherever that was posted", async () => {
  const w = await vaultWorld({
    agents: ["kai"],
    setup: { workTools: true },
    script: {
      kai: ({ n }) =>
        n === 1
          ? { calls: [{ name: "work_in_background", input: { title: "Records", say: "On it." } }] }
          : n === 2
            ? { calls: [READ] }
            : { text: typed("The report:") },
    },
  });
  await w.say("@kai go through the records");
  await w.settle();
  const [work] = await w.db.select().from(schema.agentWorks);
  const reportOf = async () =>
    (await w.stored()).find((m) => m.id === work?.resultMessageId) ?? { threadId: null, meta: {} };
  // The work was going when it read the record, so its own thread is the confidential one, and its report is sealed.
  expect((await w.db.select().from(schema.confidentialThreads)).map((t) => t.rootMessageId)).toEqual([
    work?.anchorMessageId ?? "",
  ]);
  expect((await reportOf()).meta).toMatchObject({ confidential: true, sealedBody: typed("The report:") });
  // The statement that wrote it put it under the work's thread. A report that is outside it, as one posted where
  // the work was asked is, is found by the work's own pointer.
  expect((await reportOf()).threadId).toBe(work?.anchorMessageId ?? "");
  await w.db
    .update(schema.messages)
    .set({ threadId: null })
    .where(eq(schema.messages.id, work?.resultMessageId ?? ""));
  await age(w, CONFIDENTIAL_KEEP_DAYS + 1);
  await pruneConfidential({ db: w.db });
  expect((await reportOf()).meta).toMatchObject({ pruned: true, bodyCode: CONFIDENTIAL_REMOVED_CODE });
  expect(await w.tablesHolding(CANARY)).toEqual([]);
});

test("work another agent handed over: the copy of its report where the person asked holds none of the words, and goes with the thread too", async () => {
  const w = await vaultWorld({
    agents: ["mira", "kai"],
    script: {
      mira: ({ n }) =>
        n === 1
          ? { calls: [{ name: "tell_agent", input: { agent: "@kai", message: "Read record r1 and report it." } }] }
          : { text: "Kai has it." },
      kai: ({ n }) => (n === 1 ? { calls: [READ] } : { text: typed("The record says") }),
    },
  });
  await w.say("@mira have kai read record r1");
  await w.settle();
  await w.advance(10);
  const [work] = await w.db.select().from(schema.agentWorks);
  expect([work?.how, work?.status, work?.channelId]).toEqual(["handed", "done", w.channelId]);
  // The run read the record where it was handed the work, and that thread is the confidential one.
  expect(w.turnsOf("kai").join("\n")).toContain(CANARY);
  const [thread] = await w.db.select().from(schema.confidentialThreads);
  expect(thread?.channelId).not.toBe(w.channelId);
  // Where the person asked, the copy is there and says nothing: no message of that conversation holds the words.
  const copyOf = async () => (await w.stored()).find((m) => m.id === work?.resultMessageId);
  expect((await copyOf())?.meta).toMatchObject({ confidential: true, sealedBody: CONFIDENTIAL_STUB });
  expect(JSON.stringify(await w.stored())).not.toContain(CANARY);
  await age(w, CONFIDENTIAL_KEEP_DAYS + 1);
  await pruneConfidential({ db: w.db });
  expect((await copyOf())?.meta).toMatchObject({ pruned: true, bodyCode: CONFIDENTIAL_REMOVED_CODE });
  expect(await w.tablesHolding(CANARY)).toEqual([]);
});
