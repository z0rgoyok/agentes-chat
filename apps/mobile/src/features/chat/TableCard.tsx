import { TABLE_PREVIEW_ROWS, tablePreviewed, tableTsv } from "@agenteschat/client/lib/table";
import * as ScreenOrientation from "expo-screen-orientation";
import { memo, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { holdOrientation, lockHome } from "@/lib/orientation";
import { EmptyState, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors } from "../shared/hooks";
import { copyText, PushedHeader } from "../shared/parts";
import { CardMore, CopyButton, FullScreenButton } from "./CodeCard";
import type { Block, Inline } from "./logic";
import { cellText, Table } from "./MessageSpans";

type TableBlock = Pick<Extract<Block, { kind: "table" }>, "header" | "rows" | "align">;

/** The table open in full screen (a route can't carry a table in its URL), as the code's is. */
let opened: TableBlock | null = null;

function openTable(table: TableBlock) {
  opened = table;
  router.push("/table");
}

/** A table as a spreadsheet takes it from the clipboard: each value lands in its own cell (`tableTsv`). */
const tsvOf = ({ header, rows }: TableBlock) =>
  tableTsv(
    header.map(cellText),
    rows.map((r: Inline[][]) => r.map(cellText)),
  );

/**
 * A table in a message, in the code card's frame (the web's table card): on top, "Table · N rows" with Copy (the
 * table as a spreadsheet takes it, each value in its own cell) and Full screen. A long table shows its first rows and
 * "See all N rows", as long code shows its first lines. Its columns fit the card before it scrolls (`Table`).
 */
export const TableCard = memo(function TableCard({ header, rows, align }: TableBlock) {
  const { t } = useTranslation();
  const c = useColors();
  const previewed = tablePreviewed(rows.length);
  const shown = useMemo(() => (previewed ? rows.slice(0, TABLE_PREVIEW_ROWS) : rows), [previewed, rows]);
  const tsv = useMemo(() => tsvOf({ header, rows, align }), [header, rows, align]);
  const open = () => openTable({ header, rows, align });
  return (
    <View style={[styles.card, { backgroundColor: c.sunken, borderColor: c.line }]}>
      <View style={styles.top}>
        <Text variant="label" tone="faint" style={styles.label} numberOfLines={1}>
          {t("mobile.table.label", { count: rows.length })}
        </Text>
        <CopyButton text={tsv} label={t("mobile.table.copy")} />
        <FullScreenButton onPress={open} />
      </View>
      <Table header={header} rows={shown} align={align} surface={c.sunken} bare />
      {previewed ? <CardMore label={t("mobile.table.more", { count: rows.length })} onPress={open} /> : null}
    </View>
  );
});

/**
 * While the table's screen shows, it turns with the phone: lying down, more columns fit. Leaving it, the app stands
 * the way it does everywhere else (`lockHome`), as an agent's screen hands it back (`useSideways`).
 */
function useTurnsWithPhone() {
  useEffect(() => {
    const release = holdOrientation();
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.DEFAULT).catch(() => {});
    return () => {
      release();
      lockHome();
    };
  }, []);
}

/**
 * A message's table in full screen (`/table`, a pushed screen with the system's back): every row, the header staying
 * on top and the first column standing still as the rest scroll under them, Copy in the bar. It turns with the phone.
 */
export function TableScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  useTurnsWithPhone();
  const table = opened;
  if (!table) {
    return (
      // Opened again with nothing to show (the app started over on it): said as every empty place says it.
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        <PushedHeader title={t("mobile.table.title")} />
        <View style={styles.gone}>
          <EmptyState size="panel" icon="spreadsheet" title={t("mobile.table.gone")} />
        </View>
      </View>
    );
  }
  const copy = () => {
    void copyText(tsvOf(table)).then((ok) =>
      toast(ok ? { title: t("mobile.table.copied"), icon: "check" } : { title: t("mobile.app.failed"), icon: "x" }),
    );
  };
  return (
    <View style={[styles.fill, { backgroundColor: c.bg, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <PushedHeader
        title={t("mobile.table.title")}
        subtitle={t("mobile.table.rows", { count: table.rows.length })}
        actions={[{ icon: "copy", sf: "doc.on.doc", label: t("mobile.table.copy"), onPress: copy }]}
      />
      <Table header={table.header} rows={table.rows} align={table.align} surface={c.bg} full bottom={insets.bottom} />
    </View>
  );
}

const styles = StyleSheet.create({
  // The code card's frame (`CodeCard`): the same corners, hairline and head.
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  top: { flexDirection: "row", alignItems: "center", gap: 2, height: 38, paddingLeft: 14, paddingRight: 4 },
  label: { flex: 1 },
  fill: { flex: 1 },
  gone: { flex: 1, justifyContent: "center", padding: 24 },
});
