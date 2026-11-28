import type { ChartSpec } from "@agenteschat/client/lib/chart";
import type { RichDoc, RichRun } from "@agenteschat/live/rich";
import {
  type DeckFonts,
  type ElementView,
  type SlideBackground,
  type SlideTheme,
  shapeFill,
  type ThemeId,
  textLook,
  themeOf,
} from "@agenteschat/live/slides";
import type { HexColor } from "@agenteschat/ui/agent/engine";
import { Image, type ImageSource } from "expo-image";
import { createContext, memo, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet, type TextStyle, View } from "react-native";
import Svg, { Ellipse, G, Line, Polygon, Rect } from "react-native-svg";
import { Icon, useTheme } from "@/ui";
import { ThemeColorsOverride } from "@/ui/theme";
import { ChartView } from "../../chat/ChartCard";
import { faceStyle, useNativeFaces } from "../shared/fonts";
import {
  type DeckSize,
  drawnParagraphs,
  elementFrame,
  PARAGRAPH_GAP_EM,
  placeholderOf,
  runLook,
  slideHeight,
  slideScale,
} from "./logic";

/**
 * A slide drawn on the phone as it looks (ADR 0196 §2, 0198): in the deck's own units, scaled to `width`, every size
 * the theme's or the element's own, so it reads the same in the list, opened large, presenting and in an uploaded
 * deck. Texts are the app's text (never scaled by the person's text size: a slide is a picture with words), shapes
 * and lines are drawn, pictures come from the file with the session (`picture`), charts are the chat's own charts in
 * the theme's colors, tables are rows of cells. `edit` shows what an empty box will hold ("Toque para adicionar um
 * título"); presenting and thumbnails never do.
 */

/** An element as drawn: a live slide's (with its id) or an uploaded deck's (none, its picture by media name). */
export type DrawElement = Omit<ElementView, "id" | "z"> & { id?: string };

export interface DrawSlide {
  bg?: SlideBackground;
  elements: readonly DrawElement[];
}

/** A picture's source by its reference (an asset of the file, a deck's media), with the session and a cache key. */
export type PictureOf = (ref: string) => ImageSource | null;

export type SlideMode = "edit" | "thumb" | "show";

/** The deck's own fonts over its theme's (ADR 0220 §3), for every slide drawn below. */
export const SlideFontsContext = createContext<DeckFonts | undefined>(undefined);

export interface SlideViewProps {
  theme: ThemeId | undefined;
  slide: DrawSlide | null;
  width: number;
  deck?: DeckSize;
  picture?: PictureOf;
  mode: SlideMode;
  /** The slide's corners, in points (none when presenting: the screen's black is around it). */
  radius?: number;
}

export const SlideView = memo(function SlideView({
  theme: themeId,
  slide,
  width,
  deck,
  picture,
  mode,
  radius = 6,
}: SlideViewProps) {
  const theme = themeOf(themeId);
  const shared = useContext(SlideFontsContext);
  const fonts = (deck as { fonts?: DeckFonts } | undefined)?.fonts ?? shared;
  const k = slideScale(width, deck);
  const height = slideHeight(width, deck);
  const bg = slide?.bg;
  const ground = typeof bg === "string" ? bg : theme.colors.bg;
  const bgPicture = bg && typeof bg === "object" ? picture?.(bg.asset) : null;
  if (width <= 0) return null;
  return (
    <View
      pointerEvents="none"
      style={[styles.slide, { width, height, backgroundColor: ground, borderRadius: radius }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {bgPicture ? (
        <Image source={bgPicture} contentFit="cover" style={StyleSheet.absoluteFill} accessible={false} />
      ) : null}
      {(slide?.elements ?? []).map((el, i) => (
        // Elements of a deck read from a file have no ids: their place in the slide is theirs.
        <Part key={el.id ?? `at${i}`} el={el} k={k} theme={theme} fonts={fonts} picture={picture} mode={mode} />
      ))}
    </View>
  );
});

function Part({
  el,
  k,
  theme,
  fonts,
  picture,
  mode,
}: {
  el: DrawElement;
  k: number;
  theme: SlideTheme;
  fonts: DeckFonts | undefined;
  picture: PictureOf | undefined;
  mode: SlideMode;
}) {
  const f = elementFrame(el, k);
  const box = {
    left: f.left,
    top: f.top,
    width: Math.max(1, f.width),
    height: Math.max(1, f.height),
    ...(f.rot ? { transform: [{ rotate: `${f.rot}deg` }] } : {}),
    ...(el.style?.opacity !== undefined && el.type !== "line" ? { opacity: el.style.opacity } : {}),
  };
  switch (el.type) {
    case "text":
      return (
        <View style={[styles.abs, box]}>
          <TextBody el={el} k={k} theme={theme} fonts={fonts} mode={mode} />
        </View>
      );
    case "shape":
      return (
        <View style={[styles.abs, box]}>
          <ShapeBody el={el} k={k} theme={theme} fonts={fonts} />
        </View>
      );
    case "image":
      return (
        <View style={[styles.abs, box, styles.clip, el.style?.radius ? { borderRadius: el.style.radius * k } : null]}>
          <ImageBody el={el} k={k} theme={theme} picture={picture} mode={mode} />
        </View>
      );
    case "chart":
      return el.chart ? (
        <View style={[styles.abs, box]}>
          <ChartBody el={el} k={k} theme={theme} />
        </View>
      ) : null;
    case "table":
      return el.table ? (
        <View style={[styles.abs, box]}>
          <TableBody el={el} k={k} theme={theme} />
        </View>
      ) : null;
    case "line":
      return <LineBody el={el} k={k} theme={theme} />;
  }
}

// ── Text ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Rich text in a box, in the theme's look for its role: paragraphs, lists, levels and marks as the web draws them. */
export function RichBlock({
  rich,
  look,
  k,
  placeholder,
  placeholderColor,
}: {
  rich: RichDoc;
  look: ReturnType<typeof textLook>;
  k: number;
  placeholder?: string | null;
  placeholderColor?: string;
}) {
  const size = Math.max(0.5, look.size * k);
  // Each face the text draws with (ADR 0220 §8): the box's own, and any a run names.
  const faces = useMemo(
    () => [
      { ref: look.fontRef, weight: look.weight, italic: false },
      ...rich.flatMap((p) =>
        p.runs
          .filter((r) => r.font || r.weight || r.bold || r.italic)
          .map((r) => ({
            ref: r.font ?? look.fontRef,
            weight: r.weight ?? (r.bold ? 700 : look.weight),
            italic: r.italic === true,
          })),
      ),
    ],
    [rich, look.fontRef, look.weight],
  );
  useNativeFaces(faces);
  const base: TextStyle = {
    fontSize: size,
    lineHeight: Math.max(1, look.size * look.lineHeight * k),
    color: look.color,
    ...faceStyle({ ref: look.fontRef, weight: look.weight, italic: false }),
    textAlign: look.align,
    ...(look.tracking
      ? { letterSpacing: (look.tracking / 1000) * size }
      : look.font === "heading"
        ? { letterSpacing: -0.01 * size }
        : {}),
    ...(look.caps ? { textTransform: "uppercase" } : {}),
  };
  const runStyle = (run: RichRun): TextStyle => {
    const own = run.size ? run.size * k : size;
    const typed = run.font || run.weight || run.bold || run.italic;
    return {
      ...runLook(run),
      ...(typed
        ? faceStyle({
            ref: run.font ?? look.fontRef,
            weight: run.weight ?? (run.bold ? 700 : look.weight),
            italic: run.italic === true,
          })
        : {}),
      ...(run.size ? { fontSize: own } : {}),
      ...(run.tracking ? { letterSpacing: (run.tracking / 1000) * own } : {}),
      ...(run.caps ? { textTransform: "uppercase" } : {}),
      ...(run.highlight ? { backgroundColor: run.highlight } : {}),
    };
  };
  const paragraphs = useMemo(() => drawnParagraphs(rich), [rich]);
  const empty = !rich.some((p) => p.runs.some((r) => r.text));
  return (
    <View
      style={[
        styles.fill,
        { justifyContent: look.valign === "middle" ? "center" : look.valign === "bottom" ? "flex-end" : "flex-start" },
      ]}
    >
      {empty ? (
        placeholder ? (
          <RNText
            allowFontScaling={false}
            style={[base, styles.placeholder, { color: placeholderColor ?? look.color }]}
          >
            {placeholder}
          </RNText>
        ) : null
      ) : (
        paragraphs.map((p, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of one text, in order
            key={i}
            style={{
              paddingLeft: p.indent * size,
              marginTop: i > 0 ? PARAGRAPH_GAP_EM * size : 0,
              ...(rich[i]?.spaceAfter ? { marginBottom: (rich[i]?.spaceAfter ?? 0) * k } : {}),
            }}
          >
            {p.marker ? (
              <RNText
                allowFontScaling={false}
                style={[base, styles.marker, { left: p.markerAt * size, width: 1.4 * size, textAlign: "left" }]}
              >
                {p.marker}
              </RNText>
            ) : null}
            <RNText
              allowFontScaling={false}
              style={[
                base,
                p.align ? { textAlign: p.align } : null,
                rich[i]?.lineHeight ? { lineHeight: Math.max(1, look.size * (rich[i]?.lineHeight ?? 1) * k) } : null,
              ]}
            >
              {p.runs.length
                ? p.runs.map((run, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: runs of one paragraph, in order
                    <RNText key={j} style={runStyle(run)}>
                      {run.text}
                    </RNText>
                  ))
                : " "}
            </RNText>
          </View>
        ))
      )}
    </View>
  );
}

function TextBody({
  el,
  k,
  theme,
  fonts,
  mode,
}: {
  el: DrawElement;
  k: number;
  theme: SlideTheme;
  fonts: DeckFonts | undefined;
  mode: SlideMode;
}) {
  const { t } = useTranslation();
  const look = textLook(theme, el, fonts);
  const hint = mode === "edit" ? placeholderOf(el) : null;
  return (
    <RichBlock
      rich={el.text ?? []}
      look={look}
      k={k}
      placeholder={hint ? t(`mobile.live.slides.placeholder.${hint}`) : null}
      placeholderColor={theme.colors.muted}
    />
  );
}

// ── Shapes and lines ──────────────────────────────────────────────────────────────────────────────────────────────

/** A shape's outline in its w×h box, inset by half its stroke so the stroke stays inside (the web's `shapePath`). */
function ShapePath({
  kind,
  w,
  h,
  inset,
  radius,
}: {
  kind: string;
  w: number;
  h: number;
  inset: number;
  radius: number;
}) {
  const x0 = inset;
  const y0 = inset;
  const x1 = Math.max(x0, w - inset);
  const y1 = Math.max(y0, h - inset);
  const mx = w / 2;
  const my = h / 2;
  switch (kind) {
    case "ellipse":
      return <Ellipse cx={mx} cy={my} rx={Math.max(0, mx - inset)} ry={Math.max(0, my - inset)} />;
    case "triangle":
      return <Polygon points={`${mx},${y0} ${x1},${y1} ${x0},${y1}`} />;
    case "diamond":
      return <Polygon points={`${mx},${y0} ${x1},${my} ${mx},${y1} ${x0},${my}`} />;
    case "arrow": {
      const head = Math.min((x1 - x0) * 0.45, (y1 - y0) * 0.9);
      const neck = x1 - head;
      const top = y0 + (y1 - y0) * 0.28;
      const bottom = y1 - (y1 - y0) * 0.28;
      return (
        <Polygon
          points={`${x0},${top} ${neck},${top} ${neck},${y0} ${x1},${my} ${neck},${y1} ${neck},${bottom} ${x0},${bottom}`}
        />
      );
    }
    default:
      return (
        <Rect
          x={x0}
          y={y0}
          width={Math.max(0, x1 - x0)}
          height={Math.max(0, y1 - y0)}
          rx={Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2)}
        />
      );
  }
}

function ShapeBody({
  el,
  k,
  theme,
  fonts,
}: {
  el: DrawElement;
  k: number;
  theme: SlideTheme;
  fonts: DeckFonts | undefined;
}) {
  const style = el.style ?? {};
  const fill = shapeFill(theme, style);
  const stroke = style.stroke && style.stroke !== "none" ? style.stroke : null;
  const width = stroke ? (style.strokeWidth ?? 4) : 0;
  const w = Math.max(1, el.w);
  const h = Math.max(1, el.h);
  const hasText = (el.text ?? []).some((p) => p.runs.some((r) => r.text));
  return (
    <>
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={StyleSheet.absoluteFill}
      >
        <G fill={fill === "none" ? "none" : fill} stroke={stroke ?? "none"} strokeWidth={width} strokeLinejoin="round">
          <ShapePath kind={style.shape ?? "rect"} w={w} h={h} inset={width / 2} radius={style.radius ?? 0} />
        </G>
      </Svg>
      {hasText ? <RichBlock rich={el.text ?? []} look={textLook(theme, el, fonts)} k={k} /> : null}
    </>
  );
}

function LineBody({ el, k, theme }: { el: DrawElement; k: number; theme: SlideTheme }) {
  const style = el.style ?? {};
  const width = style.strokeWidth ?? 6;
  const color = style.stroke && style.stroke !== "none" ? style.stroke : theme.colors.text;
  const f = elementFrame(el, k);
  const w = Math.abs(el.w);
  const h = Math.abs(el.h);
  const x1 = el.w < 0 ? w : 0;
  const y1 = el.h < 0 ? h : 0;
  const x2 = el.w < 0 ? 0 : w;
  const y2 = el.h < 0 ? 0 : h;
  const arrow = style.lineEnd === "arrow";
  const head = Math.max(width * 3, 18);
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  // The line stops where the head starts, so its round end never shows past the point.
  const ex = arrow ? x2 - ux * head * 0.8 : x2;
  const ey = arrow ? y2 - uy * head * 0.8 : y2;
  const px = -uy * head * 0.55;
  const py = ux * head * 0.55;
  const hx = x2 - ux * head;
  const hy = y2 - uy * head;
  // The drawing reaches past the box by half the stroke (and the head), so it never clips at the ends.
  const pad = Math.max(width, head);
  return (
    <View
      style={[
        styles.abs,
        { left: f.left - pad * k, top: f.top - pad * k, width: (w + 2 * pad) * k, height: (h + 2 * pad) * k },
        f.rot ? { transform: [{ rotate: `${f.rot}deg` }] } : null,
      ]}
    >
      <Svg width="100%" height="100%" viewBox={`${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`}>
        <G stroke={color} fill={color} opacity={style.opacity ?? 1}>
          <Line x1={x1} y1={y1} x2={ex} y2={ey} strokeWidth={width} strokeLinecap="round" />
          {arrow ? <Polygon points={`${x2},${y2} ${hx + px},${hy + py} ${hx - px},${hy - py}`} stroke="none" /> : null}
        </G>
      </Svg>
    </View>
  );
}

// ── Pictures, charts, tables ──────────────────────────────────────────────────────────────────────────────────────

function ImageBody({
  el,
  k,
  theme,
  picture,
  mode,
}: {
  el: DrawElement;
  k: number;
  theme: SlideTheme;
  picture: PictureOf | undefined;
  mode: SlideMode;
}) {
  const { t } = useTranslation();
  const source = el.asset ? picture?.(el.asset) : null;
  if (source) {
    return (
      <Image
        source={source}
        contentFit={el.fit ?? "cover"}
        style={StyleSheet.absoluteFill}
        transition={0}
        accessible={false}
      />
    );
  }
  // An empty picture slot of the layout: a quiet block while editing, nothing when presenting.
  if (mode === "show" && !el.asset) return null;
  return (
    <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: theme.colors.surface }]}>
      {mode === "edit" ? (
        <View style={[styles.hint, { gap: 16 * k }]}>
          <Icon name="image" size={Math.max(8, 40 * k)} color={theme.colors.muted} />
          <RNText allowFontScaling={false} style={{ fontSize: Math.max(4, 32 * k), color: theme.colors.muted }}>
            {el.asset ? t("live.slides.image.missing") : t("mobile.live.slides.placeholder.image")}
          </RNText>
        </View>
      ) : null}
    </View>
  );
}

/** The chat's chart is drawn this many slide units per point, then scaled to the slide (the web's `CHART_ZOOM`). */
const CHART_ZOOM = 2.4;

function ChartBody({ el, k, theme }: { el: DrawElement; k: number; theme: SlideTheme }) {
  const app = useTheme().colors;
  // The chart's words and lines in the theme's colors: a dark theme's chart reads on its slide whatever the app's.
  const colors = useMemo(
    () => ({
      ...app,
      ink: theme.colors.text,
      ink2: theme.colors.text,
      muted: theme.colors.muted,
      faint: theme.colors.muted,
      line: theme.colors.line,
      line2: theme.colors.line,
      plate: theme.colors.surface,
      sunken: theme.colors.surface,
      bg: theme.colors.bg,
      raised: theme.colors.surface,
    }),
    [app, theme],
  );
  const chart = el.chart;
  if (!chart) return null;
  const head = chart.title || chart.subtitle;
  const headH = (chart.title ? 40 * 1.15 : 0) + (chart.subtitle ? 26 * 1.3 : 0) + (head ? 16 : 0);
  const plotW = el.w / CHART_ZOOM;
  const plotH = Math.max(0, el.h - headH) / CHART_ZOOM;
  return (
    <View style={styles.fill}>
      {chart.title ? (
        <RNText
          allowFontScaling={false}
          numberOfLines={1}
          style={{ fontSize: 40 * k, lineHeight: 46 * k, fontWeight: "600", color: theme.colors.text }}
        >
          {chart.title}
        </RNText>
      ) : null}
      {chart.subtitle ? (
        <RNText allowFontScaling={false} numberOfLines={1} style={{ fontSize: 26 * k, color: theme.colors.muted }}>
          {chart.subtitle}
        </RNText>
      ) : null}
      <View style={[styles.plot, { marginTop: head ? 16 * k : 0 }]}>
        <View style={[styles.zoom, { width: plotW, height: plotH, transform: [{ scale: k * CHART_ZOOM }] }]}>
          <ThemeColorsOverride colors={colors}>
            <ChartView spec={chart as ChartSpec} accent={theme.colors.accent as HexColor} big still />
          </ThemeColorsOverride>
        </View>
      </View>
    </View>
  );
}

/** A table's words in slide units: a bit smaller than body text, so a few rows fit (the web's `tableFontSize`). */
export function tableFontSize(theme: SlideTheme, el: Pick<ElementView, "style" | "table">): number {
  if (el.style?.size) return el.style.size;
  const rows = el.table?.rows.length ?? 1;
  return Math.round(Math.max(18, Math.min(theme.sizes.body * 0.8, 36 - Math.max(0, rows - 6) * 1.5)));
}

function TableBody({ el, k, theme }: { el: DrawElement; k: number; theme: SlideTheme }) {
  const table = el.table;
  if (!table) return null;
  const size = tableFontSize(theme, el) * k;
  const border = Math.max(StyleSheet.hairlineWidth, 2 * k);
  return (
    <View style={[styles.fill, { borderColor: theme.colors.line, borderTopWidth: border, borderLeftWidth: border }]}>
      {table.rows.map((row, r) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one table, in order
          key={r}
          style={[
            styles.row,
            table.header && r === 0 ? { backgroundColor: theme.colors.surface } : null,
            { borderColor: theme.colors.line, borderBottomWidth: border },
          ]}
        >
          {row.map((cell, c) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: the cells of one row, in order
              key={c}
              style={[
                styles.cell,
                {
                  borderColor: theme.colors.line,
                  borderRightWidth: border,
                  paddingVertical: 0.35 * size,
                  paddingHorizontal: 0.6 * size,
                },
              ]}
            >
              <RNText
                allowFontScaling={false}
                style={{
                  fontSize: size,
                  lineHeight: size * 1.25,
                  color: theme.colors.text,
                  fontWeight: table.header && r === 0 ? "700" : "400",
                }}
              >
                {cell}
              </RNText>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  slide: { overflow: "hidden" },
  abs: { position: "absolute" },
  clip: { overflow: "hidden" },
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  hint: { flexDirection: "row", alignItems: "center" },
  placeholder: { opacity: 0.42 },
  marker: { position: "absolute", top: 0, fontVariant: ["tabular-nums"] },
  plot: { flex: 1, overflow: "hidden" },
  zoom: { position: "absolute", left: 0, top: 0, transformOrigin: "left top" },
  row: { flex: 1, flexDirection: "row" },
  cell: { flex: 1, justifyContent: "center", overflow: "hidden" },
});
