import { expect, test } from "bun:test";
import { dmList } from "../src/lib/recent";
import {
  addSection,
  favoritesOf,
  moveBy,
  moveChannelBy,
  moveSectionBy,
  parseFavorite,
  placeInSection,
  removeSection,
  renameSection,
  SIDEBAR_FAVORITE_LIMIT,
  SIDEBAR_VIEW_DEFAULT,
  sectionOfChannel,
  toggleFavorite,
} from "../src/lib/sidebar-view";

test("Favoritos start from the pins of before them, else day one's agents, and drop what is gone", () => {
  expect(favoritesOf(SIDEBAR_VIEW_DEFAULT, ["a1", "a2"])).toEqual(["agent:a1", "agent:a2"]);
  const pinned = { ...SIDEBAR_VIEW_DEFAULT, pins: { agents: ["a1"], channels: ["c1"], people: ["u1", "u2"] } };
  expect(favoritesOf(pinned, ["a9"])).toEqual(["agent:a1", "person:u1", "person:u2", "channel:c1"]);
  // Saved, they are what shows, in their order; a person who left takes no place, an unloaded list keeps its own.
  const saved = { ...pinned, favorites: ["channel:c1", "person:u2", "agent:a1", "bogus"] };
  expect(favoritesOf(saved, [], { person: ["u1"], agent: [] })).toEqual(["channel:c1", "agent:a1"]);
  // Emptied on purpose: nothing, not the pins again.
  expect(favoritesOf({ ...pinned, favorites: [] })).toEqual([]);
});

test("a favorite is added at the end, taken off by the same toggle, refused once Favoritos is full", () => {
  expect(toggleFavorite(["agent:a"], "channel:c")).toEqual(["agent:a", "channel:c"]);
  expect(toggleFavorite(["agent:a", "channel:c"], "agent:a")).toEqual(["channel:c"]);
  const full = Array.from({ length: SIDEBAR_FAVORITE_LIMIT }, (_, i) => `agent:${i}`);
  expect(toggleFavorite(full, "agent:new")).toBeNull();
  expect(parseFavorite("person:u1")).toEqual({ kind: "person", id: "u1" });
  expect(parseFavorite("group:x")).toBeNull();
  expect(moveBy(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
  expect(moveBy(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
});

test("a channel dropped on another makes a section of both; dragging the last one out takes the section away", () => {
  const made = addSection([], "Nova seção", ["seo", "marketing"]);
  expect(made.sections).toEqual([{ id: made.id, name: "Nova seção", channelIds: ["seo", "marketing"] }]);
  expect(sectionOfChannel(made.sections, "seo")).toBe(made.id);
  const more = placeInSection(made.sections, "ads", made.id, "marketing");
  expect(more[0]?.channelIds).toEqual(["seo", "ads", "marketing"]);
  // Into another section, out of this one.
  const other = addSection(more, "Vendas", ["leads"], made.id);
  expect(other.sections.map((s) => s.name)).toEqual(["Vendas", "Nova seção"]);
  const moved = placeInSection(other.sections, "seo", other.id);
  expect(moved.map((s) => s.channelIds)).toEqual([
    ["leads", "seo"],
    ["ads", "marketing"],
  ]);
  // Back to Canais: the empty section goes.
  const out = placeInSection(placeInSection(moved, "ads", null), "marketing", null);
  expect(out.map((s) => s.name)).toEqual(["Vendas"]);
});

test("sections rename, reorder and go; their channels reorder inside them", () => {
  const a = addSection([], "A", ["1", "2", "3"]);
  const b = addSection(a.sections, "B", ["4"]);
  expect(renameSection(b.sections, a.id, "  Lançamento v3  ")[0]?.name).toBe("Lançamento v3");
  expect(renameSection(b.sections, a.id, "   ")[0]?.name).toBe("A");
  expect(moveSectionBy(b.sections, b.id, -1).map((s) => s.name)).toEqual(["B", "A"]);
  expect(moveChannelBy(b.sections, "3", -1)[0]?.channelIds).toEqual(["1", "3", "2"]);
  expect(removeSection(b.sections, a.id).map((s) => s.name)).toEqual(["B"]);
});

test("Mensagens diretas: the right hand first, then the latest DM, then everyone else by name; recent keeps who I talked to", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  const listed = [
    { kind: "person" as const, id: "u-bia", name: "Bia" },
    { kind: "agent" as const, id: "a-ada", name: "Ada" },
    { kind: "person" as const, id: "u-caio", name: "Caio" },
    { kind: "agent" as const, id: "a-lodi", name: "Lodi" },
    { kind: "person" as const, id: "u-ana", name: "Ana" },
  ];
  const dm = (type: "person" | "agent", id: string, at: string | null, unread = 0) => ({
    with: { type, id, name: "", handle: null },
    lastMessage: at ? { id: "m", body: "", createdAt: at, authorType: type } : null,
    openedAt: "2026-11-01T00:00:00Z",
    unread,
  });
  const dms = [dm("person", "u-caio", "2026-11-27T11:00:00Z"), dm("agent", "a-ada", "2026-11-27T11:30:00Z")];
  const names = (show: "all" | "recent") => dmList(listed, dms, { show, first: "a-lodi", now }).map((l) => l.name);
  expect(names("all")).toEqual(["Lodi", "Ada", "Caio", "Ana", "Bia"]);
  expect(names("recent")).toEqual(["Lodi", "Ada", "Caio"]);
});
