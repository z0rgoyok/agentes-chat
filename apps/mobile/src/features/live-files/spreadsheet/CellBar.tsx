import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text as RNText,
  ScrollView,
  StyleSheet,
  TextInput,
  type TextInputInstance,
  type TextInputSelectionChangeEvent,
  View,
} from "react-native";
import { Button, IconButton, SCREEN_X, Text, useFieldText, useTheme } from "@/ui";

/**
 * The cell bar under a spreadsheet (ADR 0196): the active cell's address and what it holds as the person would type it
 * ("B4 · =SOMA(B2:B3)"), or the selection's sum, average and count, with Editar. Editing, it is a field riding the
 * keyboard, in the person's language; Enter writes the cell and moves to the one under it, keeping the keyboard up
 * for the next; ✓ writes and closes; × leaves the cell as it was. Over the keys while a formula is typed, the keys
 * formulas need that the phone's keyboard hides (=, parentheses, the argument separator, :, $), and a tap on any cell
 * puts its address in the formula.
 */
export interface CellEditing {
  text: string;
  /** A caret the screen put (after a key or a cell's address): the field follows it once, then the person's again. */
  place?: { start: number; end: number };
}

export type Caret = { start: number; end: number };

export function CellBar({
  label,
  value,
  stats,
  readOnly,
  editing,
  problem,
  keys,
  input,
  caret,
  onEdit,
  onChange,
  onEnter,
  onDone,
  onCancel,
}: {
  label: string;
  /** What the active cell holds, as typed. */
  value: string;
  /** "Soma 1.234 · Média 411,33 · Contagem 3" when several cells are selected. */
  stats: string | null;
  readOnly: boolean;
  editing: CellEditing | null;
  /** Why the last try wasn't written, in words. */
  problem: string | null;
  /** The formula keys over the keyboard. */
  keys: readonly string[];
  input: RefObject<TextInputInstance | null>;
  /** Where the caret is in the field (the screen puts a tapped cell's address there). */
  caret: RefObject<Caret>;
  onEdit: () => void;
  onChange: (next: CellEditing) => void;
  onEnter: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const field = useFieldText("body");

  const typeKey = (key: string) => {
    if (!editing) return;
    const { start, end } = caret.current;
    const text = editing.text.slice(0, start) + key + editing.text.slice(end);
    const at = start + key.length;
    caret.current = { start: at, end: at };
    onChange({ text, place: { start: at, end: at } });
  };

  if (editing)
    return (
      <View style={[styles.bar, { backgroundColor: c.bg, borderTopColor: c.line2 }]}>
        {problem ? (
          <Text variant="footnote" tone="danger" style={styles.problem} accessibilityLiveRegion="polite">
            {problem}
          </Text>
        ) : null}
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.keys}
          style={styles.keysRow}
        >
          {keys.map((key) => (
            <Pressable
              key={key}
              onPress={() => typeKey(key)}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.live.sheet.typeKey", { key })}
              hitSlop={4}
              style={({ pressed }) => [styles.key, { backgroundColor: pressed ? c.line2 : c.plate }]}
            >
              <RNText allowFontScaling={false} style={[styles.keyText, { color: c.ink2 }]}>
                {key}
              </RNText>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.row}>
          <IconButton icon="x" small label={t("mobile.live.sheet.cancel")} onPress={onCancel} />
          <Text variant="subhead" style={styles.ref} numberOfLines={1}>
            {label}
          </Text>
          <TextInput
            ref={input}
            value={editing.text}
            {...(editing.place ? { selection: editing.place } : {})}
            onChangeText={(text) => onChange({ text })}
            onSelectionChange={(e: TextInputSelectionChangeEvent) => {
              caret.current = e.nativeEvent.selection;
              if (editing.place) onChange({ text: editing.text });
            }}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            spellCheck={false}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={onEnter}
            placeholder={t("mobile.live.sheet.placeholder")}
            placeholderTextColor={c.faint}
            accessibilityLabel={t("mobile.live.sheet.editing", { cell: label })}
            style={[field, styles.input, { color: c.ink, backgroundColor: c.plate }]}
          />
          <IconButton icon="check" small label={t("mobile.live.sheet.done")} onPress={onDone} />
        </View>
      </View>
    );

  return (
    <Pressable
      onPress={readOnly ? undefined : onEdit}
      disabled={readOnly}
      accessibilityRole={readOnly ? "text" : "button"}
      accessibilityLabel={stats ? `${label}, ${stats}` : `${label}, ${value || t("mobile.live.sheet.empty")}`}
      accessibilityHint={readOnly ? undefined : t("mobile.live.sheet.editHint")}
      style={[styles.bar, styles.row, styles.idle, { backgroundColor: c.bg, borderTopColor: c.line2 }]}
    >
      <Text variant="subhead" style={styles.ref} numberOfLines={1}>
        {label}
      </Text>
      <Text variant="subhead" tone={stats || !value ? "faint" : "ink2"} numberOfLines={1} style={styles.value}>
        {stats ?? (value || t("mobile.live.sheet.empty"))}
      </Text>
      {readOnly ? null : <Button variant="secondary" size="sm" label={t("mobile.live.sheet.edit")} onPress={onEdit} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 8 },
  idle: { minHeight: 52 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  ref: { fontWeight: "600", minWidth: 36, fontVariant: ["tabular-nums"] },
  value: { flex: 1, minWidth: 0 },
  problem: { paddingHorizontal: 4, paddingBottom: 6 },
  keysRow: { flexGrow: 0, marginBottom: 8 },
  keys: { gap: 8, paddingHorizontal: 4 },
  key: {
    minWidth: 40,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  keyText: { fontSize: 17, fontWeight: "500" },
  input: { flex: 1, minWidth: 0, height: 40, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 0 },
});
