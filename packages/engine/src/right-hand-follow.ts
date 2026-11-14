import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  gte,
  isNotNull,
  isNull,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { plainLine } from "@agenteschat/ui/markdown";
import { runPerson } from "./authority";
import { deliverNotice, publishDelivery } from "./delivery";
import { openPersonAgentDm, personAgentDmKey } from "./dms";
import { cutText } from "./format";
import { canSee } from "./issues";
import type { Notice } from "./notices";
import { humanBehindRun, issueStatusGroup } from "./notification-producers";
import { markNotificationRead } from "./notifications";
import { enqueue } from "./outbox";
import { RIGHT_HAND } from "./right-hand";
import { defineLodiLane, type LodiPromptContext } from "./right-hand-lane";
import { readLodiPrefs } from "./right-hand-prefs";
import { lodiFor, saidOnce } from "./right-hand-proactive";
import { localDate } from "./rrule";
import { forPeople } from "./run-resume";

/**
 * "Lembrar o que combinamos": the right hand follows a task it handed over to its end, says once when one is stuck,
 * and keeps what it and a person agreed on with a time as a reminder.
 *
 * The contract with the rest of the server is `followLane` below: the server reads the jobs, the prompt block and the
 * switch from it, so nothing else is wired by hand.
 * - A task's end (`TASK_END_JOB`, queued with the status change): done or canceled after the hand-over was reported
 *   back, the right hand is told once in the DM of the person it handed the task over for.
 * - A task that stopped (`TASK_CHECK_JOB`, queued with the hand-over, first a day later): nothing moved for
 *   `HANDED_TASK_QUIET_MS` and it waits on someone or something the person was not told of, it is told once what.
 *   Otherwise it looks again a day later, `HANDED_TASK_LOOKS` times. A task reported back and left open is not
 *   stopped: the person heard its report, and closing it is theirs.
 * - What it is told is a notice only it reads (`wait_result` with `refs.task`), and at most
 *   `HANDED_TASK_WAKES_A_DAY` of them a person a day start a turn of it, on the AI that answers that person in that
 *   DM: their own for the right hand when they chose one, else the workspace's as it serves them, which may be
 *   another person's plan that serves everyone (`right-hand.ts`). Neither job calls a model.
 * - `keepingWordBlock` is a block of its prompt in its DM with `ctx.personId`: when to set a reminder by itself and
 *   the ones waiting there. A plain reminder posts the person's words at its time, with no model call.
 * - The person's switch (`remindOff`) stops all three. `live` shows it on the right hand's page and adds `reminders`
 *   to `set_team_week`.
 */

const { agentConsultations, agentRuns, agents, channels, issues, messages, notifications, routines, users } = schema;

export const TASK_CHECK_JOB = "right_hand.task_check";
export const TASK_END_JOB = "right_hand.task_end";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A task that changed or was written in this lately is moving. */
export const HANDED_TASK_QUIET_MS = 4 * HOUR_MS;
/** How many daily looks a handed task gets. */
export const HANDED_TASK_LOOKS = 7;
/** How many turns a day these notices start for one person. Past it they are written and read with the next turn. */
export const HANDED_TASK_WAKES_A_DAY = 3;
/** How many reminders the right hand keeps by itself in one DM. */
export const KEPT_REMINDERS_MAX = 3;
/**
 * How long after a status change its job runs. A change made through `updateIssue` tells the right hand itself, right
 * away: the job is what tells it when that failed, when the server stopped in between, or when background work ended
 * the task.
 */
const END_JOB_DELAY_MS = 60_000;
/**
 * An end this close after the hand-over's report is the same finish: the run that reported also closed the task, in
 * either order, and its report tells it.
 */
const SAME_FINISH_MS = 5 * 60_000;

type Deps = { db: Database; pubsub?: PubSub };
type IssueRow = typeof issues.$inferSelect;
type HandOver = typeof agentConsultations.$inferSelect;
/** Who changed a task: a person, or an agent (in a run, when it has one). */
export interface TaskChangedBy {
  type: "person" | "agent";
  id: string;
  runId?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const taskLabel = (issue: Pick<IssueRow, "number" | "title">) =>
  `Task #${issue.number} "${cutText(plainLine(issue.title), 120)}"`;

/** The first look at a task the right hand just handed over, or the next one: a day from now. */
export async function queueTaskCheck(tx: Executor, orgId: string, consultationId: string, n = 1) {
  if (n > HANDED_TASK_LOOKS) return;
  await enqueue(tx, {
    orgId,
    kind: TASK_CHECK_JOB,
    payload: { consultationId, n },
    dedupeKey: `${TASK_CHECK_JOB}:${consultationId}:${n}`,
    runAt: new Date(Date.now() + DAY_MS),
  });
}

/**
 * The right hand's newest hand-over of the task whose conversation this is, found by that conversation (the index on
 * a hand-over's workspace and conversation). `since` is when the task was created: none is older than its task.
 */
async function handOverOf(db: Executor, orgId: string, conversationId: string, since: Date): Promise<HandOver | null> {
  const [row] = await db
    .select({ c: agentConsultations })
    .from(agentConsultations)
    .innerJoin(agents, and(eq(agents.orgId, agentConsultations.orgId), eq(agents.id, agentConsultations.askerAgentId)))
    .where(
      and(
        eq(agentConsultations.orgId, orgId),
        eq(agentConsultations.channelId, conversationId),
        eq(agentConsultations.kind, "note"),
        gte(agentConsultations.createdAt, since),
        eq(agents.builtin, RIGHT_HAND),
      ),
    )
    .orderBy(desc(agentConsultations.createdAt))
    .limit(1);
  return row?.c ?? null;
}

/**
 * With a task's change to done or canceled, in its transaction: the job that tells the right hand, only for a task it
 * handed over. Returns what the job reads, for a caller that tells it right away (`tellTaskEnd`).
 */
export async function queueTaskEnd(
  tx: Executor,
  issue: Pick<IssueRow, "id" | "orgId" | "status" | "createdAt" | "updatedAt" | "conversationChannelId">,
  by: TaskChangedBy,
): Promise<Record<string, unknown> | null> {
  if ((issue.status !== "done" && issue.status !== "canceled") || !issue.conversationChannelId) return null;
  if (!(await handOverOf(tx, issue.orgId, issue.conversationChannelId, issue.createdAt))) return null;
  const at = issue.updatedAt.getTime();
  const payload = { issueId: issue.id, to: issue.status, at, by };
  await enqueue(tx, {
    orgId: issue.orgId,
    kind: TASK_END_JOB,
    payload,
    dedupeKey: `${TASK_END_JOB}:${issue.orgId}:${issue.id}:${at}`,
    runAt: new Date(Date.now() + END_JOB_DELAY_MS),
  });
  return payload;
}

/**
 * Who a hand-over was for and whether the right hand may tell them about its task now. Null keeps it silent: it is not
 * the right hand's, the person left, turned this off, may no longer talk to it or no longer sees the task.
 */
async function tellable(db: Database, orgId: string, c: HandOver, issue: IssueRow) {
  const requester = await runPerson(db, orgId, c.askerRunId);
  if (!requester) return null;
  const lodi = await lodiFor(db, orgId, requester);
  if (!lodi || lodi.id !== c.askerAgentId) return null;
  const { prefs, dayTimezone } = await readLodiPrefs(db, orgId, requester);
  if (prefs.remindOff) return null;
  if (!(await canSee(db, { type: "person", userId: requester }, orgId, issue))) return null;
  return { lodi, requester, zone: dayTimezone };
}

/** One of the day's turns for this person, in their own day, while any is left. */
async function takeWake(tx: Executor, orgId: string, userId: string, zone: string) {
  const day = localDate(new Date(), zone);
  for (let n = 1; n <= HANDED_TASK_WAKES_A_DAY; n++)
    if (await saidOnce(tx, orgId, `right_hand.task_wake:${userId}:${day}:${n}`)) return true;
  return false;
}

/**
 * Tells the right hand about a handed task, once per `once`, in its DM with the person it was for: a notice only it
 * reads, which starts a turn there while the day has one left. The notice names the run that handed the task over, so
 * the turn is that person's: their permissions, and the AI that answers them in that DM. Null when it was already
 * said.
 */
async function tellLodi(
  deps: Deps,
  orgId: string,
  to: NonNullable<Awaited<ReturnType<typeof tellable>>>,
  once: string,
  notice: Notice,
) {
  const out = await deps.db.transaction(async (tx) => {
    if (!(await saidOnce(tx, orgId, once))) return null;
    const wake = await takeWake(tx, orgId, to.requester, to.zone);
    const dm = await openPersonAgentDm(tx, orgId, to.requester, to.lodi.id);
    const delivered = await deliverNotice(tx, {
      orgId,
      agentId: to.lodi.id,
      channelId: dm.id,
      threadId: null,
      hop: 0,
      stretchId: null,
      notice,
      // Without its @handles: the stored words never mention, and so never start, an agent.
      body: forPeople(notice),
      wake,
      trigger: "dm",
    });
    return { delivered, wake };
  });
  if (out) await publishDelivery(deps.pubsub, out.delivered).catch(() => {});
  return out;
}

const handleOf = async (db: Database, orgId: string, agentId: string) => {
  const [a] = await db
    .select({ handle: agents.handle })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  return a ? `@${a.handle}` : "an agent";
};

const personName = async (db: Database, userId: string) => {
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return u?.name || "a person";
};

/**
 * The person already knows of the change: they made it, they asked the run that made it in their own words (its
 * answer is theirs to read), the right hand made it for them, or it asked the agent that made it in a later turn of
 * theirs. The hand-over's own run is none of these: what it does after its report is news.
 */
async function knownToRequester(db: Database, orgId: string, by: TaskChangedBy, requester: string, c: HandOver) {
  if (by.type === "person") return by.id === requester;
  if (!by.runId) return false;
  const [asked] = await db
    .select({ person: messages.authorUserId, agent: messages.authorAgentId, inRun: messages.agentRunId })
    .from(agentRuns)
    .innerJoin(messages, and(eq(messages.orgId, agentRuns.orgId), eq(messages.id, agentRuns.triggerMessageId)))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, by.runId)));
  if (asked?.person === requester) return true;
  const lodiRun =
    by.id === c.askerAgentId
      ? by.runId
      : by.runId !== c.targetRunId && asked?.agent === c.askerAgentId
        ? asked.inRun
        : null;
  return (await humanBehindRun({ db }, orgId, lodiRun)) === requester;
}

/**
 * In SQL: the right hand holds the news that task `taskId` ended, in its DM `dm` with the person, since `since` (the
 * notice `tellTaskEnd` writes there). The day's card leaves such a task out, so one thing tells an end. Read by
 * conversation and time, never across every message.
 */
export const taskEndToldSql = (taskId: SQL, dm: SQL, since: string) => sql`exists (select 1 from messages tm
  where tm.channel_id = ${dm} and tm.created_at >= ${since}::timestamptz
    and tm.meta->'notice'->>'kind' = 'wait_result' and tm.meta->'notice'->'refs'->>'task' = ${taskId}::text
    and tm.meta->'notice'->'refs'->>'state' in ('done', 'canceled'))`;

/**
 * Job `right_hand.task_end`, and what a status change calls right after it: a task the right hand handed over ended
 * after its hand-over was reported back. Silent when the task changed status again since, the hand-over is still out
 * or closed after the change or just before it (its own report tells the end), or the person knows already. When a
 * turn starts, the inbox row of the same change is marked read for them: it rings nothing, so one thing tells them,
 * and it stays in their list, so a turn that fails or passes still leaves them the news. True when the right hand
 * was told.
 */
export async function tellTaskEnd(deps: Deps, orgId: string, payload: Record<string, unknown>): Promise<boolean> {
  const { db } = deps;
  const at = Number(payload.at);
  const by = payload.by as TaskChangedBy | undefined;
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.orgId, orgId), eq(issues.id, str(payload.issueId))));
  if (!issue?.conversationChannelId || issue.status !== payload.to || !by) return false;
  const c = await handOverOf(db, orgId, issue.conversationChannelId, issue.createdAt);
  if (!c || c.status === "open" || !c.answeredAt || c.answeredAt.getTime() + SAME_FINISH_MS > at) return false;
  const to = await tellable(db, orgId, c, issue);
  if (!to || (await knownToRequester(db, orgId, by, to.requester, c))) return false;
  const who = by.type === "person" ? await personName(db, by.id) : await handleOf(db, orgId, by.id);
  const told = await tellLodi(deps, orgId, to, `right_hand.task_end:${c.id}`, {
    kind: "wait_result",
    from: `Task #${issue.number}`,
    text: `${taskLabel(issue)}, which you handed to ${await handleOf(db, orgId, c.targetAgentId)} for them, ${
      issue.status === "done" ? "is now done" : "was canceled"
    }: ${who} marked it.`,
    refs: { task: issue.id, state: issue.status, runId: c.askerRunId, consultationId: c.id },
  });
  if (told?.wake) {
    const [row] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, to.requester),
          eq(notifications.groupKey, issueStatusGroup(issue.id, at)),
          isNull(notifications.doneAt),
          isNull(notifications.readAt),
        ),
      );
    if (row) await markNotificationRead(deps, to.requester, orgId, row.id, true);
  }
  return Boolean(told);
}

/** What a waiting inbox row asks of its person, in a few words. */
const WAITS: Record<string, string> = {
  approval: "an approval",
  agent_question: "an answer",
  secret_request: "a secret",
};

/**
 * What a task that stopped waits on, read from its own conversation: the people something there waits on, else its
 * agent's run paused on something else. Null when there is nothing to say: work goes on, the person it would be told
 * to is one of those it waits on (they have it in their inbox), its hand-over is still out and waits on no person
 * (what comes of it is reported by itself), or its hand-over was reported back and nothing there is paused (the
 * person heard that report, and a task left open after it waits on them).
 */
async function waitsOn(
  db: Database,
  issue: Pick<IssueRow, "orgId" | "conversationRootId"> & { conversationChannelId: string },
  requester: string,
  out: boolean,
) {
  // Reads the workspace's open inbox rows to find the conversation's: no index leads to a row by its source's
  // channel. Fine for one look a day per handed task, not for anything asked more often.
  const asked = await db
    .select({ userId: notifications.userId, kind: notifications.kind, name: users.name })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(
      and(
        eq(notifications.orgId, issue.orgId),
        isNull(notifications.doneAt),
        eq(notifications.waiting, true),
        sql`${notifications.source}->>'channelId' = ${issue.conversationChannelId}`,
      ),
    )
    .limit(20);
  if (asked.some((a) => a.userId === requester)) return null;
  if (asked.length > 0) {
    const people = [...new Map(asked.map((a) => [a.userId, a])).values()].slice(0, 5);
    return `It waits on ${people.map((p) => `${p.name || "a person"} (${WAITS[p.kind] ?? "something asked there"})`).join(", ")}.`;
  }
  if (out) return null;
  // Every run in a task's conversation is in its one thread.
  const [run] = issue.conversationRootId
    ? await db
        .select({ agentId: agentRuns.agentId, status: agentRuns.status })
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, issue.orgId), eq(agentRuns.threadRootId, issue.conversationRootId)))
        .orderBy(desc(agentRuns.createdAt))
        .limit(1)
    : [];
  if (run?.status !== "waiting_approval" && run?.status !== "waiting_input") return null;
  return `${await handleOf(db, issue.orgId, run.agentId)}'s run there is paused and nobody has what it waits on in their inbox: it may be its computer, its AI or its budget (team_status says which).`;
}

/**
 * Job `right_hand.task_check`: a look at a task the right hand handed over, a day after the hand-over or the last look.
 * Ended: nothing (its end is told by `tellTaskEnd`). Moving, or stopped with nothing to say (`waitsOn`): one more look
 * tomorrow, `HANDED_TASK_LOOKS` in all. Stopped on someone or something the person was not told of: the right hand is
 * told once per task what it waits on, and the looks end. A hand-over that failed or was never taken was told when it
 * closed, so it is not said again. It may run twice (`saidOnce` inside `tellLodi`) and calls no model.
 */
export async function checkHandedTask(deps: Deps, orgId: string, payload: Record<string, unknown>): Promise<void> {
  const { db } = deps;
  const n = Number(payload.n) || 1;
  const [c] = await db
    .select()
    .from(agentConsultations)
    .where(and(eq(agentConsultations.orgId, orgId), eq(agentConsultations.id, str(payload.consultationId))));
  if (!c || c.status === "failed" || c.status === "expired") return;
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.orgId, orgId), eq(issues.conversationChannelId, c.channelId)));
  if (!issue || issue.status === "done" || issue.status === "canceled") return;
  const to = await tellable(db, orgId, c, issue);
  if (!to) return;
  const [last] = await db
    .select({ at: sql<Date | string | null>`max(${messages.createdAt})` })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.channelId, c.channelId)));
  const moved = Math.max(issue.updatedAt.getTime(), last?.at ? new Date(last.at).getTime() : 0);
  const waits =
    Date.now() - moved < HANDED_TASK_QUIET_MS
      ? null
      : await waitsOn(db, { ...issue, conversationChannelId: c.channelId }, to.requester, c.status === "open");
  if (!waits) {
    await queueTaskCheck(db, orgId, c.id, n + 1);
    return;
  }
  const since = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  await tellLodi(deps, orgId, to, `right_hand.task_stuck:${issue.id}`, {
    kind: "wait_result",
    from: `Task #${issue.number}`,
    text: `${taskLabel(issue)}, which you handed to ${await handleOf(db, orgId, c.targetAgentId)} for them on ${since(c.createdAt.getTime())}, is not finished (${issue.status}) and has not moved since ${since(moved)}. ${waits}`,
    refs: { task: issue.id, state: "stuck", runId: c.askerRunId, consultationId: c.id },
  });
}

/**
 * The right hand's prompt in its DM with this person: when it sets a reminder by itself, and the ones waiting there.
 * "" when they turned reminders off.
 */
export async function keepingWordBlock(db: Database, ctx: LodiPromptContext): Promise<string> {
  if ((await readLodiPrefs(db, ctx.orgId, ctx.personId)).prefs.remindOff) return "";
  const waiting = await db
    .select({
      id: routines.id,
      text: routines.prompt,
      at: routines.nextRunAt,
      timezone: routines.timezone,
      plain: sql<boolean>`coalesce(${routines.target}->>'reminder' = 'true', false)`,
    })
    .from(routines)
    .innerJoin(
      channels,
      and(
        eq(channels.orgId, routines.orgId),
        eq(channels.dmKey, personAgentDmKey(ctx.personId, ctx.agentId)),
        sql`${routines.target}->>'channelId' = ${channels.id}::text`,
      ),
    )
    .where(
      and(
        eq(routines.orgId, ctx.orgId),
        eq(routines.agentId, ctx.agentId),
        eq(routines.createdByUserId, ctx.personId),
        eq(routines.triggerType, "once"),
        eq(routines.active, true),
        isNull(routines.deletedAt),
        isNotNull(routines.nextRunAt),
      ),
    )
    .orderBy(routines.nextRunAt)
    .limit(10);
  const full = waiting.filter((r) => r.plain).length >= KEPT_REMINDERS_MAX;
  return [
    "# Keeping your word",
    'When they or you agree on something with a time in this conversation ("I\'ll send it Friday", "vou te mandar até sexta", "remind me tomorrow"), set one schedule_reminder for that time, with `message` in their words and language, and say so in one line. Don\'t ask whether to set it. Leave ask_agent out: at its time the reminder posts those words to them, and nothing runs.',
    'Set ask_agent only when they asked you to do something at that time ("check the numbers on Monday"). Your own promise to come back within a day is a follow_up.',
    'Never for a vague intention ("someday", "I should", "let\'s see") or with no time said. One reminder per thing agreed: check the list below first.',
    "When what was agreed is done or dropped before its time, cancel its reminder (cancel_reminder with its id) without a word about it.",
    full
      ? `${KEPT_REMINDERS_MAX} reminders already wait here: set no more by yourself until one comes or is canceled. One they ask for in words is still theirs.`
      : `At most ${KEPT_REMINDERS_MAX} reminders you set by yourself wait here at once.`,
    waiting.length
      ? `Reminders waiting here:\n${waiting
          .map(
            (r) =>
              `- ${r.id}: "${cutText(plainLine(r.text), 120)}" at ${r.at?.toISOString()} (${r.timezone ?? "UTC"})${r.plain ? "" : ", you act then"}`,
          )
          .join("\n")}`
      : "No reminder waits here.",
  ].join("\n");
}

export const followLane = defineLodiLane({
  switch: "reminders",
  live: true,
  jobs: { [TASK_CHECK_JOB]: checkHandedTask, [TASK_END_JOB]: tellTaskEnd },
  promptBlock: keepingWordBlock,
});
