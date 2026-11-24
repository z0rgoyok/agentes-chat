import { useLayoutEffect, useState, useSyncExternalStore } from "react";

/** A value its readers subscribe to by the part they read (`useStorePart`). */
export interface ValueStore<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

/**
 * `value` as a store of one stable identity: put in a context, a change of it redraws only the readers whose part
 * changed (`useStorePart`), where the context's value itself would redraw every reader. They see it before the paint.
 */
export function useValueStore<T>(value: T): ValueStore<T> {
  const [store] = useState(() => {
    let current = value;
    const listeners = new Set<() => void>();
    return {
      get: () => current,
      set(next: T) {
        if (Object.is(next, current)) return;
        current = next;
        for (const l of listeners) l();
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  });
  useLayoutEffect(() => store.set(value), [store, value]);
  return store;
}

/** The part of a store's value `pick` reads: the caller draws again only when that part changes (`Object.is`). */
export function useStorePart<T, P>(store: ValueStore<T>, pick: (value: T) => P): P {
  return useSyncExternalStore(store.subscribe, () => pick(store.get()));
}
