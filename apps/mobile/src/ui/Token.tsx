import { Children, type ReactElement, type ReactNode, useState } from "react";
import { type AccessibilityActionEvent, Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Icon } from "./Icon";
import { withAlpha } from "./palette";
import { TOUCH } from "./rhythm";
import { systemText } from "./Text";
import { motion, useTheme } from "./theme";
import { CHROME_MAX_SCALE } from "./type-scale";

/** A token's height: one picked thing in a field (an address, a channel, an agent). */
export const TOKEN_H = 32;
/** Between tokens, across and down. */
export const TOKEN_GAP = 6;
/** The ×'s own box at the pill's end; `hitSlop` grows its target to a finger's 44. */
const X_BOX = 24;
/** A token just added fades in (built once: a builder made in render is a new animation every time). */
const TOKEN_IN = FadeIn.duration(motion.fast).easing(motion.easeOut);

export interface TokenProps {
  label: string;
  /** Before the label: a face, a channel's icon or a cargo's mark, 20 at most. */
  leading?: ReactNode;
  /** Why it won't go as it is, after the label and never cut with it ("confira", "já está aqui"). */
  note?: string;
  /** `bad`: it has to be fixed or taken out; `soft`: it won't go and needs nothing (someone in already). */
  tone?: "neutral" | "bad" | "soft";
  /** The token itself pressed (an address to fix goes back to the field). */
  onPress?: () => void;
  /** An × at its end that takes it out. */
  onRemove?: () => void;
  /** The ×'s name for VoiceOver ("Tirar ana@example.com"). */
  removeLabel?: string;
  /** Just added: it fades in (none with reduced motion). */
  fresh?: boolean;
}

/**
 * One picked thing in a field, the web's kit Token: a 32-point pill with what leads it, its label on one line (a long
 * address is cut in its middle, its note and × stay) and, when it can go, an × whose target is 44.
 */
export function Token({ label, leading, note, tone = "neutral", onPress, onRemove, removeLabel, fresh }: TokenProps) {
  const { colors: c, reducedMotion } = useTheme();
  const ink = tone === "bad" ? c.danger : tone === "soft" ? c.faint : c.ink;
  const said = note ? `${label}, ${note}` : label;
  const pill = (
    <View
      style={[
        styles.pill,
        { backgroundColor: tone === "bad" ? withAlpha(c.danger, 0.12) : c.chip },
        leading ? styles.led : null,
        onRemove ? styles.closable : null,
      ]}
    >
      {leading ? <View style={styles.lead}>{leading}</View> : null}
      {/* Cut in the middle: an address keeps its name and its domain, which tell two apart. */}
      <RNText
        numberOfLines={1}
        ellipsizeMode="middle"
        maxFontSizeMultiplier={CHROME_MAX_SCALE}
        style={[TEXT, styles.label, { color: ink }]}
      >
        {label}
      </RNText>
      {note ? (
        <RNText numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE} style={[TEXT, { color: ink }]}>
          {`· ${note}`}
        </RNText>
      ) : null}
      {onRemove ? (
        <Pressable
          onPress={onRemove}
          hitSlop={(TOUCH - X_BOX) / 2}
          accessibilityRole="button"
          accessibilityLabel={removeLabel ?? label}
          style={({ pressed }) => [styles.x, pressed ? { opacity: 0.5 } : null]}
        >
          <Icon name="x" size={14} color={tone === "bad" ? c.danger : c.faint} />
        </Pressable>
      ) : null}
    </View>
  );
  // Pressable itself (an address to fix): a finger's 44 around its 32, and to VoiceOver one button whose × is its
  // action, since a button inside a button can't be reached.
  const body = onPress ? (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: (TOUCH - TOKEN_H) / 2, bottom: (TOUCH - TOKEN_H) / 2 }}
      accessibilityRole="button"
      accessibilityLabel={said}
      {...(onRemove
        ? {
            accessibilityActions: [{ name: "delete", label: removeLabel ?? label }],
            onAccessibilityAction: (e: AccessibilityActionEvent) => {
              if (e.nativeEvent.actionName === "delete") onRemove();
            },
          }
        : {})}
      style={({ pressed }) => [styles.shrink, pressed ? { opacity: 0.6 } : null]}
    >
      {pill}
    </Pressable>
  ) : (
    <View style={styles.shrink} accessible={!onRemove} accessibilityLabel={said}>
      {pill}
    </View>
  );
  return (
    <Animated.View style={styles.shrink} entering={fresh && !reducedMotion ? TOKEN_IN : undefined}>
      {body}
    </Animated.View>
  );
}

const TEXT = systemText("subhead");

/**
 * Tokens from line to line, at most `lines` of them: the ones that don't fit leave, and `more` says how many on the
 * last line's end ("+3"), so a field never grows past its lines. Without `lines`, as many lines as they take.
 */
export function TokenWrap({
  children,
  lines,
  more,
}: {
  children: ReactNode;
  lines?: number;
  /** The words for the ones left out ("+3"). */
  more?: (count: number) => string;
}) {
  const { colors: c } = useTheme();
  const items = Children.toArray(children) as ReactElement[];
  // Each token's top, as laid out: those starting past the last line are the ones left out.
  const [tops, setTops] = useState<Record<string, number>>({});
  const limit = lines ? lines * TOKEN_H + (lines - 1) * TOKEN_GAP : null;
  const out = limit === null ? 0 : items.filter((it) => (tops[String(it.key)] ?? 0) >= limit).length;
  return (
    <View style={styles.wrapLine}>
      <View style={[styles.wrap, limit !== null ? { maxHeight: limit, overflow: "hidden" } : null]}>
        {items.map((it) => (
          <View
            key={it.key}
            style={styles.shrink}
            onLayout={(e) => {
              const y = Math.round(e.nativeEvent.layout.y);
              const key = String(it.key);
              setTops((all) => (all[key] === y ? all : { ...all, [key]: y }));
            }}
          >
            {it}
          </View>
        ))}
      </View>
      {out > 0 && more ? (
        <RNText maxFontSizeMultiplier={CHROME_MAX_SCALE} style={[TEXT, styles.more, { color: c.faint }]}>
          {more(out)}
        </RNText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: TOKEN_GAP,
    minHeight: TOKEN_H,
    paddingHorizontal: 12,
    borderRadius: TOKEN_H / 2,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  // A face or a mark sits 6 from the pill's round end, as far as from its top and bottom.
  led: { paddingLeft: 6 },
  // The ×'s box carries the pill to its end: 4 past it, as round as the lead's side.
  closable: { paddingRight: 4 },
  lead: { alignItems: "center", justifyContent: "center" },
  label: { flexShrink: 1, minWidth: 0 },
  x: { width: X_BOX, height: X_BOX, borderRadius: X_BOX / 2, alignItems: "center", justifyContent: "center" },
  shrink: { flexShrink: 1, minWidth: 0, maxWidth: "100%" },
  wrapLine: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  wrap: { flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", gap: TOKEN_GAP },
  // On the last line's middle.
  more: { lineHeight: TOKEN_H },
});
