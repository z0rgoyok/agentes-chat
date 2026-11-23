/**
 * Who made a change to a live document (ADR 0196 §6). Every mutation runs in `doc.transact(fn, origin)`, so observers
 * and the server know where it came from, and undo in the apps only ever takes back the person's own changes: the
 * apps' `Y.UndoManager` tracks `LOCAL` alone, by identity, never a change from the network or an agent.
 */
export interface LiveOrigin {
  kind: "local" | "remote" | "agent" | "system";
  userId?: string;
  agentId?: string;
  runId?: string;
}

/** The app's own edits (the person at this screen). */
export const LOCAL: LiveOrigin = Object.freeze({ kind: "local" as const });

/** Changes applied from the network. */
export const REMOTE: LiveOrigin = Object.freeze({ kind: "remote" as const });

/** Server jobs: generated images, a version restored, an import. */
export const SYSTEM: LiveOrigin = Object.freeze({ kind: "system" as const });

/** An agent's tool call, with the run it belongs to. */
export function agentOrigin(agentId: string, runId?: string): LiveOrigin {
  return runId ? { kind: "agent", agentId, runId } : { kind: "agent", agentId };
}

const KINDS: readonly string[] = ["local", "remote", "agent", "system"];

/** Whether a transaction's origin is one of ours (Yjs passes anything through). */
export function isLiveOrigin(value: unknown): value is LiveOrigin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    KINDS.includes((value as { kind: string }).kind)
  );
}
