/**
 * A choice made on its own pushed screen (ADR 0135: screens, never sheets), as `agent-pick` does for a widget's agent:
 * what the form that pushed the screen offers, and how a choice goes back to it. A route can't carry a callback, so the
 * form opens the store before pushing and closes it when it goes away; the screen reads it, and goes back when nothing
 * is open (its address on its own, after a restart).
 */
export function pickStore<T>() {
  let current: T | null = null;
  const listeners = new Set<() => void>();
  const set = (next: T | null) => {
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    open: (pick: T) => set(pick),
    close: () => set(null),
    /** A change while the screen shows (a switch flipped there): the screen redraws from it. */
    update: (change: (pick: T) => T) => {
      if (current) set(change(current));
    },
    now: (): T | null => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
