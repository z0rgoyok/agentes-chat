import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  type AgentRun,
  buildRunContext,
  CHANNEL_LEAD_JOB,
  createAgent,
  endWork,
  getIssue,
  handOffsFrom,
  insertMessage,
  JevOffError,
  movableRun,
  onConsultedRunFinished,
  planStepOf,
  postWorkUpdate,
  recoverStaleRuns,
  replyPolicyFor,
  type ToolContext,
  tellChannelLead,
  updateIssue,
  WHY_GOING_ON,
  WHY_YOU_WERE_CALLED,
  workEligible,
  workView,
} from "../src";
import { CHANNEL_WORK_GUIDANCE, HANDED_HOME_AT_WORK, HANDED_HOME_GUIDANCE, noticeText } from "../src/notices";
import { openRoutineRoom } from "../src/routine-room";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close();
  f = undefined as unknown as Fixture;
});

const addAgent = (name: string) =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle: name.toLowerCase(), role: "Operations", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );

/** A run of @dev in #general on the person's message: the conversation the hand-off reports to. */
async function devRun(body: string) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
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
      stretchId: trigger.id,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const ctxOf = (run: AgentRun): ToolContext => ({
  db: f.db,
  orgId: run.orgId,
  agentId: run.agentId,
  runId: run.id,
  channelId: run.channelId,
  threadRootId: run.threadRootId,
  triggerMessageId: run.triggerMessageId,
});

const tell = (run: AgentRun, agent: string, message: string, more: Record<string, unknown> = {}) => {
  if (!f.tools) throw new Error("no tools");
  return f.tools.invoke(ctxOf(run), {
    toolUseId: `tu_${crypto.randomUUID()}`,
    name: "tell_agent",
    input: { agent, message, ...more },
  });
};

const consultations = () =>
  f.db
    .select()
    .from(schema.agentConsultations)
    .orderBy(asc(schema.agentConsultations.createdAt), asc(schema.agentConsultations.id));
const works = () => f.db.select().from(schema.agentWorks).orderBy(asc(schema.agentWorks.createdAt));
const runOf = async (id: string | null | undefined) => {
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, id ?? ""));
  if (!run) throw new Error("no run");
  return run;
};

/** Atlas's run ends with `body` as its report (`meta.workEnd`, as the executor posts it), then its hooks run. */
async function reports(run: AgentRun, body: string) {
  const said = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: run.channelId,
    author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
    body,
    meta: { workEnd: { id: run.workId, status: "done" } },
  });
  await f.db
    .update(schema.agentRuns)
    .set({ status: "done", replyMessageId: said.id })
    .where(eq(schema.agentRuns.id, run.id));
  const ended = await runOf(run.id);
  await endWork({ db: f.db, pubsub: f.pubsub }, ended, "done");
  await onConsultedRunFinished({ db: f.db, pubsub: f.pubsub, judge: f.context.judge }, ended, "done");
  return said;
}

describe("work handed to another agent reports where the person asked (F1)", () => {
  test("tell_agent makes the run it starts a handed work, reporting in the person's conversation", async () => {
    f = await setup({ askAgent: true });
    const atlas = await addAgent("Atlas");
    const dev = await devRun("@dev get the October sales report ready");
    await tell(dev, "@atlas", "Build the October sales report.\nOrders and refunds.");
    const [c] = await consultations();
    const [w] = await works();
    const run = await runOf(c?.targetRunId);
    expect(w).toMatchObject({
      how: "handed",
      agentId: atlas.id,
      channelId: f.general.id,
      handedThreadId: null,
      consultationId: c?.id,
      anchorMessageId: c?.messageId,
      requestedByUserId: f.owner.id,
      title: "Build the October sales report.",
      status: "live",
    });
    expect(run.workId).toBe(w?.id ?? "");
    const view = await workView(f.db, f.org.id, w?.id ?? "");
    expect(view).toMatchObject({
      how: "handed",
      channelId: f.general.id,
      homeThreadId: null,
      askerRunId: dev.id,
      handedBy: { agentId: f.agent.id, consultationId: c?.id },
    });
    // Its card on the board, made by the agent that handed it, from where the person asked.
    const issue = await getIssue(f.db, { type: "person", userId: f.owner.id }, f.org.id, { id: w?.issueId ?? "" });
    expect(issue).toMatchObject({
      assignees: [{ type: "agent", id: atlas.id }],
      createdBy: { type: "agent", id: f.agent.id },
      source: { type: "agent", agentId: f.agent.id, channelId: f.general.id, messageId: dev.triggerMessageId },
    });
    expect(issue.backgroundWork?.handedBy?.agentId).toBe(f.agent.id);
  });

  test("the agent that handed it is told the person follows the work there, and that it isn't woken to relay it", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    const out = await tell(dev, "@atlas", "Build the October sales report.");
    expect(out).toMatchObject({
      output: { content: expect.stringContaining("you are not woken to relay what comes of it") },
    });
  });

  test("a run a note only joined never becomes a handed work, even through work_in_background", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    await tell(dev, "@atlas", "Build the October sales report.");
    const [c] = await consultations();
    const run = await runOf(c?.targetRunId);
    // As if the run had started on something else and this note joined it.
    expect(await workEligible(f.db, { ...run, workId: null, triggerMessageId: dev.triggerMessageId })).toBe(false);
  });

  test("a note that joins a run already at work makes no second work", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev tell atlas");
    await tell(dev, "@atlas", "First part.");
    await tell(dev, "@atlas", "Second part.");
    const [first, second] = await consultations();
    expect(second?.targetRunId).toBe(first?.targetRunId ?? "");
    expect(await works()).toHaveLength(1);
  });

  test("a second note that joins the work rides on it: the sender is told so, and neither note wakes it", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev tell atlas");
    await tell(dev, "@atlas", "Build the October sales report.");
    const out = await tell(dev, "@atlas", "Add the refunds too.");
    expect(out).toMatchObject({
      output: { content: expect.stringContaining("you are not woken to relay what comes of it") },
    });
    const [c] = await consultations();
    // Its run read the second note at its next step.
    await f.db
      .update(schema.agentRuns)
      .set({ pendingMessageIds: [] })
      .where(eq(schema.agentRuns.id, c?.targetRunId ?? ""));
    await reports(await runOf(c?.targetRunId), "Report saved in Drive, refunds included.");
    expect((await consultations()).map((r) => r.status)).toEqual(["answered", "answered"]);
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.filter((r) => r.agentId === f.agent.id)).toHaveLength(1);
  });

  test("a delegate lost in a restart posts its end home before the sender hears it, so the sender isn't woken", async () => {
    f = await setup({ askAgent: true });
    const atlas = await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    await tell(dev, "@atlas", "Build the October sales report.");
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, dev.id));
    const [c] = await consultations();
    const long = new Date(Date.now() - 10 * 60_000);
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", startedAt: long, heartbeatAt: long })
      .where(eq(schema.agentRuns.id, c?.targetRunId ?? ""));
    // Its job went with its worker.
    await f.db.update(schema.outbox).set({ status: "done" }).where(eq(schema.outbox.kind, "agent_run.execute"));
    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).failed).toEqual([c?.targetRunId ?? ""]);
    const [w] = await works();
    const [end] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, w?.resultMessageId ?? ""));
    expect(end).toMatchObject({ channelId: f.general.id, authorAgentId: atlas.id });
    expect((await consultations())[0]?.status).toBe("failed");
    const notice = (await f.db.select().from(schema.messages)).find(
      (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "consult_reply",
    );
    expect((notice?.meta.notice as { refs?: { wake?: string } } | undefined)?.refs).toMatchObject({ status: "failed" });
    expect((notice?.meta.notice as { refs?: { wake?: string } } | undefined)?.refs?.wake).toBeUndefined();
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.filter((r) => r.agentId === f.agent.id)).toHaveLength(1);
  });

  test("the delegate may post updates: they land in the person's conversation as its own", async () => {
    f = await setup({ askAgent: true });
    const atlas = await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    await tell(dev, "@atlas", "Build the October sales report.");
    const [c] = await consultations();
    const run = await runOf(c?.targetRunId);
    // Already its work: no second move, and the run counts as one people follow.
    expect(await workEligible(f.db, { ...run, workId: null })).toBe(true);
    expect(await movableRun(f.db, run)).toBe(false);
    const out = await postWorkUpdate({ db: f.db, pubsub: f.pubsub }, run.id, {
      text: "Pulled 1,284 October orders from the store.",
      plan: [
        { id: "s1", text: "Pull orders", state: "done" },
        { id: "s2", text: "Match refunds", state: "doing" },
      ],
    });
    if (!out.ok) throw new Error(out.reason);
    expect(out.message).toMatchObject({
      channelId: f.general.id,
      threadId: null,
      authorAgentId: atlas.id,
      agentRunId: run.id,
    });
    expect((await workView(f.db, f.org.id, out.work.id))?.planStep).toEqual({ current: 2, total: 2 });
  });

  test("its report is copied home, which becomes the result; the card goes to Done with its first line", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    await tell(dev, "@atlas", "Build the October sales report.");
    const [c] = await consultations();
    const run = await runOf(c?.targetRunId);
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, run.id));
    const issueId = (await works())[0]?.issueId ?? "";
    expect((await getIssue(f.db, { type: "person", userId: f.owner.id }, f.org.id, { id: issueId })).status).toBe(
      "in_progress",
    );
    const said = await reports(await runOf(run.id), "Report saved in Drive.\n\nTwo totals need checking.");
    const [w] = await works();
    const [copy] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, w?.resultMessageId ?? ""));
    expect(copy).toMatchObject({ channelId: f.general.id, body: said.body, agentRunId: run.id });
    expect(copy?.meta.handedReport).toEqual({ fromMessageId: said.id });
    const issue = await getIssue(f.db, { type: "person", userId: f.owner.id }, f.org.id, { id: issueId });
    expect(issue.status).toBe("done");
    expect(issue.backgroundWork?.result).toEqual({ text: "Report saved in Drive.", messageId: copy?.id ?? "" });
    // Nothing woke the agent that handed it to relay it.
    expect((await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === f.agent.id)).toHaveLength(1);
  });

  test("a turn that ends with a criterion still open leaves the card in review, not Done", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    await tell(dev, "@atlas", "Build the October sales report.");
    const [c] = await consultations();
    const run = await runOf(c?.targetRunId);
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, run.id));
    const issueId = (await works())[0]?.issueId ?? "";
    const owner = { type: "person" as const, userId: f.owner.id };
    await updateIssue({ db: f.db, pubsub: f.pubsub }, owner, f.org.id, issueId, {
      criteria: [{ text: "Totals match the store" }],
    });
    await reports(await runOf(run.id), "Pulled the orders; refunds come next.");
    expect((await getIssue(f.db, owner, f.org.id, { id: issueId })).status).toBe("in_review");
  });

  test("a stop posts its end where the person asked", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    await tell(dev, "@atlas", "Build the October sales report.");
    const [c] = await consultations();
    await f.db
      .update(schema.agentRuns)
      .set({ status: "canceled" })
      .where(eq(schema.agentRuns.id, c?.targetRunId ?? ""));
    await endWork({ db: f.db, pubsub: f.pubsub }, await runOf(c?.targetRunId), "canceled");
    const [w] = await works();
    const [end] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, w?.resultMessageId ?? ""));
    expect(end).toMatchObject({ channelId: f.general.id, threadId: null });
    expect(end?.meta.workEnd).toMatchObject({ status: "canceled" });
  });
});

describe("the agent that handed it goes on when a step of its own waits on the result", () => {
  /** The delegate's reply matters to the sender; `next` is the judge's reading of whether the sender goes on. */
  const judging = (next: number) => (kind: string) =>
    kind === "note_reply" ? 0.9 : kind === "hand_off_next" ? next : undefined;
  /** The same, with the sender's judgment failing as `error` does. */
  const failing = (error: Error) => (kind: string) => {
    if (kind === "hand_off_next") throw error;
    return kind === "note_reply" ? 0.9 : undefined;
  };

  const refsOf = (m: { meta: Record<string, unknown> } | undefined) =>
    (m?.meta.notice as { refs?: Record<string, string> } | undefined)?.refs;
  const replies = async () =>
    (await f.db.select().from(schema.messages).orderBy(asc(schema.messages.createdAt), asc(schema.messages.id))).filter(
      (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "consult_reply",
    );
  const devRuns = async () => (await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === f.agent.id);
  const judged = (kind: string) =>
    (f.context.judge as unknown as { calls: { kind: string; state: Record<string, unknown> }[] }).calls.filter(
      (c) => c.kind === kind,
    );

  const REQUEST = "@dev you run the month's close: Atlas totals the invoices, you check them and send the report";
  const TOTALS = "Total this month's invoices by client.";

  /** @dev hands Atlas the invoices, ends its turn, and Atlas posts its report home. */
  async function handedAndBack(options: { confidential?: boolean } = {}) {
    await addAgent("Atlas");
    const dev = await devRun(REQUEST);
    await tell(dev, "@atlas", TOTALS);
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, dev.id));
    if (options.confidential)
      await f.db
        .insert(schema.confidentialThreads)
        .values({ orgId: f.org.id, channelId: dev.channelId, rootMessageId: dev.threadRootId });
    const [c] = await consultations();
    await reports(await runOf(c?.targetRunId), "The totals by client are in the shared sheet.");
    return { dev, runs: await devRuns(), notices: await replies() };
  }

  test("it wakes once, told the result is already with the people, and may stay quiet", async () => {
    f = await setup({ askAgent: true, judge: judging(0.9) });
    const events = f.listen(f.general.id);
    const { dev, runs, notices } = await handedAndBack();
    expect(notices).toHaveLength(1);
    expect(refsOf(notices[0])).toMatchObject({ wake: "1", home: "1" });
    const woken = runs.filter((r) => r.id !== dev.id);
    expect(woken).toHaveLength(1);
    expect(woken[0]?.triggerMessageId).toBe(notices[0]?.id ?? "");
    expect(replyPolicyFor(woken[0] as AgentRun, notices[0]).mayPass).toBe(true);
    expect(noticeText(notices[0]?.meta, true)).toContain(HANDED_HOME_GUIDANCE);
    expect(events.find((e) => e.type === "agent.consulted")).not.toHaveProperty("goesOn");
    // Woken to go on, not to stay quiet without looking.
    const context = await buildRunContext(f.db, woken[0] as AgentRun, f.agent, { maxMessages: 10, mayPass: true });
    expect(systemText(context.system)).toContain(WHY_GOING_ON);
    expect(systemText(context.system)).not.toContain(WHY_YOU_WERE_CALLED);
    // The judge read the person's request and what came back.
    expect(judged("hand_off_next")[0]?.state).toMatchObject({
      request: REQUEST,
      handed: [
        {
          to: "@atlas",
          note: expect.stringContaining("invoices by client"),
          result: expect.stringContaining("shared sheet"),
        },
      ],
      pending: [],
    });
  });

  test("a plain delegation still wakes nobody, and the apps hear the sender isn't writing", async () => {
    f = await setup({ askAgent: true, judge: judging(0.1) });
    const events = f.listen(f.general.id);
    const { runs, notices } = await handedAndBack();
    expect(notices).toHaveLength(1);
    expect(refsOf(notices[0])?.wake).toBeUndefined();
    expect(runs).toHaveLength(1);
    expect(events.find((e) => e.type === "agent.consulted")).toMatchObject({ kind: "note", goesOn: false });
  });

  test("a judge that can't answer here wakes nobody; one that fails wakes the sender", async () => {
    f = await setup({ askAgent: true, judge: failing(new JevOffError()) });
    expect((await handedAndBack()).runs).toHaveLength(1);
    await f.close();
    f = await setup({ askAgent: true, judge: failing(new Error("judge: timed out")) });
    expect((await handedAndBack()).runs).toHaveLength(2);
  });

  test("a confidential thread's words never reach the judge, even once the sender's run is gone from memory", async () => {
    f = await setup({ askAgent: true, judge: judging(0.9) });
    expect((await handedAndBack({ confidential: true })).runs).toHaveLength(1);
    expect(judged("hand_off_next")).toHaveLength(0);
  });

  test("a sender still at work takes the result into its turn, without asking the judge", async () => {
    f = await setup({ askAgent: true, judge: judging(0.1) });
    await addAgent("Atlas");
    const dev = await devRun(REQUEST);
    await tell(dev, "@atlas", TOTALS);
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, dev.id));
    const [c] = await consultations();
    await reports(await runOf(c?.targetRunId), "The totals by client are in the shared sheet.");
    const [notice] = await replies();
    expect(refsOf(notice)).toMatchObject({ wake: "1", home: "1" });
    expect(await devRuns()).toHaveLength(1);
    expect((await runOf(dev.id)).pendingMessageIds).toContain(notice?.id ?? "");
    expect(judged("hand_off_next")).toHaveLength(0);
    // Read mid-turn: no "woken", no pass.
    const text = noticeText(notice?.meta, true, false, true) ?? "";
    expect(text).toContain(HANDED_HOME_AT_WORK);
    expect(text).not.toContain("call pass");
  });

  test("colleagues still out reach the judge and the woken run, which isn't told everything is back", async () => {
    f = await setup({ askAgent: true, judge: judging(0.9) });
    await addAgent("Atlas");
    await addAgent("Mila");
    const dev = await devRun(REQUEST);
    await tell(dev, "@atlas", TOTALS);
    await tell(dev, "@mila", "Send the report to the accountant once the totals are in.");
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, dev.id));
    const [toAtlas, toMila] = await consultations();
    // Mila's part waits on a person's approval: it holds up nobody.
    await f.db
      .update(schema.agentRuns)
      .set({ status: "waiting_approval" })
      .where(eq(schema.agentRuns.id, toMila?.targetRunId ?? ""));
    await reports(await runOf(toAtlas?.targetRunId), "The totals by client are in the shared sheet.");
    const [notice] = await replies();
    expect(refsOf(notice)).toMatchObject({ wake: "1", home: "1", pending: "@mila" });
    const text = noticeText(notice?.meta, true) ?? "";
    expect(text).toContain("Still out, waiting on a person or a computer: @mila");
    expect(text).not.toContain("Everything you handed off");
    expect(judged("hand_off_next")[0]?.state).toMatchObject({
      pending: [{ to: "@mila", note: expect.stringContaining("to the accountant") }],
    });
  });

  test("from the second round on, the judge still reads the person's request and what the sender told them", async () => {
    f = await setup({ askAgent: true, judge: judging(0.9) });
    await addAgent("Atlas");
    await addAgent("Mila");
    const dev = await devRun(REQUEST);
    await tell(dev, "@atlas", TOTALS);
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, dev.id));
    const [toAtlas] = await consultations();
    await reports(await runOf(toAtlas?.targetRunId), "The totals by client are in the shared sheet.");
    // Woken, it checks the totals, hands the next part on and tells the people.
    const [second] = (await devRuns()).filter((r) => r.id !== dev.id);
    if (!second) throw new Error("not woken");
    await tell(second, "@mila", "Write the summary for the accountant from the shared sheet.");
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: second.id, hop: second.hop },
      body: "The totals check out; Mila is writing the summary.",
    });
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", replyMessageId: said.id })
      .where(eq(schema.agentRuns.id, second.id));
    const toMila = (await consultations()).find((c) => c.askerRunId === second.id);
    await reports(await runOf(toMila?.targetRunId), "The summary is in the shared folder.");
    const [, again] = judged("hand_off_next");
    expect(again?.state).toMatchObject({
      request: REQUEST,
      said: expect.stringContaining("Mila is writing the summary"),
      handed: [{ to: "@mila", result: expect.stringContaining("shared folder") }],
    });
  });
});

describe("one turn of the agent at a time, whatever handed the work", () => {
  const judging = (kind: string) => (kind === "note_reply" || kind === "hand_off_next" ? 0.9 : undefined);
  const devRuns = async () => (await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === f.agent.id);

  test("two reports at once wake one turn of the agent, not two side by side", async () => {
    f = await setup({ askAgent: true, judge: judging });
    await addAgent("Atlas");
    await addAgent("Mila");
    const first = await devRun("@dev get this month's invoices totaled");
    await tell(first, "@atlas", "Total this month's invoices by client.");
    const second = await devRun("@dev and get the accountant's summary written");
    await tell(second, "@mila", "Write the summary for the accountant.");
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.agentId, f.agent.id));
    const [toAtlas, toMila] = await consultations();
    await reports(await runOf(toAtlas?.targetRunId), "The totals by client are in the shared sheet.");
    await reports(await runOf(toMila?.targetRunId), "The summary is in the shared folder.");
    const woken = (await devRuns()).filter((r) => r.id !== first.id && r.id !== second.id);
    expect(woken).toHaveLength(1);
    const notices = (await f.db.select().from(schema.messages)).filter(
      (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "consult_reply",
    );
    expect(notices).toHaveLength(2);
    // The second report joined the turn the first one started.
    const late = notices.find((m) => m.id !== woken[0]?.triggerMessageId);
    expect(woken[0]?.pendingMessageIds).toContain(late?.id ?? "");
  });

  test("what its routine handed off for this conversation shows in the work it handed off here", async () => {
    f = await setup({ askAgent: true, judge: judging });
    const atlas = await addAgent("Atlas");
    // The routine works in its own room and reports in #general.
    const routineId = crypto.randomUUID();
    const room = await openRoutineRoom(f.db, f.org.id, f.agent.id, routineId);
    const brief = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: room.id,
      author: { type: "person", userId: f.owner.id },
      body: "Every morning, get the day's invoices totaled.",
      meta: {
        routineBrief: {
          routineId,
          routineRunId: crypto.randomUUID(),
          deliverTo: { channelId: f.general.id, threadId: null },
        },
      },
    });
    const [routineRun] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: room.id,
        threadRootId: brief.id,
        triggerMessageId: brief.id,
        trigger: "mention",
        hop: 1,
        stretchId: brief.id,
        background: true,
      })
      .returning();
    if (!routineRun) throw new Error("no run");
    await f.db.insert(schema.agentConsultations).values({
      orgId: f.org.id,
      askerRunId: routineRun.id,
      askerAgentId: f.agent.id,
      targetAgentId: atlas.id,
      channelId: room.id,
      messageId: brief.id,
      waitId: `note:${crypto.randomUUID()}`,
      question: "Total today's invoices by client.",
      chain: [f.agent.id],
      kind: "note",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const later = await devRun("@dev how are today's invoices going?");
    expect((await handOffsFrom(f.db, later)).map((h) => [h.handle, h.status])).toEqual([["atlas", "open"]]);
  });
});

describe("the channel's responsible agent gets the turn when work a person asked of another agent ends there", () => {
  const judging = (next: number) => (kind: string) => (kind === "channel_lead_next" ? next : undefined);
  const leadDeps = () => ({ db: f.db, pubsub: f.pubsub, judge: f.context.judge });
  const leadJobs = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, CHANNEL_LEAD_JOB));

  /** Atlas and Mila in #general, Mila responsible for it. */
  async function team() {
    const atlas = await addAgent("Atlas");
    const mila = await addAgent("Mila");
    await f.db.insert(schema.channelMembers).values([
      { orgId: f.org.id, channelId: f.general.id, agentId: atlas.id },
      { orgId: f.org.id, channelId: f.general.id, agentId: mila.id },
    ]);
    await f.db.update(schema.channels).set({ leadAgentId: mila.id }).where(eq(schema.channels.id, f.general.id));
    return { atlas, mila };
  }

  /** A person asked Atlas for work in #general; it ends with `report`. */
  async function ownWorkEnds(report = "The totals by client are in the shared sheet; March is still missing.") {
    const { atlas, mila } = await team();
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "@atlas total this month's invoices by client",
    });
    const [work] = await f.db
      .insert(schema.agentWorks)
      .values({
        orgId: f.org.id,
        agentId: atlas.id,
        channelId: f.general.id,
        anchorMessageId: ask.id,
        ownThread: false,
        title: "Total this month's invoices",
        status: "live",
        how: "agent",
        lastUpdateAt: new Date(),
        requestedByUserId: f.owner.id,
      })
      .returning();
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: atlas.id,
        channelId: f.general.id,
        threadRootId: ask.id,
        triggerMessageId: ask.id,
        trigger: "mention",
        hop: 1,
        stretchId: ask.id,
        workId: work?.id,
        transcript: { messages: [] },
      })
      .returning();
    if (!work || !run) throw new Error("no work");
    const said = await reports(run, report);
    return { atlas, mila, work, run, said };
  }

  test("its turn is judged in a job and lands under the report, as data, in a run it may pass", async () => {
    f = await setup({ judge: judging(0.9) });
    const { mila, work, run, said } = await ownWorkEnds();
    const jobs = await leadJobs();
    expect(jobs.map((j) => j.payload)).toEqual([{ workId: work.id, runId: run.id }]);
    const delivered = await tellChannelLead(leadDeps(), f.org.id, { workId: work.id, runId: run.id });
    expect(delivered?.message).toMatchObject({
      channelId: f.general.id,
      threadId: said.threadId,
      authorAgentId: mila.id,
      mentionedAgentIds: [],
    });
    expect(delivered?.message.body).not.toContain("@");
    expect(delivered?.message.meta.notice).toMatchObject({ kind: "channel_work", from: "@atlas" });
    expect(delivered?.runs.map((r) => r.agentId)).toEqual([mila.id]);
    const woken = delivered?.runs[0] as AgentRun;
    expect(replyPolicyFor(woken, delivered?.message).mayPass).toBe(true);
    const text = noticeText(delivered?.message.meta, true) ?? "";
    expect(text).toContain(CHANNEL_WORK_GUIDANCE);
    expect(text).toContain(`"Total this month's invoices"`);
    expect(text).toContain("<external_data");
    const context = await buildRunContext(f.db, woken, mila, { maxMessages: 10, mayPass: true });
    expect(systemText(context.system)).toContain(WHY_GOING_ON);
  });

  test("not when the judge reads no step, the lead waits to be mentioned, or people can continue that end", async () => {
    f = await setup({ judge: judging(0.1) });
    const first = await ownWorkEnds();
    expect(await tellChannelLead(leadDeps(), f.org.id, { workId: first.work.id, runId: first.run.id })).toBeNull();
    await f.close();
    f = await setup({ judge: judging(0.9) });
    const mentioned = await ownWorkEnds();
    await f.db
      .update(schema.channelMembers)
      .set({ autoReply: false })
      .where(eq(schema.channelMembers.agentId, mentioned.mila.id));
    expect(
      await tellChannelLead(leadDeps(), f.org.id, { workId: mentioned.work.id, runId: mentioned.run.id }),
    ).toBeNull();
    await f.close();
    f = await setup({ judge: judging(0.9) });
    const cut = await ownWorkEnds();
    // Its step limit cut it short: Continuar goes on from that reply.
    await f.db
      .update(schema.messages)
      .set({ meta: { ...cut.said.meta, stepLimit: true } })
      .where(eq(schema.messages.id, cut.said.id));
    expect(await tellChannelLead(leadDeps(), f.org.id, { workId: cut.work.id, runId: cut.run.id })).toBeNull();
  });

  test("work handed off queues nothing: it goes back to the agent that handed it", async () => {
    f = await setup({ askAgent: true, judge: (kind) => (kind === "note_reply" ? 0.9 : judging(0.9)(kind)) });
    await team();
    const dev = await devRun("@dev get this month's invoices totaled");
    await tell(dev, "@atlas", "Total this month's invoices by client.");
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, dev.id));
    const [c] = await consultations();
    await reports(await runOf(c?.targetRunId), "The totals by client are in the shared sheet.");
    expect(await leadJobs()).toEqual([]);
  });
});

describe("where its plan is", () => {
  test("the first step not done, never past the last", () => {
    const steps = (states: ("todo" | "doing" | "done")[]) =>
      states.map((state, i) => ({ id: `s${i}`, text: `Step ${i}`, state }));
    expect(planStepOf(steps(["done", "done", "doing", "todo", "todo"]))).toEqual({ current: 3, total: 5 });
    expect(planStepOf(steps(["done", "done"]))).toEqual({ current: 2, total: 2 });
    expect(planStepOf([])).toBeNull();
  });
});
