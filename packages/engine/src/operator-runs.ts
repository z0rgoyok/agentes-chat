import {
  and,
  arrayOverlaps,
  asc,
  count,
  type Database,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { z } from "zod";
import { audienceSql } from "./audience";
import { decodeCursor, encodeCursor } from "./cursor";
import { ValidationError } from "./errors";
import { cutText, stringsOf } from "./format";
import { PLATFORM_CAP } from "./limits";
import { machineOnline } from "./machines";
import { type Message, parseMentionHandles, receiptsFor } from "./messages";
import { jobOf, jobsOfRun, OPERATOR_JOB_ERROR_MAX, selectJobs, spentColumns, spentOf } from "./operator-jobs";
import {
  CODE,
  codeOf,
  errorText,
  ms,
  olderThan,
  orgExists,
  type PageQuery,
  pageOf,
  UuidCursor,
  uuidOf,
} from "./operator-paging";
import { rightHandReaches } from "./right-hand";
import {
  computerWaitSql,
  KEPT_ON_HOLD,
  NO_AI,
  outageParkedSql,
  passedSql,
  type RunStatus,
  runErrorDetail,
  usageWaitSql,
} from "./runs";
import { type BillingHold, isBillingHold, workRefusal } from "./standing";
import { monthStartUtc, orgDefaultAgentBudget } from "./usage";

/**
 * Runs and conversations for the operator API (ADR 0056): what an agent's run did and why a message did or did not
 * start one. Ids, codes, times and sizes: never what a message says, what a tool was given or answered, a prompt or
 * a transcript. Every field is picked by name, and nothing here writes, because a caller holding only the read
 * token reaches all of it.
 */

const {
  agentBudgetPeriods,
  agentQuestions,
  agentRuns,
  agentRunSteps,
  agents,
  approvals,
  channelMembers,
  channels,
  machines,
  messages,
  organizationMembers,
  organizations,
  outbox,
  routingDecisions,
  secretRequests,
  usageRecords,
} = schema;

/** How much of a run's stored error an answer carries. */
export const OPERATOR_RUN_ERROR_MAX = 500;

/** A time a JSON column holds, when it is one (`codeOf`, `uuidOf`: the same rule). */
function timeOf(v: unknown) {
  const at = typeof v === "string" ? new Date(v) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}
/** A JSON array of names computed in SQL: some drivers hand it over as text. */
const namesOf = (v: unknown) => stringsOf(typeof v === "string" ? JSON.parse(v) : v).filter((k) => CODE.test(k));

// In a select list over one table drizzle writes columns without their table, so in a subquery a bare
// "id" would be the subquery's own: the outer row is named in full.
const RUN_ID = sql.raw(`"agent_runs"."id"`);
const AGENT_ID = sql.raw(`"agents"."id"`);
const STEP = sql.raw(`"agent_run_steps"`);

// ── Runs ─────────────────────────────────────────────────────────────────────

/** A run's status as people read it: what it waits for, or that it ended without a reply. */
export const OPERATOR_RUN_SHOWN = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "waiting_computer",
  "waiting_line",
  "waiting_plan",
  "waiting_budget",
  "waiting_outage",
  "done",
  "no_reply",
  "failed",
  "canceled",
] as const;

const shown = sql<(typeof OPERATOR_RUN_SHOWN)[number]>`(case when ${passedSql} then 'no_reply'
  when ${computerWaitSql} = 'line' then 'waiting_line'
  when ${computerWaitSql} is not null then 'waiting_computer'
  when ${usageWaitSql} = 'budget' then 'waiting_budget'
  when ${usageWaitSql} is not null then 'waiting_plan'
  when ${outageParkedSql} then 'waiting_outage'
  else ${agentRuns.status}::text end)`;

const WAIT = sql`${agentRuns.transcript}->'waitingForBrain'`;

const runColumns = {
  id: agentRuns.id,
  orgId: agentRuns.orgId,
  agentId: agentRuns.agentId,
  channelId: agentRuns.channelId,
  threadRootId: agentRuns.threadRootId,
  triggerMessageId: agentRuns.triggerMessageId,
  replyMessageId: agentRuns.replyMessageId,
  trigger: agentRuns.trigger,
  hop: agentRuns.hop,
  background: agentRuns.background,
  brain: agentRuns.brain,
  model: sql<string | null>`(select s.data->>'model' from ${agentRunSteps} s
    where s.run_id = ${RUN_ID} and s.kind = 'model_call' order by s.seq desc limit 1)`,
  turns: agentRuns.turns,
  status: agentRuns.status,
  shown,
  waitCode: sql<string | null>`coalesce(${WAIT}->>'code', case when ${outageParkedSql} then 'provider_outage' end)`,
  waitSource: sql<string | null>`${WAIT}->>'source'`,
  waitResetsAt: sql<string | null>`${WAIT}->>'resetsAt'`,
  waitingMachineId: agentRuns.waitingMachineId,
  error: agentRuns.error,
  createdAt: ms(agentRuns.createdAt),
  startedAt: agentRuns.startedAt,
  finishedAt: agentRuns.finishedAt,
  heartbeatAt: agentRuns.heartbeatAt,
};

const selectRuns = (db: Database) => db.select(runColumns).from(agentRuns);
type RunRow = Awaited<ReturnType<typeof selectRuns>>[number];

/**
 * The first `limit` runs matching `where`, oldest or newest first. Their ids are found first: a run's row is worked
 * out from its stored transcript (what it waits for), and a sort computes the columns of every row it is given before
 * it keeps a page of them. A transcript is the run's whole conversation: only the page's are read.
 */
async function runsInOrder(db: Database, where: SQL | undefined, order: typeof asc, limit: number) {
  const page = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(where)
    .orderBy(order(runColumns.createdAt), order(agentRuns.id))
    .limit(limit);
  if (page.length === 0) return [];
  const rows = await selectRuns(db).where(
    inArray(
      agentRuns.id,
      page.map((r) => r.id),
    ),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return page.flatMap(({ id }) => byId.get(id) ?? []);
}

const errorCodeOf = (error: string | null) => runErrorDetail(error)?.errorCode ?? null;

function runOf({ error, model, waitCode, waitSource, waitResetsAt, ...run }: RunRow) {
  return {
    ...run,
    model: codeOf(model),
    waitCode: codeOf(waitCode),
    waitSource: codeOf(waitSource),
    waitResetsAt: timeOf(waitResetsAt),
    errorCode: errorCodeOf(error),
    error: errorText(error, OPERATOR_RUN_ERROR_MAX),
  };
}

export type OperatorRun = ReturnType<typeof runOf>;

interface RunFilters {
  agentId?: string;
  channelId?: string;
  threadRootId?: string;
  /** As stored. */
  status?: RunStatus;
  /** Created at or after. */
  from?: Date;
  /** Created before. */
  to?: Date;
}

export interface OperatorRunQuery extends RunFilters, PageQuery {
  /** The app's code of the stored error (`run.no_ai`, `run.provider_rate_limit`…), as each row says it. */
  errorCode?: string;
}

const runsIn = (orgId: string, q: RunFilters) =>
  and(
    eq(agentRuns.orgId, orgId),
    q.agentId ? eq(agentRuns.agentId, q.agentId) : undefined,
    q.channelId ? eq(agentRuns.channelId, q.channelId) : undefined,
    q.threadRootId ? eq(agentRuns.threadRootId, q.threadRootId) : undefined,
    q.status ? eq(agentRuns.status, q.status) : undefined,
    q.from ? gte(agentRuns.createdAt, q.from) : undefined,
    q.to ? lt(agentRuns.createdAt, q.to) : undefined,
  );

/** How many different stored errors a count by error reads, most frequent first. */
export const OPERATOR_RUN_ERROR_TEXTS = 2000;

/**
 * The stored errors of the runs matching `where`, with how many runs hold each. A run's code is worked out from its
 * text in code (`runErrorDetail`), so counting and filtering by code both start from the distinct texts.
 */
async function errorTexts(db: Database, where: SQL | undefined) {
  const rows = await db
    .select({
      error: sql<string>`${agentRuns.error}`,
      runs: count(),
      firstAt: sql<Date>`min(${agentRuns.createdAt})`.mapWith((v: string | Date) => new Date(v)),
      lastAt: sql<Date>`max(${agentRuns.createdAt})`.mapWith((v: string | Date) => new Date(v)),
    })
    .from(agentRuns)
    .where(and(where, isNotNull(agentRuns.error)))
    .groupBy(agentRuns.error)
    .orderBy(desc(count()), asc(agentRuns.error))
    .limit(OPERATOR_RUN_ERROR_TEXTS + 1);
  return { texts: rows.slice(0, OPERATOR_RUN_ERROR_TEXTS), more: rows.length > OPERATOR_RUN_ERROR_TEXTS };
}

/**
 * A workspace's runs, newest first, in keyset pages: each with its status as stored and as people read it, what it
 * waits for, and its error as a code and its first characters. Null: no such workspace.
 */
export async function operatorRuns(db: Database, orgId: string, query: OperatorRunQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  if (!(await orgExists(db, orgId))) return null;
  const where = runsIn(orgId, query);
  let errors: string[] | null = null;
  if (query.errorCode) {
    // ponytail: past OPERATOR_RUN_ERROR_TEXTS different texts in the range the rarest are missed; a stored code
    // column on the run would make this one indexed filter.
    const found = await errorTexts(db, where);
    errors = found.texts.filter((e) => errorCodeOf(e.error) === query.errorCode).map((e) => e.error);
    if (errors.length === 0) return { runs: [], next: null };
  }
  const rows = await runsInOrder(
    db,
    and(
      where,
      errors ? inArray(agentRuns.error, errors) : undefined,
      after
        ? sql`(${runColumns.createdAt}, ${agentRuns.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
        : undefined,
    ),
    desc,
    query.limit + 1,
  );
  const page = pageOf(rows, query.limit, (r) => [r.createdAt, r.id]);
  return { runs: page.items.map(runOf), next: page.next };
}

/** How far back a count by error looks when no start is given. */
export const OPERATOR_RUN_ERRORS_DAYS = 7;

/**
 * How many of a workspace's runs ended with each error code in a range of dates, most frequent first, with the first
 * and the last time each was seen. Null: no such workspace.
 */
export async function operatorRunErrors(db: Database, orgId: string, query: RunFilters & { errorCode?: string }) {
  if (!(await orgExists(db, orgId))) return null;
  const to = query.to ?? new Date();
  const from = query.from ?? new Date(to.getTime() - OPERATOR_RUN_ERRORS_DAYS * 86_400_000);
  const { texts, more } = await errorTexts(db, runsIn(orgId, { ...query, from, to }));
  const byCode = new Map<string, { errorCode: string; runs: number; firstAt: Date; lastAt: Date }>();
  for (const e of texts) {
    const errorCode = errorCodeOf(e.error);
    if (!errorCode || (query.errorCode && errorCode !== query.errorCode)) continue;
    const seen = byCode.get(errorCode);
    if (!seen) byCode.set(errorCode, { errorCode, runs: e.runs, firstAt: e.firstAt, lastAt: e.lastAt });
    else {
      seen.runs += e.runs;
      if (e.firstAt < seen.firstAt) seen.firstAt = e.firstAt;
      if (e.lastAt > seen.lastAt) seen.lastAt = e.lastAt;
    }
  }
  const errors = [...byCode.values()].sort((a, b) => b.runs - a.runs || a.errorCode.localeCompare(b.errorCode));
  return { from, to, errors, more };
}

// ── What an agent asked of people ────────────────────────────────────────────

/** Every table an agent's ask to a person lives in has these columns. */
type AskTable = typeof approvals | typeof agentQuestions | typeof secretRequests;

/**
 * Approvals, questions and requests for a secret matching `where`, at most `limit` of each, oldest first: what kind,
 * its state and its times. Never an approval's title or parameters, a question's text or answer, nor what a secret
 * is for.
 */
async function asksWhere(db: Database, where: (t: AskTable, at: SQL<Date>) => SQL | undefined, limit: number) {
  const approvalAt = ms(approvals.createdAt);
  const questionAt = ms(agentQuestions.createdAt);
  const secretAt = ms(secretRequests.createdAt);
  const [asked, questions, secrets] = await Promise.all([
    db
      .select({
        id: approvals.id,
        runId: approvals.runId,
        agentId: approvals.agentId,
        threadRootId: sql<string | null>`${approvals.threadRootId}`,
        tool: sql<string | null>`${approvals.tool}`,
        status: sql<string>`${approvals.status}::text`,
        createdAt: approvalAt,
        expiresAt: approvals.expiresAt,
        resolvedAt: approvals.decidedAt,
        byUserId: approvals.decidedByUserId,
      })
      .from(approvals)
      .where(where(approvals, approvalAt))
      .orderBy(asc(approvalAt), asc(approvals.id))
      .limit(limit),
    db
      .select({
        id: agentQuestions.id,
        runId: sql<string | null>`${agentQuestions.runId}`,
        agentId: agentQuestions.agentId,
        threadRootId: agentQuestions.threadId,
        tool: sql<string | null>`null`,
        status: sql<string>`${agentQuestions.status}::text`,
        createdAt: questionAt,
        expiresAt: agentQuestions.expiresAt,
        resolvedAt: agentQuestions.answeredAt,
        byUserId: agentQuestions.answeredByUserId,
      })
      .from(agentQuestions)
      .where(where(agentQuestions, questionAt))
      .orderBy(asc(questionAt), asc(agentQuestions.id))
      .limit(limit),
    db
      .select({
        id: secretRequests.id,
        runId: sql<string | null>`${secretRequests.runId}`,
        agentId: secretRequests.agentId,
        threadRootId: secretRequests.threadId,
        tool: sql<string | null>`null`,
        status: sql<string>`${secretRequests.status}::text`,
        createdAt: secretAt,
        expiresAt: secretRequests.expiresAt,
        resolvedAt: secretRequests.deliveredAt,
        byUserId: sql<string | null>`null`,
      })
      .from(secretRequests)
      .where(where(secretRequests, secretAt))
      .orderBy(asc(secretAt), asc(secretRequests.id))
      .limit(limit),
  ]);
  return [
    ...asked.map((a) => ({ kind: "approval" as const, ...a, tool: codeOf(a.tool) })),
    ...questions.map((q) => ({ kind: "question" as const, ...q })),
    ...secrets.map((r) => ({ kind: "secret" as const, ...r })),
  ];
}

/** Oldest first, then by id the way the database orders them. */
const inOrder = (a: [Date, string], b: [Date, string]) =>
  a[0].getTime() - b[0].getTime() || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

// ── One run ──────────────────────────────────────────────────────────────────

/** How many of a run's jobs, and of each kind of ask, its trace lists. */
export const OPERATOR_TRACE_JOBS = 100;
export const OPERATOR_TRACE_ASKS = 100;

const DATA = agentRunSteps.data;
const KIND = agentRunSteps.kind;

/** A tool call's step says its tool is the server's own (the Tool Gateway's mark): absent, it isn't known to be. */
const builtInSql = (data: SQL) => sql<boolean>`coalesce(${data}->'builtIn' = 'true'::jsonb, false)`;

// Each fact is read only from the kind of step that writes it: on another kind the same name may hold text.
const stepColumns = {
  seq: agentRunSteps.seq,
  kind: KIND,
  at: agentRunSteps.createdAt,
  toolUseId: sql<string | null>`case when ${KIND} in ('tool_call', 'tool_result') then ${DATA}->>'toolUseId' end`,
  tool: sql<string | null>`case when ${KIND} in ('tool_call', 'tool_result') then ${DATA}->>'name' end`,
  // Only the call's step holds the mark: a result reads it from the call it answers.
  builtIn: sql<boolean | null>`case when ${KIND} = 'tool_call' then ${builtInSql(sql`${DATA}`)}
    when ${KIND} = 'tool_result' then coalesce((select ${builtInSql(sql`c.data`)} from ${agentRunSteps} c
      where c.run_id = ${STEP}.run_id and c.kind = 'tool_call' and c.seq < ${STEP}.seq
        and c.data->>'toolUseId' = ${STEP}.data->>'toolUseId'
      order by c.seq desc limit 1), false) end`,
  connector: sql<string | null>`case when ${KIND} = 'tool_call' then ${DATA}->>'connector' end`,
  isError: sql<
    boolean | null
  >`case when ${KIND} = 'tool_result' then coalesce(${DATA}->'isError' = 'true'::jsonb, false) end`,
  refusal: sql<string | null>`case when ${KIND} = 'tool_result' then ${DATA}->'data'->>'refusal' end`,
  code: sql<string | null>`case when ${KIND} = 'error' then ${DATA}->>'code'
    when ${KIND} = 'tool_result' then ${DATA}->'data'->>'code' end`,
  reason: sql<string | null>`case when ${KIND} = 'error' then ${DATA}->>'reason' end`,
  model: sql<string | null>`case when ${KIND} = 'model_call' then ${DATA}->>'model' end`,
  stopReason: sql<string | null>`case when ${KIND} = 'model_call' then ${DATA}->>'stopReason' end`,
  // Sizes are measured in the database: the text itself is never read out.
  chars: sql<number | null>`case when ${KIND} = 'tool_call' then length(${DATA}->>'input')
    when ${KIND} = 'tool_result' then length(${DATA}->>'content') end`.mapWith(Number),
  messageId: sql<string | null>`case when ${KIND} = 'message' then ${DATA}->>'messageId' end`,
  records: sql<string[] | null>`case when ${KIND} = 'context'
    then (select jsonb_agg(k) from jsonb_object_keys(${DATA}) k) end`.mapWith(namesOf),
};

/**
 * One run, start to end: its row, its steps in order (which tool, whether it failed, how big its input and its
 * result were, never either of them), what it asked of people, the jobs that started and woke it, what it spent and
 * the computer it is tied to. `beforeSeq` pages back from the end, `limit` steps at a time. Null: no such run.
 */
export async function operatorRunTrace(db: Database, runId: string, query: { limit: number; beforeSeq?: number }) {
  const [run] = await selectRuns(db).where(eq(agentRuns.id, runId));
  if (!run) return null;
  // No index is on the run: the agent's rows since it began are (org, agent, created_at).
  const spent = and(
    eq(usageRecords.orgId, run.orgId),
    eq(usageRecords.agentId, run.agentId),
    gte(usageRecords.createdAt, run.createdAt),
    eq(usageRecords.runId, runId),
  );
  const [steps, counted, asks, jobs, usage, ranOn, agent] = await Promise.all([
    db
      .select(stepColumns)
      .from(agentRunSteps)
      .where(and(eq(agentRunSteps.runId, runId), query.beforeSeq ? lt(agentRunSteps.seq, query.beforeSeq) : undefined))
      .orderBy(desc(agentRunSteps.seq))
      .limit(query.limit),
    db.select({ steps: count() }).from(agentRunSteps).where(eq(agentRunSteps.runId, runId)),
    asksWhere(db, (t) => sql`${t.runId} = ${runId}::uuid`, OPERATOR_TRACE_ASKS),
    selectJobs(db)
      .where(jobsOfRun(runId))
      .orderBy(desc(outbox.createdAt), desc(outbox.id))
      .limit(OPERATOR_TRACE_JOBS + 1),
    db
      .select({
        provider: usageRecords.provider,
        model: usageRecords.model,
        billedTo: usageRecords.billedTo,
        ...spentColumns,
      })
      .from(usageRecords)
      .where(spent)
      .groupBy(usageRecords.provider, usageRecords.model, usageRecords.billedTo)
      .orderBy(asc(usageRecords.provider), asc(usageRecords.model), asc(usageRecords.billedTo))
      .limit(50),
    db
      .select({ machineId: usageRecords.machineId })
      .from(usageRecords)
      .where(and(spent, isNotNull(usageRecords.machineId)))
      .orderBy(desc(usageRecords.createdAt))
      .limit(1),
    db.select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, run.agentId)),
  ]);

  // The run's row doesn't say where it ran: the computer it waits for, else the one its plan's usage names,
  // else its agent's now.
  const tied = run.waitingMachineId
    ? { from: "waiting" as const, id: run.waitingMachineId }
    : ranOn[0]?.machineId
      ? { from: "usage" as const, id: ranOn[0].machineId }
      : agent[0]?.machineId
        ? { from: "agent" as const, id: agent[0].machineId }
        : null;
  const [computer] = tied
    ? await db
        .select({
          id: machines.id,
          name: machines.name,
          kind: machines.kind,
          online: machines.online,
          lastSeenAt: machines.lastSeenAt,
          deletedAt: machines.deletedAt,
        })
        .from(machines)
        .where(and(eq(machines.orgId, run.orgId), eq(machines.id, tied.id)))
    : [];

  const called = new Map<string, Date>();
  const trail = steps.reverse().map(({ toolUseId, ...s }) => {
    if (s.kind === "tool_call" && toolUseId) called.set(toolUseId, s.at);
    const since = s.kind === "tool_result" && toolUseId ? called.get(toolUseId) : undefined;
    return {
      ...s,
      tool: codeOf(s.tool),
      connector: s.connector ? cutText(s.connector, 100) : null,
      refusal: codeOf(s.refusal),
      code: codeOf(s.code),
      reason: codeOf(s.reason),
      model: codeOf(s.model),
      stopReason: codeOf(s.stopReason),
      durationMs: since ? s.at.getTime() - since.getTime() : null,
      messageId: uuidOf(s.messageId),
      records: s.records ?? [],
    };
  });
  const sumOf = (field: keyof typeof spentColumns) => usage.reduce((n, u) => n + u[field], 0);
  return {
    run: runOf(run),
    steps: trail,
    stepCount: counted[0]?.steps ?? 0,
    asks: asks.sort((a, b) => inOrder([a.createdAt, a.id], [b.createdAt, b.id])),
    jobs: jobs.slice(0, OPERATOR_TRACE_JOBS).map(jobOf),
    moreJobs: jobs.length > OPERATOR_TRACE_JOBS,
    usage: {
      ...spentOf({
        calls: sumOf("calls"),
        input: sumOf("input"),
        output: sumOf("output"),
        cacheRead: sumOf("cacheRead"),
        cacheWrite: sumOf("cacheWrite"),
        costNanoUsd: sumOf("costNanoUsd"),
      }),
      byModel: usage.map(spentOf),
    },
    machine:
      tied && computer
        ? {
            id: computer.id,
            name: computer.name,
            kind: computer.kind,
            online: machineOnline(computer),
            lastSeenAt: computer.lastSeenAt,
            from: tied.from,
          }
        : null,
  };
}

// ── A workspace's tool calls ─────────────────────────────────────────────────

export const OPERATOR_TOOL_OUTCOMES = ["ok", "error", "refused", "pending"] as const;
type ToolOutcome = (typeof OPERATOR_TOOL_OUTCOMES)[number];
export const OPERATOR_TOOL_CALL_GROUPS = ["tool", "agent", "outcome"] as const;

/** How far back tool calls are read when no start is given, and the longest stretch one read covers. */
export const OPERATOR_TOOL_CALL_DAYS = 7;
export const OPERATOR_TOOL_CALL_MAX_DAYS = 31;

// A call's result: the first step after it, in its run, that answers its id.
// ponytail: every call in the range is paired with its result before a page or a count is kept. A call's outcome
// stored on its own step (a write in the Tool Gateway when the result lands) lets a page read only its own rows.
const RESULT = sql`(select r.created_at, r.data from ${agentRunSteps} r
  where r.run_id = ${STEP}.run_id and r.kind = 'tool_result' and r.seq > ${STEP}.seq
    and r.data->>'toolUseId' = ${STEP}.data->>'toolUseId'
  order by r.seq limit 1) res`;
const OUTCOME = sql<ToolOutcome>`(case when res.data is null then 'pending'
  when res.data->'data'->>'refusal' is not null then 'refused'
  when res.data->'isError' = 'true'::jsonb then 'error' else 'ok' end)`;
const BUILT_IN = builtInSql(sql`${DATA}`);
const TOOL_NAME = sql<string | null>`${DATA}->>'name'`;

// Never `input` nor a result's `content`: how long each is, measured in the database.
const toolCallColumns = {
  id: agentRunSteps.id,
  at: ms(agentRunSteps.createdAt),
  runId: agentRunSteps.runId,
  agentId: agentRuns.agentId,
  seq: agentRunSteps.seq,
  tool: TOOL_NAME,
  builtIn: BUILT_IN,
  connector: sql<string | null>`${DATA}->>'connector'`,
  connectorKind: sql<string | null>`${DATA}->>'service'`,
  outcome: OUTCOME,
  refusal: sql<string | null>`res.data->'data'->>'refusal'`,
  code: sql<string | null>`res.data->'data'->>'code'`,
  // A null never reaches a decoder: the type says it may still come back.
  resultAt: ms(sql`res.created_at`) as SQL<Date | null>,
  inputChars: sql<number>`coalesce(length(${DATA}->>'input'), 0)`.mapWith(Number),
  resultChars: sql<number | null>`length(res.data->>'content')`.mapWith(Number),
};

const TOOL_CALL_GROUPS: Record<(typeof OPERATOR_TOOL_CALL_GROUPS)[number], SQL<string | null>> = {
  tool: TOOL_NAME,
  agent: sql`${agentRuns.agentId}::text`,
  outcome: OUTCOME,
};

interface ToolCallFilters {
  agentId?: string;
  runId?: string;
  /** Part of the tool's name; any case, matched literally. */
  tool?: string;
  outcome?: ToolOutcome;
  /** Called at or after. */
  from?: Date;
  /** Called before. */
  to?: Date;
}

export interface OperatorToolCallQuery extends ToolCallFilters, PageQuery {}

/** The dates a read of tool calls covers and the calls in them; null: no such workspace, or run in it. */
async function toolCallsIn(db: Database, orgId: string, q: ToolCallFilters, now: Date) {
  let began: Date | null = null;
  if (q.runId) {
    const [run] = await db
      .select({ createdAt: agentRuns.createdAt })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, q.runId)));
    if (!run) return null;
    began = run.createdAt;
  } else if (!(await orgExists(db, orgId))) return null;

  const to = q.to ?? now;
  const from = q.from ?? began ?? new Date(to.getTime() - OPERATOR_TOOL_CALL_DAYS * 86_400_000);
  if (from >= to) throw new ValidationError("from must be before to");
  // One run's steps are few however long ago it began; any other read is held to the range.
  if (!began && to.getTime() - from.getTime() > OPERATOR_TOOL_CALL_MAX_DAYS * 86_400_000)
    throw new ValidationError(`from and to are ${OPERATOR_TOOL_CALL_MAX_DAYS} days apart at most`);

  const where = and(
    eq(agentRuns.orgId, orgId),
    eq(KIND, "tool_call"),
    gte(agentRunSteps.createdAt, from),
    lt(agentRunSteps.createdAt, to),
    // No index is on a step's time. A call is recorded only while its run is at work (its own turn, or the bridge,
    // which refuses a run in any other state), so the workspace's runs at work in the range hold every call in it:
    // only their steps are read. The minute is for a call in flight when its run was stopped.
    lt(agentRuns.createdAt, to),
    or(isNull(agentRuns.finishedAt), gte(agentRuns.finishedAt, new Date(from.getTime() - 60_000))),
    q.runId ? eq(agentRunSteps.runId, q.runId) : undefined,
    q.agentId ? eq(agentRuns.agentId, q.agentId) : undefined,
    q.tool ? sql`strpos(lower(${TOOL_NAME}), lower(${q.tool}::text)) > 0` : undefined,
    q.outcome ? sql`${OUTCOME} = ${q.outcome}` : undefined,
  );
  return { from, to, where };
}

/**
 * The tools a workspace's agents called in a range of dates, newest first, in keyset pages: which tool, whether it
 * is the server's own or a connected app's, how the call ended and how long it took, with how long its input and
 * its result are, never either of them. The range is the last 7 days unless said, one run's from when it began.
 * Null: no such workspace, or no such run in it.
 */
export async function operatorToolCalls(db: Database, orgId: string, query: OperatorToolCallQuery, now = new Date()) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  const found = await toolCallsIn(db, orgId, query, now);
  if (!found) return null;
  const rows = await db
    .select(toolCallColumns)
    .from(agentRunSteps)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunSteps.runId))
    .leftJoinLateral(RESULT, sql`true`)
    .where(
      and(
        found.where,
        after
          ? sql`(${toolCallColumns.at}, ${agentRunSteps.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(toolCallColumns.at), desc(agentRunSteps.id))
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (r) => [r.at, r.id]);
  return {
    from: found.from,
    to: found.to,
    calls: page.items.map(({ id, resultAt, ...call }) => ({
      ...call,
      tool: codeOf(call.tool),
      connector: call.connector ? cutText(call.connector, 100) : null,
      connectorKind: codeOf(call.connectorKind),
      refusal: codeOf(call.refusal),
      code: codeOf(call.code),
      durationMs: resultAt ? resultAt.getTime() - call.at.getTime() : null,
    })),
    next: page.next,
  };
}

/**
 * How many tool calls a workspace's agents made in a range of dates, by tool, by agent or by how they ended, most
 * calls first, with how many of each failed and were refused. Null: no such workspace, or no such run in it.
 */
export async function operatorToolCallCounts(
  db: Database,
  orgId: string,
  query: ToolCallFilters & { groupBy: (typeof OPERATOR_TOOL_CALL_GROUPS)[number]; limit: number },
  now = new Date(),
) {
  const found = await toolCallsIn(db, orgId, query, now);
  if (!found) return null;
  const group = TOOL_CALL_GROUPS[query.groupBy];
  const ended = (outcome: ToolOutcome) => sql<number>`count(*) filter (where ${OUTCOME} = ${outcome})`.mapWith(Number);
  const rows = await db
    .select({
      group,
      // A name is the server's own when any call of it was: the same word names the same tool.
      builtIn: sql<boolean>`bool_or(${BUILT_IN})`,
      calls: count(),
      errors: ended("error"),
      refused: ended("refused"),
      pending: ended("pending"),
    })
    .from(agentRunSteps)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunSteps.runId))
    .leftJoinLateral(RESULT, sql`true`)
    .where(found.where)
    .groupBy(group)
    .orderBy(desc(count()), asc(group))
    .limit(query.limit + 1);
  return {
    from: found.from,
    to: found.to,
    groups: rows.slice(0, query.limit).map(({ builtIn, ...g }) => ({
      ...g,
      group: query.groupBy === "agent" ? uuidOf(g.group) : codeOf(g.group),
      builtIn: query.groupBy === "tool" ? builtIn : null,
    })),
    more: rows.length > query.limit,
  };
}

// ── A conversation's timeline ────────────────────────────────────────────────

// A message's `meta` is written by the server alone: the names of what it holds say what kind of message it is.
const flagsOf = (meta: Record<string, unknown>) => Object.keys(meta).filter((k) => CODE.test(k));

/** Never `body`: how long it is. */
const messageColumns = {
  id: messages.id,
  at: ms(messages.createdAt),
  threadRootId: messages.threadId,
  authorType: messages.authorType,
  authorUserId: messages.authorUserId,
  authorAgentId: messages.authorAgentId,
  runId: messages.agentRunId,
  hop: messages.hop,
  length: sql<number>`char_length(${messages.body})`.mapWith(Number),
  mentionedAgentIds: messages.mentionedAgentIds,
  mentionedUserIds: messages.mentionedUserIds,
  flags: sql<string[]>`(select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(${messages.meta}) k)`.mapWith(
    namesOf,
  ),
  edited: sql<boolean>`${messages.editedAt} is not null`,
  deleted: sql<boolean>`${messages.deletedAt} is not null`,
};

/**
 * What the router's own code says of a pick, before any step's words: a decision's `reason` starts with these, then
 * holds what a model said about the message, which is never returned.
 */
const ROUTING_MARKERS: ReadonlySet<string> = new Set([
  "follow-up",
  "alone",
  "default",
  "coordinator",
  "talking to",
  "best",
  "last talked to",
  "already answered by another agent",
  "for people",
  "held back",
  "every mentioned agent acts",
]);

function routingMarkers(reason: string | null) {
  const markers: string[] = [];
  for (const part of reason?.split("; ") ?? []) {
    if (!ROUTING_MARKERS.has(part) && !/^referenced only: \d+$/.test(part)) break;
    markers.push(part);
  }
  return markers;
}

const routingColumns = {
  id: routingDecisions.id,
  messageId: routingDecisions.messageId,
  at: ms(routingDecisions.createdAt),
  strategy: routingDecisions.strategy,
  candidates: routingDecisions.candidates,
  needsAgentScore: routingDecisions.needsAgentScore,
  selectedAgentIds: routingDecisions.selectedAgentIds,
  reason: routingDecisions.reason,
  error: routingDecisions.error,
};

const selectRouting = (db: Database) => db.select(routingColumns).from(routingDecisions);
type RoutingRow = Awaited<ReturnType<typeof selectRouting>>[number];

function routingOf({ reason, error, candidates, strategy, ...decision }: RoutingRow) {
  return {
    ...decision,
    strategy: cutText(strategy, 100),
    candidates: candidates.flatMap((c) =>
      uuidOf(c?.agentId) && typeof c.score === "number" ? [{ agentId: c.agentId, score: c.score }] : [],
    ),
    reasonCodes: routingMarkers(reason),
    error: errorText(error, OPERATOR_JOB_ERROR_MAX),
  };
}

/** The longest stretch of a conversation one timeline covers, and how far around a message it looks by default. */
const TIMELINE_MAX_MS = 48 * 3600_000;
const TIMELINE_AROUND_MS = 3 * 3600_000;

export interface OperatorTimelineQuery extends PageQuery {
  /** The conversation; or `messageId`, never both. */
  channelId?: string;
  /** A message: its conversation, around when it was written. */
  messageId?: string;
  from?: Date;
  to?: Date;
}

// A message and the runs it starts are written by one statement, at one instant: at the same time a cause comes
// before what it caused, whatever their ids.
const TIMELINE_ORDER = { message: 0, routing: 1, run: 2, ask: 3 } as const;
/** A page of a timeline ends at this key: `[at (ms), its type's place, id]`. */
const TimelineCursor = z.tuple([z.iso.datetime(), z.number().int().min(0).max(3), z.uuid()]);

/**
 * What happened in one conversation, oldest first, in keyset pages: its messages (who wrote each, how long it is,
 * whom it mentions, never what it says), the routing decisions, the runs started and what agents asked of people.
 * The window is `from` to `to`: by default the 6 hours up to now, or the 3 hours before and after `messageId`.
 * Null: no such workspace, conversation or message.
 */
export async function operatorTimeline(db: Database, orgId: string, query: OperatorTimelineQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, TimelineCursor) : null;
  if (Boolean(query.channelId) === Boolean(query.messageId))
    throw new ValidationError("One of channelId and messageId is required");
  let around: Date | null = null;
  let channelId = query.channelId;
  if (query.messageId) {
    const [message] = await db
      .select({ channelId: messages.channelId, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, query.messageId)));
    if (!message) return null;
    around = message.createdAt;
    channelId = message.channelId;
  }
  if (!channelId) return null;
  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, channelId)));
  if (!channel) return null;

  const to = query.to ?? new Date((around ?? new Date()).getTime() + (around ? TIMELINE_AROUND_MS : 0));
  const from = query.from ?? new Date((around ?? to).getTime() - (around ? 1 : 2) * TIMELINE_AROUND_MS);
  if (from >= to) throw new ValidationError("from must be before to");
  if (to.getTime() - from.getTime() > TIMELINE_MAX_MS)
    throw new ValidationError("from and to are 48 hours apart at most");

  // The range is on the stored time itself, never on an expression of it: `messages` is partitioned by it.
  type Rows = { orgId: unknown; channelId: unknown; createdAt: unknown; id: unknown };
  const within = (type: keyof typeof TIMELINE_ORDER) => (t: Rows, at: SQL<Date>) => {
    const place = TIMELINE_ORDER[type];
    const past = !after
      ? undefined
      : place === after[1]
        ? sql`(${at}, ${t.id}) > (${after[0]}::timestamptz, ${after[2]}::uuid)`
        : place > after[1]
          ? sql`${at} >= ${after[0]}::timestamptz`
          : sql`${at} > ${after[0]}::timestamptz`;
    return and(
      sql`${t.orgId} = ${orgId}::uuid`,
      sql`${t.channelId} = ${channelId}::uuid`,
      sql`${t.createdAt} >= ${from.toISOString()}::timestamptz`,
      sql`${t.createdAt} < ${to.toISOString()}::timestamptz`,
      past,
    );
  };
  const more = query.limit + 1;
  const [written, decisions, runs, asks] = await Promise.all([
    db
      .select(messageColumns)
      .from(messages)
      .where(within("message")(messages, messageColumns.at))
      .orderBy(asc(messageColumns.at), asc(messages.id))
      .limit(more),
    selectRouting(db)
      .where(within("routing")(routingDecisions, routingColumns.at))
      .orderBy(asc(routingColumns.at), asc(routingDecisions.id))
      .limit(more),
    runsInOrder(db, within("run")(agentRuns, runColumns.createdAt), asc, more),
    asksWhere(db, within("ask"), more),
  ]);
  const events = [
    ...written.map((m) => ({ type: "message" as const, ...m })),
    ...decisions.map((d) => ({ type: "routing" as const, ...routingOf(d) })),
    ...runs.map((r) => ({ type: "run" as const, at: r.createdAt, ...runOf(r) })),
    ...asks.map((a) => ({ type: "ask" as const, at: a.createdAt, ...a })),
  ].sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      TIMELINE_ORDER[a.type] - TIMELINE_ORDER[b.type] ||
      inOrder([a.at, a.id], [b.at, b.id]),
  );
  const page = events.slice(0, query.limit);
  const last = page.at(-1);
  const next =
    events.length > query.limit && last
      ? encodeCursor([last.at.toISOString(), TIMELINE_ORDER[last.type], last.id])
      : null;
  return { channelId, from, to, events: page, next };
}

// ── Why a message did or did not start a run ─────────────────────────────────

/** How many agents an explanation lists: the ones the message concerns first, then the conversation's others. */
export const OPERATOR_EXPLAIN_AGENTS = 50;

export const OPERATOR_EXPLAIN_VERDICTS = [
  "run",
  "joined",
  "answered_question",
  "mission_suggestion",
  "kept_on_hold",
  "no_ai",
  "platform_cap",
  "blocked",
  "referenced_only",
  "nobody_picked",
  "picked_not_started",
  "job_pending",
  "job_failed",
  "not_routed",
] as const;

export const OPERATOR_EXPLAIN_SKIPS = [
  "workspace_deleting",
  "workspace_paused",
  "never_queued",
  "direct_conversation",
  "hop_limit",
  "no_candidates",
  "unknown",
] as const;

/**
 * Why a message did or did not start a run, from what is stored: the runs it started, joined or resumed, the
 * routing decision, the agents it names and the job that routes it. What isn't stored is worked out as things are
 * now and kept apart (`now`, `skipped`): each agent's state in the conversation, whether its author may talk to it,
 * the workspace's standing. `maxHops`: the server's hop limit. Null: no such message.
 */
export async function operatorExplainMessage(db: Database, messageId: string, options: { maxHops: number }) {
  // Every partition's primary key: a message can be stored at another time than its id says.
  const [message]: Message[] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message) return null;
  const { orgId, channelId, meta } = message;
  const person = message.authorType === "person" ? message.authorUserId : null;
  const typed = parseMentionHandles(message.body);
  const [receipts, taken, decisions, channel, workspace, posted, namedAgents, namedPeople, budget] = await Promise.all([
    receiptsFor(db, orgId, [message]),
    // A run already at work that took it, whoever sent it there (the router, an agent's mention): it still waits in
    // the run's inbox, or a step says the run read it. Only the insert's own steering is on the message.
    selectRuns(db)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.channelId, channelId),
          gte(agentRuns.createdAt, new Date(message.createdAt.getTime() - 86_400_000)),
          lt(agentRuns.createdAt, message.createdAt),
          sql`(${messageId}::uuid = any(${agentRuns.pendingMessageIds}) or exists (
            select 1 from ${agentRunSteps} s where s.run_id = ${RUN_ID} and s.kind = 'context'
              and s.data->'steeredMessageIds' @> ${JSON.stringify([messageId])}::jsonb))`,
        ),
      )
      .limit(OPERATOR_EXPLAIN_AGENTS),
    selectRouting(db).where(eq(routingDecisions.messageId, messageId)),
    db.select({ kind: channels.kind }).from(channels).where(eq(channels.id, channelId)),
    db
      .select({
        state: organizations.standing,
        reason: organizations.standingReason,
        notice: organizations.standingNotice,
        deletionDueAt: organizations.deletionDueAt,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId)),
    selectJobs(db).where(eq(outbox.dedupeKey, `message.posted:${messageId}`)),
    typed.length === 0
      ? []
      : db
          .select({ id: agents.id, handle: agents.handle, previousHandles: agents.previousHandles })
          .from(agents)
          .where(
            and(
              eq(agents.orgId, orgId),
              or(inArray(agents.handle, typed), arrayOverlaps(agents.previousHandles, typed)),
            ),
          )
          .limit(OPERATOR_EXPLAIN_AGENTS),
    typed.length === 0
      ? []
      : db
          .select({ userId: organizationMembers.userId, handle: organizationMembers.handle })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.handle, typed)))
          .limit(OPERATOR_EXPLAIN_AGENTS),
    orgDefaultAgentBudget(db, orgId),
  ]);
  const receipt = receipts.get(messageId);
  const handled = receipt?.handled ?? [];
  const routing = decisions[0] ? routingOf(decisions[0]) : null;
  const known = new Set([
    ...namedAgents.flatMap((a) => [a.handle, ...a.previousHandles]),
    ...namedPeople.flatMap((p) => p.handle ?? []),
  ]);

  const concerned = [
    ...new Set([
      ...handled.map((h) => h.agentId),
      ...taken.map((r) => r.agentId),
      ...message.mentionedAgentIds,
      ...namedAgents.map((a) => a.id),
      ...(receipt?.seenBy ?? []),
    ]),
  ].slice(0, OPERATOR_EXPLAIN_AGENTS);
  const inConversation = sql`exists (select 1 from ${channelMembers} cm
    where cm.agent_id = ${AGENT_ID} and cm.channel_id = ${channelId}::uuid)`;
  const [listed, answering] = await Promise.all([
    db
      .select({
        agentId: agents.id,
        name: agents.name,
        handle: agents.handle,
        archived: sql<boolean>`${agents.archivedAt} is not null`,
        held: sql<boolean>`${agents.operatorHoldAt} is not null`,
        inChannel: sql<boolean>`(${inConversation} or ${rightHandReaches(sql`${agents}`, sql`${channelId}::uuid`)})`,
        autoReply: sql<boolean | null>`(select cm.auto_reply from ${channelMembers} cm
          where cm.agent_id = ${AGENT_ID} and cm.channel_id = ${channelId}::uuid limit 1)`,
        mayTalk: (person
          ? audienceSql("agents", sql`${person}::text`, { channelId: sql`${channelId}::uuid` })
          : sql`null`) as SQL<boolean | null>,
        // Every agent has a budget (`effectiveAgentBudget`): its own, else the workspace's default.
        overBudget: sql<boolean>`(coalesce((
          select bp.spent_nano_usd from ${agentBudgetPeriods} bp where bp.agent_id = ${AGENT_ID}
            and bp.period_start = ${monthStartUtc(new Date()).toISOString().slice(0, 10)}::date), 0)
          >= coalesce(${agents.monthlyBudgetNanoUsd}, ${budget}::bigint))`,
      })
      .from(agents)
      .where(
        and(eq(agents.orgId, orgId), or(concerned.length ? inArray(agents.id, concerned) : undefined, inConversation)),
      )
      .orderBy(
        concerned.length ? desc(sql`${agents.id} = any(${`{${concerned.join(",")}}`}::uuid[])`) : asc(agents.id),
        asc(agents.createdAt),
      )
      .limit(OPERATOR_EXPLAIN_AGENTS),
    handled.length === 0
      ? []
      : selectRuns(db).where(
          and(
            eq(agentRuns.orgId, orgId),
            inArray(
              agentRuns.id,
              handled.map((h) => h.runId),
            ),
          ),
        ),
  ]);

  const steered = new Set([...stringsOf(meta.steeredRunIds), ...taken.map((r) => r.id)]);
  const referenced = new Set(receipt?.referenced ?? []);
  const named = new Set(namedAgents.map((a) => a.id));
  const explained = listed.map(({ agentId, name, handle, ...now }) => {
    const row =
      answering.find((r) => r.id === handled.find((h) => h.agentId === agentId)?.runId) ??
      taken.find((r) => r.agentId === agentId);
    const run = row ? runOf(row) : null;
    return {
      agentId,
      name,
      handle,
      named: named.has(agentId),
      mentioned: message.mentionedAgentIds.includes(agentId),
      referenced: referenced.has(agentId),
      candidate: routing?.candidates.some((c) => c.agentId === agentId) ?? false,
      score: routing?.candidates.find((c) => c.agentId === agentId)?.score ?? null,
      selected: routing?.selectedAgentIds.includes(agentId) ?? false,
      outcome: !run
        ? ("none" as const)
        : run.triggerMessageId === messageId
          ? ("run" as const)
          : steered.has(run.id)
            ? ("joined" as const)
            : ("answered_question" as const),
      run,
      now,
    };
  });

  const standing = workspace[0];
  const billingHold =
    standing && !standing.deletionDueAt && isBillingHold(standing) ? (standing.reason as BillingHold) : null;
  const job = posted[0] ? jobOf(posted[0]) : null;
  const outcomes = new Set(explained.map((a) => a.outcome));
  const flags = flagsOf(meta);
  // `UNANSWERED` tells the same in SQL, for every message of a range at once: a test holds the two together.
  const verdict: (typeof OPERATOR_EXPLAIN_VERDICTS)[number] = outcomes.has("run")
    ? "run"
    : outcomes.has("joined")
      ? "joined"
      : outcomes.has("answered_question")
        ? "answered_question"
        : flags.includes("missionSuggestion")
          ? "mission_suggestion"
          : routing?.strategy === KEPT_ON_HOLD
            ? "kept_on_hold"
            : decisions[0]?.error === NO_AI
              ? "no_ai"
              : decisions[0]?.error === PLATFORM_CAP
                ? "platform_cap"
                : (receipt?.blocked.length ?? 0) > 0
                  ? "blocked"
                  : referenced.size > 0
                    ? "referenced_only"
                    : routing
                      ? routing.selectedAgentIds.length > 0
                        ? "picked_not_started"
                        : "nobody_picked"
                      : job?.status === "pending" || job?.status === "processing"
                        ? "job_pending"
                        : job?.status === "failed"
                          ? "job_failed"
                          : "not_routed";
  // The router's own exits store nothing: which of them the message would meet as things are now.
  const candidates = explained.filter(
    (a) => a.now.inChannel && a.now.autoReply && !a.now.archived && !a.now.held && a.now.mayTalk !== false,
  );
  const skipped: (typeof OPERATOR_EXPLAIN_SKIPS)[number] | null =
    verdict !== "not_routed"
      ? null
      : standing?.deletionDueAt
        ? "workspace_deleting"
        : // The router goes on in one case only: a person's message while the workspace waits for its first plan.
          workRefusal(standing) && !(billingHold === "payment" && message.authorType === "person")
          ? "workspace_paused"
          : !job
            ? "never_queued"
            : channel[0]?.kind === "dm"
              ? "direct_conversation"
              : message.hop >= options.maxHops
                ? "hop_limit"
                : person && candidates.length === 0
                  ? "no_candidates"
                  : "unknown";

  return {
    message: {
      id: message.id,
      orgId,
      channelId,
      channelKind: channel[0]?.kind ?? null,
      at: message.createdAt,
      threadRootId: message.threadId,
      authorType: message.authorType,
      authorUserId: message.authorUserId,
      authorAgentId: message.authorAgentId,
      runId: message.agentRunId,
      hop: message.hop,
      length: [...message.body].length,
      mentionedAgentIds: message.mentionedAgentIds,
      mentionedUserIds: message.mentionedUserIds,
      flags,
      edited: message.editedAt !== null,
      deleted: message.deletedAt !== null,
    },
    verdict,
    skipped,
    handles: {
      agentIds: namedAgents.map((a) => a.id),
      userIds: namedPeople.map((p) => p.userId),
      // How many, never which: a handle nobody here has is a word of the message.
      unknown: typed.filter((h) => !known.has(h)).length,
    },
    agents: explained,
    routing,
    workspace: {
      standing: standing?.state ?? "active",
      billingHold,
      deleting: Boolean(standing?.deletionDueAt),
    },
    postedJob: job,
  };
}

// ── People's messages nobody answered ────────────────────────────────────────

/** What an explanation says of a message no run answered: every verdict but the three that name a run. */
export const OPERATOR_UNANSWERED_OUTCOMES = [
  "mission_suggestion",
  "kept_on_hold",
  "no_ai",
  "platform_cap",
  "blocked",
  "referenced_only",
  "nobody_picked",
  "picked_not_started",
  "job_pending",
  "job_failed",
  "not_routed",
] as const satisfies readonly (typeof OPERATOR_EXPLAIN_VERDICTS)[number][];
type Unanswered = (typeof OPERATOR_UNANSWERED_OUTCOMES)[number];

/** How far back unanswered messages are read when no start is given, and the longest stretch one read covers. */
export const OPERATOR_UNANSWERED_DAYS = 1;
export const OPERATOR_UNANSWERED_MAX_DAYS = 7;

// A code the server owns, written into the statement as it is: an expression rows are grouped by holds no parameter.
const literal = (code: string) => sql.raw(`'${code}'`);
/** A list a message's `meta` holds under `name`, empty when it holds none. */
const listIn = (name: string) => sql`(case when jsonb_typeof(${messages.meta}->${literal(name)}) = 'array'
  then ${messages.meta}->${literal(name)} else '[]'::jsonb end)`;
const REFERENCED = listIn("referencedAgentIds");

// `operatorExplainMessage`'s verdict for a message no run answered, in its order and from the same stored facts.
const UNANSWERED = sql<Unanswered>`(case
  when ${messages.meta} ? 'missionSuggestion' then 'mission_suggestion'
  when ${routingDecisions.strategy} = ${literal(KEPT_ON_HOLD)} then 'kept_on_hold'
  when ${routingDecisions.error} = ${literal(NO_AI)} then 'no_ai'
  when ${routingDecisions.error} = ${literal(PLATFORM_CAP)} then 'platform_cap'
  when not (to_jsonb(${messages.mentionedAgentIds}) <@ ${REFERENCED}) then 'blocked'
  when jsonb_array_length(${REFERENCED}) > 0 then 'referenced_only'
  when ${routingDecisions.id} is not null then
    case when cardinality(${routingDecisions.selectedAgentIds}) > 0 then 'picked_not_started' else 'nobody_picked' end
  when ${outbox.status} in ('pending', 'processing') then 'job_pending'
  when ${outbox.status} = 'failed' then 'job_failed'
  else 'not_routed' end)`;

interface UnansweredFilters {
  channelId?: string;
  outcome?: Unanswered;
  /** Written at or after. */
  from?: Date;
  /** Written before. */
  to?: Date;
}

export interface OperatorUnansweredQuery extends UnansweredFilters, PageQuery {}

/** The dates a read of unanswered messages covers and the messages in them; null: no such workspace. */
async function unansweredIn(db: Database, orgId: string, q: UnansweredFilters, now: Date) {
  if (!(await orgExists(db, orgId))) return null;
  const to = q.to ?? now;
  const from = q.from ?? new Date(to.getTime() - OPERATOR_UNANSWERED_DAYS * 86_400_000);
  if (from >= to) throw new ValidationError("from must be before to");
  if (to.getTime() - from.getTime() > OPERATOR_UNANSWERED_MAX_DAYS * 86_400_000)
    throw new ValidationError(`from and to are ${OPERATOR_UNANSWERED_MAX_DAYS} days apart at most`);
  // A run already at work took the message (the router or a hand-on sent it there): it still waits in that run's
  // inbox, or a step says the run read it. Such a run began in the day before the message, so in the range's too.
  // ponytail: no index of `agent_runs` starts with the workspace and the conversation; one on
  // (org_id, channel_id, created_at) (a migration) once this takes long.
  const taken = sql`exists (select 1 from ${agentRuns} r
    where r.org_id = ${messages.orgId} and r.channel_id = ${messages.channelId}
      and r.created_at >= ${messages.createdAt} - interval '1 day' and r.created_at < ${messages.createdAt}
      and r.created_at >= ${new Date(from.getTime() - 86_400_000).toISOString()}::timestamptz
      and r.created_at < ${to.toISOString()}::timestamptz
      and (${messages.id} = any(r.pending_message_ids) or exists (select 1 from ${agentRunSteps} s
        where s.run_id = r.id and s.kind = 'context' and s.data->'steeredMessageIds' ? ${messages.id}::text)))`;
  const where = and(
    eq(messages.orgId, orgId),
    // The range is on the stored time itself: `messages` is partitioned by it. Its index starts with the conversation,
    // so the workspace's conversations lead to its messages.
    gte(messages.createdAt, from),
    lt(messages.createdAt, to),
    q.channelId
      ? eq(messages.channelId, q.channelId)
      : sql`${messages.channelId} in (select c.id from ${channels} c where c.org_id = ${orgId}::uuid)`,
    eq(messages.authorType, "person"),
    isNull(messages.deletedAt),
    sql`not exists (select 1 from ${agentRuns} t where t.trigger_message_id = ${messages.id})`,
    sql`jsonb_array_length(${listIn("steeredRunIds")}) = 0`,
    sql`not (${messages.meta} ? 'answersQuestionId')`,
    sql`not ${taken}`,
    q.outcome ? sql`${UNANSWERED} = ${q.outcome}` : undefined,
  );
  return { from, to, where };
}

/** The job that routes a message, by its name. */
const POSTED_JOB = eq(outbox.dedupeKey, sql`'message.posted:' || ${messages.id}`);

/**
 * People's messages in a range of dates that no run answered, newest first, in keyset pages: the ones that started
 * no run, were taken by none already at work and answered no agent's question. Each with why, as
 * `operatorExplainMessage` tells it from what is stored, never what the message says. The range is the last day
 * unless said. Null: no such workspace.
 */
export async function operatorUnanswered(
  db: Database,
  orgId: string,
  query: OperatorUnansweredQuery,
  now = new Date(),
) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  const found = await unansweredIn(db, orgId, query, now);
  if (!found) return null;
  const rows = await db
    .select({
      id: messages.id,
      at: messageColumns.at,
      channelId: messages.channelId,
      threadRootId: messages.threadId,
      authorUserId: messages.authorUserId,
      outcome: UNANSWERED,
      strategy: routingDecisions.strategy,
    })
    .from(messages)
    .leftJoin(routingDecisions, eq(routingDecisions.messageId, messages.id))
    .leftJoin(outbox, POSTED_JOB)
    .where(and(found.where, olderThan(messageColumns.at, messages.id, after)))
    .orderBy(desc(messageColumns.at), desc(messages.id))
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (m) => [m.at, m.id]);
  return {
    from: found.from,
    to: found.to,
    messages: page.items.map((m) => ({ ...m, strategy: m.strategy ? cutText(m.strategy, 100) : null })),
    next: page.next,
  };
}

/** How many of them there are for each reason, most first. Null: no such workspace. */
export async function operatorUnansweredCounts(
  db: Database,
  orgId: string,
  query: UnansweredFilters,
  now = new Date(),
) {
  const found = await unansweredIn(db, orgId, query, now);
  if (!found) return null;
  const counts = await db
    .select({ outcome: UNANSWERED, messages: count() })
    .from(messages)
    .leftJoin(routingDecisions, eq(routingDecisions.messageId, messages.id))
    .leftJoin(outbox, POSTED_JOB)
    .where(found.where)
    .groupBy(UNANSWERED)
    .orderBy(desc(count()), asc(UNANSWERED));
  return { from: found.from, to: found.to, counts };
}
