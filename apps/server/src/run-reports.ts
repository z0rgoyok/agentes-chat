import type { ErrorReporter, ReportedError } from "@agenteschat/adapters/error-reports";
import { scrubLogLine } from "@agenteschat/adapters/error-scrub";
import type { RunProfileReport, TurnTrace } from "@agenteschat/engine";

/** A turn that ended so on purpose: nothing went wrong. */
const NOT_FAILURES = new Set(["done", "canceled"]);

/** What a turn says of itself in a report: its brain, model, how it started, never a word of the conversation. */
function turnTags(turn: TurnTrace | undefined) {
  const r = turn?.runner;
  return {
    brain: turn?.brain,
    model: turn?.model,
    warm: r ? r.warm : undefined,
    cold: r?.cold,
  };
}

function turnContext(turn: TurnTrace | undefined) {
  if (!turn) return {};
  const { evidence, ...measures } = turn.runner ?? { warm: undefined };
  return {
    turn: {
      ms: turn.ms,
      end: turn.end,
      pre_turn_ms: turn.preTurnMs,
      first_event_ms: turn.firstEventMs,
      first_text_ms: turn.firstTextMs,
      tools: turn.tools?.count,
      tools_ms: turn.tools?.ms,
      ...measures,
    },
    // Scrubbed again: a computer's runner is the workspace's, and its lines reach the error server as sent.
    ...(evidence?.length ? { cli_log: { lines: evidence.map((line) => scrubLogLine(line)) } } : {}),
  };
}

const reported = (message: string, fields: Omit<ReportedError, "name" | "message">): ReportedError =>
  Object.assign(new Error(message), fields, { name: fields.level === "warning" ? "SlowTurn" : "BrainTurnFailed" });

/**
 * A claim's slow turns and failed brain turns as reports (`errors`), each grouped by what it is and not by its stack:
 * a slow one by its stage, cause and brain, a failed one by its brain and code. Tags hold ids, the brain, model and
 * how its CLI started, and its computer's runner protocol; contexts hold the turn's timings and its CLI's evidence.
 */
export async function reportRunProfile(
  errors: ErrorReporter,
  profile: RunProfileReport,
  runnerProtocol: (machineId: string) => Promise<number | undefined> = async () => undefined,
) {
  if (profile.slow.length === 0 && profile.turns.every((t) => NOT_FAILURES.has(t.end))) return;
  const protocol = profile.machineId ? await runnerProtocol(profile.machineId).catch(() => undefined) : undefined;
  const ids = {
    org_id: profile.orgId,
    agent_id: profile.agentId,
    run_id: profile.runId,
    machine_id: profile.machineId,
    runner_protocol: protocol,
  };
  for (const mark of profile.slow) {
    const turn = mark.turn ? profile.turns[mark.turn - 1] : profile.turns.at(-1);
    const brain = turn?.brain ?? "none";
    errors.capture(
      reported(`Slow ${mark.stage}: ${mark.cause} (${brain})`, {
        level: "warning",
        fingerprint: ["slow_turn", mark.stage, mark.cause, brain],
        contexts: { slow: { ms: mark.ms, budget_ms: mark.budgetMs, turn: mark.turn }, ...turnContext(turn) },
      }),
      { ...ids, ...turnTags(turn), stage: mark.stage, cause: mark.cause },
    );
  }
  for (const turn of profile.turns) {
    if (NOT_FAILURES.has(turn.end)) continue;
    errors.capture(
      reported(`Brain turn failed: ${turn.end} (${turn.brain})`, {
        level: "error",
        fingerprint: ["brain_turn_failed", turn.brain, turn.end],
        contexts: turnContext(turn),
      }),
      { ...ids, ...turnTags(turn), code: turn.end },
    );
  }
}
