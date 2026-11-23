import type { BrainPickOption } from "@agenteschat/client/lib/brain-picker";
import { useSyncExternalStore } from "react";
import { pickStore } from "./pick-store";

/**
 * "Quem pensa" for a new agent, chosen on its own pushed screen (`agent-brain`): every model and plan the agent's page
 * offers, the one chosen now, and how the choice goes back to "Create agent".
 */
export interface BrainPick {
  options: readonly BrainPickOption[];
  value: string | undefined;
  apply: (option: BrainPickOption) => void;
}

const store = pickStore<BrainPick>();

export const openBrainPick = store.open;
export const closeBrainPick = store.close;

/** One chosen on the screen: back to the form. */
export function chooseBrain(option: BrainPickOption) {
  const pick = store.now();
  if (!pick) return;
  pick.apply(option);
  store.update((p) => ({ ...p, value: option.value }));
}

export function useBrainPick(): BrainPick | null {
  return useSyncExternalStore(store.subscribe, store.now);
}
