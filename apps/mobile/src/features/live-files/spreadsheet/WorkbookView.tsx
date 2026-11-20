import { sheetLocale, type WorkbookData } from "@agenteschat/live/spreadsheet";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, type TextInputInstance, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Filters, useTheme } from "@/ui";
import { type Caret, CellBar } from "./CellBar";
import { boxLabel } from "./edit";
import { dataGridSource, selectionStats, workbookTabs } from "./model";
import { type GridSelection, SheetGrid } from "./SheetGrid";

/**
 * A workbook shown read-only on the phone (ADR 0198): an uploaded Excel, OpenDocument or CSV file as the server read
 * it, or an old table, drawn by the same grid as a live spreadsheet, with its sheets as chips and the cell bar saying
 * what the selected cell holds (a sum, average and count for several). `footer`: what the screen offers under it (Edit
 * as a spreadsheet).
 */
export function WorkbookView({ workbook, footer }: { workbook: WorkbookData; footer?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const locale = useMemo(() => sheetLocale(i18n.language || "en"), [i18n.language]);
  const tabs = useMemo(() => workbookTabs(workbook), [workbook]);
  const [picked, setPicked] = useState("0");
  const index = Math.max(0, Math.min(Number(picked) || 0, workbook.sheets.length - 1));
  const sheet = workbook.sheets[index];
  const source = useMemo(() => (sheet ? dataGridSource(sheet, locale, String(index)) : null), [sheet, locale, index]);
  const start = (s: typeof source): GridSelection => {
    const row = s?.layout.frozenRows ?? 0;
    const col = s?.layout.frozenCols ?? 0;
    return { row, col, box: { r1: row, c1: col, r2: row, c2: col } };
  };
  const [selection, setSelection] = useState<GridSelection>(() => start(source));
  // biome-ignore lint/correctness/useExhaustiveDependencies: another sheet starts at its first cell.
  useEffect(() => setSelection(start(source)), [index]);
  const input = useRef<TextInputInstance>(null);
  const caret = useRef<Caret>({ start: 0, end: 0 });
  const stats = useMemo(() => {
    if (!source) return null;
    const s = selectionStats(source, selection.box);
    if (!s) return null;
    const n = new Intl.NumberFormat(locale.tag, { maximumFractionDigits: 2 });
    if (s.numbers === 0) return t("mobile.live.sheet.countOnly", { count: n.format(s.count) });
    return t("mobile.live.sheet.stats", {
      sum: n.format(s.sum),
      average: n.format(s.average ?? 0),
      count: n.format(s.count),
    });
  }, [source, selection.box, locale.tag, t]);
  if (!source) return null;
  const noop = () => {};
  return (
    <View style={styles.fill}>
      <View style={styles.fill}>
        <SheetGrid source={source} selection={selection} onSelect={setSelection} />
      </View>
      {tabs.length > 1 ? (
        <View style={[styles.tabs, { backgroundColor: c.bg }]}>
          <Filters
            items={tabs.map((tab) => ({ key: tab.id, label: tab.name }))}
            value={String(index)}
            onChange={setPicked}
          />
        </View>
      ) : null}
      <CellBar
        label={boxLabel(selection.box, source.layout)}
        value={source.input(selection.row, selection.col)}
        stats={stats}
        readOnly
        editing={null}
        problem={null}
        keys={[]}
        input={input}
        caret={caret}
        onEdit={noop}
        onChange={noop}
        onEnter={noop}
        onDone={noop}
        onCancel={noop}
      />
      {footer}
      <View style={{ height: insets.bottom, backgroundColor: c.bg }} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  tabs: { paddingTop: 8 },
});
