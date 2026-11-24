/**
 * The conversation list's scroll rules, kept pure so they can be tested: when the list follows new
 * content, which rows just arrived at the bottom (they animate in), what sits below the person while
 * they read older ones (the round button's count and the "Novas" line), and where the person was while
 * something covered the list.
 */

/**
 * The list follows new content only while the person is this close to the end, as a fraction of the
 * visible height (Legend List's `maintainScrollAtEndThreshold`, measured from the physical end since 3.7:
 * about Bluesky's 100 points). Farther up, they are reading: nothing moves and the round button counts what arrived.
 */
export const STICK_TO_END_THRESHOLD = 0.15;

/**
 * Keys added at the bottom since the previous rows: after the last row both lists share, and new.
 * An older page prepended above, the first load (no previous rows) and a replaced list give none.
 */
/** How far before the screen opened a message may be dated and still be one arriving now (the clocks differ). */
export const ARRIVING_SLACK_MS = 2000;

/**
 * Whether a row that came in at the bottom is one arriving now (it rises in), or one that was already there before
 * the screen opened: what the server sends right after a launch, the messages written while the app was closed, came
 * in all at once and every one rose in, a flicker through the conversation (seen on a phone). Rows other than
 * messages (who is working, a day's line) keep rising in.
 */
export function arrivesNow(createdAt: string | undefined, openedAt: number): boolean {
  if (!createdAt) return true;
  const at = Date.parse(createdAt);
  return !Number.isFinite(at) || at >= openedAt - ARRIVING_SLACK_MS;
}

export function appendedKeys(prev: readonly string[], next: readonly string[]): string[] {
  if (prev.length === 0) return [];
  const before = new Set(prev);
  let last = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    if (before.has(next[i] as string)) {
      last = i;
      break;
    }
  }
  if (last < 0) return [];
  return next.slice(last + 1).filter((k) => !before.has(k));
}

export interface ScrollRow {
  key: string;
  /** A message (day dividers, markers and cards of what works never count). */
  kind: "message" | "other";
  /** A message row's message id, in the order the server posted them. */
  id?: string;
  /** Written by the person reading (never counts as new for them). */
  mine?: boolean;
  /** Who wrote it or is working ("agent:<id>", "person:<id>"): the pill's faces and names. */
  who?: string;
  /** The sticker or GIF an agent adds after its reply (ADR 0091): never news of its own (no count, no "Novas"). */
  silent?: boolean;
  /** Someone else's message that @mentions the person reading: the round button's count turns red. */
  mentionsMe?: boolean;
}

/** The last message row: where the person has read up to when they are at the end. */
export function lastSeenKey(rows: readonly ScrollRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] as ScrollRow;
    if (r.kind === "message") return r.key;
  }
  return null;
}

export interface Unseen {
  /** New messages below (an agent still at work isn't one yet). */
  messages: number;
  /** Where the "Novas" line goes: the first new message. */
  firstKey: string | null;
  /** Who wrote the new messages, in order, once each. */
  authors: string[];
  /** Who writes now ("Theo escrevendo"), once each: its reply comes below, whole once posted (the screen's runs). */
  working: string[];
  /** One of the new messages @mentions the person reading. */
  mentionsMe: boolean;
}

/**
 * What arrived below the last row the person saw, theirs left out ("↓ 2 novas · Marina e Ada · Atlas escrevendo"), and
 * the messages posted after `seenPostedId` (the one posted last when they were at the end, `lastPostedId`) in a place
 * above that row (`PLACE_KEPT_MS`): they land there and are still new.
 */
export function unseenBelow(rows: readonly ScrollRow[], seenKey: string | null, seenPostedId?: string): Unseen {
  const none: Unseen = { messages: 0, firstKey: null, authors: [], working: [], mentionsMe: false };
  if (!seenKey) return none;
  const at = rows.findIndex((r) => r.key === seenKey);
  if (at < 0) return none;
  const out: Unseen = { ...none, authors: [], working: [] };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as ScrollRow;
    const postedSince = seenPostedId !== undefined && r.id !== undefined && r.id > seenPostedId;
    if (i <= at && !(r.kind === "message" && postedSince)) continue;
    if (r.kind !== "message" || r.mine || r.silent) continue;
    out.firstKey ??= r.key;
    out.messages++;
    if (r.mentionsMe) out.mentionsMe = true;
    if (r.who && !out.authors.includes(r.who)) out.authors.push(r.who);
  }
  return out;
}

/**
 * Where a row goes so it shows in the band between the floating bar and the dock, as `scrollToIndex` takes it. The list
 * places a row in its whole height, whose top runs under the bar, so a row sent to the top (`viewPosition` 0) landed
 * hidden under it: the band's top (`top`, points under the bar) is given as an offset, in the share that keeps the row
 * at the same place in the band (`viewPosition` 0.5: centred in the band, 1: its end on the dock). A row taller than
 * the band (`band`, points) shows its start or its end (`tall`).
 *
 * A row the list never measured (far from where it drew) is only an estimate here: the list measures it during the
 * glide and keeps it where the estimate put it, so a tall one landed with its middle in view, its start above the bar
 * or its end (a request's card) under the dock. It gets the list's own fallback instead, which re-aims it once measured
 * when it doesn't fit: its start under the bar (`top`), or its end on the dock (no offset: the list takes it off even
 * when the fallback fires, and the end would sink under the dock).
 */
export function bandAim(aim: {
  viewPosition: number;
  /** The row's measured height, if the list has it. */
  size: number | undefined;
  band: number;
  top: number;
  tall: "start" | "end";
}): { viewPosition: number; viewOffset: number; viewPositionFallback?: "start" | "end" } {
  const { viewPosition, size, band, top, tall } = aim;
  if (size === undefined) return { viewPosition, viewOffset: tall === "start" ? top : 0, viewPositionFallback: tall };
  if (size > band) return tall === "start" ? { viewPosition: 0, viewOffset: top } : { viewPosition: 1, viewOffset: 0 };
  return { viewPosition, viewOffset: Math.round(top * (1 - viewPosition)) };
}

/**
 * Where the person is in the conversation, kept while something covers it (a sheet, the agent's computer): at the
 * end, or reading, with the scroll, a row on screen and where that row was (rows above can change size meanwhile).
 */
export type Place = { end: true } | { end: false; scroll: number; key: string | null; position: number | null };

/** How far the list may drift from a kept place before it is put back (points). */
export const PLACE_SLACK = 40;

/**
 * What puts a kept place back on screen, or null when it is still there: the end (`"end"`), or the scroll that
 * shows the row where it was, either way the list moved (toward older messages or toward the end).
 */
export function placeCorrection(
  place: Place,
  now: { scroll: number; distanceFromEnd: number; positionOf: (key: string) => number | undefined },
): "end" | number | null {
  if (place.end) return now.distanceFromEnd > PLACE_SLACK ? "end" : null;
  const at = place.key !== null ? now.positionOf(place.key) : undefined;
  const moved = at !== undefined && place.position !== null ? at - place.position : 0;
  const target = place.scroll + moved;
  return Math.abs(now.scroll - target) > PLACE_SLACK ? target : null;
}
