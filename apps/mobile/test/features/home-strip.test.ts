import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Channel, DirectMessage } from "@agenteschat/client";
import {
  agentStarters,
  buildConversations,
  HOME_SECTIONS,
  pinnedRows,
  RECENT_MAX,
  recentRows,
} from "../../src/features/chats/logic";
import { faceMark } from "../../src/features/chats/rowFacts";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
import { at, thread } from "./fixtures";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

const channel = (id: string, minutesAgo: number): Channel => ({
  id,
  name: id,
  topic: "",
  visibility: "public",
  isMember: true,
  createdAt: at(1000),
  lastMessage: {
    id: `m-${id}`,
    authorType: "person",
    authorId: "u1",
    authorName: "Caio",
    preview: "oi",
    meta: null,
    createdAt: at(minutesAgo),
  },
});
const dm = (type: "agent" | "person", id: string, minutesAgo: number, unread = 0): DirectMessage => ({
  channelId: `d-${id}`,
  with: { type, id, name: id, handle: type === "agent" ? id : null },
  lastMessage: { id: `m-${id}`, body: "Oi", createdAt: at(minutesAgo), authorType: type },
  unread,
});

// Ada and Dev talked to; Theo never (no DM); Ana a person; two channels; one thread.
const rows = buildConversations({
  channels: [channel("vendas", 30), channel("bugs", 2)],
  dms: [dm("agent", "ada", 50), dm("agent", "dev", 5, 3), dm("person", "ana", 10)],
  threads: [thread({ id: "t1", title: "Deploy", lastActivityAt: at(1) })],
});
const team = [
  { id: "ada", name: "Ada", handle: "ada" },
  { id: "dev", name: "Dev", handle: "dev" },
  { id: "theo", name: "Theo", handle: "theo" },
];
const starters = agentStarters(team);
const keys = (list: { key: string }[]) => list.map((r) => r.key);

describe("the pinned strip", () => {
  test("agents first, then channels, then people, each in the pins' order", () => {
    const pins = { agents: ["dev", "ada"], channels: ["vendas"], people: ["ana"] };
    expect(keys(pinnedRows(rows, starters, pins))).toEqual(["d:d-dev", "d:d-ada", "c:vendas", "d:d-ana"]);
  });

  test("a pinned agent never talked to stands as one to start; its DM's row once there is one", () => {
    const strip = pinnedRows(rows, starters, { agents: ["theo", "ada"], channels: [], people: [] });
    expect(strip.map((r) => [r.key, r.channelId])).toEqual([
      ["a:theo", ""],
      ["d:d-ada", "d-ada"],
    ]);
  });

  test("a pin of something no longer listed (gone, hidden, the right hand) holds no place; nothing pinned, nothing", () => {
    const pins = { agents: ["gone", "dev"], channels: ["left"], people: ["nobody"] };
    expect(keys(pinnedRows(rows, starters, pins))).toEqual(["d:d-dev"]);
    expect(pinnedRows(rows, starters, { agents: [], channels: [], people: [] })).toEqual([]);
  });

  test("an agent whose DM wouldn't open is never one to start, though the Agents tab lists it", () => {
    // Who it answers or who manages it opens its DM (the server's `openDm`, ADR 0085 addendum of 2026-11-17): an agent I
    // only edit, or someone's private agent under a mere "Edit agents", would open a refused one.
    const edited = { id: "iris", name: "Iris", handle: "iris", canTalk: false, canEdit: true, canManage: false };
    const locked = { id: "ivo", name: "Ivo", handle: "ivo", canTalk: false, canManage: false };
    const managed = { id: "lia", name: "Lia", handle: "lia", canTalk: false, canManage: true };
    const pins = { agents: ["iris", "ivo", "lia", "ada"], channels: [], people: [] };
    // The one I manage opens its DM (its composer offers to let me in); the others hold no place on the strip.
    expect(keys(pinnedRows(rows, agentStarters([...team, edited, locked, managed]), pins))).toEqual([
      "a:lia",
      "d:d-ada",
    ]);
  });
});

describe("Recentes", () => {
  test("every DM and channel by latest activity, pinned ones in their place, threads out", () => {
    // Dev and #vendas are pinned: Recentes keeps them where their activity puts them.
    expect(keys(recentRows(rows))).toEqual(["c:bugs", "d:d-dev", "d:d-ana", "c:vendas", "d:d-ada"]);
  });

  test("agents never talked to stay out (Agentes and the strip have them)", () => {
    expect(recentRows(rows).some((r) => r.key.startsWith("a:"))).toBe(false);
  });

  test("the home shows the latest twenty before See all", () => {
    expect(RECENT_MAX).toBe(20);
  });
});

describe("a face's mark stands for its row's second line", () => {
  const state = (over: { mark?: "orbit" | "wait" | "clock" | null; amber?: boolean }) => ({
    kind: "state" as const,
    mark: over.mark ?? null,
    word: "w",
    strong: false,
    em: true,
    amber: over.amber ?? false,
    rest: "",
  });

  test("at work the orbit, waiting on you the amber square, a wait elsewhere the clock, a last message none", () => {
    expect(faceMark({ kind: "doing", text: "Writing the report" })).toBe("orbit");
    expect(faceMark(state({ mark: "orbit" }))).toBe("orbit");
    expect(faceMark(state({ amber: true }))).toBe("wait");
    expect(faceMark(state({ mark: "clock" }))).toBe("clock");
    expect(faceMark({ kind: "away", text: "Waiting for the laptop" })).toBe("clock");
    expect(faceMark({ kind: "last", lead: "", text: "Done" })).toBeNull();
  });
});

describe("Conversas with the strip and one list", () => {
  const home = src("chats/ChatsScreen.tsx");
  const strip = src("chats/PinnedStrip.tsx");

  test("the strip stands under Início's widgets, above Recentes", () => {
    const loaded = home.slice(home.indexOf("<HomeWidgets"));
    const order = ["<HomeWidgets", "<PinnedStrip", 'title={t("mobile.chats.recent")}'].map((p) => loaded.indexOf(p));
    expect(order.every((pos, i) => pos >= 0 && (i === 0 || pos > (order[i - 1] ?? 0)))).toBe(true);
    expect(home).toContain("pinnedRows(pinned.rows, starters, pins.pins)");
    expect(home).toContain('holdLabel={t("sidebarPins.unpin")}');
  });

  test("Recentes: the home's rows with no grouping, no pin first and no pin mark, the first twenty and See all", () => {
    expect(home).toContain("recent.slice(0, RECENT_MAX).map((r, i) => (");
    expect(home).toContain('<SeeAllRow label={t("mobile.chats.seeAll")} onPress={() => openKindList("recent")} />');
    for (const gone of ["homeLayout", "categoryMenu", "pinned={", "mobile.chats.section", "useHomeCollapsed"])
      expect({ gone, home: home.includes(gone) }).toEqual({ gone, home: false });
    expect(src("chats/HomeRow.tsx")).not.toMatch(/\bpinned(: boolean|=\{)/);
    expect(src("chats/ConversationRowView.tsx")).not.toContain("pinned={pinned}");
  });

  test("loading stands as the one section it will be; nothing yet invites the first conversation", () => {
    const loading = home.slice(home.indexOf(") : list.loading ? ("), home.indexOf("<HomeWidgets"));
    expect(loading).toContain('title={t("mobile.chats.recent")}');
    expect(loading).toContain("<SkeletonList rows={6} />");
    expect(loading).not.toContain("count=");
    expect(home).toContain('place="chats"');
  });

  test("the invitation to make the first agent waits for an empty Agents tab, agents I only edit counted", () => {
    // Those are never ones to start (`agentStarters`), nor are their DMs listed, yet the team isn't empty; the
    // greeting's count of who works matches the Agents tab too.
    expect(home).toContain("const teamListed = dir.agents.some((a) => !isRightHand(a) && listsAgent(org, a));");
    expect(home).toContain("const empty = !list.loading && !failed && pinned.rows.length === 0 && !teamListed;");
    expect(home).toContain("return a !== undefined && listsAgent(org, a) && !offline.has(id);");
  });

  test("every part collapses and is remembered, with the home's own keys", () => {
    expect([...HOME_SECTIONS]).toEqual(["widgets", "pinned", "recent", "otherChannels"]);
    expect(home).toContain("const { collapsed, toggle } = useCollapsedSections();");
    for (const key of ["widgets", "pinned", "recent", "otherChannels"])
      expect({
        key,
        toggles:
          home.includes(`onToggle={() => toggle("${key}")}`) ||
          home.includes(`useCallback(() => toggle("${key}"), [toggle])`),
      }).toEqual({ key, toggles: true });
  });

  test("a face opens its conversation as its row does, and its long press is the row's own", () => {
    const row = src("chats/ConversationRowView.tsx");
    expect(row).toContain("export function OpensConversation(");
    expect(row).toContain("<OpensConversation");
    expect(strip).toContain("<OpensConversation");
    expect(strip).toContain('onStart={r.kind === "dm" && !r.channelId ? onStart : undefined}');
    expect(strip).toContain("onTouchStart={warm}");
    expect(strip).toContain("{...hold}");
  });

  test("the app's faces, the kit's press and badge, the screen's sides, and nothing that moves for show", () => {
    expect(strip).toContain("<AgentFace agentId={r.with.id} size={FACE - 2} mode={facts.face} live={live} presence />");
    expect(strip).toContain('<Tile icon="hash" size={FACE} />');
    expect(strip).toMatch(/<PressScale\s+haptic=\{false\}/);
    expect(strip).toContain("<Count");
    expect(strip).toContain("paddingHorizontal: SCREEN_X");
    expect(strip).toContain("if (items.length === 0) return null;");
    expect(strip).toContain("<ScrollView horizontal showsHorizontalScrollIndicator={false}");
    expect(strip).not.toMatch(/entering=|withTiming|withSpring|snapToInterval/);
    // Only a pinned agent at work moves, within the home's budget, and none while the strip is closed.
    expect(home).toContain('const moves = !collapsed.includes("pinned") && facts.face === "run" && live < LIVE_ROWS;');
  });

  test("its words in both languages, and the per-kind sections' words gone", () => {
    for (const keysOf of [featureKeysEn, featureKeysPtBR]) {
      expect(typeof keysOf.chats.pinned).toBe("string");
      expect(typeof keysOf.chats.recent).toBe("string");
      expect(typeof keysOf.chats.seeAll).toBe("string");
      expect("section" in keysOf.chats).toBe(false);
      expect("seeAll" in keysOf.categories).toBe(false);
    }
    expect(featureKeysPtBR.chats.pinned).toBe("Fixados");
    expect(featureKeysPtBR.chats.recent).toBe("Recentes");
  });
});
