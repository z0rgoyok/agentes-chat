import type { Agent, AgentGroup, SidebarChannelSection, SidebarPins, SidebarView } from "../api/types";
import { groupOf } from "./agent-groups";

/** At most this many pinned rows on top of each section (`SIDEBAR_PIN_LIMIT`, packages/engine/src/sidebar-items.ts). */
export const SIDEBAR_PIN_LIMIT = 5;
export type PinKind = keyof SidebarPins;
/** AGENTES' orders, as its ⋯ menu lists them (`AGENT_SORTS`, packages/engine/src/sidebar-items.ts). */
export const AGENT_SORTS = ["workspace", "mine", "working"] as const satisfies readonly SidebarView["agentSort"][];

/** The view of someone who never changed it. */
export const SIDEBAR_VIEW_DEFAULT: SidebarView = {
  agentSort: "workspace",
  showAllAgents: false,
  pins: null,
  favorites: null,
  sections: null,
  dms: "all",
};
const NO_PINS: SidebarPins = { agents: [], channels: [], people: [] };

/**
 * Day one ("Fixar no topo" never used nor dismissed): the person's own agents on top of AGENTES, the most recently
 * active first (`lastActive`: agent id → ISO time of its DM's last message), then in the workspace's order (the
 * agents' list: as they were made, a template team in its template's order), at most the limit. Only the ones in no
 * group: these follow the DMs' activity, so a grouped agent pinned here would move inside its group whenever its
 * agents talked.
 */
export function dayOnePins(
  agents: readonly Pick<Agent, "id" | "name" | "ownerUserId">[],
  myUserId: string,
  lastActive: ReadonlyMap<string, string> = new Map(),
  groups: readonly AgentGroup[] = [],
): string[] {
  return agents
    .filter((a) => a.ownerUserId === myUserId && !groupOf(groups, a.id))
    .sort((a, b) => (lastActive.get(b.id) ?? "").localeCompare(lastActive.get(a.id) ?? ""))
    .slice(0, SIDEBAR_PIN_LIMIT)
    .map((a) => a.id);
}

/**
 * What shows pinned: the saved pins, or on day one only `dayOne` agents. With `known` (the ids each list holds), a pin
 * of something gone (a deleted agent, a channel I left) is left out: it never shows, so no one could take it off, and
 * it would hold one of the five places for good. A list not loaded yet (missing or empty) keeps its pins.
 */
export function pinsOf(
  view: SidebarView,
  dayOne: readonly string[],
  known: { [K in PinKind]?: readonly string[] | undefined } = {},
): SidebarPins {
  const pins = view.pins ?? { ...NO_PINS, agents: [...dayOne] };
  const kept = (kind: PinKind) => {
    const ids = known[kind];
    return ids?.length ? pins[kind].filter((id) => ids.includes(id)) : pins[kind];
  };
  return { agents: kept("agents"), channels: kept("channels"), people: kept("people") };
}

/**
 * `id` pinned first in its section (where the person looks: at the end of the pinned rows, the row next to them
 * hardly moved), or taken off; null when the section already holds the limit.
 */
export function togglePin(pins: SidebarPins, kind: PinKind, id: string): SidebarPins | null {
  const list = pins[kind];
  if (list.includes(id)) return { ...pins, [kind]: list.filter((x) => x !== id) };
  if (list.length >= SIDEBAR_PIN_LIMIT) return null;
  return { ...pins, [kind]: [id, ...list] };
}

/**
 * A section's rows split into its pinned ones (`top`, in the pins' order) and the rest (in theirs). A pin puts an
 * agent on top of its own setor (or of the agents in none), never out of it: a setor holds its agents whoever put
 * them there, and whenever.
 */
export function splitPinned<T>(items: readonly T[], pins: readonly string[], idOf: (item: T) => string) {
  const top = pins.flatMap((id) => items.filter((item) => idOf(item) === id));
  return { top, rest: items.filter((item) => !top.includes(item)) };
}

/**
 * `view` with these agents out of its pins; null when none of them is pinned. An agent the person just put in a group
 * by hand lands where they put it, not on top of the group as a pinned one would.
 */
export function unpinAgents(view: SidebarView, ids: readonly string[]): SidebarView | null {
  const agents = view.pins?.agents.filter((id) => !ids.includes(id));
  if (!view.pins || !agents || agents.length === view.pins.agents.length) return null;
  return { ...view, pins: { ...view.pins, agents } };
}

/** `view` with the agent pinned again at `at` among the pinned agents (Desfazer after a move took its pin off). */
export function repinAgent(view: SidebarView, id: string, at: number): SidebarView {
  const pins = view.pins;
  if (!pins || pins.agents.includes(id) || pins.agents.length >= SIDEBAR_PIN_LIMIT) return view;
  return { ...view, pins: { ...pins, agents: [...pins.agents.slice(0, at), id, ...pins.agents.slice(at)] } };
}

/**
 * One group's agents in the person's order (stable): the workspace's, the ones I'm responsible for first (`mine`), or
 * the ones working now first (`working`, `busy` their ids).
 */
export function sortAgents<A extends Pick<Agent, "id" | "ownerUserId">>(
  agents: readonly A[],
  sort: SidebarView["agentSort"],
  myUserId: string,
  busy: ReadonlySet<string> = new Set(),
): A[] {
  if (sort === "workspace") return [...agents];
  const first = (a: A) => (sort === "mine" ? a.ownerUserId === myUserId : busy.has(a.id));
  return [...agents.filter(first), ...agents.filter((a) => !first(a))];
}

// ── Favoritos (ADR 0260) ──

/** At most this many favorites (`SIDEBAR_FAVORITE_LIMIT`, packages/engine/src/sidebar-items.ts). */
export const SIDEBAR_FAVORITE_LIMIT = 50;
export type FavoriteKind = "agent" | "channel" | "person";
export interface Favorite {
  kind: FavoriteKind;
  id: string;
}
export const favoriteKey = (kind: FavoriteKind, id: string) => `${kind}:${id}`;
export function parseFavorite(key: string): Favorite | null {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  return at > 0 && id && (kind === "agent" || kind === "channel" || kind === "person") ? { kind, id } : null;
}

/**
 * Favoritos, as keys in order: the saved ones; never saved, the pins of before them (the agents, the people, then the
 * channels, each in their order), else day one's agents (`dayOne`). With `known` (each kind's ids the lists hold), a
 * favorite of something gone is left out: it would hold a place no one could take it off. A list not loaded yet keeps
 * its favorites.
 */
export function favoritesOf(
  view: SidebarView,
  dayOne: readonly string[] = [],
  known: { [K in FavoriteKind]?: readonly string[] | undefined } = {},
): string[] {
  const keys =
    view.favorites ??
    (view.pins
      ? [
          ...view.pins.agents.map((id) => favoriteKey("agent", id)),
          ...view.pins.people.map((id) => favoriteKey("person", id)),
          ...view.pins.channels.map((id) => favoriteKey("channel", id)),
        ]
      : dayOne.map((id) => favoriteKey("agent", id)));
  return keys.filter((key) => {
    const f = parseFavorite(key);
    const ids = f && known[f.kind];
    return f !== null && (!ids?.length || ids.includes(f.id));
  });
}

/** `key` added at the end of Favoritos or taken off; null when Favoritos is full. */
export function toggleFavorite(list: readonly string[], key: string): string[] | null {
  if (list.includes(key)) return list.filter((k) => k !== key);
  if (list.length >= SIDEBAR_FAVORITE_LIMIT) return null;
  return [...list, key];
}

/** `item` one step up (-1) or down (1) in `list`; the same list at either end. */
export function moveBy<T>(list: readonly T[], item: T, delta: -1 | 1): T[] {
  const i = list.indexOf(item);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j] as T, out[i] as T];
  return out;
}

// ── Channel sections, each person's own (ADR 0260) ──

/** A section's name, as typed, at most this long (`SIDEBAR_SECTION_NAME_MAX` in the engine). */
export const SIDEBAR_SECTION_NAME_MAX = 40;
/** A new section's id: unique among one person's sections, no crypto needed (Hermes has no `randomUUID`). */
export const newSectionId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** The section a channel is in, or null. */
export const sectionOfChannel = (sections: readonly SidebarChannelSection[], channelId: string) =>
  sections.find((s) => s.channelIds.includes(channelId))?.id ?? null;

/** Sections with no channel left go away (ADR 0260 §2). */
const kept = (sections: SidebarChannelSection[]) => sections.filter((s) => s.channelIds.length > 0);

/**
 * `channelId` into `sectionId` (null: out of every section, back to Canais), before `beforeId` (null or absent: at its
 * end). A section left with no channel goes.
 */
export function placeInSection(
  sections: readonly SidebarChannelSection[],
  channelId: string,
  sectionId: string | null,
  beforeId: string | null = null,
): SidebarChannelSection[] {
  const out = sections.map((s) => ({ ...s, channelIds: s.channelIds.filter((id) => id !== channelId) }));
  const to = out.find((s) => s.id === sectionId);
  if (to) {
    const at = beforeId ? to.channelIds.indexOf(beforeId) : -1;
    to.channelIds.splice(at < 0 ? to.channelIds.length : at, 0, channelId);
  }
  return kept(out);
}

/**
 * A new section holding `channelIds` (taken out of the ones they were in), placed before `beforeSectionId` (null or
 * absent: last). Returns the sections and the new one's id.
 */
export function addSection(
  sections: readonly SidebarChannelSection[],
  name: string,
  channelIds: readonly string[],
  beforeSectionId: string | null = null,
): { sections: SidebarChannelSection[]; id: string } {
  const id = newSectionId();
  const out = sections.map((s) => ({ ...s, channelIds: s.channelIds.filter((c) => !channelIds.includes(c)) }));
  const at = beforeSectionId ? out.findIndex((s) => s.id === beforeSectionId) : -1;
  out.splice(at < 0 ? out.length : at, 0, {
    id,
    name: name.trim().slice(0, SIDEBAR_SECTION_NAME_MAX),
    channelIds: [...new Set(channelIds)],
  });
  return { sections: kept(out), id };
}

/** A section renamed; an empty name keeps the one it had. */
export const renameSection = (sections: readonly SidebarChannelSection[], id: string, name: string) => {
  const clean = name.trim().slice(0, SIDEBAR_SECTION_NAME_MAX);
  return sections.map((s) => (s.id === id && clean ? { ...s, name: clean } : s));
};

/** A section taken away: its channels go back to Canais. */
export const removeSection = (sections: readonly SidebarChannelSection[], id: string) =>
  sections.filter((s) => s.id !== id);

/** A section one step up or down among the others. */
export function moveSectionBy(sections: readonly SidebarChannelSection[], id: string, delta: -1 | 1) {
  const section = sections.find((s) => s.id === id);
  return section ? moveBy(sections, section, delta) : [...sections];
}

/** A channel one step up or down inside its section (a channel in none stays: Canais keeps the workspace's order). */
export function moveChannelBy(sections: readonly SidebarChannelSection[], channelId: string, delta: -1 | 1) {
  return sections.map((s) =>
    s.channelIds.includes(channelId) ? { ...s, channelIds: moveBy(s.channelIds, channelId, delta) } : s,
  );
}
