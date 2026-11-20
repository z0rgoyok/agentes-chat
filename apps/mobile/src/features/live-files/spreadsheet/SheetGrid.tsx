import { colName } from "@agenteschat/live/spreadsheet";
import { Canvas, Path, Skia } from "@shopify/react-native-skia";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, PixelRatio, Text as RNText, StyleSheet, type TextStyle, View } from "react-native";
import {
  GestureDetector,
  useLongPressGesture,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDecay,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "@/ui";
import { Face } from "../../shared/Face";
import {
  boxOnScreen,
  clamp,
  clampCamera,
  drawnBox,
  type Frame,
  type GridAxes,
  type GridBox,
  gridSegments,
  HEADER_H,
  hitCell,
  MAX_ZOOM,
  MIN_ZOOM,
  paneOrigin,
  revealCamera,
  rowHeaderWidth,
  sameBox,
  visibleBox,
  zoomCamera,
} from "./grid-view";
import type { GridCellView, GridLayout, GridSource } from "./model";

/**
 * A spreadsheet on the phone (ADR 0196, 0198): a live file's sheet or a workbook read from an upload, drawn the same
 * way. The grid's lines are drawn on the UI thread for every frame of a pan (Skia), the cells' text and looks are views
 * laid over them for the rows and columns on screen only (in whole blocks, so a pan redraws them a few times a second
 * at most), and the column letters and row numbers stay on the edges at their own size at any zoom. Frozen rows and
 * columns stay put while the rest moves under them. A pinch zooms from half to twice the size around the fingers, and
 * the text is laid out again at the new size when the fingers lift, so it reads sharp.
 *
 * A tap selects a cell (a column's letter its column, a row's number its row, the corner everything); dragging the
 * selection's round handle stretches it; a long press asks for the cell's menu. The person's selection is ink (never
 * the agents' blue); everyone else's is a ring in their own color with their face on its corner.
 */

export interface GridSelection {
  /** The active cell. */
  row: number;
  col: number;
  /** The selected block (the active cell inside it). */
  box: GridBox;
}

/** Someone else's selection on this sheet. */
export interface GridPeer {
  key: string;
  box: GridBox;
  tint: string;
  who: { type: "agent" | "person"; id: string };
  editing: boolean;
}

export interface SheetGridProps {
  source: GridSource;
  selection: GridSelection;
  onSelect: (selection: GridSelection) => void;
  /**
   * A cell tapped, before it is selected: true when the screen took the tap (the cell already selected was tapped
   * again to edit it, or a formula being typed takes the cell's reference).
   */
  onTapCell?: (row: number, col: number, again: boolean) => boolean;
  /** A long press on a cell (its menu), after it was selected. */
  onHold?: (row: number, col: number) => void;
  peers?: readonly GridPeer[];
  /** Brings a block into view whenever `n` changes (the cell being edited, someone followed). */
  reveal?: { box: GridBox; n: number } | null;
  /** The person moved the view themselves (following someone stops). */
  onMoved?: () => void;
  /** The active cell is being typed into. */
  editing?: boolean;
}

/** Points the round handle answers to around it. */
const HANDLE_REACH = 26;
const HANDLE = 12;
/** Text inside a cell keeps this far from its sides and its bottom, at 100%. */
const PAD_X = 5;
const PAD_Y = 3;

const px = 1 / PixelRatio.get();
/** A line on whole device pixels, so a hairline never blurs over two. */
const crisp = (v: number) => {
  "worklet";
  return Math.round(v / px) * px + px / 2;
};

export const SheetGrid = memo(function SheetGrid({
  source,
  selection,
  onSelect,
  onTapCell,
  onHold,
  peers = [],
  reveal,
  onMoved,
  editing = false,
}: SheetGridProps) {
  const { colors: c, scheme } = useTheme();
  const layout = source.layout;
  const headerW = rowHeaderWidth(layout.rows);
  const axesNow = useMemo<GridAxes>(
    () => ({
      rowStarts: layout.rowStarts,
      colStarts: layout.colStarts,
      frozenRows: layout.frozenRows,
      frozenCols: layout.frozenCols,
      headerW,
    }),
    [layout.rowStarts, layout.colStarts, layout.frozenRows, layout.frozenCols, headerW],
  );

  const x = useSharedValue(axesNow.colStarts[axesNow.frozenCols] ?? 0);
  const y = useSharedValue(axesNow.rowStarts[axesNow.frozenRows] ?? 0);
  const s = useSharedValue(1);
  const frame = useSharedValue<Frame>({ width: 0, height: 0 });
  const axes = useSharedValue<GridAxes>(axesNow);
  const sel = useSharedValue<GridBox>(selection.box);
  const active = useSharedValue<GridBox>({
    r1: selection.row,
    c1: selection.col,
    r2: selection.row,
    c2: selection.col,
  });
  // The text's layout size: the zoom it was last laid out at (a pinch scales it, the lift lays it out again).
  const [k, setK] = useState(1);
  const [drawn, setDrawn] = useState<GridBox>({ r1: 0, c1: 0, r2: -1, c2: -1 });
  const [width, setWidth] = useState(0);

  // A new shape (rows added, sizes changed): the camera keeps its place within it. Another sheet starts at its top.
  useEffect(() => {
    axes.value = axesNow;
    const at = clampCamera(x.value, y.value, s.value, frame.value, axesNow);
    x.value = at.x;
    y.value = at.y;
  }, [axesNow, axes, x, y, s, frame]);
  useEffect(() => {
    void layout.key;
    cancelAnimation(x);
    cancelAnimation(y);
    x.value = axes.value.colStarts[axes.value.frozenCols] ?? 0;
    y.value = axes.value.rowStarts[axes.value.frozenRows] ?? 0;
  }, [layout.key, axes, x, y]);
  useEffect(() => {
    sel.value = selection.box;
    active.value = { r1: selection.row, c1: selection.col, r2: selection.row, c2: selection.col };
  }, [selection, sel, active]);

  const camera = () => {
    "worklet";
    return { x: x.value, y: y.value, s: s.value };
  };

  // The block of cells to lay out follows the camera, a block at a time.
  useAnimatedReaction(
    () =>
      drawnBox(
        visibleBox(camera(), frame.value, axes.value),
        axes.value.rowStarts.length - 1,
        axes.value.colStarts.length - 1,
        axes.value.frozenRows,
        axes.value.frozenCols,
      ),
    (box, was) => {
      if (!sameBox(box, was)) scheduleOnRN(setDrawn, box);
    },
  );

  // Brought into view: the cell being typed into, the block someone followed is on.
  const revealN = reveal?.n ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per request (`n`), the block as it was asked.
  useEffect(() => {
    if (!reveal) return;
    const at = revealCamera(camera(), reveal.box, frame.value, axes.value);
    cancelAnimation(x);
    cancelAnimation(y);
    x.value = at.x;
    y.value = at.y;
  }, [revealN]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    frame.value = { width: w, height: h };
    const at = clampCamera(x.value, y.value, s.value, frame.value, axes.value);
    x.value = at.x;
    y.value = at.y;
    setWidth(w);
    // The keyboard took room: the cell being typed into stays in view.
    if (editing) {
      const r = revealCamera(camera(), active.value, frame.value, axes.value);
      x.value = r.x;
      y.value = r.y;
    }
  };

  // ── Gestures ───────────────────────────────────────────────────────────────────────────────────────────────────

  const moved = useCallback(() => onMoved?.(), [onMoved]);
  const tapped = useCallback(
    (row: number, col: number) => {
      const rows = layout.rows;
      const cols = layout.cols;
      if (rows <= 0 || cols <= 0) return;
      if (row < 0 && col < 0) {
        onSelect({ row: selection.row, col: selection.col, box: { r1: 0, c1: 0, r2: rows - 1, c2: cols - 1 } });
        return;
      }
      if (row < 0) {
        onSelect({ row: layout.frozenRows, col, box: { r1: 0, c1: col, r2: rows - 1, c2: col } });
        return;
      }
      if (col < 0) {
        onSelect({ row, col: layout.frozenCols, box: { r1: row, c1: 0, r2: row, c2: cols - 1 } });
        return;
      }
      const single = selection.box.r1 === selection.box.r2 && selection.box.c1 === selection.box.c2;
      const again = single && selection.row === row && selection.col === col;
      if (onTapCell?.(row, col, again)) return;
      onSelect({ row, col, box: { r1: row, c1: col, r2: row, c2: col } });
    },
    [layout.rows, layout.cols, layout.frozenRows, layout.frozenCols, selection, onSelect, onTapCell],
  );
  const held = useCallback(
    (row: number, col: number) => {
      if (row < 0 || col < 0) return;
      const inside =
        row >= selection.box.r1 && row <= selection.box.r2 && col >= selection.box.c1 && col <= selection.box.c2;
      if (!inside) onSelect({ row, col, box: { r1: row, c1: col, r2: row, c2: col } });
      onHold?.(row, col);
    },
    [selection, onSelect, onHold],
  );
  const stretched = useCallback(
    (row: number, col: number) => {
      const box = {
        r1: Math.min(selection.row, row),
        c1: Math.min(selection.col, col),
        r2: Math.max(selection.row, row),
        c2: Math.max(selection.col, col),
      };
      if (!sameBox(box, selection.box)) onSelect({ row: selection.row, col: selection.col, box });
    },
    [selection, onSelect],
  );

  // A drag from the selection's handle stretches it; any other drag moves the view.
  const stretching = useSharedValue(false);
  const lastCell = useSharedValue({ row: -1, col: -1 });
  const pan = usePanGesture({
    maxPointers: 2,
    minDistance: 6,
    onBegin: (e) => {
      "worklet";
      cancelAnimation(x);
      cancelAnimation(y);
      const r = boxOnScreen(sel.value, camera(), axes.value);
      stretching.value =
        !!r && r.w > 0 && Math.hypot(e.x - (r.x + r.w), e.y - (r.y + r.h)) <= HANDLE_REACH && e.numberOfPointers <= 1;
      lastCell.value = { row: -1, col: -1 };
    },
    onActivate: () => {
      "worklet";
      if (!stretching.value) scheduleOnRN(moved);
    },
    onUpdate: (e) => {
      "worklet";
      if (stretching.value) {
        const hit = hitCell({ x: e.x, y: e.y }, camera(), axes.value);
        const row = Math.max(0, hit.row);
        const col = Math.max(0, hit.col);
        if (row === lastCell.value.row && col === lastCell.value.col) return;
        lastCell.value = { row, col };
        scheduleOnRN(stretched, row, col);
        return;
      }
      const at = clampCamera(
        x.value - e.changeX / s.value,
        y.value - e.changeY / s.value,
        s.value,
        frame.value,
        axes.value,
      );
      x.value = at.x;
      y.value = at.y;
    },
    onDeactivate: (e) => {
      "worklet";
      if (stretching.value) return;
      // Let go: it glides on and slows down, never past the sheet's edges.
      const low = clampCamera(-1e9, -1e9, s.value, frame.value, axes.value);
      const high = clampCamera(1e9, 1e9, s.value, frame.value, axes.value);
      x.value = withDecay({ velocity: -e.velocityX / s.value, clamp: [low.x, high.x] });
      y.value = withDecay({ velocity: -e.velocityY / s.value, clamp: [low.y, high.y] });
    },
  });
  const pinchFrom = useSharedValue(1);
  const pinch = usePinchGesture({
    onBegin: () => {
      "worklet";
      cancelAnimation(x);
      cancelAnimation(y);
      pinchFrom.value = s.value;
    },
    onActivate: () => {
      "worklet";
      scheduleOnRN(moved);
    },
    onUpdate: (e) => {
      "worklet";
      const next = clamp(pinchFrom.value * e.scale, MIN_ZOOM, MAX_ZOOM);
      const to = zoomCamera(camera(), next, { x: e.focalX, y: e.focalY }, frame.value, axes.value);
      s.value = to.s;
      x.value = to.x;
      y.value = to.y;
    },
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(setK, s.value);
    },
  });
  const tap = useTapGesture({
    maxDuration: 400,
    maxDistance: 10,
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      const hit = hitCell({ x: e.x, y: e.y }, camera(), axes.value);
      scheduleOnRN(tapped, hit.row, hit.col);
    },
  });
  const hold = useLongPressGesture({
    minDuration: 450,
    maxDistance: 10,
    onActivate: (e) => {
      "worklet";
      const hit = hitCell({ x: e.x, y: e.y }, camera(), axes.value);
      scheduleOnRN(held, hit.row, hit.col);
    },
  });
  const gestures = useSimultaneousGestures(pinch, pan, tap, hold);

  // ── Lines ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const lines = useDerivedValue(() => {
    const seg = gridSegments(camera(), frame.value, axes.value);
    const path = Skia.PathBuilder.Make();
    for (let i = 0; i + 3 < seg.length; i += 4) {
      const vertical = seg[i] === seg[i + 2];
      const x1 = vertical ? crisp(seg[i] ?? 0) : (seg[i] ?? 0);
      const y1 = vertical ? (seg[i + 1] ?? 0) : crisp(seg[i + 1] ?? 0);
      const x2 = vertical ? x1 : (seg[i + 2] ?? 0);
      const y2 = vertical ? (seg[i + 3] ?? 0) : y1;
      path.moveTo(x1, y1);
      path.lineTo(x2, y2);
    }
    return path.build();
  });
  // The edges of the frozen part, heavier, where it meets what scrolls.
  const frozenEdges = useDerivedValue(() => {
    const a = axes.value;
    const o = paneOrigin(a, s.value);
    const f = frame.value;
    const path = Skia.PathBuilder.Make();
    if (a.frozenCols > 0) {
      path.moveTo(o.x, 0);
      path.lineTo(o.x, f.height);
    }
    if (a.frozenRows > 0) {
      path.moveTo(0, o.y);
      path.lineTo(f.width, o.y);
    }
    return path.build();
  });
  const headerEdges = useDerivedValue(() => {
    const f = frame.value;
    const path = Skia.PathBuilder.Make();
    path.moveTo(0, crisp(HEADER_H));
    path.lineTo(f.width, crisp(HEADER_H));
    path.moveTo(crisp(axes.value.headerW), 0);
    path.lineTo(crisp(axes.value.headerW), f.height);
    return path.build();
  });

  // ── Layers ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const quadrants = useMemo(() => {
    const fr = layout.frozenRows;
    const fc = layout.frozenCols;
    const rows = drawn.r2 >= drawn.r1 ? { r1: Math.max(drawn.r1, fr), r2: drawn.r2 } : null;
    const cols = drawn.c2 >= drawn.c1 ? { c1: Math.max(drawn.c1, fc), c2: drawn.c2 } : null;
    const box = (r: { r1: number; r2: number } | null, cc: { c1: number; c2: number } | null) =>
      r && cc && r.r2 >= r.r1 && cc.c2 >= cc.c1 ? { r1: r.r1, r2: r.r2, c1: cc.c1, c2: cc.c2 } : null;
    const frozenRows = fr > 0 ? { r1: 0, r2: fr - 1 } : null;
    const frozenCols = fc > 0 ? { c1: 0, c2: fc - 1 } : null;
    return {
      main: box(rows, cols),
      top: box(frozenRows, cols),
      left: box(rows, frozenCols),
      corner: box(frozenRows, frozenCols),
    };
  }, [drawn, layout.frozenRows, layout.frozenCols]);
  const cellsOf = (box: GridBox | null) => (box ? source.cells(box) : []);

  const mainClip = useAnimatedStyle(() => {
    const o = paneOrigin(axes.value, s.value);
    return { left: o.x, top: o.y, right: 0, bottom: 0 };
  });
  const topClip = useAnimatedStyle(() => {
    const o = paneOrigin(axes.value, s.value);
    return { left: o.x, top: HEADER_H, right: 0, height: o.y - HEADER_H };
  });
  const leftClip = useAnimatedStyle(() => {
    const o = paneOrigin(axes.value, s.value);
    return { left: axes.value.headerW, top: o.y, bottom: 0, width: o.x - axes.value.headerW };
  });
  const cornerClip = useAnimatedStyle(() => {
    const o = paneOrigin(axes.value, s.value);
    return { left: axes.value.headerW, top: HEADER_H, width: o.x - axes.value.headerW, height: o.y - HEADER_H };
  });
  // Inside each clip the cells sit at their grid places (laid out at `k`), moved and scaled to the camera.
  const moveBoth = useAnimatedStyle(() => ({
    transform: [{ translateX: -x.value * s.value }, { translateY: -y.value * s.value }, { scale: s.value / k }],
  }));
  const moveX = useAnimatedStyle(() => ({
    transform: [{ translateX: -x.value * s.value }, { translateY: 0 }, { scale: s.value / k }],
  }));
  const moveY = useAnimatedStyle(() => ({
    transform: [{ translateX: 0 }, { translateY: -y.value * s.value }, { scale: s.value / k }],
  }));
  const still = useAnimatedStyle(() => ({ transform: [{ scale: s.value / k }] }));

  // The headers' labels: their row moves and stretches with the camera, each label keeps its own size.
  const colLabels = useAnimatedStyle(() => {
    const o = paneOrigin(axes.value, s.value);
    return { transform: [{ translateX: o.x - axes.value.headerW - x.value * s.value }, { scaleX: s.value / k }] };
  });
  const frozenColLabels = useAnimatedStyle(() => ({ transform: [{ scaleX: s.value / k }] }));
  const rowLabels = useAnimatedStyle(() => {
    const o = paneOrigin(axes.value, s.value);
    return { transform: [{ translateY: o.y - HEADER_H - y.value * s.value }, { scaleY: s.value / k }] };
  });
  const frozenRowLabels = useAnimatedStyle(() => ({ transform: [{ scaleY: s.value / k }] }));
  const keepWidth = useAnimatedStyle((): TextStyle => ({ transform: [{ scaleX: k / s.value }] }));
  const keepHeight = useAnimatedStyle((): TextStyle => ({ transform: [{ scaleY: k / s.value }] }));
  const colScroll = useAnimatedStyle(() => ({
    left: paneOrigin(axes.value, s.value).x - axes.value.headerW,
  }));
  const rowScroll = useAnimatedStyle(() => ({ top: paneOrigin(axes.value, s.value).y - HEADER_H }));
  const frozenColsW = useAnimatedStyle(() => ({ width: paneOrigin(axes.value, s.value).x - axes.value.headerW }));
  const frozenRowsH = useAnimatedStyle(() => ({ height: paneOrigin(axes.value, s.value).y - HEADER_H }));

  // ── The selection ──────────────────────────────────────────────────────────────────────────────────────────────

  const dark = scheme === "dark";
  const rangeFill = dark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";
  const many = !sameBox(selection.box, {
    r1: selection.row,
    c1: selection.col,
    r2: selection.row,
    c2: selection.col,
  });
  const rangeStyle = useAnimatedStyle(() => boxStyle(boxOnScreen(sel.value, camera(), axes.value)));
  const activeStyle = useAnimatedStyle(() => boxStyle(boxOnScreen(active.value, camera(), axes.value)));
  const handleStyle = useAnimatedStyle(() => {
    const r = boxOnScreen(sel.value, camera(), axes.value);
    if (!r || r.w <= 0 || r.h <= 0) return { opacity: 0, transform: [{ translateX: -100 }, { translateY: -100 }] };
    return {
      opacity: 1,
      transform: [{ translateX: r.x + r.w - HANDLE / 2 }, { translateY: r.y + r.h - HANDLE / 2 }],
    };
  });
  const colMark = useAnimatedStyle(() => {
    const b = sel.value;
    const r = boxOnScreen(
      { r1: axes.value.frozenRows, c1: b.c1, r2: axes.value.frozenRows, c2: b.c2 },
      camera(),
      axes.value,
    );
    return r && r.w > 0 ? { opacity: 1, left: r.x, width: r.w } : { opacity: 0, left: 0, width: 0 };
  });
  const rowMark = useAnimatedStyle(() => {
    const b = sel.value;
    const r = boxOnScreen(
      { r1: b.r1, c1: axes.value.frozenCols, r2: b.r2, c2: axes.value.frozenCols },
      camera(),
      axes.value,
    );
    return r && r.h > 0 ? { opacity: 1, top: r.y, height: r.h } : { opacity: 0, top: 0, height: 0 };
  });

  const colRange = useMemo(() => {
    const fc = layout.frozenCols;
    const list: number[] = [];
    for (let col = Math.max(drawn.c1, fc); col <= drawn.c2; col++) list.push(col);
    return list;
  }, [drawn.c1, drawn.c2, layout.frozenCols]);
  const rowRange = useMemo(() => {
    const fr = layout.frozenRows;
    const list: number[] = [];
    for (let row = Math.max(drawn.r1, fr); row <= drawn.r2; row++) list.push(row);
    return list;
  }, [drawn.r1, drawn.r2, layout.frozenRows]);
  const selCols = { from: selection.box.c1, to: selection.box.c2 };
  const selRows = { from: selection.box.r1, to: selection.box.r2 };

  return (
    <GestureDetector gesture={gestures}>
      <View style={[styles.fill, { backgroundColor: c.bg }]} onLayout={onLayout} collapsable={false}>
        {/* The headers' strips, under the lines. */}
        <View style={[styles.colStrip, { left: headerW, backgroundColor: c.sunken }]} />
        <View style={[styles.rowStrip, { width: headerW, backgroundColor: c.sunken }]} />
        <Animated.View style={[styles.colMark, { backgroundColor: rangeFill }, colMark]} />
        <Animated.View style={[styles.rowMark, { width: headerW, backgroundColor: rangeFill }, rowMark]} />

        {width > 0 ? (
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            <Path path={lines} style="stroke" strokeWidth={px} color={c.line2} />
            <Path path={headerEdges} style="stroke" strokeWidth={px} color={c.line2} />
            <Path path={frozenEdges} style="stroke" strokeWidth={2} color={c.line2} />
          </Canvas>
        ) : null}

        {/* The cells, in four parts: what scrolls both ways, the frozen rows, the frozen columns, their corner. */}
        <Animated.View style={[styles.clip, mainClip]} pointerEvents="none">
          <Animated.View style={[styles.world, moveBoth]}>
            <Cells views={cellsOf(quadrants.main)} layout={layout} k={k} />
          </Animated.View>
        </Animated.View>
        {layout.frozenRows > 0 ? (
          <Animated.View style={[styles.clip, topClip, { backgroundColor: c.bg }]} pointerEvents="none">
            <Animated.View style={[styles.world, moveX]}>
              <Cells views={cellsOf(quadrants.top)} layout={layout} k={k} />
            </Animated.View>
          </Animated.View>
        ) : null}
        {layout.frozenCols > 0 ? (
          <Animated.View style={[styles.clip, leftClip, { backgroundColor: c.bg }]} pointerEvents="none">
            <Animated.View style={[styles.world, moveY]}>
              <Cells views={cellsOf(quadrants.left)} layout={layout} k={k} />
            </Animated.View>
          </Animated.View>
        ) : null}
        {layout.frozenRows > 0 && layout.frozenCols > 0 ? (
          <Animated.View style={[styles.clip, cornerClip, { backgroundColor: c.bg }]} pointerEvents="none">
            <Animated.View style={[styles.world, still]}>
              <Cells views={cellsOf(quadrants.corner)} layout={layout} k={k} />
            </Animated.View>
          </Animated.View>
        ) : null}

        {/* Column letters and row numbers, at their own size. */}
        <View style={[styles.colLabels, { left: headerW }]} pointerEvents="none">
          {layout.frozenCols > 0 ? (
            <Animated.View style={[styles.clip, styles.colFrozen, frozenColsW]}>
              <Animated.View style={[styles.world, frozenColLabels]}>
                {Array.from({ length: layout.frozenCols }, (_, col) => (
                  <ColLabel
                    // biome-ignore lint/suspicious/noArrayIndexKey: a column's place is the column
                    key={col}
                    col={col}
                    layout={layout}
                    k={k}
                    keep={keepWidth}
                    on={col >= selCols.from && col <= selCols.to}
                  />
                ))}
              </Animated.View>
            </Animated.View>
          ) : null}
          <Animated.View style={[styles.clip, styles.colScroll, colScroll]}>
            <Animated.View style={[styles.world, colLabels]}>
              {colRange.map((col) => (
                <ColLabel
                  key={col}
                  col={col}
                  layout={layout}
                  k={k}
                  keep={keepWidth}
                  on={col >= selCols.from && col <= selCols.to}
                  offset={layout.colStarts[layout.frozenCols] ?? 0}
                />
              ))}
            </Animated.View>
          </Animated.View>
        </View>
        <View style={[styles.rowLabels, { width: headerW }]} pointerEvents="none">
          {layout.frozenRows > 0 ? (
            <Animated.View style={[styles.clip, styles.rowFrozen, frozenRowsH]}>
              <Animated.View style={[styles.world, frozenRowLabels]}>
                {Array.from({ length: layout.frozenRows }, (_, row) => (
                  <RowLabel
                    // biome-ignore lint/suspicious/noArrayIndexKey: a row's place is the row
                    key={row}
                    row={row}
                    layout={layout}
                    k={k}
                    keep={keepHeight}
                    on={row >= selRows.from && row <= selRows.to}
                  />
                ))}
              </Animated.View>
            </Animated.View>
          ) : null}
          <Animated.View style={[styles.clip, styles.rowScroll, rowScroll]}>
            <Animated.View style={[styles.world, rowLabels]}>
              {rowRange.map((row) => (
                <RowLabel
                  key={row}
                  row={row}
                  layout={layout}
                  k={k}
                  keep={keepHeight}
                  on={row >= selRows.from && row <= selRows.to}
                  offset={layout.rowStarts[layout.frozenRows] ?? 0}
                />
              ))}
            </Animated.View>
          </Animated.View>
        </View>
        <View style={[styles.corner, { width: headerW, backgroundColor: c.sunken, borderColor: c.line2 }]} />

        {/* Everyone else's selections, then the person's own on top. */}
        {peers.map((p) => (
          <PeerRing key={p.key} peer={p} x={x} y={y} s={s} axes={axes} />
        ))}
        {many ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.box, { backgroundColor: rangeFill, borderColor: c.ink, borderWidth: 1 }, rangeStyle]}
          />
        ) : null}
        <Animated.View
          pointerEvents="none"
          style={[styles.box, { borderColor: c.ink, borderWidth: editing ? 2.5 : 2 }, activeStyle]}
        />
        <Animated.View
          pointerEvents="none"
          style={[styles.handle, { backgroundColor: c.bg, borderColor: c.ink }, handleStyle]}
        />
      </View>
    </GestureDetector>
  );
});

/** A box's place on screen, hidden while it is off the view. */
function boxStyle(r: { x: number; y: number; w: number; h: number } | null) {
  "worklet";
  if (!r || r.w <= 0 || r.h <= 0) return { opacity: 0, left: 0, top: 0, width: 0, height: 0 };
  return { opacity: 1, left: r.x, top: r.y, width: r.w, height: r.h };
}

/** Someone else's selection: a ring in their color, their face on its top right corner. */
const PeerRing = memo(function PeerRing({
  peer,
  x,
  y,
  s,
  axes,
}: {
  peer: GridPeer;
  x: SharedValue<number>;
  y: SharedValue<number>;
  s: SharedValue<number>;
  axes: SharedValue<GridAxes>;
}) {
  const box = peer.box;
  const ring = useAnimatedStyle(() => boxStyle(boxOnScreen(box, { x: x.value, y: y.value, s: s.value }, axes.value)));
  const tag = useAnimatedStyle(() => {
    const r = boxOnScreen(box, { x: x.value, y: y.value, s: s.value }, axes.value);
    if (!r || r.w <= 0 || r.h <= 0) return { opacity: 0, transform: [{ translateX: -100 }, { translateY: -100 }] };
    return { opacity: 1, transform: [{ translateX: r.x + r.w - 9 }, { translateY: r.y - 9 }] };
  });
  // An agent writing washes its cells in its color.
  const wash = peer.who.type === "agent" && peer.editing ? `${peer.tint}1f` : undefined;
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={[styles.box, { borderColor: peer.tint, borderWidth: 2, backgroundColor: wash }, ring]}
      />
      <Animated.View pointerEvents="none" style={[styles.tag, { borderColor: peer.tint }, tag]}>
        <Face who={peer.who} size={14} live={false} />
      </Animated.View>
    </>
  );
});

/** The cells of one part of the grid, at their grid places laid out at `k`. */
const Cells = memo(function Cells({ views, layout, k }: { views: GridCellView[]; layout: GridLayout; k: number }) {
  return (
    <>
      {views.map((v) => (
        <CellView
          key={`${v.r}:${v.c}`}
          view={v}
          sig={cellSig(v)}
          k={k}
          left={(layout.colStarts[v.c] ?? 0) * k}
          top={(layout.rowStarts[v.r] ?? 0) * k}
          width={((layout.colStarts[v.c + v.cols] ?? 0) - (layout.colStarts[v.c] ?? 0)) * k}
          height={((layout.rowStarts[v.r + v.rows] ?? 0) - (layout.rowStarts[v.r] ?? 0)) * k}
        />
      ))}
    </>
  );
});

/** What makes a cell look different: it redraws only when one of these changed. */
const cellSig = (v: GridCellView) =>
  [
    v.text,
    v.align,
    v.valign,
    v.color,
    v.bg,
    v.bold,
    v.italic,
    v.underline,
    v.strike,
    v.wrap,
    v.size,
    v.spill,
    v.rows,
    v.cols,
    v.error?.code,
    v.borders ? JSON.stringify(v.borders) : "",
  ].join("|");

const CellView = memo(
  function CellView({
    view: v,
    k,
    left,
    top,
    width,
    height,
  }: {
    view: GridCellView;
    sig: string;
    k: number;
    left: number;
    top: number;
    width: number;
    height: number;
  }) {
    const { colors: c } = useTheme();
    const merged = v.rows > 1 || v.cols > 1;
    const bd = v.borders;
    const side = (b: { w: number; c?: string } | undefined) => (b ? { w: b.w * k, c: b.c ?? c.ink } : null);
    const t = side(bd?.t);
    const r = side(bd?.r);
    const b = side(bd?.b);
    const l = side(bd?.l);
    return (
      <>
        {v.bg || merged || bd ? (
          <View
            style={[
              styles.cell,
              { left, top, width, height, backgroundColor: v.bg ?? (merged ? c.bg : undefined) },
              t && { borderTopWidth: t.w, borderTopColor: t.c },
              r && { borderRightWidth: r.w, borderRightColor: r.c },
              b && { borderBottomWidth: b.w, borderBottomColor: b.c },
              l && { borderLeftWidth: l.w, borderLeftColor: l.c },
            ]}
          />
        ) : null}
        {v.text ? (
          <View
            style={[
              styles.cell,
              styles.textBox,
              {
                left,
                top,
                width: width + v.spill * k,
                height,
                paddingHorizontal: PAD_X * k,
                paddingVertical: PAD_Y * k,
                justifyContent: v.valign === "t" ? "flex-start" : v.valign === "m" ? "center" : "flex-end",
              },
            ]}
          >
            <RNText
              allowFontScaling={false}
              numberOfLines={v.wrap ? 0 : 1}
              ellipsizeMode="clip"
              style={[
                styles.text,
                {
                  fontSize: v.size * k,
                  lineHeight: Math.round(v.size * 1.25 * k),
                  color: v.error ? c.danger : (v.color ?? c.ink),
                  textAlign: v.align === "r" ? "right" : v.align === "c" ? "center" : "left",
                  width: v.spill > 0 ? undefined : "100%",
                },
                v.bold && styles.bold,
                v.italic && styles.italic,
                (v.underline || v.strike) && {
                  textDecorationLine:
                    v.underline && v.strike ? "underline line-through" : v.underline ? "underline" : "line-through",
                },
              ]}
            >
              {v.text}
            </RNText>
          </View>
        ) : null}
      </>
    );
  },
  (a, b) =>
    a.sig === b.sig &&
    a.k === b.k &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height,
);

/** A label's own scale against the zoom, so it keeps its size while its header stretches. */
type LabelKeep = ReturnType<typeof useAnimatedStyle<TextStyle>>;

/** A column's letter in its header; ink and bold while the selection covers it. */
const ColLabel = memo(function ColLabel({
  col,
  layout,
  k,
  keep,
  on,
  offset = 0,
}: {
  col: number;
  layout: GridLayout;
  k: number;
  keep: LabelKeep;
  on: boolean;
  /** Where the scrolling labels' row starts (the frozen columns' width), in grid units. */
  offset?: number;
}) {
  const { colors: c } = useTheme();
  const start = layout.colStarts[col] ?? 0;
  const end = layout.colStarts[col + 1] ?? start;
  return (
    <View style={[styles.colLabel, { left: (start - offset) * k, width: (end - start) * k }]}>
      <Animated.Text
        allowFontScaling={false}
        numberOfLines={1}
        style={[styles.label, { color: on ? c.ink : c.muted }, on && styles.bold, keep]}
      >
        {colName(col)}
      </Animated.Text>
    </View>
  );
});

/** A row's number in its header. */
const RowLabel = memo(function RowLabel({
  row,
  layout,
  k,
  keep,
  on,
  offset = 0,
}: {
  row: number;
  layout: GridLayout;
  k: number;
  keep: LabelKeep;
  on: boolean;
  offset?: number;
}) {
  const { colors: c } = useTheme();
  const start = layout.rowStarts[row] ?? 0;
  const end = layout.rowStarts[row + 1] ?? start;
  return (
    <View style={[styles.rowLabel, { top: (start - offset) * k, height: (end - start) * k }]}>
      <Animated.Text
        allowFontScaling={false}
        numberOfLines={1}
        style={[styles.label, { color: on ? c.ink : c.muted }, on && styles.bold, keep]}
      >
        {String(row + 1)}
      </Animated.Text>
    </View>
  );
});

/** The grid's lines while a sheet opens: its shape, never a spinner alone. */
export function GridBones() {
  const { colors: c } = useTheme();
  const { t } = useTranslation();
  return (
    <View
      style={[styles.fill, { backgroundColor: c.bg }]}
      accessible
      accessibilityLabel={t("mobile.common.loading")}
      accessibilityState={{ busy: true }}
    >
      <View style={[styles.bonesHead, { backgroundColor: c.sunken, borderColor: c.line2 }]} />
      {Array.from({ length: 24 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
        <View key={i} style={[styles.bonesRow, { borderColor: c.line2 }]}>
          <View style={[styles.bonesNum, { backgroundColor: c.sunken, borderColor: c.line2 }]} />
          {[0, 1, 2, 3].map((col) => (
            <View key={col} style={[styles.bonesCell, { borderColor: c.line2 }]} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: "hidden" },
  colStrip: { position: "absolute", top: 0, right: 0, height: HEADER_H },
  rowStrip: { position: "absolute", left: 0, top: HEADER_H, bottom: 0 },
  colMark: { position: "absolute", top: 0, height: HEADER_H },
  rowMark: { position: "absolute", left: 0 },
  clip: { position: "absolute", overflow: "hidden" },
  world: { position: "absolute", left: 0, top: 0, width: 0, height: 0, transformOrigin: "left top" },
  cell: { position: "absolute" },
  textBox: { overflow: "hidden" },
  text: { fontVariant: ["tabular-nums"] },
  bold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
  colLabels: { position: "absolute", top: 0, right: 0, height: HEADER_H, overflow: "hidden" },
  colFrozen: { left: 0, top: 0, bottom: 0 },
  colScroll: { top: 0, bottom: 0, right: 0 },
  rowLabels: { position: "absolute", left: 0, top: HEADER_H, bottom: 0, overflow: "hidden" },
  rowFrozen: { left: 0, top: 0, right: 0 },
  rowScroll: { left: 0, right: 0, bottom: 0 },
  colLabel: { position: "absolute", top: 0, height: HEADER_H, alignItems: "center", justifyContent: "center" },
  rowLabel: { position: "absolute", left: 0, right: 0, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 12, fontVariant: ["tabular-nums"] },
  corner: {
    position: "absolute",
    left: 0,
    top: 0,
    height: HEADER_H,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  box: { position: "absolute" },
  handle: {
    position: "absolute",
    left: 0,
    top: 0,
    width: HANDLE,
    height: HANDLE,
    borderRadius: HANDLE / 2,
    borderWidth: 2,
  },
  tag: {
    position: "absolute",
    left: 0,
    top: 0,
    borderWidth: 2,
    borderRadius: 6,
    overflow: "hidden",
  },
  bonesHead: { height: HEADER_H, borderBottomWidth: StyleSheet.hairlineWidth },
  bonesRow: { flexDirection: "row", height: 24, borderBottomWidth: StyleSheet.hairlineWidth },
  bonesNum: { width: 36, borderRightWidth: StyleSheet.hairlineWidth },
  bonesCell: { width: 100, borderRightWidth: StyleSheet.hairlineWidth },
});
