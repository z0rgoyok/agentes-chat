import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownOptionsOf } from "../main-stack";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("the keyboard comes up only for a tap", () => {
  test.each([
    "features/wiki/WikiWrite.tsx",
    "features/new/NewChannelForm.tsx",
    "features/new/NewScreen.tsx",
    "features/new/NewChatPicker.tsx",
    "features/new/ChatTargets.tsx",
  ])("%s focuses no field as it opens", (file) => {
    const code = src(file);
    expect(code).not.toContain("autoFocus");
    expect(code).not.toMatch(/\.focus\(\);?\s*\}, \[\]\)/);
  });

  test("a person or an agent picked in New opens the conversation with its keyboard down", () => {
    const create = src("features/new/NewScreen.tsx");
    expect(create).not.toContain("compose: true");
    expect(create).toContain("openDm({ agentId }, { replace: true })");
    expect(create).toContain("openDm({ userId: p.userId }, { replace: true })");
  });

  test("the wiki editor's tools ride on the keys, never a bar's height behind them", () => {
    const write = src("features/wiki/WikiWrite.tsx");
    // Measured where it is on the screen (under the bar), not from its parent's top.
    expect(write).toContain('<KeyboardAvoidingView behavior="padding" automaticOffset style={styles.fill}>');
    // The home indicator's room goes as the keyboard comes.
    expect(write).toContain("height: insets.bottom * (1 - keyboard.progress.get())");
    expect(write).not.toContain("<View style={{ height: insets.bottom }} />");
  });

  test("the island's reply field comes only for a tap on Reply, and stays clear of the keyboard", () => {
    const island = src("features/island/NoticeIsland.tsx");
    // The field shows once Reply was tapped (`typing`): its focus answers that tap.
    expect(island).toContain("typing && target ? (");
    expect(island).toContain("onPress={() => setTyping(true)}");
    // Open with the keyboard up, the island ends above it and scrolls the reply's row into sight.
    expect(island).toContain("keyboardHeight > 0 ? keyboardHeight + 12 : insets.bottom + 16");
    expect(island).toContain("list.current?.scrollTo({ y: Math.max(0, replyEnd - size.h)");
  });

  test("a sheet's content puts the keyboard away on a drag", () => {
    for (const file of ["ui/SheetScreen.tsx", "ui/Sheet.tsx", "features/shared/SheetHost.tsx"]) {
      expect({ file, drag: src(file).includes('keyboardDismissMode="on-drag"') }).toEqual({ file, drag: true });
    }
  });
});

describe("New and Chat with…", () => {
  test("New's groups swap at once as the person types: no layout or fade per keystroke", () => {
    const create = src("features/new/NewScreen.tsx");
    expect(create).not.toContain("LinearTransition");
    expect(create).not.toContain("layout={layout}");
    expect(create).not.toContain("FadeOut");
  });

  test("Chat with… lists agents and people in New's own grouped rows", () => {
    const targets = src("features/new/ChatTargets.tsx");
    expect(targets).toContain("<GroupedRow");
    expect(targets).toContain("size={GROUPED_ROW.lead}");
    expect(targets).not.toContain("ActionList");
  });

  test("a search that found nobody offers to clear it", () => {
    for (const file of ["features/new/NewScreen.tsx", "features/new/ChatTargets.tsx"]) {
      expect({ file, clear: src(file).includes('label={t("filters.clearSearch")}') }).toEqual({ file, clear: true });
    }
    expect(src("features/new/NewChatPicker.tsx")).toContain('onClear={() => setQ("")}');
  });

  test("a channel that couldn't be made says why", () => {
    const form = src("features/new/NewChannelForm.tsx");
    expect(form).toContain(".catch(failed)");
    expect(form).not.toContain('t("mobile.app.failed")');
  });
});

describe("headers", () => {
  test("the wiki's graph: a clear bar on both platforms, its title, back and status bar white over the night", () => {
    const map = src("features/wiki/WikiMap.tsx");
    expect(map).toContain('<PushedHeader title={t("wiki.graph")} plate />');
    expect(map).toContain('headerTintColor: "#ffffff", headerTitleStyle: { color: "#ffffff" }');
    expect(map).toContain('{focused ? <StatusBar style="light" /> : null}');
    // Under a clear bar the filters' `headerHeight + 8` is right on both platforms (an opaque one doubled it).
    const layout = readFileSync(join(import.meta.dir, "../../app/(app)/(main)/_layout.tsx"), "utf8");
    expect(layout).toContain('"wiki-map": cover,');
    expect(layout).not.toContain('"wiki-map": solid,');
  });

  test("writing a wiki page lays out below an opaque bar, from the first frame to a conflict", () => {
    expect(ownOptionsOf("wiki-write")).toBe("solid,");
    const write = src("features/wiki/WikiWrite.tsx");
    // A clear bar set while the page loaded (or on a conflict) would stay clear over the text: options merge.
    expect(write).not.toContain("solid={false}");
  });

  test("a page's history names the page under its title, never 'History of' under 'History'", () => {
    const wiki = src("features/wiki/WikiScreen.tsx");
    const history = wiki.slice(wiki.indexOf("export function WikiHistoryScreen"));
    expect(history).not.toContain("wiki.historyTitle");
    expect(history).toContain("{page.data.title}");
  });

  test("the wiki's search sits under its large title as Drive's", () => {
    expect(src("features/wiki/WikiScreen.tsx")).toContain(
      "search: { paddingHorizontal: SCREEN_X, paddingBottom: 10 },",
    );
  });
});

describe("lists that load from the server refresh on a pull", () => {
  test.each([
    ["features/wiki/WikiScreen.tsx", 3],
    ["features/wiki/WikiBulk.tsx", 1],
    ["features/memory/MemoryScreen.tsx", 1],
    ["features/chats/ArchivedChannelsScreen.tsx", 1],
  ])("%s", (file, pulls) => {
    // The wiki's home, a page and a page's history each have one; the trash, Memória and the archived channels too.
    const found = src(file).match(/refreshControl=\{<RefreshControl refreshing=\{pull\.refreshing\}/g)?.length ?? 0;
    expect({ file, pulls: found }).toEqual({ file, pulls });
  });

  test("Memória's rows are the list's own, as the wiki's beside it", () => {
    const memory = src("features/memory/MemoryScreen.tsx");
    expect(memory).toContain("<ListRow");
    expect(memory).toContain("size={LIST_AVATAR - 2}");
    expect(memory).not.toContain("<Row\n");
  });
});
