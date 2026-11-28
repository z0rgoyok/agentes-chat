import type * as Y from "yjs";

/**
 * Groups on slides and canvases (ADR 0220 §3): pieces that hold together, selected, moved and scaled as one. Each kind
 * keeps a map of group id to `{ name?, parent? }` and each piece names its `group`; a group may sit in another.
 */

export interface LiveGroup {
  id: string;
  name?: string;
  /** The group it sits in. */
  parent?: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A group's name: at most 200 characters, never empty. */
export function cleanGroupName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
}

/**
 * A groups map as plain data, each group once, sorted by id: a parent that doesn't exist or that would close a loop is
 * left out, so a broken client's groups never hang a reader.
 */
export function readGroupMap(map: Y.Map<unknown> | null | undefined): LiveGroup[] {
  const raw = new Map<string, { name?: string; parent?: string }>();
  map?.forEach((value, id) => {
    if (!ID.test(id) || !value || typeof value !== "object" || Array.isArray(value)) return;
    const v = value as Record<string, unknown>;
    const g: { name?: string; parent?: string } = {};
    const name = cleanGroupName(v.name);
    if (name) g.name = name;
    if (typeof v.parent === "string" && ID.test(v.parent) && v.parent !== id) g.parent = v.parent;
    raw.set(id, g);
  });
  const out: LiveGroup[] = [];
  for (const [id, g] of [...raw].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const group: LiveGroup = { id, ...(g.name ? { name: g.name } : {}) };
    let up = g.parent;
    const seen = new Set([id]);
    while (up && raw.has(up) && !seen.has(up)) {
      seen.add(up);
      up = raw.get(up)?.parent;
    }
    if (g.parent && raw.has(g.parent) && !(up && seen.has(up))) group.parent = g.parent;
    out.push(group);
  }
  return out;
}

/** The ids of a group and of every group inside it. */
export function groupAndInner(groups: readonly LiveGroup[], groupId: string): Set<string> {
  const inside = new Set([groupId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) {
      if (g.parent && inside.has(g.parent) && !inside.has(g.id)) {
        inside.add(g.id);
        grew = true;
      }
    }
  }
  return inside;
}

/** The pieces a group holds, its inner groups' included. */
export function groupMembersOf<T extends { id: string; group?: string }>(
  items: readonly T[],
  groups: readonly LiveGroup[],
  groupId: string,
): string[] {
  const inside = groupAndInner(groups, groupId);
  return items.filter((item) => item.group && inside.has(item.group)).map((item) => item.id);
}

/** The outermost group a group sits in (itself when it sits in none). */
export function outermostGroup(groups: readonly LiveGroup[], groupId: string): string {
  const parentOf = new Map(groups.map((g) => [g.id, g.parent]));
  let at = groupId;
  const seen = new Set<string>();
  while (parentOf.get(at) && !seen.has(at)) {
    seen.add(at);
    at = parentOf.get(at) as string;
  }
  return at;
}

/** The groups that still hold something (a piece, or a group that does), from the groups the pieces name. */
export function usedGroups(groups: readonly LiveGroup[], named: Iterable<string>): Set<string> {
  const used = new Set(named);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) {
      if (used.has(g.id) && g.parent && !used.has(g.parent)) {
        used.add(g.parent);
        grew = true;
      }
    }
  }
  return used;
}
