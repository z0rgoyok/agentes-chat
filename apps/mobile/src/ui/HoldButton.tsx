import { mixHex } from "@agenteschat/ui/agent/engine";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { BUTTON_SIZES, type ButtonSize, primaryLook, slopOf } from "./Button";
import { haptics } from "./haptics";
import { PRESS_IN, PRESS_OUT } from "./PressScale";
import { systemText } from "./Text";
import { motion, useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

/** Let go early, the fill snaps back fast; once confirmed it drains a little slower, the decision made. */
const LET_GO = { duration: motion.base, easing: motion.easeOut };
const DRAIN = { duration: motion.panel, easing: motion.easeOut };

export interface HoldButtonProps {
  /** "Segure para aprovar". One label: a shorter one while held would shrink the button under the finger. */
  label: string;
  onConfirm: () => void;
  /** How long to hold (default 700 ms). */
  durationMs?: number;
  /** Not yet: dimmed, and holding does nothing (as `Button`'s). */
  disabled?: boolean;
  /** The button's height and type (default `md`); a request card's footer uses `card`. */
  size?: ButtonSize;
}

/** The hold's own curve: the fill starts slow and speeds up, so the end of the hold is felt coming. */
const HOLD_EASE = Easing.bezier(0.4, 0, 1, 1);
/** Light taps while held, closer together as the fill speeds up (shares of the hold: 190 to 620 of its 700 ms). */
const TICKS = [190, 340, 460, 550, 620].map((ms) => ms / 700);
/**
 * The press's mark for iOS: a message's system menu (`MessageMenu`) starts before a hold fills, so a hold inside the
 * message (an approval's) was cancelled and the menu opened instead. A press that starts on a view with this `testID`
 * (its accessibilityIdentifier) opens no menu (`patches/expo-router@58.0.23.patch`).
 */
export const OWN_HOLD = "own-hold";

/**
 * Hold to confirm (high-risk approvals): the button rests a shade lighter and fills from the left in the ink's own
 * tone while held, slowly then faster, with light taps that come closer together and a success one when full.
 * Released early it snaps back fast on an ease-out, the taps stop, nothing asked. With reduced motion the fill is
 * linear (it shows time passing) with one tap at the start. No icon: the words are the button.
 */
export function HoldButton({ label, onConfirm, durationMs = 700, disabled = false, size = "md" }: HoldButtonProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const look = primaryLook(theme);
  const s = BUTTON_SIZES[size];
  const fill = useSharedValue(0);
  const press = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ticks = useRef<ReturnType<typeof setTimeout>[]>([]);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  const stopTicks = () => {
    for (const tick of ticks.current) clearTimeout(tick);
    ticks.current = [];
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      for (const tick of ticks.current) clearTimeout(tick);
    },
    [],
  );

  const start = () => {
    haptics.light();
    stopTicks();
    if (!theme.reducedMotion) ticks.current = TICKS.map((share) => setTimeout(haptics.light, share * durationMs));
    fill.value = withTiming(1, { duration: durationMs, easing: theme.reducedMotion ? Easing.linear : HOLD_EASE });
    press.value = theme.reducedMotion ? 1 : withTiming(1, PRESS_IN);
    timer.current = setTimeout(() => {
      timer.current = null;
      ticks.current = [];
      press.value = theme.reducedMotion ? 0 : withTiming(0, PRESS_OUT);
      fill.value = withTiming(0, DRAIN);
      haptics.success();
      confirmRef.current();
    }, durationMs);
  };
  const stop = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    stopTicks();
    cancelAnimation(fill);
    fill.value = withTiming(0, LET_GO);
    press.value = theme.reducedMotion ? 0 : withTiming(0, PRESS_OUT);
  };

  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.03 * press.value }] }));
  const { bg } = theme.colors;

  return (
    <Animated.View
      style={[
        {
          minHeight: s.height,
          borderRadius: s.radius,
          boxShadow: look.shadow,
          alignSelf: "stretch",
          opacity: disabled ? 0.5 : 1,
        },
        pressStyle,
      ]}
    >
      <Pressable
        onPressIn={start}
        onPressOut={stop}
        testID={OWN_HOLD}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={t("mobile.a11y.hold")}
        accessibilityState={{ disabled }}
        hitSlop={slopOf(s.height)}
        style={[styles.face, { borderRadius: s.radius }]}
      >
        <LinearGradient
          colors={[mixHex(look.gradient[0], bg, 0.3), mixHex(look.gradient[1], bg, 0.3)] as const}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: "left" }, fillStyle]} pointerEvents="none">
          <LinearGradient colors={look.gradient} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <View style={[styles.edge, { backgroundColor: look.highlight }]} />
        <RNText
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={[systemText(s.text, weights.semibold), { color: look.text }]}
        >
          {label}
        </RNText>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  face: {
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    overflow: "hidden",
  },
  edge: { position: "absolute", left: 0, right: 0, top: 0, height: 1 },
});
