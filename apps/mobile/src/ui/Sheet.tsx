import { type SheetDetent, TrueSheet } from "@lodev09/react-native-true-sheet";
import { useNavigation } from "expo-router";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, ScrollView, type ScrollViewInstance, StyleSheet, View, type ViewStyle } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { hintBack } from "./hints";
import { sheetColors } from "./palette";
import { SHEET_GAP, SHEET_X } from "./rhythm";
import { ThemeColorsOverride, useTheme } from "./theme";

/** A sheet's own height: its content's, up to the screen's. */
const AUTO: SheetDetent[] = ["auto"];

export interface SheetProps {
  open: boolean;
  /** The person closed it (a flick down, the scrim, Android's back): the owner sets `open` to false. */
  onClose: () => void;
  children?: ReactNode;
  /**
   * Once the sheet is gone from the screen. Something the system presents (the photo library, the camera) must wait
   * for it: presented over a sheet still leaving, iOS dismisses it with the sheet, and its answer never comes.
   */
  onGone?: () => void;
  /**
   * Pinned over the content while it scrolls (a picker's bar and its search). It brings its own room under the
   * grabber (`SheetBar` does).
   */
  header?: ReactNode;
  /**
   * The heights it may rest at: fractions of the screen, or `"auto"` (the default) for its content's height. A sheet
   * whose content changes as the person works in it (a list filtered by what they type) takes fixed ones, so it
   * doesn't jump at every keystroke or collapse when nothing matches; its content then fills them.
   */
  detents?: SheetDetent[];
}

/**
 * The bottom sheet (no dialogs on the phone): the system's own, through TrueSheet (iOS's sheet presentation, Android's
 * Material bottom sheet), on the sheet's solid gray. The system draws it, its grabber and corners, dims the screen,
 * drags it, and lifts it over the keyboard; by default it takes its content's height, up to the screen's. A sheet
 * presented while another is up stacks over it, as the system's sheets do. Its content is on the sheet's colors
 * (`sheetColors`) and scrolls.
 */
export function Sheet({ open, onClose, children, onGone, header, detents }: SheetProps) {
  const ref = useRef<TrueSheet>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  // Under a header the content starts right away; alone, it leaves the grabber its room.
  const body = useSheetBody(header ? 8 : 24);
  const props = useSheetProps({ open, onClose, onGone, ref, ...(detents ? { detents } : {}) });
  const fill = !props.detents.includes("auto");
  return (
    <TrueSheet
      ref={ref}
      {...props}
      scrollableRef={scroll}
      {...(fill ? { style: styles.fill } : {})}
      {...(header
        ? {
            header: (
              <View>
                <OnSheet>{header}</OnSheet>
              </View>
            ),
          }
        : {})}
    >
      <SheetContent fill={fill}>
        <ScrollView
          ref={scroll}
          style={fill ? styles.fill : undefined}
          keyboardShouldPersistTaps="handled"
          // A sheet with a field (an answer, a fix): a drag down its content puts the keyboard away.
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={body}
        >
          {children}
        </ScrollView>
      </SheetContent>
    </TrueSheet>
  );
}

/**
 * The look every sheet of the app shares, the ones a screen opens and the ones that are routes: the system's grabber
 * (named for screen readers) and corners, on the sheet's own solid gray (`sheetColors`), never see-through: iOS 26
 * would draw Liquid Glass without a color, and a pinned bar on the sheet's gray read as a band over the glass.
 */
function useSheetLook() {
  const { colors, scheme } = useTheme();
  const { t } = useTranslation();
  const inside = useMemo(() => sheetColors(colors, scheme), [colors, scheme]);
  return useMemo(
    () => ({
      grabber: true,
      backgroundColor: inside.grouped,
      accessibilityOptions: { grabberLabel: t("mobile.a11y.grabber") },
    }),
    [inside, t],
  );
}

/**
 * The options of a sheet that is a route (`Sheet.Screen` in `app/(app)/_layout.tsx`), on `Sheet`'s look. `detents`:
 * the fractions of the screen it may rest at, or `"auto"` for its content's height; one with fixed heights fills them.
 * Its content tells the sheet which view scrolls (`useRouteSheetScrollable`).
 */
export function useRouteSheetOptions() {
  const look = useSheetLook();
  return useCallback(
    (detents: SheetDetent[]) => ({
      ...look,
      detents,
      ...(detents.includes("auto") ? {} : { style: styles.fill }),
    }),
    [look],
  );
}

/**
 * A route sheet's content: its scroll view is the sheet's own (dragging at its top moves the sheet, the keyboard
 * insets it).
 */
export function useRouteSheetScrollable(ref: RefObject<ScrollViewInstance | null>) {
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ scrollableRef: ref } as never);
  }, [navigation, ref]);
}

/**
 * What every sheet a screen opens shares, for `<TrueSheet>`: content-sized unless `detents` says otherwise, `Sheet`'s
 * look, Android's back (an open ⓘ goes with the sheet), and `open` driving present and dismiss with `onClose` when the
 * person closes it and `onGone` once it is off the screen.
 */
export function useSheetProps({
  open,
  onClose,
  onGone,
  ref,
  presentOnMount = false,
  detents = AUTO,
}: {
  open: boolean;
  onClose: () => void;
  onGone?: (() => void) | undefined;
  ref: RefObject<TrueSheet | null>;
  /**
   * Present as it mounts, rather than when `open` turns true: the system then waits out a sheet still leaving (or its
   * recycled view) before presenting, where a `present()` call made meanwhile does nothing.
   */
  presentOnMount?: boolean;
  /** The heights it may rest at (`Sheet`'s `detents`); its content's height by default. */
  detents?: SheetDetent[];
}) {
  const look = useSheetLook();
  const shown = useRef(presentOnMount);
  const openRef = useRef(open);
  openRef.current = open;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const goneRef = useRef(onGone);
  goneRef.current = onGone;

  useEffect(() => {
    // A sheet that presents as it mounts starts shown: `open` turning false still takes it away.
    if (open) {
      if (shown.current) return;
      shown.current = true;
      // The screen's own field (the composer) lets go of the keyboard first. Kept, iOS gave the keyboard back when
      // the sheet closed and the composer stayed under it.
      Keyboard.dismiss();
      // A present that fails (no window to present from) ends as a dismissal would: left "shown", the owner would
      // keep a sheet open that nobody sees.
      void ref.current?.present().catch(() => {
        shown.current = false;
        if (openRef.current) closeRef.current();
        goneRef.current?.();
      });
    } else if (shown.current) {
      void ref.current?.dismiss();
    }
  }, [open, ref]);

  return {
    ...look,
    detents,
    ...(presentOnMount ? { initialDetentIndex: 0 } : {}),
    // A present on mount can't be called off before it lands (the system answers "already dismissed" and presents
    // anyway): one that lands after the owner closed it goes away again.
    onDidPresent: () => {
      if (!openRef.current) void ref.current?.dismiss();
    },
    onDidDismiss: () => {
      shown.current = false;
      // Closed by the person: its owner hears it. Closed by its owner: nothing to tell.
      if (openRef.current) closeRef.current();
      goneRef.current?.();
    },
    // Android's back takes the sheet away, and an ⓘ open in it with it.
    onBackPress: () => {
      hintBack();
    },
  };
}

/**
 * A sheet's content: gestures need their own root in the sheet's window, and it reads the sheet's colors. `fill` for a
 * sheet of fixed heights, whose content fills them; otherwise it is as tall as what it holds. The root always gets a
 * style: left without one, it takes `flex: 1`, which in a sheet sized to its content is no height at all, and the
 * sheet came up empty.
 */
export function SheetContent({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
  return (
    <GestureHandlerRootView style={fill ? styles.fill : styles.fit}>
      <OnSheet>{children}</OnSheet>
    </GestureHandlerRootView>
  );
}

/** What sits on the sheet reads the sheet's colors: its content, and the header pinned over it outside the content. */
function OnSheet({ children }: { children: ReactNode }) {
  const { colors, scheme } = useTheme();
  const inside = useMemo(() => sheetColors(colors, scheme), [colors, scheme]);
  return <ThemeColorsOverride colors={inside}>{children}</ThemeColorsOverride>;
}

/**
 * The body of every sheet's content (a screen's sheets, their steps, the sheets that are routes): `SHEET_X` at the
 * sides, `top` (room for the grabber), 24 over the bottom edge, and `SHEET_GAP` between its blocks. The home indicator's
 * room is TrueSheet's own (`insetAdjustment` and `contentInsetAdjustment`, both automatic): added here as well, every
 * sheet ended on an empty band twice that tall.
 */
export function useSheetBody(top = 24): ViewStyle {
  return {
    paddingHorizontal: SHEET_X,
    paddingTop: top,
    paddingBottom: 24,
    gap: SHEET_GAP,
  };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  fit: { alignSelf: "stretch" },
});
