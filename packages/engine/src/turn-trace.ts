import { type BrainTurnTimings, cliReadyMs, SLOW_TURN_BUDGETS } from "@agenteschat/adapters";
import type { BrainEvent, BrainPhase } from "./brains/types";
import type { StageTiming } from "./profile";

/**
 * One brain turn as the server saw it (any brain, the model's API too), kept with its claim's profile: when it began in
 * the claim, how long it took and how it ended, the work before the model (`code`: the agent's checkouts), its first
 * event and first text, the calls the brain ran itself, what its runner said of it (`runner`, `BrainTurnTimings`, with
 * the CLI's evidence for a slow or failed turn), and a computer brain's system text by its blocks (`agentSystemParts`).
 * Times are the server's, in ms from the turn's start, so they hold for every brain and every runner.
 */
export interface TurnTrace {
  brain: string;
  /** The model it asked for, where it named one. */
  model?: string;
  /** From the claim's start. */
  at: number;
  ms: number;
  /** `done`, or the code it failed with (`thrown`: no brain's code). */
  end: string;
  preTurnMs?: number;
  firstEventMs?: number;
  firstTextMs?: number;
  /** Calls the brain ran itself: how many, and the time of those it said it started (`tool_started`). */
  tools?: { count: number; ms: number; maxMs: number };
  runner?: BrainTurnTimings;
  system?: Record<string, string>;
}

/** A budget of `SLOW_TURN_BUDGETS` a claim broke, and what took the time. */
export interface SlowMark {
  stage: "context" | "pre_turn" | "init" | "first_byte" | "reply";
  ms: number;
  budgetMs: number;
  cause: string;
  /** The turn it is of, from 1. */
  turn?: number;
}

/** Records one turn's events as they pass (`event`), and its pre-turn phase (`phase`). */
export function turnRecorder(brain: string, claimStartedAt: number, now = () => Date.now()) {
  const start = now();
  let phaseAt: number | null = null;
  let preTurn = 0;
  let firstEvent: number | undefined;
  let firstText: number | undefined;
  let runner: BrainTurnTimings | undefined;
  const started = new Map<string, number>();
  const tools = { count: 0, ms: 0, maxMs: 0 };
  const phase = (on: BrainPhase | null) => {
    if (on) phaseAt ??= now();
    else if (phaseAt !== null) {
      preTurn += now() - phaseAt;
      phaseAt = null;
    }
  };
  return {
    phase,
    event(event: BrainEvent) {
      const at = now() - start;
      if (event.type !== "error") firstEvent ??= at;
      if (event.type === "text_delta") firstText ??= at;
      else if (event.type === "tool_started") started.set(event.id, now());
      else if (event.type === "tool_call" && event.executed) {
        tools.count++;
        const from = started.get(event.id);
        if (from !== undefined) {
          started.delete(event.id);
          tools.ms += now() - from;
          tools.maxMs = Math.max(tools.maxMs, now() - from);
        }
      } else if ((event.type === "done" || event.type === "error") && event.timings) runner = event.timings;
    },
    finish(end: string, also: { model?: string; system?: Record<string, string> } = {}): TurnTrace {
      phase(null);
      return {
        brain,
        ...(also.model ? { model: also.model } : {}),
        at: Math.max(0, start - claimStartedAt),
        ms: now() - start,
        end,
        ...(preTurn > 0 ? { preTurnMs: preTurn } : {}),
        ...(firstEvent !== undefined ? { firstEventMs: firstEvent } : {}),
        ...(firstText !== undefined ? { firstTextMs: firstText } : {}),
        ...(tools.count > 0 ? { tools } : {}),
        ...(runner ? { runner } : {}),
        ...(also.system ? { system: also.system } : {}),
      };
    },
  };
}

/** A stage's name without the turn it is of (`model#2` → `model`). */
const stageName = (stage: string) => stage.replace(/#\d+$/, "");

/**
 * The budgets a claim broke (`SLOW_TURN_BUDGETS`): its context, and in each turn the work before it, a new CLI's
 * start, and the first token once the CLI was ready (a CLI's own measure where its runner gave one, else the first
 * text the server saw after the work before it); a reply of one turn with no call, from the claim's start to its end.
 */
export function slowMarks(
  stages: readonly StageTiming[],
  turns: readonly TurnTrace[],
  slowSources: readonly { source: string; ms: number }[] = [],
): SlowMark[] {
  const b = SLOW_TURN_BUDGETS;
  const marks: SlowMark[] = [];
  // Listing the tools waits on the slowest of their sources: it names the cause (`tools_granted.connectors`).
  const source = [...slowSources].sort((x, y) => y.ms - x.ms)[0]?.source;
  for (const s of stages) {
    if (stageName(s.stage) !== "context" || s.ms <= b.contextMs) continue;
    const top = [...(s.parts ?? [])].sort((x, y) => y.ms - x.ms)[0]?.stage;
    const cause = top === "tools_granted" && source ? `${top}.${source}` : (top ?? "context");
    marks.push({ stage: "context", ms: Math.round(s.ms), budgetMs: b.contextMs, cause });
  }
  turns.forEach((t, i) => {
    const turn = i + 1;
    const r = t.runner;
    if ((t.preTurnMs ?? 0) > b.preTurnMs)
      marks.push({ stage: "pre_turn", ms: t.preTurnMs ?? 0, budgetMs: b.preTurnMs, cause: "checkouts", turn });
    // The runner's own waits before it handed the turn to its CLI (`sentMs`): ours, never the API's.
    if (r?.sentMs !== undefined && r.sentMs > b.preTurnMs)
      marks.push({
        stage: "pre_turn",
        ms: r.sentMs,
        budgetMs: b.preTurnMs,
        cause: r.warm ? "runner_wait" : "spawn",
        turn,
      });
    if (r?.initMs !== undefined && r.initMs > b.initMs)
      marks.push({ stage: "init", ms: r.initMs, budgetMs: b.initMs, cause: r.cold ?? "cold", turn });
    const firstByte =
      r?.firstTokenMs !== undefined
        ? r.firstTokenMs - cliReadyMs(r)
        : t.firstTextMs !== undefined || t.firstEventMs !== undefined
          ? (t.firstTextMs ?? t.firstEventMs ?? 0) - (t.preTurnMs ?? 0)
          : t.end === "done"
            ? undefined
            : t.ms - (t.preTurnMs ?? 0);
    if (firstByte !== undefined && firstByte > b.firstByteMs) {
      const cause =
        t.end !== "done" && r?.firstTokenMs === undefined ? t.end : (r?.retries ?? 0) > 0 ? "api_retry" : "wait";
      marks.push({ stage: "first_byte", ms: Math.round(firstByte), budgetMs: b.firstByteMs, cause, turn });
    }
  });
  const total = stages.reduce((n, s) => n + s.ms, 0);
  const only = turns.length === 1 ? turns[0] : undefined;
  if (only?.end === "done" && !only.tools && total > b.replyMs) {
    const top = [...stages].sort((x, y) => y.ms - x.ms)[0];
    marks.push({ stage: "reply", ms: Math.round(total), budgetMs: b.replyMs, cause: stageName(top?.stage ?? "model") });
  }
  return marks;
}
