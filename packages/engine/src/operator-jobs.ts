import { and, asc, count, type Database, desc, eq, gte, lt, or, type SQL, schema, sql } from "@agenteschat/db";
import { decodeCursor, encodeCursor } from "./cursor";
import { ValidationError } from "./errors";
import {
  codeOf,
  errorText,
  micros,
  ms,
  olderThan,
  orgExists,
  type PageQuery,
  UuidCursor,
  uuidOf,
} from "./operator-paging";
import { LANE_SLOW_FOR_MS } from "./outbox";

/**
 * Jobs and usage for the operator API (ADR 0056): what waits in the queue or failed there, and what model calls
 * spent. A job is its kind, its state and its times, never its payload; usage is counts of tokens and their cost.
 * Every field is picked by name, and nothing here writes, because a caller holding only the read token reaches all
 * of it.
 */

const { agentRuns, agents, outbox, usageRecords } = schema;

// ── Jobs ─────────────────────────────────────────────────────────────────────

/** How much of a job's last error an answer carries. */
export const OPERATOR_JOB_ERROR_MAX = 300;

const RUN_JOB = "agent_run.execute";

// Never `payload`: a job's holds addresses, links and text.
const jobColumns = {
  id: outbox.id,
  orgId: outbox.orgId,
  kind: outbox.kind,
  status: outbox.status,
  attempts: outbox.attempts,
  maxAttempts: outbox.maxAttempts,
  nextAttemptAt: outbox.nextAttemptAt,
  lockedUntil: outbox.lockedUntil,
  lockedBy: outbox.lockedBy,
  lastError: outbox.lastError,
  dedupe: outbox.dedupeKey,
  createdAt: ms(outbox.createdAt),
  completedAt: outbox.completedAt,
};

export const selectJobs = (db: Database) => db.select(jobColumns).from(outbox);
type JobRow = Awaited<ReturnType<typeof selectJobs>>[number];

/**
 * A run's jobs are all named `agent_run.execute:<run id>`, then the word that says why that job woke the run: both
 * are read from the name, which outlives the payload.
 */
export function jobOf({ dedupe, lastError, ...job }: JobRow) {
  const [, runId, cause] = job.kind === RUN_JOB && dedupe ? dedupe.split(":") : [];
  return {
    ...job,
    runId: uuidOf(runId),
    cause: codeOf(cause),
    lastError: errorText(lastError, OPERATOR_JOB_ERROR_MAX),
  };
}

// By name, not by payload: a finished job's payload is cleared after 30 days and its name stays.
// ponytail: no index serves a name by its start, so this reads the whole outbox; an index on `dedupe_key` with
// `text_pattern_ops` (a migration) once that takes long.
export const jobsOfRun = (runId: string) =>
  and(eq(outbox.kind, RUN_JOB), sql`starts_with(${outbox.dedupeKey}, ${`${RUN_JOB}:${runId}`})`);

/**
 * A job is stuck when it has been due this long and no worker took it, or when a worker took it and its lease ran
 * out: as long as a lane stays slow before the server itself tells of it.
 */
export const OPERATOR_JOB_STUCK_MS = LANE_SLOW_FOR_MS;

interface JobFilters {
  orgId?: string;
  kind?: string;
  status?: (typeof schema.outboxStatusEnum.enumValues)[number];
  /** The jobs that started and woke this run. */
  runId?: string;
  stuck?: boolean;
  /** Created at or after. */
  from?: Date;
  /** Created before. */
  to?: Date;
}

export interface OperatorJobQuery extends JobFilters, PageQuery {}

const jobsIn = (q: JobFilters, now: Date) =>
  and(
    q.orgId ? eq(outbox.orgId, q.orgId) : undefined,
    q.kind ? eq(outbox.kind, q.kind) : undefined,
    q.status ? eq(outbox.status, q.status) : undefined,
    q.runId ? jobsOfRun(q.runId) : undefined,
    q.stuck
      ? or(
          and(eq(outbox.status, "pending"), lt(outbox.nextAttemptAt, new Date(now.getTime() - OPERATOR_JOB_STUCK_MS))),
          and(eq(outbox.status, "processing"), lt(outbox.lockedUntil, now)),
        )
      : undefined,
    q.from ? gte(outbox.createdAt, q.from) : undefined,
    q.to ? lt(outbox.createdAt, q.to) : undefined,
  );

const QUEUED_AT = micros(outbox.createdAt);

/**
 * Jobs of every workspace and of none, newest first, in keyset pages.
 * ponytail: only due and leased jobs are indexed, so every other filter reads the whole outbox and sorts it. A page
 * is ordered and continued by the stored `created_at` itself, never an expression of it (which an index on the
 * column can't serve), so an index on `(created_at, id)` (a migration) serves it once that takes long.
 */
export async function operatorJobs(db: Database, query: OperatorJobQuery, now = new Date()) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  const rows = await db
    .select({ ...jobColumns, queuedAt: QUEUED_AT })
    .from(outbox)
    .where(
      and(
        jobsIn(query, now),
        after ? sql`(${outbox.createdAt}, ${outbox.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(outbox.createdAt), desc(outbox.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    jobs: page.map(({ queuedAt, ...job }) => jobOf(job)),
    next: last && rows.length > query.limit ? encodeCursor([last.queuedAt, last.id]) : null,
  };
}

const EMAIL_JOB = "email.send";

// An email adapter words a provider's refusal as "… refused the email (status name): its words". The status and the
// name are the provider's codes; its words may quote an address.
const REFUSED = /refused the email \((\d{3})(?: ([\w.-]+))?\)/;

/**
 * The emails queued to one address, newest first, in keyset pages: which template each sends, its state and its
 * attempts. The address is compared here, whole and in any case, with the ones a job is to, and never read out; nor
 * is anything else of the payload (a subject, a link, a code). A finished job keeps its addresses 30 days
 * (`clearOldOutboxPayloads`): after that it is no longer found. Like `operatorJobs`, this reads the whole outbox.
 */
export async function operatorEmailJobs(db: Database, query: PageQuery & { to: string }) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  const addresses = sql`jsonb_array_elements_text(case when jsonb_typeof(${outbox.payload}->'to') = 'array'
    then ${outbox.payload}->'to' else '[]'::jsonb end)`;
  const rows = await db
    .select({
      ...jobColumns,
      queuedAt: QUEUED_AT,
      template: sql<string | null>`${outbox.payload}->'template'->>'kind'`,
    })
    .from(outbox)
    .where(
      and(
        eq(outbox.kind, EMAIL_JOB),
        sql`exists (select 1 from ${addresses} sent(address) where lower(sent.address) = lower(${query.to}))`,
        olderThan(outbox.createdAt, outbox.id, after),
      ),
    )
    .orderBy(desc(outbox.createdAt), desc(outbox.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    jobs: page.map(({ queuedAt, template, ...job }) => {
      const refused = REFUSED.exec(job.lastError ?? "");
      return { ...jobOf(job), template: codeOf(template), errorCode: refused?.[2] ?? refused?.[1] ?? null };
    }),
    next: last && rows.length > query.limit ? encodeCursor([last.queuedAt, last.id]) : null,
  };
}

/** How many kinds and states of job a summary lists: every kind the code queues, in each of its four states. */
export const OPERATOR_JOB_COUNTS = 500;

/**
 * How many jobs there are of each kind in each state, and since when the oldest one still due has waited: for a
 * kind, and in all.
 */
export async function operatorJobSummary(db: Database, query: JobFilters, now = new Date()) {
  const due = sql`${outbox.status} = 'pending' and ${outbox.nextAttemptAt} <= ${now.toISOString()}::timestamptz`;
  const rows = await db
    .select({
      kind: outbox.kind,
      status: outbox.status,
      jobs: count(),
      // A null never reaches a decoder: the type says it may still come back.
      oldestDueAt: sql<Date | null>`min(${outbox.nextAttemptAt}) filter (where ${due})`.mapWith(
        (v: string | Date): Date | null => new Date(v),
      ),
    })
    .from(outbox)
    .where(jobsIn(query, now))
    .groupBy(outbox.kind, outbox.status)
    .orderBy(asc(outbox.kind), asc(outbox.status))
    .limit(OPERATOR_JOB_COUNTS + 1);
  const counts = rows.slice(0, OPERATOR_JOB_COUNTS);
  const oldest = counts.reduce<Date | null>(
    (first, c) => (c.oldestDueAt && (!first || c.oldestDueAt < first) ? c.oldestDueAt : first),
    null,
  );
  return {
    at: now,
    counts,
    more: rows.length > OPERATOR_JOB_COUNTS,
    oldestDueAt: oldest,
    oldestDueSeconds: oldest ? Math.round((now.getTime() - oldest.getTime()) / 1000) : null,
  };
}

// ── Usage ────────────────────────────────────────────────────────────────────

const total = (column: unknown) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

/** What a set of model calls spent. */
export const spentColumns = {
  calls: count(),
  input: total(usageRecords.inputTokens),
  output: total(usageRecords.outputTokens),
  cacheRead: total(usageRecords.cacheReadTokens),
  cacheWrite: total(usageRecords.cacheWriteTokens),
  costNanoUsd: total(usageRecords.costNanoUsd),
};

/** Its cost in dollars, to a millionth. */
export const spentOf = <T extends { costNanoUsd: number }>({ costNanoUsd, ...spent }: T) => ({
  ...spent,
  costUsd: Math.round(costNanoUsd / 1e3) / 1e6,
});

export const OPERATOR_USAGE_GROUPS = ["agent", "day", "hour", "model", "provider", "payer"] as const;
type UsageGroup = (typeof OPERATOR_USAGE_GROUPS)[number];

/** How far back usage is read when no start is given, and the longest stretch one read covers. */
export const OPERATOR_USAGE_DAYS = 7;
export const OPERATOR_USAGE_MAX_DAYS = 90;
const DAY_MS = 86_400_000;

const UTC = sql`${usageRecords.createdAt} at time zone 'UTC'`;
const GROUPS: Record<UsageGroup, SQL<string | null>> = {
  agent: sql`${usageRecords.agentId}::text`,
  day: sql`to_char(${UTC}, 'YYYY-MM-DD')`,
  hour: sql`to_char(${UTC}, 'YYYY-MM-DD"T"HH24":00:00.000Z"')`,
  model: sql`${usageRecords.model}`,
  provider: sql`${usageRecords.provider}`,
  payer: sql`${usageRecords.billedTo}`,
};
const TOKENS = sql`sum(${usageRecords.inputTokens} + ${usageRecords.outputTokens}
  + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens})`;

export interface OperatorUsageQuery {
  orgId?: string;
  agentId?: string;
  runId?: string;
  /** Recorded at or after. */
  from?: Date;
  /** Recorded before. */
  to?: Date;
  groupBy?: UsageGroup;
  /** How many groups. */
  limit: number;
}

/**
 * What model calls spent in a range of dates: of the whole instance, a workspace, an agent or one run, in all and
 * by `groupBy`, each group told apart by who it is billed to. Days and hours come oldest first, every other group
 * most tokens first. The range is the last 7 days unless said, a run's from when it began. Null: no such
 * workspace, agent or run, or one that isn't in the workspace or of the agent given with it.
 */
export async function operatorUsage(db: Database, query: OperatorUsageQuery, now = new Date()) {
  let { orgId, agentId } = query;
  let began: Date | null = null;
  // No index is on the run or on the agent alone: both are read through (org, agent, created_at).
  if (query.runId) {
    const [run] = await db
      .select({ orgId: agentRuns.orgId, agentId: agentRuns.agentId, createdAt: ms(agentRuns.createdAt) })
      .from(agentRuns)
      .where(eq(agentRuns.id, query.runId));
    if (!run || (orgId && orgId !== run.orgId) || (agentId && agentId !== run.agentId)) return null;
    ({ orgId, agentId, createdAt: began } = run);
  } else if (agentId) {
    const [agent] = await db.select({ orgId: agents.orgId }).from(agents).where(eq(agents.id, agentId));
    if (!agent || (orgId && orgId !== agent.orgId)) return null;
    orgId = agent.orgId;
  } else if (orgId && !(await orgExists(db, orgId))) return null;

  const to = query.to ?? now;
  const from = query.from ?? began ?? new Date(to.getTime() - OPERATOR_USAGE_DAYS * DAY_MS);
  if (from >= to) throw new ValidationError("from must be before to");
  // One run's rows are few however long ago it began; any other read is held to the range.
  if (!began && to.getTime() - from.getTime() > OPERATOR_USAGE_MAX_DAYS * DAY_MS)
    throw new ValidationError(`from and to are ${OPERATOR_USAGE_MAX_DAYS} days apart at most`);

  const where = and(
    orgId ? eq(usageRecords.orgId, orgId) : undefined,
    agentId ? eq(usageRecords.agentId, agentId) : undefined,
    query.runId ? eq(usageRecords.runId, query.runId) : undefined,
    gte(usageRecords.createdAt, from),
    lt(usageRecords.createdAt, to),
  );
  const group = query.groupBy ? GROUPS[query.groupBy] : null;
  const timed = query.groupBy === "day" || query.groupBy === "hour";
  const [totals, groups] = await Promise.all([
    db.select(spentColumns).from(usageRecords).where(where),
    group
      ? db
          .select({ group, billedTo: usageRecords.billedTo, ...spentColumns })
          .from(usageRecords)
          .where(where)
          .groupBy(group, usageRecords.billedTo)
          .orderBy(...(timed ? [] : [desc(TOKENS)]), asc(group), asc(usageRecords.billedTo))
          .limit(query.limit + 1)
      : [],
  ]);
  // An aggregate without `group by` always answers one row.
  const all = totals[0] as NonNullable<(typeof totals)[number]>;
  return {
    from,
    to,
    total: spentOf(all),
    groups: groups.slice(0, query.limit).map(spentOf),
    more: groups.length > query.limit,
  };
}
