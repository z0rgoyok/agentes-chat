import { onThemeChange } from "@agenteschat/ui";
import {
  forwardRef,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  drawGrid,
  fillHandleBox,
  forgetMeasures,
  type GridTheme,
  markStrength,
  measure,
  type RangeMark,
  withAlpha,
} from "./draw";
import {
  type CellPos,
  cellAtPoint,
  fillTarget,
  type GridRange,
  HEADER_H,
  HEADER_W,
  inRange,
  rangeBox,
  scrollToShow,
  type Viewport,
  type Whole,
} from "./model";
import type { DrawCell, GridSource } from "./source";

/**
 * The spreadsheet's grid (ADR 0196): a scroller sized to the whole sheet gives native scrollbars, momentum and
 * keyboard scrolling, a canvas pinned over it draws only the visible window each frame (DPR-aware, so lines stay one
 * device pixel), and a layer of DOM on top holds what needs to be real elements: the cell's editor, people's name
 * tags, a cell's tip and "Add rows". Pointer gestures (select, drag, headers, resizing, the fill handle) are read off
 * the scroller and handed to the editor; positions on screen are worked out in `model.ts`.
 */

/** A name tag over someone's range: a person's or an agent's. */
export interface GridTag {
  id: string;
  range: GridRange;
  color: string;
  /** The tag's content (a name, or a face and a name). */
  content: ReactNode;
  /** Shown now (they are typing, or moved a moment ago); else only while the pointer is over their range. */
  show: boolean;
}

export interface GridHandle {
  /** Brings a range into view (its top-left first when it doesn't fit). */
  reveal(range: GridRange): void;
  /** A range's box in the window's coordinates, for menus and popups. */
  clientBox(range: GridRange): { x: number; y: number; width: number; height: number } | null;
  /** How many rows a page holds (PageUp/PageDown). */
  pageRows(): number;
  /** A text's width in a cell's font (the editor grows with it). */
  textWidth(text: string, cell: DrawCell | null): number;
  /** The scroller, which takes focus for the keys when nothing is being typed. */
  element(): HTMLElement | null;
}

export type GridArea = "cell" | "row" | "col" | "corner";

/** A point in sheet pixels: from the top-left of cell A1, as if nothing were scrolled. */
export interface SheetPoint {
  x: number;
  y: number;
}

/**
 * The grid's view for what is drawn over the cells in step with its scrolling (agents' cursors): a signal each frame
 * the grid draws, and where a point of the sheet is on that layer now (frozen rows and columns stay put).
 */
export interface GridView {
  subscribe(listener: () => void): () => void;
  /** Goes up with every frame drawn. */
  frame(): number;
  /** A sheet point → px on the cursors' layer (whose top-left is the cells' top-left on screen). */
  toScreen(p: SheetPoint): SheetPoint;
}

export interface GridProps {
  source: GridSource;
  /** The selection's cells and active cell (null: none drawn). */
  selection: { range: GridRange; active: CellPos; whole?: Whole } | null;
  marks: readonly RangeMark[];
  tags: readonly GridTag[];
  /** The cell being typed in (its text is the editor's). */
  editing: CellPos | null;
  readOnly: boolean;
  /** The editor's own width while it grows with the text (CSS px), else the cell's. */
  editorWidth?: number | undefined;
  /** The editor, laid over the active cell. */
  editor: ReactNode;
  /** Words for an error cell's tip ("Divisão por zero"). */
  errorTip(cell: DrawCell): string;
  /** "Add rows" under the last row (an editable sheet). */
  moreRows?: ReactNode;
  /** What moves with the cells over them (agents' cursors), drawn on a layer clipped to the cells. */
  cursors?: (view: GridView) => ReactNode;
  /** A press on a cell or a header; `drag` for each cell the pointer moves over until it lifts. */
  onPress(at: CellPos, area: GridArea, how: { shift: boolean; meta: boolean }): void;
  onDrag(at: CellPos, area: GridArea): void;
  onRelease(): void;
  onDoubleClick(at: CellPos): void;
  onFill(to: GridRange): void;
  onResize(axis: "row" | "col", index: number, size: number): void;
  onAutoFit(axis: "row" | "col", index: number): void;
  onMenu(x: number, y: number, at: CellPos, area: GridArea): void;
  /** The person scrolled the grid themselves (not the editor bringing a cell into view). */
  onUserScroll(): void;
}

/** How far from a header's edge (CSS px) the pointer resizes instead of selecting. */
const EDGE_SLOP = 4;
/** How near the grid's edge a drag scrolls it, and how fast at most (CSS px per frame). */
const AUTO_SCROLL_EDGE = 24;
const AUTO_SCROLL_MAX = 24;
/** A finger that moves less than this taps (a cell gets selected); more scrolls. */
const TAP_SLOP = 8;
const TIP_DELAY_MS = 350;

function readTheme(el: Element): GridTheme {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme === "dark";
  const ink = v("--ink", dark ? "#efefec" : "#151514");
  return {
    dark,
    cell: v("--raised", dark ? "#1c1c1b" : "#ffffff"),
    header: v("--sunken", dark ? "#0a0a09" : "#f3f3f0"),
    line: v("--line2", dark ? "rgba(255, 255, 255, 0.15)" : "rgba(23, 23, 22, 0.12)"),
    lineStrong: v("--line-strong", "#82827d"),
    ink,
    muted: v("--muted", dark ? "#a3a39e" : "#5c5c58"),
    danger: v("--danger", dark ? "#f08a80" : "#b42a20"),
    selFill: dark ? "rgba(255, 255, 255, 0.08)" : withAlpha(ink, 0.06),
    headerSel: dark ? "rgba(255, 255, 255, 0.1)" : withAlpha(ink, 0.08),
    font: v("--font-sans", "system-ui, sans-serif"),
  };
}

type Gesture =
  | { kind: "select"; area: GridArea; last: string }
  | { kind: "resize"; axis: "row" | "col"; index: number; start: number; size: number; now: number }
  | { kind: "fill"; from: GridRange; to: GridRange | null }
  | { kind: "tap"; x: number; y: number; at: CellPos; area: GridArea; shift: boolean; meta: boolean };

export const Grid = forwardRef<GridHandle, GridProps>(function Grid(props, ref) {
  const latest = useRef(props);
  latest.current = props;
  const scroller = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const editorHost = useRef<HTMLDivElement>(null);
  const tipEl = useRef<HTMLDivElement>(null);
  const moreEl = useRef<HTMLDivElement>(null);
  const guide = useRef<HTMLDivElement>(null);
  const tagEls = useRef(new Map<string, HTMLDivElement>());
  const size = useRef({ width: 0, height: 0, dpr: 1 });
  const theme = useRef<GridTheme | null>(null);
  const frame = useRef(0);
  const gesture = useRef<Gesture | null>(null);
  const fillTo = useRef<GridRange | null>(null);
  const hover = useRef<CellPos | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const autoScroll = useRef<{ dx: number; dy: number; x: number; y: number } | null>(null);
  /** Scroll positions the grid set itself: their scroll events aren't the person's. */
  const ownScroll = useRef<{ x: number; y: number } | null>(null);
  const frames = useRef(0);
  const frameListeners = useRef(new Set<() => void>());

  const view = useCallback((): Viewport => {
    const el = scroller.current;
    const { frozen } = latest.current.source;
    return {
      width: size.current.width,
      height: size.current.height,
      scrollX: el?.scrollLeft ?? 0,
      scrollY: el?.scrollTop ?? 0,
      frozenRows: frozen.rows,
      frozenCols: frozen.cols,
    };
  }, []);

  const gridView = useMemo<GridView>(
    () => ({
      subscribe(listener) {
        frameListeners.current.add(listener);
        return () => {
          frameListeners.current.delete(listener);
        };
      },
      frame: () => frames.current,
      toScreen(p) {
        const vw = view();
        const { rows, cols } = latest.current.source;
        const frozenW = cols.start(vw.frozenCols);
        const frozenH = rows.start(vw.frozenRows);
        return { x: p.x < frozenW ? p.x : p.x - vw.scrollX, y: p.y < frozenH ? p.y : p.y - vw.scrollY };
      },
    }),
    [view],
  );

  /** The newest `draw`, for a frame that asks for the next one. */
  const drawRef = useRef<() => void>(() => {});
  const draw = useCallback(() => {
    frame.current = 0;
    /** The editor over the active cell, the tags over their ranges, "Add rows" under the last row. */
    const placeOverlay = (vw: Viewport) => {
      const p = latest.current;
      const { rows, cols } = p.source;
      const host = editorHost.current;
      if (host) {
        const at = p.editing ?? p.selection?.active ?? null;
        const merge = at ? p.source.merges.at(at.r, at.c) : undefined;
        const range = merge ?? (at ? { r1: at.r, c1: at.c, r2: at.r, c2: at.c } : null);
        const b = range ? rangeBox(range, rows, cols, vw) : null;
        const visible = b !== null && b.x + b.w > HEADER_W && b.y + b.h > HEADER_H && b.x < vw.width && b.y < vw.height;
        if (b && (visible || p.editing)) {
          const width = Math.max(b.w, Math.min(p.editorWidth ?? 0, Math.max(b.w, vw.width - b.x - 4)));
          host.style.transform = `translate(${b.x}px, ${b.y}px)`;
          host.style.width = `${width}px`;
          host.style.minHeight = `${b.h}px`;
        } else {
          // Out of view and not typing: the editor waits at the corner, still holding the keys' focus.
          host.style.transform = `translate(${HEADER_W}px, ${HEADER_H}px)`;
          host.style.width = "0px";
          host.style.minHeight = "0px";
        }
      }
      for (const tag of p.tags) {
        const el = tagEls.current.get(tag.id);
        if (!el) continue;
        const b = rangeBox(tag.range, rows, cols, vw);
        const over = hover.current !== null && inRange(tag.range, hover.current.r, hover.current.c);
        const shown = (tag.show || over) && b.x + b.w > HEADER_W && b.y + b.h > HEADER_H && b.y < vw.height;
        el.style.transform = `translate(${Math.min(b.x + b.w, vw.width)}px, ${b.y}px)`;
        el.dataset.shown = shown ? "true" : "false";
      }
      const more = moreEl.current;
      if (more) {
        const y = HEADER_H + rows.total - vw.scrollY;
        more.style.transform = `translate(${HEADER_W}px, ${y}px)`;
        more.dataset.shown = y < vw.height ? "true" : "false";
      }
    };
    const p = latest.current;
    const el = canvas.current;
    const vw = view();
    // The overlay's elements first: they need no canvas (tests, a canvas the browser refused).
    placeOverlay(vw);
    if (frameListeners.current.size > 0) {
      frames.current++;
      for (const listener of frameListeners.current) listener();
    }
    const ctx = el?.getContext("2d");
    if (!el || !ctx || vw.width <= 0 || vw.height <= 0) return;
    theme.current ??= readTheme(el);
    drawGrid(ctx, {
      source: p.source,
      view: vw,
      dpr: size.current.dpr,
      theme: theme.current,
      selection: p.selection,
      fillHandle: !p.readOnly && p.selection !== null && p.editing === null,
      fillTo: fillTo.current,
      marks: p.marks,
      editing: p.editing,
      now: performance.now(),
    });
    // A mark fading out (an agent moved on) asks for the next frame until it is gone.
    const fading = p.marks.some((m) => m.fade && markStrength(m, performance.now()) > 0);
    if (fading) frame.current = requestAnimationFrame(drawRef.current);
  }, [view]);
  drawRef.current = draw;

  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(draw);
  }, [draw]);

  // Redraw whenever what is drawn changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: every prop drawn is read from `latest` when the frame runs
  useLayoutEffect(() => {
    schedule();
  }, [
    props.source,
    props.selection,
    props.marks,
    props.tags,
    props.editing,
    props.editorWidth,
    props.readOnly,
    schedule,
  ]);

  // Size, pixel ratio, theme and fonts.
  useEffect(() => {
    const el = scroller.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = el.clientWidth;
      const height = el.clientHeight;
      size.current = { width, height, dpr };
      cv.width = Math.max(1, Math.round(width * dpr));
      cv.height = Math.max(1, Math.round(height * dpr));
      cv.style.width = `${width}px`;
      cv.style.height = `${height}px`;
      if (overlay.current) {
        overlay.current.style.width = `${width}px`;
        overlay.current.style.height = `${height}px`;
      }
      schedule();
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(el);
    // A window moved to a screen of another density.
    let media: MediaQueryList | null = null;
    const watchDpr = () => {
      media?.removeEventListener("change", onDpr);
      media = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) ?? null;
      media?.addEventListener?.("change", onDpr);
    };
    const onDpr = () => {
      resize();
      watchDpr();
    };
    watchDpr();
    const offTheme = onThemeChange(() => {
      theme.current = null;
      schedule();
    });
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    const onFonts = () => {
      forgetMeasures();
      schedule();
    };
    fonts?.addEventListener?.("loadingdone", onFonts);
    void fonts?.ready?.then(onFonts);
    return () => {
      observer?.disconnect();
      media?.removeEventListener?.("change", onDpr);
      offTheme();
      fonts?.removeEventListener?.("loadingdone", onFonts);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      clearTimeout(tipTimer.current);
    };
  }, [schedule]);

  // The scroller's size follows the sheet's.
  useLayoutEffect(() => {
    const el = sizer.current;
    if (!el) return;
    const { rows, cols } = props.source;
    el.style.width = `${HEADER_W + cols.total}px`;
    el.style.height = `${HEADER_H + rows.total + (props.moreRows ? 56 : 0)}px`;
  }, [props.source, props.moreRows]);

  useImperativeHandle(
    ref,
    (): GridHandle => ({
      reveal(range) {
        const el = scroller.current;
        if (!el) return;
        const { rows, cols } = latest.current.source;
        const vw = view();
        if (vw.width <= 0) return;
        const to = scrollToShow(range, rows, cols, vw);
        if (to.x === vw.scrollX && to.y === vw.scrollY) return;
        ownScroll.current = to;
        el.scrollLeft = to.x;
        el.scrollTop = to.y;
        schedule();
      },
      clientBox(range) {
        const el = scroller.current;
        if (!el) return null;
        const { rows, cols } = latest.current.source;
        const b = rangeBox(range, rows, cols, view());
        const rect = el.getBoundingClientRect();
        return { x: rect.left + b.x, y: rect.top + b.y, width: b.w, height: b.h };
      },
      pageRows() {
        const { rows } = latest.current.source;
        const h = Math.max(0, size.current.height - HEADER_H);
        return Math.max(1, Math.floor(h / Math.max(1, rows.size(0) || 24)) - 1);
      },
      textWidth(text, cell) {
        const cv = canvas.current;
        const ctx = cv?.getContext("2d");
        if (!ctx) return text.length * 7;
        theme.current ??= readTheme(cv as HTMLCanvasElement);
        const font = `${cell?.style?.i ? "italic " : ""}${cell?.style?.b ? 600 : 400} ${
          cell?.style?.fs ? Math.round(cell.style.fs * 13) / 10 : 13
        }px ${theme.current.font}`;
        return measure(ctx, font, text);
      },
      element: () => scroller.current,
    }),
    [schedule, view],
  );

  // ── Pointer ───────────────────────────────────────────────────────────────────────────────────────────────────

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = scroller.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const hit = (x: number, y: number): { at: CellPos; area: GridArea } => {
    const { rows, cols } = latest.current.source;
    const at = cellAtPoint(x, y, rows, cols, view());
    const area: GridArea = at.r < 0 && at.c < 0 ? "corner" : at.r < 0 ? "col" : at.c < 0 ? "row" : "cell";
    return { at: { r: Math.max(0, at.r), c: Math.max(0, at.c) }, area };
  };

  /** A header's edge under the pointer (to resize), or null. */
  const edgeAt = (x: number, y: number): { axis: "row" | "col"; index: number } | null => {
    const { rows, cols } = latest.current.source;
    const vw = view();
    if (y < HEADER_H && x > HEADER_W) {
      const frozenW = cols.start(vw.frozenCols);
      const cx = x - HEADER_W < frozenW ? x - HEADER_W : x - HEADER_W + vw.scrollX;
      const index = cols.edgeNear(cx, EDGE_SLOP);
      return index >= 0 ? { axis: "col", index } : null;
    }
    if (x < HEADER_W && y > HEADER_H) {
      const frozenH = rows.start(vw.frozenRows);
      const cy = y - HEADER_H < frozenH ? y - HEADER_H : y - HEADER_H + vw.scrollY;
      const index = rows.edgeNear(cy, EDGE_SLOP);
      return index >= 0 ? { axis: "row", index } : null;
    }
    return null;
  };

  const onFillHandle = (x: number, y: number): boolean => {
    const p = latest.current;
    if (p.readOnly || !p.selection || p.editing) return false;
    const { rows, cols } = p.source;
    const b = fillHandleBox(p.selection.range, rows, cols, view(), size.current.dpr);
    return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  };

  const showGuide = (axis: "row" | "col", at: number) => {
    const g = guide.current;
    if (!g) return;
    g.dataset.axis = axis;
    g.dataset.shown = "true";
    g.style.transform = axis === "col" ? `translate(${at}px, 0)` : `translate(0, ${at}px)`;
  };

  const hideGuide = () => {
    if (guide.current) guide.current.dataset.shown = "false";
  };

  const stepAutoScroll = () => {
    const a = autoScroll.current;
    const el = scroller.current;
    if (!a || !el || !gesture.current) return;
    el.scrollLeft += a.dx;
    el.scrollTop += a.dy;
    moveTo(a.x, a.y);
    requestAnimationFrame(stepAutoScroll);
  };

  const moveTo = (x: number, y: number) => {
    const g = gesture.current;
    if (!g) return;
    const p = latest.current;
    const { rows, cols } = p.source;
    if (g.kind === "resize") {
      const now = Math.max(16, g.size + (g.axis === "col" ? x : y) - g.start);
      g.now = now;
      const vw = view();
      const edge =
        g.axis === "col"
          ? HEADER_W + cols.start(g.index) - (g.index < vw.frozenCols ? 0 : vw.scrollX) + now
          : HEADER_H + rows.start(g.index) - (g.index < vw.frozenRows ? 0 : vw.scrollY) + now;
      showGuide(g.axis, edge);
      return;
    }
    const { at } = hit(Math.max(HEADER_W + 1, x), Math.max(HEADER_H + 1, y));
    if (g.kind === "fill") {
      const to = fillTarget(g.from, at);
      g.to = to
        ? {
            r1: Math.min(to.r1, g.from.r1),
            c1: Math.min(to.c1, g.from.c1),
            r2: Math.max(to.r2, g.from.r2),
            c2: Math.max(to.c2, g.from.c2),
          }
        : null;
      fillTo.current = g.to;
      schedule();
      return;
    }
    if (g.kind === "select") {
      const target = g.area === "col" ? { r: 0, c: hit(x, Math.max(0, Math.min(y, HEADER_H - 1))).at.c } : at;
      const key = `${target.r}:${target.c}`;
      if (key === g.last) return;
      g.last = key;
      p.onDrag(g.area === "row" ? { r: hit(Math.max(0, Math.min(x, HEADER_W - 1)), y).at.r, c: 0 } : target, g.area);
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest(".sheet-grid__overlay [data-interactive]")) return;
    const { x, y } = local(e);
    const el = scroller.current;
    if (!el) return;
    // Clicks on the scrollbars scroll.
    if (x >= el.clientWidth || y >= el.clientHeight) return;
    if (e.button === 2) return;
    const p = latest.current;
    const { at, area } = hit(x, y);
    if (e.pointerType === "touch") {
      gesture.current = { kind: "tap", x, y, at, area, shift: e.shiftKey, meta: e.metaKey || e.ctrlKey };
      return;
    }
    if (e.button !== 0) return;
    const edge = p.readOnly ? null : edgeAt(x, y);
    if (edge) {
      e.preventDefault();
      const { rows, cols } = p.source;
      gesture.current = {
        kind: "resize",
        axis: edge.axis,
        index: edge.index,
        start: edge.axis === "col" ? x : y,
        size: edge.axis === "col" ? cols.size(edge.index) : rows.size(edge.index),
        now: edge.axis === "col" ? cols.size(edge.index) : rows.size(edge.index),
      };
      el.setPointerCapture?.(e.pointerId);
      return;
    }
    if (onFillHandle(x, y) && p.selection) {
      e.preventDefault();
      gesture.current = { kind: "fill", from: p.selection.range, to: null };
      el.setPointerCapture?.(e.pointerId);
      return;
    }
    e.preventDefault();
    gesture.current = { kind: "select", area, last: `${at.r}:${at.c}` };
    el.setPointerCapture?.(e.pointerId);
    p.onPress(at, area, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const { x, y } = local(e);
    const g = gesture.current;
    const el = scroller.current;
    if (!el) return;
    if (g?.kind === "tap") {
      if (Math.hypot(x - g.x, y - g.y) > TAP_SLOP) gesture.current = null;
      return;
    }
    if (!g) {
      hoverAt(x, y);
      const edge = latest.current.readOnly ? null : edgeAt(x, y);
      el.style.cursor = edge
        ? edge.axis === "col"
          ? "col-resize"
          : "row-resize"
        : onFillHandle(x, y)
          ? "crosshair"
          : x > HEADER_W && y > HEADER_H
            ? "cell"
            : "default";
      return;
    }
    moveTo(x, y);
    if (g.kind === "resize") return;
    // Near an edge, the grid scrolls on by itself while the drag goes on.
    const speed = (d: number) => Math.max(-AUTO_SCROLL_MAX, Math.min(AUTO_SCROLL_MAX, d / 2));
    const dx =
      x > el.clientWidth - AUTO_SCROLL_EDGE
        ? speed(x - el.clientWidth + AUTO_SCROLL_EDGE)
        : x < HEADER_W
          ? speed(x - HEADER_W)
          : 0;
    const dy =
      y > el.clientHeight - AUTO_SCROLL_EDGE
        ? speed(y - el.clientHeight + AUTO_SCROLL_EDGE)
        : y < HEADER_H
          ? speed(y - HEADER_H)
          : 0;
    const running = autoScroll.current !== null;
    autoScroll.current = dx || dy ? { dx, dy, x, y } : null;
    if (autoScroll.current && !running) requestAnimationFrame(stepAutoScroll);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    autoScroll.current = null;
    scroller.current?.releasePointerCapture?.(e.pointerId);
    const p = latest.current;
    if (!g) return;
    if (g.kind === "tap") {
      p.onPress(g.at, g.area, { shift: g.shift, meta: g.meta });
      p.onRelease();
      return;
    }
    if (g.kind === "resize") {
      hideGuide();
      if (Math.round(g.now) !== Math.round(g.size)) p.onResize(g.axis, g.index, Math.round(g.now));
      return;
    }
    if (g.kind === "fill") {
      fillTo.current = null;
      schedule();
      if (g.to) p.onFill(g.to);
      return;
    }
    p.onRelease();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const { x, y } = local(e);
    const p = latest.current;
    const edge = p.readOnly ? null : edgeAt(x, y);
    if (edge) {
      p.onAutoFit(edge.axis, edge.index);
      return;
    }
    const { at, area } = hit(x, y);
    if (area === "cell") p.onDoubleClick(at);
  };

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const { x, y } = local(e);
    const { at, area } = hit(x, y);
    e.preventDefault();
    latest.current.onMenu(e.clientX, e.clientY, at, area);
  };

  /** Hovering an error cell shows what it means; hovering someone's range shows their tag. */
  const hoverAt = (x: number, y: number) => {
    const { at, area } = hit(x, y);
    const p = latest.current;
    const prev = hover.current;
    const next = area === "cell" ? at : null;
    if (prev?.r === next?.r && prev?.c === next?.c) return;
    hover.current = next;
    if (p.tags.length) schedule();
    const tip = tipEl.current;
    clearTimeout(tipTimer.current);
    if (tip) tip.dataset.shown = "false";
    if (!next || !tip) return;
    const cell = p.source.cell(next.r, next.c);
    if (cell?.kind !== "error") return;
    tipTimer.current = setTimeout(() => {
      const { rows, cols } = latest.current.source;
      const b = rangeBox({ r1: next.r, c1: next.c, r2: next.r, c2: next.c }, rows, cols, view());
      tip.textContent = latest.current.errorTip(cell);
      tip.style.transform = `translate(${b.x}px, ${b.y + b.h + 4}px)`;
      tip.dataset.shown = "true";
    }, TIP_DELAY_MS);
  };

  const onPointerLeave = () => {
    hover.current = null;
    clearTimeout(tipTimer.current);
    if (tipEl.current) tipEl.current.dataset.shown = "false";
    if (latest.current.tags.length) schedule();
  };

  const onScroll = () => {
    const el = scroller.current;
    schedule();
    if (!el) return;
    const own = ownScroll.current;
    if (own && Math.abs(el.scrollLeft - own.x) <= 1 && Math.abs(el.scrollTop - own.y) <= 1) {
      ownScroll.current = null;
      return;
    }
    ownScroll.current = null;
    if (!gesture.current) latest.current.onUserScroll();
  };

  return (
    <div className="sheet-grid">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the canvas grid's pointer gestures; its keys go to the cell's field */}
      <div
        ref={scroller}
        className="sheet-grid__scroller"
        tabIndex={-1}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <div ref={sizer} className="sheet-grid__space" />
      </div>
      <canvas ref={canvas} className="sheet-grid__canvas" />
      <div ref={overlay} className="sheet-grid__overlay">
        <div ref={editorHost} className="sheet-grid__editor-host">
          {props.editor}
        </div>
        {props.tags.map((tag) => (
          <div
            key={tag.id}
            ref={(el) => {
              if (el) tagEls.current.set(tag.id, el);
              else tagEls.current.delete(tag.id);
            }}
            className="sheet-grid__tag"
            data-shown="false"
            style={{ "--tag": tag.color } as React.CSSProperties}
          >
            {tag.content}
          </div>
        ))}
        {props.cursors && (
          <div className="sheet-grid__cursors" style={{ left: HEADER_W, top: HEADER_H }}>
            {props.cursors(gridView)}
          </div>
        )}
        <div ref={tipEl} className="sheet-grid__tip" data-shown="false" role="tooltip" />
        <div ref={guide} className="sheet-grid__guide" data-shown="false" aria-hidden="true" />
        {props.moreRows && (
          <div ref={moreEl} className="sheet-grid__more" data-interactive="" data-shown="false">
            {props.moreRows}
          </div>
        )}
      </div>
    </div>
  );
});
