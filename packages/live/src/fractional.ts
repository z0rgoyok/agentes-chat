import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * Stacking keys (ADR 0196 §2): slide elements and canvas shapes keep their order as fractional-indexing strings in
 * `z`, so two people bringing things forward at once never rewrite each other's keys. Items sort by `z`, then by id,
 * so two keys made equal by people working at once still give everyone the same order.
 */

/**
 * A key that sorts after `a` and before `b` (`null` = the start / the end). Bounds may come in either order. Equal
 * bounds (a tie two people made at once) give a key just after them. A key no app made throws.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && a === b) return generateKeyBetween(a, `${a}V`);
  return generateKeyBetween(a, b);
}

/** `n` keys in order between `a` and `b` (see `keyBetween`). */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (a !== null && a === b) return generateNKeysBetween(a, `${a}V`, n);
  if (a !== null && b !== null && a > b) return generateNKeysBetween(b, a, n);
  return generateNKeysBetween(a, b, n);
}

/** Whether `key` is a stacking key the library made (anything else can't be a bound for a new key). */
export function isOrderKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/** The stacking order: by key, then by id. */
export function compareStack(a: { id: string; z: string }, b: { id: string; z: string }): number {
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type StackMove = "front" | "back" | "forward" | "backward";

/**
 * New keys for moving `ids` in the stack of `items`: `front`/`back` take them above/below everything (keeping their
 * own order), `forward`/`backward` move each one past the next item that isn't moving. Only the moved items get new
 * keys, unless the keys around them tie or weren't made by the library: then every item is numbered again in the new
 * order, so the result is always a valid, strict order. An empty map means nothing changes.
 */
export function restack(
  items: readonly { id: string; z: string }[],
  ids: Iterable<string>,
  how: StackMove,
): Map<string, string> {
  const chosen = new Set(ids);
  const order = [...items].sort(compareStack);
  if (!order.some((item) => chosen.has(item.id))) return new Map();
  let next: { id: string; z: string }[];
  if (how === "front" || how === "back") {
    const moving = order.filter((item) => chosen.has(item.id));
    const staying = order.filter((item) => !chosen.has(item.id));
    next = how === "front" ? [...staying, ...moving] : [...moving, ...staying];
  } else {
    next = [...order];
    if (how === "forward") {
      for (let i = next.length - 2; i >= 0; i--) swapIfMoving(next, i, i + 1, chosen);
    } else {
      for (let i = 1; i < next.length; i++) swapIfMoving(next, i, i - 1, chosen);
    }
  }
  if (next.every((item, i) => item === order[i])) return new Map();
  const keys = new Map<string, string>();
  let i = 0;
  while (i < next.length) {
    const item = next[i];
    if (!item || !chosen.has(item.id)) {
      i++;
      continue;
    }
    let end = i;
    while (end < next.length && chosen.has(next[end]?.id ?? "")) end++;
    const lower = i > 0 ? (next[i - 1]?.z ?? null) : null;
    const upper = end < next.length ? (next[end]?.z ?? null) : null;
    if (!boundsUsable(lower, upper)) return renumber(next);
    const run = keysBetween(lower, upper, end - i);
    for (let k = i; k < end; k++) {
      const moved = next[k];
      const key = run[k - i];
      if (moved && key) keys.set(moved.id, key);
    }
    i = end;
  }
  return keys;
}

/** Keys for every item, in the order given (a fresh numbering). */
export function renumber(items: readonly { id: string }[]): Map<string, string> {
  const keys = keysBetween(null, null, items.length);
  const out = new Map<string, string>();
  items.forEach((item, i) => {
    const key = keys[i];
    if (key) out.set(item.id, key);
  });
  return out;
}

function swapIfMoving(list: { id: string; z: string }[], from: number, to: number, chosen: Set<string>): void {
  const a = list[from];
  const b = list[to];
  if (a && b && chosen.has(a.id) && !chosen.has(b.id)) {
    list[from] = b;
    list[to] = a;
  }
}

function boundsUsable(lower: string | null, upper: string | null): boolean {
  if (lower !== null && !isOrderKey(lower)) return false;
  if (upper !== null && !isOrderKey(upper)) return false;
  return lower === null || upper === null || lower < upper;
}
