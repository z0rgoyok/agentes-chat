import { useSyncExternalStore } from "react";

/**
 * A list beside its detail on a regular-width window (ADR 0212: the iPhone Duo's inner display, a large screen): what
 * the detail pane shows, kept per workspace while the app runs (through redraws, remounts and the device opening and
 * closing), and what the window changing size class does with it. Conversations, Threads, Agents, You and the
 * workspace's settings each keep one. Pure but for the stores and their hooks, so the tests run it.
 */

/** What a split keeps of the person's choice: the item and its visit (`choose`'s `again`). */
interface Chosen<T> {
  item: T;
  visit: number;
}

/** One split's choice in every workspace. */
export interface SplitStore<T> {
  /**
   * Opens `item` in the workspace's split. `again`: a new visit even when it is the one shown, so its pane draws
   * afresh (a form saved, a place handed over from the other screen).
   */
  choose(orgId: string, item: T, again?: boolean): void;
  /** What the person opened in the workspace's split, if anything: what closing the device pushes as a page. */
  chosen(orgId: string): T | null;
  /**
   * What the detail pane shows while nothing is chosen (the list's first agent, a page of its own); null for none. It
   * stays where it is when the device closes: only a choice is pushed as a page.
   */
  offer(orgId: string, item: T | null): void;
  /** What the detail pane shows: the choice, else what is offered. The same object until it changes. */
  shown(orgId: string): T | null;
  /** The key its pane is drawn under: another item, or a new visit of the same one, draws it afresh. */
  shownKey(orgId: string): string | null;
  /** `shownKey` as it changes. */
  useShownKey(orgId: string): string | null;
  /** `shown` as it changes. */
  useShown(orgId: string | null): T | null;
  /** Whether `item` is what the detail pane shows: a row redraws only when its own answer changes. */
  useIsShown(orgId: string | null, item: T | null): boolean;
}

/** A split's store; `keyOf` names an item (two items with one name are the same one). */
export function createSplitStore<T>(keyOf: (item: T) => string): SplitStore<T> {
  const chosen = new Map<string, Chosen<T>>();
  const offered = new Map<string, T>();
  // Visits count per workspace, so an item chosen again over an offered one keeps its pane (the same key).
  const visits = new Map<string, number>();
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const same = (a: T | null | undefined, b: T | null | undefined) =>
    a === b || (a != null && b != null && keyOf(a) === keyOf(b));
  const shown = (orgId: string): T | null => chosen.get(orgId)?.item ?? offered.get(orgId) ?? null;
  const shownKey = (orgId: string): string | null => {
    const item = shown(orgId);
    return item === null ? null : `${keyOf(item)}:${visits.get(orgId) ?? 0}`;
  };
  return {
    choose(orgId, item, again = false) {
      const was = chosen.get(orgId);
      if (!again && was && same(was.item, item)) return;
      const visit = (visits.get(orgId) ?? 0) + (again ? 1 : 0);
      visits.set(orgId, visit);
      chosen.set(orgId, { item, visit });
      tell();
    },
    chosen: (orgId) => chosen.get(orgId)?.item ?? null,
    offer(orgId, item) {
      if (same(offered.get(orgId) ?? null, item)) return;
      if (item === null) offered.delete(orgId);
      else offered.set(orgId, item);
      // Behind a choice nothing shows of it.
      if (!chosen.has(orgId)) tell();
    },
    shown,
    shownKey,
    useShownKey(orgId) {
      return useSyncExternalStore(
        subscribe,
        () => shownKey(orgId),
        () => shownKey(orgId),
      );
    },
    useShown(orgId) {
      const read = () => (orgId === null ? null : shown(orgId));
      return useSyncExternalStore(subscribe, read, read);
    },
    useIsShown(orgId, item) {
      const read = () => orgId !== null && item !== null && same(shown(orgId), item);
      return useSyncExternalStore(subscribe, read, read);
    },
  };
}

/** What the window changing size class does with what the split shows (`splitHandoff`). */
export type SplitStep<T> = { kind: "push"; item: T } | { kind: "split"; item: T } | null;

/**
 * So that closing and opening an iPhone Duo mid-task keeps the person where they were (ADR 0212):
 * - wide to compact, with the split on screen and something chosen in it, that is pushed as a page, as a tap on its
 *   row does on a phone;
 * - compact to wide, with one of the split's pages pushed over the split's screen, it opens in the split, back there.
 * Anything else stays as it is (a screen pushed over the split, another tab, no change of size class).
 */
export function splitHandoff<T>(
  before: boolean,
  wide: boolean,
  state: { splitShown: boolean; chosen: T | null; pushed: T | null },
): SplitStep<T> {
  if (before && !wide) return state.splitShown && state.chosen !== null ? { kind: "push", item: state.chosen } : null;
  if (!before && wide) return state.pushed !== null ? { kind: "split", item: state.pushed } : null;
  return null;
}

/** A navigator's state, as much of it as the splits read. */
export interface StackState {
  index?: number;
  routes: readonly { key: string; name: string; params?: object | undefined }[];
}

/** The tab selected under whatever is pushed over the tabs (their navigator's state); null where it can't be told. */
export function selectedTabOf(state: { index?: number; routes?: readonly { name: string }[] } | undefined) {
  const routes = state?.routes;
  if (!routes || routes.length === 0) return null;
  return routes[Math.min(Math.max(state?.index ?? 0, 0), routes.length - 1)]?.name ?? null;
}

/**
 * The route on top of a stack when it stands right above the route `key` (a page pushed from that screen and nothing
 * over it); null otherwise.
 */
export function routeAbove(state: StackState | undefined, key: string) {
  if (!state) return null;
  const top = state.index ?? state.routes.length - 1;
  const at = state.routes.findIndex((r) => r.key === key);
  return at >= 0 && at === top - 1 ? (state.routes[top] ?? null) : null;
}

/**
 * The address of a route of the main stack with nothing in its params but the mark of a page opened in place
 * (`still`): `settings/roles/index` is `/settings/roles`. Null for one with params (a link's, a lookup's), whose page
 * the split would open without them.
 */
export function hrefOfRoute(route: { name: string; params?: object | undefined } | null): string | null {
  if (!route) return null;
  const params = Object.entries(route.params ?? {}).filter(([name, value]) => name !== "still" && value !== undefined);
  if (params.length > 0) return null;
  const path = route.name.replace(/(^|\/)index$/, "");
  return path ? `/${path}` : "/";
}
