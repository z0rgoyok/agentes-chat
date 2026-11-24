import { getTableColumns, schema, sql } from "@agenteschat/db";

/**
 * The transcript's keys the `agent_runs_state` trigger copies to `agent_runs.state` on every write of the transcript
 * (migration 0331): where the run stands (its wait, an outage, its place in a computer's line, what it owes), all of
 * them small. Status reads and lists look at nothing else, so they never decompress the transcript, tens of KB a run.
 * Equal to the trigger's list: `run-state.test.ts` checks.
 */
export const RUN_STATE_KEYS = [
  "waitingForBrain",
  "outage",
  "roomAsk",
  "roomPeople",
  "roomAsked",
  "roomOrderSince",
  "roomWaitSince",
  "signInWait",
  "spill",
  "accountMove",
  "usageWait",
  "usagePause",
  "usageGrant",
  "catchUp",
  "catchUpTriage",
  "steeredBy",
  "answerOwed",
  "passListed",
  "requestMoot",
  "promptKey",
  "toolGroups",
  "autoModel",
] as const;

/**
 * A run's transcript for reading `RUN_STATE_KEYS` alone: its `state` copy, or, on a run whose transcript wasn't
 * written since the copy began (only finished runs), the transcript itself. Coalesce reads the transcript only then.
 * In a raw select over `agent_runs r` the same is `coalesce(r.state, r.transcript)`.
 */
export const runState = sql`coalesce(${schema.agentRuns.state}, ${schema.agentRuns.transcript})`;

const { transcript: _transcript, profiles: _profiles, ...columns } = getTableColumns(schema.agentRuns);

/** Every column of a run but its transcript and profiles, tens of KB each: what a lookup that reads neither selects. */
export const runColumns = columns;
export type RunRow = Omit<typeof schema.agentRuns.$inferSelect, "transcript" | "profiles">;
