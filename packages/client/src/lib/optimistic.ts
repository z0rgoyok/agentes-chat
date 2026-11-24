import type { DefaultError, Query, QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * One change to the cache made before the server answers: every cached query under `key` (a prefix, or the one query
 * with `exact`) goes through `update`. A query with no data yet is left alone (nothing on screen to change).
 */
export type CacheEdit = {
  key: QueryKey;
  exact?: boolean;
  /** Only the queries under `key` it picks (a channel's message lists, not its members). */
  where?: (query: Query) => boolean;
  update: (old: unknown) => unknown;
};

/** What the edited queries held before, to put back when the server refuses the write. */
export type Before = Array<[QueryKey, unknown]>;

/** A typed `CacheEdit`. `exact` defaults to true: a key names one query unless the caller says it is a prefix. */
export function edit<T>(key: QueryKey, update: (old: T) => T, exact = true): CacheEdit {
  return { key, exact, update: update as (old: unknown) => unknown };
}

/** The same `update` for every query under a prefix (a channel's message pages, every list of threads). */
export function editAll<T>(prefix: QueryKey, update: (old: T) => T): CacheEdit {
  return edit(prefix, update, false);
}

/** The same `update` for the queries under a prefix that `where` picks. */
export function editWhere<T>(prefix: QueryKey, where: (query: Query) => boolean, update: (old: T) => T): CacheEdit {
  return { key: prefix, exact: false, where, update: update as (old: unknown) => unknown };
}

/** The filters that name an edit's queries. */
const filtersOf = (e: CacheEdit) => ({ queryKey: e.key, exact: e.exact, predicate: e.where });

/** Applies the edits now and returns what was there. */
export function applyEdits(qc: QueryClient, edits: CacheEdit[]): Before {
  const before: Before = [];
  for (const change of edits) {
    for (const [key, data] of qc.getQueriesData(filtersOf(change))) {
      if (data === undefined) continue;
      const next = change.update(data);
      if (next === data) continue;
      before.push([key, data]);
      qc.setQueryData(key, next);
    }
  }
  return before;
}

/** Puts back what `applyEdits` changed. */
export function restoreEdits(qc: QueryClient, before: Before | undefined) {
  for (const [key, data] of before ?? []) qc.setQueryData(key, data);
}

/** What `onMutate` leaves for `onError`: the data to put back, and the reads it stopped to make its change. */
export type OptimisticContext = { before: Before; stopped: QueryKey[] };

/**
 * `onMutate`/`onError` for a write the screen shows at once: the edits land in the same tick as the tap, and a refused
 * write puts back what was there (the mutation cache's toast says why). A read still in flight of a query it edits is
 * cancelled first, or its older answer (or its cancellation, which restores the state from before it started) would
 * undo the change; only then does `onMutate` wait, for that cancellation. Only queries with data are stopped: a first
 * read has nothing on screen to change, and cancelling it would leave its page loading. A refused write reads the
 * stopped queries again. Spread it into `useMutation` and keep the hook's own `onSuccess`/`onSettled` to read the truth
 * back in the background.
 */
export function optimistic<V>(qc: QueryClient, edits: (vars: V) => CacheEdit[]) {
  return {
    onMutate: (vars: V): OptimisticContext | Promise<OptimisticContext> => {
      const list = edits(vars);
      const stopped = list.flatMap((e) =>
        qc
          .getQueryCache()
          .findAll(filtersOf(e))
          .filter((q) => q.state.fetchStatus === "fetching" && q.state.data !== undefined)
          .map((q) => q.queryKey),
      );
      if (stopped.length === 0) return { before: applyEdits(qc, list), stopped };
      return Promise.all(stopped.map((queryKey) => qc.cancelQueries({ queryKey, exact: true }))).then(() => ({
        before: applyEdits(qc, list),
        stopped,
      }));
    },
    // `DefaultError`, as `useMutation` assumes: a wider type here would widen every caller's `onError`.
    onError: (_error: DefaultError, _vars: V, context: OptimisticContext | undefined) => {
      restoreEdits(qc, context?.before);
      for (const queryKey of context?.stopped ?? []) void qc.invalidateQueries({ queryKey, exact: true });
    },
  };
}

/** A list without the item whose `id` is `id` (an archived, decided or deleted row leaving its list at once). */
export function without<T extends { id: string }>(id: string) {
  return (list: T[] | undefined) => (Array.isArray(list) ? list.filter((x) => x.id !== id) : list) as T[];
}

/** A list with the item whose `id` is `id` changed by `patch`. */
export function patchIn<T extends { id: string }>(id: string, patch: Partial<T> | ((item: T) => T)) {
  return (list: T[] | undefined) =>
    (Array.isArray(list)
      ? list.map((x) => (x.id === id ? (typeof patch === "function" ? patch(x) : { ...x, ...patch }) : x))
      : list) as T[];
}
