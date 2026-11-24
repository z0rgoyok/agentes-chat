import { HeaderHeightContext } from "expo-router/react-navigation";
import {
  type ComponentRef,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type LayoutChangeEvent, Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { SafeAreaProvider, useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "./Button";
import { Glass } from "./Glass";
import type { HeaderAction } from "./headerActions";
import { IconButton, usePlateEdge } from "./IconButton";
import type { IconName } from "./icons.data";
import { HeaderSlot, type HeaderSlotStore, useHeaderSlot } from "./navigation";
import { PANE_BAR_HEIGHT, PANE_BAR_SIDE, PANE_BUTTON, PANE_CAPSULE_PAD, paneTitleRoom } from "./pane-bar";
import { Text } from "./Text";
import { useTheme } from "./theme";

/**
 * A screen drawn inside a pane of a two-pane layout (ADR 0212: the iPhone Duo's inner display) rather than as a
 * navigator's screen. The screen sets its bar as it always does (`PushedHeader`, `LargeTitleScreen`), and inside a
 * pane that bar is the pane's own, drawn by the pane at its top with our own views instead of the navigator's options;
 * what the screen reads of its place (the bar's height, its width, the safe area) is the pane's. Outside a pane
 * nothing changes.
 */

/** A word on the right of the bar that saves (`PushedHeader`'s `action`). */
interface PaneWord {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/** What a screen in a pane asks its bar to show, as it would set a navigation bar's options. */
export interface PaneHeaderSpec {
  /** Words (the bar's title) or a view of the screen's own (the conversation's pill, a title that fades in). */
  title?: ReactNode;
  /** A line under the title. */
  subtitle?: string | undefined;
  subtitleColor?: string | undefined;
  /** A view at the bar's start (the workspace's mark on a tab's root). No back button: the list is beside the pane. */
  left?: ReactNode;
  /** Buttons at the bar's start. */
  leftActions?: HeaderAction[] | undefined;
  /** A view at the bar's end, in place of `actions`. */
  right?: ReactNode;
  /** The screen's own view first among `actions`, in their capsule (a count beside a mark). */
  lead?: ReactNode;
  /**
   * Buttons at the bar's end, our icon buttons in one capsule on every platform (as Android's bar draws them): a
   * `menu` calls `onPress`, which lists the same choices in the app's sheet.
   */
  actions?: HeaderAction[] | undefined;
  /** A word at the bar's end that saves, our small primary button. */
  word?: PaneWord | undefined;
  /**
   * Clear, over the screen, which keeps its own room under it (`useHeaderHeight`): a bar over art or a conversation.
   * Otherwise the bar stands above the screen, in `tone`, and the screen lays out below it.
   */
  over?: boolean;
  /** The color of a bar that stands above the screen (the grouped gray of settings-like screens); the page's by default. */
  tone?: string | undefined;
}

/** A button of the bar, as the pane draws it: its press always reaches the screen's latest handler. */
export interface BarButton {
  key: string;
  icon: IconName;
  label: string;
  disabled: boolean;
  onPress: () => void;
}

/** The bar as the pane draws it: plain values, the screen's own views in slots (redrawn alone as they change). */
export interface PaneBarState {
  over: boolean;
  tone: string | null;
  text: string;
  subtitle: string | null;
  subtitleColor: string | null;
  title: HeaderSlotStore | null;
  left: HeaderSlotStore | null;
  right: HeaderSlotStore | null;
  lead: HeaderSlotStore | null;
  actions: BarButton[];
  leftActions: BarButton[];
  word: { label: string; disabled: boolean; onPress: () => void } | null;
}

/** The bar the screen in a pane set last; the pane draws it. */
export interface PaneBarStore {
  get(): PaneBarState | null;
  set(bar: PaneBarState): void;
  /** The screen leaving takes its bar away, never one a screen after it already set. */
  clear(bar: PaneBarState): void;
  subscribe(listener: () => void): () => void;
}

function createBarStore(): PaneBarStore {
  let bar: PaneBarState | null = null;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const l of listeners) l();
  };
  return {
    get: () => bar,
    set(next) {
      if (next === bar) return;
      bar = next;
      tell();
    },
    clear(was) {
      if (bar !== was) return;
      bar = null;
      tell();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The pane a screen is drawn in. */
export interface PaneValue {
  /** The pane's width: what a screen sizes by the window's width sizes by this inside it (`useContentWidth`). */
  width: number;
  /**
   * How far the pane's bottom edge stands above the window's: the keyboard rises from the window's edge, and on Android
   * the tabs' content ends above their bar. 0 where the pane reaches the window's bottom (iOS: the bar floats over it).
   */
  below: number;
  bar: PaneBarStore;
}

const PaneContext = createContext<PaneValue | null>(null);

/** The pane the screen is drawn in (ADR 0212), or null for a navigator's screen. */
export function usePane(): PaneValue | null {
  return useContext(PaneContext);
}

/** The width the screen lays out in: its pane's inside one, the window's elsewhere. */
export function useContentWidth(): number {
  const pane = usePane();
  const { width } = useWindowDimensions();
  return pane ? pane.width : width;
}

/**
 * A pane of a two-pane layout around a screen (ADR 0212): it draws the bar the screen sets (`usePaneHeader`), at the
 * top, clear over the screen or above it, and tells the screen its bar's height (`useHeaderHeight` reads it, as a
 * navigator's) and its width (`usePane`). The screen mounts once the pane knows its width, so nothing sized by it
 * starts at a guess. `ownInsets`: what the screen reads of the safe area is the pane's own (`SafeAreaProvider`), so a
 * composer at its foot keeps clear of the tab bar floating over it, which the window's insets know nothing of.
 */
export function Pane({
  children,
  ownInsets = false,
  testID,
}: {
  children: ReactNode;
  ownInsets?: boolean;
  testID?: string;
}) {
  const { top } = useSafeAreaInsets();
  const frame = useSafeAreaFrame();
  const ref = useRef<ComponentRef<typeof View>>(null);
  const [width, setWidth] = useState(0);
  const [below, setBelow] = useState(0);
  const [bar] = useState(createBarStore);
  const windowHeight = frame.height;
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      setWidth(Math.round(e.nativeEvent.layout.width));
      ref.current?.measureInWindow((_x, y, _width, height) =>
        setBelow(Math.max(0, Math.round(windowHeight - (y + height)))),
      );
    },
    [windowHeight],
  );
  const value = useMemo<PaneValue | null>(() => (width > 0 ? { width, below, bar } : null), [width, below, bar]);
  const barHeight = top + PANE_BAR_HEIGHT;
  return (
    <View ref={ref} style={styles.fill} onLayout={onLayout} testID={testID}>
      {value ? (
        <PaneContext.Provider value={value}>
          <HeaderHeightContext.Provider value={barHeight}>
            <PaneBarHost bar={bar} top={top} width={width} over={false} />
            <View style={styles.fill}>
              {ownInsets ? <SafeAreaProvider style={styles.fill}>{children}</SafeAreaProvider> : children}
            </View>
            <PaneBarHost bar={bar} top={top} width={width} over />
          </HeaderHeightContext.Provider>
        </PaneContext.Provider>
      ) : null}
    </View>
  );
}

/** The bar where it stands: above the screen (`over` false) or clear over it; nothing until the screen sets one. */
function PaneBarHost({ bar, top, width, over }: { bar: PaneBarStore; top: number; width: number; over: boolean }) {
  const state = useSyncExternalStore(bar.subscribe, bar.get, bar.get);
  if (!state || state.over !== over) return null;
  return <PaneBar state={state} top={top} width={width} />;
}

type Described = Pick<BarButton, "key" | "icon" | "label" | "disabled">;

/** Only what the bar shows of a button: its press goes through the latest handlers. */
const describe = (list: HeaderAction[] | undefined): Described[] =>
  (list ?? []).map(({ icon, label, disabled }) => ({
    key: `${icon}:${label}`,
    icon,
    label,
    disabled: disabled ?? false,
  }));

/**
 * Sets the bar of the pane the screen is in, as a navigator's screen sets its options; nothing outside a pane. The bar
 * changes only when what it shows does (a conversation redraws as agents write): the screen's views are kept in slots
 * (`useHeaderSlot`) and presses reach its latest handlers.
 */
export function usePaneHeader(spec: PaneHeaderSpec) {
  const bar = usePane()?.bar ?? null;
  const { title, left, right, lead } = spec;
  const titleView = title != null && typeof title !== "string" ? title : null;
  const titleSlot = useHeaderSlot(titleView);
  const leftSlot = useHeaderSlot(left ?? null);
  const rightSlot = useHeaderSlot(right ?? null);
  const leadSlot = useHeaderSlot(lead ?? null);
  const latest = useRef(spec);
  useLayoutEffect(() => {
    latest.current = spec;
  });
  const plain = JSON.stringify({
    over: spec.over ?? false,
    tone: spec.tone ?? null,
    text: typeof title === "string" ? title : "",
    subtitle: spec.subtitle || null,
    subtitleColor: spec.subtitleColor ?? null,
    views: [titleView !== null, left != null, right != null, lead != null],
    actions: describe(spec.actions),
    leftActions: describe(spec.leftActions),
    word: spec.word ? { label: spec.word.label, disabled: spec.word.disabled ?? false } : null,
  });
  const state = useMemo<PaneBarState>(() => {
    const p = JSON.parse(plain) as {
      over: boolean;
      tone: string | null;
      text: string;
      subtitle: string | null;
      subtitleColor: string | null;
      views: [boolean, boolean, boolean, boolean];
      actions: Described[];
      leftActions: Described[];
      word: { label: string; disabled: boolean } | null;
    };
    const [hasTitle, hasLeft, hasRight, hasLead] = p.views;
    return {
      over: p.over,
      tone: p.tone,
      text: p.text,
      subtitle: p.subtitle,
      subtitleColor: p.subtitleColor,
      title: hasTitle ? titleSlot : null,
      left: hasLeft ? leftSlot : null,
      right: hasRight ? rightSlot : null,
      lead: hasLead ? leadSlot : null,
      actions: p.actions.map((a, i) => ({ ...a, onPress: () => latest.current.actions?.[i]?.onPress() })),
      leftActions: p.leftActions.map((a, i) => ({ ...a, onPress: () => latest.current.leftActions?.[i]?.onPress() })),
      word: p.word ? { ...p.word, onPress: () => latest.current.word?.onPress() } : null,
    };
  }, [plain, titleSlot, leftSlot, rightSlot, leadSlot]);
  useLayoutEffect(() => {
    if (!bar) return;
    bar.set(state);
    return () => bar.clear(state);
  }, [bar, state]);
}

/**
 * The pane's bar: its title (words, or the screen's view) and line centred on the pane, our icon buttons in a capsule
 * at its end (glass on iOS, Android's opaque plate) and whatever the screen puts at its start; no back button. Its
 * empty parts let touches through to the screen under a clear bar.
 */
function PaneBar({ state, top, width }: { state: PaneBarState; top: number; width: number }) {
  const { colors } = useTheme();
  const [ends, setEnds] = useState({ start: 0, end: 0 });
  const measured = (side: "start" | "end") => (e: LayoutChangeEvent) => {
    const w = Math.ceil(e.nativeEvent.layout.width);
    setEnds((was) => (was[side] === w ? was : { ...was, [side]: w }));
  };
  const hasStart = state.left !== null || state.leftActions.length > 0;
  const hasEnd = state.right !== null || state.lead !== null || state.actions.length > 0 || state.word !== null;
  // Centred on the pane: the title keeps clear of the wider end on both sides.
  const room = paneTitleRoom(width, Math.max(hasStart ? ends.start : 0, hasEnd ? ends.end : 0));
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.bar,
        { height: top + PANE_BAR_HEIGHT, paddingTop: top },
        state.over ? styles.over : { backgroundColor: state.tone ?? colors.bg },
      ]}
    >
      <View pointerEvents="box-none" style={styles.row}>
        <View pointerEvents="box-none" style={styles.middle}>
          <View style={[styles.title, { maxWidth: room }]}>
            {state.title ? (
              <HeaderSlot slot={state.title} />
            ) : state.text ? (
              <Text variant="body" numberOfLines={1} accessibilityRole="header" style={styles.titleText}>
                {state.text}
              </Text>
            ) : null}
            {state.subtitle ? (
              <Text variant="caption" numberOfLines={1} style={{ color: state.subtitleColor ?? colors.muted }}>
                {state.subtitle}
              </Text>
            ) : null}
          </View>
        </View>
        {hasStart ? (
          <View style={[styles.end, styles.start]} onLayout={measured("start")}>
            {state.left ? <HeaderSlot slot={state.left} /> : null}
            {state.leftActions.length > 0 ? <PaneButtons buttons={state.leftActions} /> : null}
          </View>
        ) : null}
        {hasEnd ? (
          <View style={[styles.end, styles.finish]} onLayout={measured("end")}>
            {state.right ? (
              <PaneCapsule>
                <HeaderSlot slot={state.right} />
              </PaneCapsule>
            ) : state.lead || state.actions.length > 0 ? (
              <PaneButtons buttons={state.actions} lead={state.lead} />
            ) : null}
            {state.word ? (
              <Button
                size="sm"
                variant="primary"
                label={state.word.label}
                disabled={state.word.disabled}
                onPress={state.word.onPress}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The bar's buttons in one capsule, the screen's own view first (`lead`). */
function PaneButtons({ buttons, lead = null }: { buttons: BarButton[]; lead?: HeaderSlotStore | null }) {
  return (
    <PaneCapsule>
      {lead ? <HeaderSlot slot={lead} /> : null}
      {buttons.map((b) => (
        <IconButton key={b.key} icon={b.icon} label={b.label} disabled={b.disabled} onPress={b.onPress} />
      ))}
    </PaneCapsule>
  );
}

/** One capsule around a bar's buttons, as the system groups them: glass on iOS, the opaque plate on Android. */
function PaneCapsule({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const edge = usePlateEdge();
  if (Platform.OS === "ios")
    return (
      <Glass liquid interactive={false} intensity={40} style={styles.capsule}>
        {children}
      </Glass>
    );
  return <View style={[styles.capsule, { backgroundColor: colors.glassSolid }, edge]}>{children}</View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { paddingHorizontal: PANE_BAR_SIDE },
  over: { position: "absolute", top: 0, left: 0, right: 0 },
  row: { flex: 1, flexDirection: "row", alignItems: "center" },
  middle: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { alignItems: "center", minWidth: 0 },
  titleText: { fontWeight: "600" },
  end: { flexDirection: "row", alignItems: "center", gap: 8 },
  start: { marginRight: "auto" },
  finish: { marginLeft: "auto" },
  capsule: {
    flexDirection: "row",
    alignItems: "center",
    padding: PANE_CAPSULE_PAD,
    borderRadius: PANE_BUTTON / 2 + PANE_CAPSULE_PAD,
  },
});
