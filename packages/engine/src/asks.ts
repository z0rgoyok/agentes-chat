import { type Database, schema } from "@agenteschat/db";
import { type Judge, type JudgeGroup, startJudgmentState } from "./judge";

/**
 * Time per task (ADR 0254): a person's message that starts agents' work is an ask, and its stretch (ADR 0089) is all
 * the work it set off, the hand-offs to other agents and their follow-ups included, until a person acts again. Jev reads
 * what kind of ask it is as its first run starts (`judgeAskKind`, in the run's start request); its times are read
 * back from the stretch's runs and messages (`operatorAskTimes`, `ask-times.ts`), nothing else is written.
 */

export const ASK_KINDS = ["chat", "question", "lookup", "action", "task", "project"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

const KIND_CRITERIA: Record<AskKind, string> = {
  chat: "A greeting, thanks, an acknowledgement or small talk: nothing to find out or do.",
  question: "A question it can answer from what it knows or what the conversation says, without looking anything up.",
  lookup: "Find, check or read something: a search, a file, a page, a record, a status, a calendar.",
  action: "Do one specific thing: send, create, change, schedule, post, approve or delete something.",
  task: "Work of several steps that takes minutes: research, a report, a document, code, an analysis, a plan.",
  project:
    "Long work that goes on for hours or in the background: a feature, a migration, a big investigation, a deploy pipeline, an ongoing duty.",
};

/** Jev's read of an ask's kind, kept only this sure; below it the kind is read from what the work did. */
export const ASK_KIND_SURE = 0.5;

/**
 * Jev reads what `message` asks of the agent, in any language, as one of `ASK_KINDS`. Calibrated only, beside the run
 * and never in its way: without Jev, or when it fails or isn't sure, null.
 */
export async function judgeAskKind(
  judge: Judge,
  input: {
    orgId: string;
    agentId: string;
    runId: string;
    agent: { name: string; role: string; instructions: string };
    message: string;
    recent: string[];
    group?: JudgeGroup;
  },
): Promise<{ kind: AskKind; p: number } | null> {
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "ask_kind",
    calibrated: true,
    ...(input.group ? { group: input.group } : {}),
    state: startJudgmentState(input),
    questions: {
      kind: {
        type: "choice",
        instructions:
          "A person wrote `message` to an AI agent of their team (`agent`; `recent` is what was said before). What does it ask the agent for? Judge by the work it needs, in any language, not by its length: a short go-ahead for work discussed in `recent` asks for that work.",
        criteria: KIND_CRITERIA,
      },
    },
  });
  const kind = answers.kind?.choice as AskKind | undefined;
  const p = kind ? answers.kind?.probabilities?.[kind] : undefined;
  return kind && ASK_KINDS.includes(kind) && typeof p === "number" && p >= ASK_KIND_SURE ? { kind, p } : null;
}

/** Keeps Jev's read of an ask: the first one, when several agents answer the same message. */
export async function recordAskKind(
  db: Database,
  input: { orgId: string; messageId: string; kind: AskKind; p: number },
) {
  await db.insert(schema.askKinds).values(input).onConflictDoNothing();
}
