import { type CSSProperties, useSyncExternalStore } from "react";

/** What one click made (a team, an import): the new channels and agents, in the order they were made. */
export interface Arrival {
  channelIds: string[];
  agentIds: string[];
}

interface State {
  /** The latest arrival Lodi's cursor will show, until it starts. */
  waiting: Arrival | null;
  /** The ids the cursor shows (or is about to): the sidebar leaves drawing them to it. */
  owned: ReadonlySet<string>;
  /** A run plays: a hold banner that wasn't up yet waits for it. */
  busy: boolean;
  /** The hold banner was already up when the run began: it stays, so the page doesn't jump away and back. */
  bannerUp: boolean;
  /** What the cursor dropped into the closed drawer (phone width), until it opens. */
  inDrawer: Arrival | null;
}

const EMPTY: State = { waiting: null, owned: new Set(), busy: false, bannerUp: false, inDrawer: null };
let state: State = EMPTY;
/** What "Pular" and Esc stop: the run playing now. */
let skipper: (() => void) | null = null;
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Where the person who made a team (or imported one) sees it land: fed by that click alone (`card.created`'s ids,
 * the import's result), never by the events everyone gets. Everyone else's sidebar draws the rows in by itself.
 */
export const arrivals = {
  add(a: Arrival) {
    if (a.channelIds.length + a.agentIds.length === 0) return;
    const bannerUp = state.busy ? state.bannerUp : document.querySelector(".hold-banner") !== null;
    set({ waiting: a, owned: new Set([...a.channelIds, ...a.agentIds]), busy: true, bannerUp });
  },
  /** The runner takes the arrival to play. */
  take(): Arrival | null {
    const a = state.waiting;
    if (a) set({ waiting: null });
    return a;
  },
  /** The run ended (played, skipped or fallen back): the rows are the sidebar's again. */
  done() {
    set({ busy: false, bannerUp: false, owned: new Set() });
  },
  owns: (id: string) => state.owned.has(id),
  /** "Pular": the run lands everything at once. */
  skip: () => skipper?.(),
  onSkip(fn: () => void) {
    skipper = fn;
    return () => {
      if (skipper === fn) skipper = null;
    };
  },
  dropIntoDrawer(part: Partial<Arrival>) {
    // Pular after a bunch was dropped drops everything: what is there already counts once.
    const was = state.inDrawer ?? { channelIds: [], agentIds: [] };
    set({
      inDrawer: {
        channelIds: [...new Set([...was.channelIds, ...(part.channelIds ?? [])])],
        agentIds: [...new Set([...was.agentIds, ...(part.agentIds ?? [])])],
      },
    });
  },
  /** The drawer opened: what was dropped there is shown, once. */
  drawerOpened(): Arrival | null {
    const dropped = state.inDrawer;
    if (dropped) set({ inDrawer: null });
    return dropped;
  },
  get: () => state,
  subscribe,
  /** Tests start clean. */
  reset() {
    state = EMPTY;
    for (const l of listeners) l();
  },
};

export const useArrivals = () => useSyncExternalStore(subscribe, arrivals.get, arrivals.get);
/** Lodi's cursor is showing a team land: what would push the page (the hold banner) waits for it. */
export const useArrivalsBusy = () => useArrivals().busy;
/** The hold banner waits for Lodi's cursor, unless it was already up when the run began. */
export const useHoldBannerWaits = () => {
  const { busy, bannerUp } = useArrivals();
  return busy && !bannerUp;
};

/**
 * Rows that draw themselves (the cursor's fallback, and everyone else's sidebar): each opens its room, a pixel veil
 * sweeps off it, an agent's face bursts. 400 ms apart, closer for a big team, about 3 s in all.
 */
export const DRAW = { rowMs: 220, gapMs: 400, totalMs: 3000 } as const;
export const drawDelay = (index: number, count: number) =>
  Math.round(index * Math.min(DRAW.gapMs, DRAW.totalMs / Math.max(1, count)));

/**
 * A sidebar row's marks while it lands (`useArrived`): its place among the arrivals and when its room opens. The rows
 * Lodi's cursor shows open together; anyone else's open one after another, as they draw themselves.
 */
export function arrivalProps(arrived: ReadonlyMap<string, number>, id: string) {
  const i = arrived.get(id);
  if (i === undefined) return {};
  const delay = arrivals.owns(id) ? 0 : drawDelay(i, arrived.size);
  return { "data-arriving": i, style: { "--arrive-delay": `${delay}ms` } as CSSProperties };
}

/** How many rows wait in the closed drawer. */
export const droppedCount = (a: Arrival | null) => (a ? a.channelIds.length + a.agentIds.length : 0);
