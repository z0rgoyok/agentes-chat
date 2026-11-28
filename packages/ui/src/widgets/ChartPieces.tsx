/**
 * The React pieces of the chat's charts (a clean stroke over a fine dither in the agent's tones),
 * shared by the chat's chart card (`apps/web/src/components/ChartBlock.tsx`) and the widgets (ADR 0135). The cells
 * themselves come from `../sky/chart`, DOM-free, as the phone draws them.
 */
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AgentColorName } from "../agent/engine.js";
import { cx } from "../cx";
import { useDarkTheme } from "../hooks/useDarkTheme";
import {
  areaCells,
  CHART_CELL,
  chartAreaTones,
  chartInk,
  linePoints,
  lineTops,
  nearestPoint,
  smoothPath,
} from "../sky/chart";
import { parseColor } from "../sky/math";

/** Paints cells (one canvas pixel each, drawn at `CHART_CELL` points) in the color `tone(value)` gives. */
export function paintCells(
  canvas: HTMLCanvasElement | null,
  cols: number,
  rows: number,
  cells: ArrayLike<number>,
  tone: (value: number) => string | null,
) {
  if (!canvas || cols < 1 || rows < 1) return;
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(cols, rows);
  const cache = new Map<number, [number, number, number] | null>();
  for (let i = 0; i < cols * rows; i++) {
    const v = cells[i] ?? -1;
    if (!cache.has(v)) {
      const c = tone(v);
      cache.set(v, c ? parseColor(c) : null);
    }
    const rgb = cache.get(v);
    if (!rgb) continue;
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** An element's width, kept up to date. */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Where a chart's tip stands (in its box's points) and what it says; null when it is hidden. */
export type ChartTipAt = { x: number; y: number; text: ReactNode } | null;

/**
 * The tip over a chart's point, the chat's charts' and the widgets' alike: above the point, or under it near the
 * box's top (`above` keeps it above: a chart at a card's foot has no room under it). Given the box's `width`, a
 * point near either side keeps the tip inside it instead of centered over it.
 */
export function ChartTip({ tip, width, above = false }: { tip: ChartTipAt; width?: number; above?: boolean }) {
  const side = !tip || !width ? undefined : tip.x < width * 0.2 ? "start" : tip.x > width * 0.8 ? "end" : undefined;
  return (
    <span
      className="chart-tip"
      data-on={Boolean(tip)}
      data-below={tip && !above ? tip.y < 44 : undefined}
      data-side={side}
      style={tip ? { left: tip.x, top: tip.y } : undefined}
      aria-hidden="true"
    >
      {tip?.text}
    </span>
  );
}

const STEP_KEYS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };

/**
 * The point a reader is on in a chart of `count` points: the nearest one (`nearest`, from x in the box) under the
 * pointer, kept after a tap on a touch screen until the chart loses focus; with the keyboard, the last one once the
 * chart has focus, then the arrow keys (Home, End) move it and Escape hides it. Spread `props` on the chart's box.
 */
export function useChartCursor(count: number, nearest: (x: number) => number) {
  const [at, setAt] = useState<number | null>(null);
  const last = count - 1;
  const pick = (e: PointerEvent<HTMLElement>) => {
    const i = nearest(e.clientX - e.currentTarget.getBoundingClientRect().left);
    if (i >= 0) setAt(i);
  };
  const props = {
    tabIndex: 0,
    onPointerMove: pick,
    onPointerDown: pick,
    onPointerLeave: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse") setAt(null);
    },
    onFocus: () => setAt((a) => a ?? last),
    onBlur: () => setAt(null),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const step = STEP_KEYS[e.key];
      const next =
        step !== undefined
          ? (at ?? (step < 0 ? count : -1)) + step
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
      if (e.key === "Escape") setAt(null);
      if (next === null) return;
      e.preventDefault();
      setAt(Math.max(0, Math.min(last, next)));
    },
  };
  return { at: at !== null && at <= last ? at : null, props };
}

/** Tops missing at either end (NaN) take the nearest column's, so an edge-to-edge area has no gap at its sides. */
export function fillEnds(tops: number[]) {
  const first = tops.findIndex((v) => !Number.isNaN(v));
  if (first < 0) return;
  for (let i = 0; i < first; i++) tops[i] = tops[first] as number;
  for (let i = first + 1; i < tops.length; i++) if (Number.isNaN(tops[i] as number)) tops[i] = tops[i - 1] as number;
}

/**
 * The dither under a line (`points`, in a box `width` × `height` points), in an agent's tones: the near tone along
 * the curve, the far one fading down. `bleed` (edge to edge) fills the side columns the curve's samples round past
 * and fades over twice the height, so the dither still reaches the bottom edge. The one painter of a line's area, for
 * the chat's chart and the widgets alike.
 */
export function paintLineArea(
  canvas: HTMLCanvasElement | null,
  points: readonly (readonly [number, number])[],
  width: number,
  height: number,
  color: AgentColorName,
  dark: boolean,
  bleed = false,
) {
  if (width < 10) return;
  const cols = Math.round(width / CHART_CELL);
  const rows = Math.round(height / CHART_CELL);
  const tops = lineTops(points, cols);
  if (bleed) fillEnds(tops);
  const [near, far] = chartAreaTones(color, dark);
  const cells = areaCells(cols, bleed ? rows * 2 : rows, tops);
  paintCells(canvas, cols, rows, cells, (v) => (v === 1 ? near : v === 2 ? far : null));
}

/**
 * A line over its dither area, in an agent's tones, as wide as its box: no axes. `bleed` runs it edge to edge (a
 * sparkline), `dot` marks the last point with a square, as a widget's line ends. Given `tip` (what a point says), the
 * reader's point (pointer, tap or arrow keys: `useChartCursor`) gets a crosshair, its square and the chat's tip.
 */
export function DitherLine({
  values,
  color,
  height,
  bleed = false,
  dot = false,
  tip,
  label,
  className,
}: {
  values: readonly number[];
  /** An agent color, as `AgentAvatar` takes it. */
  color: string;
  height: number;
  bleed?: boolean;
  dot?: boolean;
  /** What point `i` says ("Nov 12: $ 18,420"): the chart then answers hover, tap and the arrow keys. */
  tip?: (i: number) => string;
  /** The chart's name for a screen reader, with `tip`. */
  label?: string;
  className?: string;
}) {
  const dark = useDarkTheme();
  const [box, width] = useElementWidth<HTMLDivElement>();
  const area = useRef<HTMLCanvasElement>(null);
  const tone = color as AgentColorName;
  const points = useMemo(() => {
    if (width < 10 || values.length < 2) return [];
    const pad = bleed ? 3 : 6;
    const flat = linePoints(values, width, height, pad);
    if (!bleed) return flat;
    return flat.map(([, y], i): [number, number] => [(i * width) / Math.max(1, values.length - 1), y]);
  }, [values, width, height, bleed]);
  const ink = chartInk(tone, dark);
  const cursor = useChartCursor(points.length, (x) => nearestPoint(points, x));

  useLayoutEffect(() => {
    if (points.length < 2) return;
    paintLineArea(area.current, points, width, height, tone, dark, bleed);
  }, [points, width, height, tone, dark, bleed]);

  const last = points[points.length - 1];
  const on = tip && cursor.at !== null ? points[cursor.at] : undefined;
  const text = on && tip && cursor.at !== null ? tip(cursor.at) : null;
  // Kept whole inside the box: edge to edge, the first and last points sit on its sides.
  const square = ([x, y]: readonly [number, number], size: number) => ({
    x: Math.max(0, Math.min(width - size, Math.round(x) - size / 2)),
    y: Math.max(0, Math.min(height - size, Math.round(y) - size / 2)),
    width: size,
    height: size,
  });
  return (
    <div
      className={cx("ac-dline", className)}
      ref={box}
      style={{ height }}
      {...(tip ? { ...cursor.props, role: "group", "aria-label": label } : { "aria-hidden": true })}
    >
      <canvas ref={area} className="ac-dline__area" />
      {width > 10 && points.length > 1 && (
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
          {on && <line x1={on[0]} x2={on[0]} y1={0} y2={height} className="chart-line__cursor" />}
          <path d={smoothPath(points)} fill="none" stroke={ink} strokeWidth={2} strokeLinecap="round" />
          {dot && last && last !== on && <rect {...square(last, 6)} fill={ink} />}
          {on && <rect {...square(on, 8)} fill={ink} className="ac-dline__on" />}
        </svg>
      )}
      {tip && (
        <>
          <ChartTip tip={on && text ? { x: on[0], y: on[1], text } : null} width={width} above={bleed} />
          <span className="ac-visually-hidden" aria-live="polite">
            {text}
          </span>
        </>
      )}
    </div>
  );
}
