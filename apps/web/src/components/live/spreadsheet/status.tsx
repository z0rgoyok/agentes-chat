import { formatValue, type SheetLocale } from "@agenteschat/live/spreadsheet";
import { useTranslation } from "react-i18next";
import type { SelectionStats } from "./model";

/**
 * The selection's numbers at the end of the sheet tabs (ADR 0196): "Soma 1.234,00 · Média 411,33 · Contagem 3", in
 * the first number's format and the reader's separators. Only the sum stays when the sheet is narrow (`sheet.css`);
 * a selection holding no number says only how many cells hold something.
 */
export function SelectionStatus({ stats, locale }: { stats: SelectionStats; locale: SheetLocale }) {
  const { t } = useTranslation();
  if (stats.count === 0) return null;
  const number = (n: number) => formatValue(n, stats.nf ?? (Number.isInteger(n) ? "#,##0" : "#,##0.00"), locale).text;
  const count = t("live.sheet.status.count", { value: new Intl.NumberFormat(locale.tag).format(stats.count) });
  if (stats.numbers === 0) return <span>{count}</span>;
  return (
    <>
      <span>{t("live.sheet.status.sum", { value: number(stats.sum) })}</span>
      <span className="sheet-stat--more">
        {" · "}
        {t("live.sheet.status.average", { value: number(stats.sum / stats.numbers) })}
        {" · "}
        {count}
      </span>
    </>
  );
}
