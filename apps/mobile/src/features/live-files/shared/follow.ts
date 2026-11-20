import { useSyncExternalStore } from "react";

/**
 * Whom this phone follows in each open live file (ADR 0196 §5), by the awareness client id the file's people list
 * gives: the "who's here" screen sets it, the file's own screen moves its view along with that person's and says so,
 * and any move of the person's own stops it. In memory only: following ends with the app.
 */
const follows = new Map<string, number>();
const listeners = new Set<() => void>();

export function setFollowing(fileId: string, clientId: number | null) {
  if (clientId === null) {
    if (!follows.delete(fileId)) return;
  } else {
    if (follows.get(fileId) === clientId) return;
    follows.set(fileId, clientId);
  }
  for (const l of [...listeners]) l();
}

export const followingIn = (fileId: string): number | null => follows.get(fileId) ?? null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The client id this phone follows in a file, or null. */
export function useFollowing(fileId: string): number | null {
  const read = () => followingIn(fileId);
  return useSyncExternalStore(subscribe, read, read);
}
