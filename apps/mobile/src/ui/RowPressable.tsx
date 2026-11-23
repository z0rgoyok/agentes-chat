import { NavigationContext } from "expo-router/react-navigation";
import { type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Pressable, type PressableProps, type StyleProp, StyleSheet, type ViewStyle } from "react-native";
import Animated, { type CSSTransitionProperties, cubicBezier } from "react-native-reanimated";
import { ROW_PRESS_DELAY } from "./PressScale";
import { useTheme } from "./theme";

/**
 * How a lit row goes out, the system lists' own: at once under the finger, then out over 0.3 s, ease-out (only its
 * opacity moves, on the UI thread).
 */
export const ROW_OUT_MS = 300;
const EASE_OUT = cubicBezier(0.23, 1, 0.32, 1);
/** How long a held row waits for the screen it opens before it goes out anyway (a tap that opened nothing). */
const HOLD_WAIT = 450;

type Fade = Pick<ViewStyle, "opacity"> & CSSTransitionProperties<ViewStyle>;
const LIT: Fade = { opacity: 1, transitionProperty: "opacity", transitionDuration: 0 };
const OUT: Fade = {
  opacity: 0,
  transitionProperty: "opacity",
  transitionDuration: ROW_OUT_MS,
  transitionTimingFunction: EASE_OUT,
};

type Held = "no" | "waiting";

export interface RowPressableProps extends Omit<PressableProps, "style" | "children"> {
  style?: StyleProp<ViewStyle>;
  /**
   * The row opens a screen: it stays lit until that screen covers it, then goes out underneath, so the list is plain
   * again when the person comes back (a row lit until the way back ended read as stuck).
   */
  hold?: boolean;
  /** Lights under the finger (default true); off where the control in it answers on its own (a switch's row). */
  light?: boolean;
  /** The lit color where the row doesn't sit on a list's card (default the system's `rowLit`). */
  litColor?: string;
  /** The row's own corner, when it is a rounded box of its own: the light keeps it. */
  radius?: number;
  children?: ReactNode;
}

/**
 * A full-width row of a list or a sheet, pressed as the system's lists press theirs: no scale, the row lights in the
 * system's gray as the finger lands (a beat late, `ROW_PRESS_DELAY`, so a finger that only scrolls never flashes it),
 * goes out over 0.3 s when it lifts, and a quick tap still shows it lit, going out. No haptic: the system's lists give
 * none; a switch, a choice and a swipe give their own.
 */
export function RowPressable({
  style,
  hold = false,
  light = true,
  litColor,
  radius,
  children,
  onPressIn,
  onPressOut,
  onPress,
  unstable_pressDelay = ROW_PRESS_DELAY,
  ...rest
}: RowPressableProps) {
  const { colors } = useTheme();
  // The screen's own navigation, read without following its state (a row never redraws when the stack moves).
  const navigation = useContext(NavigationContext);
  const [lit, setLit] = useState(false);
  const held = useRef<Held>("no");
  const wait = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopWaiting = useCallback(() => {
    if (wait.current) clearTimeout(wait.current);
    wait.current = null;
  }, []);
  const release = useCallback(() => {
    held.current = "no";
    stopWaiting();
    setLit(false);
  }, [stopWaiting]);

  useEffect(() => {
    if (!hold || !navigation) return;
    return navigation.addListener("blur", () => {
      if (held.current === "waiting") release();
    });
  }, [hold, navigation, release]);
  useEffect(() => stopWaiting, [stopWaiting]);

  return (
    <Pressable
      unstable_pressDelay={unstable_pressDelay}
      {...rest}
      style={style}
      onPressIn={(e) => {
        if (light) setLit(true);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        // A frame later: a tap shorter than the delay lights and lifts at once, and it must be seen lit; a press that
        // opens a screen holds it in the meantime (`onPress` runs right after this).
        requestAnimationFrame(() => {
          if (held.current === "no") setLit(false);
        });
        onPressOut?.(e);
      }}
      {...(onPress
        ? {
            onPress: (e: Parameters<NonNullable<PressableProps["onPress"]>>[0]) => {
              if (hold && light) {
                held.current = "waiting";
                setLit(true);
                stopWaiting();
                wait.current = setTimeout(release, HOLD_WAIT);
              }
              onPress(e);
            },
          }
        : {})}
    >
      {light ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: litColor ?? colors.rowLit },
            radius === undefined ? null : { borderRadius: radius },
            lit ? LIT : OUT,
          ]}
        />
      ) : null}
      {children}
    </Pressable>
  );
}
