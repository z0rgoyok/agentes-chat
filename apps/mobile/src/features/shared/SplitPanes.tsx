import { type ErrorBoundaryProps, Stack, useIsFocused, useNavigation, useRoute } from "expo-router";
import {
  Component,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Text, TwoPane, useWide } from "@/ui";
import { goBack, router } from "@/ui/navigation";
import { Pane } from "@/ui/pane";
import { type PaneBack, PaneBackContext } from "@/ui/pane-back";
import { stillHref } from "../links/landing";
import { useOrgId } from "./hooks";
import { ScreenError } from "./ScreenError";
import { hrefOfRoute, routeAbove, type SplitStore, type StackState, selectedTabOf, splitHandoff } from "./split-store";

/**
 * The pieces every list-and-detail split shares on a regular-width window (ADR 0212: the iPhone Duo's inner display, a
 * large screen): the two panes with the detail drawn afresh per item inside its own error boundary, what the window
 * changing size class does with the open item, and, for a pushed screen that lists pages (You, the workspace's
 * settings), the whole split: its list's way back, its rows opening pages beside it, and what those pages may ask of it.
 */

/**
 * The list and the open item side by side: the list's pane, then the detail's, which draws `detail` afresh under each
 * `detailKey` (another item, a new visit) inside its own error boundary, or `empty` as a quiet line when nothing is
 * open. `ownInsets`: the detail's safe area is its own (a tab's split: the tab bar floats over its foot).
 */
export function SplitPanes({
  testID,
  list,
  detail,
  detailKey,
  ownInsets = false,
  empty = null,
}: {
  testID: string;
  list: ReactNode;
  detail: ReactNode;
  detailKey: string | null;
  ownInsets?: boolean;
  empty?: string | null;
}) {
  return (
    <TwoPane
      testID={testID}
      list={<Pane testID={`${testID}-list`}>{list}</Pane>}
      detail={
        <Pane ownInsets={ownInsets} testID={`${testID}-detail`}>
          {detailKey !== null ? <PaneBoundary key={detailKey}>{detail}</PaneBoundary> : <NothingOpen text={empty} />}
        </Pane>
      }
    />
  );
}

/** Nothing open beside the list yet (nothing to open): a quiet line where it would be. */
function NothingOpen({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <View style={styles.empty}>
      <Text variant="small" tone="faint" style={styles.emptyText}>
        {text}
      </Text>
    </View>
  );
}

/**
 * What breaks while drawing in a detail pane says what happened there, the list beside it still there; "Try again"
 * draws it again. Another item opened draws a fresh one (the boundary is keyed by it).
 */
export class PaneBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  private retry: ErrorBoundaryProps["retry"] = async () => this.setState({ error: null });

  override render() {
    return this.state.error ? <ScreenError error={this.state.error} retry={this.retry} /> : this.props.children;
  }
}

/**
 * Opening and closing the device mid-task keeps the person where they were (ADR 0212): the window changing size class
 * moves what is open between the split's detail pane and a page pushed over the split's screen (`splitHandoff`).
 * `read` is asked as the size class changes, with what the screen knows then; `push` and `take` do the moving.
 */
export function useSplitHandoff<T>(
  wide: boolean,
  read: () => { splitShown: boolean; chosen: T | null; pushed: T | null },
  move: { push: (item: T) => void; take: (item: T) => void },
) {
  const latest = useRef({ read, move });
  useLayoutEffect(() => {
    latest.current = { read, move };
  });
  const was = useRef(wide);
  useEffect(() => {
    const before = was.current;
    was.current = wide;
    const step = splitHandoff(before, wide, latest.current.read());
    if (!step) return;
    if (step.kind === "push") latest.current.move.push(step.item);
    else latest.current.move.take(step.item);
  }, [wide]);
}

/**
 * Which tab is selected under whatever is pushed over the tabs, read off the tabs' navigator when asked (each tab's
 * root sits in a stack of its own inside it), so a page pushed from a tab goes back to that tab's split. Null where it
 * can't be told. For a tab's root screen.
 */
export function useSelectedTab(): () => string | null {
  const navigation = useNavigation();
  return useCallback(() => {
    const tabs = navigation.getParent() as
      | { getState(): { index?: number; routes?: readonly { name: string }[] } | undefined }
      | undefined;
    return selectedTabOf(tabs?.getState());
  }, [navigation]);
}

/** What a page may ask, before it is replaced, when it holds changes not saved yet: `go` replaces it. */
export type SplitAsk = (go: () => void) => void;

/** What a page in a split's detail pane may ask of its split (ADR 0212). */
interface SplitDetail {
  /** The page is done (a form saved): nothing is under it to go back to (the list stands beside it). */
  leave: () => void;
  /** The page's question before another row replaces it, while it holds changes not saved (`useSplitGuard`). */
  guard: { current: SplitAsk | null };
}

const SplitDetailContext = createContext<SplitDetail | null>(null);

/**
 * How a page leaves itself once it is done (a form saved, "OK"): back to where it was opened from; in a split's detail
 * pane, where nothing is under it, it is drawn afresh in place instead, showing what was saved.
 */
export function useLeavePage(): () => void {
  const split = useContext(SplitDetailContext);
  return useCallback(() => (split ? split.leave() : goBack()), [split]);
}

/**
 * In a split's detail pane, `ask` comes before another row of the list replaces the page (a form's changes not saved);
 * null: nothing to ask. Nothing outside a split.
 */
export function useSplitGuard(ask: SplitAsk | null) {
  const split = useContext(SplitDetailContext);
  useLayoutEffect(() => {
    if (!split || !ask) return;
    split.guard.current = ask;
    return () => {
      if (split.guard.current === ask) split.guard.current = null;
    };
  }, [split, ask]);
}

/** How a split's list opens a page beside it (You, the workspace's settings). */
interface PageOpener {
  /** Whether `href` is one of the split's pages. */
  has: (href: string) => boolean;
  /** Opens one of the split's pages beside the list; false for any other address (the caller pushes it). */
  open: (href: string) => boolean;
  /** The page beside the list. */
  shown: string | null;
}

const PageOpenerContext = createContext<PageOpener | null>(null);

/** Opens `href`: beside the list in a split when it is one of its pages, else pushed with the platform's push. */
export function useOpenPage(): (href: string) => void {
  const opener = useContext(PageOpenerContext);
  return useCallback(
    (href: string) => {
      if (!opener?.open(href)) router.push(href as never);
    },
    [opener],
  );
}

/**
 * A row's props for the page at `href`: in a split's list, `GroupedRow`'s `selected` (lit while that page shows beside
 * it, no chevron); nothing anywhere else, nor for an address that isn't one of the split's pages.
 */
export function useLitPage(): (href: string) => { selected?: boolean } {
  const opener = useContext(PageOpenerContext);
  return useCallback((href: string) => (opener?.has(href) ? { selected: opener.shown === href } : {}), [opener]);
}

/** Each page of a split by its address, drawn as its route draws it. */
export type SplitPages = Readonly<Record<string, () => ReactNode>>;

/** Said either way: a screen's options merge, so the bar the split hid stays hidden until it is shown again. */
const SPLIT_OPTIONS = { headerShown: false };
const PAGE_OPTIONS = { headerShown: true };

/**
 * A pushed screen that lists pages (You, the workspace's settings), on a regular-width window (ADR 0212): the list in
 * the left pane with the way back in its bar (the screen's own bar is hidden: it would stand over both panes), and the
 * page chosen in it on the right, its bar the pane's; with none chosen, `fallback` shows there, which closing the
 * device leaves behind. Its rows open their pages beside it (`useOpenPage`) and the open one stays lit
 * (`useLitPage`); any other address is pushed as always. A compact window shows the list alone, as before. The choice
 * is kept per workspace (`store`), and opening or closing the device moves it between the pane and a pushed page.
 */
export function PageSplitScreen({
  store,
  pages,
  fallback,
  list,
  testID,
}: {
  store: SplitStore<string>;
  pages: SplitPages;
  fallback: string | null;
  list: ReactNode;
  testID: string;
}) {
  const wide = useWide();
  const orgId = useOrgId();
  // Before the first frame is shown, so the pane never flashes empty first.
  useLayoutEffect(
    () => store.offer(orgId, fallback !== null && pages[fallback] !== undefined ? fallback : null),
    [store, orgId, fallback, pages],
  );
  return (
    <>
      <Stack.Screen options={wide ? SPLIT_OPTIONS : PAGE_OPTIONS} />
      <PageHandoff wide={wide} store={store} pages={pages} />
      {wide ? <PageSplit store={store} pages={pages} list={list} testID={testID} /> : list}
    </>
  );
}

/** The two panes of `PageSplitScreen`. */
function PageSplit({
  store,
  pages,
  list,
  testID,
}: {
  store: SplitStore<string>;
  pages: SplitPages;
  list: ReactNode;
  testID: string;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const key = store.useShownKey(orgId);
  const shown = store.useShown(orgId);
  const guard = useRef<SplitAsk | null>(null);
  const opener = useMemo<PageOpener>(
    () => ({
      has: (href) => pages[href] !== undefined,
      open(href) {
        if (pages[href] === undefined) return false;
        const go = () => store.choose(orgId, href);
        const ask = guard.current;
        // The page already beside the list stays where it is (chosen now, its pane kept): nothing to ask.
        if (ask && store.shown(orgId) !== href) ask(go);
        else go();
        return true;
      },
      shown,
    }),
    [store, pages, orgId, shown],
  );
  const detail = useMemo<SplitDetail>(
    () => ({
      leave: () => {
        const now = store.shown(orgId);
        if (now !== null) store.choose(orgId, now, true);
      },
      guard,
    }),
    [store, orgId],
  );
  const back = useMemo<PaneBack>(() => ({ label: t("mobile.common.back"), onPress: () => goBack() }), [t]);
  const page = shown !== null ? pages[shown] : undefined;
  return (
    <SplitPanes
      testID={testID}
      list={
        <PaneBackContext.Provider value={back}>
          <PageOpenerContext.Provider value={opener}>{list}</PageOpenerContext.Provider>
        </PaneBackContext.Provider>
      }
      detailKey={page ? key : null}
      detail={page ? <SplitDetailContext.Provider value={detail}>{page()}</SplitDetailContext.Provider> : null}
    />
  );
}

/**
 * `PageSplitScreen`'s move between the sizes: closing the device with a page chosen beside the list pushes it in place
 * (no slide: it was on screen); opening it with one of the split's pages pushed right over this screen goes back here
 * with that page beside the list. Draws nothing; mounted in both sizes.
 */
function PageHandoff({ wide, store, pages }: { wide: boolean; store: SplitStore<string>; pages: SplitPages }) {
  const orgId = useOrgId();
  const focused = useIsFocused();
  const navigation = useNavigation();
  const route = useRoute();
  useSplitHandoff(
    wide,
    () => {
      const above = hrefOfRoute(routeAbove(navigation.getState() as StackState | undefined, route.key));
      return {
        splitShown: focused,
        chosen: store.chosen(orgId),
        pushed: above !== null && pages[above] !== undefined ? above : null,
      };
    },
    {
      push: (href) => router.push(stillHref(href) as never),
      take: (href) => {
        store.choose(orgId, href, true);
        router.back();
      },
    },
  );
  return null;
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { textAlign: "center" },
});
