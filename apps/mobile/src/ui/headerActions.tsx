import type { NativeStackNavigationOptions } from "expo-router";
import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { ScrollToTopGuard } from "react-native-screens/experimental";
import { IconButton, usePlateEdge } from "./IconButton";
import type { IconName } from "./icons.data";
import type { SFSymbolName } from "./icons.sf";
import { HeaderSlot, useHeaderSlot } from "./navigation";
import { useTheme } from "./theme";

export type { SFSymbolName };

/** One choice in a bar button's menu (`HeaderAction.menu`). */
export interface HeaderMenuItem {
  label: string;
  /** Our line icon (Android's list of the same choices). */
  icon: IconName;
  /** The matching SF Symbol (iOS). */
  sf: SFSymbolName;
  onPress: () => void;
  destructive?: boolean;
}

/**
 * A button in a native header: the system bar button on iOS (glass on iOS 26), our icon button on Android. With
 * `menu`, iOS opens the system's menu from the button itself (above any screen, a modal one included); Android calls
 * `onPress`, where the screen lists the same choices in the app's sheet.
 */
export interface HeaderAction {
  /** Our line icon (Android). */
  icon: IconName;
  /** The matching SF Symbol (iOS). */
  sf: SFSymbolName;
  label: string;
  onPress: () => void;
  /** While what it starts is under way. */
  disabled?: boolean;
  menu?: HeaderMenuItem[];
}

const IOS = Platform.OS === "ios";

type Described = Omit<HeaderAction, "onPress" | "menu"> & { menu?: Omit<HeaderMenuItem, "onPress">[] };

/**
 * A system bar button's image (iOS): the system's own symbol, as every icon of the app on iOS (`Icon`), so a bar of
 * system buttons, a bar of our own views and a menu's rows show the same drawings.
 */
const barIcon = ({ sf }: { sf: SFSymbolName }) => ({ type: "sfSymbol" as const, name: sf });

/**
 * Header options for a screen's actions. On iOS the right actions are native `UIBarButtonItem`s
 * (`unstable_headerRightItems`): UIKit places, sizes and groups them in the bar, where a React view in
 * `headerRight` could be laid out in the wrong place on iOS 26. `lead` is a view of our own that has no system form (a
 * count beside a mark: an agent's tasks, a computer's line), first in the same group: a custom item that shares the
 * buttons' glass, so the bar is one capsule whether it shows or not. `left` is a custom element (the avatar on
 * Início), shown without the shared glass behind it. On Android both are React views in the bar, the right ones
 * (`lead` first) in a `HeaderCapsule` (the floating plate iOS 26 puts them in).
 * The options only change when the actions' icons or labels change; presses always reach the latest
 * handlers.
 */
export function useHeaderActionOptions({
  right,
  lead,
  left,
  leftActions,
}: {
  right?: HeaderAction[] | undefined;
  /** Our own view first among the right actions, in their group (see above). */
  lead?: ReactNode;
  left?: ReactNode;
  /** Native buttons on the left (iOS): unlike a custom `left` view, they keep the large title collapsing. */
  leftActions?: HeaderAction[] | undefined;
}): NativeStackNavigationOptions {
  const latest = useRef(right);
  const latestLeft = useRef(leftActions);
  useLayoutEffect(() => {
    latest.current = right;
    latestLeft.current = leftActions;
  });
  const leftSlot = useHeaderSlot(left ?? null);
  const hasLeft = left != null;
  const leadSlot = useHeaderSlot(lead ?? null);
  const hasLead = lead != null;
  const describe = (list: HeaderAction[] | undefined) =>
    (list ?? []).map(({ icon, sf, label, disabled, menu }) => ({
      icon,
      sf,
      label,
      disabled,
      menu: menu?.map(({ label: l, icon: i, sf: s, destructive }) => ({ label: l, icon: i, sf: s, destructive })),
    }));
  const signature = JSON.stringify([describe(right), describe(leftActions)]);
  return useMemo<NativeStackNavigationOptions>(() => {
    const [actions, lefts] = JSON.parse(signature) as Described[][];
    const press = (i: number) => () => latest.current?.[i]?.onPress();
    const pick = (i: number, j: number) => () => latest.current?.[i]?.menu?.[j]?.onPress();
    const pressLeft = (i: number) => () => latestLeft.current?.[i]?.onPress();
    const options: NativeStackNavigationOptions = {};
    if (IOS) {
      // Shares the buttons' glass (no `hidesSharedBackground`): one capsule with them.
      const leadItem = {
        type: "custom" as const,
        element: (
          <BarPressable>
            <HeaderSlot slot={leadSlot} />
          </BarPressable>
        ),
      };
      options.unstable_headerRightItems =
        actions.length || hasLead
          ? () => [
              ...(hasLead ? [leadItem] : []),
              ...actions.map((a, i) =>
                a.menu
                  ? {
                      type: "menu" as const,
                      label: a.label,
                      accessibilityLabel: a.label,
                      icon: barIcon(a),
                      menu: {
                        items: a.menu.map((m, j) => ({
                          type: "action" as const,
                          label: m.label,
                          icon: { type: "sfSymbol" as const, name: m.sf },
                          destructive: m.destructive,
                          onPress: pick(i, j),
                        })),
                      },
                    }
                  : {
                      type: "button" as const,
                      label: a.label,
                      accessibilityLabel: a.label,
                      icon: barIcon(a),
                      disabled: a.disabled,
                      onPress: press(i),
                    },
              ),
            ]
          : undefined;
      options.unstable_headerLeftItems = lefts.length
        ? () =>
            lefts.map((a, i) => ({
              type: "button" as const,
              label: a.label,
              accessibilityLabel: a.label,
              icon: barIcon(a),
              onPress: pressLeft(i),
            }))
        : hasLeft
          ? () => [
              {
                type: "custom" as const,
                element: (
                  <BarPressable>
                    <HeaderSlot slot={leftSlot} />
                  </BarPressable>
                ),
                hidesSharedBackground: true,
              },
            ]
          : undefined;
    } else {
      options.headerRight =
        actions.length || hasLead
          ? () => (
              <HeaderCapsule>
                {hasLead ? <HeaderSlot slot={leadSlot} /> : null}
                {actions.map((a, i) => (
                  <IconButton
                    key={`${a.icon}:${a.label}`}
                    icon={a.icon}
                    label={a.label}
                    disabled={a.disabled ?? false}
                    onPress={press(i)}
                  />
                ))}
              </HeaderCapsule>
            )
          : undefined;
      options.headerLeft = hasLeft ? () => <HeaderSlot slot={leftSlot} /> : undefined;
    }
    return options;
  }, [signature, hasLeft, leftSlot, hasLead, leadSlot]);
}

/**
 * Our own pressable views in a native bar (its buttons, the conversation's pill, Início's avatar). On iPadOS 26 and
 * iPhone iOS 27 a tap on the bar also scrolls the screen's list to its top, a tap on one of them included: the
 * conversation jumped up when its computer or "…" was pressed. The guard keeps the tap theirs (react-native-screens'
 * workaround until React Native fixes it: react-native#56061); nothing on Android.
 */
export function BarPressable({ children }: { children: ReactNode }) {
  return <ScrollToTopGuard>{children}</ScrollToTopGuard>;
}

/**
 * Buttons of a bar floating over the content (Android): one opaque plate with round ends around them, like the
 * glass capsule iOS 26 draws around a bar's buttons; one button makes a circle. Nothing of its own on iOS,
 * where the system draws the capsule.
 */
export function HeaderCapsule({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const edge = usePlateEdge();
  if (IOS) return <>{children}</>;
  return <View style={[styles.row, styles.capsule, { backgroundColor: colors.glassSolid }, edge]}>{children}</View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  capsule: { gap: 0, borderRadius: 20 },
});
