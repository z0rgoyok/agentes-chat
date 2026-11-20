import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { type SharedValue, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Glass, PressScale, SCREEN_X, Text, useTheme } from "@/ui";
import type { WBox } from "./camera";
import { type CropRect, clampCrop, MIN_CROP } from "./logic";

/** A corner's handle: what shows, and the finger's reach around it. */
const HANDLE = 14;
const REACH = 44;

type Edge = "l" | "t" | "r" | "b";

/**
 * Cropping a picture on the canvas (ADR 0196 §2): the picture as it shows (`box`, on screen), the part to keep framed
 * by four corner handles inside it (a drag in the frame moves it), the rest dimmed; Apply keeps that part (as fractions
 * of what shows, `onApply`), Cancel leaves the picture as it was. The frame follows the finger on the UI thread; the
 * picture changes once, on Apply. It covers the canvas meanwhile, so nothing else moves.
 */
export function CropOverlay({
  box,
  onApply,
  onCancel,
}: {
  box: WBox;
  onApply: (part: CropRect) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const l = useSharedValue(box.x);
  const top = useSharedValue(box.y);
  const r = useSharedValue(box.x + box.w);
  const b = useSharedValue(box.y + box.h);
  const apply = () =>
    onApply(
      clampCrop({
        x: (l.value - box.x) / box.w,
        y: (top.value - box.y) / box.h,
        w: (r.value - l.value) / box.w,
        h: (b.value - top.value) / box.h,
      }),
    );
  // The dimmed rest: above, below, and either side of the frame.
  const above = useAnimatedStyle(() => ({ height: Math.max(0, top.value) }));
  const below = useAnimatedStyle(() => ({ top: b.value }));
  const left = useAnimatedStyle(() => ({ top: top.value, height: b.value - top.value, width: Math.max(0, l.value) }));
  const right = useAnimatedStyle(() => ({ top: top.value, height: b.value - top.value, left: r.value }));
  const dim = { backgroundColor: "rgba(0, 0, 0, 0.45)" };
  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[styles.dimTop, dim, above]} />
      <Animated.View style={[styles.dimBottom, dim, below]} />
      <Animated.View style={[styles.dimSide, dim, left]} />
      <Animated.View style={[styles.dimRight, dim, right]} />
      <MoveFrame l={l} t={top} r={r} b={b} box={box} />
      <Corner x="l" y="t" edges={{ l, t: top, r, b }} box={box} />
      <Corner x="r" y="t" edges={{ l, t: top, r, b }} box={box} />
      <Corner x="l" y="b" edges={{ l, t: top, r, b }} box={box} />
      <Corner x="r" y="b" edges={{ l, t: top, r, b }} box={box} />
      <View style={styles.barAt} pointerEvents="box-none">
        <View style={Platform.OS === "android" ? { borderRadius: 16, boxShadow: shadows.e2 } : undefined}>
          <Glass liquid interactive={false} intensity={70} style={[styles.bar, { borderColor: c.line2 }]}>
            <Text variant="subhead" style={styles.title} numberOfLines={1}>
              {t("live.canvas.crop.label")}
            </Text>
            <PressScale
              haptic={false}
              onPress={onCancel}
              accessibilityRole="button"
              style={styles.button}
              contentStyle={styles.buttonIn}
            >
              <Text variant="subhead" tone="muted">
                {t("live.canvas.crop.cancel")}
              </Text>
            </PressScale>
            <PressScale
              haptic={false}
              onPress={apply}
              accessibilityRole="button"
              style={[styles.button, { backgroundColor: c.ink }]}
              contentStyle={styles.buttonIn}
            >
              <Text variant="subhead" style={[styles.strong, { color: c.bg }]}>
                {t("live.canvas.crop.apply")}
              </Text>
            </PressScale>
          </Glass>
        </View>
      </View>
    </View>
  );
}

/** The frame: its edge, and a drag inside it moves it whole within the picture. */
function MoveFrame({
  l,
  t,
  r,
  b,
  box,
}: {
  l: SharedValue<number>;
  t: SharedValue<number>;
  r: SharedValue<number>;
  b: SharedValue<number>;
  box: WBox;
}) {
  const from = useSharedValue({ l: 0, t: 0, r: 0, b: 0 });
  const style = useAnimatedStyle(() => ({
    left: l.value,
    top: t.value,
    width: r.value - l.value,
    height: b.value - t.value,
  }));
  const pan = usePanGesture({
    minDistance: 2,
    onBegin: () => {
      "worklet";
      from.value = { l: l.value, t: t.value, r: r.value, b: b.value };
    },
    onUpdate: (e) => {
      "worklet";
      const f = from.value;
      const dx = Math.min(Math.max(e.translationX, box.x - f.l), box.x + box.w - f.r);
      const dy = Math.min(Math.max(e.translationY, box.y - f.t), box.y + box.h - f.b);
      l.value = f.l + dx;
      r.value = f.r + dx;
      t.value = f.t + dy;
      b.value = f.b + dy;
    },
  });
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.frame, style]} />
    </GestureDetector>
  );
}

/** A corner's handle: it moves its two edges, never past the picture's or closer than `MIN_CROP` to the others. */
function Corner({
  x,
  y,
  edges,
  box,
}: {
  x: Extract<Edge, "l" | "r">;
  y: Extract<Edge, "t" | "b">;
  edges: Record<Edge, SharedValue<number>>;
  box: WBox;
}) {
  const from = useSharedValue({ x: 0, y: 0 });
  const pan = usePanGesture({
    minDistance: 0,
    onBegin: () => {
      "worklet";
      from.value = { x: edges[x].value, y: edges[y].value };
    },
    onUpdate: (e) => {
      "worklet";
      const nx = from.value.x + e.translationX;
      const ny = from.value.y + e.translationY;
      edges[x].value =
        x === "l"
          ? Math.min(Math.max(nx, box.x), edges.r.value - MIN_CROP)
          : Math.max(Math.min(nx, box.x + box.w), edges.l.value + MIN_CROP);
      edges[y].value =
        y === "t"
          ? Math.min(Math.max(ny, box.y), edges.b.value - MIN_CROP)
          : Math.max(Math.min(ny, box.y + box.h), edges.t.value + MIN_CROP);
    },
  });
  const at = useAnimatedStyle(() => ({
    transform: [{ translateX: edges[x].value - REACH / 2 }, { translateY: edges[y].value - REACH / 2 }],
  }));
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.reach, at]}>
        <View style={styles.handle} />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  dimTop: { position: "absolute", left: 0, right: 0, top: 0 },
  dimBottom: { position: "absolute", left: 0, right: 0, bottom: 0 },
  dimSide: { position: "absolute", left: 0 },
  dimRight: { position: "absolute", right: 0 },
  frame: { position: "absolute", borderWidth: 2, borderColor: "#ffffff" },
  reach: {
    position: "absolute",
    left: 0,
    top: 0,
    width: REACH,
    height: REACH,
    alignItems: "center",
    justifyContent: "center",
  },
  handle: {
    width: HANDLE,
    height: HANDLE,
    borderRadius: 4,
    backgroundColor: "#ffffff",
    boxShadow: "0px 1px 3px rgba(0, 0, 0, 0.35)",
  },
  barAt: { position: "absolute", top: 12, left: SCREEN_X, right: SCREEN_X, alignItems: "flex-start" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 48,
    padding: 4,
    paddingLeft: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  title: { fontWeight: "600", marginRight: 4, flexShrink: 1 },
  button: { minHeight: 40, minWidth: 44, paddingHorizontal: 12, borderRadius: 12 },
  buttonIn: { justifyContent: "center" },
  strong: { fontWeight: "600" },
});
