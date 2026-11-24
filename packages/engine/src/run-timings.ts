import { BRAIN_COLD_CAUSES, BRAIN_TURN_MEASURES } from "@agenteschat/adapters";
import { type Database, rowsOf, type SQL, type schema, sql } from "@agenteschat/db";
import { BRAIN_KINDS } from "./brain-settings";
import { ValidationError } from "./errors";
import { isJsonObject, numberIn, wholeOrNull } from "./format";
import { heavyRead, instantOf } from "./operator-paging";

/**
 * Where runs' time went, for the operator API: one run's kept claims (`runClaims`, in its trace) and the stages,
 * computer starts and waits of the runs created in a window (`operatorRunTimings`). Both read `agent_runs.profiles`,
 * JSON that each claim appends to when it ends. Numbers, times and words the code itself writes: a name not shaped
 * like one of those reads `other`, and a value of the wrong shape is skipped, never an error.
 */

/** The most claims, stages of a claim and computer turns of a claim a trace gives. */
export const RUN_CLAIMS_MAX = 10;
export const RUN_CLAIM_STAGES_MAX = 200;
export const RUN_CLAIM_TURNS_MAX = 50;
/** The longest window of `operatorRunTimings` in one workspace, and across them all, which reads every one's runs. */
export const RUN_TIMINGS_MAX_DAYS = 31;
export const RUN_TIMINGS_FLEET_MAX_DAYS = 2;
/** The most rows of each of its lists. */
export const RUN_TIMINGS_ROWS_MAX = 300;
/** A stage, a claim or a computer's start lasting longer than a day is no measure. */
const TIMING_MAX_MS = 86_400_000;
const QUERIES_MAX = 1_000_000_000;

// A stage as the profiler names it: a word, then the turn it is of. Both sides read it, so one pattern for both.
const STAGE = /^[a-z][a-z0-9_]{0,39}(#[0-9]{1,5})?$/;
// `CODE` of `operator-paging.ts` spelled out for Postgres, whose `\w` also takes letters beyond ASCII.
const MODEL_SQL = "^[A-Za-z][A-Za-z0-9_.:/-]{0,99}$";
const CAUSE_SQL = "^[a-z_:]{1,60}$";

const msOf = (v: unknown) => wholeOrNull(numberIn(v, 0, TIMING_MAX_MS));
/** A computer turn's measures as its runner gave them (`BrainTurnTimings`), null where it gave none. */
const turnMeasures = (t: Record<string, unknown>) =>
  Object.fromEntries(BRAIN_TURN_MEASURES.map((k) => [k, msOf(t[k])])) as Record<
    (typeof BRAIN_TURN_MEASURES)[number],
    number | null
  >;

/** Why a cold turn started a process, as its runner said (`BRAIN_COLD_CAUSES`); null when warm or not said. */
const coldOf = (t: Record<string, unknown>) =>
  t.warm === false && (BRAIN_COLD_CAUSES as readonly unknown[]).includes(t.cold) ? (t.cold as string) : null;
const COLD_SQL = `^(${BRAIN_COLD_CAUSES.join("|")})$`;

interface ClaimStage {
  stage: string;
  ms: number;
  queries: number;
  parts?: ClaimStage[];
}
/** A stage as stored, or none when its time is no measure; its steps (`parts`) the same way, one level deep. */
function stageOf(s: unknown, deep: boolean): ClaimStage[] {
  if (!isJsonObject(s)) return [];
  const ms = msOf(s.ms);
  if (ms === null) return [];
  const stage = typeof s.stage === "string" && STAGE.test(s.stage) ? s.stage : "other";
  const parts = deep && Array.isArray(s.parts) ? s.parts.flatMap((p) => stageOf(p, false)) : [];
  return [
    {
      stage,
      ms,
      queries: wholeOrNull(numberIn(s.queries, 0, QUERIES_MAX)) ?? 0,
      ...(parts.length > 0 ? { parts: parts.slice(0, RUN_CLAIM_STAGES_MAX) } : {}),
    },
  ];
}

/** A run's kept claims as its trace gives them, oldest first: `profiles` as stored, which may hold anything. */
export function runClaims(profiles: unknown) {
  if (!Array.isArray(profiles)) return [];
  return profiles
    .filter(isJsonObject)
    .slice(-RUN_CLAIMS_MAX)
    .map((claim) => {
      const stages = (Array.isArray(claim.stages) ? claim.stages : []).flatMap((s: unknown) => stageOf(s, true));
      const total = isJsonObject(claim.total) ? claim.total : {};
      const sum = (field: "ms" | "queries") => stages.reduce((n, s) => n + s[field], 0);
      return {
        endedAt: instantOf(claim.endedAt),
        totalMs: msOf(total.ms) ?? sum("ms"),
        queries: wholeOrNull(numberIn(total.queries, 0, QUERIES_MAX)) ?? sum("queries"),
        stages: stages.slice(0, RUN_CLAIM_STAGES_MAX),
        stagesCut: stages.length > RUN_CLAIM_STAGES_MAX,
        computerTurns: (Array.isArray(claim.brain) ? claim.brain : [])
          .flatMap((t: unknown) =>
            isJsonObject(t) && typeof t.warm === "boolean"
              ? [{ warm: t.warm, cold: coldOf(t), ...turnMeasures(t) }]
              : [],
          )
          .slice(0, RUN_CLAIM_TURNS_MAX),
      };
    });
}

export interface RunTimingsQuery {
  /** ISO 8601 instants: runs created at or after `from` and before `to`. */
  from: string;
  to: string;
  orgId?: string;
  /** Only with `orgId`. */
  agentId?: string;
  by?: "brain" | "model";
}

// Postgres promises no order between the two sides of an `and`, so each cast sits inside the `case` that checked it.
// Through numeric, which holds any number JSON can: a float8 would refuse the largest.
const msSql = (value: string) =>
  `case when jsonb_typeof(${value}) = 'number' then case when (${value})::numeric between 0 and ${TIMING_MAX_MS}
      then (${value})::numeric::float8 end end`;
const stageSql = (value: string) =>
  `case when ${value}->>'stage' ~ '${STAGE.source}' then regexp_replace(${value}->>'stage', '#[0-9]+$', '') else 'other' end`;
const listSql = (value: string) => `case when jsonb_typeof(${value}) = 'array' then ${value} else '[]'::jsonb end`;
const pct = (q: number, column: string, filter = "") =>
  `percentile_cont(${q}) within group (order by ${column})${filter ? ` filter (where ${filter})` : ""}`;

/** Nulls last, then as the database would order two words. */
const byWord = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

/**
 * Where the time of the runs created in a window went, in one workspace (31 days at most) or across them (7), per
 * brain or per brain and model: each stage's count and percentiles, how computer turns started, and the waits for a
 * computer by their code.
 */
export async function operatorRunTimings(db: Database, query: RunTimingsQuery, now = new Date()) {
  const [from, to] = [instantOf(query.from), instantOf(query.to)];
  const apart = from && to ? Date.parse(to) - Date.parse(from) : 0;
  const maxDays = query.orgId ? RUN_TIMINGS_MAX_DAYS : RUN_TIMINGS_FLEET_MAX_DAYS;
  if (!from || !to || apart <= 0 || apart > maxDays * 86_400_000) {
    throw new ValidationError(
      `from and to are ISO 8601 instants, from before to, at most ${RUN_TIMINGS_FLEET_MAX_DAYS} days apart across workspaces and ${RUN_TIMINGS_MAX_DAYS} with orgId`,
      "analytics.range",
    );
  }
  if (query.agentId && !query.orgId) throw new ValidationError("agentId is only read with orgId");
  const by = query.by ?? "brain";

  const runsIn = sql`ar.created_at >= ${from}::timestamptz and ar.created_at < ${to}::timestamptz${
    query.orgId ? sql` and ar.org_id = ${query.orgId}` : sql``
  }${query.agentId ? sql` and ar.agent_id = ${query.agentId}` : sql``}`;
  const brain = sql.raw(
    `case when ar.brain in (${BRAIN_KINDS.map((b) => `'${b}'`).join(", ")}) then ar.brain
      when ar.brain is not null then 'other' end`,
  );
  const model = sql.raw(
    by === "model"
      ? `(select case when m.data->>'model' ~ '${MODEL_SQL}' then m.data->>'model' end from agent_run_steps m
          where m.run_id = ar.id and m.kind = 'model_call' order by m.seq desc limit 1)`
      : "null::text",
  );
  const kept = String(RUN_TIMINGS_ROWS_MAX);
  const read = (statement: SQL) => heavyRead(db, statement);
  const [profileRows, waitRows] = await Promise.all([
    // Each run's claims, read once for the counts, the stages and the starts.
    read(sql`
      with c as materialized (
        select r.id, r.brain, r.model, e.value as claim
        from (
          select ar.id, ${brain} as brain, ${model} as model, ar.profiles
          from agent_runs ar where ${runsIn}
          -- Keeps this a query of its own, so a run's model is looked up once, not once per claim it kept.
          offset 0
        ) r
        left join lateral jsonb_array_elements(${sql.raw(listSql("r.profiles"))}) e
          on jsonb_typeof(e.value) = 'object'
      ), cs as (
        select c.brain, c.model, s.value as s
        from c, jsonb_array_elements(${sql.raw(listSql("c.claim->'stages'"))}) s
      ), st as (
        select cs.brain, cs.model, ${sql.raw(stageSql("cs.s"))} as stage, ${sql.raw(msSql("cs.s->'ms'"))} as ms
        from cs
        union all
        -- A stage's steps, each named after it: context.build.
        select cs.brain, cs.model, ${sql.raw(stageSql("cs.s"))} || '.' || ${sql.raw(stageSql("p.value"))},
          ${sql.raw(msSql("p.value->'ms'"))}
        from cs, jsonb_array_elements(${sql.raw(listSql("cs.s->'parts'"))}) p
      ), sg as (
        select brain, model, stage, count(*)::int as count, ${sql.raw(pct(0.5, "ms"))} as "medianMs",
          ${sql.raw(pct(0.9, "ms"))} as "p90Ms", ${sql.raw(pct(0.99, "ms"))} as "p99Ms", max(ms) as "maxMs"
        from st where ms is not null group by brain, model, stage
      ), b as (
        select c.brain, c.model, t.value->'warm' = 'true'::jsonb as warm, t.value->>'cold' as cold,
          ${sql.raw(msSql("t.value->'initMs'"))} as init, ${sql.raw(msSql("t.value->'firstEventMs'"))} as first,
          ${sql.raw(msSql("t.value->'firstTokenMs'"))} as token, ${sql.raw(msSql("t.value->'firstAssistantMs'"))} as said,
          ${sql.raw(msSql("t.value->'retries'"))} as retries, ${sql.raw(msSql("t.value->'retryDelayMs'"))} as delay,
          ${sql.raw(msSql("t.value->'thinkingChars'"))} as thought
        from c, jsonb_array_elements(${sql.raw(listSql("c.claim->'brain'"))}) t
        where jsonb_typeof(t.value->'warm') = 'boolean'
      )
      select (select count(distinct id)::int from c) as runs,
        (select count(distinct id)::int from c where claim is not null) as profiled,
        (select count(*)::int from sg) as groups,
        (select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) from (
          select * from sg order by count desc, brain, model, stage limit ${sql.raw(kept)}
        ) g) as stages,
        (select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) from (
          select brain, model, count(*)::int as turns, count(*) filter (where warm)::int as warm,
            ${sql.raw(pct(0.5, "init"))} as "initMedianMs", ${sql.raw(pct(0.9, "init"))} as "initP90Ms",
            ${sql.raw(pct(0.99, "init"))} as "initP99Ms",
            ${sql.raw(pct(0.5, "first", "warm"))} as "warmFirstEventMedianMs",
            ${sql.raw(pct(0.9, "first", "warm"))} as "warmFirstEventP90Ms",
            ${sql.raw(pct(0.99, "first", "warm"))} as "warmFirstEventP99Ms",
            ${sql.raw(pct(0.5, "first", "not warm"))} as "coldFirstEventMedianMs",
            ${sql.raw(pct(0.9, "first", "not warm"))} as "coldFirstEventP90Ms",
            ${sql.raw(pct(0.99, "first", "not warm"))} as "coldFirstEventP99Ms",
            ${sql.raw(pct(0.5, "token"))} as "firstTokenMedianMs", ${sql.raw(pct(0.9, "token"))} as "firstTokenP90Ms",
            ${sql.raw(pct(0.5, "said"))} as "firstAssistantMedianMs",
            ${sql.raw(pct(0.9, "said"))} as "firstAssistantP90Ms",
            count(*) filter (where retries > 0)::int as "retriedTurns", sum(retries) as retries,
            sum(delay) as "retryDelayMs", ${sql.raw(pct(0.5, "thought"))} as "thinkingCharsMedian",
            ${sql.raw(pct(0.9, "thought"))} as "thinkingCharsP90"
          from b group by brain, model order by turns desc, brain, model limit ${sql.raw(kept)}
        ) g) as starts,
        (select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) from (
          select brain, model, case when cold ~ '${sql.raw(COLD_SQL)}' then cold else 'unsaid' end as cause,
            count(*)::int as turns
          from b where not warm group by 1, 2, 3 order by turns desc, 1, 2, 3 limit ${sql.raw(kept)}
        ) g) as "coldStarts"`),
    // A wait is a step written once: it lasts until the run's next step, its end, or the earlier of now and `to`.
    // Materialized, or each of the four measures of `sec` below would look the next step up again. The step's
    // condition is the one of `agent_run_steps`'s partial index on `run_id`, word for word: the planner reads the
    // waits through that index only when it can prove the condition from the statement's.
    read(sql`
      with w as materialized (
        select ar.id, ${brain} as brain, ${model} as model,
          'brain_unavailable:' || coalesce(s.data->>'code', 'other') || coalesce(':' || (s.data->>'room'), '') as said,
          greatest(extract(epoch from coalesce(
            (select n.created_at from agent_run_steps n where n.run_id = s.run_id and n.seq > s.seq
              order by n.seq limit 1),
            ar.finished_at, least(${now.toISOString()}::timestamptz, ${to}::timestamptz)) - s.created_at)::float8,
            0) as sec
        from agent_runs ar join agent_run_steps s on s.run_id = ar.id
        where ${runsIn} and s.kind = 'error' and s.data->>'reason' = 'brain_unavailable'
      )
      select case when said ~ '${sql.raw(CAUSE_SQL)}' then said else 'other' end as cause, brain, model,
        count(*)::int as waits, count(distinct id)::int as runs, ${sql.raw(pct(0.5, "sec"))} as "medianSec",
        ${sql.raw(pct(0.9, "sec"))} as "p90Sec", ${sql.raw(pct(0.99, "sec"))} as "p99Sec", sum(sec) as "totalSec"
      from w group by 1, 2, 3 order by waits desc, 1, 2, 3 limit ${sql.raw(kept)}`),
  ]);

  type Measures = Record<string, number | null>;
  type Group = { brain: string | null; model: string | null };
  const [found] = rowsOf<{
    runs: number;
    profiled: number;
    groups: number;
    stages: (Group & { stage: string; count: number } & Measures)[];
    starts: (Group & { turns: number; warm: number } & Measures)[];
    coldStarts: (Group & { cause: string; turns: number })[];
  }>(profileRows);
  const group = (g: Group) => ({ brain: g.brain, model: g.model });
  const inGroups = (a: Group, b: Group) => byWord(a.brain, b.brain) || byWord(a.model, b.model);
  return {
    from,
    to,
    by,
    runs: Number(found?.runs ?? 0),
    profiled: Number(found?.profiled ?? 0),
    stages: (found?.stages ?? [])
      .map((s) => ({
        ...group(s),
        stage: s.stage,
        count: Number(s.count),
        medianMs: wholeOrNull(s.medianMs),
        p90Ms: wholeOrNull(s.p90Ms),
        p99Ms: wholeOrNull(s.p99Ms),
        maxMs: wholeOrNull(s.maxMs),
      }))
      .sort((a, b) => inGroups(a, b) || (b.medianMs ?? 0) - (a.medianMs ?? 0) || byWord(a.stage, b.stage)),
    stagesMore: Number(found?.groups ?? 0) > RUN_TIMINGS_ROWS_MAX,
    computerStarts: (found?.starts ?? [])
      .map((s) => ({
        ...group(s),
        turns: Number(s.turns),
        warm: Number(s.warm),
        initMedianMs: wholeOrNull(s.initMedianMs),
        initP90Ms: wholeOrNull(s.initP90Ms),
        initP99Ms: wholeOrNull(s.initP99Ms),
        warmFirstEventMedianMs: wholeOrNull(s.warmFirstEventMedianMs),
        warmFirstEventP90Ms: wholeOrNull(s.warmFirstEventP90Ms),
        warmFirstEventP99Ms: wholeOrNull(s.warmFirstEventP99Ms),
        coldFirstEventMedianMs: wholeOrNull(s.coldFirstEventMedianMs),
        coldFirstEventP90Ms: wholeOrNull(s.coldFirstEventP90Ms),
        coldFirstEventP99Ms: wholeOrNull(s.coldFirstEventP99Ms),
        firstTokenMedianMs: wholeOrNull(s.firstTokenMedianMs),
        firstTokenP90Ms: wholeOrNull(s.firstTokenP90Ms),
        firstAssistantMedianMs: wholeOrNull(s.firstAssistantMedianMs),
        firstAssistantP90Ms: wholeOrNull(s.firstAssistantP90Ms),
        retriedTurns: Number(s.retriedTurns ?? 0),
        retries: wholeOrNull(s.retries) ?? 0,
        retryDelayMs: wholeOrNull(s.retryDelayMs) ?? 0,
        thinkingCharsMedian: wholeOrNull(s.thinkingCharsMedian),
        thinkingCharsP90: wholeOrNull(s.thinkingCharsP90),
      }))
      .sort((a, b) => inGroups(a, b) || b.turns - a.turns),
    coldStarts: (found?.coldStarts ?? [])
      .map((c) => ({ ...group(c), cause: c.cause, turns: Number(c.turns) }))
      .sort((a, b) => inGroups(a, b) || b.turns - a.turns || byWord(a.cause, b.cause)),
    waits: rowsOf<Group & { cause: string; waits: number; runs: number } & Measures>(waitRows)
      .map((w) => ({
        cause: w.cause,
        ...group(w),
        waits: Number(w.waits),
        runs: Number(w.runs),
        medianSec: wholeOrNull(w.medianSec),
        p90Sec: wholeOrNull(w.p90Sec),
        p99Sec: wholeOrNull(w.p99Sec),
        totalSec: wholeOrNull(w.totalSec),
      }))
      .sort((a, b) => inGroups(a, b) || b.waits - a.waits || byWord(a.cause, b.cause)),
  };
}

/** The longest window of `operatorReplyTimes`, by hour or by day. */
export const REPLY_TIMES_MAX_DAYS = 31;
/** A short ask: a person's message under this many characters, which should get the quickest replies. */
export const SHORT_ASK_CHARS = 40;
export const REPLY_TIME_BUCKETS = ["hour", "day"] as const;
/** The brains a reply time is split by: any other, or none yet, is `other`. */
export const REPLY_BRAINS = ["model", "claude_code", "codex", "other"] as const;
export const REPLY_WAIT_CAUSES = ["room", "offline", "other"] as const;
/**
 * The server's own lines a run posts before (or instead of) its answer, by `bodyCode`: no AI to think with, a plan at
 * its limit or switched, a computer or provider not answering, the asker at their limit. None is a reply: within a
 * second, they'd pass for the quickest ones.
 */
const NOT_A_REPLY = "^(no_ai|plan_limit|plan_account_moved|brain_unavailable|provider_|person_limit)";

export interface ReplyTimesQuery {
  /** ISO 8601 instants: runs created at or after `from` and before `to`. */
  from: string;
  to: string;
  bucket?: (typeof REPLY_TIME_BUCKETS)[number];
}

/**
 * How long people waited for agents, per UTC hour or day of the runs created in a window, across workspaces: from a
 * person's message to the run's first message in the conversation (replies, by brain and by trigger, and the same
 * for short asks), how computer turns started, and the waits for a computer. Counts and times only.
 */
export async function operatorReplyTimes(db: Database, query: ReplyTimesQuery, now = new Date()) {
  const [from, to] = [instantOf(query.from), instantOf(query.to)];
  const apart = from && to ? Date.parse(to) - Date.parse(from) : 0;
  if (!from || !to || apart <= 0 || apart > REPLY_TIMES_MAX_DAYS * 86_400_000) {
    throw new ValidationError(
      `from and to are ISO 8601 instants, from before to, at most ${REPLY_TIMES_MAX_DAYS} days apart`,
      "analytics.range",
    );
  }
  const bucket = query.bucket ?? "day";
  if (!REPLY_TIME_BUCKETS.includes(bucket)) throw new ValidationError("bucket is hour or day");
  const at = sql.raw(
    `to_char(date_trunc('${bucket}', ar.created_at, 'UTC') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:00:00"Z"')`,
  );
  const runsIn = sql`ar.created_at >= ${from}::timestamptz and ar.created_at < ${to}::timestamptz and not ar.background`;
  const named = REPLY_BRAINS.filter((b) => b !== "other").map((b) => `'${b}'`);
  const brain = sql.raw(`case when ar.brain in (${named.join(", ")}) then ar.brain else 'other' end`);
  const ms = (column: string, filter = "") => [0.5, 0.9, 0.99].map((q) => sql.raw(pct(q, column, filter)));
  const [p50, p90, p99] = ms("ms");
  const [s50, s90, s99] = ms("ms", "short");

  const [replyRows, startRows, waitRows] = await Promise.all([
    // A person's message (hop 1) and its run's first message. The bounds on `created_at` let each lookup read only
    // the month partitions they reach; a trigger not found there (an ask joined later) counts from the run's start.
    heavyRead(
      db,
      sql`
      with s as materialized (
        select ${at} as at, ${brain} as brain, ar.trigger::text as trigger, q.short,
          extract(epoch from (
            select min(m.created_at) from messages m where m.agent_run_id = ar.id
              and m.created_at >= ar.created_at - interval '1 minute' and m.created_at < ar.created_at + interval '2 days'
              and coalesce(m.meta->>'bodyCode', '') !~ '${sql.raw(NOT_A_REPLY)}'
          ) - coalesce(q.asked, ar.created_at)) * 1000 as said
        from agent_runs ar
        left join lateral (
          select m.created_at as asked, char_length(m.body) < ${SHORT_ASK_CHARS} as short,
            m.author_type = 'person' as person
          from messages m
          where m.id = ar.trigger_message_id and m.created_at <= ar.created_at + interval '1 minute'
            and m.created_at > ar.created_at - interval '1 day'
          limit 1
        ) q on true
        -- An agent's message can start a hop-1 run too (a routine's report that names another agent): nobody waits on it.
        where ${runsIn} and ar.hop = 1 and q.person is not false
      ), r as (
        -- A run that never replied stays null: greatest() would make it 0.
        select at, brain, trigger, short, case when said < 0 then 0 else said end as ms from s
      )
      select at, case when grouping(brain) = 1 then 'all' else brain end as brain,
        case when grouping(trigger) = 1 then 'all' else trigger end as trigger,
        count(*)::int as runs, count(ms)::int as replied, ${p50} as "p50Ms", ${p90} as "p90Ms", ${p99} as "p99Ms",
        count(*) filter (where short)::int as "shortRuns", count(ms) filter (where short)::int as "shortReplied",
        ${s50} as "shortP50Ms", ${s90} as "shortP90Ms", ${s99} as "shortP99Ms"
      from r group by grouping sets ((at), (at, brain), (at, trigger)) order by 1, 2, 3`,
    ),
    heavyRead(
      db,
      sql`
      with b as (
        select ${at} as at, t.value->'warm' = 'true'::jsonb as warm,
          ${sql.raw(msSql("t.value->'firstEventMs'"))} as first
        from agent_runs ar, jsonb_array_elements(${sql.raw(listSql("ar.profiles"))}) c,
          jsonb_array_elements(${sql.raw(listSql("c.value->'brain'"))}) t
        where ${runsIn} and jsonb_typeof(t.value->'warm') = 'boolean'
      )
      select at, count(*)::int as turns, count(*) filter (where warm)::int as warm,
        ${sql.raw(pct(0.5, "first", "warm"))} as "warmFirstEventP50Ms",
        ${sql.raw(pct(0.9, "first", "warm"))} as "warmFirstEventP90Ms",
        ${sql.raw(pct(0.5, "first", "not warm"))} as "coldFirstEventP50Ms",
        ${sql.raw(pct(0.9, "first", "not warm"))} as "coldFirstEventP90Ms"
      from b group by at order by at`,
    ),
    // As `operatorRunTimings`'s waits: each lasts until the run's next step, its end, or the earlier of now and `to`.
    heavyRead(
      db,
      sql`
      with w as materialized (
        select ${at} as at, ar.id,
          case s.data->>'code' when 'busy' then 'room' when 'machine_offline' then 'offline' else 'other' end as cause,
          greatest(extract(epoch from coalesce(
            (select n.created_at from agent_run_steps n where n.run_id = s.run_id and n.seq > s.seq
              order by n.seq limit 1),
            ar.finished_at, least(${now.toISOString()}::timestamptz, ${to}::timestamptz)) - s.created_at) * 1000,
            0) as ms
        from agent_runs ar join agent_run_steps s on s.run_id = ar.id
        where ${runsIn} and s.kind = 'error' and s.data->>'reason' = 'brain_unavailable'
      )
      select at, cause, count(*)::int as waits, count(distinct id)::int as runs, ${p50} as "p50Ms", ${p90} as "p90Ms"
      from w group by 1, 2 order by 1, 2`,
    ),
  ]);

  type Measures = Record<string, number | null>;
  type Trigger = "all" | (typeof schema.agentRunTriggerEnum.enumValues)[number];
  return {
    from,
    to,
    bucket,
    replies: rowsOf<{ at: string; brain: "all" | (typeof REPLY_BRAINS)[number]; trigger: Trigger } & Measures>(
      replyRows,
    ).map((r) => ({
      at: r.at,
      brain: r.brain,
      trigger: r.trigger,
      runs: Number(r.runs),
      replied: Number(r.replied),
      p50Ms: wholeOrNull(r.p50Ms),
      p90Ms: wholeOrNull(r.p90Ms),
      p99Ms: wholeOrNull(r.p99Ms),
      short: {
        runs: Number(r.shortRuns),
        replied: Number(r.shortReplied),
        p50Ms: wholeOrNull(r.shortP50Ms),
        p90Ms: wholeOrNull(r.shortP90Ms),
        p99Ms: wholeOrNull(r.shortP99Ms),
      },
    })),
    computerStarts: rowsOf<{ at: string } & Measures>(startRows).map((s) => ({
      at: s.at,
      turns: Number(s.turns),
      warm: Number(s.warm),
      warmFirstEventP50Ms: wholeOrNull(s.warmFirstEventP50Ms),
      warmFirstEventP90Ms: wholeOrNull(s.warmFirstEventP90Ms),
      coldFirstEventP50Ms: wholeOrNull(s.coldFirstEventP50Ms),
      coldFirstEventP90Ms: wholeOrNull(s.coldFirstEventP90Ms),
    })),
    waits: rowsOf<{ at: string; cause: (typeof REPLY_WAIT_CAUSES)[number] } & Measures>(waitRows).map((w) => ({
      at: w.at,
      cause: w.cause,
      waits: Number(w.waits),
      runs: Number(w.runs),
      p50Ms: wholeOrNull(w.p50Ms),
      p90Ms: wholeOrNull(w.p90Ms),
    })),
  };
}

/** The longest window of `operatorCliRuns`, and the most CLI builds it lists. */
export const CLI_RUNS_MAX_DAYS = 7;
export const CLI_RUNS_ROWS_MAX = 200;

/**
 * The runs created in a window that ended (`done` or `failed`), by the coding CLI and version they thought with
 * (`agent_runs.cli`), and how many of them failed: what the Cloud compares a CLI's new build with the one before by.
 * Every failure counts, whatever its cause. Only values shaped as `recordRunBrain` writes them.
 */
export async function operatorCliRuns(db: Database, query: { from: string; to: string }) {
  const [from, to] = [instantOf(query.from), instantOf(query.to)];
  const apart = from && to ? Date.parse(to) - Date.parse(from) : 0;
  if (!from || !to || apart <= 0 || apart > CLI_RUNS_MAX_DAYS * 86_400_000) {
    throw new ValidationError(
      `from and to are ISO 8601 instants, from before to, at most ${CLI_RUNS_MAX_DAYS} days apart`,
      "analytics.range",
    );
  }
  const rows = rowsOf<{ cli: string; runs: number; failed: number }>(
    await heavyRead(
      db,
      sql`select ar.cli, count(*)::int as runs, (count(*) filter (where ar.status = 'failed'))::int as failed
        from agent_runs ar
        where ar.created_at >= ${from}::timestamptz and ar.created_at < ${to}::timestamptz
          and ar.status in ('done', 'failed') and ar.cli ~ '^[a-z]{1,20} [0-9][0-9A-Za-z.+-]{0,63}$'
        group by ar.cli order by runs desc, ar.cli limit ${CLI_RUNS_ROWS_MAX}`,
    ),
  );
  return {
    from,
    to,
    clis: rows.map(({ cli, runs, failed }) => {
      const [name = "", version = ""] = cli.split(" ");
      return { cli: name, version, runs, failed };
    }),
  };
}
