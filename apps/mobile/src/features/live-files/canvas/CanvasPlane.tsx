import { type LiveRoom, useLivePeers } from "@agenteschat/client";
import { LOCAL } from "@agenteschat/live";
import {
  arrowHeadPoints,
  moveShapes,
  resizeShape,
  rotatedBounds,
  routeArrow,
  type ShapeView,
  shapeBounds,
  union,
} from "@agenteschat/live/canvas";
import { Canvas, DashPathEffect, Fill, Group, Path, RoundedRect, Shader, Skia } from "@shopify/react-native-skia";
import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
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
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { reportError } from "@/lib/error-reports";
import { motion, Text, useReducedMotion, useTheme } from "@/ui";
import { Face } from "../../shared/Face";
import { useDirectory } from "../../shared/hooks";
import { LivePointer } from "../shared/LivePointer";
import { usePeerLook } from "../shared/peers";
import { useFilePictures } from "../slides/pictures";
import type { TalkPin } from "../talk/logic";
import {
  arrowLineW,
  boxOnScreen,
  type Cam,
  centerOn,
  clampZoom,
  dotAlpha,
  dotOffset,
  dotSpacing,
  FIT_PAD,
  type Frame,
  fitCam,
  followCam,
  inside,
  laidOutBox,
  onAnyBox,
  onHandle,
  type PeerView,
  type Pt,
  panBy,
  peerViewOf,
  stretchBox,
  toScreen,
  toWorld,
  viewBox,
  viewCenter,
  type WBox,
  zoomAt,
} from "./camera";
import { colorFloats, DOTS_SHADER } from "./dots";
import {
  type ArrowDraw,
  arrowDraws,
  isInk,
  keepsRatio,
  movingIds,
  peerPicks,
  peerPointers,
  STROKE_MAX,
  shapeAt,
  shapesIn,
  stretchable,
} from "./logic";
import { ArrowLabel, FrameName, type Motion, ShapeItem } from "./ShapeItems";

/**
 * A gesture's error, caught on the UI thread: thrown there it closed the app at the first touch. The gesture goes back
 * to rest and the error is reported, with its message, for the next build to fix.
 */
const gestureFailed = (error: unknown) => {
  "worklet";
  scheduleOnRN(reportGestureError, error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
};

function reportGestureError(text: string) {
  console.warn(`canvas gesture failed: ${text}`);
  reportError(new Error(text), { where: "canvas.gesture" });
}

/**
 * A canvas's plane on the phone (ADR 0196 §2, §9): an endless world under a camera (`camera.ts`), panned with a finger
 * (it glides on when let go), zoomed with two from 10% to 400% around them. The dots and the frames are drawn on the UI
 * thread (Skia) for every frame; the shapes are views laid out at the zoom they were last settled at and moved and
 * scaled with the camera, laid out again sharp when the fingers lift, and only those around what the screen shows.
 * Arrows, the selection's outline and everyone else's are drawn over them, at the screen's own line width.
 *
 * A tap picks what is under the finger (again on the picked one: open it, its words or its file); a drag on the picked
 * shape moves it (a frame with what is in it), its round corner stretches it (a picture keeping its shape); a long
 * press asks for its menu (or the plane's). Moving and stretching follow the finger on the UI thread and are written to
 * the file once, when it lifts. Everyone else's pointer glides over the plane with their name.
 *
 * The dock's tools (ADR 0196 §2) change what one finger does: the pen draws (the stroke follows the finger on the UI
 * thread and is written once it lifts), the arrow drags from one place to another, a comment pins where the finger
 * taps (ADR 0199); two fingers still move and zoom. The conversation's comments show as pins (author's face and
 * number), a tap on one opens its message.
 */
/** What one finger does on the plane. */
export type PlaneTool = "select" | "pen" | "arrow" | "comment";

export interface PlaneHandle {
  /** The world point in the middle of what the person sees. */
  center(): Pt;
  /** The world box the screen shows. */
  view(): WBox | null;
  /** Brings a world box into view (fitted when it doesn't fit), gliding there. */
  reveal(box: WBox): void;
  /** Everything on the canvas in view. */
  fitAll(): void;
  /** 100%, around the middle. */
  actualSize(): void;
  /** The zoom now (screen points per world unit). */
  zoom(): number;
  /** Where a world box is on screen now. */
  screenBox(box: WBox): WBox;
}

export interface CanvasPlaneProps {
  room: LiveRoom;
  fileId: string;
  shapes: readonly ShapeView[];
  byId: ReadonlyMap<string, ShapeView>;
  readOnly: boolean;
  selected: readonly string[];
  onSelect: (ids: string[]) => void;
  /** A tap on the one shape already picked: open its words, its file, its page. */
  onOpen: (shape: ShapeView) => void;
  /** A tap on a picture that failed to be made: try again. */
  onRetry: (shape: ShapeView) => void;
  /** A long press on a shape (picked first) or on the plane (`id` null), with where it was, in the world. */
  onHold: (id: string | null, at: Pt) => void;
  /** Someone followed: their view, which this one goes to whenever it changes. */
  follow: PeerView | null;
  /** The person moved the view themselves (following someone stops). */
  onMoved: () => void;
  /** The dock's tool (default: picking). */
  tool?: PlaneTool;
  /** A pen stroke drawn (world x, y pairs), once the finger lifts. */
  onDraw?: (points: number[]) => void;
  /** How the pen draws while the finger is down: its color, its width (world units), the highlighter. */
  pen?: { color: string; width: number; marker: boolean };
  /** An arrow dragged from one place to another (world points), once the finger lifts. */
  onArrow?: (from: Pt, to: Pt) => void;
  /** A tap with the comment tool: where, in the world. */
  onComment?: (at: Pt) => void;
  /** The conversation's comments pinned on the canvas (ADR 0199 §3). */
  pins?: readonly TalkPin[];
  /** A tap on a pin. */
  onPin?: (pin: TalkPin) => void;
  ref?: Ref<PlaneHandle>;
}

/** Compiled once; null if the device refuses it (the plane is then plain). */
let dotsEffect: ReturnType<typeof Skia.RuntimeEffect.Make> | undefined;
function dots() {
  if (dotsEffect === undefined) {
    try {
      dotsEffect = Skia.RuntimeEffect.Make(DOTS_SHADER);
    } catch {
      dotsEffect = null;
    }
  }
  return dotsEffect;
}

/** A glide of the camera (a fit, a reveal, following someone). */
const GLIDE = { duration: motion.panel, easing: motion.easeInOut };
/** After the view settles, this long before the person's presence says where they look. */
const VIEW_AFTER_MS = 150;
const NO_BOX: WBox = { x: 0, y: 0, w: 0, h: 0 };

export function CanvasPlane({
  room,
  fileId,
  shapes,
  byId,
  readOnly,
  selected,
  onSelect,
  onOpen,
  onRetry,
  onHold,
  follow,
  onMoved,
  tool = "select",
  onDraw,
  pen = PEN_PREVIEW,
  onArrow,
  onComment,
  pins = [],
  onPin,
  ref,
}: CanvasPlaneProps) {
  const { t } = useTranslation();
  const { colors: c, scheme } = useTheme();
  const reduced = useReducedMotion();
  const doc = room.doc;
  const picture = useFilePictures(room.orgId, fileId);
  const look = usePeerLook();

  // ── The camera ─────────────────────────────────────────────────────────────────────────────────────────────────
  const cx = useSharedValue(0);
  const cy = useSharedValue(0);
  const cs = useSharedValue(1);
  const frame = useSharedValue<Frame>({ width: 0, height: 0 });
  const [size, setSize] = useState<Frame | null>(null);
  // The zoom the shapes were last laid out at (a pinch scales them, the lift lays them out again).
  const [k, setK] = useState(1);
  // The world box shapes are laid out for: what the screen shows and a screen around it.
  const [region, setRegion] = useState<WBox>({ x: -2000, y: -2000, w: 4000, h: 4000 });
  const regionSv = useSharedValue<WBox>(region);
  const cam = useCallback((): Cam => ({ x: cx.value, y: cy.value, s: cs.value }), [cx, cy, cs]);

  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishView = useCallback(() => {
    if (viewTimer.current) clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(() => {
      const f = frame.value;
      if (f.width > 0 && !room.destroyed) room.setLocal({ view: peerViewOf(cam(), f) });
    }, VIEW_AFTER_MS);
  }, [room, frame, cam]);
  useEffect(
    () => () => {
      if (viewTimer.current) clearTimeout(viewTimer.current);
    },
    [],
  );

  /** The view laid out again at its zoom, around where it is. */
  const settle = useCallback(
    (s: number) => {
      setK(s);
      const f = frame.value;
      if (f.width > 0) {
        const next = laidOutBox(cam(), f);
        regionSv.value = next;
        setRegion(next);
      }
      publishView();
    },
    [frame, cam, regionSv, publishView],
  );

  /** The camera to `to`, gliding (still with reduced motion), laid out again where it lands. */
  const goTo = useCallback(
    (to: Cam) => {
      cancelAnimation(cx);
      cancelAnimation(cy);
      cancelAnimation(cs);
      if (reduced) {
        cx.value = to.x;
        cy.value = to.y;
        cs.value = to.s;
        settle(to.s);
        return;
      }
      cx.value = withTiming(to.x, GLIDE);
      cy.value = withTiming(to.y, GLIDE);
      cs.value = withTiming(to.s, GLIDE, (done) => {
        if (done) scheduleOnRN(settle, to.s);
      });
    },
    [cx, cy, cs, reduced, settle],
  );

  // The first view: everything on the canvas, at most at its real size; an empty canvas around its origin.
  const placed = useRef(false);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const f = { width, height };
    frame.value = f;
    setSize(f);
    if (!placed.current && width > 0) {
      placed.current = true;
      const all = union(shapes.map((s) => shapeBounds(s, byId)));
      const to = all ? fitCam(all, f, FIT_PAD, 1) : centerOn({ x: 0, y: 0 }, f, 1);
      cx.value = to.x;
      cy.value = to.y;
      cs.value = to.s;
      settle(to.s);
    } else settle(cs.value);
  };

  useImperativeHandle(
    ref,
    () => ({
      center: () => viewCenter(cam(), frame.value),
      view: () => (frame.value.width > 0 ? viewBox(cam(), frame.value) : null),
      reveal: (box) => {
        const f = frame.value;
        if (f.width <= 0) return;
        if (inside(box, viewBox(cam(), f))) return;
        goTo(fitCam(box, f, FIT_PAD, Math.max(1, cs.value)));
      },
      fitAll: () => {
        const f = frame.value;
        const all = union(shapes.map((s) => shapeBounds(s, byId)));
        if (f.width > 0) goTo(all ? fitCam(all, f, FIT_PAD, 1) : centerOn({ x: 0, y: 0 }, f, 1));
      },
      actualSize: () => {
        const f = frame.value;
        if (f.width > 0) goTo(centerOn(viewCenter(cam(), f), f, 1));
      },
      zoom: () => cs.value,
      screenBox: (box) => boxOnScreen(box, cam()),
    }),
    [cam, frame, cs, goTo, shapes, byId],
  );

  // Following someone: the view goes where theirs is, whenever it changes.
  const followKey = follow ? `${follow.x}:${follow.y}:${follow.w}:${follow.h}:${follow.zoom}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per change of their view (`followKey`).
  useEffect(() => {
    if (!follow || !size) return;
    goTo(followCam(follow, size));
  }, [followKey, size]);

  // Laid out again whenever the view leaves the box laid out for it (a long pan).
  useAnimatedReaction(
    () => ({ x: cx.value, y: cy.value, s: cs.value, f: frame.value }),
    (now) => {
      if (now.f.width <= 0) return;
      const at = { x: now.x, y: now.y, s: now.s };
      if (inside(viewBox(at, now.f), regionSv.value)) return;
      const next = laidOutBox(at, now.f);
      regionSv.value = next;
      scheduleOnRN(setRegion, next);
    },
  );

  // ── The selection, on the UI thread ────────────────────────────────────────────────────────────────────────────
  const selBoxes = useSharedValue<WBox[]>([]);
  const selUnion = useSharedValue<WBox | null>(null);
  const canStretch = useSharedValue(false);
  const ratio = useSharedValue(false);
  // The one chosen shape's own box: what its corner stretches.
  const oneBox = useSharedValue<WBox>(NO_BOX);
  const one = selected.length === 1 ? byId.get(selected[0] ?? "") : undefined;
  useEffect(() => {
    const boxes = selected.flatMap((id) => {
      const s = byId.get(id);
      return s ? [s.type === "arrow" ? shapeBounds(s, byId) : rotatedBounds(s, s.rot ?? 0)] : [];
    });
    selBoxes.value = boxes;
    selUnion.value = union(boxes);
    canStretch.value = !readOnly && stretchable(one);
    ratio.value = !!one && keepsRatio(one);
    oneBox.value = one ? { x: one.x, y: one.y, w: one.w, h: one.h } : NO_BOX;
  }, [selected, byId, one, readOnly, selBoxes, selUnion, canStretch, ratio, oneBox]);

  // ── Moving and stretching ──────────────────────────────────────────────────────────────────────────────────────
  const moving = useSharedValue<Record<string, true>>({});
  const drag = useSharedValue<Pt>({ x: 0, y: 0 });
  const stretchId = useSharedValue("");
  const stretch = useSharedValue<WBox>(NO_BOX);
  const motionRefs = useMemo<Motion>(() => ({ moving, drag, stretchId, stretch }), [moving, drag, stretchId, stretch]);
  // What is lifted (moved or stretched), for the plane's own drawing of frames.
  const [lifted, setLifted] = useState<ReadonlySet<string>>(new Set());
  const [stretching, setStretching] = useState<string | null>(null);
  const reset = useRef(false);
  const settleMotion = useCallback(() => {
    moving.value = {};
    drag.value = { x: 0, y: 0 };
    stretchId.value = "";
    setLifted(new Set());
    setStretching(null);
  }, [moving, drag, stretchId]);
  // The file changed with the move: the shapes are drawn where they went, and the finger's offset goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: after each new drawing of the shapes.
  useLayoutEffect(() => {
    if (!reset.current) return;
    reset.current = false;
    settleMotion();
  }, [shapes]);
  const later = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleSoon = useCallback(() => {
    reset.current = true;
    if (later.current) clearTimeout(later.current);
    // Nothing changed in the file (or the change was refused): nothing will draw again, so it settles anyway.
    later.current = setTimeout(() => {
      if (!reset.current) return;
      reset.current = false;
      settleMotion();
    }, 120);
  }, [settleMotion]);

  const startMove = useCallback(() => {
    const all = movingIds(selected, shapes);
    const rec: Record<string, true> = {};
    for (const id of all) rec[id] = true;
    moving.value = rec;
    setLifted(all);
  }, [selected, shapes, moving]);
  const startStretch = useCallback(() => {
    const id = selected[0];
    const s = id ? byId.get(id) : undefined;
    if (!s) return;
    // Its box to stretch from was set as the finger landed (`oneBox`), and follows the finger since.
    stretchId.value = s.id;
    setLifted(new Set([s.id]));
    setStretching(s.id);
  }, [selected, byId, stretchId]);
  const endMove = useCallback(
    (dx: number, dy: number) => {
      const s = cs.value;
      if (Math.hypot(dx, dy) * s < 0.5) {
        settleMotion();
        return;
      }
      try {
        moveShapes(doc, selected, dx, dy, LOCAL);
        const box = selUnion.value;
        if (box) {
          const at = { x: Math.round(box.x + box.w / 2 + dx), y: Math.round(box.y + box.h / 2 + dy) };
          room.setLocal({ cursor: { ...at, space: "canvas" } });
        }
      } catch {
        // Refused (the shape went meanwhile): it settles where it was.
      }
      settleSoon();
    },
    [doc, selected, cs, selUnion, room, settleMotion, settleSoon],
  );
  const endStretch = useCallback(
    (box: WBox) => {
      const id = stretchId.value;
      if (!id) return;
      try {
        resizeShape(doc, id, box, LOCAL);
      } catch {
        // Refused: it settles back.
      }
      settleSoon();
    },
    [doc, stretchId, settleSoon],
  );

  // ── What is laid out ───────────────────────────────────────────────────────────────────────────────────────────
  const keep = useMemo(() => new Set<string>([...selected, ...lifted]), [selected, lifted]);
  const visible = useMemo(() => shapesIn(shapes, byId, region, keep), [shapes, byId, region, keep]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const frames = visible.filter((s) => s.type === "frame");
  const items = visible.filter((s) => s.type !== "frame" && s.type !== "arrow");
  const arrows = useMemo(() => arrowDraws(visible, byId), [visible, byId]);
  // An arrow a finger moves (itself or a shape it binds) follows it on the UI thread, straight, until it lands; the
  // others are drawn on their route (a curve, right angles) from the canvas's own geometry, at the zoom laid out.
  const movingArrows = useMemo(() => arrows.filter((a) => liftsArrow(a, lifted)), [arrows, lifted]);
  const routed = useMemo(
    () =>
      routedArrows(
        arrows.filter((a) => !liftsArrow(a, lifted)),
        ARROW_HEAD / k,
      ),
    [arrows, lifted, k],
  );
  const arrowsSv = useSharedValue(movingArrows);
  useEffect(() => {
    arrowsSv.value = movingArrows;
  }, [movingArrows, arrowsSv]);
  const labels = visible.flatMap((s) => {
    if (s.type !== "arrow" || !s.label) return [];
    const a = arrows.find((d) => d.id === s.id);
    if (!a) return [];
    const l = arrowLineW(a.from, a.to);
    return [{ id: s.id, label: s.label, at: { x: (l.x1 + l.x2) / 2, y: (l.y1 + l.y2) / 2 } }];
  });

  // ── Drawing: the pen's stroke and the arrow being dragged, on the UI thread until the finger lifts ──────────────
  const toolSv = useSharedValue<PlaneTool>(tool);
  useEffect(() => {
    toolSv.value = readOnly && (tool === "pen" || tool === "arrow") ? "select" : tool;
  }, [tool, readOnly, toolSv]);
  const ink = useSharedValue<number[]>([]);
  const inking = useSharedValue(false);
  const arrowFrom = useSharedValue<Pt>({ x: 0, y: 0 });
  const arrowTo = useSharedValue<Pt>({ x: 0, y: 0 });
  const drawn = useRef(false);
  const clearInk = useCallback(() => {
    inking.value = false;
    ink.value = [];
  }, [inking, ink]);
  // The stroke written: drawn as a shape now, the finger's copy goes (a moment later when nothing came back).
  // biome-ignore lint/correctness/useExhaustiveDependencies: after each new drawing of the shapes.
  useLayoutEffect(() => {
    if (!drawn.current) return;
    drawn.current = false;
    clearInk();
  }, [shapes]);
  const endDraw = useCallback(
    (points: number[], arrow: boolean) => {
      drawn.current = true;
      setTimeout(() => {
        if (!drawn.current) return;
        drawn.current = false;
        clearInk();
      }, 300);
      if (arrow) {
        const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = points;
        // A drag too short to mean an arrow (on screen) draws none.
        if (Math.hypot(x2 - x1, y2 - y1) * cs.value < 12) return clearInk();
        onArrow?.({ x: x1, y: y1 }, { x: x2, y: y2 });
      } else if (points.length >= 2) onDraw?.(points);
    },
    [onArrow, onDraw, cs, clearInk],
  );

  // ── Gestures ───────────────────────────────────────────────────────────────────────────────────────────────────
  const moved = useCallback(() => onMoved(), [onMoved]);
  const tapped = useCallback(
    (x: number, y: number) => {
      const at = toWorld({ x, y }, cam());
      // A pin under the finger opens its message, whatever the tool.
      const pin = pinAt(pins, { x, y }, cam());
      if (pin) {
        onPin?.(pin);
        return;
      }
      if (tool === "comment") {
        onComment?.(at);
        return;
      }
      if (tool === "pen" || tool === "arrow") return;
      const id = shapeAt(visibleRef.current, byId, at, cs.value);
      const shape = id ? byId.get(id) : undefined;
      room.setLocal({ cursor: { x: Math.round(at.x), y: Math.round(at.y), space: "canvas" } });
      if (!shape) {
        onSelect([]);
        return;
      }
      if (shape.type === "pending" && shape.status === "failed" && !readOnly) {
        onRetry(shape);
        return;
      }
      if (selected.length === 1 && selected[0] === shape.id) {
        onOpen(shape);
        return;
      }
      onSelect([shape.id]);
    },
    [cam, byId, cs, room, onSelect, onRetry, onOpen, selected, readOnly, pins, onPin, tool, onComment],
  );
  const held = useCallback(
    (x: number, y: number) => {
      if (tool !== "select") return;
      const at = toWorld({ x, y }, cam());
      onHold(shapeAt(visibleRef.current, byId, at, cs.value), at);
    },
    [cam, byId, cs, onHold, tool],
  );

  const mode = useSharedValue<"pan" | "move" | "stretch" | "draw" | "arrow">("pan");
  const from = useSharedValue<WBox>(NO_BOX);
  const pan = usePanGesture({
    maxPointers: 2,
    minDistance: 6,
    onBegin: (e) => {
      "worklet";
      try {
        cancelAnimation(cx);
        cancelAnimation(cy);
        const now = { x: cx.value, y: cy.value, s: cs.value };
        const p = { x: e.x, y: e.y };
        const drawing = toolSv.value === "pen" || toolSv.value === "arrow";
        if (drawing && e.numberOfPointers <= 1) {
          // One finger draws with the pen or drags an arrow; two still move the canvas.
          const w = toWorld(p, now);
          mode.value = toolSv.value === "pen" ? "draw" : "arrow";
          inking.value = false;
          ink.value = [w.x, w.y];
          arrowFrom.value = w;
          arrowTo.value = w;
        } else if (drawing) mode.value = "pan";
        else if (e.numberOfPointers <= 1 && canStretch.value && onHandle(p, selUnion.value, now)) {
          mode.value = "stretch";
          from.value = oneBox.value;
          stretch.value = oneBox.value;
        } else if (!readOnly && e.numberOfPointers <= 1 && onAnyBox(p, selBoxes.value, now)) mode.value = "move";
        else mode.value = "pan";
      } catch (error) {
        mode.value = "pan";
        inking.value = false;
        gestureFailed(error);
      }
    },
    onActivate: () => {
      "worklet";
      try {
        if (mode.value === "draw" || mode.value === "arrow") inking.value = true;
        else if (mode.value === "move") scheduleOnRN(startMove);
        else if (mode.value === "stretch") scheduleOnRN(startStretch);
        else scheduleOnRN(moved);
      } catch (error) {
        mode.value = "pan";
        inking.value = false;
        gestureFailed(error);
      }
    },
    onUpdate: (e) => {
      "worklet";
      try {
        const s = cs.value;
        if ((mode.value === "draw" || mode.value === "arrow") && e.numberOfPointers > 1) {
          // A second finger: it was a move of the canvas, never a line.
          mode.value = "pan";
          inking.value = false;
          ink.value = [];
        }
        if (mode.value === "draw") {
          const w = toWorld({ x: e.x, y: e.y }, { x: cx.value, y: cy.value, s });
          ink.modify((points) => {
            "worklet";
            const n = points.length;
            // A point a hair from the last adds nothing (and the stroke has room for so many).
            if (n < STROKE_MAX - 2 && Math.hypot(w.x - (points[n - 2] ?? 0), w.y - (points[n - 1] ?? 0)) * s >= 1.5)
              points.push(w.x, w.y);
            return points;
          });
          return;
        }
        if (mode.value === "arrow") {
          arrowTo.value = toWorld({ x: e.x, y: e.y }, { x: cx.value, y: cy.value, s });
          return;
        }
        if (mode.value === "move") {
          drag.value = { x: drag.value.x + e.changeX / s, y: drag.value.y + e.changeY / s };
          return;
        }
        if (mode.value === "stretch") {
          stretch.value = stretchBox(from.value, e.translationX / s, e.translationY / s, ratio.value, s);
          return;
        }
        const to = panBy({ x: cx.value, y: cy.value, s }, e.changeX, e.changeY);
        cx.value = to.x;
        cy.value = to.y;
      } catch (error) {
        mode.value = "pan";
        inking.value = false;
        gestureFailed(error);
      }
    },
    onDeactivate: (e) => {
      "worklet";
      try {
        if (mode.value === "draw") {
          scheduleOnRN(endDraw, ink.value.slice(), false);
          return;
        }
        if (mode.value === "arrow") {
          const a = arrowFrom.value;
          const b = arrowTo.value;
          scheduleOnRN(endDraw, [a.x, a.y, b.x, b.y], true);
          return;
        }
        if (mode.value === "move") {
          scheduleOnRN(endMove, drag.value.x, drag.value.y);
          return;
        }
        if (mode.value === "stretch") {
          scheduleOnRN(endStretch, stretch.value);
          return;
        }
        // Let go: the plane glides on and slows down.
        const s = cs.value;
        cx.value = withDecay({ velocity: -e.velocityX / s });
        cy.value = withDecay({ velocity: -e.velocityY / s }, (done) => {
          if (done) scheduleOnRN(publishView);
        });
      } catch (error) {
        mode.value = "pan";
        inking.value = false;
        gestureFailed(error);
      }
    },
  });
  const pinchFrom = useSharedValue(1);
  const pinch = usePinchGesture({
    onBegin: () => {
      "worklet";
      try {
        cancelAnimation(cx);
        cancelAnimation(cy);
        cancelAnimation(cs);
        pinchFrom.value = cs.value;
      } catch (error) {
        gestureFailed(error);
      }
    },
    onActivate: () => {
      "worklet";
      try {
        scheduleOnRN(moved);
      } catch (error) {
        gestureFailed(error);
      }
    },
    onUpdate: (e) => {
      "worklet";
      try {
        const to = zoomAt({ x: cx.value, y: cy.value, s: cs.value }, clampZoom(pinchFrom.value * e.scale), {
          x: e.focalX,
          y: e.focalY,
        });
        cx.value = to.x;
        cy.value = to.y;
        cs.value = to.s;
      } catch (error) {
        gestureFailed(error);
      }
    },
    onDeactivate: () => {
      "worklet";
      try {
        scheduleOnRN(settle, cs.value);
      } catch (error) {
        gestureFailed(error);
      }
    },
  });
  const tap = useTapGesture({
    maxDuration: 400,
    maxDistance: 10,
    onDeactivate: (e) => {
      "worklet";
      try {
        if (e.canceled) return;
        scheduleOnRN(tapped, e.x, e.y);
      } catch (error) {
        gestureFailed(error);
      }
    },
  });
  const hold = useLongPressGesture({
    minDuration: 450,
    maxDistance: 10,
    onActivate: (e) => {
      "worklet";
      try {
        scheduleOnRN(held, e.x, e.y);
      } catch (error) {
        gestureFailed(error);
      }
    },
  });
  const gestures = useSimultaneousGestures(pinch, pan, tap, hold);

  // ── Drawing on the UI thread ───────────────────────────────────────────────────────────────────────────────────
  const effect = dots();
  const dotColor = useMemo(() => colorFloats(c.line2), [c.line2]);
  const uniforms = useDerivedValue(() => {
    const now = { x: cx.value, y: cy.value, s: cs.value };
    const spacing = dotSpacing(now.s);
    const off = dotOffset(now, spacing);
    return {
      off: [off.x, off.y],
      spacing,
      r: 0.75,
      color: [dotColor[0], dotColor[1], dotColor[2], dotColor[3] * dotAlpha(now.s)],
    };
  });
  const world = useDerivedValue(() => [
    { translateX: -cx.value * cs.value },
    { translateY: -cy.value * cs.value },
    { scale: cs.value },
  ]);
  const dragged = useDerivedValue(() => [{ translateX: drag.value.x }, { translateY: drag.value.y }]);
  const hair = useDerivedValue(() => 1 / cs.value);
  const line15 = useDerivedValue(() => 1.5 / cs.value);
  const line2 = useDerivedValue(() => 2 / cs.value);
  const arrowPaths = useDerivedValue(() => {
    const solid = Skia.PathBuilder.Make();
    const dashed = Skia.PathBuilder.Make();
    const heads = Skia.PathBuilder.Make();
    const mv = moving.value;
    const d = drag.value;
    const sid = stretchId.value;
    const st = stretch.value;
    const head = ARROW_HEAD / cs.value;
    for (const a of arrowsSv.value) {
      const endOf = (e: (typeof a)["from"]) => {
        if (e.shape && e.shape === sid) return { x: st.x, y: st.y, w: st.w, h: st.h, box: e.box };
        const shifts = e.shape ? !!mv[e.shape] : !!mv[a.id];
        return shifts ? { x: e.x + d.x, y: e.y + d.y, w: e.w, h: e.h, box: e.box } : e;
      };
      const l = arrowLineW(endOf(a.from), endOf(a.to));
      const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
      if (len < 1e-6) continue;
      const ux = (l.x2 - l.x1) / len;
      const uy = (l.y2 - l.y1) / len;
      const path = a.dashed ? dashed : solid;
      const s0 = a.startHead ? head * 0.8 : 0;
      const e0 = a.endHead ? head * 0.8 : 0;
      path.moveTo(l.x1 + ux * s0, l.y1 + uy * s0);
      path.lineTo(l.x2 - ux * e0, l.y2 - uy * e0);
      if (a.endHead) {
        const bx = l.x2 - ux * head;
        const by = l.y2 - uy * head;
        heads.moveTo(l.x2, l.y2);
        heads.lineTo(bx - uy * head * 0.55, by + ux * head * 0.55);
        heads.lineTo(bx + uy * head * 0.55, by - ux * head * 0.55);
        heads.close();
      }
      if (a.startHead) {
        const bx = l.x1 + ux * head;
        const by = l.y1 + uy * head;
        heads.moveTo(l.x1, l.y1);
        heads.lineTo(bx - uy * head * 0.55, by + ux * head * 0.55);
        heads.lineTo(bx + uy * head * 0.55, by - ux * head * 0.55);
        heads.close();
      }
    }
    return { solid: solid.build(), dashed: dashed.build(), heads: heads.build() };
  });
  const solidArrows = useDerivedValue(() => arrowPaths.value.solid);
  const dashedArrows = useDerivedValue(() => arrowPaths.value.dashed);
  const arrowHeads = useDerivedValue(() => arrowPaths.value.heads);
  // The pen's stroke as the finger draws it, and the arrow being dragged (with its head).
  const inkPath = useDerivedValue(() => {
    const p = Skia.PathBuilder.Make();
    const points = ink.value;
    if (!inking.value || points.length < 2) return p.build();
    p.moveTo(points[0] ?? 0, points[1] ?? 0);
    for (let i = 2; i + 1 < points.length; i += 2) p.lineTo(points[i] ?? 0, points[i + 1] ?? 0);
    if (points.length === 2) p.lineTo((points[0] ?? 0) + 0.01, points[1] ?? 0);
    return p.build();
  });
  const draggedArrow = useDerivedValue(() => {
    const p = Skia.PathBuilder.Make();
    if (!inking.value || mode.value !== "arrow") return p.build();
    const a = arrowFrom.value;
    const b = arrowTo.value;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) return p.build();
    const head = ARROW_HEAD / cs.value;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    p.moveTo(a.x, a.y);
    p.lineTo(b.x - ux * head * 0.8, b.y - uy * head * 0.8);
    return p.build();
  });
  const draggedHead = useDerivedValue(() => {
    const p = Skia.PathBuilder.Make();
    if (!inking.value || mode.value !== "arrow") return p.build();
    const a = arrowFrom.value;
    const b = arrowTo.value;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) return p.build();
    const head = ARROW_HEAD / cs.value;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const bx = b.x - ux * head;
    const by = b.y - uy * head;
    p.moveTo(b.x, b.y);
    p.lineTo(bx - uy * head * 0.55, by + ux * head * 0.55);
    p.lineTo(bx + uy * head * 0.55, by - ux * head * 0.55);
    p.close();
    return p.build();
  });
  const selOutline = useDerivedValue(() => {
    const p = Skia.PathBuilder.Make();
    const u = selUnion.value;
    if (!u) return p.build();
    let b = u;
    if (stretchId.value) b = stretch.value;
    else if (Object.keys(moving.value).length > 0) b = { x: u.x + drag.value.x, y: u.y + drag.value.y, w: u.w, h: u.h };
    const pad = 3 / cs.value;
    p.addRect(Skia.XYWHRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad));
    return p.build();
  });
  const handleStyle = useAnimatedStyle(() => {
    const u = selUnion.value;
    if (!u || !canStretch.value) return { opacity: 0, transform: [{ translateX: -100 }, { translateY: -100 }] };
    const b = stretchId.value
      ? stretch.value
      : Object.keys(moving.value).length > 0
        ? { x: u.x + drag.value.x, y: u.y + drag.value.y, w: u.w, h: u.h }
        : u;
    const r = boxOnScreen(b, { x: cx.value, y: cy.value, s: cs.value });
    const pad = 3;
    return {
      opacity: 1,
      transform: [{ translateX: r.x + r.w + pad - HANDLE / 2 }, { translateY: r.y + r.h + pad - HANDLE / 2 }],
    };
  });
  const layer = useAnimatedStyle(() => ({
    transform: [{ translateX: -cx.value * cs.value }, { translateY: -cy.value * cs.value }, { scale: cs.value / k }],
  }));
  const pointerView = useDerivedValue(() => ({ s: cs.value, x: cx.value, y: cy.value, width: 1, height: 1 }));

  // ── Everyone else ──────────────────────────────────────────────────────────────────────────────────────────────
  const peers = useLivePeers(room);
  const picks = peerPicks(peers, byId);
  const pointers = peerPointers(peers);

  const frameColor = (f: ShapeView) => f.fill ?? c.sunken;
  const staticFrames = frames.filter((f) => !lifted.has(f.id));
  const liftedFrames = frames.filter((f) => lifted.has(f.id) && f.id !== stretching);
  const stretchedFrame = stretching ? frames.find((f) => f.id === stretching) : undefined;

  return (
    <GestureDetector gesture={gestures}>
      <View
        style={[styles.fill, { backgroundColor: c.bg }]}
        onLayout={onLayout}
        collapsable={false}
        accessible
        accessibilityRole="image"
        accessibilityLabel={t("live.canvas.count.items", { count: shapes.length })}
      >
        {size ? (
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            {effect ? (
              <Fill>
                <Shader source={effect} uniforms={uniforms} />
              </Fill>
            ) : null}
            <Group transform={world}>
              {staticFrames.map((f) => (
                <FrameRect key={f.id} frame={f} fill={frameColor(f)} edge={c.line2} hair={hair} />
              ))}
              <Group transform={dragged}>
                {liftedFrames.map((f) => (
                  <FrameRect key={f.id} frame={f} fill={frameColor(f)} edge={c.line2} hair={hair} />
                ))}
              </Group>
              {stretchedFrame ? (
                <StretchedFrame box={stretch} fill={frameColor(stretchedFrame)} edge={c.line2} hair={hair} />
              ) : null}
            </Group>
          </Canvas>
        ) : null}

        <Animated.View style={[styles.world, layer]} pointerEvents="none">
          {frames.map((f) => (
            <FrameName key={`name:${f.id}`} shape={f} k={k} motion={motionRefs} />
          ))}
          {items.map((s) => (
            <ShapeItem key={s.id} shape={s} k={k} motion={motionRefs} picture={picture} readOnly={readOnly} />
          ))}
          {labels.map((l) => (
            <ArrowLabel key={`label:${l.id}`} label={l.label} at={l.at} k={k} />
          ))}
        </Animated.View>

        {size ? (
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            <Group transform={world}>
              {routed.paths.map((a) =>
                a.dashed ? (
                  <Path key={a.id} path={a.path} style="stroke" strokeWidth={line2} color={c.ink}>
                    <DashPathEffect intervals={DASHES} />
                  </Path>
                ) : (
                  <Path
                    key={a.id}
                    path={a.path}
                    style="stroke"
                    strokeWidth={line2}
                    strokeCap="round"
                    strokeJoin="round"
                    color={c.ink}
                  />
                ),
              )}
              <Path path={routed.heads} color={c.ink} />
              <Path path={solidArrows} style="stroke" strokeWidth={line2} strokeCap="round" color={c.ink} />
              <Path path={dashedArrows} style="stroke" strokeWidth={line2} color={c.ink}>
                <DashPathEffect intervals={DASHES} />
              </Path>
              <Path path={arrowHeads} color={c.ink} />
              {picks.flatMap(({ peer, ids }) => {
                const tint = look(peer.user).tint;
                return ids.map((id) => {
                  const s = byId.get(id);
                  if (!s) return null;
                  const b = s.type === "arrow" ? shapeBounds(s, byId) : rotatedBounds(s, s.rot ?? 0);
                  return (
                    <RoundedRect
                      key={`${peer.clientId}:${id}`}
                      x={b.x}
                      y={b.y}
                      width={b.w}
                      height={b.h}
                      r={2}
                      style="stroke"
                      strokeWidth={line2}
                      color={tint}
                    />
                  );
                });
              })}
              {selected.length > 0 ? (
                <Path path={selOutline} style="stroke" strokeWidth={line15} color={c.ink} />
              ) : null}
              <Path
                path={inkPath}
                style="stroke"
                strokeWidth={pen.width}
                strokeCap="round"
                strokeJoin="round"
                color={scheme === "dark" && isInk(pen.color) ? c.ink : pen.color}
                opacity={pen.marker ? 0.4 : 1}
              />
              <Path path={draggedArrow} style="stroke" strokeWidth={line2} strokeCap="round" color={c.ink} />
              <Path path={draggedHead} color={c.ink} />
            </Group>
          </Canvas>
        ) : null}

        {pins.map((pin) => (
          <PinMark key={pin.messageId} pin={pin} cx={cx} cy={cy} cs={cs} />
        ))}

        {readOnly ? null : (
          <Animated.View
            pointerEvents="none"
            style={[styles.handle, { backgroundColor: "#ffffff", borderColor: c.ink }, handleStyle]}
          />
        )}

        {pointers.map(({ peer, at }) => {
          const who = look(peer.user);
          return (
            <LivePointer
              key={`pointer:${peer.clientId}`}
              user={peer.user}
              name={who.name}
              tint={who.tint}
              at={at}
              view={pointerView}
            />
          );
        })}
      </View>
    </GestureDetector>
  );
}

/** The selection's corner handle, in points. */
const HANDLE = 12;
/** The pen as it draws until the screen says otherwise: ink, 4 world units. */
const PEN_PREVIEW = { color: "#151514", width: 4, marker: false };
/** An arrow's head on screen, in points. */
const ARROW_HEAD = 12;
/** A comment pin on screen: its height and the most width a tap reaches it by (face, number, padding). */
const PIN_H = 24;
const PIN_W = 48;

/** Whether a finger moves this arrow now: itself, or a shape at one of its ends. */
const liftsArrow = (a: ArrowDraw, lifted: ReadonlySet<string>) =>
  lifted.has(a.id) ||
  (a.from.shape !== null && lifted.has(a.from.shape)) ||
  (a.to.shape !== null && lifted.has(a.to.shape));

/** The resting arrows on their routes (the canvas's `routeArrow`), with their heads `head` world units long. */
function routedArrows(list: readonly ArrowDraw[], head: number) {
  const heads = Skia.PathBuilder.Make();
  const paths: { id: string; dashed: boolean; path: NonNullable<ReturnType<typeof Skia.Path.MakeFromSVGString>> }[] =
    [];
  const addHead = ([tip, a, b]: [Pt, Pt, Pt]) => {
    heads.moveTo(tip.x, tip.y);
    heads.lineTo(a.x, a.y);
    heads.lineTo(b.x, b.y);
    heads.close();
  };
  for (const a of list) {
    const line = arrowLineW(a.from, a.to);
    if (Math.hypot(line.x2 - line.x1, line.y2 - line.y1) < 1e-6) continue;
    const r = routeArrow(line, a.route, { start: a.startHead ? head * 0.8 : 0, end: a.endHead ? head * 0.8 : 0 });
    const path = Skia.Path.MakeFromSVGString(r.d);
    if (path) paths.push({ id: a.id, dashed: a.dashed, path });
    if (a.endHead) addHead(arrowHeadPoints(r.end, r.endDir, head));
    if (a.startHead) addHead(arrowHeadPoints(r.start, { x: -r.startDir.x, y: -r.startDir.y }, head));
  }
  return { paths, heads: heads.build() };
}

/** The pin under a finger at `p` (screen), the newest on top; null for none. */
function pinAt(pins: readonly TalkPin[], p: Pt, cam: { x: number; y: number; s: number }): TalkPin | null {
  for (let i = pins.length - 1; i >= 0; i--) {
    const pin = pins[i];
    if (!pin) continue;
    const at = toScreen(pin.at, cam);
    if (p.x >= at.x - 6 && p.x <= at.x + PIN_W + 6 && p.y >= at.y - PIN_H - 10 && p.y <= at.y + 10) return pin;
  }
  return null;
}

/**
 * A comment pinned on the canvas (ADR 0199): a raised bubble with its author's face and its number, its cut corner on
 * the spot it points at; it rides with the camera on the UI thread at the screen's own size.
 */
function PinMark({
  pin,
  cx,
  cy,
  cs,
}: {
  pin: TalkPin;
  cx: SharedValue<number>;
  cy: SharedValue<number>;
  cs: SharedValue<number>;
}) {
  const { t } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const name = useDirectory().nameOf(pin.author);
  const at = useAnimatedStyle(() => ({
    transform: [
      { translateX: (pin.at.x - cx.value) * cs.value },
      { translateY: (pin.at.y - cy.value) * cs.value - PIN_H },
    ],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      accessible
      accessibilityLabel={t("mobile.live.canvas.pin", { n: pin.n, name })}
      style={[styles.pin, { backgroundColor: c.raised, boxShadow: shadows.e2 }, at]}
    >
      <Face who={pin.author} size={18} live={false} />
      <Text variant="caption" style={styles.pinN}>
        {pin.n}
      </Text>
    </Animated.View>
  );
}
/** A dashed arrow's dashes, in world units. */
const DASHES = [10, 8];

/** A frame on the plane: a rounded box a little sunken, its edge a hairline at any zoom. */
function FrameRect({
  frame,
  fill,
  edge,
  hair,
}: {
  frame: ShapeView;
  fill: string;
  edge: string;
  hair: Readonly<SharedValue<number>>;
}) {
  return (
    <Group>
      <RoundedRect x={frame.x} y={frame.y} width={frame.w} height={frame.h} r={12} color={fill} opacity={0.6} />
      <RoundedRect
        x={frame.x}
        y={frame.y}
        width={frame.w}
        height={frame.h}
        r={12}
        style="stroke"
        strokeWidth={hair}
        color={edge}
      />
    </Group>
  );
}

/** The frame being stretched, following the finger's box on the UI thread. */
function StretchedFrame({
  box,
  fill,
  edge,
  hair,
}: {
  box: Readonly<SharedValue<WBox>>;
  fill: string;
  edge: string;
  hair: Readonly<SharedValue<number>>;
}) {
  const x = useDerivedValue(() => box.value.x);
  const y = useDerivedValue(() => box.value.y);
  const w = useDerivedValue(() => box.value.w);
  const h = useDerivedValue(() => box.value.h);
  return (
    <Group>
      <RoundedRect x={x} y={y} width={w} height={h} r={12} color={fill} opacity={0.6} />
      <RoundedRect x={x} y={y} width={w} height={h} r={12} style="stroke" strokeWidth={hair} color={edge} />
    </Group>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: "hidden" },
  world: { position: "absolute", left: 0, top: 0, width: 0, height: 0, transformOrigin: "left top" },
  handle: { position: "absolute", left: 0, top: 0, width: HANDLE, height: HANDLE, borderRadius: 3, borderWidth: 1.5 },
  pin: {
    position: "absolute",
    left: 0,
    top: 0,
    height: PIN_H,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingLeft: 3,
    paddingRight: 7,
    // Its corners follow the face's, as a picture's pins do (`PicturePins`).
    borderRadius: 8,
    // The corner on the spot it points at, cut as the app's cards are.
    borderBottomLeftRadius: 3,
  },
  pinN: { fontWeight: "700" },
});
