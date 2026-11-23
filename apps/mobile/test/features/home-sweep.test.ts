import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("the large title's scroll view is the screen's own first view", () => {
  test("a selection's bar goes in PushedLargeTitle's dock, never in a view wrapped around it", () => {
    for (const [file, bar] of [
      ["wiki/WikiScreen.tsx", "dock={pickBar}"],
      ["wiki/WikiBulk.tsx", "dock={bar}"],
    ] as const) {
      const code = src(file);
      expect({ file, dock: code.includes(bar) }).toEqual({ file, dock: true });
      expect({ file, wrapped: /<View style=\{styles\.fill\}>\s*<PushedLargeTitle/.test(code) }).toEqual({
        file,
        wrapped: false,
      });
    }
  });
});

describe("headers are the system's own", () => {
  test("a wiki page's Editar and … are native bar buttons, the … the system's menu on iOS", () => {
    const page = src("wiki/WikiScreen.tsx");
    expect(page).toContain("actions={barActions}");
    expect(page).toContain('sf: "ellipsis"');
    expect(page).toContain("menu: items.map((i) => ({");
    // Android lists the same choices in the app's sheet.
    expect(page).toContain("chooseAction(\n              p.title,");
    expect(page).not.toContain("barWordText");
  });

  test("a wiki page's name comes into the bar as its heading scrolls away", () => {
    const page = src("wiki/WikiScreen.tsx");
    expect(page).toContain("<FadingHeaderTitle");
    expect(page).toContain("onScroll={scroll.onScroll}");
  });

  test("the wiki's forms are settings pages with their word in the bar", () => {
    for (const file of ["wiki/WikiScreen.tsx", "wiki/WikiBulk.tsx", "wiki/WikiAudience.tsx"]) {
      expect({ file, form: src(file).includes("<SettingsPage") }).toEqual({ file, form: true });
    }
    const move = src("wiki/WikiScreen.tsx");
    expect(move).toContain('<GroupedField label={t("wiki.form.title")}>');
    expect(move).not.toContain("backgroundColor: c.sunken, color: c.ink");
  });

  test("New page is the sheet's bar and form fields; who sees never opens a list under a row", () => {
    const sheet = src("wiki/WikiWrite.tsx");
    expect(sheet).toContain('<SheetHeader title={t("wiki.newPage")} />');
    expect(sheet).toContain("<WhoSeesRows draft={sees} />");
    expect(sheet).not.toContain("setChoosing");
    expect(sheet).not.toContain('<Text variant="title2" accessibilityRole="header">\n        {t("wiki.newPage")}');
  });
});

describe("states: the rows' shape while loading, LoadFailed when it failed", () => {
  test.each([
    ["chats/ArchivedChannelsScreen.tsx", "<LoadFailed onRetry={() => void list.refetch()} />"],
    ["chats/ThreadsScreen.tsx", "<LoadFailed onRetry={() => void list.refetch()} />"],
    ["activity/ActivityScreen.tsx", "<LoadFailed onRetry={() => void list.refetch()} />"],
    ["wiki/WikiScreen.tsx", "<LoadFailed onRetry={() => void tree.refetch()} />"],
    ["wiki/WikiScreen.tsx", "<LoadFailed onRetry={() => void page.refetch()} />"],
    ["wiki/WikiScreen.tsx", "<LoadFailed onRetry={() => void history.refetch()} />"],
    ["wiki/WikiBulk.tsx", "<LoadFailed onRetry={() => void trash.refetch()} />"],
    ["memory/MemoryScreen.tsx", "<LoadFailed onRetry={() => void memories.refetch()} />"],
    ["search/SearchFilters.tsx", "<LoadFailed onRetry={() => void hits.refetch()} />"],
  ])("%s says it failed", (file, failed) => {
    expect(src(file)).toContain(failed);
  });

  test("no list in this area waits on a bare spinner", () => {
    for (const file of [
      "chats/ArchivedChannelsScreen.tsx",
      "wiki/WikiBulk.tsx",
      "memory/MemoryScreen.tsx",
      "auth/InviteGone.tsx",
    ]) {
      expect({ file, spinner: src(file).includes("ActivityIndicator") }).toEqual({ file, spinner: false });
    }
    // A wiki page loads in its own shape; who sees a page has its bar from the first frame.
    expect(src("wiki/WikiScreen.tsx")).toContain("{page.isLoading ? <PageSkeleton /> : null}");
    expect(src("wiki/WikiAudience.tsx")).not.toContain("return null;");
  });

  test("a section loading has no count yet and its header still opens and closes it", () => {
    const section = src("chats/HomeSection.tsx");
    expect(section).toContain("count?: number;");
    for (const file of ["chats/ChatsScreen.tsx", "chats/ThreadsScreen.tsx"]) {
      const code = src(file);
      expect({ file, noop: code.includes("onToggle={() => {}}"), zero: code.includes("count={0}") }).toEqual({
        file,
        noop: false,
        zero: false,
      });
    }
  });
});

describe("the kit's own parts, not look-alikes", () => {
  test("the channels an administrator isn't in are list rows on the home's plain list", () => {
    const home = src("chats/ChatsScreen.tsx");
    expect(home).not.toContain("<GroupedRow");
    expect(home).toContain('leading={<Tile icon="lock" size={LIST_AVATAR} />}');
  });

  test("the first agent's examples are grouped rows", () => {
    const empty = src("chats/Greeting.tsx");
    expect(empty).toContain("<GroupedRow");
    expect(empty).not.toContain("IDEA_INSET");
  });

  test("the search box's filters are tokens", () => {
    const filters = src("search/SearchFilters.tsx");
    expect(filters).toContain("<Token");
    expect(filters).not.toContain("PressScale");
  });

  test("Atividade's next page is the kit's button, with its wheel while it comes", () => {
    const activity = src("activity/ActivityScreen.tsx");
    expect(activity).toContain('label={t("mobile.activity.more")}');
    expect(activity).toContain("loading={list.isFetchingNextPage}");
    // What a row decides under it starts at the row's words.
    expect(activity).toContain("change: { paddingLeft: LIST_INSET, paddingRight: 16, paddingBottom: 12 },");
  });

  test("a new channel's name sits in a group on the grouped rows' ruler, its fine print as a group's footer", () => {
    const form = src("new/NewChannelForm.tsx");
    expect(form).toContain("<GroupedList>");
    expect(form).toContain("<GroupedFooter>");
    expect(form).toContain("minHeight: GROUPED_ROW.minHeight,");
    expect(form).not.toContain("marginHorizontal: 6");
  });

  test("a conversation's search runs edge to edge by exactly the sheet's own padding", () => {
    expect(src("search/ConversationSearch.tsx")).toContain("bleed: { marginHorizontal: -SHEET_X, marginTop: 10 },");
  });

  test("the wiki's folder shortcuts are the kit's filters", () => {
    const wiki = src("wiki/WikiScreen.tsx");
    const chips = wiki.slice(wiki.indexOf("export function FolderChips"));
    expect(chips).toContain("<Filters");
    expect(chips).not.toContain("<Pressable");
  });
});

describe("motion only where it helps", () => {
  test("New's page and field never animate their layout as the person types", () => {
    const create = src("new/NewScreen.tsx");
    expect(create).not.toContain("<Animated.View layout={layout}>");
  });

  test("the search tab slides under its folding title only where the title is drawn", () => {
    expect(src("search/SearchScreen.tsx")).toContain(
      'const layout = reduced || Platform.OS === "ios" ? undefined : LinearTransition.duration(220);',
    );
  });
});

describe("every tap does something visible", () => {
  test("a link in a page's preview opens it, or says it doesn't exist yet", () => {
    const write = src("wiki/WikiWrite.tsx");
    expect(write).toContain("onOpenLink={previewLink}");
    expect(write).not.toContain("onOpenLink={() => undefined}");
  });

  test("a version being read says so on its row", () => {
    expect(src("wiki/WikiScreen.tsx")).toContain("reading === v.version ? (");
  });

  test("the wiki map's filters sit under the bar's real height", () => {
    const map = src("wiki/WikiMap.tsx");
    expect(map).toContain("top: headerHeight + 8");
    expect(map).not.toContain("insets.top + 52");
  });
});
