import { formatInt } from "@agenteschat/client/lib/format";
import { LIMIT_NEAR, overLimitText, tooLongText, tooLongToSend } from "@agenteschat/client/lib/message-length";
import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, type TextInputInstance, type TextInputProps } from "react-native";
import { Text, useSystemText } from "@/ui";
import { useColors } from "./hooks";

/**
 * How much a field holds, in place of `maxLength`, which drops pasted or dictated text past it without a word: here
 * nothing is ever cut, and the screen holds its submit while `overLimit` says so. `fix`: for words that go to the
 * agent as the person's message, the message's size and limit, then this way out; without it the field's own line.
 */
export interface TextLimit {
  max: number;
  fix?: string;
}

/** Counted as the server counts it (trimmed). */
export const overLimit = (value: string | undefined, limit: TextLimit | undefined) =>
  limit !== undefined && tooLongToSend(value ?? "", limit.max);

/**
 * A multi-line field on a raised surface (sheets: reason to refuse, a new
 * agent, a task, a mission's goal). The design system has the composer and
 * the search field but no plain text area, so it is composed here. `ref`: the
 * field, for a screen that focuses it (an idea added to a text). It grows with
 * its text up to `maxHeight`, then scrolls inside (with `scrollEnabled` false
 * it grows whole, the screen scrolling it). With `limit` (never with
 * `maxLength`, kept for one-line names), a counter under it from 90% of the
 * limit, and past it the field's error line.
 */
export function TextArea({
  style,
  minHeight = 84,
  maxHeight,
  limit,
  ref,
  ...props
}: Omit<TextInputProps, "ref"> & {
  minHeight?: number;
  maxHeight?: number;
  limit?: TextLimit;
  ref?: Ref<TextInputInstance | null>;
}) {
  const c = useColors();
  const { t, i18n } = useTranslation();
  // What people write grows with their text size, as the text around it.
  const words = useSystemText("body");
  const length = (props.value ?? "").trim().length;
  const over = overLimit(props.value, limit);
  const near = limit !== undefined && length >= limit.max * LIMIT_NEAR;
  const overLine =
    limit && over
      ? limit.fix
        ? `${tooLongText(t, i18n.language, length, limit.max)} ${limit.fix}`
        : overLimitText(t, i18n.language, length, limit.max)
      : null;
  return (
    <>
      <TextInput
        ref={ref}
        multiline
        textAlignVertical="top"
        placeholderTextColor={c.faint}
        {...props}
        style={[
          styles.field,
          words,
          {
            minHeight,
            maxHeight: props.scrollEnabled === false ? undefined : (maxHeight ?? Math.max(minHeight, 280)),
            backgroundColor: c.raised,
            color: c.ink,
            borderColor: over ? c.danger : c.line,
          },
          style,
        ]}
      />
      {overLine ? (
        <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite" style={styles.line}>
          {overLine}
        </Text>
      ) : near && limit ? (
        <Text variant="footnote" style={[styles.line, styles.count]}>
          {formatInt(i18n.language, length)} / {formatInt(i18n.language, limit.max)}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
  },
  // Under the field's words, as far in as they are.
  line: { paddingHorizontal: 14 },
  count: { alignSelf: "flex-end", fontVariant: ["tabular-nums"] },
});
