import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildConversations, type ConversationRow } from "../../src/features/chats/logic";
import { type RowContext, reuseByKey, rowFacts, samePlain } from "../../src/features/chats/rowFacts";
import { agent, at, thread, translator } from "./fixtures";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

const ada = agent({ id: "a-ada", name: "Ada", appearance: { color: "indigo" } });
const NOW = new Date(2026, 9, 17, 15, 0).getTime();

async function context(over: Partial<RowContext> = {}): Promise<RowContext> {
  const t = await translator("en");
  const agents = new Map([[ada.id, ada]]);
  return {
    t,
    locale: "en",
    now: NOW,
    dir: {
      agentById: agents,
      nameOf: (who) =>
        who?.type === "agent" ? (agents.get(who.id ?? "")?.name ?? "") : who?.id === "u-theo" ? "Theo" : "",
    },
    presence: { person: () => null, agent: () => null },
    channelName: () => undefined,
    org: null,
    short: (iso) => `at ${iso.slice(11, 16)}`,
    ...over,
  };
}

const channel = (over: Record<string, unknown> = {}) =>
  buildConversations({
    channels: [
      {
        id: "c-vendas",
        name: "vendas",
        topic: "",
        isMember: true,
        unreadCount: 2,
        mentionCount: 0,
        lastMessage: {
          authorType: "person",
          authorId: "u-theo",
          authorName: "Theo",
          preview: "Bom dia",
          createdAt: at(5),
        },
        ...over,
      },
    ] as never,
    dms: [],
    threads: [],
  })[0] as ConversationRow;

const agentDm = (): ConversationRow => ({
  kind: "dm",
  key: "d:c-ada",
  channelId: "c-ada",
  with: { type: "agent", id: ada.id, name: "Ada", handle: "ada" },
  last: null,
  at: at(30),
  unread: 0,
  working: false,
});

describe("a conversation's row says it from plain values, worked out once per screen", () => {
  test("a channel: who said its last line and what, its time and its count", async () => {
    const ctx = await context();
    const facts = rowFacts(channel(), undefined, ctx);
    expect(facts.line).toEqual({ kind: "last", lead: "Theo", text: "Bom dia" });
    expect(facts.label).toBe("Theo: Bom dia");
    expect(facts.badge).toBe(2);
    expect(facts.mention).toBe(false);
    expect(facts.time).toBe(`at ${at(5).slice(11, 16)}`);
    expect(facts.place).toBeNull();
    // A mention of me is the row's number, as on the web.
    expect(rowFacts(channel({ mentionCount: 1 }), undefined, ctx)).toMatchObject({ badge: 1, mention: true });
  });

  test("an agent at work: its face works, the orbit in its tones, what it does in place of its last line", async () => {
    const ctx = await context();
    const facts = rowFacts(
      agentDm(),
      { kind: "working", work: { kind: "run", what: "Corrigir o link" } as never },
      ctx,
    );
    expect(facts.face).toBe("run");
    expect(facts.orbit).toBe("indigo");
    expect(facts.line).toEqual({ kind: "doing", text: "Corrigir o link" });
    expect(facts.label).toBe(ctx.t("mobile.homeNow.doingLabel", { what: "Corrigir o link" }));
  });

  test("an agent waiting for its computer dozes, and says so by a clock", async () => {
    const ctx = await context();
    const facts = rowFacts(agentDm(), { kind: "computer", computer: "MacBook" }, ctx);
    expect(facts.face).toBe("rest");
    expect(facts.line).toEqual({ kind: "away", text: ctx.t("mobile.outage.rowWaiting", { computer: "MacBook" }) });
  });

  test("what waits on you is amber, with what it is", async () => {
    const ctx = await context();
    const facts = rowFacts(agentDm(), { kind: "waiting", wait: "approval", title: "PR #128" }, ctx);
    expect(facts.line).toMatchObject({ kind: "state", mark: null, amber: true, rest: " · PR #128" });
    expect(facts.face).toBe("idle");
  });

  test("a thread at work: the orbit in its longest worker's tones and how long, the place over its name", async () => {
    const ctx = await context();
    const [row] = buildConversations({
      channels: [],
      dms: [],
      threads: [
        thread({
          id: "t-1",
          channelName: "vendas",
          title: "Preço novo",
          working: true,
          worker: ada.id,
          since: new Date(NOW - 22 * 60_000).toISOString(),
        }),
      ],
    });
    const facts = rowFacts(row as ConversationRow, undefined, ctx);
    expect(facts.orbit).toBe("indigo");
    expect(facts.line).toMatchObject({
      kind: "state",
      mark: "orbit",
      strong: true,
      word: ctx.t("threads.status.working"),
    });
    expect(facts.place).toBe(`${ctx.t("mobile.chats.thread")} · #vendas`);
  });

  test("a row kept while nothing in it changes: the same object, so its memoized drawing stays", async () => {
    const ctx = await context();
    const one = channel();
    const again = channel();
    expect(one).not.toBe(again);
    expect(samePlain(one, again)).toBe(true);
    const first = reuseByKey(new Map(), [one]);
    const second = reuseByKey(first.byKey, [again, agentDm()]);
    expect(second.list[0]).toBe(one);
    // A changed row is the new one.
    const third = reuseByKey(second.byKey, [channel({ unreadCount: 3 })]);
    expect(third.list[0]).not.toBe(one);
    expect(samePlain(rowFacts(one, undefined, ctx), rowFacts(again, undefined, ctx))).toBe(true);
  });
});

describe("a screen of rows", () => {
  test("Conversas and its Ver todos draw the same rows: a swipe to pin or silence, the long press's menu", () => {
    const home = src("chats/ChatsScreen.tsx");
    const all = src("chats/ConversationListScreen.tsx");
    for (const screen of [home, all]) {
      expect(screen).toContain("<HomeRow");
      expect(screen).toContain("facts={factsOf(r, agentStates.get(r.key))}");
      expect(screen).toContain("onHold={menus.openRowMenu}");
      expect(screen).toContain("holdActions={menus.rowActionsOf}");
      expect(screen).toContain("onMute={muteRow}");
      expect(screen).toContain("useConversationRows()");
    }
    // Ver todos: the home's large title, rows of its shape while it loads (never "Loading…"), the sheet its menu needs.
    expect(all).toContain("<PushedLargeTitle");
    expect(all).toContain("<SkeletonList rows={6} />");
    expect(all).not.toContain("mobile.common.loading");
    expect(all).toContain("<SheetHostProvider>");
    const row = src("chats/HomeRow.tsx");
    expect(row).toContain("export const HomeRow = memo(");
    expect(row).toContain("<SwipeRow right={panes}>");
  });

  test("a row reads nothing itself: no directory, presence or clock per row, one minute's clock for the list", () => {
    const row = src("chats/ConversationRowView.tsx");
    const item = row.slice(
      row.indexOf("export const ConversationItem"),
      row.indexOf("export const ConversationRowView"),
    );
    for (const hook of ["useDirectory(", "usePresenceOf(", "useNow(", "useAgentWorkLine(", "useWhen("])
      expect({ hook, read: item.includes(hook) }).toEqual({ hook, read: false });
    expect(src("chats/useRows.ts")).toContain("const now = useNow(WORK_TICK_MS);");
  });

  test("past the moving rows an orbit holds still, as the faces do", () => {
    expect(src("chats/ConversationRowView.tsx")).toContain(
      "<PixelOrbit color={facts.orbit} size={ORBIT} still={!live} />",
    );
  });

  test("a finger only starting a scroll lights no row; the finger landing already asks for the conversation", () => {
    const section = src("chats/HomeSection.tsx");
    const seeAll = section.slice(section.indexOf("export function SeeAllRow"));
    // A list row: `RowPressable` holds its light back by the row press delay.
    expect(seeAll).toContain("<RowPressable onPress={onPress} hold");
    expect(section.slice(0, section.indexOf("export function SeeAllRow"))).toContain(
      "unstable_pressDelay={ROW_PRESS_DELAY}",
    );
    // The prefetch starts on touch-down, not after the press delay (it started only a few ms before the push): the
    // messages and what the rows wait for (`prefetchConversation`), a thread's replies too; fresh ones aren't read
    // again.
    const row = src("chats/ConversationRowView.tsx");
    expect(row).toContain("onTouchStart={warm}");
    expect(row).toContain("const prefetch = usePrefetchConversation(orgId);");
    expect(row).toContain(
      'if (r.channelId) prefetch(r.channelId, r.kind === "thread" || r.kind === "mission" ? r.threadId : null);',
    );
    const ui = (file: string) => readFileSync(join(import.meta.dir, "../../src/ui", file), "utf8");
    expect(ui("ListRow.tsx")).toContain("<RowPressable {...press} hold={opens}");
    expect(ui("RowPressable.tsx")).toContain("unstable_pressDelay = ROW_PRESS_DELAY,");
    expect(ui("RowPressable.tsx")).toContain("onPressIn?.(e);");
  });

  test("the home's sky comes up within 300 ms of the splash leaving", () => {
    expect(src("chats/ChatsScreen.tsx")).toContain("const SKY_ARRIVE_MS = 300;");
  });
});
