import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Disclosure, ROW_MARK } from "./RowMarks";
import { RowPressable } from "./RowPressable";
import { CARD_PAD } from "./rhythm";
import { Text, textLineOf } from "./Text";
import { useFontScale } from "./text-scale";
import { useTheme } from "./theme";
import { leadBox } from "./type-scale";

/** The leading column: a tile or face of up to 36 pt, centered in it. */
const LEAD = 36;
/** A faded row's face and words, as the web's Offline rows. */
const FADED = 0.45;

export interface RowProps {
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  /** Lines the subtitle may take (default 1). */
  subtitleLines?: number;
  /** Right side: a time, a badge (`<Count inverted />`)… */
  meta?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  /** A hairline above (Card adds it between rows). */
  divider?: boolean;
  /** Under the text, in its column (a plan's meter, a note). */
  below?: ReactNode;
  /** Someone off for now (a members list's Offline): the face and the words dimmed, the meta as it is. */
  faded?: boolean;
}

/** A list row: leading avatar or tile, title in ink, a muted line, meta on the right. */
export function Row({
  leading,
  title,
  subtitle,
  subtitleLines = 1,
  meta,
  chevron = false,
  onPress,
  divider = false,
  below,
  faded = false,
}: RowProps) {
  const { colors } = useTheme();
  const fontScale = useFontScale();
  // A subtitle that wraps or something under it: the leading sits at the top and the meta and chevron on the
  // title's line (centred on the whole row they floated between lines). Short rows keep everything centred.
  const tall = subtitleLines > 1 || Boolean(below);
  const line = tall ? textLineOf("title", fontScale) : null;
  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: tall ? "flex-start" : "center",
        gap: 12,
        paddingHorizontal: CARD_PAD,
        paddingVertical: 14,
        minHeight: 60,
      }}
    >
      {divider ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: leading ? CARD_PAD + LEAD + 12 : CARD_PAD,
            right: 0,
            height: StyleSheet.hairlineWidth,
            backgroundColor: colors.separator,
          }}
        />
      ) : null}
      {/* One column for whatever leads (a 30 or 36 tile or face): the text and the hairline above start together. */}
      {leading ? (
        <View style={{ width: LEAD, alignItems: "center", opacity: faded ? FADED : 1 }}>{leading}</View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, opacity: faded ? FADED : 1 }}>
        <Text variant="title" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="small" numberOfLines={subtitleLines}>
            {subtitle}
          </Text>
        ) : null}
        {below}
      </View>
      {meta ? (
        <View style={{ alignItems: "flex-end", gap: 4, minHeight: line?.height, justifyContent: "center" }}>
          {meta}
        </View>
      ) : null}
      {chevron ? (
        <View style={line ? leadBox(line, ROW_MARK.disclosure) : null}>
          <Disclosure />
        </View>
      ) : null}
    </View>
  );
  if (!onPress) return body;
  // Lit as the system's lists light a row; one that opens a screen stays lit until that screen covers it.
  return (
    <RowPressable
      onPress={onPress}
      hold={chevron}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
    >
      {body}
    </RowPressable>
  );
}
