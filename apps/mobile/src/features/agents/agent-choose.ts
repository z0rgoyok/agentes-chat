import { useSyncExternalStore } from "react";
import { pickStore } from "./pick-store";

/**
 * Agents chosen on their own pushed screen (`agent-choose`), for a form on an agent's pages: who it reports to (one,
 * or nobody), which agents it may call (several, each saved on the tap). The agents offered are the form's own, in its
 * order, so a choice the server would refuse is never listed.
 */
export interface AgentChoose {
  title: string;
  /** The agents offered, in the order shown. */
  ids: readonly string[];
  /** The ones chosen now. */
  picked: readonly string[];
  /** Several at once, each tap saved; otherwise a tap chooses and goes back. */
  multi?: boolean;
  /** A first row that chooses nobody ("Ninguém"), for a single choice. */
  none?: string;
  /** The line under the list. */
  note?: string;
  apply: (ids: string[]) => void;
}

const store = pickStore<AgentChoose>();

export const openAgentChoose = store.open;
export const closeAgentChoose = store.close;

/** A tap on the screen: a single choice goes back to the form; several stay, the list as it is now. */
export function chooseAgents(ids: string[]) {
  const pick = store.now();
  if (!pick) return;
  pick.apply(ids);
  store.update((p) => ({ ...p, picked: ids }));
}

export function useAgentChoose(): AgentChoose | null {
  return useSyncExternalStore(store.subscribe, store.now);
}
