import { type Database, rowsOf, type SQL, sql } from "@agenteschat/db";
import { BRAIN_KINDS } from "./brain-settings";
import { ValidationError } from "./errors";
import { isJsonObject, numberIn, wholeOrNull } from "./format";
import { instantOf } from "./operator-paging";

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
              ? [{ warm: t.warm, initMs: msOf(t.initMs), firstEventMs: msOf(t.firstEventMs) }]
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

  // Fleet-wide these read many rows: compiling them costs more than it saves, and one that still runs long is stopped.
  const read = (statement: SQL) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`set local jit = off`);
      await tx.execute(sql`set local statement_timeout = '20s'`);
      return tx.execute(statement);
    });
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
        select c.brain, c.model, t.value->'warm' = 'true'::jsonb as warm,
          ${sql.raw(msSql("t.value->'initMs'"))} as init, ${sql.raw(msSql("t.value->'firstEventMs'"))} as first
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
            ${sql.raw(pct(0.99, "first", "not warm"))} as "coldFirstEventP99Ms"
          from b group by brain, model order by turns desc, brain, model limit ${sql.raw(kept)}
        ) g) as starts`),
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
      }))
      .sort((a, b) => inGroups(a, b) || b.turns - a.turns),
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
