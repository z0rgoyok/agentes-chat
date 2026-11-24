import { useHeaderHeight } from "expo-router/react-navigation";
import type { ReactElement, ReactNode } from "react";
import { Platform, type RefreshControlProps, ScrollView, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BAR_TITLE_FROM, BAR_TITLE_TO, type HeaderAction, LargeTitleHead, useLargeTitleScroll } from "@/ui";
import { FadingHeaderTitle } from "@/ui/cover";
import { useColors } from "./hooks";
import { FocusLive, type HeaderWordAction, PushedHeader } from "./parts";

type PushedLargeTitleProps = {
  title: string;
  right?: ReactNode;
  /** The bar's buttons as the system's own ("+", a "…" menu): `PushedHeader`'s `actions`, in place of `right`. */
  actions?: HeaderAction[];
  /** A word on the right of the bar (a selection's "Cancelar"): `PushedHeader`'s `action`. */
  action?: HeaderWordAction;
  refreshControl?: ReactElement<RefreshControlProps>;
  onScrollBeginDrag?: () => void;
  /** The content came to rest after a scroll (let go without a glide, or at the glide's end). */
  onScrollEnd?: () => void;
  /** Room under the content (a bottom bar over it needs more). */
  bottomInset?: number;
  /** The large title folded away (a search in progress). */
  collapsed?: boolean;
  /** The grouped gray background with white cards on it (Dashboards), as `LargeTitleScreen`'s. */
  grouped?: boolean;
  /** A field in the content or the dock: the content makes room for the keyboard and drags it away. */
  keyboard?: boolean;
  /** What stays at the screen's bottom over the content (a widget's "Ask for a change"), absolutely placed. */
  dock?: ReactNode;
  children?: ReactNode;
};

/**
 * A pushed screen with a large title (Issues, Drive). On iOS it is the system's own: the large title in the bar
 * folds into it as the list scrolls and the bar takes the system's material (iOS 26's glass and its scroll edge, a
 * blur before) over what passes under it, so the title and the buttons always read; the scroll view is the
 * screen's first child, as the system needs to follow it. Android has no large title in its bar: the title is drawn
 * at the top of the content and the bar's own title fades in as it scrolls away (`DrawnLargeTitle`).
 * `collapsed` folds the large title away (a search field under it took the focus, as the system's search bar does).
 */
export function PushedLargeTitle(props: PushedLargeTitleProps) {
  return Platform.OS === "ios" ? <SystemLargeTitle {...props} /> : <DrawnLargeTitle {...props} />;
}

function SystemLargeTitle({
  title,
  right,
  actions,
  action,
  refreshControl,
  onScrollBeginDrag,
  onScrollEnd,
  bottomInset = 24,
  collapsed = false,
  grouped = false,
  keyboard = false,
  dock,
  children,
}: PushedLargeTitleProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <>
      <PushedHeader
        title={title}
        right={right}
        {...(actions ? { actions } : {})}
        {...(action ? { action } : {})}
        solid={false}
        grouped={grouped}
        largeTitle={!collapsed}
      />
      <FocusLive>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          style={[styles.screen, { backgroundColor: grouped ? c.grouped : c.bg }]}
          onScrollBeginDrag={onScrollBeginDrag}
          onScrollEndDrag={onScrollEnd}
          onMomentumScrollEnd={onScrollEnd}
          refreshControl={refreshControl}
          keyboardDismissMode={keyboard ? "interactive" : "on-drag"}
          automaticallyAdjustKeyboardInsets={keyboard}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + bottomInset }}
        >
          {children}
        </ScrollView>
      </FocusLive>
      {dock}
    </>
  );
}

/** Android's: the large title at the top of the content, the bar's title fading in as it scrolls away. */
function DrawnLargeTitle({
  title,
  right,
  actions,
  action,
  refreshControl,
  onScrollBeginDrag,
  onScrollEnd,
  bottomInset = 24,
  collapsed = false,
  grouped = false,
  keyboard = false,
  dock,
  children,
}: PushedLargeTitleProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  // iOS insets the scroll view by the bar (automatic adjustment): at rest the offset is minus its height.
  const scroll = useLargeTitleScroll(Platform.OS === "ios" ? headerHeight : 0, { snap: !collapsed });
  return (
    <View style={[styles.screen, { backgroundColor: grouped ? c.grouped : c.bg }]}>
      <PushedHeader
        title={<FadingHeaderTitle y={scroll.y} from={BAR_TITLE_FROM} to={BAR_TITLE_TO} text={title} />}
        right={right}
        {...(actions ? { actions } : {})}
        {...(action ? { action } : {})}
        solid={false}
        grouped={grouped}
      />
      <FocusLive>
        <Animated.ScrollView
          ref={scroll.ref}
          onScroll={scroll.onScroll}
          onScrollBeginDrag={onScrollBeginDrag}
          onScrollEndDrag={(e) => {
            scroll.onScrollEndDrag(e);
            onScrollEnd?.();
          }}
          onMomentumScrollEnd={(e) => {
            scroll.onMomentumScrollEnd(e);
            onScrollEnd?.();
          }}
          scrollEventThrottle={16}
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={refreshControl}
          keyboardDismissMode={keyboard ? "interactive" : "on-drag"}
          automaticallyAdjustKeyboardInsets={keyboard}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + bottomInset }}
        >
          <LargeTitleHead y={scroll.y} title={title} collapsed={collapsed} />
          {children}
        </Animated.ScrollView>
      </FocusLive>
      {dock}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
