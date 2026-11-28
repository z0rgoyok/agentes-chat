import { type Database, rowsOf, sql } from "@agenteschat/db";
import { askKindOf } from "./ask-times";
import { ASK_KINDS } from "./asks";
import { UUID } from "./authority";
import { BRAIN_KINDS } from "./brain-settings";
import { ValidationError } from "./errors";
import { getOrMake, percentile } from "./format";
import { heavyRead, instantOf } from "./operator-paging";
import {
  listSql as list,
  MODEL_SQL,
  msSql as ms,
  stageSql as named,
  STAGE_GROUPS,
  type StageGroup,
  stageGroupOf,
} from "./run-timings";

/**
 * Where the time goes, for the operator's console: each run's time in the breakdown's groups (`STAGE_GROUPS`), read
 * from the stage profile it kept (`agent_runs.profiles`), with each group's median and p90 per UTC day, per kind of
 * ask (ADR 0254), per brain and per model, and the slowest runs for a drill-down to their waterfall in the trace.
 */

/**
 * The longest window across workspaces, and in one. It reads every run's profile: a day across workspaces is some
 * tens of thousands of runs and a few seconds, past a heavy read's limit at a week.
 */
export const STAGE_BREAKDOWN_FLEET_MAX_DAYS = 2;
export const STAGE_BREAKDOWN_MAX_DAYS = 31;
/** The slowest runs listed, and the most models. */
export const STAGE_BREAKDOWN_SLOWEST = 25;
export const STAGE_BREAKDOWN_MODELS_MAX = 20;
/** A run's kind: its ask's (ADR 0254), another agent's message (`agent`), or no one's ask (`background`). */
export const BREAKDOWN_KINDS = [...ASK_KINDS, "agent", "background"] as const;
export type BreakdownKind = (typeof BREAKDOWN_KINDS)[number];

/** One run as the breakdown reads it: its time per group (0 where it had none). */
export interface BreakdownRun {
  runId: string;
  orgId: string;
  agentId: string;
  createdAt: Date;
  brain: string;
  model: string | null;
  kind: BreakdownKind;
  totalMs: number;
  groups: Record<StageGroup, number>;
}

/** A run's stages summed by name (a computer turn's `model` by its steps) as the breakdown's groups. */
export function groupsOf(stages: Record<string, number>): Record<StageGroup, number> {
  const groups = Object.fromEntries(STAGE_GROUPS.map((g) => [g, 0])) as Record<StageGroup, number>;
  for (const [stage, value] of Object.entries(stages)) groups[stageGroupOf(stage)] += value;
  return groups;
}

/** Each group's runs that had it, and its median and p90 over them; and the runs' whole time. */
export function breakdownMeasures(runs: readonly BreakdownRun[]) {
  const q = (values: number[]) =>
    values.length === 0
      ? { p50Ms: null, p90Ms: null }
      : { p50Ms: Math.round(percentile(values, 0.5)), p90Ms: Math.round(percentile(values, 0.9)) };
  return {
    runs: runs.length,
    total: q(runs.map((r) => r.totalMs)),
    groups: STAGE_GROUPS.map((group) => {
      const had = runs.map((r) => r.groups[group]).filter((v) => v > 0);
      return { group, runs: had.length, ...q(had) };
    }),
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const r of rows) getOrMake(groups, key(r), () => []).push(r);
  return groups;
}

/** The operator's answer from the runs read: overall, per day, per kind, per brain, per model, and the slowest. */
export function stageBreakdown(runs: readonly BreakdownRun[]) {
  const byKind = groupBy(runs, (r) => r.kind);
  const byModel = [...groupBy(runs, (r) => r.model ?? "none")].sort((a, b) => b[1].length - a[1].length);
  return {
    groups: [...STAGE_GROUPS],
    totals: breakdownMeasures(runs),
    days: [...groupBy(runs, (r) => r.createdAt.toISOString().slice(0, 10))]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, list]) => ({ day, ...breakdownMeasures(list) })),
    kinds: BREAKDOWN_KINDS.flatMap((kind) => {
      const own = byKind.get(kind);
      return own ? [{ kind, ...breakdownMeasures(own) }] : [];
    }),
    brains: [...groupBy(runs, (r) => r.brain)]
      .map(([brain, list]) => ({ brain, ...breakdownMeasures(list) }))
      .sort((a, b) => b.runs - a.runs || (a.brain < b.brain ? -1 : 1)),
    models: byModel
      .slice(0, STAGE_BREAKDOWN_MODELS_MAX)
      .map(([model, list]) => ({ model, ...breakdownMeasures(list) })),
    modelsMore: byModel.length > STAGE_BREAKDOWN_MODELS_MAX,
    slowest: [...runs]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, STAGE_BREAKDOWN_SLOWEST)
      .map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  };
}

export interface StageBreakdownQuery {
  /** ISO 8601 instants: runs created at or after `from` and before `to`. */
  from: string;
  to: string;
  orgId?: string;
}

/** The runs created in a window that kept a profile, each summed by stage in the database (one row a run). */
export async function readBreakdownRuns(db: Database, query: StageBreakdownQuery): Promise<BreakdownRun[]> {
  const org = query.orgId ? sql`and ar.org_id = ${query.orgId}` : sql``;
  const brain = `case when r.brain in (${BRAIN_KINDS.map((b) => `'${b}'`).join(", ")}) then r.brain else 'other' end`;
  const rows = rowsOf<Record<string, unknown>>(
    await heavyRead(
      db,
      sql`
      with r as materialized (
        select ar.id, ar.org_id, ar.agent_id, ar.created_at, ar.brain, ar.background, ar.profiles,
          coalesce(ar.stretch_id, ar.trigger_message_id) as ask, ar.trigger_message_id
        from agent_runs ar
        where ar.created_at >= ${query.from}::timestamptz and ar.created_at < ${query.to}::timestamptz ${org}
          and jsonb_typeof(ar.profiles) = 'array' and jsonb_array_length(ar.profiles) > 0
      ), st as (
        select r.id, ${sql.raw(named("s.value"))} as stage, s.value as v
        from r, jsonb_array_elements(r.profiles) c, jsonb_array_elements(${sql.raw(list("c.value->'stages'"))}) s
        where jsonb_typeof(c.value) = 'object'
      ), leaf as (
        -- A computer turn's model stage by its steps, every other stage whole.
        select st.id, case when p.value is null then st.stage else ${sql.raw(named("p.value"))} end as name,
          case when p.value is null then ${sql.raw(ms("st.v->'ms'"))} else ${sql.raw(ms("p.value->'ms'"))} end as ms
        from st left join lateral jsonb_array_elements(
          case when st.stage = 'model' then ${sql.raw(list("st.v->'parts'"))} else '[]'::jsonb end) p on true
      ), sums as (
        select id, jsonb_object_agg(name, ms) as stages
        from (select id, name, sum(ms) as ms from leaf where ms is not null group by id, name) x group by id
      )
      select r.id, r.org_id, r.agent_id, r.created_at, ${sql.raw(brain)} as brain, r.background, sums.stages,
        k.kind, q.chars, q.person,
        case when k.kind is null and q.person and not r.background then (select count(*) from agent_run_steps s
          where s.run_id = r.id and s.kind = 'tool_call')::int end as tools,
        (select case when u.model ~ ${MODEL_SQL} then u.model end from usage_records u
          where u.run_id = r.id and u.kind = 'agent' and u.provider <> 'web' order by u.created_at limit 1) as model
      from r join sums on sums.id = r.id
      left join ask_kinds k on k.message_id = r.ask
      left join lateral (
        select char_length(m.body) as chars, m.author_type = 'person' as person from messages m
        where m.id = r.trigger_message_id and m.created_at <= r.created_at + interval '1 minute'
          and m.created_at > r.created_at - interval '1 day'
        limit 1
      ) q on true`,
    ),
  );
  return rows.map((r) => {
    const stages = Object.fromEntries(
      Object.entries((r.stages ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0]),
    );
    const groups = groupsOf(stages);
    const kind: BreakdownKind =
      r.background === true
        ? "background"
        : typeof r.kind === "string" && (ASK_KINDS as readonly string[]).includes(r.kind)
          ? (r.kind as BreakdownKind)
          : r.person === true
            ? askKindOf({ kind: null, tools: Number(r.tools ?? 0), chars: r.chars === null ? null : Number(r.chars) })
            : "agent";
    return {
      runId: r.id as string,
      orgId: r.org_id as string,
      agentId: r.agent_id as string,
      createdAt: new Date(r.created_at as string | Date),
      brain: r.brain as string,
      // A custom endpoint's model is named by the workspace: only that it was one leaves.
      model: typeof r.model === "string" ? (r.model.startsWith("custom:") ? "custom" : r.model) : null,
      kind,
      totalMs: Math.round(Object.values(groups).reduce((n, v) => n + v, 0)),
      groups: Object.fromEntries(STAGE_GROUPS.map((g) => [g, Math.round(groups[g])])) as Record<StageGroup, number>,
    };
  });
}

/**
 * Where the time of the runs created in a window went (`GET /analytics/stage-breakdown`): across workspaces (2 days
 * at most) or in one (31). Counts, times, ids and the server's own words only: no message, no name.
 */
export async function operatorStageBreakdown(db: Database, query: StageBreakdownQuery) {
  const [from, to] = [instantOf(query.from), instantOf(query.to)];
  const apart = from && to ? Date.parse(to) - Date.parse(from) : 0;
  const maxDays = query.orgId ? STAGE_BREAKDOWN_MAX_DAYS : STAGE_BREAKDOWN_FLEET_MAX_DAYS;
  if (!from || !to || apart <= 0 || apart > maxDays * 86_400_000) {
    throw new ValidationError(
      `from and to are ISO 8601 instants, from before to, at most ${STAGE_BREAKDOWN_FLEET_MAX_DAYS} days apart across workspaces and ${STAGE_BREAKDOWN_MAX_DAYS} with orgId`,
      "analytics.range",
    );
  }
  if (query.orgId !== undefined && !UUID.test(query.orgId)) throw new ValidationError("orgId is a workspace's id");
  const runs = await readBreakdownRuns(db, { from, to, ...(query.orgId ? { orgId: query.orgId } : {}) });
  return { from, to, orgId: query.orgId ?? null, ...stageBreakdown(runs) };
}
