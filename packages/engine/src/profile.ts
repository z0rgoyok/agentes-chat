import type { BrainTurnTimings } from "@agenteschat/adapters";
import { currentQueryCount } from "@agenteschat/db";

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
  const mark = (stage: string) => {
    const now = performance.now();
    const q = currentQueryCount();
    stages.push({ stage, ms: round(now - at), queries: q - queries, ...(parts.length > 0 ? { parts } : {}) });
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
    /** The run it profiles, once claimed: its profile is kept with it. */
    run: undefined as { id: string; orgId: string; agentId: string } | undefined,
    total: () => ({
      ms: round(stages.reduce((n, s) => n + s.ms, 0)),
      queries: stages.reduce((n, s) => n + s.queries, 0),
    }),
  };
}
