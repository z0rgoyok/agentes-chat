import { useSyncExternalStore } from "react";
import { pickStore } from "../agents/pick-store";

/** One person a form offers: their name and a quieter line (their @ or e-mail). */
export interface PersonOption {
  userId: string;
  name: string;
  sub?: string;
}

/**
 * A person chosen on their own pushed screen (`person-choose`): who cares for a setor or stands in, someone added to
 * who talks to an agent. The people offered are the form's own; a choice goes back to it at once.
 */
export interface PersonChoose {
  title: string;
  people: readonly PersonOption[];
  /** The one chosen now. */
  picked: string | null;
  /** A first row that chooses nobody ("Ninguém"). */
  none?: string;
  apply: (userId: string | null) => void;
}

const store = pickStore<PersonChoose>();

export const openPersonChoose = store.open;
export const closePersonChoose = store.close;

/** A person (or nobody) chosen on the screen: back to the form. */
export function choosePerson(userId: string | null) {
  const pick = store.now();
  if (!pick) return;
  pick.apply(userId);
  store.update((p) => ({ ...p, picked: userId }));
}

export function usePersonChoose(): PersonChoose | null {
  return useSyncExternalStore(store.subscribe, store.now);
}
