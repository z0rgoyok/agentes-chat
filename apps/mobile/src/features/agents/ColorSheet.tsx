import { BODY_CUT, BODY_RADIUS, hexToHsv, hsvToHex, isHexColor, pickerStart } from "@agenteschat/ui/agent/engine";
import { Canvas, RoundedRect, LinearGradient as SkiaGradient, vec } from "@shopify/react-native-skia";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useDerivedValue, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Button, fieldText, Sheet } from "@/ui";
import { useColors } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { hsvRgb, rgbHex, tileOf } from "./color-pick";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const HUES = ["#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ff0000"] as const;
/** The thumbs' size, centred on the point they mark. */
const THUMB = 22;
/** The chosen color's tile, in the agent's own shape. */
const TILE = 44;
/** The agent's body: its corners, the cut one at bottom-left (as `Sky`'s and the avatars'). */
const TILE_SHAPE = {
  rect: { x: 0, y: 0, width: TILE, height: TILE },
  topLeft: { x: TILE * BODY_RADIUS, y: TILE * BODY_RADIUS },
  topRight: { x: TILE * BODY_RADIUS, y: TILE * BODY_RADIUS },
  bottomRight: { x: TILE * BODY_RADIUS, y: TILE * BODY_RADIUS },
  bottomLeft: { x: TILE * BODY_CUT, y: TILE * BODY_CUT },
};

/**
 * "Personalizar" on the phone: the web's popover as a sheet. A saturation/brightness area, a hue bar, a hex field
 * and a tile in the agent's shape painted as the color really shows (contrast-clamped, as `gradientOf` clamps it).
 * A drag runs on the UI thread: the thumbs, the area's hue and the tile follow the finger with no render, and the form
 * under the sheet (its sky, its avatar) hears the color once, when the finger lets go, and on Done.
 */
export function ColorSheet({
  open,
  value,
  onChange,
  onClose,
  title,
  done: doneLabel,
  onDone,
}: {
  open: boolean;
  value: string;
  onChange: (hex: `#${string}`) => void;
  onClose: () => void;
  /** Its title and button; the agent's custom color's by default. */
  title?: string;
  done?: string;
  /** Called with the color on the button instead of `onChange`: for a color only kept when it is pressed. */
  onDone?: (hex: `#${string}`) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  // The color as last let go of, or typed: what the field, the screen reader and Done read.
  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(pickerStart(value)));
  const [text, setText] = useState<string>(hsvToHex(...hsv));
  const [h, s, v] = hsv;
  const hex = hsvToHex(h, s, v);
  // The same color under the finger, on the UI thread.
  const hue = useSharedValue(h);
  const sat = useSharedValue(s);
  const val = useSharedValue(v);
  const areaW = useSharedValue(0);
  const areaH = useSharedValue(0);
  const barW = useSharedValue(0);

  /** The finger let go: the color is chosen, said once to the field and to the form. */
  const commit = (nh: number, ns: number, nv: number) => {
    setHsv([nh, ns, nv]);
    const out = hsvToHex(nh, ns, nv);
    setText(out);
    onChange(out as `#${string}`);
  };
  /** A color chosen at once (a screen reader's step): the thumbs move to it, and it is chosen as a release is. */
  const set = (next: [number, number, number]) => {
    hue.set(next[0]);
    sat.set(next[1]);
    val.set(next[2]);
    commit(next[0], next[1], next[2]);
  };

  const pickArea = (x: number, y: number) => {
    "worklet";
    const w = areaW.get();
    const height = areaH.get();
    if (w <= 0 || height <= 0) return;
    sat.set(Math.min(1, Math.max(0, x / w)));
    val.set(Math.min(1, Math.max(0, 1 - y / height)));
  };
  const pickHue = (x: number) => {
    "worklet";
    const w = barW.get();
    if (w <= 0) return;
    hue.set(Math.min(1, Math.max(0, x / w)) * 359);
  };
  // From the first touch (`minDistance` 0): a tap picks as well as a drag, and the sheet's scroll never takes the
  // drag over mid-way, which a 2D area can't share with it.
  const area = usePanGesture({
    minDistance: 0,
    maxPointers: 1,
    onBegin: (e) => {
      "worklet";
      pickArea(e.x, e.y);
    },
    onUpdate: (e) => {
      "worklet";
      pickArea(e.x, e.y);
    },
    onFinalize: () => {
      "worklet";
      scheduleOnRN(commit, hue.get(), sat.get(), val.get());
    },
  });
  const bar = usePanGesture({
    minDistance: 0,
    maxPointers: 1,
    onBegin: (e) => {
      "worklet";
      pickHue(e.x);
    },
    onUpdate: (e) => {
      "worklet";
      pickHue(e.x);
    },
    onFinalize: () => {
      "worklet";
      scheduleOnRN(commit, hue.get(), sat.get(), val.get());
    },
  });

  // Hidden until the area and the bar are measured: a thumb never shows at the corner first.
  const areaThumb = useAnimatedStyle(() => ({
    opacity: areaW.get() > 0 ? 1 : 0,
    backgroundColor: rgbHex(hsvRgb(hue.get(), sat.get(), val.get())),
    transform: [
      { translateX: sat.get() * areaW.get() - THUMB / 2 },
      { translateY: (1 - val.get()) * areaH.get() - THUMB / 2 },
    ],
  }));
  const hueThumb = useAnimatedStyle(() => ({
    opacity: barW.get() > 0 ? 1 : 0,
    transform: [{ translateX: (hue.get() / 359) * barW.get() - THUMB / 2 }],
  }));
  // The area's pure hue, under the white and the black that fade over it.
  const pure = useAnimatedStyle(() => ({ backgroundColor: rgbHex(hsvRgb(hue.get(), 1, 1)) }));
  const tile = useDerivedValue(() => tileOf(hue.get(), sat.get(), val.get()));

  // Applied even untouched: the color shown is the color chosen.
  const done = () => {
    (onDone ?? onChange)(hex as `#${string}`);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <View style={styles.wrap}>
        <SheetTitle title={title ?? t("look.customColor")} />
        <GestureDetector gesture={area}>
          <View
            onLayout={(e) => {
              areaW.set(e.nativeEvent.layout.width);
              areaH.set(e.nativeEvent.layout.height);
            }}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={t("look.colorArea")}
            accessibilityValue={{ text: `${Math.round(s * 100)}%, ${Math.round(v * 100)}%` }}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(e) =>
              set([h, s, clamp01(v + (e.nativeEvent.actionName === "increment" ? 0.1 : -0.1))])
            }
            style={styles.area}
          >
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, pure]} />
            <LinearGradient
              pointerEvents="none"
              colors={["#ffffff", "rgba(255,255,255,0)"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
            <LinearGradient pointerEvents="none" colors={["transparent", "#000000"]} style={StyleSheet.absoluteFill} />
            <Animated.View pointerEvents="none" style={[styles.thumb, areaThumb]} />
          </View>
        </GestureDetector>
        <GestureDetector gesture={bar}>
          <View
            onLayout={(e) => barW.set(e.nativeEvent.layout.width)}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={t("look.hue")}
            accessibilityValue={{ min: 0, max: 359, now: Math.round(h) }}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(e) =>
              set([(h + (e.nativeEvent.actionName === "increment" ? 10 : 350)) % 360, s, v])
            }
            style={styles.bar}
          >
            <LinearGradient
              pointerEvents="none"
              colors={HUES}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={[StyleSheet.absoluteFill, styles.barTrack]}
            />
            <Animated.View pointerEvents="none" style={[styles.thumb, styles.hueThumb, hueThumb]} />
          </View>
        </GestureDetector>
        <View style={styles.foot}>
          <Canvas style={styles.tile}>
            <RoundedRect rect={TILE_SHAPE}>
              <SkiaGradient start={vec(0, 0)} end={vec(0, TILE)} colors={tile} />
            </RoundedRect>
          </Canvas>
          <TextInput
            value={text}
            onChangeText={(raw) => {
              const next = raw.trim().startsWith("#") ? raw.trim() : `#${raw.trim()}`;
              setText(next);
              if (isHexColor(next)) {
                const typed = hexToHsv(next);
                hue.set(typed[0]);
                sat.set(typed[1]);
                val.set(typed[2]);
                setHsv(typed);
                onChange(next.toLowerCase() as `#${string}`);
              }
            }}
            onEndEditing={() => setText(hex)}
            onSubmitEditing={done}
            maxLength={7}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t("look.hex")}
            style={[styles.hex, fieldText("body"), { backgroundColor: c.raised, color: c.ink, borderColor: c.line }]}
          />
        </View>
        <Button variant="primary" wide label={doneLabel ?? t("look.useColor")} onPress={done} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // The sheet already gives its 18 pt sides: the color sheet's title and area line up with every other sheet's.
  wrap: { gap: 14 },
  area: { height: 180, borderRadius: 14, overflow: "hidden" },
  // At the area's corner, moved to its point by `translate` (`left`/`top` would lay the sheet out every frame).
  thumb: {
    position: "absolute",
    left: 0,
    top: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 3,
    borderColor: "#ffffff",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  // Centred on the 16 pt bar.
  hueThumb: { top: -3 },
  bar: { height: 16, justifyContent: "center" },
  barTrack: { borderRadius: 999 },
  foot: { flexDirection: "row", alignItems: "center", gap: 12 },
  tile: { width: TILE, height: TILE },
  hex: { flex: 1, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
});
