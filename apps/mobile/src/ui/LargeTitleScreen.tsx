import { type NativeStackNavigationOptions, Stack, useIsFocused } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { Platform, RefreshControl, type ScrollEvent, ScrollView, StyleSheet, View } from "react-native";
import Animated, { type AnimatedRef } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LivePause, useStillWhileScrolling } from "@/agent/live";
import { CoverBarBackdrop, CoverParallax, FadingHeaderTitle } from "./cover";
import { type HeaderAction, useHeaderActionOptions } from "./headerActions";
import { LargeTitleHead, useLargeTitleScroll } from "./LargeTitleHead";
import { useScrollUnderPushedOptions } from "./navigation";
import { PULL_TINT, PullOrbit } from "./PullOrbit";
import { usePane, usePaneHeader } from "./pane";
import { SCREEN_X } from "./rhythm";
import { Text } from "./Text";
import { useTheme } from "./theme";
import { BAR_TITLE_FROM, BAR_TITLE_TO } from "./title-snap";

/**
 * What the tab roots keep at their foot, over the tab bar (the work-along strip where the bar has no accessory): what
 * it draws, and the room their lists keep for it at their end, so no row moves under it.
 */
export const TabFoot = createContext<{ node: ReactNode; height: number } | null>(null);

/** A pull to refresh: whether it is reloading, and what a pull does (`usePullRefresh`). */
export interface PullRefresh {
  refreshing: boolean;
  onRefresh: () => void;
}

export interface LargeTitleScreenProps {
  title: string;
  /** A line under the large title (it scrolls with the content). */
  subtitle?: string;
  /** Buttons in the bar (native bar buttons on iOS). */
  actions?: HeaderAction[];
  /** The bar's leading item (the person's avatar, which opens Você). */
  left?: ReactNode;
  /** Native buttons on the bar's leading side (iOS). */
  leftActions?: HeaderAction[];
  /** Under the large title, scrolling with it (Conversas: the greeting and what changed). */
  below?: ReactNode;
  /**
   * The large title drawn in the content rather than the system's (iOS), for art standing behind the bar and the
   * title that scrolls along with them (`backdrop`: Conversas' sky). Android always draws it: its bar has none.
   */
  drawnTitle?: boolean;
  /** Art behind the clear bar, the large title and `below`, with `drawnTitle` (Conversas: the sky). */
  backdrop?: ReactNode;
  children?: ReactNode;
  /**
   * Pull to refresh. Under the system's large title, the system's wheel (as on the pushed screens); where the title is
   * drawn, the pixel orbit in the gap a pull-down opens, the wheel hidden on iOS (`PullOrbit`).
   */
  pull?: PullRefresh;
  /** Room under the content (default 24; the system already keeps content clear of the tab bar). */
  bottomInset?: number;
  /** The person starts scrolling the list (Conversas closes its open "Esperando você" card). */
  onScrollBeginDrag?: () => void;
  /**
   * Drawn fixed over the screen's foot, under the bar's band and the tab foot, never scrolling: what shows as the list
   * is pulled past its end (Conversas: the team peeking up from behind the tab bar), handed the list's scroll view to
   * read the pull from on the UI thread. With `drawnTitle`.
   */
  pastEnd?: (scroll: AnimatedRef<Animated.ScrollView>) => ReactNode;
  /**
   * The grouped gray background (settings-like screens) with white cards on it; the tabs, lists and chat
   * stay on the plain (white, in light) background.
   */
  grouped?: boolean;
  /**
   * The large title folded away and the bar's own title in its place (a search field under it took the focus, as
   * the system's search bar rises into the navigation); content that should slide up with it carries a
   * `LinearTransition` layout.
   */
  collapsed?: boolean;
}

/**
 * A tab's root screen (Agentes, Atividade, Threads, Buscar, Conversas). On iOS the large title is the system's, as on
 * the pushed screens (`PushedLargeTitle`): it folds into the bar as the list scrolls and the bar takes the system's
 * material over what passes under it, so the title and the buttons always read. Where art stands behind the bar
 * (`drawnTitle`), and on Android, the title is drawn in the content instead. Agents inside stop moving while the
 * screen is not showing.
 */
export function LargeTitleScreen(own: LargeTitleScreenProps) {
  // A pane has no navigation bar to hold the system's large title (ADR 0212): there it is always drawn.
  const props = usePane() ? { ...own, drawnTitle: true } : own;
  return IOS && !props.drawnTitle ? <SystemTitleScreen {...props} /> : <DrawnTitleScreen {...props} />;
}

/**
 * The list's drag and glide handlers that hold the faces still while it moves, as a conversation's do
 * (`useStillWhileScrolling`: their frames share the thread that places the rows): a drag or a glide holds them, its
 * end lets them go. Each also runs the screen's own handler for that event (`then`).
 */
function useStillList(then: {
  onScrollBeginDrag?: (() => void) | undefined;
  onScrollEndDrag?: ((e: ScrollEvent) => void) | undefined;
  onMomentumScrollEnd?: ((e: ScrollEvent) => void) | undefined;
}) {
  const { hold, settle } = useStillWhileScrolling();
  const { onScrollBeginDrag: began, onScrollEndDrag: dragEnded, onMomentumScrollEnd: glideEnded } = then;
  const onScrollBeginDrag = useCallback(() => {
    hold();
    began?.();
  }, [hold, began]);
  const onScrollEndDrag = useCallback(
    (e: ScrollEvent) => {
      settle();
      dragEnded?.(e);
    },
    [settle, dragEnded],
  );
  const onMomentumScrollEnd = useCallback(
    (e: ScrollEvent) => {
      settle();
      glideEnded?.(e);
    },
    [settle, glideEnded],
  );
  return { onScrollBeginDrag, onScrollEndDrag, onMomentumScrollBegin: hold, onMomentumScrollEnd };
}

/**
 * The system's large title over the tab's scroll view, set up as the pushed screens': the system's bar (the tab
 * stacks' clear one is for a drawn title, and under it the system's large title never folded while the list scrolled
 * inside the tabs) and the scroll view as the screen's first view, insets left to the system.
 */
function SystemTitleScreen({
  title,
  subtitle,
  actions,
  left,
  leftActions,
  below,
  children,
  pull,
  bottomInset = 24,
  onScrollBeginDrag,
  grouped = false,
  collapsed = false,
}: LargeTitleScreenProps) {
  const { colors } = useTheme();
  const focused = useIsFocused();
  const foot = useContext(TabFoot);
  const bar = useScrollUnderPushedOptions();
  const actionOptions = useHeaderActionOptions({ right: actions, left, leftActions });
  const still = useStillList({ onScrollBeginDrag });
  // Stable options: `setOptions` runs when the title or the actions change, not on every render.
  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      ...actionOptions,
      ...bar,
      title,
      headerTitle: title,
      // Folded away for a search, the bar's own title stands.
      headerLargeTitleEnabled: !collapsed,
      headerLargeTitleShadowVisible: false,
      headerLargeTitleStyle: { color: colors.ink },
    }),
    [actionOptions, bar, title, collapsed, colors.ink],
  );
  return (
    <>
      <Stack.Screen options={options} />
      <LivePause paused={!focused}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          style={[styles.screen, { backgroundColor: grouped ? colors.grouped : colors.bg }]}
          onScrollBeginDrag={still.onScrollBeginDrag}
          onScrollEndDrag={still.onScrollEndDrag}
          onMomentumScrollBegin={still.onMomentumScrollBegin}
          onMomentumScrollEnd={still.onMomentumScrollEnd}
          refreshControl={pull ? <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} /> : undefined}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: bottomInset + (foot?.height ?? 0) }}
        >
          {subtitle ? (
            <Text variant="small" tone="muted" style={styles.subtitle}>
              {subtitle}
            </Text>
          ) : null}
          {below}
          {children}
        </ScrollView>
      </LivePause>
      {foot?.node}
    </>
  );
}

/**
 * The large title in Funnel Display drawn as part of the content: it scrolls away with it, the bar's own title fades
 * in as it goes (like Mail's) and a scroll never rests with the title half gone (`useLargeTitleScroll`). The bar is
 * clear over the large title and turns into the system glass (iOS 26 scroll edge; a blur before; on Android a fade
 * into the screen's color under the floating buttons) once content passes under it.
 */
function DrawnTitleScreen({
  title,
  subtitle,
  actions,
  left,
  leftActions,
  below,
  backdrop,
  children,
  pull,
  bottomInset = 24,
  onScrollBeginDrag,
  grouped = false,
  collapsed = false,
  pastEnd,
}: LargeTitleScreenProps) {
  const { colors } = useTheme();
  const focused = useIsFocused();
  const headerHeight = useHeaderHeight();
  const safe = useSafeAreaInsets();
  const foot = useContext(TabFoot);
  const footRoom = foot?.height ?? 0;
  // On iOS the scroll view is inset by the clear bar ourselves (contentInset, resting at minus the header
  // height): the automatic adjustment didn't apply under the tab stacks' clear bar inside the system tabs, so the
  // list rested under the bar with the large title hidden, shown only while pulled. Android lays it out from the top,
  // under the bar. Folded away for a search, there is no title to settle.
  const titled = useLargeTitleScroll(IOS ? headerHeight : 0, { snap: !collapsed });
  // The title's settling once the list stops, and the faces held still while it moves.
  const still = useStillList({
    onScrollBeginDrag,
    onScrollEndDrag: titled.onScrollEndDrag,
    onMomentumScrollEnd: titled.onMomentumScrollEnd,
  });
  const scroll = { ...titled, ...still };
  const { y } = scroll;
  const actionOptions = useHeaderActionOptions({ right: actions, left, leftActions });
  // Stable options: `setOptions` runs when the title or the actions change, not on every render.
  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      ...actionOptions,
      title,
      // Folded, the bar's plain title stands (no fade to drive; set, not left out, as options merge); else it fades
      // in as the large one leaves.
      headerTitle: collapsed
        ? title
        : () => <FadingHeaderTitle y={y} from={BAR_TITLE_FROM} to={BAR_TITLE_TO} text={title} />,
    }),
    [actionOptions, title, y, collapsed],
  );
  // In a pane (ADR 0212) the same bar is the pane's own, clear over the art: the title that fades in, the mark at its
  // start, the buttons at its end. Outside one this sets nothing.
  const pane = usePane();
  const paneTitle = useMemo(
    () => (collapsed ? title : <FadingHeaderTitle y={y} from={BAR_TITLE_FROM} to={BAR_TITLE_TO} text={title} />),
    [collapsed, title, y],
  );
  usePaneHeader({ title: paneTitle, left, leftActions, actions, over: true });
  return (
    <View style={[styles.screen, { backgroundColor: grouped ? colors.grouped : colors.bg }]}>
      {pane ? null : <Stack.Screen options={options} />}
      <LivePause paused={!focused}>
        <Animated.ScrollView
          ref={scroll.ref}
          onScroll={scroll.onScroll}
          onScrollBeginDrag={scroll.onScrollBeginDrag}
          onScrollEndDrag={scroll.onScrollEndDrag}
          onMomentumScrollBegin={scroll.onMomentumScrollBegin}
          onMomentumScrollEnd={scroll.onMomentumScrollEnd}
          scrollEventThrottle={16}
          // The pixel orbit stands in for the wheel, hidden on iOS (Android keeps its own over the content).
          refreshControl={
            pull ? (
              <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={PULL_TINT} />
            ) : undefined
          }
          contentInsetAdjustmentBehavior="never"
          {...(IOS
            ? {
                contentInset: { top: headerHeight, bottom: safe.bottom + TAB_BAR + footRoom },
                scrollIndicatorInsets: { top: headerHeight, bottom: safe.bottom + TAB_BAR + footRoom },
                contentOffset: { x: 0, y: -headerHeight },
              }
            : {})}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingTop: IOS ? 0 : headerHeight,
            paddingBottom: bottomInset + (IOS ? 0 : footRoom),
          }}
        >
          {/* The art reaches up behind the clear bar and the status bar on both platforms (no band above it). */}
          <View style={backdrop ? { marginTop: -headerHeight, paddingTop: headerHeight } : undefined}>
            {/* As the agent's cover: it lags behind the list, and stretches into the gap a pull-down opens. */}
            {backdrop ? (
              <CoverParallax y={y} style={StyleSheet.absoluteFill}>
                {backdrop}
              </CoverParallax>
            ) : null}
            <LargeTitleHead y={y} title={title} subtitle={subtitle} collapsed={collapsed} tight={Boolean(below)} />
            {below}
          </View>
          {children}
          {pull ? (
            // On iOS the content starts under the bar's inset: the gap opens above that.
            <View pointerEvents="none" style={[styles.pullMark, { top: -PULL_MARK - (IOS ? headerHeight : 0) }]}>
              <PullOrbit refreshing={pull.refreshing} />
            </View>
          ) : null}
        </Animated.ScrollView>
      </LivePause>
      {pastEnd?.(scroll.ref)}
      <CoverBarBackdrop y={y} from={0} to={12} height={headerHeight} tone={grouped ? colors.grouped : colors.bg} />
      {foot?.node}
    </View>
  );
}

const IOS = Platform.OS === "ios";
/** Room for the system tab bar over the list's end (iOS; the floating bar and its margin), so the last row clears it. */
const TAB_BAR = 76;

/** The pull-down's gap, where the orbit sits (the system's wheel takes about as much). */
const PULL_MARK = 56;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // Under the system's large title, at the screen's sides as the lists and cards under it.
  subtitle: { paddingHorizontal: SCREEN_X, paddingBottom: 10 },
  // Above the content's top edge: only a pull-down brings it into view (the system's wheel sits there too).
  pullMark: {
    position: "absolute",
    left: 0,
    right: 0,
    height: PULL_MARK,
    alignItems: "center",
    justifyContent: "center",
  },
});
