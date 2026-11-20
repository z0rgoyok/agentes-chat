import { useSyncExternalStore } from "react";

/**
 * An agent picked on its own pushed screen (ADR 0135: screens, never sheets): the agent picked now and how a choice
 * goes back to the form that pushed the screen (New widget's "Who looks after it", a routine's agent, the agent a
 * plan is for in Connect an AI). The form starts it before pushing and ends it when it closes, as "Who edits
 * › Some roles…" shares its draft (`edit-roles.ts`): a route can't carry a callback.
 */
export interface AgentPick {
  agentId: string | null;
  apply: (agentId: string) => void;
  /** The screen's title (default: New widget's "Who looks after it"). */
  title?: string;
  /** The line under the list (default: the widget's note); "" for none. */
  note?: string;
  /** Every agent of the workspace, not only those the person can talk to (a routine's agent). */
  everyone?: boolean;
  /**
   * Only these agents, in this order (Connect an AI's agents a plan may think for: the person's own), whoever else the
   * workspace has.
   */
  ids?: readonly string[];
}

let current: AgentPick | null = null;
const listeners = new Set<() => void>();

function set(next: AgentPick | null) {
  current = next;
  for (const listener of listeners) listener();
}

export function openAgentPick(pick: AgentPick) {
  set(pick);
}

/** An agent chosen on the screen: back to the form at once. */
export function chooseAgent(agentId: string) {
  if (!current) return;
  current.apply(agentId);
  set({ ...current, agentId });
}

export function closeAgentPick() {
  set(null);
}

export const agentPickNow = (): AgentPick | null => current;

export function useAgentPick(): AgentPick | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
  );
}
