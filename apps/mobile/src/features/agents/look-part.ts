import { useSyncExternalStore } from "react";
import type { FullLook } from "./edit";
import { pickStore } from "./pick-store";

/**
 * One part of an agent's look chosen on its own pushed screen (`agent-look`), from "Create agent" and "Edit agent":
 * the eyes or the accessory, each drawn on the agent as it looks now.
 */
export interface LookPart {
  part: "eyes" | "accessory";
  look: FullLook;
  apply: (next: FullLook) => void;
}

const store = pickStore<LookPart>();

export const openLookPart = store.open;
export const closeLookPart = store.close;

/** A part chosen on the screen: the form wears it, and the screen shows it checked as it goes back. */
export function chooseLook(next: FullLook) {
  const pick = store.now();
  if (!pick) return;
  pick.apply(next);
  store.update((p) => ({ ...p, look: next }));
}

export function useLookPart(): LookPart | null {
  return useSyncExternalStore(store.subscribe, store.now);
}
