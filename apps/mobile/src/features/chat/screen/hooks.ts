import { useCallback, useRef, useSyncExternalStore } from "react";

/** The latest of a function behind one that never changes: what it is handed to isn't redrawn when the function is. */
export function useLatest<A extends unknown[], R>(fn: (...args: A) => R) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/**
 * A value kept outside the screen's state (how far up the person reads, the day at the top of the list): only what
 * reads it (`useValueOf`) redraws when it changes, and setting it again to the same value tells no one.
 */
export interface ValueStore<T> {
  get(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const useValueOf = <T>(store: ValueStore<T>) => useSyncExternalStore(store.subscribe, store.get, store.get);
