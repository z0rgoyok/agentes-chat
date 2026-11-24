import { useLayoutEffect, useRef } from "react";

/**
 * Where a conversation is being read, handed from the screen that shows it to the next one that will (ADR 0212: an
 * iPhone Duo opened or closed moves the conversation between the split's pane and a pushed screen). A place is the
 * message at the top of the view, or null at the conversation's end, where it opens anyway. Only the display changing
 * hands a place over: every other opening keeps its own rules (the end, the "Novas" line, a message asked for).
 */

/** How long a place handed over (or left by a pane) waits for the screen that takes it, in ms. */
export const HAND_MS = 5000;

type Reader = () => string | null;

/** The conversations' screens mounted now, oldest first (the one the person was reading). */
const readers = new Map<string, Reader[]>();
/** The last pane's place as it unmounted (the window turned compact under it): one at a time, as the display is. */
let left: { key: string; id: string | null; at: number } | null = null;
/** The place the next screen of a conversation opens at: one handoff at a time. */
let handed: { key: string; id: string; at: number } | null = null;

/** A conversation's key, as its screens are keyed: `channel:thread`. */
export const placeKey = (channelId: string, threadId: string | null) => `${channelId}:${threadId ?? ""}`;

const readSafely = (read: Reader): string | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

/**
 * The place a conversation's screen reads (`read`) while it is mounted. `keepOnLeave`: a pane's, kept a moment as it
 * unmounts, read before its list goes.
 */
export function useReadingPlace(key: string, read: Reader, keepOnLeave: boolean) {
  const latest = useRef(read);
  latest.current = read;
  useLayoutEffect(() => {
    const reader: Reader = () => latest.current();
    readers.set(key, [...(readers.get(key) ?? []), reader]);
    return () => {
      if (keepOnLeave) left = { key, id: readSafely(reader), at: Date.now() };
      const rest = (readers.get(key) ?? []).filter((r) => r !== reader);
      if (rest.length > 0) readers.set(key, rest);
      else readers.delete(key);
    };
  }, [key, keepOnLeave]);
}

/** Where the person reads this conversation now: its oldest mounted screen's place, else what a pane just left. */
export function readingPlace(key: string, now = Date.now()): string | null {
  const reader = readers.get(key)?.[0];
  if (reader) return readSafely(reader);
  return left?.key === key && now - left.at <= HAND_MS ? left.id : null;
}

/** The place the next screen of this conversation opens at (null: its end, as always). */
export function handPlace(key: string, id: string | null, now = Date.now()) {
  if (left?.key === key) left = null;
  if (id) handed = { key, id, at: now };
  else if (handed?.key === key) handed = null;
}

/** The place handed to this conversation's next screen, taken once; null when none, or one left too long. */
export function takeHandedPlace(key: string, now = Date.now()): string | null {
  const place = handed;
  if (place?.key !== key) return null;
  handed = null;
  return now - place.at <= HAND_MS ? place.id : null;
}

/** A row of the conversation's list, as much as a place needs of it. */
interface PlaceRow {
  kind: string;
  key: string;
  /** `local`: still sending (its id is the app's own, not the server's). */
  message?: { id: string; local?: unknown };
}

/**
 * The message a place in the list stands on (`useKeepPlace`'s `placeNow`): the row at the top of the view, or the
 * first message under it (a day's line, a marker), never one still sending; null at the end.
 */
export function placeMessage(
  place: { end: boolean; key?: string | null } | null,
  rows: readonly PlaceRow[],
): string | null {
  if (!place || place.end || !place.key) return null;
  const at = rows.findIndex((r) => r.key === place.key);
  if (at < 0) return null;
  for (let i = at; i < rows.length; i++) {
    const message = rows[i]?.message;
    if (rows[i]?.kind === "message" && message && !message.local) return message.id;
  }
  return null;
}
