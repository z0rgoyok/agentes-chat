import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSplitStore,
  hrefOfRoute,
  routeAbove,
  selectedTabOf,
  splitHandoff,
} from "../../src/features/shared/split-store";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("what a split shows beside its list (ADR 0212)", () => {
  test("a choice per workspace; the same item again keeps its pane, `again` draws it afresh", () => {
    const store = createSplitStore((s: string) => s);
    expect(store.shown("w1")).toBeNull();
    expect(store.shownKey("w1")).toBeNull();
    store.choose("w1", "a");
    expect(store.chosen("w1")).toBe("a");
    expect(store.shown("w1")).toBe("a");
    const first = store.shownKey("w1");
    store.choose("w1", "a");
    expect(store.shownKey("w1")).toBe(first);
    store.choose("w1", "a", true);
    expect(store.shownKey("w1")).not.toBe(first);
    expect(store.shownKey("w1")?.startsWith("a:")).toBe(true);
    store.choose("w1", "b");
    expect(store.chosen("w1")).toBe("b");
    // Another workspace has its own.
    expect(store.chosen("w2")).toBeNull();
  });

  test("an offer shows while nothing is chosen, is never the choice, and stays behind one", () => {
    const store = createSplitStore((s: string) => s);
    store.offer("w1", "first");
    expect(store.shown("w1")).toBe("first");
    // Closing the device pushes only a choice.
    expect(store.chosen("w1")).toBeNull();
    const offered = store.shownKey("w1");
    // Choosing what is offered keeps its pane: the same key.
    store.choose("w1", "first");
    expect(store.chosen("w1")).toBe("first");
    expect(store.shownKey("w1")).toBe(offered);
    // A new offer behind a choice changes nothing shown.
    store.offer("w1", "other");
    expect(store.shown("w1")).toBe("first");
    // No offer: nothing.
    const empty = createSplitStore((s: string) => s);
    empty.offer("w1", "x");
    empty.offer("w1", null);
    expect(empty.shown("w1")).toBeNull();
  });

  test("items are named by `keyOf`: one name, one item, the object kept as given", () => {
    const store = createSplitStore((c: { id: string; n: number }) => c.id);
    const one = { id: "a", n: 1 };
    store.choose("w1", one);
    const key = store.shownKey("w1");
    store.choose("w1", { id: "a", n: 2 });
    expect(store.shown("w1")).toBe(one);
    expect(store.shownKey("w1")).toBe(key);
  });

  test("closing the device pushes the choice; opening it takes a page pushed over the split's screen", () => {
    expect(splitHandoff(true, false, { splitShown: true, chosen: "a", pushed: null })).toEqual({
      kind: "push",
      item: "a",
    });
    // Another screen over the split, or nothing chosen: nothing moves.
    expect(splitHandoff(true, false, { splitShown: false, chosen: "a", pushed: null })).toBeNull();
    expect(splitHandoff(true, false, { splitShown: true, chosen: null, pushed: null })).toBeNull();
    expect(splitHandoff(false, true, { splitShown: false, chosen: "a", pushed: "b" })).toEqual({
      kind: "split",
      item: "b",
    });
    expect(splitHandoff(false, true, { splitShown: true, chosen: "a", pushed: null })).toBeNull();
    // No change of size class: nothing.
    expect(splitHandoff(true, true, { splitShown: true, chosen: "a", pushed: "b" })).toBeNull();
    expect(splitHandoff(false, false, { splitShown: true, chosen: "a", pushed: "b" })).toBeNull();
  });

  test("the tab under the pushed screens, read off the tabs' navigator", () => {
    const routes = [{ name: "(chats)" }, { name: "threads" }, { name: "agents" }];
    expect(selectedTabOf({ index: 1, routes })).toBe("threads");
    expect(selectedTabOf({ routes })).toBe("(chats)");
    expect(selectedTabOf({ index: 9, routes })).toBe("agents");
    expect(selectedTabOf({ index: 0, routes: [] })).toBeNull();
    expect(selectedTabOf(undefined)).toBeNull();
  });

  test("the page right above a screen: only when it is on top, right over it", () => {
    const state = {
      index: 2,
      routes: [
        { key: "tabs", name: "(tabs)" },
        { key: "me", name: "me/index" },
        { key: "lang", name: "me/language" },
      ],
    };
    expect(routeAbove(state, "me")?.name).toBe("me/language");
    expect(routeAbove(state, "tabs")).toBeNull();
    expect(routeAbove(state, "lang")).toBeNull();
    expect(routeAbove(state, "nope")).toBeNull();
    expect(routeAbove(undefined, "me")).toBeNull();
    // Settings between: You's page is not over You.
    const deeper = {
      index: 3,
      routes: [...state.routes.slice(0, 2), { key: "set", name: "settings/index" }, { key: "acc", name: "me/account" }],
    };
    expect(routeAbove(deeper, "me")).toBeNull();
    expect(routeAbove(deeper, "set")?.name).toBe("me/account");
  });

  test("a route's address, only with nothing in its params but the mark of a page opened in place", () => {
    expect(hrefOfRoute({ name: "me/language" })).toBe("/me/language");
    expect(hrefOfRoute({ name: "settings/roles/index", params: {} })).toBe("/settings/roles");
    expect(hrefOfRoute({ name: "connectors/index", params: { still: "1" } })).toBe("/connectors");
    expect(hrefOfRoute({ name: "usage", params: { still: undefined } })).toBe("/usage");
    expect(hrefOfRoute({ name: "usage", params: { view: "people" } })).toBeNull();
    expect(hrefOfRoute({ name: "connectors/index", params: { connected: "x" } })).toBeNull();
    expect(hrefOfRoute(null)).toBeNull();
  });
});

describe("the pieces every split shares", () => {
  test("the detail draws afresh per item inside its own boundary, a quiet line when nothing is open", () => {
    const panes = src("features/shared/SplitPanes.tsx");
    expect(panes).toContain("export class PaneBoundary extends Component<");
    expect(panes).toContain("return this.state.error ? <ScreenError error={this.state.error} retry={this.retry} />");
    expect(panes).toContain(
      "{detailKey !== null ? <PaneBoundary key={detailKey}>{detail}</PaneBoundary> : <NothingOpen text={empty} />}",
    );
  });

  test("a pushed screen's split hides its bar, has the way back in its list's bar and offers its first page", () => {
    const panes = src("features/shared/SplitPanes.tsx");
    expect(panes).toContain("<Stack.Screen options={wide ? SPLIT_OPTIONS : PAGE_OPTIONS} />");
    expect(panes).toContain("const SPLIT_OPTIONS = { headerShown: false };");
    expect(panes).toContain("const PAGE_OPTIONS = { headerShown: true };");
    expect(panes).toContain("<PageHandoff wide={wide} store={store} pages={pages} />");
    expect(panes).toContain("{wide ? <PageSplit store={store} pages={pages} list={list} testID={testID} /> : list}");
    expect(panes).toContain('({ label: t("mobile.common.back"), onPress: () => goBack() })');
    expect(panes).toContain("<PaneBackContext.Provider value={back}>");
    // The way back is drawn by the pane's bar of the list, never of the page beside it.
    const parts = src("features/shared/parts.tsx");
    expect(parts).toContain("const back = usePaneBack();");
    expect(parts).toContain('[{ icon: "back", sf: "chevron.left", label: back.label, onPress: back.onPress }]');
    // Opening: back to this screen, the page beside the list; closing: the chosen page pushed in place.
    expect(panes).toMatch(/store\.choose\(orgId, href, true\);\s*router\.back\(\);/);
    expect(panes).toContain("push: (href) => router.push(stillHref(href) as never),");
    expect(panes).toContain(
      "const above = hrefOfRoute(routeAbove(navigation.getState() as StackState | undefined, route.key));",
    );
  });

  test("a page done in a pane is drawn afresh in place, and a form with changes asks before another row replaces it", () => {
    const panes = src("features/shared/SplitPanes.tsx");
    expect(panes).toContain("return useCallback(() => (split ? split.leave() : goBack()), [split]);");
    expect(panes).toContain("if (now !== null) store.choose(orgId, now, true);");
    expect(panes).toContain("if (ask && store.shown(orgId) !== href) ask(go);");
    const parts = src("features/settings/parts.tsx");
    expect(parts).toContain("useSplitGuard(dirty ? (go) => (leaving.current ? go() : ask(go)) : null);");
    expect(src("features/me/AccountPage.tsx")).toContain("const leavePage = useLeavePage();");
    const status = src("features/status/StatusScreen.tsx");
    expect(status).toContain("const leavePage = useLeavePage();");
    expect(status).not.toContain("router.back()");
  });

  test("a split's row lights its page and drops its chevron: it opens beside the list, not over it", () => {
    const grouped = src("ui/Grouped.tsx");
    expect(grouped).toContain("const chevron = opensScreen && selected === undefined;");
    expect(grouped).toContain("selected ? { backgroundColor: withAlpha(c.ink, SELECTED_TINT) } : null,");
    expect(grouped).toContain(
      "...(checked !== undefined ? { selected: checked } : selected !== undefined ? { selected } : {}),",
    );
    expect(grouped).toContain("const SELECTED_TINT = 0.08;");
  });

  test("a page opened in place drops the mark once it is up, so going back slides", () => {
    const layout = readFileSync(join(import.meta.dir, "../../app/(app)/(main)/_layout.tsx"), "utf8");
    expect(layout).toContain("<Stack screenOptions={screenOptions} screenListeners={stackListeners}>");
    expect(layout).toContain(
      "if (!e.data?.closing && isStill(route.params)) navigation.setParams({ [STILL_PARAM]: undefined });",
    );
    expect(layout).toContain("slideListeners.transitionEnd();");
    // Nothing slides into a pane: what moves on an agent's page starts at once there.
    expect(src("features/shared/hooks.ts")).toContain("const [ended, setEnded] = useState(inPane);");
  });
});
