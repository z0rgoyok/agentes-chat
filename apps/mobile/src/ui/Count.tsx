import { formatInt } from "@agenteschat/client/lib/format";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, countBadge, countStyle, type Weight } from "./type-scale";

export interface CountProps {
  value: number;
  /** Font size (default 14). */
  size?: number;
  /** A badge: the number in the background color on an ink pill (unread counts, tab badges). */
  inverted?: boolean;
  /** Text color override (e.g. on a selected filter). */
  color?: string;
  /** The badge's pill color, ink by default (red for a count that calls on the person, as a mention). */
  fill?: string;
  /** Past this, shows "max+" (unread counts: the server stops counting at 100). */
  max?: number;
  /** A rare large hero number: drawn in Doto (ROND 100). Everything else is the system font. */
  hero?: boolean;
  /** The weight (default semibold; section counts are medium). */
  weight?: Weight;
}

/** How far the figures travel as one number leaves and the next arrives (points). */
const ROLL = 6;

/**
 * Every counter in the app: the system font, semibold, tabular figures (badges, section counts). Doto only
 * for the rare hero number (`hero`). When the number changes it rolls: the old figures leave upward and the new ones
 * arrive from below on a spring, so a change reads as a change (never with reduced motion, nor on mount).
 */
export function Count({ value, size = 14, inverted = false, color, fill, max, hero = false, weight }: CountProps) {
  const { colors, fonts, motion, reducedMotion } = useTheme();
  const { i18n } = useTranslation();
  // In the person's language ("1.284" in Portuguese).
  const label =
    max !== undefined && value > max ? `${formatInt(i18n.language, max)}+` : formatInt(i18n.language, value);
  const [shown, setShown] = useState(label);
  // -1: the old figures gone upward; 1: the new ones below, about to arrive; 0: at rest.
  const k = useSharedValue(0);
  const next = useRef(label);
  next.current = label;
  const arrive = () => {
    setShown(next.current);
    k.set(1);
    k.set(withSpring(0, motion.snap));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new label starts a roll
  useEffect(() => {
    if (label === shown) return;
    if (reducedMotion) {
      setShown(label);
      return;
    }
    k.set(
      withTiming(-1, { duration: 110 }, (done) => {
        if (done) scheduleOnRN(arrive);
      }),
    );
  }, [label, reducedMotion]);
  const roll = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, Math.abs(k.get())),
    transform: [{ translateY: k.get() * ROLL }],
  }));
  const face = hero
    ? { fontFamily: fonts.dot, fontSize: size, lineHeight: Math.round(size * 1.2) }
    : countStyle(size, weight);
  if (inverted) {
    const badge = countBadge(size);
    return (
      <View style={[badge.box, { backgroundColor: fill ?? colors.ink }]}>
        <Animated.Text
          style={[face, badge.text, { color: color ?? colors.bg }, roll]}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
        >
          {shown}
        </Animated.Text>
      </View>
    );
  }
  return (
    <Animated.Text maxFontSizeMultiplier={CHROME_MAX_SCALE} style={[face, { color: color ?? colors.ink }, roll]}>
      {shown}
    </Animated.Text>
  );
}
