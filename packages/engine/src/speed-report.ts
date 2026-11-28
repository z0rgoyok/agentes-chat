import { type Executor, rowsOf, sql } from "@agenteschat/db";
import { percentile } from "./format";

/**
 * Time per kind of work, for the people who run the server (`bun run report:speed`): the person-started runs of a
 * window (one brain's, or every one's), each sorted by what it turned out to be, and where their time went. Reads only.
 *
 * What a message was is read from what its run did, not guessed from its words: a greeting (a short message, no
 * tool), a quick answer (no tool), a lookup (1 to 3 tool calls) or a task (4 or more). The felt time is the person's
 * wait: from their message to the run's end, which is when its reply is in place.
 */

export const SPEED_CLASSES = ["greeting", "quick", "lookup", "task"] as const;
export type SpeedClass = (typeof SPEED_CLASSES)[number];

/** A message this short that needed no tool is a greeting ("oi", "bom dia", "thanks!"). */
export const GREETING_MAX_CHARS = 15;
/** At most this many tool calls is a lookup; more is a task. */
export const LOOKUP_MAX_TOOLS = 3;

export interface SpeedRun {
  id: string;
  orgId: string;
  brain: string;
  model: string | null;
  triggerChars: number | null;
  tools: number;
  /** The person's message to the run's end. */
  feltMs: number | null;
  /** The run's own claims, the context it built and its model stages (turns on a computer included). */
  totalMs: number | null;
  contextMs: number | null;
  modelMs: number | null;
  /** The first computer turn: started on a process already open, or why not; its start and first byte. */
  warm: boolean | null;
  cold: string | null;
  initMs: number | null;
  firstTokenMs: number | null;
  firstAssistantMs: number | null;
  /** Tokens of its plan's calls: uncached input, read from and written to the cache, output. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export const speedClassOf = (r: Pick<SpeedRun, "tools" | "triggerChars">): SpeedClass =>
  r.tools === 0
    ? r.triggerChars !== null && r.triggerChars <= GREETING_MAX_CHARS
      ? "greeting"
      : "quick"
    : r.tools <= LOOKUP_MAX_TOOLS
      ? "lookup"
      : "task";

export interface SpeedRange {
  from: string;
  to: string;
  orgId?: string | null;
  /** `claude_code`, `codex`, `model`...: that brain's runs alone. */
  brain?: string | null;
}

/** Runs the window holds, read whole: a week of a busy server is some tens of thousands of rows. */
export async function speedRuns(db: Executor, range: SpeedRange): Promise<SpeedRun[]> {
  const org = range.orgId ? sql`and ar.org_id = ${range.orgId}` : sql``;
  const brain = range.brain ? sql`and ar.brain = ${range.brain}` : sql``;
  const ms = (path: string) => sql.raw(`(${path})::numeric`);
  const rows = rowsOf<Record<string, string | number | boolean | null>>(
    await db.execute(sql`
      with r as (
        select ar.id, ar.org_id, ar.brain, ar.created_at, ar.finished_at, ar.trigger_message_id,
          ar.profiles -> -1 as p
        from agent_runs ar
        where ar.created_at >= ${range.from} and ar.created_at < ${range.to} ${org} ${brain}
          and ar.status = 'done' and not ar.background
          and jsonb_typeof(ar.profiles) = 'array' and jsonb_array_length(ar.profiles) > 0
      )
      select r.id, r.org_id, r.brain,
        ${ms("r.p -> 'total' ->> 'ms'")} as total_ms,
        (select sum((e ->> 'ms')::numeric) from jsonb_array_elements(r.p -> 'stages') e
          where e ->> 'stage' = 'context') as context_ms,
        (select sum((e ->> 'ms')::numeric) from jsonb_array_elements(r.p -> 'stages') e
          where e ->> 'stage' like 'model#%') as model_ms,
        r.p -> 'brain' -> 0 ->> 'warm' as warm,
        r.p -> 'brain' -> 0 ->> 'cold' as cold,
        ${ms("r.p -> 'brain' -> 0 ->> 'initMs'")} as init_ms,
        ${ms("r.p -> 'brain' -> 0 ->> 'firstTokenMs'")} as first_token_ms,
        ${ms("r.p -> 'brain' -> 0 ->> 'firstAssistantMs'")} as first_assistant_ms,
        (select count(*) from agent_run_steps s where s.run_id = r.id and s.kind = 'tool_call') as tools,
        m.chars as trigger_chars,
        extract(epoch from (r.finished_at - m.created_at)) * 1000 as felt_ms,
        u.model, u.input, u.cache_read, u.cache_write, u.output
      from r
      left join lateral (
        select length(body) as chars, created_at from messages
        where id = r.trigger_message_id and created_at >= ${range.from}::timestamptz - interval '1 day'
          and created_at < ${range.to}
      ) m on true
      left join lateral (
        select max(model) as model, coalesce(sum(input_tokens), 0) as input,
          coalesce(sum(cache_read_tokens), 0) as cache_read, coalesce(sum(cache_write_tokens), 0) as cache_write,
          coalesce(sum(output_tokens), 0) as output
        from usage_records where run_id = r.id and billed_to = 'plan'
      ) u on true
    `),
  );
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  return rows.map((r) => ({
    id: String(r.id),
    orgId: String(r.org_id),
    brain: r.brain ? String(r.brain) : "none",
    model: r.model ? String(r.model) : null,
    triggerChars: num(r.trigger_chars),
    tools: Number(r.tools ?? 0),
    feltMs: num(r.felt_ms),
    totalMs: num(r.total_ms),
    contextMs: num(r.context_ms),
    modelMs: num(r.model_ms),
    warm: r.warm === "true" ? true : r.warm === "false" ? false : null,
    cold: r.cold ? String(r.cold) : null,
    initMs: num(r.init_ms),
    firstTokenMs: num(r.first_token_ms),
    firstAssistantMs: num(r.first_assistant_ms),
    input: Number(r.input ?? 0),
    cacheRead: Number(r.cache_read ?? 0),
    cacheWrite: Number(r.cache_write ?? 0),
    output: Number(r.output ?? 0),
  }));
}

export interface SpeedSummary {
  kind: SpeedClass;
  runs: number;
  feltP50: number | null;
  feltP90: number | null;
  contextP50: number | null;
  modelP50: number | null;
  /** Share of first computer turns that started a process (of those that said). */
  coldShare: number | null;
  initP50: number | null;
  /** The first computer turn's start to the model's first byte. */
  firstByteP50: number | null;
  /**
   * A one-turn run without tools: its model stage past the runner's first answer. Nearly all of it is waiting before
   * the turn reached the computer (the checkouts' sync) and after it ended there, not the model.
   */
  outsideTurnP50: number | null;
  outsideTurnP90: number | null;
  /** Share of prompt tokens read from the cache, the median run's. */
  cacheHitP50: number | null;
  promptTokensP50: number | null;
  outputTokensP50: number | null;
  toolsP50: number | null;
}

const p = (values: (number | null)[], q: number) => {
  const kept = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return kept.length === 0 ? null : percentile(kept, q);
};

export function speedSummary(runs: readonly SpeedRun[]): SpeedSummary[] {
  return SPEED_CLASSES.flatMap((kind) => {
    const g = runs.filter((r) => speedClassOf(r) === kind);
    if (g.length === 0) return [];
    const said = g.filter((r) => r.warm !== null);
    const cold = said.filter((r) => r.warm === false);
    const prompt = (r: SpeedRun) => r.input + r.cacheRead + r.cacheWrite;
    const oneTurn = g.filter((r) => r.tools === 0 && r.modelMs !== null && r.firstAssistantMs !== null);
    return [
      {
        kind,
        runs: g.length,
        feltP50: p(
          g.map((r) => r.feltMs),
          0.5,
        ),
        feltP90: p(
          g.map((r) => r.feltMs),
          0.9,
        ),
        contextP50: p(
          g.map((r) => r.contextMs),
          0.5,
        ),
        modelP50: p(
          g.map((r) => r.modelMs),
          0.5,
        ),
        coldShare: said.length === 0 ? null : cold.length / said.length,
        initP50: p(
          cold.map((r) => r.initMs),
          0.5,
        ),
        firstByteP50: p(
          said.map((r) => r.firstTokenMs),
          0.5,
        ),
        outsideTurnP50: p(
          oneTurn.map((r) => (r.modelMs as number) - (r.firstAssistantMs as number)),
          0.5,
        ),
        outsideTurnP90: p(
          oneTurn.map((r) => (r.modelMs as number) - (r.firstAssistantMs as number)),
          0.9,
        ),
        cacheHitP50: p(
          g.map((r) => (prompt(r) > 0 ? r.cacheRead / prompt(r) : null)),
          0.5,
        ),
        promptTokensP50: p(
          g.map((r) => (prompt(r) > 0 ? prompt(r) : null)),
          0.5,
        ),
        outputTokensP50: p(
          g.map((r) => r.output),
          0.5,
        ),
        toolsP50: p(
          g.map((r) => r.tools),
          0.5,
        ),
      },
    ];
  });
}

/** Why first computer turns started a process, most first (`null`: a runner too old to say). */
export function coldCauses(runs: readonly SpeedRun[]): { cause: string; turns: number }[] {
  const counts = new Map<string, number>();
  for (const r of runs) {
    if (r.warm !== false) continue;
    const cause = r.cold ?? "unsaid";
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return [...counts].map(([cause, turns]) => ({ cause, turns })).sort((a, b) => b.turns - a.turns);
}

export interface PreTurnSync {
  turns: number;
  /** Turns a checkouts' sync of the same computer ended right before. */
  synced: number;
  over5s: number;
  over15s: number;
  /** Seconds turns waited on those syncs, and on the ones where a repository failed (a timeout, mostly). */
  waitedSec: number;
  waitedOnFailedSec: number;
}

/**
 * How long computer turns waited on the checkouts' sync before them (`git.sync` right before `brain.turn`), from the
 * requests that crossed replicas (`machine_rpc`, kept about an hour): a sample, not every turn.
 */
export async function preTurnSyncs(db: Executor): Promise<PreTurnSync> {
  const [row] = rowsOf<Record<string, string | number | null>>(
    await db.execute(sql`
      with t as (
        select machine_id, created_at from machine_rpc where request ->> 'op' = 'brain.turn'
      ), s as (
        select machine_id, created_at, replied_at,
          (select count(*) from jsonb_array_elements(
            case when jsonb_typeof(reply -> 'data' -> 'repos') = 'array' then reply -> 'data' -> 'repos' else '[]' end
          ) x where x ->> 'status' = 'failed') as failed
        from machine_rpc where request ->> 'op' = 'git.sync' and replied_at is not null
      )
      select count(*) as turns, count(y.ms) as synced,
        count(*) filter (where y.ms >= 5000) as over5s, count(*) filter (where y.ms >= 15000) as over15s,
        coalesce(sum(y.ms), 0) / 1000 as waited_sec,
        coalesce(sum(y.ms) filter (where y.failed > 0), 0) / 1000 as waited_on_failed_sec
      from t left join lateral (
        select extract(epoch from (s.replied_at - s.created_at)) * 1000 as ms, s.failed from s
        where s.machine_id = t.machine_id and s.replied_at <= t.created_at + interval '1 second'
          and s.replied_at > t.created_at - interval '3 seconds'
        order by s.replied_at desc limit 1
      ) y on true
    `),
  );
  const n = (v: unknown) => Math.round(Number(v ?? 0));
  return {
    turns: n(row?.turns),
    synced: n(row?.synced),
    over5s: n(row?.over5s),
    over15s: n(row?.over15s),
    waitedSec: n(row?.waited_sec),
    waitedOnFailedSec: n(row?.waited_on_failed_sec),
  };
}

const sec = (ms: number | null) => (ms === null ? "-" : (ms / 1000).toFixed(1));
const pct = (share: number | null) => (share === null ? "-" : `${Math.round(share * 100)}%`);
const whole = (n: number | null) => (n === null ? "-" : String(Math.round(n)));

/** The operators' table: one row per kind of work, then why turns started cold and the syncs they waited on. */
export function speedTable(
  title: string,
  summary: readonly SpeedSummary[],
  causes: readonly { cause: string; turns: number }[],
  sync?: PreTurnSync,
): string {
  const head = [
    "kind",
    "runs",
    "felt p50",
    "felt p90",
    "context",
    "model",
    "cold",
    "init",
    "1st byte",
    "outside turn p50/p90",
    "cache hit",
    "prompt tok",
    "out tok",
    "tools",
  ];
  const rows = summary.map((s) => [
    s.kind,
    String(s.runs),
    sec(s.feltP50),
    sec(s.feltP90),
    sec(s.contextP50),
    sec(s.modelP50),
    pct(s.coldShare),
    sec(s.initP50),
    sec(s.firstByteP50),
    `${sec(s.outsideTurnP50)}/${sec(s.outsideTurnP90)}`,
    pct(s.cacheHitP50),
    whole(s.promptTokensP50),
    whole(s.outputTokensP50),
    whole(s.toolsP50),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ");
  return [
    title,
    "",
    line(head),
    ...rows.map(line),
    "",
    "Times in seconds, medians unless p90. felt: the person's message to the reply in place. outside turn: a one-turn",
    "run without tools, its model stage past the computer's first answer (the checkouts' sync before the turn, mostly).",
    "",
    `Cold starts by cause: ${causes.map((c) => `${c.cause} ${c.turns}`).join(", ") || "none"}`,
    ...(sync
      ? [
          `Checkouts' sync before a turn (last hour, cross-replica sample): ${sync.synced} of ${sync.turns} turns, ` +
            `${sync.over5s} waited 5 s or more, ${sync.over15s} 15 s or more; ${sync.waitedSec} s waited, ` +
            `${sync.waitedOnFailedSec} s of it on syncs where a repository failed.`,
        ]
      : []),
  ].join("\n");
}
