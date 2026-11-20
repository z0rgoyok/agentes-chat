import { useSyncExternalStore } from "react";

/**
 * Whether the launch splash has left. Screens under it wait for this before they take the keyboard: an
 * input focused on mount raised the keyboard over the splash, before its screen was in view.
 */
let launched = false;
/**
 * Whether the app is in view: the splash opened its window onto it (`LaunchSplash`'s dive) or left. Conversas plays
 * its arrival from here, so the window shows it arriving, not waiting hidden.
 */
let revealed = false;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export function markRevealed(): void {
  if (revealed) return;
  revealed = true;
  changed();
}

export function markLaunched(): void {
  if (launched) return;
  launched = true;
  revealed = true;
  changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useLaunched = (): boolean => useSyncExternalStore(subscribe, () => launched);
export const useRevealed = (): boolean => useSyncExternalStore(subscribe, () => revealed);
