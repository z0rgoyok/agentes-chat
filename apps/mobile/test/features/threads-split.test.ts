import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationRow } from "../../src/features/chats/logic";
import { firstChatOf, pushedChatOf, THREADS_TAB, threadSplit } from "../../src/features/chats/split";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

/** Only what the split reads of a row. */
const row = (kind: ConversationRow["kind"], channelId: string, threadId?: string) =>
  ({ kind, key: `${kind}:${channelId}:${threadId ?? ""}`, channelId, threadId }) as unknown as ConversationRow;

describe("Threads in two panes (ADR 0212)", () => {
  test("its own choice per workspace, apart from Conversas'; the first thread or mission opens with none yet", () => {
    expect(threadSplit.chosen("org-threads-a")).toBeNull();
    threadSplit.choose("org-threads-a", { channelId: "c1", threadId: "t1" });
    expect(threadSplit.chosen("org-threads-a")).toEqual({ channelId: "c1", threadId: "t1" });
    expect(threadSplit.shownKey("org-threads-a")?.startsWith("c1:t1:")).toBe(true);
    // Missions come first in the list, then threads: the first one of either opens.
    expect(firstChatOf([row("mission", "c2", "m1"), row("thread", "c1", "t1")])).toEqual({
      channelId: "c2",
      threadId: "m1",
    });
    expect(THREADS_TAB).toBe("threads");
    // A thread pushed over the tabs is the chat route on top, with its thread.
    expect(pushedChatOf(["(app)", "(main)", "chat", "[channelId]"], { channelId: "c1", thread: "t1" })).toEqual({
      channelId: "c1",
      threadId: "t1",
    });
  });

  test("wide, the list and the open thread side by side, each pane with its own bar; compact as always", () => {
    const screen = src("chats/ThreadsScreen.tsx");
    const top = screen.slice(screen.indexOf("export function ThreadsScreen("), screen.indexOf("function ThreadsList("));
    expect(top).toContain("const wide = useWide();");
    expect(top).toContain("if (pushed) return <ThreadsList pushed />;");
    expect(top).toContain("<Stack.Screen options={wide ? SPLIT_OPTIONS : LIST_OPTIONS} />");
    // The handoff watches in both sizes; it takes back only what was pushed from this tab.
    expect(top).toContain('<ChatHandoff wide={wide} store={threadSplit} owner="threads" home="/threads" />');
    expect(top).toMatch(
      /<ChatSplit\s+store=\{threadSplit\}\s+list=\{<ThreadsList \/>\}\s+testID="threads-split"\s+empty=\{t\("mobile\.threads\.splitEmpty"\)\}/,
    );
    expect(top).toMatch(/\) : \(\s*<ThreadsList \/>\s*\)\}/);
    expect(screen).toContain("const SPLIT_OPTIONS = { headerShown: false };");
    expect(screen).toContain("const LIST_OPTIONS = { headerShown: true };");
  });

  test("with nothing open the list's first opens beside it; with none, a quiet line in the words of each language", () => {
    const screen = src("chats/ThreadsScreen.tsx");
    expect(screen).toContain("const first = opener ? firstChatOf(sections.flatMap((s) => s.rows)) : null;");
    expect(screen).toContain(
      "{opener ? <OpenFirstChat channelId={first?.channelId ?? null} threadId={first?.threadId ?? null} /> : null}",
    );
    expect(featureKeysEn.threads.splitEmpty).toBe("Your threads open here.");
    expect(featureKeysPtBR.threads.splitEmpty).toBe("Suas threads abrem aqui.");
  });

  test("its rows open beside the list and stay lit, through the split's own opener (Conversas' rows)", () => {
    const split = src("chats/ChatsSplit.tsx");
    // The opener carries the split's store, so a row lights the thread open in Threads, not in Conversas.
    expect(split).toContain("() => ({ orgId, store, open: (target) => store.choose(orgId, target) }),");
    expect(src("chats/ThreadsScreen.tsx")).toContain("<ConversationItem");
    expect(src("chats/ConversationRowView.tsx")).toContain("const chosen = useIsChosen(opener, chatOfRow(r));");
  });
});
