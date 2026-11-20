/**
 * Sizes a conversation's rows measured, kept in memory while the app runs. Only the heights of messages' words also
 * outlive it, in a file of the app's cache (`ClippedMessage`, `keptWordHeights`): ids and numbers, no content.
 *
 * The list unmounts a row that leaves the screen and mounts it again when it comes back. A row that measures part of
 * itself to decide its size (how tall its words are before they are cut, how wide a table's columns are, how much room
 * its pictures have) drew at a guess for a frame and then changed size, and every row under it moved while the person
 * scrolled. Kept here, a row comes back at its size from its first frame; it measures only the first time it shows, out
 * of sight ahead of the scroll (the list draws a screen ahead).
 *
 * A key holds what the size depends on besides the content (`useLayoutKey`: the window's width, the text size, the
 * conversation's look). Bounded: past `MAX_KEPT` the size kept longest ago goes first.
 */

export const MAX_KEPT = 3000;

/** A height or a width, a table's columns by index, or a part the person opened (`keepOpen`). */
type Kept = number | Readonly<Record<number, number>> | true;

const kept = new Map<string, Kept>();

function keep(key: string, value: Kept) {
  // Kept again, it becomes the newest: the oldest are the ones not seen for longest.
  kept.delete(key);
  kept.set(key, value);
  if (kept.size > MAX_KEPT) {
    const oldest = kept.keys().next();
    if (!oldest.done) kept.delete(oldest.value);
  }
}

export function keptSize(key: string): number | undefined {
  const value = kept.get(key);
  return typeof value === "number" ? value : undefined;
}

export function keepSize(key: string, size: number) {
  keep(key, size);
}

export function keptColumns(key: string): Readonly<Record<number, number>> | undefined {
  const value = kept.get(key);
  return typeof value === "object" ? value : undefined;
}

export function keepColumns(key: string, columns: Readonly<Record<number, number>>) {
  keep(key, { ...columns });
}

/**
 * Whether the person left a row's part open (a reply's tools), kept as the sizes are: a block opened and scrolled away
 * came back closed, another size than the one the list kept for its row. No key: nothing kept.
 */
export function keptOpen(key: string | undefined): boolean {
  return key !== undefined && kept.get(key) === true;
}

export function keepOpen(key: string | undefined, open: boolean) {
  if (key === undefined) return;
  if (open) keep(key, true);
  else kept.delete(key);
}

/** The keys of messages' words' heights (`ClippedMessage`): the only sizes kept across launches. */
export const WORDS_KEY = "words:";

/**
 * The latest `max` heights of messages' words, the oldest first, for the next launch (`ClippedMessage`): a message's
 * id and how tall its words are, never what they say.
 */
export function keptWordHeights(max: number): Record<string, number> {
  const words: [string, number][] = [];
  for (const [key, value] of kept) {
    if (key.startsWith(WORDS_KEY) && typeof value === "number") words.push([key, value]);
  }
  return Object.fromEntries(words.slice(-max));
}

/** Heights an earlier launch kept (`keptWordHeights`); one measured in this run wins. Anything else is left out. */
export function restoreWordHeights(saved: unknown) {
  if (!saved || typeof saved !== "object") return;
  for (const [key, value] of Object.entries(saved)) {
    if (!key.startsWith(WORDS_KEY) || typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    if (!kept.has(key)) keep(key, value);
  }
}

/** Everything kept, gone (tests). */
export function forgetKeptSizes() {
  kept.clear();
}

/**
 * How far past its rule a part that folds may show before its first measure (a message's words, a live block's parts,
 * a long text on a card). React Native measures a text no taller than the room its box gives it (a text under a cap
 * reads at most the cap), so under a cap exactly at the rule a long paragraph read exactly the rule, "not over it": it
 * showed whole for a frame and then folded, moving every row under it twice. A point past the rule, words that reach
 * the cap are over the rule.
 */
export const PAST_RULE = 1;

/**
 * The height to keep after a measure of a part that folds (`ClippedMessage`'s words, `SpecBlock`'s parts), or null when
 * nothing changes. Folded (under the cut, or the cap before the first measure) the part measures shorter than it is
 * whole, since the fold changes the room around it (a text reads no taller than its room): a message near the rule
 * measured just under it folded and just over it whole, and flipped between the two on every layout. Folded, a measure
 * only ever raises the height; unfolded, it is the part's whole height.
 *
 * `cap`: the height of the fold, when it is fixed (a live block's cut). A text it clamps reads its whole room, so the
 * part then reads at least the cap; a measure under it was clamped by nothing and is the part's whole height, lower
 * too (details closed, parts hidden by a switch). Never accepted, the block stayed a cut box over blank space.
 */
export function keptHeightAfter(kept: number, measured: number, folded: boolean, cap = 0): number | null {
  if (!Number.isFinite(measured) || measured === kept) return null;
  if (folded && measured < kept && measured >= cap) return null;
  return measured;
}
