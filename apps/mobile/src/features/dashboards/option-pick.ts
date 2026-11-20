import { type ReactNode, useSyncExternalStore } from "react";
import type { IconName } from "@/ui";

/**
 * One of many (or several), picked on its own pushed screen (screens, never a list that opens in place inside a card):
 * where a routine delivers, its mailbox and folder, its starting point, the board a widget goes on, the roles that see
 * a board. The form starts it before pushing `/option-pick` and ends it when it closes, as `agent-pick.ts` does: a
 * route can't carry a callback.
 */
export interface PickChoice {
  key: string;
  label: string;
  /** A quieter line under it (what the choice does, the template's words). */
  sub?: string | undefined;
  /** Lines `sub` may take (default 2). */
  subLines?: number | undefined;
  /** An icon's tile before it. */
  icon?: IconName | undefined;
  /** Anything else before it (an app's logo), in place of the tile. */
  leading?: ReactNode;
  /** The header it is listed under; options with the same one in a row share it. */
  group?: string | undefined;
  /** Words a search finds it by besides its label, line and group. */
  keywords?: string | undefined;
}

interface PickBase {
  title: string;
  options: readonly PickChoice[];
  /** One quiet line under the list. */
  note?: string | undefined;
  /** A search field over the list; on its own from `PICK_SEARCH_FROM` options. */
  search?: boolean | undefined;
  /** The search field's words (default: "Buscar"). */
  searchLabel?: string | undefined;
}

/** One of many: the pick goes back to the form and the screen with it. */
export interface OnePick extends PickBase {
  many?: undefined;
  /** The key in use: checked. */
  value: string | null;
  apply: (key: string) => void;
}

/** Several at once: each tap checks or unchecks, the form follows at once, and "Pronto" goes back. */
export interface ManyPick extends PickBase {
  many: true;
  values: readonly string[];
  apply: (keys: string[]) => void;
}

export type OptionPick = OnePick | ManyPick;

/** From this many options the list gets its search field (as the app's picker sheet). */
export const PICK_SEARCH_FROM = 9;

/** What a search reads in an option: its words, its line, its group and its keywords. */
export const pickText = (o: PickChoice) => [o.label, o.sub, o.group, o.keywords].filter(Boolean).join(" ");

let current: OptionPick | null = null;
const listeners = new Set<() => void>();

function set(next: OptionPick | null) {
  current = next;
  for (const listener of listeners) listener();
}

export function openOptionPick(pick: OptionPick) {
  set(pick);
}

/** An option chosen on the screen: back to the form at once (in a pick of several, it is checked or unchecked). */
export function chooseOption(key: string) {
  if (!current) return;
  if (current.many) {
    const values = current.values.includes(key) ? current.values.filter((k) => k !== key) : [...current.values, key];
    current.apply(values);
    set({ ...current, values });
    return;
  }
  current.apply(key);
  set({ ...current, value: key });
}

export function closeOptionPick() {
  set(null);
}

export const optionPickNow = (): OptionPick | null => current;

export function useOptionPick(): OptionPick | null {
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
