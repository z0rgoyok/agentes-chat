import { requireNativeView, requireOptionalNativeModule } from "expo";
import { type ComponentType, createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { type LayoutChangeEvent, Platform, StyleSheet, useWindowDimensions, View, type ViewProps } from "react-native";
import {
  activeWindowFold,
  type FoldRoom,
  foldRoom,
  NO_FOLD,
  sameWindowFold,
  type WindowFold,
  windowFoldOf,
} from "./fold-room";
import { usePane } from "./pane";
import { useTheme } from "./theme";
import { activeFold, type DuoRegions, type Fold, foldInside, paneFrames, WIDE_MIN } from "./two-pane";

type RegionsEvent = { nativeEvent: DuoRegions };

interface RegionsViewProps extends ViewProps {
  onRegions?: (event: RegionsEvent) => void;
}

/**
 * modules/duo-layout's view (ADR 0212), transparent and untouchable: it reports the window's size class and where the
 * iPhone Duo's fold crosses it. Only on iOS, in a build that has the module; elsewhere nothing renders and the window's
 * width decides.
 */
const RegionsView: ComponentType<RegionsViewProps> | null =
  Platform.OS === "ios" && requireOptionalNativeModule("DuoLayout") !== null
    ? requireNativeView<RegionsViewProps>("DuoLayout")
    : null;

/** The window's size class as the native view reports it; null before it does, or where there is none. */
const WideContext = createContext<boolean | null>(null);

/**
 * Whether the window is regular width, where two panes show (ADR 0212): the iPhone Duo's inner display, a large screen.
 * The system's size class once `DuoProvider` has it; before that, and on Android, the window's width (`WIDE_MIN`).
 */
export function useWide(): boolean {
  const wide = useContext(WideContext);
  const { width } = useWindowDimensions();
  return wide ?? width >= WIDE_MIN;
}

/** The window's fold as the native view filling the root reports it; none where there is no module. */
const FoldContext = createContext<WindowFold>(NO_FOLD);

/**
 * The iPhone Duo's fold across the whole window, in its points (ADR 0212): where it is, whether it divides the window
 * now (`active`: the device folded like a book) and whether there is one at all (`hasFold`, active or not: for a
 * decision that should not change as the device bends). No fold on a phone, on Android, in a build without the module
 * and before it reports. Inside two panes the fold is theirs (`TwoPane`); a control floating over a whole screen reads
 * `useFoldRoom`.
 */
export function useWindowFold(): WindowFold {
  return useContext(FoldContext);
}

/** Whether the tree is inside a `TwoPane`, whose panes already keep to one side of the fold. */
const InTwoPaneContext = createContext(false);

/**
 * The side of the window a control floating over a whole screen keeps to while the fold divides it (ADR 0212):
 * `foldRoom` of the window's active fold, as insets from its edges. Null when nothing has to move: no active fold, or a
 * screen inside two panes (`Pane`, `TwoPane`), which already keep to one side of it.
 */
export function useFoldRoom(): FoldRoom | null {
  const windowFold = useWindowFold();
  const pane = usePane();
  const inTwoPane = useContext(InTwoPaneContext);
  const { width } = useWindowDimensions();
  const fold = pane || inTwoPane ? null : activeWindowFold(windowFold);
  return useMemo(() => foldRoom(width, fold), [width, fold]);
}

/**
 * Reads the window's size class (`useWide`) and its fold (`useWindowFold`) once for the whole app, through a hidden
 * native view filling the root: the fold comes in the window's points. Mounted once, in `AppProviders`.
 */
export function DuoProvider({ children }: { children: ReactNode }) {
  const [wide, setWide] = useState<boolean | null>(null);
  const [windowFold, setWindowFold] = useState<WindowFold>(NO_FOLD);
  const onRegions = useCallback((event: RegionsEvent) => {
    setWide(event.nativeEvent.wide);
    // A report that changed only the size class keeps the fold as it was: nothing that reads it redraws.
    const next = windowFoldOf(event.nativeEvent.fold);
    setWindowFold((was) => (sameWindowFold(was, next) ? was : next));
  }, []);
  return (
    <>
      {RegionsView ? <RegionsView pointerEvents="none" style={StyleSheet.absoluteFill} onRegions={onRegions} /> : null}
      <WideContext.Provider value={wide}>
        <FoldContext.Provider value={windowFold}>{children}</FoldContext.Provider>
      </WideContext.Provider>
    </>
  );
}

/** A report that changed only `wide` leaves the panes where they are. */
const sameFold = (a: Fold | null, b: Fold | null) =>
  a === b || (a !== null && b !== null && a.x === b.x && a.width === b.width);

/**
 * A list and its detail side by side, filling the parent (ADR 0212): the list pane, the hairline divider, the detail
 * pane, each clipping its content (`paneFrames`). When the iPhone Duo is folded like a book, the panes rebalance so the
 * fold falls between them and nothing sits in it; its own native view reads the fold in the row's points. Show it only
 * where `useWide()` is true: a compact window shows one pane at a time.
 */
export function TwoPane({ list, detail, testID }: { list: ReactNode; detail: ReactNode; testID?: string }) {
  const { colors } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const [measured, setMeasured] = useState<number | null>(null);
  const [fold, setFold] = useState<Fold | null>(null);
  // Until the row has measured itself, the window's width: the row fills its screen, so the first frame is close.
  const width = measured ?? windowWidth;
  const frames = paneFrames(width, fold);
  const onLayout = useCallback((event: LayoutChangeEvent) => setMeasured(event.nativeEvent.layout.width), []);
  const onRegions = useCallback((event: RegionsEvent) => {
    const next = activeFold(event.nativeEvent.fold);
    setFold((was) => (sameFold(was, next) ? was : next));
  }, []);
  const row = (
    <View testID={testID} style={styles.row} onLayout={onLayout}>
      {RegionsView ? <RegionsView pointerEvents="none" style={StyleSheet.absoluteFill} onRegions={onRegions} /> : null}
      <View style={[styles.pane, { width: frames.list.width }]}>{list}</View>
      <View
        style={[
          { width: frames.gap },
          foldInside(width, fold) ? null : [styles.divider, { borderLeftColor: colors.separator }],
        ]}
      />
      <View style={[styles.pane, styles.detail]}>{detail}</View>
    </View>
  );
  // What floats inside the panes stays where it is (`useFoldRoom`): they already keep to one side of the fold.
  return <InTwoPaneContext.Provider value>{row}</InTwoPaneContext.Provider>;
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row", overflow: "hidden" },
  pane: { overflow: "hidden" },
  // The rest of the row: `paneFrames`' detail width once the row is measured, and never past its edge before.
  detail: { flex: 1 },
  divider: { borderLeftWidth: StyleSheet.hairlineWidth },
});
