import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  archiveAgent,
  askAgentToImplement,
  createAgent,
  createIssue,
  getIssue,
  getIssueDetail,
  listIssueActivity,
  listIssues,
  NEW_AGENT_DEFAULTS,
  openTaskConversation,
  openTasksBrief,
  postPersonMessage,
  removeMember,
  setIssueAudience,
  updateIssue,
  type WorkActor,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const p = (id: string): WorkActor => ({ type: "person", id });
const a = (id: string): WorkActor => ({ type: "agent", id });
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const assigned = (userId: string) =>
  f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.kind, "issue_assigned")));
const newAgent = (name: string) =>
  createAgent(f.db, f.owner.id, f.org.id, { name, handle: name.toLowerCase() }, NEW_AGENT_DEFAULTS);

describe("several assignees on a task (ADR 0188)", () => {
  test("a task is made with people and agents in order; one named twice counts once; more than 20 are refused", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const list = [p(bia.id), a(f.agent.id), p(caio.id), p(bia.id)];
    const issue = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "Launch", assignees: list });
    expect(issue.assignees).toEqual([p(bia.id), a(f.agent.id), p(caio.id)]);
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).assignees).toEqual(issue.assignees);
    // Each person put on it hears it, once.
    expect(await assigned(bia.id)).toHaveLength(1);
    expect(await assigned(caio.id)).toHaveLength(1);

    const bare = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "Nobody's" });
    expect(bare.assignees).toEqual([]);
    const many = Array.from({ length: 21 }, (_, n) => p(`user-${n}`));
    await expect(
      createIssue(deps(), person(f.owner.id), f.org.id, { title: "Crowd", assignees: many }),
    ).rejects.toThrow("at most 20");
  });

  test("a change sends the whole list: who is new is told, who is left out leaves, each one an event; a new order is none", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const owner = person(f.owner.id);
    const issue = await createIssue(deps(), owner, f.org.id, { title: "Report", assignees: [p(bia.id)] });
    const events = async () =>
      (await listIssueActivity(f.db, owner, f.org.id, issue.id))
        .filter((e) => e.event === "assigned")
        .map((e) => [e.textCode, e.assignee]);

    const next = await updateIssue(deps(), owner, f.org.id, issue.id, { assignees: [p(caio.id), a(f.agent.id)] });
    expect(next.assignees).toEqual([p(caio.id), a(f.agent.id)]);
    expect(await events()).toEqual([
      ["assigned", p(caio.id)],
      ["assigned", a(f.agent.id)],
      ["unassigned", p(bia.id)],
    ]);
    expect(await assigned(caio.id)).toHaveLength(1);
    // Bia's "assigned to you" is done with.
    expect((await assigned(bia.id)).map((n) => n.doneAt !== null)).toEqual([true]);

    const reordered = await updateIssue(deps(), owner, f.org.id, issue.id, {
      assignees: [a(f.agent.id), p(caio.id)],
    });
    expect(reordered.assignees).toEqual([a(f.agent.id), p(caio.id)]);
    expect(await events()).toHaveLength(3);
    expect(await assigned(caio.id)).toHaveLength(1);

    expect((await updateIssue(deps(), owner, f.org.id, issue.id, { assignees: [] })).assignees).toEqual([]);
    expect((await events()).slice(3)).toEqual([
      ["unassigned", a(f.agent.id)],
      ["unassigned", p(caio.id)],
    ]);
  });

  test("a person who can't see the task isn't put on it; the people on it stay when it is limited", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const dana = await addMember(f.db, f.org.id, "member", "dana");
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const task = await createIssue(deps(), person(ana.id), f.org.id, {
      title: "Payroll",
      assignees: [p(bia.id), p(caio.id)],
    });
    const limited = await setIssueAudience(deps(), person(ana.id), f.org.id, task.id, {
      mode: "people",
      userIds: [ana.id],
    });
    expect(limited.audience.userIds.sort()).toEqual([ana.id, bia.id, caio.id].sort());
    await expect(
      updateIssue(deps(), person(ana.id), f.org.id, task.id, { assignees: [p(bia.id), p(caio.id), p(dana.id)] }),
    ).rejects.toMatchObject({ code: "issue.assignee_outside" });
    // Sent again as it is, nobody on it is checked again.
    await updateIssue(deps(), person(ana.id), f.org.id, task.id, { assignees: [p(caio.id), p(bia.id)] });
  });

  test("in the task's conversation, what names nobody goes to the first assigned agent in the list's order", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"] }) });
    const qa = await newAgent("QA");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const owner = person(f.owner.id);
    const issue = await createIssue(deps(), owner, f.org.id, {
      title: "Review",
      assignees: [p(bia.id), a(qa.id), a(f.agent.id)],
    });
    const at = await openTaskConversation(f.db, owner, f.org.id, issue.id);
    const runsOf = async (messageId: string) =>
      (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, messageId))).map(
        (r) => r.agentId,
      );
    const say = (body: string) =>
      postPersonMessage(deps(), f.owner.id, f.org.id, at.channelId, { body, threadId: at.rootId });
    expect(await runsOf((await say("done")).id)).toEqual([qa.id]);
    // Every agent on it is in the conversation, to be named there.
    const members = await f.db
      .select({ agentId: schema.channelMembers.agentId })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, at.channelId));
    expect(members.map((m) => m.agentId).sort()).toEqual([qa.id, f.agent.id].sort());

    await updateIssue(deps(), owner, f.org.id, issue.id, { assignees: [a(f.agent.id), p(bia.id), a(qa.id)] });
    expect(await runsOf((await say("paid")).id)).toEqual([f.agent.id]);
  });

  test("asking an agent to implement puts it first, everyone else staying, and starts it", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"] }) });
    const qa = await newAgent("QA");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const owner = person(f.owner.id);
    const issue = await createIssue(deps(), owner, f.org.id, { title: "Fix login", assignees: [p(bia.id), a(qa.id)] });
    const asked = await askAgentToImplement(deps(), f.owner.id, f.org.id, issue.id, f.agent.id);
    expect(asked.assignees).toEqual([a(f.agent.id), p(bia.id), a(qa.id)]);
    expect(asked).toMatchObject({ status: "in_progress", work: { agentId: f.agent.id } });
    // One already on it moves to the front, with no new "assigned".
    const again = await askAgentToImplement(deps(), f.owner.id, f.org.id, issue.id, qa.id);
    expect(again.assignees).toEqual([a(qa.id), a(f.agent.id), p(bia.id)]);
    const events = (await listIssueActivity(f.db, owner, f.org.id, issue.id)).filter((e) => e.event === "assigned");
    expect(events.map((e) => e.assignee)).toEqual([a(f.agent.id)]);

    // QA's run ends while Dev's still waits to start: the task shows the one that is going.
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", finishedAt: new Date() })
      .where(and(eq(schema.agentRuns.issueId, issue.id), eq(schema.agentRuns.agentId, qa.id)));
    const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.issueId, issue.id));
    expect(runs.map((r) => r.agentId).sort()).toEqual([f.agent.id, qa.id].sort());
    // QA's run is the newer one and is over; Dev's, older, is alive.
    expect((await getIssue(f.db, owner, f.org.id, { id: issue.id })).work).toMatchObject({
      agentId: f.agent.id,
      state: "running",
    });
  });

  test("every assigned agent has the task among its open tasks, and a list by assignee finds it for each", async () => {
    f = await setup();
    const qa = await newAgent("QA");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const owner = person(f.owner.id);
    const issue = await createIssue(deps(), owner, f.org.id, {
      title: "Shared work",
      assignees: [a(f.agent.id), a(qa.id), p(bia.id)],
    });
    await createIssue(deps(), owner, f.org.id, { title: "Nobody's" });
    for (const agentId of [f.agent.id, qa.id]) {
      expect(await openTasksBrief(f.db, f.org.id, agentId, f.general.id, false)).toContain("Shared work");
    }
    for (const who of [a(f.agent.id), a(qa.id), p(bia.id)]) {
      expect((await listIssues(f.db, owner, f.org.id, { assignee: who })).map((i) => i.id)).toEqual([issue.id]);
    }
    expect(await listIssues(f.db, owner, f.org.id, { assignee: p(f.owner.id) })).toEqual([]);
    // A step carries its own.
    await createIssue(deps(), owner, f.org.id, { title: "Step", parentIssueId: issue.id, assignees: [a(qa.id)] });
    expect((await getIssueDetail(f.db, owner, f.org.id, { id: issue.id })).subIssues.map((s) => s.assignees)).toEqual([
      [a(qa.id)],
    ]);
  });

  test("a person who leaves the workspace and an archived agent leave every task they were on", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const owner = person(f.owner.id);
    const list = [p(bia.id), a(f.agent.id), p(caio.id)];
    const one = await createIssue(deps(), owner, f.org.id, { title: "One", assignees: list });
    const two = await createIssue(deps(), owner, f.org.id, { title: "Two", assignees: [p(bia.id)] });
    const of = async (id: string) => (await getIssue(f.db, owner, f.org.id, { id })).assignees;

    await removeMember(f.db, f.owner.id, f.org.id, bia.id, { pubsub: f.pubsub });
    expect(await of(one.id)).toEqual([a(f.agent.id), p(caio.id)]);
    expect(await of(two.id)).toEqual([]);

    await archiveAgent(f.db, f.owner.id, f.org.id, f.agent.id, f.pubsub);
    expect(await of(one.id)).toEqual([p(caio.id)]);
  });

  test("the migration carries each task's assignee over as the first of its list, leaving out who is gone", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const qa = await newAgent("QA");
    const owner = person(f.owner.id);
    const make = async (title: string) => (await createIssue(deps(), owner, f.org.id, { title })).id;
    const ofPerson = await make("A person's");
    const ofAgent = await make("An agent's");
    const ofArchived = await make("An archived agent's");
    const ofGone = await make("Of someone who left");
    await make("Nobody's");
    await archiveAgent(f.db, f.owner.id, f.org.id, qa.id, f.pubsub);
    // As the table was before: the two columns the migration reads.
    const had = (id: string, type: string, who: string) =>
      f.db.execute(sql`update issues set assignee_type = ${type}, assignee_id = ${who} where id = ${id}`);
    await had(ofPerson, "person", bia.id);
    await had(ofAgent, "agent", f.agent.id);
    await had(ofArchived, "agent", qa.id);
    await had(ofGone, "person", "someone-who-left");
    const file = await Bun.file(new URL("../../db/migrations/0281_issue_assignees.sql", import.meta.url)).text();
    const backfill = file.split("--> statement-breakpoint").find((s) => s.includes('INSERT INTO "issue_assignees"'));
    await f.db.execute(sql.raw(backfill ?? ""));
    const rows = await f.db.select().from(schema.issueAssignees);
    const got = new Map(rows.map((r) => [r.issueId, [r.assigneeType, r.assigneeId, r.position]]));
    expect(got.get(ofPerson)).toEqual(["person", bia.id, 0]);
    expect(got.get(ofAgent)).toEqual(["agent", f.agent.id, 0]);
    expect([...got.keys()].sort()).toEqual([ofPerson, ofAgent].sort());
  });
});
