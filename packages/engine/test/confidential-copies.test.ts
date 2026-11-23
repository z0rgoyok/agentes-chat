import { afterEach, expect, spyOn, test } from "bun:test";
import type { ErrorReporter } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  afterTurnDone,
  CONFIDENTIAL_AI_CHANGED,
  CONFIDENTIAL_NOT_SHOWN,
  CONFIDENTIAL_STUB,
  createCredential,
  createRoutine,
  createTalker,
  decideApproval,
  learnFromRefusal,
  learnRun,
  loadThread,
  notifyQuestion,
  operatorReview,
  operatorRuns,
  queueApprovalDigests,
  runRoutineNow,
} from "../src";
import { renderPush } from "../src/push-messages";
import { closeWorlds } from "./autonomy/harness";
import { CANARY, type VaultWorld, vaultWorld } from "./confidential-fixtures";

// ADR 0190: what a run read as confidential, and what its thread says, reach its own model and the people who read
// the thread, and nothing else. Each test plants words no other text holds and then looks for them everywhere.

afterEach(closeWorlds);

/** What a person pasted in the thread's root, before any mark. */
const ROOT = "quokkaplan";
/** What a person wrote under it afterwards. */
const REPLY = "ibexnote";

const READ = { name: "vault_read_record", input: { id: "r1" } };

/** The tables that may hold a confidential thread's words: its own messages, its runs, and what its runs showed. */
const OWN = ["agent_run_steps", "agent_runs", "messages"];

const within = (found: string[], allowed: string[]) => found.filter((t) => !allowed.some((a) => t.startsWith(a)));

/** What an install's own logs and error reports would hold: every console line and every reported error, as text. */
function captureLogs() {
  const lines: string[] = [];
  const keep = (...args: unknown[]) =>
    void lines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" "));
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    spyOn(console, level).mockImplementation(keep),
  );
  const errors: ErrorReporter = {
    capture: (error, tags) => {
      keep(error, JSON.stringify(tags ?? {}), JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})));
      return undefined;
    },
    flush: async () => true,
  };
  return { lines, errors, restore: () => spies.forEach((s) => void s.mockRestore()) };
}

test("every copy: after the mark neither the result's words nor the thread's reach a judge, another model, the search index, a notification, memory, a log line or an error report", async () => {
  let marked: { judgments: number; models: number; embeddings: number } | null = null;
  const logs = captureLogs();
  const w: VaultWorld = await vaultWorld({
    agents: ["kai", "mira"],
    setup: { contextTools: true, mediaTools: true, embeddings: true, toolsOnDemand: true, errors: logs.errors },
    judge: { followThrough: () => "done" },
    script: {
      kai: ({ n }) => {
        if (n === 1) return { calls: [READ] };
        // The result is in: from here on the thread is confidential.
        marked ??= {
          judgments: w.judgments.length,
          models: w.f.provider.calls.length,
          embeddings: w.f.embeddings.calls.length,
        };
        return n === 2 ? { text: `The record says ${CANARY}, as the paste did.` } : { text: `Yes: ${CANARY}.` };
      },
    },
  });
  const asked = await w.say(`@kai a customer pasted this: ${ROOT}. Read record r1.`);
  await w.settle();
  // A person's reply under it, with no mention: the router's to place.
  await w.say(`it also said ${REPLY}, right?`, { threadId: asked.id });
  await w.settle();
  await w.say(`@kai and ${REPLY}?`, { threadId: asked.id });
  await w.settle();
  // Two agents named at once: who is asked is a judge's question everywhere else.
  const addressed = w.judgments.length;
  await w.say(`@kai @mira and for both of you, ${REPLY}?`, { threadId: asked.id });
  await w.settle();
  expect(w.judgments.slice(addressed).map((j) => j.kind)).not.toContain("mention_addressees");
  // Later jobs: the thread's assessment, summaries, learning.
  await w.advance(24 * 60);
  logs.restore();
  if (!marked) throw new Error("the run never read the record");
  const at: { judgments: number; models: number; embeddings: number } = marked;

  // The words are where they belong, so the checks below look for something real.
  expect(await w.tablesHolding(CANARY)).toEqual(expect.arrayContaining(["agent_run_steps", "agent_runs"]));
  expect(w.judgments.slice(0, at.judgments).map((j) => j.kind)).toEqual(expect.arrayContaining(["tool_groups"]));
  expect((await w.runs("kai")).length).toBeGreaterThanOrEqual(2);
  expect(w.turnsOf("kai").join("\n")).toContain(CANARY);
  expect(w.turnsOf("kai").join("\n")).toContain(REPLY);

  // No judge was asked with them: the status line, the reaction, stuck, the context budget, the tool loader, the
  // turn's end, a mention.
  const judged = JSON.stringify(w.judgments.slice(at.judgments));
  for (const word of [CANARY, ROOT, REPLY]) expect(judged).not.toContain(word);
  // No model but the own one of a run of the thread was handed them: the routing model, a summary, the thread's
  // name, learning.
  const others = [...w.f.provider.calls.slice(at.models), ...w.f.openaiProvider.calls]
    .map((c) => JSON.stringify([c.request.system, c.request.messages]))
    .filter((text) => !/You are (Kai|Mira) \(@(kai|mira)\)/.test(text));
  for (const word of [CANARY, ROOT, REPLY]) expect(others.join("\n")).not.toContain(word);
  // The router read the unmentioned reply as the stub.
  expect(w.unrouted).toContain(CONFIDENTIAL_STUB);
  // Nothing went to the embeddings provider.
  const embedded = JSON.stringify(w.f.embeddings.calls.slice(at.embeddings));
  for (const word of [CANARY, ROOT, REPLY]) expect(embedded).not.toContain(word);

  // Every table: the search index (the root's document included), notifications, memory and summaries, jobs' payloads
  // (a mail that quotes, a push), the audit log, a thread's title.
  for (const word of [CANARY, ROOT, REPLY]) expect(within(await w.tablesHolding(word), OWN)).toEqual([]);
  // And in `messages` only the thread's own, sealed.
  for (const m of await w.stored()) {
    const text = JSON.stringify(m);
    if (![CANARY, ROOT, REPLY].some((word) => text.includes(word))) continue;
    expect([m.id === asked.id || m.threadId === asked.id, m.meta.confidential, m.body]).toEqual([
      true,
      true,
      CONFIDENTIAL_STUB,
    ]);
  }
  expect(await w.db.select().from(schema.contextItems)).toEqual([]);
  expect(await w.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "context.learn"))).toEqual([]);
  // Nor did a log line or an error report carry them.
  for (const word of [CANARY, ROOT, REPLY]) expect(logs.lines.join("\n")).not.toContain(word);
});

test("nobody answers for a working run of a confidential thread: the conversation layer's model is not asked", async () => {
  const w = await vaultWorld({
    agents: ["kai"],
    script: {
      kai: [
        { calls: [READ] },
        {
          text: `It holds ${CANARY}.`,
          calls: [
            {
              name: "ask_user",
              input: { question: `Is ${CANARY} right?`, why: "Only the person knows what the customer meant by it." },
            },
          ],
        },
      ],
    },
  });
  const asked = await w.say("@kai read record r1 and check it with me");
  await w.settle();
  const [run] = await w.runs("kai");
  expect(run?.status).toBe("waiting_input");
  const decisions: string[] = [];
  const talker = createTalker({
    db: w.db,
    pubsub: w.f.pubsub,
    gateway: w.f.gateway,
    resolveModel: async () => "claude-haiku-5-5",
    onDecision: (d) => decisions.push(d.outcome),
  });
  const message = await w.say("what are you doing?", { threadId: asked.id });
  const [stored] = await w.db.select().from(schema.messages).where(eq(schema.messages.id, message.id));
  if (!run || !stored) throw new Error("no run");
  const before = w.f.provider.calls.length;
  await talker.consider({ run, message: stored, live: false, waited: null });
  expect(decisions).toEqual(["confidential"]);
  expect(
    w.f.provider.calls.slice(before).filter((c) => systemText(c.request.system).includes("conversation layer")),
  ).toEqual([]);
});

test("the same conversation with a server the operator did not list: the words go where they always went, which is what the test above looks for", async () => {
  const w = await vaultWorld({
    agents: ["kai", "mira"],
    listed: false,
    setup: { contextTools: true, mediaTools: true, embeddings: true, toolsOnDemand: true },
    judge: { followThrough: () => "done" },
    script: { kai: [{ calls: [READ] }, { text: `The record says ${CANARY}, as the paste did.` }, { text: "Yes." }] },
  });
  const asked = await w.say(`@kai a customer pasted this: ${ROOT}. Read record r1.`);
  await w.settle();
  await w.say(`it also said ${REPLY}, right?`);
  await w.settle();
  await w.advance(24 * 60);
  expect(asked.threadId).toBeNull();
  expect(JSON.stringify(w.judgments)).toContain(CANARY);
  expect(w.unrouted.join("\n")).toContain(REPLY);
  expect(JSON.stringify(w.f.embeddings.calls)).toContain(CANARY);
  const found = await w.tablesHolding(CANARY);
  expect(found).toEqual(expect.arrayContaining(["search_documents", "agent_run_steps", "agent_runs"]));
  expect(found.some((t) => t.startsWith("messages"))).toBe(true);
});

test("the tools the lock keeps copy nothing out: a question, a choice card, a block and its second version, a poll, an approval's title and why", async () => {
  const typed = (what: string) => `${what} ${CANARY}`;
  const w: VaultWorld = await vaultWorld({
    agents: ["kai"],
    changeAsks: true,
    setup: { blockTools: true, embeddings: true },
    script: {
      kai: ({ n, request }) => {
        if (n === 1) return { calls: [READ] };
        if (n === 2) {
          return {
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
                name: "ask_choices",
                input: {
                  title: typed("choice"),
                  questions: [{ question: typed("which"), options: [{ label: typed("a") }, { label: typed("b") }] }],
                },
              },
            ],
          };
        }
        if (n === 3) {
          // The block's id, as its tool's answer gave it.
          const block = /as block ([0-9a-f-]{36})/.exec(JSON.stringify(request.messages))?.[1];
          return {
            calls: [
              {
                name: "show_block",
                input: {
                  title: typed("block again"),
                  block_id: block,
                  spec: { parts: [{ type: "stat", label: typed("second"), value: "2" }] },
                },
              },
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
        }
        if (n === 4)
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
        return { text: "Waiting for your answer." };
      },
    },
  });
  await w.say("@kai read record r1 and ask me what to do");
  await w.settle();
  // The cards exist, with what the agent typed: on its approval, in the thread.
  const [approval] = await w.db.select().from(schema.approvals);
  expect(JSON.stringify([approval?.why, approval?.detail])).toContain(CANARY);
  await decideApproval({ db: w.db, pubsub: w.f.pubsub }, w.owner.id, w.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await w.settle();
  await w.advance(60);
  const [question] = await w.db.select().from(schema.agentQuestions);
  expect(question?.text).toContain(CANARY);
  const kept = await w.db.select().from(schema.artifacts);
  expect(kept.map((a) => a.kind).sort()).toEqual(["block", "choices", "poll"]);
  // The block was written a second time, which is what queues a file for the index.
  expect(kept.find((a) => a.kind === "block")?.currentVersion).toBe(2);
  expect(kept.map((a) => a.threadId)).toEqual(kept.map(() => (kept[0]?.threadId ?? null) as string | null));
  expect(kept[0]?.threadId).not.toBeNull();

  // The people who decide were told, with no word of it.
  const told = await w.db.select().from(schema.notifications);
  expect(told.map((t) => t.kind)).toEqual(expect.arrayContaining(["approval", "agent_question"]));
  expect(JSON.stringify(told)).not.toContain(CANARY);
  // No document of the index holds it, the block's second version included, and nothing was embedded.
  expect(JSON.stringify(await w.db.select().from(schema.searchDocuments))).not.toContain(CANARY);
  expect(JSON.stringify(w.f.embeddings.calls)).not.toContain(CANARY);
  // Nothing but the run, its cards and its thread holds it: no job's payload (a push, a mail), no audit row.
  expect(
    within(await w.tablesHolding(CANARY), [...OWN, "approvals", "agent_questions", "artifacts", "artifact_versions"]),
  ).toEqual([]);
});

test("what a run of the thread types on a card is kept inert: no link in a question, a choice card, a poll, or an approval's detail and why", async () => {
  const LINK = "[open the report](https://example.com/?q=WORDS)";
  const w = await vaultWorld({
    agents: ["kai"],
    changeAsks: true,
    setup: { blockTools: true },
    script: {
      kai: ({ n }) => {
        if (n === 1) return { calls: [READ] };
        if (n === 2)
          return {
            calls: [
              { name: "start_poll", input: { question: `Which one? ${LINK}`, options: ["yes", "no"] } },
              {
                name: "ask_choices",
                input: {
                  title: `Pick ${LINK}`,
                  questions: [{ question: `Which? ${LINK}`, options: [{ label: "a" }, { label: "b" }] }],
                },
              },
              {
                name: "vault_change_record",
                input: {
                  id: "r1",
                  note: `see ${LINK}`,
                  why: `The person asked for this change just now, see ${LINK}`,
                },
              },
            ],
          };
        if (n === 3)
          return {
            calls: [
              {
                name: "ask_user",
                input: { question: `Is that right? ${LINK}`, why: `Only the person can confirm it, see ${LINK}` },
              },
            ],
          };
        return { text: "Waiting for your answer." };
      },
    },
  });
  await w.say("@kai read record r1 and ask me what to do");
  await w.settle();
  const [approval] = await w.db.select().from(schema.approvals);
  await decideApproval({ db: w.db, pubsub: w.f.pubsub }, w.owner.id, w.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await w.settle();
  const [question] = await w.db.select().from(schema.agentQuestions);
  const cards = await w.db
    .select({ kind: schema.artifacts.kind, title: schema.artifacts.title, excerpt: schema.artifacts.excerpt })
    .from(schema.artifacts);
  expect(cards.map((c) => c.kind).sort()).toEqual(["choices", "poll"]);
  // What the apps show as formatted text: the words stay, and nothing in them is an address a click would open.
  const shown = JSON.stringify([approval?.title, approval?.detail, approval?.why, question?.text, cards]);
  expect(shown).toContain("open the report");
  expect(shown).not.toContain("](");
  expect(shown).not.toMatch(/:\/\/\S/);
  // The approved action itself is the one the agent asked for, to the letter.
  expect(approval?.params).toMatchObject({ note: `see ${LINK}` });
});

test("the operator's review of a run of a confidential thread names its calls and shows nothing of them", async () => {
  const w = await vaultWorld({
    agents: ["kai"],
    script: { kai: [{ calls: [READ] }, { text: `The record says ${CANARY}.` }] },
  });
  await w.say(`@kai a customer pasted this: ${ROOT}. Read record r1.`);
  await w.settle();
  const [run] = await w.runs("kai");
  const review = await operatorReview(w.db, "run", run?.id ?? "", { reason: "a sample", operator: "screening" });
  expect(review?.text).toContain("Tool call 1: vault_read_record (answered)");
  expect(review?.text).toContain(CONFIDENTIAL_NOT_SHOWN);
  for (const word of [CANARY, ROOT, "r1"]) expect(review?.text).not.toContain(word);
});

test("the operator's list of runs says a failed run of a confidential thread by its code, with none of its error's words", async () => {
  const w = await vaultWorld({
    agents: ["kai", "mira"],
    script: { kai: [{ calls: [READ] }, { text: "Read." }], mira: [{ text: "Fine." }] },
  });
  await w.say("@kai read record r1.");
  await w.say("@mira and you?");
  await w.settle();
  // As a run that failed on what it read keeps it: another program's words.
  const error = `The server answered: ${CANARY}`;
  await w.db.update(schema.agentRuns).set({ status: "failed", error });
  const listed = (await operatorRuns(w.db, w.org.id, { limit: 10 }))?.runs ?? [];
  const told = async (handle: string) => {
    const [run] = await w.runs(handle);
    const said = listed.find((r) => r.id === run?.id);
    return [said?.errorCode, said?.error];
  };
  expect(await told("kai")).toEqual(["run.failed", null]);
  // A run of the plain thread beside it reads as before.
  expect(await told("mira")).toEqual(["run.failed", error]);
});

test("a mail about requests left waiting counts one made in a confidential thread and quotes nothing of it", async () => {
  const w = await vaultWorld({
    agents: ["kai"],
    changeAsks: true,
    script: {
      kai: [
        { calls: [READ] },
        {
          calls: [
            {
              name: "vault_change_record",
              input: {
                id: "r1",
                note: CANARY,
                why: `the customer asked for this change in their own words: ${CANARY}`,
              },
            },
          ],
        },
      ],
    },
  });
  await w.say("@kai read record r1 and change it");
  await w.settle();
  const [approval] = await w.db.select().from(schema.approvals);
  expect(approval?.status).toBe("pending");
  expect(JSON.stringify(approval)).toContain(CANARY);
  const later = new Date(Date.now() + 5 * 3600_000);
  expect(await queueApprovalDigests(w.db, "https://chat.example.com", 4, later)).toBe(1);
  const mails = await w.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send"));
  expect(mails).toHaveLength(1);
  expect(JSON.stringify(mails)).not.toContain(CANARY);
});

test("a refused approval of a confidential thread leaves no lesson and no outcome", async () => {
  const w = await vaultWorld({
    agents: ["kai"],
    changeAsks: true,
    script: {
      kai: [
        { calls: [READ] },
        {
          calls: [
            {
              name: "vault_change_record",
              input: {
                id: "r1",
                note: CANARY,
                why: `the customer asked for this change in their own words: ${CANARY}`,
              },
            },
          ],
        },
        { text: "Understood." },
      ],
    },
  });
  await w.say("@kai read record r1 and change it");
  await w.settle();
  const [approval] = await w.db.select().from(schema.approvals);
  await decideApproval({ db: w.db, pubsub: w.f.pubsub }, w.owner.id, w.org.id, approval?.id ?? "", {
    decision: "refuse",
    reason: `no: ${CANARY} is not what they meant`,
  });
  await w.settle();
  const [refused] = await w.db.select().from(schema.approvals);
  expect(refused && (await learnFromRefusal({ db: w.db }, refused))).toBeNull();
  expect(await w.db.select().from(schema.contextItems)).toEqual([]);
  expect(await w.db.select().from(schema.outcomes)).toEqual([]);
});

test("one provider: a run that read the thread and comes back to another provider's model ends there, saying so", async () => {
  const change = (note: string) => ({
    name: "vault_change_record",
    input: { id: "r1", note, why: "the person asked for this change to the record just now, here" },
  });
  const scenario = async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      changeAsks: true,
      script: { kai: [{ calls: [READ] }, { calls: [change("seen")] }, { text: "Changed." }] },
    });
    await w.say("@kai read record r1 and change it");
    await w.settle();
    const [approval] = await w.db.select().from(schema.approvals);
    return {
      w,
      approve: () =>
        decideApproval({ db: w.db, pubsub: w.f.pubsub }, w.owner.id, w.org.id, approval?.id ?? "", {
          decision: "approve",
        }),
    };
  };

  // The same model when it comes back: it goes on.
  const same = await scenario();
  await same.approve();
  await same.w.settle();
  expect((await same.w.runs("kai"))[0]?.status).toBe("done");

  // Another provider's model: what it holds in its transcript would be sent there.
  const moved = await scenario();
  await moved.w.db
    .update(schema.agents)
    .set({ model: "gpt-6-sol" })
    .where(eq(schema.agents.id, moved.w.agents.kai?.id ?? ""));
  await moved.approve();
  await moved.w.settle();
  const [run] = await moved.w.runs("kai");
  expect([run?.status, run?.error]).toEqual(["failed", CONFIDENTIAL_AI_CHANGED]);
  // Nothing of the run was sent to the new provider.
  expect(moved.w.f.openaiProvider.calls.filter((c) => JSON.stringify(c.request).includes(CANARY))).toEqual([]);
});

test("one provider: another agent named in the thread that thinks with another provider is handed nothing of it", async () => {
  const w = await vaultWorld({
    agents: ["kai", "mira"],
    script: {
      kai: [{ calls: [READ] }, { text: `@mira the record says ${CANARY}, please look at it.` }],
      mira: () => ({ text: "Looked." }),
    },
  });
  await createCredential(w.db, w.f.keyWrapper, w.owner.id, w.org.id, {
    provider: "openai",
    label: "openai",
    apiKey: "test-openai-key",
    makeDefault: true,
  });
  await w.db
    .update(schema.agents)
    .set({ model: "gpt-6-sol", credentialId: null })
    .where(eq(schema.agents.id, w.agents.mira?.id ?? ""));
  const asked = await w.say("@kai read record r1");
  await w.settle();
  await w.advance(10);
  // The thread's own model read it, and named the other agent there.
  expect(w.turnsOf("kai").join("\n")).toContain(CANARY);
  const [run] = await w.runs("mira");
  expect([run?.threadRootId, run?.status, run?.error]).toEqual([asked.id, "failed", CONFIDENTIAL_AI_CHANGED]);
  expect(w.f.openaiProvider.calls.filter((c) => JSON.stringify(c.request).includes(CANARY))).toEqual([]);
});

test("a routine's own run that read the record leaves no record and delivers no report", async () => {
  const w = await vaultWorld({
    agents: ["kai"],
    script: { kai: [{ calls: [READ] }, { text: `The record says ${CANARY}.` }] },
  });
  const deps = { db: w.db, pubsub: w.f.pubsub, context: w.f.context };
  const routine = await createRoutine(deps, w.owner.id, w.org.id, {
    name: "Records",
    agentId: w.agents.kai?.id ?? "",
    prompt: "Read record r1 and report what it says.",
    target: { type: "channel", channelId: w.channelId },
    trigger: { type: "schedule", phrase: "todo dia às 8h" },
  });
  await w.db.update(schema.routines).set({ report: "always" }).where(eq(schema.routines.id, routine.id));
  await runRoutineNow(deps, w.owner.id, w.org.id, routine.id);
  await w.settle();
  await w.advance(10);
  // It read the record in its own room, whose thread is confidential now.
  expect(await w.tablesHolding(CANARY)).toEqual(expect.arrayContaining(["agent_run_steps"]));
  expect(await w.db.select().from(schema.confidentialThreads)).toHaveLength(1);
  // Its final text is neither the routine's record, which its next run is handed, nor a report where it reports.
  const [ended] = await w.db.select().from(schema.routineRuns);
  expect([ended?.status, ended?.summary]).toEqual(["silent", ""]);
  expect(await w.stored()).toEqual([]);
  expect(within(await w.tablesHolding(CANARY), OWN)).toEqual([]);
});

test("a write of the marking connection is no team action: its arguments stay with the run", async () => {
  const change = (id: string, note: string) => ({ name: "vault_change_record", input: { id, note } });
  const w = await vaultWorld({
    agents: ["kai"],
    script: {
      kai: [
        { calls: [change("r0", "before")] },
        { calls: [READ] },
        { calls: [change(`${CANARY}@example.com`, `the customer wrote ${CANARY}`)] },
        { text: "Done." },
      ],
    },
  });
  await w.say("@kai update the records");
  await w.settle();
  await w.advance(10);
  expect((await w.calls("kai")).map((c) => c.isError)).toEqual([false, false, false]);
  // The write before the mark is the team's to know, as always; the one after it is not.
  const actions = await w.db.select().from(schema.teamActions);
  expect(actions.map((a) => a.tool)).toEqual(["vault_change_record"]);
  expect(within(await w.tablesHolding(CANARY), OWN)).toEqual([]);
});

test("a write of the marking connection that a person approved is no team action either", async () => {
  const w = await vaultWorld({
    agents: ["kai"],
    changeAsks: true,
    script: {
      kai: [
        { calls: [READ] },
        {
          calls: [
            {
              name: "vault_change_record",
              input: {
                id: `${CANARY}@example.com`,
                note: `the customer wrote ${CANARY}`,
                why: "The person asked for this change to the record just now, in this thread.",
              },
            },
          ],
        },
        { text: "Done." },
      ],
    },
  });
  await w.say("@kai read record r1 and change it");
  await w.settle();
  const [approval] = await w.db.select().from(schema.approvals);
  await decideApproval({ db: w.db, pubsub: w.f.pubsub }, w.owner.id, w.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await w.settle();
  await w.advance(10);
  // The approved write went out to the server that marked the thread.
  expect(w.vault.requests.map((r) => r.name)).toEqual(["read_record", "change_record"]);
  expect((await w.db.select().from(schema.approvals))[0]?.executedAt).not.toBeNull();
  // Its targets and words are kept nowhere a team's other agents search.
  expect(await w.db.select().from(schema.teamActions)).toEqual([]);
  expect(JSON.stringify(await w.db.select().from(schema.searchDocuments))).not.toContain(CANARY);
  expect(within(await w.tablesHolding(CANARY), [...OWN, "approvals"])).toEqual([]);
});

test("a run another agent asked: what it would ask a person, or have them approve, is refused, and its answer goes back as the stub", async () => {
  const w = await vaultWorld({
    agents: ["mira", "kai"],
    changeAsks: true,
    script: {
      mira: [
        { calls: [{ name: "ask_agent", input: { agent: "@kai", question: "What does record r1 say?" } }] },
        { text: "Asked Kai." },
        { text: "Kai could not say." },
      ],
      kai: [
        { calls: [READ] },
        {
          calls: [
            {
              name: "ask_user",
              input: {
                question: `Is ${CANARY} right?`,
                why: `I need the person to confirm what the record says before going on, it said ${CANARY}`,
              },
            },
            {
              name: "vault_change_record",
              input: {
                id: `${CANARY}@example.com`,
                note: CANARY,
                why: `the customer asked for this change in their own words: ${CANARY}`,
              },
            },
          ],
        },
        { text: `It says ${CANARY}.` },
      ],
    },
  });
  await w.say("@mira ask kai what record r1 says");
  await w.settle();
  await w.advance(10);
  const calls = await w.calls("kai");
  expect(calls.map((c) => [c.name, c.isError])).toEqual([
    ["vault_read_record", false],
    ["ask_user", true],
    ["vault_change_record", true],
  ]);
  // No card where the person asked, for people who do not read the agents' conversation.
  expect(await w.db.select().from(schema.agentQuestions)).toEqual([]);
  expect(await w.db.select().from(schema.approvals)).toEqual([]);
  expect(JSON.stringify(await w.stored())).not.toContain(CANARY);
  expect(JSON.stringify(await w.db.select().from(schema.notifications))).not.toContain(CANARY);
  // The agent that asked is handed the stub for the answer, and nothing else holds the word.
  expect(w.turnsOf("mira").join("\n")).not.toContain(CANARY);
  expect(w.turnsOf("mira").join("\n")).toContain(CONFIDENTIAL_STUB);
  expect(within(await w.tablesHolding(CANARY), OWN)).toEqual([]);
});

test("a question asked from a confidential thread is told with no word of it, wherever its card is", async () => {
  const w = await vaultWorld({ agents: ["kai"], script: { kai: [{ calls: [READ] }, { text: "Read." }] } });
  await w.say("@kai read record r1");
  await w.settle();
  const [run] = await w.runs("kai");
  const elsewhere = await w.say("something else entirely");
  const [question] = await w.db
    .insert(schema.agentQuestions)
    .values({
      orgId: w.org.id,
      runId: run?.id ?? "",
      agentId: run?.agentId ?? "",
      channelId: w.channelId,
      threadId: elsewhere.id,
      toolUseId: "t9",
      text: `Is ${CANARY} right?`,
      choices: [`yes, ${CANARY}`],
      requestedForUserId: w.owner.id,
      expiresAt: new Date(Date.now() + 3600_000),
    })
    .returning();
  if (!question) throw new Error("no question");
  await notifyQuestion({ db: w.db, pubsub: w.f.pubsub }, question);
  const told = (await w.db.select().from(schema.notifications)).filter((n) => n.kind === "agent_question");
  expect(told).toHaveLength(1);
  expect(JSON.stringify(told)).not.toContain(CANARY);
});

test("learning, summaries and reflection, one guard at a time: no job for a run of the thread, none run for one queued before the mark, no thread to read", async () => {
  const w = await vaultWorld({
    agents: ["kai", "mira"],
    script: { kai: [{ calls: [READ] }, { text: `It says ${CANARY}.` }], mira: [{ text: "Plain." }] },
  });
  const plain = await w.say("@mira say something plain");
  await w.settle();
  const asked = await w.say("@kai read record r1");
  await w.settle();
  const [sealed] = await w.runs("kai");
  const [open] = await w.runs("mira");
  if (!sealed || !open) throw new Error("no runs");
  const taught = { judged: true, signal: "method" as const };
  // A turn that taught something queues its lesson; one of the confidential thread queues none.
  expect(await afterTurnDone(w.f.context, open, taught)).toBe(true);
  expect(await afterTurnDone(w.f.context, sealed, taught)).toBe(false);
  const jobs = await w.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "context.learn"));
  expect(jobs.map((j) => (j.payload as { runId?: string }).runId)).toEqual([open.id]);
  // A job a turn queued before its thread was marked does nothing when it runs.
  expect((await learnRun(w.f.context, { orgId: w.org.id, runId: sealed.id })).skipped).toBe("confidential");
  // What summarizes a thread or reflects on it is handed none of a confidential one.
  expect(await loadThread(w.db, w.org.id, asked.id)).toBeNull();
  expect(await loadThread(w.db, w.org.id, plain.id)).not.toBeNull();
});

test("a push with nothing to quote says only that something waits", () => {
  for (const kind of ["agent_question", "agent_reply", "mention", "approval"]) {
    const push = renderPush("en", { kind, waiting: true, actorName: "Kai", actorType: "agent", text: "", title: "" });
    expect(push.title).toContain("Kai");
    expect(push.body.length).toBeGreaterThan(0);
    expect(push.body).not.toContain("confidential");
  }
});
