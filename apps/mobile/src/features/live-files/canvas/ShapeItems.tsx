import { useArtifact } from "@agenteschat/client";
import { type ShapeView, strokePath } from "@agenteschat/live/canvas";
import type { RichDoc } from "@agenteschat/live/rich";
import type { TextLook } from "@agenteschat/live/slides";
import { Image, type ImageSource } from "expo-image";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import Svg, { Ellipse, Path, Polygon, Rect } from "react-native-svg";
import { PixelOrbit } from "@/agent/PixelOrbit";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { Icon, type IconName, useReducedMotion, useTheme } from "@/ui";
import { Face } from "../../shared/Face";
import { useDirectory, useOrgId } from "../../shared/hooks";
import { agentLook } from "../../shared/logic";
import { NOTE_TINTS } from "../shared/LiveCover";
import { RichBlock } from "../slides/SlideView";
import type { Pt, WBox } from "./camera";
import { isInk, NOTE_PAD, NOTE_TEXT, pendingWords, retryable } from "./logic";

/**
 * What a canvas's shapes look like on the phone (ADR 0196 §2, 0197), the web's look in world units laid out at `k`
 * points per unit: pictures (corners 8, the part a crop shows), notes in their soft colors, bare text, shapes in their
 * form with their border and label, pen strokes, pictures being made (the sky forming, who asked, the prompt; failed,
 * why and "Tentar de novo"), an agent's page and any file as a card. Frames and arrows are drawn on the plane itself
 * (Skia). A shape being moved or stretched follows the finger on the UI thread (`Motion`) until the change is written.
 */

/** What moves on the UI thread while a finger drags: the shapes moved (and by how much), the one stretched. */
export interface Motion {
  moving: SharedValue<Record<string, true>>;
  drag: SharedValue<Pt>;
  stretchId: SharedValue<string>;
  stretch: SharedValue<WBox>;
}

export const ShapeItem = memo(function ShapeItem({
  shape,
  k,
  motion,
  picture,
  readOnly,
}: {
  shape: ShapeView;
  k: number;
  motion: Motion;
  picture: (asset: string) => ImageSource;
  readOnly: boolean;
}) {
  const id = shape.id;
  const { x, y, w, h } = shape;
  const rot = shape.rot ?? 0;
  const follow = useAnimatedStyle(() => {
    if (motion.stretchId.value === id && w > 0 && h > 0) {
      const s = motion.stretch.value;
      // Stretched around its middle: the middle moves to the new box's, the size scales to it.
      return {
        transform: [
          { translateX: (s.x + s.w / 2 - (x + w / 2)) * k },
          { translateY: (s.y + s.h / 2 - (y + h / 2)) * k },
          { rotate: `${rot}deg` },
          { scaleX: s.w / w },
          { scaleY: s.h / h },
        ],
      };
    }
    const d = motion.moving.value[id] ? motion.drag.value : null;
    return {
      transform: [
        { translateX: d ? d.x * k : 0 },
        { translateY: d ? d.y * k : 0 },
        { rotate: `${rot}deg` },
        { scaleX: 1 },
        { scaleY: 1 },
      ],
    };
  });
  return (
    <Animated.View
      style={[styles.abs, { left: x * k, top: y * k, width: Math.max(1, w * k), height: Math.max(1, h * k) }, follow]}
    >
      <ShapeBody shape={shape} k={k} picture={picture} readOnly={readOnly} />
    </Animated.View>
  );
});

function ShapeBody({
  shape,
  k,
  picture,
  readOnly,
}: {
  shape: ShapeView;
  k: number;
  picture: (asset: string) => ImageSource;
  readOnly: boolean;
}) {
  switch (shape.type) {
    case "image":
      return <Picture shape={shape} k={k} picture={picture} />;
    case "note":
      return <Note shape={shape} k={k} />;
    case "text":
      return <Words shape={shape} k={k} />;
    case "shape":
      return <Geo shape={shape} k={k} />;
    case "draw":
      return <Stroke shape={shape} />;
    case "pending":
      return <Pending shape={shape} k={k} readOnly={readOnly} />;
    case "html":
    case "file":
      return <FileCard shape={shape} k={k} />;
    default:
      return null;
  }
}

function Picture({ shape, k, picture }: { shape: ShapeView; k: number; picture: (asset: string) => ImageSource }) {
  const { colors: c } = useTheme();
  const reduced = useReducedMotion();
  const radius = 8 * k;
  const crop = shape.crop;
  // A crop: the picture scaled up and moved so its part fills the box.
  const placed = crop
    ? {
        position: "absolute" as const,
        width: (shape.w * k) / crop.w,
        height: (shape.h * k) / crop.h,
        left: (-crop.x / crop.w) * shape.w * k,
        top: (-crop.y / crop.h) * shape.h * k,
      }
    : StyleSheet.absoluteFill;
  return (
    <View style={[styles.fill, styles.clip, { borderRadius: radius, backgroundColor: c.sunken }]}>
      {shape.asset ? (
        <Image
          source={picture(shape.asset)}
          recyclingKey={shape.asset}
          contentFit={crop ? "fill" : "cover"}
          // A picture that just came (a generated one) fades in where its placeholder was.
          transition={reduced ? 0 : 200}
          style={placed}
          accessible={false}
        />
      ) : null}
    </View>
  );
}

/** The look of a canvas's words (Source Sans 3's sizes on the system's font). */
function look(size: number, color: string, opts: Partial<TextLook> = {}): TextLook {
  return {
    font: "body",
    fontFamily: "Source Sans 3",
    size,
    weight: 400,
    color,
    align: "left",
    valign: "top",
    lineHeight: 1.4,
    ...opts,
  };
}

function Note({ shape, k }: { shape: ShapeView; k: number }) {
  const { colors: c, scheme, shadows } = useTheme();
  const tint = NOTE_TINTS[shape.color ?? "yellow"] ?? NOTE_TINTS.yellow;
  return (
    <View
      style={[
        styles.fill,
        styles.clip,
        {
          borderRadius: 6 * k,
          padding: NOTE_PAD * k,
          backgroundColor: scheme === "dark" ? tint.dark : tint.light,
          boxShadow: shadows.e1,
        },
      ]}
    >
      <RichBlock rich={shape.text ?? []} look={look(NOTE_TEXT, c.ink)} k={k} />
    </View>
  );
}

function Words({ shape, k }: { shape: ShapeView; k: number }) {
  const { colors: c } = useTheme();
  const s = shape.style ?? {};
  return (
    <RichBlock
      rich={shape.text ?? []}
      look={look(s.size ?? 24, s.color ?? c.ink, {
        lineHeight: 1.35,
        ...(s.align ? { align: s.align } : {}),
        ...(s.weight ? { weight: s.weight } : {}),
      })}
      k={k}
    />
  );
}

/** A star's corners on a 100 × 100 square. */
const STAR = [50, 3, 62, 36, 97, 37, 69, 58, 79, 93, 50, 72, 21, 93, 31, 58, 3, 37, 38, 36];

function Geo({ shape, k }: { shape: ShapeView; k: number }) {
  const { colors: c } = useTheme();
  const w = Math.max(1, shape.w);
  const h = Math.max(1, shape.h);
  const fill = shape.fill ?? c.raised;
  const stroke = shape.stroke ?? c.lineStrong;
  const width = shape.strokeWidth ?? 2;
  const kind = shape.kind ?? "rect";
  const rich: RichDoc = shape.text ?? [];
  const corners =
    kind === "triangle"
      ? `${w / 2},1 ${w - 1},${h - 1} 1,${h - 1}`
      : kind === "star"
        ? STAR.reduce<string[]>((out, v, i) => {
            if (i % 2 === 0) out.push(`${(v / 100) * w},${((STAR[i + 1] ?? 0) / 100) * h}`);
            return out;
          }, []).join(" ")
        : kind === "diamond"
          ? `${w / 2},1 ${w - 1},${h / 2} ${w / 2},${h - 1} 1,${h / 2}`
          : null;
  return (
    <>
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={StyleSheet.absoluteFill}
      >
        {kind === "ellipse" ? (
          <Ellipse
            cx={w / 2}
            cy={h / 2}
            rx={Math.max(0, w / 2 - 1)}
            ry={Math.max(0, h / 2 - 1)}
            fill={fill}
            stroke={stroke}
            strokeWidth={width}
          />
        ) : corners ? (
          <Polygon points={corners} fill={fill} stroke={stroke} strokeWidth={width} />
        ) : (
          <Rect
            x={1}
            y={1}
            width={w - 2}
            height={h - 2}
            rx={Math.max(0, Math.min(shape.radius ?? 8, w / 2, h / 2))}
            fill={fill}
            stroke={stroke}
            strokeWidth={width}
          />
        )}
      </Svg>
      <View style={[styles.fill, { padding: 12 * k }]}>
        <RichBlock rich={rich} look={look(18, c.ink, { align: "center", valign: "middle", lineHeight: 1.35 })} k={k} />
      </View>
    </>
  );
}

/** A pen stroke (its points from its box's corner, in world units); the marker wide and see-through. */
function Stroke({ shape }: { shape: ShapeView }) {
  const { colors: c, scheme } = useTheme();
  if (!shape.points?.length) return null;
  const marker = shape.tool === "marker";
  const w = Math.max(1, shape.w);
  const h = Math.max(1, shape.h);
  return (
    <Svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={[StyleSheet.absoluteFill, styles.visible]}
    >
      <Path
        d={strokePath(shape.points)}
        fill="none"
        // The ink people draw with reads light on the dark canvas, as on the web.
        stroke={
          shape.stroke && shape.stroke !== "none" && !(scheme === "dark" && isInk(shape.stroke)) ? shape.stroke : c.ink
        }
        strokeWidth={shape.strokeWidth ?? (marker ? 16 : 4)}
        strokeOpacity={marker ? 0.4 : 1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** A picture on its way (ADR 0197): the sky forming in the asker's tone, who asked and the prompt; failed, why. */
function Pending({ shape, k, readOnly }: { shape: ShapeView; k: number; readOnly: boolean }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const dir = useDirectory();
  const by = shape.by;
  const agent = by?.kind === "agent" ? dir.anyAgent(by.id) : undefined;
  const tone = agent ? agentLook(agent).color : "sky";
  const failed = shape.status === "failed";
  const name = by ? dir.nameOf({ type: by.kind === "agent" ? "agent" : "person", id: by.id }) : "";
  const size = 15 * k;
  // Too small on screen for words: the forming sky alone says it.
  const words = size >= 6;
  const face = Math.round(18 * k);
  return (
    <View
      style={[
        styles.fill,
        styles.clip,
        { borderRadius: 8 * k, backgroundColor: c.bg, borderColor: c.line2 },
        styles.edge,
      ]}
      accessible
      accessibilityRole={failed ? "button" : "progressbar"}
      accessibilityLabel={t(pendingWords(shape))}
    >
      {failed ? null : (
        <Dither kind="forming" tones={softTones(tone, c.bg)} pixel={3} style={StyleSheet.absoluteFill} />
      )}
      {words ? (
        <View style={[styles.pendingBody, failed && styles.pendingFailed, { padding: 16 * k, gap: 8 * k }]}>
          {failed ? (
            <>
              <RNText allowFontScaling={false} style={[styles.strong, { fontSize: size, color: c.danger }]}>
                {t(pendingWords(shape))}
              </RNText>
              {retryable(shape) && !readOnly ? (
                <View
                  style={[
                    {
                      paddingVertical: 6 * k,
                      paddingHorizontal: 12 * k,
                      borderRadius: 10 * k,
                      backgroundColor: c.raised,
                    },
                  ]}
                >
                  <RNText allowFontScaling={false} style={[styles.strong, { fontSize: size, color: c.ink }]}>
                    {t("live.images.retry")}
                  </RNText>
                </View>
              ) : null}
            </>
          ) : (
            <View style={[styles.line, { gap: 8 * k }]}>
              {face >= 8 ? <PixelOrbit color={tone} size={Math.round(16 * k)} /> : null}
              <RNText allowFontScaling={false} style={[styles.strong, { fontSize: size, color: c.ink }]}>
                {t(pendingWords(shape))}
              </RNText>
            </View>
          )}
          {shape.prompt ? (
            <RNText
              allowFontScaling={false}
              numberOfLines={3}
              style={{ fontSize: size, lineHeight: size * 1.35, color: c.ink }}
            >
              {shape.prompt}
            </RNText>
          ) : null}
          {by ? (
            <View style={[styles.line, { gap: 8 * k }]}>
              {face >= 8 ? (
                <Face who={{ type: by.kind === "agent" ? "agent" : "person", id: by.id }} size={face} live={false} />
              ) : null}
              <RNText allowFontScaling={false} numberOfLines={1} style={{ fontSize: 13 * k, color: c.muted }}>
                {t("live.images.askedBy", { name })}
              </RNText>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const KIND_ICONS: Record<string, IconName> = {
  document: "doc",
  table: "list",
  diff: "code",
  diagram: "chart",
  html: "globe",
  block: "globe",
  spreadsheet: "spreadsheet",
  slides: "slides",
  canvas: "canvas",
};

/** An agent's page or any Drive file on the canvas, as a card: its kind's mark and its name. */
function FileCard({ shape, k }: { shape: ShapeView; k: number }) {
  const { t } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const { data, isError } = useArtifact(useOrgId(), shape.artifact ?? null);
  const icon: IconName = shape.type === "html" ? "globe" : data ? (KIND_ICONS[data.kind] ?? "file") : "file";
  const title = isError ? t("live.canvas.fileMissing") : (data?.title ?? t("live.canvas.loadingFile"));
  const size = 18 * k;
  return (
    <View
      style={[
        styles.fill,
        styles.card,
        { borderRadius: 12 * k, padding: 16 * k, gap: 8 * k, backgroundColor: c.raised, boxShadow: shadows.e1 },
      ]}
    >
      <Icon name={icon} size={Math.max(8, Math.round(28 * k))} color={c.muted} />
      <RNText
        allowFontScaling={false}
        numberOfLines={2}
        style={[styles.strong, { fontSize: size, lineHeight: size * 1.3, color: c.ink }]}
      >
        {title}
      </RNText>
      {shape.type === "html" ? (
        <RNText allowFontScaling={false} style={{ fontSize: 14 * k, color: c.muted }}>
          {t("live.canvas.kinds.html")}
        </RNText>
      ) : null}
    </View>
  );
}

/** A frame's name over its top-left corner, at the screen's own size whatever the zoom. */
export const FrameName = memo(function FrameName({
  shape,
  k,
  motion,
}: {
  shape: ShapeView;
  k: number;
  motion: Motion;
}) {
  const { colors: c } = useTheme();
  const id = shape.id;
  const follow = useAnimatedStyle(() => {
    const d = motion.moving.value[id] ? motion.drag.value : null;
    return { transform: [{ translateX: d ? d.x * k : 0 }, { translateY: d ? d.y * k : 0 }] };
  });
  if (!shape.name) return null;
  return (
    <Animated.View
      style={[styles.abs, { left: shape.x * k, top: shape.y * k - 20, maxWidth: Math.max(40, shape.w * k) }, follow]}
    >
      <RNText allowFontScaling={false} numberOfLines={1} style={[styles.frameName, { color: c.muted }]}>
        {shape.name}
      </RNText>
    </Animated.View>
  );
});

/** An arrow's label in a small plate at the middle of its line. */
export const ArrowLabel = memo(function ArrowLabel({
  label,
  at,
  k,
}: {
  label: string;
  at: { x: number; y: number };
  k: number;
}) {
  const { colors: c } = useTheme();
  const size = 14 * k;
  // A box as wide as a long label around the middle; the plate sits in its center, as wide as its words.
  const boxW = 480 * k;
  const boxH = size * 1.3 + 4 * k;
  return (
    <View
      pointerEvents="none"
      style={[styles.abs, styles.labelBox, { left: at.x * k - boxW / 2, top: at.y * k - boxH / 2, width: boxW }]}
    >
      <View
        style={{ borderRadius: 6 * k, paddingVertical: 2 * k, paddingHorizontal: 6 * k, backgroundColor: c.raised }}
      >
        <RNText
          allowFontScaling={false}
          numberOfLines={1}
          style={{ fontSize: size, lineHeight: size * 1.3, color: c.ink }}
        >
          {label}
        </RNText>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  abs: { position: "absolute" },
  fill: { flex: 1 },
  clip: { overflow: "hidden" },
  visible: { overflow: "visible" },
  edge: { borderWidth: StyleSheet.hairlineWidth },
  strong: { fontWeight: "600" },
  line: { flexDirection: "row", alignItems: "center" },
  pendingBody: { position: "absolute", left: 0, right: 0, bottom: 0, alignItems: "flex-start" },
  pendingFailed: { top: 0, justifyContent: "center" },
  card: { justifyContent: "center" },
  frameName: { fontSize: 12, fontWeight: "600" },
  labelBox: { alignItems: "center" },
});
