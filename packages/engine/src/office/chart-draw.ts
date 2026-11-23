import { chartColors, type SlideChart, type SlideTheme } from "@agenteschat/live";

/**
 * A slide's chart (ADR 0196 §2) as plain marks in slide units: rectangles, polygons and lines, and text boxes, the
 * same for the PowerPoint export (shapes) and the PDF (paths), so both draw the chart the apps show from the same
 * numbers: a title, the plot with its gridlines and value labels, the category labels and a legend when there is
 * more than one series (or a pie's slices).
 */

export type ChartMark =
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill: string }
  | { kind: "poly"; points: [number, number][]; fill?: string; stroke?: string; width?: number; closed: boolean }
  | {
      kind: "text";
      x: number;
      y: number;
      w: number;
      h: number;
      text: string;
      size: number;
      color: string;
      align: "left" | "center" | "right";
      bold?: boolean;
    };

/** A number as a chart labels it: short, with its unit. */
export function chartNumber(n: number, unit?: string): string {
  const abs = Math.abs(n);
  const text =
    abs >= 1e3
      ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)
      : String(Math.round(n * 100) / 100);
  if (!unit) return text;
  return unit === "%" ? `${text}%` : /^[$€£R]/.test(unit) ? `${unit}${text}` : `${text} ${unit}`;
}

/** A tidy top for an axis: 1, 2, 2.5 or 5 times a power of ten, at or above `max`. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function chartMarks(
  chart: SlideChart,
  box: { x: number; y: number; w: number; h: number },
  theme: SlideTheme,
): ChartMark[] {
  const marks: ChartMark[] = [];
  const colors = chartColors(theme);
  const color = (i: number) => colors[i % colors.length] as string;
  const text = theme.colors.text;
  const muted = theme.colors.muted;
  const base = Math.max(12, Math.min(theme.sizes.caption, box.h / 14));
  let top = box.y;
  if (chart.title) {
    marks.push({
      kind: "text",
      x: box.x,
      y: top,
      w: box.w,
      h: base * 1.5,
      text: chart.title,
      size: base * 1.15,
      color: text,
      align: "left",
      bold: true,
    });
    top += base * 1.6;
  }
  if (chart.subtitle) {
    marks.push({
      kind: "text",
      x: box.x,
      y: top,
      w: box.w,
      h: base * 1.3,
      text: chart.subtitle,
      size: base * 0.9,
      color: muted,
      align: "left",
    });
    top += base * 1.4;
  }
  const bottom = box.y + box.h;

  if (chart.type === "number") {
    const value = chartNumber(chart.value ?? 0, chart.unit);
    const size = Math.max(16, Math.min((bottom - top) * 0.6, (box.w / Math.max(value.length, 1)) * 1.6));
    marks.push({
      kind: "text",
      x: box.x,
      y: top,
      w: box.w,
      h: size * 1.2,
      text: value,
      size,
      color: colors[0] as string,
      align: "left",
      bold: true,
    });
    if (chart.delta) {
      marks.push({
        kind: "text",
        x: box.x,
        y: top + size * 1.25,
        w: box.w,
        h: base * 1.4,
        text: chart.delta,
        size: base,
        color: muted,
        align: "left",
      });
    }
    return marks;
  }

  const legend = chart.type === "pie" ? chart.labels.length > 0 : chart.series.length > 1;
  const legendH = legend ? base * 1.6 : 0;
  if (legend) {
    const names = chart.type === "pie" ? chart.labels : chart.series.map((s) => s.name);
    const slot = box.w / Math.max(1, Math.min(names.length, 6));
    names.slice(0, 6).forEach((name, i) => {
      const x = box.x + i * slot;
      const y = bottom - legendH + base * 0.3;
      marks.push({ kind: "rect", x, y: y + base * 0.15, w: base * 0.7, h: base * 0.7, fill: color(i) });
      marks.push({
        kind: "text",
        x: x + base,
        y,
        w: slot - base * 1.2,
        h: base * 1.2,
        text: clip(name, 24),
        size: base * 0.8,
        color: muted,
        align: "left",
      });
    });
  }
  const plotBottom = bottom - legendH;

  if (chart.type === "pie") {
    const values = (chart.series[0]?.values ?? []).map((v) => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0);
    const r = Math.max(4, Math.min(box.w, plotBottom - top) / 2 - base * 0.4);
    const cx = box.x + box.w / 2;
    const cy = top + (plotBottom - top) / 2;
    let angle = -Math.PI / 2;
    values.forEach((v, i) => {
      if (total <= 0 || v <= 0) return;
      const sweep = (v / total) * Math.PI * 2;
      const steps = Math.max(2, Math.ceil(sweep / (Math.PI / 60)));
      const points: [number, number][] = [[cx, cy]];
      for (let k = 0; k <= steps; k++) {
        const a = angle + (sweep * k) / steps;
        points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      marks.push({ kind: "poly", points, fill: color(i), stroke: theme.colors.bg, width: 2, closed: true });
      angle += sweep;
    });
    return marks;
  }

  // Bars and lines: a value axis on the left, categories along the bottom.
  const all = chart.series.flatMap((s) => s.values);
  const high = niceMax(Math.max(0, ...all));
  const low = Math.min(0, ...all) < 0 ? -niceMax(-Math.min(0, ...all)) : 0;
  const axisW = base * 3.2;
  const labelsH = base * 1.5;
  const plot = {
    x: box.x + axisW,
    y: top + base * 0.4,
    w: Math.max(1, box.w - axisW),
    h: Math.max(1, plotBottom - top - labelsH - base * 0.4),
  };
  const yOf = (v: number) => plot.y + plot.h - ((v - low) / (high - low || 1)) * plot.h;
  for (let k = 0; k <= 4; k++) {
    const v = low + ((high - low) * k) / 4;
    const y = yOf(v);
    marks.push({
      kind: "poly",
      points: [
        [plot.x, y],
        [plot.x + plot.w, y],
      ],
      stroke: theme.colors.line,
      width: 1.5,
      closed: false,
    });
    marks.push({
      kind: "text",
      x: box.x,
      y: y - base * 0.6,
      w: axisW - base * 0.4,
      h: base * 1.2,
      text: chartNumber(v, chart.unit),
      size: base * 0.75,
      color: muted,
      align: "right",
    });
  }
  const n = Math.max(1, chart.labels.length);
  const slot = plot.w / n;
  chart.labels.forEach((label, i) => {
    marks.push({
      kind: "text",
      x: plot.x + i * slot,
      y: plot.y + plot.h + base * 0.3,
      w: slot,
      h: base * 1.2,
      text: clip(label, Math.max(3, Math.floor(slot / (base * 0.5)))),
      size: base * 0.75,
      color: muted,
      align: "center",
    });
  });
  if (chart.type === "bar") {
    const groups = Math.max(1, chart.series.length);
    const barW = (slot * 0.7) / groups;
    chart.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const x = plot.x + i * slot + slot * 0.15 + si * barW;
        const y0 = yOf(0);
        const y1 = yOf(v);
        marks.push({
          kind: "rect",
          x,
          y: Math.min(y0, y1),
          w: Math.max(1, barW - 2),
          h: Math.max(0.5, Math.abs(y1 - y0)),
          fill: color(si),
        });
      });
    });
  } else {
    chart.series.forEach((s, si) => {
      const points = s.values.map((v, i): [number, number] => [plot.x + i * slot + slot / 2, yOf(v)]);
      if (points.length > 0)
        marks.push({ kind: "poly", points, stroke: color(si), width: Math.max(2, base * 0.18), closed: false });
    });
  }
  return marks;
}
