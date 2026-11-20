import { cleanChart, SLIDE_CHART_LIMITS, type SlideChart } from "@agenteschat/live/slides";
import { Button, Dialog, DialogBody, DialogFooter, Field, Input, Segmented } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChartView } from "@/components/ChartBlock";

/**
 * A chart's data, typed in a small table (ADR 0196 §2): its kind, its title, one row per label and one column per
 * series, numbers in the person's own way of writing them ("1.234,5" in Portuguese). The chart below draws as it is
 * typed; a chart that can't be drawn honestly (a value that isn't a number) can't be saved.
 */

type ChartType = SlideChart["type"];

interface Draft {
  type: ChartType;
  title: string;
  unit: string;
  labels: string[];
  series: { name: string; values: string[] }[];
  value: string;
  delta: string;
}

/** How the person's language writes 1234.5: its group and decimal marks. */
function marks(locale: string): { group: string; decimal: string } {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234.5);
    return {
      group: parts.find((p) => p.type === "group")?.value ?? ",",
      decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
    };
  } catch {
    return { group: ",", decimal: "." };
  }
}

/** A number as the person typed it, or null. "1.234,5" in pt-BR and "1,234.5" in English are both 1234.5. */
export function parseTypedNumber(text: string, locale: string): number | null {
  const raw = text.trim().replace(/\s/g, "");
  if (!raw) return null;
  const { group, decimal } = marks(locale);
  let clean: string;
  if (decimal === ".") clean = raw.split(group).join("");
  else if (!raw.includes(decimal) && /^[-+]?\d+\.(\d{1,2}|\d{4,})$/.test(raw)) {
    // "2.5" where a comma is the decimal mark: a point typed as one (a thousands' group has three digits).
    clean = raw;
  } else clean = raw.split(group).join("").replace(decimal, ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** A number written the person's way, for the fields. */
function typed(n: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 6, useGrouping: false }).format(n);
  } catch {
    return String(n);
  }
}

function draftOf(chart: SlideChart | null, locale: string, words: { item: string; series: string }): Draft {
  if (!chart) {
    return {
      type: "bar",
      title: "",
      unit: "",
      labels: [1, 2, 3].map((n) => `${words.item} ${n}`),
      series: [{ name: words.series, values: [typed(3, locale), typed(5, locale), typed(2, locale)] }],
      value: typed(42, locale),
      delta: "",
    };
  }
  return {
    type: chart.type,
    title: chart.title,
    unit: chart.unit ?? "",
    labels: [...chart.labels],
    series: chart.series.map((s) => ({ name: s.name, values: s.values.map((v) => typed(v, locale)) })),
    value: chart.value !== undefined ? typed(chart.value, locale) : "",
    delta: chart.delta ?? "",
  };
}

/** The draft as a chart, or null while it can't be one. */
export function chartOfDraft(d: Draft, locale: string): SlideChart | null {
  const numbers = d.series.map((s) => s.values.map((v) => parseTypedNumber(v, locale)));
  if (d.type !== "number" && numbers.some((vs) => vs.some((v) => v === null))) return null;
  const raw: Record<string, unknown> = {
    type: d.type,
    title: d.title,
    labels: d.type === "number" ? [] : d.labels,
    series:
      d.type === "number"
        ? []
        : d.series.map((s, i) => ({ name: s.name, values: (numbers[i] ?? []).map((v) => v ?? 0) })),
  };
  if (d.unit.trim()) raw.unit = d.unit.trim();
  if (d.type === "number") {
    const value = parseTypedNumber(d.value, locale);
    if (value === null) return null;
    raw.value = value;
    if (d.delta.trim()) raw.delta = d.delta.trim();
  }
  if (d.type === "pie") {
    const values = (raw.series as { values: number[] }[])[0]?.values ?? [];
    if (values.some((v) => v < 0) || values.reduce((a, b) => a + b, 0) <= 0) return null;
  }
  return cleanChart(raw) ?? null;
}

export function ChartDialog({
  open,
  chart,
  locale,
  onClose,
  onSave,
}: {
  open: boolean;
  /** The chart being changed; null makes a new one. */
  chart: SlideChart | null;
  locale: string;
  onClose: () => void;
  onSave: (chart: SlideChart) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() =>
    draftOf(chart, locale, { item: t("live.slides.chart.item"), series: t("live.slides.chart.series") }),
  );
  const result = chartOfDraft(draft, locale);
  const pie = draft.type === "pie";
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setCell = (row: number, col: number, value: string) =>
    setDraft((d) => ({
      ...d,
      series: d.series.map((s, i) =>
        i === col ? { ...s, values: s.values.map((v, j) => (j === row ? value : v)) } : s,
      ),
    }));
  const addRow = () =>
    setDraft((d) => ({
      ...d,
      labels: [...d.labels, `${t("live.slides.chart.item")} ${d.labels.length + 1}`],
      series: d.series.map((s) => ({ ...s, values: [...s.values, typed(0, locale)] })),
    }));
  const removeRow = (row: number) =>
    setDraft((d) => ({
      ...d,
      labels: d.labels.filter((_, i) => i !== row),
      series: d.series.map((s) => ({ ...s, values: s.values.filter((_, i) => i !== row) })),
    }));
  const addSeries = () =>
    setDraft((d) => ({
      ...d,
      series: [
        ...d.series,
        {
          name: `${t("live.slides.chart.series")} ${d.series.length + 1}`,
          values: d.labels.map(() => typed(0, locale)),
        },
      ],
    }));
  const removeSeries = (col: number) => setDraft((d) => ({ ...d, series: d.series.filter((_, i) => i !== col) }));
  const columns = pie ? draft.series.slice(0, 1) : draft.series;
  const bad = (text: string) => parseTypedNumber(text, locale) === null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={chart ? t("live.slides.chart.editTitle") : t("live.slides.chart.newTitle")}
      closeLabel={t("common.close")}
      width={720}
      unsaved
    >
      <DialogBody className="sl-chartdlg">
        <Segmented<ChartType>
          label={t("live.slides.chart.type")}
          value={draft.type}
          onValueChange={(type) => set({ type, ...(type === "pie" ? { series: draft.series.slice(0, 1) } : {}) })}
          options={[
            { value: "bar", label: t("live.slides.chart.types.bar") },
            { value: "line", label: t("live.slides.chart.types.line") },
            { value: "pie", label: t("live.slides.chart.types.pie") },
            { value: "number", label: t("live.slides.chart.types.number") },
          ]}
          block
        />
        <div className="sl-chartdlg__row">
          <Field label={t("live.slides.chart.title")}>
            <Input value={draft.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label={t("live.slides.chart.unit")} className="sl-chartdlg__unit">
            <Input value={draft.unit} maxLength={8} onChange={(e) => set({ unit: e.target.value })} />
          </Field>
        </div>
        {draft.type === "number" ? (
          <div className="sl-chartdlg__row">
            <Field
              label={t("live.slides.chart.value")}
              error={bad(draft.value) ? t("live.slides.chart.notNumber") : undefined}
            >
              <Input
                value={draft.value}
                inputMode="decimal"
                invalid={bad(draft.value)}
                onChange={(e) => set({ value: e.target.value })}
              />
            </Field>
            <Field label={t("live.slides.chart.delta")}>
              <Input value={draft.delta} maxLength={60} onChange={(e) => set({ delta: e.target.value })} />
            </Field>
          </div>
        ) : (
          <div className="sl-chartdlg__data">
            <table className="sl-chartdlg__table">
              <thead>
                <tr>
                  <th scope="col">{t("live.slides.chart.label")}</th>
                  {columns.map((s, col) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: series in order
                    <th key={col} scope="col">
                      <span className="sl-chartdlg__series">
                        <Input
                          value={s.name}
                          maxLength={40}
                          aria-label={t("live.slides.chart.seriesName", { n: col + 1 })}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              series: d.series.map((x, i) => (i === col ? { ...x, name: e.target.value } : x)),
                            }))
                          }
                        />
                        {columns.length > 1 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="close"
                            aria-label={t("live.slides.chart.removeSeries", { name: s.name })}
                            onClick={() => removeSeries(col)}
                          />
                        )}
                      </span>
                    </th>
                  ))}
                  <td />
                </tr>
              </thead>
              <tbody>
                {draft.labels.map((label, row) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows in order
                  <tr key={row}>
                    <td>
                      <Input
                        value={label}
                        maxLength={60}
                        aria-label={t("live.slides.chart.labelN", { n: row + 1 })}
                        onChange={(e) => set({ labels: draft.labels.map((l, i) => (i === row ? e.target.value : l)) })}
                      />
                    </td>
                    {columns.map((s, col) => {
                      const value = s.values[row] ?? "";
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: cells in order
                        <td key={col}>
                          <Input
                            value={value}
                            inputMode="decimal"
                            className="tabular"
                            invalid={bad(value)}
                            aria-label={t("live.slides.chart.cell", { label, series: s.name })}
                            onChange={(e) => setCell(row, col, e.target.value)}
                          />
                        </td>
                      );
                    })}
                    <td>
                      {draft.labels.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          aria-label={t("live.slides.chart.removeRow", { label })}
                          onClick={() => removeRow(row)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="sl-chartdlg__more">
              <Button
                size="sm"
                icon="plus"
                disabled={draft.labels.length >= SLIDE_CHART_LIMITS.labels}
                onClick={addRow}
              >
                {t("live.slides.chart.addRow")}
              </Button>
              {!pie && (
                <Button
                  size="sm"
                  icon="plus"
                  disabled={draft.series.length >= SLIDE_CHART_LIMITS.series}
                  onClick={addSeries}
                >
                  {t("live.slides.chart.addSeries")}
                </Button>
              )}
            </div>
          </div>
        )}
        <div className="sl-chartdlg__preview" aria-hidden="true">
          {result ? <ChartView spec={result} /> : <p className="sl-chartdlg__invalid">{t("live.slides.chart.fix")}</p>}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={!result} onClick={() => result && onSave(result)}>
          {chart ? t("live.slides.chart.save") : t("live.slides.chart.insert")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
