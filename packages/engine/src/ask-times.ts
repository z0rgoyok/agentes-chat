import { type Database, rowsOf, sql } from "@agenteschat/db";
import { ASK_KINDS, type AskKind } from "./asks";
import { UUID } from "./authority";
import { BRAIN_KINDS } from "./brain-settings";
import { ValidationError } from "./errors";
import { getOrMake, percentile } from "./format";
import { heavyRead, instantOf } from "./operator-paging";
import { MODEL_SQL, NOT_A_REPLY } from "./run-timings";
import { failureOf } from "./work-analytics";

/** Time per task for the operator (ADR 0254): the asks of a window, timed from their stretch's runs and messages. */

/**
 * The reply a person should have by then, per kind: a reply within it satisfies, within four times it is tolerated,
 * later (or a failure) frustrates, as an Apdex score counts them. Long work should say it took the work on quickly.
 */
export const ASK_TARGET_MS: Record<AskKind, number> = {
  chat: 5_000,
  question: 10_000,
  lookup: 20_000,
  action: 30_000,
  task: 120_000,
  project: 60_000,
};

/** A message this short that needed no tool was small talk ("oi", "thanks!"), when Jev didn't say. */
const CHAT_MAX_CHARS = 15;
/** At most this many tool calls was a lookup, when Jev didn't say; more was a task. */
const LOOKUP_MAX_TOOLS = 3;

/** The longest window of `operatorAskTimes`. */
export const ASK_TIMES_MAX_DAYS = 31;
export const ASK_TIME_BUCKETS = ["hour", "day"] as const;
export const ASK_OUTCOMES = ["done", "failed", "setup", "canceled", "open", "passed"] as const;
export type AskOutcome = (typeof ASK_OUTCOMES)[number];
/** The most models listed, most asks first. */
export const ASK_MODELS_MAX = 20;

/** One ask, as `operatorAskTimes` reads it. Times are from the person's message. */
export interface AskRow {
  asked: Date;
  /** Jev's read, null when it wasn't asked or didn't answer. */
  kind: string | null;
  chars: number | null;
  runs: number;
  agents: number;
  tools: number;
  brain: string | null;
  model: string | null;
  /** The first thing it showed: a tool's step or a message. */
  activityMs: number | null;
  /** The first message of the work in the conversation (the server's own lines aren't replies). */
  replyMs: number | null;
  /** Every run of it ended, and its long work if it stepped into one: null while any goes on. */
  doneMs: number | null;
  open: boolean;
  lastStatus: string | null;
  lastError: string | null;
}

export const askKindOf = (r: Pick<AskRow, "kind" | "tools" | "chars">): AskKind =>
  r.kind && (ASK_KINDS as readonly string[]).includes(r.kind)
    ? (r.kind as AskKind)
    : r.tools === 0
      ? r.chars !== null && r.chars <= CHAT_MAX_CHARS
        ? "chat"
        : "question"
      : r.tools <= LOOKUP_MAX_TOOLS
        ? "lookup"
        : "task";

export function askOutcomeOf(r: AskRow): AskOutcome {
  if (r.lastStatus === "failed" && r.replyMs === null && ["noAi", "paused"].includes(failureOf(r.lastError)))
    return "setup";
  if (r.open) return "open";
  if (r.lastStatus === "failed") return "failed";
  if (r.lastStatus === "canceled") return "canceled";
  return r.replyMs === null ? "passed" : "done";
}

/**
 * How the person felt the wait, by the kind's target: a reply within it, within four times it, or later. A failure and
 * an ask still without a reply past four times are frustrating; one with no AI or on hold (a setup, not a wait), one a
 * person stopped, one every agent passed on (nobody needed to answer) and one still within its time don't count.
 */
export function askSpeedOf(r: AskRow, now: Date): "satisfied" | "tolerating" | "frustrated" | null {
  const outcome = askOutcomeOf(r);
  if (outcome === "setup") return null;
  const target = ASK_TARGET_MS[askKindOf(r)];
  if (r.replyMs !== null)
    return r.replyMs <= target ? "satisfied" : r.replyMs <= 4 * target ? "tolerating" : "frustrated";
  if (outcome === "failed") return "frustrated";
  if (outcome === "open") return now.getTime() - r.asked.getTime() > 4 * target ? "frustrated" : null;
  return null;
}

const quantiles = (values: (number | null)[]) => {
  const kept = values.filter((v): v is number => v !== null);
  return kept.length === 0
    ? { p50Ms: null, p90Ms: null }
    : { p50Ms: Math.round(percentile(kept, 0.5)), p90Ms: Math.round(percentile(kept, 0.9)) };
};

/** One group's asks: how many, the speed index, the times to first activity, first reply and done, how they ended. */
export function askMeasures(rows: readonly AskRow[], now: Date) {
  const verdicts = { satisfied: 0, tolerating: 0, frustrated: 0 };
  const outcomes = Object.fromEntries(ASK_OUTCOMES.map((o) => [o, 0])) as Record<AskOutcome, number>;
  for (const r of rows) {
    outcomes[askOutcomeOf(r)] += 1;
    const v = askSpeedOf(r, now);
    if (v) verdicts[v] += 1;
  }
  const counted = verdicts.satisfied + verdicts.tolerating + verdicts.frustrated;
  const timed = rows.filter((r) => askOutcomeOf(r) !== "setup");
  return {
    asks: rows.length,
    judged: rows.filter((r) => r.kind !== null).length,
    /** 0 to 100: satisfied plus half the tolerated, over the asks that count; null for none. */
    index: counted === 0 ? null : Math.round((100 * (verdicts.satisfied + verdicts.tolerating / 2)) / counted),
    ...verdicts,
    firstActivity: quantiles(timed.map((r) => r.activityMs)),
    firstReply: quantiles(timed.map((r) => r.replyMs)),
    done: quantiles(timed.map((r) => (askOutcomeOf(r) === "done" ? r.doneMs : null))),
    outcomes,
    multiAgent: rows.filter((r) => r.agents > 1).length,
    runsPerAsk: rows.length === 0 ? null : Math.round((100 * rows.reduce((n, r) => n + r.runs, 0)) / rows.length) / 100,
    toolsP50:
      rows.length === 0
        ? null
        : percentile(
            rows.map((r) => r.tools),
            0.5,
          ),
  };
}

const bucketOf = (at: Date, bucket: (typeof ASK_TIME_BUCKETS)[number]) =>
  `${at.toISOString().slice(0, bucket === "hour" ? 13 : 10)}${bucket === "hour" ? ":00:00Z" : "T00:00:00Z"}`;

function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const r of rows) getOrMake(groups, key(r), () => []).push(r);
  return groups;
}

/** The operator's answer from the asks read: overall, per kind, per brain and model, and per hour or day. */
export function askTimes(rows: readonly AskRow[], bucket: (typeof ASK_TIME_BUCKETS)[number], now: Date) {
  const byKind = groupBy(rows, askKindOf);
  const byModel = [...groupBy(rows, (r) => r.model ?? "none")].sort((a, b) => b[1].length - a[1].length);
  const buckets = [...groupBy(rows, (r) => bucketOf(r.asked, bucket))].sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    totals: askMeasures(rows, now),
    kinds: ASK_KINDS.map((kind) => ({
      kind,
      targetMs: ASK_TARGET_MS[kind],
      ...askMeasures(byKind.get(kind) ?? [], now),
    })),
    brains: [
      ...groupBy(rows, (r) => (r.brain && (BRAIN_KINDS as readonly string[]).includes(r.brain) ? r.brain : "other")),
    ]
      .map(([brain, list]) => ({ brain, ...askMeasures(list, now) }))
      .sort((a, b) => b.asks - a.asks),
    models: byModel.slice(0, ASK_MODELS_MAX).map(([model, list]) => ({ model, ...askMeasures(list, now) })),
    modelsMore: byModel.length > ASK_MODELS_MAX,
    series: buckets.flatMap(([at, list]) => {
      const kinds = groupBy(list, askKindOf);
      return [
        { at, kind: "all" as const, ...askMeasures(list, now) },
        ...ASK_KINDS.flatMap((kind) => {
          const own = kinds.get(kind);
          return own ? [{ at, kind, ...askMeasures(own, now) }] : [];
        }),
      ];
    }),
  };
}

export interface AskTimesQuery {
  /** ISO 8601 instants: asks made at or after `from` and before `to`. */
  from: string;
  to: string;
  bucket?: (typeof ASK_TIME_BUCKETS)[number];
  /** One workspace's asks; across workspaces without it. */
  orgId?: string;
}

/** The asks people made in a window, read whole (a busy week across workspaces is some tens of thousands). */
export async function readAsks(db: Database, query: { from: string; to: string; orgId?: string }): Promise<AskRow[]> {
  const org = query.orgId ? sql`and ar.org_id = ${query.orgId}` : sql``;
  const rows = rowsOf<Record<string, unknown>>(
    await heavyRead(
      db,
      sql`
      with r as materialized (
        select ar.id, coalesce(ar.stretch_id, ar.trigger_message_id) as ask, ar.created_at, ar.finished_at,
          ar.status::text as status, ar.error, ar.brain, ar.agent_id, ar.work_id,
          (select min(m.created_at) from messages m where m.agent_run_id = ar.id
            and m.created_at >= ar.created_at - interval '1 minute' and m.created_at < ar.created_at + interval '2 days'
            and coalesce(m.meta->>'bodyCode', '') !~ ${NOT_A_REPLY}) as said,
          (select s.created_at from agent_run_steps s where s.run_id = ar.id and s.kind = 'tool_call'
            order by s.seq limit 1) as tool1,
          (select count(*) from agent_run_steps s where s.run_id = ar.id and s.kind = 'tool_call')::int as tools
        from agent_runs ar
        where ar.created_at >= ${query.from}::timestamptz and ar.created_at < ${query.to}::timestamptz
          and not ar.background ${org}
      ), a as (
        select ask, min(created_at) as first_at, (array_agg(id order by created_at))[1] as first_id,
          (array_agg(brain order by created_at))[1] as brain,
          count(*)::int as runs, count(distinct agent_id)::int as agents, sum(tools)::int as tools,
          min(said) as said, min(least(said, tool1)) as active,
          bool_or(status in ('queued', 'running', 'waiting_approval', 'waiting_input')) as live,
          array_agg(distinct work_id) filter (where work_id is not null) as works, max(finished_at) as finished,
          (array_agg(status order by finished_at desc nulls first))[1] as last_status,
          (array_agg(error order by finished_at desc nulls first))[1] as last_error
        from r group by ask
      )
      select q.asked, k.kind, q.chars, a.runs, a.agents, a.tools, a.brain, a.last_status, a.last_error,
        (select case when u.model ~ ${MODEL_SQL} then u.model end from usage_records u
          where u.run_id = a.first_id and u.kind = 'agent' and u.provider <> 'web' order by u.created_at limit 1) as model,
        extract(epoch from (a.active - q.asked)) * 1000 as activity_ms,
        extract(epoch from (a.said - q.asked)) * 1000 as reply_ms,
        a.live or coalesce(w.open, false) as open,
        case when not (a.live or coalesce(w.open, false))
          then extract(epoch from (greatest(a.finished, w.finished) - q.asked)) * 1000 end as done_ms
      from a
      join lateral (
        select m.created_at as asked, char_length(m.body) as chars from messages m
        where m.id = a.ask and m.author_type = 'person' and m.created_at >= ${query.from}::timestamptz
          and m.created_at <= a.first_at + interval '1 minute' and m.created_at > a.first_at - interval '1 day'
        limit 1
      ) q on true
      left join ask_kinds k on k.message_id = a.ask
      left join lateral (
        select bool_or(w.finished_at is null) as open, max(w.finished_at) as finished from agent_works w
        where w.id = any(a.works)
      ) w on a.works is not null`,
    ),
  );
  const ms = (v: unknown) => (v === null || v === undefined ? null : Math.max(0, Math.round(Number(v))));
  return rows.map((r) => ({
    asked: new Date(r.asked as string | Date),
    kind: typeof r.kind === "string" ? r.kind : null,
    chars: r.chars === null || r.chars === undefined ? null : Number(r.chars),
    runs: Number(r.runs),
    agents: Number(r.agents),
    tools: Number(r.tools ?? 0),
    brain: typeof r.brain === "string" ? r.brain : null,
    // A custom endpoint's model is named by the workspace: only that it was one leaves.
    model: typeof r.model === "string" ? (r.model.startsWith("custom:") ? "custom" : r.model) : null,
    activityMs: ms(r.activity_ms),
    replyMs: ms(r.reply_ms),
    doneMs: ms(r.done_ms),
    open: r.open === true,
    lastStatus: typeof r.last_status === "string" ? r.last_status : null,
    lastError: typeof r.last_error === "string" ? r.last_error : null,
  }));
}

/**
 * Time per task for the operator (`GET /analytics/asks`): the asks people made in a window, across workspaces or in
 * one, with the speed index and the times to first activity, first reply and done, overall, per kind, per brain and
 * model, and per hour or day. Counts and times only: no message, no name.
 */
export async function operatorAskTimes(db: Database, query: AskTimesQuery, now = new Date()) {
  const [from, to] = [instantOf(query.from), instantOf(query.to)];
  const apart = from && to ? Date.parse(to) - Date.parse(from) : 0;
  if (!from || !to || apart <= 0 || apart > ASK_TIMES_MAX_DAYS * 86_400_000) {
    throw new ValidationError(
      `from and to are ISO 8601 instants, from before to, at most ${ASK_TIMES_MAX_DAYS} days apart`,
      "analytics.range",
    );
  }
  const bucket = query.bucket ?? "day";
  if (!ASK_TIME_BUCKETS.includes(bucket)) throw new ValidationError("bucket is hour or day");
  if (query.orgId !== undefined && !UUID.test(query.orgId)) throw new ValidationError("orgId is a workspace's id");
  const rows = await readAsks(db, { from, to, ...(query.orgId ? { orgId: query.orgId } : {}) });
  return { from, to, bucket, orgId: query.orgId ?? null, ...askTimes(rows, bucket, now) };
}
