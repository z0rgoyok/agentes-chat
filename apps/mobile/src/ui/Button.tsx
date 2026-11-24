import type { ReactNode } from "react";
import { ActivityIndicator, Text as RNText, StyleSheet, View } from "react-native";
import type { IconName } from "./Icon";
import { PressScale } from "./PressScale";
import { RADIUS } from "./radius";
import { TOUCH } from "./rhythm";
import { systemText } from "./Text";
import { type Theme, useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

/** `text`: the ghost's words with no side padding, so they start where the text above does (under a message). */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "text";

export interface ButtonProps {
  variant: ButtonVariant;
  size?: ButtonSize;
  /**
   * Kept for callers, never drawn: a button is its words (the design language has no icons inside buttons; a brand's
   * mark, which is a name and not a picture, goes in `leading`).
   */
  icon?: IconName;
  /** Drawn before the label instead of an icon (a brand's mark), given the label's color. */
  leading?: (color: string) => ReactNode;
  label: string;
  onPress: () => void;
  /** Full width. */
  wide?: boolean;
  disabled?: boolean;
  /** Working on it: a spinner in the icon's place, and it can't be pressed again meanwhile. */
  loading?: boolean;
  /** What a screen reader hears after the label: the state the label is too short to say. */
  hint?: string;
  /** The label wraps instead of being cut: it carries a name the server sets, of any length. */
  wrap?: boolean;
}

/**
 * In a card or a row: a capsule 34 tall, its target grown to 44 past it (`slopOf`). Every button is a capsule, sized
 * for a finger rather than a pointer (the web's rectangles read as a page's buttons on a phone).
 */
const SMALL = { height: 34, radius: RADIUS.full, padding: 14, text: "subhead", icon: 16 } as const;

export const BUTTON_SIZES = {
  md: { height: 50, radius: RADIUS.full, padding: 22, text: "headline", icon: 18 },
  // A request's footer in the conversation: the in-card small button, so the card stays a message.
  card: SMALL,
  sm: SMALL,
} as const;

export type ButtonSize = keyof typeof BUTTON_SIZES;

/** A button shorter than a finger's target grows it above and below, never sideways: two 8 apart never share one. */
export function slopOf(height: number) {
  const grow = (TOUCH - height) / 2;
  return grow > 0 ? { top: grow, bottom: grow } : undefined;
}

/**
 * Primary's look: the ink, solid, with the page's color for its words (no gradient, edge lines or shadow: a phone's
 * button is a fill a finger presses). A gradient pair of the same ink for what draws it as one (`HoldButton`).
 */
export function primaryLook(theme: Pick<Theme, "colors">) {
  const { ink, bg } = theme.colors;
  return {
    gradient: [ink, ink] as const,
    shadow: "none",
    highlight: "transparent",
    lowlight: "transparent",
    text: bg,
  };
}

/**
 * The kit's button, touch first: a capsule (50 wide or in a form, 34 in a row) that gives under the finger with a light
 * haptic. Primary is the ink, solid; secondary a tonal fill (`tonal`); ghost and text the ink's words with no fill.
 */
export function Button({
  variant,
  size = "md",
  leading,
  label,
  onPress,
  wide = false,
  disabled = false,
  loading = false,
  hint,
  wrap = false,
}: ButtonProps) {
  const theme = useTheme();
  const { colors } = theme;
  const s = BUTTON_SIZES[size];
  const primary = variant === "primary";
  const look = primaryLook(theme);
  const textColor = primary ? look.text : colors.ink;
  return (
    <PressScale
      onPress={onPress}
      disabled={disabled || loading}
      sink
      fill={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(hint ? { accessibilityHint: hint } : {})}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      hitSlop={slopOf(s.height)}
      style={[
        {
          borderRadius: s.radius,
          alignSelf: wide ? "stretch" : "flex-start",
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <View
        style={[
          styles.face,
          { minHeight: s.height, borderRadius: s.radius, paddingHorizontal: variant === "text" ? 0 : s.padding },
          primary
            ? { backgroundColor: colors.ink }
            : variant === "secondary"
              ? { backgroundColor: colors.tonal }
              : null,
        ]}
      >
        {loading ? <ActivityIndicator size="small" color={textColor} /> : leading ? leading(textColor) : null}
        <RNText
          numberOfLines={wrap ? 0 : 1}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={[systemText(s.text, weights.semibold), { color: textColor }, wrap ? styles.wrap : null]}
        >
          {label}
        </RNText>
      </View>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  // Sized by its content and the minimum height, never grown: a growing face inside the press's growing
  // Pressable fills whatever height Yoga offers when it measures to fit, so a button beside a row's text
  // stood as tall as the screen.
  face: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    overflow: "hidden",
  },
  wrap: { flexShrink: 1, textAlign: "center", paddingVertical: 8 },
});
