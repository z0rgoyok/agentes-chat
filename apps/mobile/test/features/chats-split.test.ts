import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationRow } from "../../src/features/chats/logic";
import {
  chatOfHref,
  chatOfRow,
  chatOwner,
  chatSplit,
  chooseChat,
  chosenChat,
  chosenKey,
  firstChatOf,
  handoffOf,
  pushedChatOf,
  sameChat,
  threadSplit,
} from "../../src/features/chats/split";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

/** Only what the split reads of a row of Conversas. */
const row = (kind: ConversationRow["kind"], channelId: string, threadId?: string) =>
  ({ kind, key: `${kind}:${channelId}:${threadId ?? ""}`, channelId, threadId }) as unknown as ConversationRow;

describe("the conversation open beside the list (ADR 0212)", () => {
  test("a row opens its conversation, a thread's or a mission's at that thread; an agent with none opens nothing", () => {
    expect(chatOfRow(row("channel", "c1"))).toEqual({ channelId: "c1", threadId: null });
    expect(chatOfRow(row("dm", "d1"))).toEqual({ channelId: "d1", threadId: null });
    expect(chatOfRow(row("thread", "c1", "t1"))).toEqual({ channelId: "c1", threadId: "t1" });
    expect(chatOfRow(row("mission", "c1", "t2"))).toEqual({ channelId: "c1", threadId: "t2" });
    expect(chatOfRow(row("dm", ""))).toBeNull();
    expect(sameChat({ channelId: "c1", threadId: null }, { channelId: "c1", threadId: null })).toBe(true);
    expect(sameChat({ channelId: "c1", threadId: null }, { channelId: "c1", threadId: "t1" })).toBe(false);
    expect(sameChat(null, null)).toBe(true);
  });

  test("with nothing open yet, the list's first conversation: agents never talked to are skipped", () => {
    expect(firstChatOf([row("dm", ""), row("thread", "c2", "t9"), row("channel", "c3")])).toEqual({
      channelId: "c2",
      threadId: "t9",
    });
    expect(firstChatOf([row("dm", "")])).toBeNull();
    expect(firstChatOf([])).toBeNull();
  });

  test("the choice is kept per workspace; a new visit of the same conversation draws its pane afresh", () => {
    expect(chosenChat("org-split-a")).toBeNull();
    expect(chosenKey("org-split-a")).toBeNull();
    chooseChat("org-split-a", { channelId: "c1", threadId: null });
    expect(chosenChat("org-split-a")).toEqual({ channelId: "c1", threadId: null });
    const first = chosenKey("org-split-a");
    // The same conversation again keeps its pane (a redraw, a second tap on its row).
    chooseChat("org-split-a", { channelId: "c1", threadId: null });
    expect(chosenKey("org-split-a")).toBe(first);
    // Handed over from a pushed screen, it opens afresh at the place handed with it.
    chooseChat("org-split-a", { channelId: "c1", threadId: null }, true);
    expect(chosenKey("org-split-a")).not.toBe(first);
    expect(chosenKey("org-split-a")?.startsWith("c1::")).toBe(true);
    chooseChat("org-split-a", { channelId: "c1", threadId: "t1" });
    expect(chosenChat("org-split-a")).toEqual({ channelId: "c1", threadId: "t1" });
    // Another workspace has its own.
    expect(chosenChat("org-split-b")).toBeNull();
  });

  test("the conversation pushed over the tabs is the main stack's chat route on top, and nothing else", () => {
    const chat = ["(app)", "(main)", "chat", "[channelId]"];
    expect(pushedChatOf(chat, { channelId: "c1" })).toEqual({ channelId: "c1", threadId: null });
    expect(pushedChatOf(chat, { channelId: "c1", thread: "t1", m: "m1" })).toEqual({ channelId: "c1", threadId: "t1" });
    // A thread id equal to its channel's is the channel (as `chatHref` writes it).
    expect(pushedChatOf(chat, { channelId: "c1", thread: "c1" })).toEqual({ channelId: "c1", threadId: null });
    expect(pushedChatOf(chat, { channelId: "../x" })).toBeNull();
    expect(pushedChatOf(["(app)", "(main)", "(tabs)", "(chats)"], { channelId: "c1" })).toBeNull();
    expect(pushedChatOf(["(app)", "(main)", "agent", "[id]"], { id: "a1" })).toBeNull();
    expect(pushedChatOf(["(app)", "consultation", "[id]"], { channelId: "c1" })).toBeNull();
  });

  test("a conversation's address opens in the split; an agent's request for help stays on its pushed screen", () => {
    expect(chatOfHref("/chat/c1")).toEqual({ channelId: "c1", threadId: null });
    expect(chatOfHref("/chat/c1?thread=t1")).toEqual({ channelId: "c1", threadId: "t1" });
    expect(chatOfHref("/chat/c1?thread=t1&m=m2")).toEqual({ channelId: "c1", threadId: "t1" });
    expect(chatOfHref("/chat/c1?m=m2&still=1")).toEqual({ channelId: "c1", threadId: null });
    expect(chatOfHref("/chat/c1?handoff=h1")).toBeNull();
    expect(chatOfHref("/agent/a1")).toBeNull();
    expect(chatOfHref("/chat/c1/x")).toBeNull();
    expect(chatOfHref("/routines")).toBeNull();
  });

  test("closing the device pushes the open conversation; opening it shows the pushed one in the split", () => {
    const open = { channelId: "c1", threadId: null };
    const pushed = { channelId: "c2", threadId: "t2" };
    // Wide to compact with the split on screen: the conversation it shows is pushed.
    expect(handoffOf(true, false, { splitShown: true, chosen: open, pushed: null })).toEqual({
      kind: "push",
      chat: open,
    });
    // Another tab, or a screen pushed over the split: nothing moves.
    expect(handoffOf(true, false, { splitShown: false, chosen: open, pushed: null })).toBeNull();
    expect(handoffOf(true, false, { splitShown: true, chosen: null, pushed: null })).toBeNull();
    // Compact to wide with a conversation pushed over the tabs: back on the tabs, it opens in the split.
    expect(handoffOf(false, true, { splitShown: false, chosen: open, pushed })).toEqual({
      kind: "split",
      chat: pushed,
    });
    expect(handoffOf(false, true, { splitShown: true, chosen: open, pushed: null })).toBeNull();
    // No change of size class: nothing.
    expect(handoffOf(true, true, { splitShown: true, chosen: open, pushed })).toBeNull();
    expect(handoffOf(false, false, { splitShown: true, chosen: open, pushed })).toBeNull();
  });
});

describe("Conversas in two panes (ADR 0212)", () => {
  test("wide, the list and the open conversation side by side, each pane with its own bar; compact as always", () => {
    const screen = src("chats/ChatsScreen.tsx");
    const top = screen.slice(screen.indexOf("export function ChatsScreen()"), screen.indexOf("function Home()"));
    expect(top).toContain("const wide = useWide();");
    expect(top).toContain("<Stack.Screen options={wide ? SPLIT_OPTIONS : LIST_OPTIONS} />");
    expect(top).toContain("const SPLIT_OPTIONS = { headerShown: false };");
    expect(top).toContain("const LIST_OPTIONS = { headerShown: true };");
    // The handoff watches in both sizes: it is what moves the conversation between them.
    expect(top).toContain("<SplitHandoff wide={wide} />");
    expect(top).toMatch(/\) : \(\s*<SheetHostProvider>\s*<Home \/>\s*<\/SheetHostProvider>\s*\)\}/);
    const split = src("chats/ChatsSplit.tsx");
    expect(split).toContain(
      '<ChatSplit store={chatSplit} list={list} testID="chats-split" empty={t("mobile.chats.splitEmpty")} />',
    );
    // The panes every split shares: the list's, then the detail's, keyed by the open conversation in its boundary.
    expect(split).toMatch(/<SplitPanes\s+testID=\{testID\}\s+list=\{list\}/);
    expect(split).toContain("ownInsets");
    expect(split).toContain("detailKey={key && chat ? key : null}");
    expect(split).toContain("detail={chat ? <ConversationPane chat={chat} /> : null}");
    const panes = src("shared/SplitPanes.tsx");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the panes' source
    expect(panes).toContain("list={<Pane testID={`${testID}-list`}>{list}</Pane>}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the panes' source
    expect(panes).toContain("<Pane ownInsets={ownInsets} testID={`${testID}-detail`}>");
    expect(panes).toContain(
      "{detailKey !== null ? <PaneBoundary key={detailKey}>{detail}</PaneBoundary> : <NothingOpen text={empty} />}",
    );
    // The open conversation is the conversation's own screen, remembered as the place to reopen (ADR 0108).
    expect(split).toContain("<ChatScreen channelId={chat.channelId} threadId={chat.threadId} />");
    expect(split).toContain("useRememberPlace(chatHref(chat.channelId, chat.threadId));");
  });

  test("with nothing open the most recent conversation opens; with none, a quiet line in the words of each language", () => {
    const screen = src("chats/ChatsScreen.tsx");
    expect(screen).toContain(
      "const first = opener ? firstChatOf(pinned.pin ? [...recent, pinned.pin] : recent) : null;",
    );
    expect(screen).toContain(
      "{opener ? <OpenFirstChat channelId={first?.channelId ?? null} threadId={first?.threadId ?? null} /> : null}",
    );
    const split = src("chats/ChatsSplit.tsx");
    // In the split the list is in (Conversas' or Threads').
    expect(split).toContain('const key = (opener?.store ?? chatSplit).useShownKey(opener?.orgId ?? "");');
    expect(split).toContain("if (opener && !key && channelId) opener.open({ channelId, threadId });");
    expect(split).toContain('{t("mobile.chats.splitEmpty")}');
    expect(featureKeysEn.chats.splitEmpty).toBe("Your chats open here.");
    expect(featureKeysPtBR.chats.splitEmpty).toBe("Suas conversas abrem aqui.");
  });

  test("a row opens its conversation beside the list instead of pushing it, and stays lit while it is open", () => {
    const rows = src("chats/ConversationRowView.tsx");
    // Lit in the split it is in: Conversas and Threads each keep their own.
    expect(rows).toContain("const chosen = useIsChosen(opener, chatOfRow(r));");
    expect(src("chats/split.ts")).toContain(
      "return (opener?.store ?? chatSplit).useIsShown(opener?.orgId ?? null, target);",
    );
    expect(rows).toContain("opens={!opener}");
    expect(rows).toContain("background: withAlpha(c.ink, CHOSEN_TINT), accessibilityState: { selected: true }");
    expect(rows).toMatch(
      /else if \(opener && r\.channelId\) \{\s*const chat = chatOfRow\(r\);\s*if \(chat\) opener\.open\(chat\);/,
    );
    // No preview to peek at: the conversation opens next to the list, the long press is the row's menu.
    expect(rows).toContain('const peeks = Platform.OS === "ios" && peekHref !== null && !opener;');
    // The right hand's field, a new DM, another channel and the start page open there too.
    expect(src("right-hand/Pin.tsx")).toContain(
      "else if (opener) opener.open({ channelId: row.channelId, threadId: null });",
    );
    expect(src("new/useOpenDm.ts")).toContain("else if (opener) opener.open({ channelId, threadId: null });");
    expect(src("chats/ChatsScreen.tsx")).toContain(
      "onPress={() => (opener ? opener.open({ channelId: o.id, threadId: null }) : router.push(chatHref(o.id)))}",
    );
    expect(src("me/useStart.ts")).toContain("if (opener && chat) opener.open(chat);");
    // Switching conversation from the pill swaps the pane, not the route's params.
    expect(src("chat/screen/useConversationActions.tsx")).toContain(
      "else if (opener) sheet.close(() => opener.open({ channelId: id, threadId: null }));",
    );
  });

  test("the window changing size class hands the conversation and its reading place over", () => {
    const split = src("chats/ChatsSplit.tsx");
    expect(split).toContain('return <ChatHandoff wide={wide} store={chatSplit} owner="chats" home="/" />;');
    const handoff = split.slice(split.indexOf("export function ChatHandoff("));
    expect(handoff).toContain("handPlace(place, readingPlace(place));");
    // A conversation pushed from the Threads tab is Threads' to take back; Conversas takes any other.
    expect(handoff).toContain("pushed: chatOwner(selectedTab()) === owner ? pushedChatOf(segments, params) : null,");
    // Closing: pushed in place, without the slide (the conversation was already on screen).
    expect(handoff).toContain("router.push(stillHref(chatHref(chat.channelId, chat.threadId)) as never);");
    // Opening: afresh in the pane at the place handed over, then back to its tab.
    expect(handoff).toMatch(/store\.choose\(orgId, chat, true\);\s*landOn\(home\);/);
    const shared = src("shared/SplitPanes.tsx");
    const moving = shared.slice(shared.indexOf("export function useSplitHandoff<T>("));
    expect(moving).toContain("const step = splitHandoff(before, wide, latest.current.read());");
    expect(moving).toContain("}, [wide]);");
  });

  test("the tab under a pushed conversation decides whose split takes it back", () => {
    expect(chatOwner("threads")).toBe("threads");
    expect(chatOwner("(chats)")).toBe("chats");
    expect(chatOwner("agents")).toBe("chats");
    expect(chatOwner(null)).toBe("chats");
    // Threads' own choice, never Conversas'.
    chooseChat("org-split-c", { channelId: "c1", threadId: null });
    threadSplit.choose("org-split-c", { channelId: "c9", threadId: "t9" });
    expect(chosenChat("org-split-c")).toEqual({ channelId: "c1", threadId: null });
    expect(threadSplit.chosen("org-split-c")).toEqual({ channelId: "c9", threadId: "t9" });
    expect(chatSplit.chosen("org-split-c")).toEqual({ channelId: "c1", threadId: null });
  });
});
