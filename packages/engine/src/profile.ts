import type { BrainTurnTimings } from "@agenteschat/adapters";
import { currentQueryCount } from "@agenteschat/db";
import type { TurnTrace } from "./turn-trace";

export interface StageTiming {
  stage: string;
  ms: number;
  /** SQL statements issued during the stage (in this async context). */
  queries: number;
  /** Back-to-back steps from the stage's start (`part`); whatever of `ms` they leave came after the last one. */
  parts?: StageTiming[];
}

/** Splits a unit of work into timed stages with their query counts (per-run breakdown at debug level). */
export function createProfiler() {
  const stages: StageTiming[] = [];
  /** Each computer turn's own timings, as the runner said them. */
  const brain: BrainTurnTimings[] = [];
  const startedAt = Date.now();
  let parts: StageTiming[] = [];
  let at = performance.now();
  let queries = currentQueryCount();
  let partAt = at;
  let partQueries = queries;
  const round = (ms: number) => Math.round(ms * 10) / 10;
  /** `own`: the stage's steps as worked out by its caller (a computer turn's, `computerTurnParts`), not `part`'s. */
  const mark = (stage: string, own?: (ms: number) => StageTiming[]) => {
    const now = performance.now();
    const q = currentQueryCount();
    const ms = round(now - at);
    const steps = own ? own(ms) : parts;
    stages.push({ stage, ms, queries: q - queries, ...(steps.length > 0 ? { parts: steps } : {}) });
    parts = [];
    at = partAt = now;
    queries = partQueries = q;
  };
  return {
    mark,
    /** A step inside the stage the next `mark` closes, timed from the previous step or the stage's start. */
    part(step: string) {
      const now = performance.now();
      const q = currentQueryCount();
      parts.push({ stage: step, ms: round(now - partAt), queries: q - partQueries });
      partAt = now;
      partQueries = q;
    },
    /** The time since the last mark as an `end` stage, so the stages add up to the whole unit of work. */
    end() {
      if (stages.length > 0) mark("end");
    },
    /** A stage timed elsewhere that came before this unit of work (the router, a wait for room): listed first.
     * Never negative: it may have been timed against another server's clock. */
    before(stage: string, ms: number) {
      stages.unshift({ stage, ms: Math.max(0, round(ms)), queries: 0 });
    },
    /** When this unit of work started (epoch ms). */
    startedAt,
    stages,
    brain,
    /** Every brain turn of the claim as the server saw it (`turnRecorder`). */
    turns: [] as TurnTrace[],
    /** Sources of tools that were slow to list theirs (`ToolContext.slowSource`). */
    slowSources: [] as { source: string; ms: number }[],
    /** The computer its turns ran on (or were refused by): speed split by computer, and by host where it is known. */
    machineId: undefined as string | undefined,
    /** The run it profiles, once claimed: its profile is kept with it. */
    run: undefined as { id: string; orgId: string; agentId: string } | undefined,
    total: () => ({
      ms: round(stages.reduce((n, s) => n + s.ms, 0)),
      queries: stages.reduce((n, s) => n + s.queries, 0),
    }),
  };
}

/** A stretch of time something ran, from and to in ms on one clock. */
export interface Span {
  from: number;
  to: number;
}

/** How long at least one of `spans` was running: two calls at the same time count once. */
export function spanUnionMs(spans: readonly Span[]) {
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const { from, to } of [...spans].sort((a, b) => a.from - b.from)) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

/**
 * A computer turn's `model` stage in its steps, named as the operator's breakdown groups them: the agent's checkouts
 * updated before it (`pre_turn_sync`, the `code` phase), a new CLI process until ready or the runner's wait for an
 * open one (`cli_init`), ready to the model API's first streamed message (`cli_first_byte`), the tools it ran
 * (`tools`), and the rest, the model writing and the trips between (`model_write`). Durations from the runner's clock and the server's mix, never instants. Not
 * back to back: tools run while the model's turn goes on, so the steps are its shares of `ms`, the last one the rest.
 */
export function computerTurnParts(
  ms: number,
  turn: { syncMs: number; timings?: BrainTurnTimings | undefined; toolsMs: number },
): StageTiming[] {
  const round = (n: number) => Math.round(Math.max(0, n) * 10) / 10;
  // Until the CLI could start the turn: a new process ready, or the runner's own waits for an open one (`sentMs`).
  const init = Math.max(turn.timings?.warm === false ? (turn.timings.initMs ?? 0) : 0, turn.timings?.sentMs ?? 0);
  const first = turn.timings?.firstTokenMs ?? turn.timings?.firstEventMs;
  const known = [
    { stage: "pre_turn_sync", ms: round(turn.syncMs) },
    { stage: "cli_init", ms: round(init) },
    { stage: "cli_first_byte", ms: first === undefined ? 0 : round(first - init) },
    { stage: "tools", ms: round(turn.toolsMs) },
  ];
  let left = ms;
  const shares = known.flatMap((p) => {
    const share = round(Math.min(p.ms, left));
    left -= share;
    return share > 0 ? [{ ...p, ms: share, queries: 0 }] : [];
  });
  return [...shares, { stage: "model_write", ms: round(left), queries: 0 }];
}
