import { useSyncExternalStore } from "react";

/**
 * A team made from Lodi's card, for the person who clicked: its faces fly into the back button to Conversas, and its
 * new conversations come in there once, the next time Conversas shows. The phone's side of the web's Lodi's cursor.
 */
export interface TeamFlight {
  faces: { key: string; name: string; appearance: unknown }[];
  /** Changes with every team, so the same faces fly again for a second one. */
  n: number;
}

/** The Conversas rows (`c:` a channel, `a:` an agent) a team made, as `logic.ts` keys them. */
export const arrivalKeys = (created: { channelIds: string[]; agentIds: string[] } | null | undefined) => [
  ...(created?.channelIds ?? []).map((id) => `c:${id}`),
  ...(created?.agentIds ?? []).map((id) => `a:${id}`),
];

let flight: TeamFlight | null = null;
let fresh: ReadonlySet<string> = new Set();
let count = 0;
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const teamArrivals = {
  add(keys: string[], faces: TeamFlight["faces"]) {
    if (keys.length === 0) return;
    count += 1;
    flight = faces.length > 0 ? { faces, n: count } : null;
    fresh = new Set([...fresh, ...keys]);
    changed();
  },
  /** The flight played (or was skipped): nothing left to draw. */
  landed() {
    flight = null;
    changed();
  },
  /** Conversas shows: the rows to bring in, handed over once. */
  takeFresh(): ReadonlySet<string> {
    const out = fresh;
    if (out.size === 0) return out;
    fresh = new Set();
    changed();
    return out;
  },
  flight: () => flight,
  /** Tests start clean. */
  reset() {
    flight = null;
    fresh = new Set();
    changed();
  },
};

export const useTeamFlight = () => useSyncExternalStore(subscribe, teamArrivals.flight, teamArrivals.flight);
