import { type ArtifactContent, type ArtifactLiveContent, isLiveFileKind } from "@agenteschat/client";
import { type CanvasPreview, type NoteColor, strokePath } from "@agenteschat/live/canvas";
import { blockText, type DocBlock, type DocumentPreview, markdownToBlocks } from "@agenteschat/live/document";
import { richText } from "@agenteschat/live/rich";
import {
  type ElementView,
  SLIDE_H,
  SLIDE_W,
  type SlideBackground,
  type SlideView,
  shapeFill,
  type ThemeId,
  textLook,
  themeOf,
} from "@agenteschat/live/slides";
import type { SheetPreview } from "@agenteschat/live/spreadsheet";
import { Image } from "expo-image";
import { memo } from "react";
import { Text as RNText, StyleSheet, View } from "react-native";
import Svg, { G, Line, Path, Rect } from "react-native-svg";
import { Icon, useTheme } from "@/ui";

/**
 * A live file drawn small (ADR 0196 §7), from the preview its card carries (never the whole document): a
 * spreadsheet's top-left cells, a presentation's first slide, a canvas's shapes as a map. The Drive's cards, a
 * message's card and the uploaded decks' list draw with these; nothing here opens the file.
 */

/** A note's soft color on the canvas, light and dark (the web's canvas tokens on the phone). */
export const NOTE_TINTS: Record<NoteColor, { light: string; dark: string }> = {
  yellow: { light: "#fff1a8", dark: "#5c5222" },
  pink: { light: "#ffd9e6", dark: "#5e3346" },
  blue: { light: "#d6e9ff", dark: "#28425e" },
  green: { light: "#d7f2de", dark: "#284c34" },
  purple: { light: "#e7ddff", dark: "#40345e" },
  gray: { light: "#ececf1", dark: "#3a3a40" },
};

const isNoteColor = (v: string | undefined): v is NoteColor => !!v && v in NOTE_TINTS;

/** A document's content as its card has it (ADR 0200): its preview, else its whole text in Markdown. */
export type DocumentCoverContent = { kind: "document"; markdown: string; preview?: DocumentPreview };

/** A file's content when it is a live file's (its card draws it), else null. */
export const liveCoverContent = (content: ArtifactContent): ArtifactLiveContent | DocumentCoverContent | null =>
  isLiveFileKind(content.kind) ? (content as ArtifactLiveContent | DocumentCoverContent) : null;

/** Whatever a live file's card draws on top, by its kind. */
export const LiveCover = memo(function LiveCover({
  content,
  width,
  height,
}: {
  content: ArtifactLiveContent | DocumentCoverContent;
  width: number;
  height: number;
}) {
  switch (content.kind) {
    case "document":
      return <DocumentCover content={content} />;
    case "spreadsheet":
      return <SheetCover preview={content.preview} />;
    case "slides":
      return <SlidesCover preview={content.preview} width={width} height={height} />;
    case "canvas":
      return <CanvasCover preview={content.preview} width={width} height={height} />;
  }
});

/** The most blocks a document's cover draws. */
const COVER_BLOCKS = 8;

/**
 * A document's first blocks as a small page (ADR 0200): headings bold, paragraphs and list items in lines, a quote
 * with its bar, a picture or a table as their shape; from its preview, else from its Markdown.
 */
export const DocumentCover = memo(function DocumentCover({ content }: { content: DocumentCoverContent }) {
  const { colors: c } = useTheme();
  const blocks: DocBlock[] = (content.preview?.blocks ?? markdownToBlocks(content.markdown)).slice(0, COVER_BLOCKS);
  return (
    <View style={[styles.fill, styles.docPage, { backgroundColor: c.raised }]}>
      {blocks.map((block, i) => {
        const key = block.id ?? String(i);
        if (block.type === "image")
          return <View key={key} style={[styles.docPicture, { backgroundColor: c.sunken }]} />;
        if (block.type === "table") return <View key={key} style={[styles.docTable, { borderColor: c.line2 }]} />;
        if (block.type === "horizontal_rule")
          return <View key={key} style={[styles.docRule, { backgroundColor: c.line2 }]} />;
        const heading = block.type === "heading";
        const listed = block.type === "paragraph" && block.list;
        return (
          <RNText
            key={key}
            allowFontScaling={false}
            numberOfLines={heading ? 1 : 2}
            style={[
              heading ? styles.docHeading : styles.docText,
              { color: heading ? c.ink : c.ink2 },
              block.type === "blockquote" && [styles.docQuote, { borderLeftColor: c.line2 }],
            ]}
          >
            {listed ? (block.list === "ordered" ? "1. " : "• ") : ""}
            {blockText(block)}
          </RNText>
        );
      })}
    </View>
  );
});

/** The cover's grid: this many rows and columns at most (the rest is in the file). */
const COVER_ROWS = 7;
const COVER_COLS = 4;

/** A spreadsheet's first cells as a small grid: the column letters, then its rows, bold and aligned as theirs. */
export const SheetCover = memo(function SheetCover({ preview }: { preview: SheetPreview }) {
  const { colors: c } = useTheme();
  const rows = (preview.rows ?? []).slice(0, COVER_ROWS);
  const cols = Math.max(1, Math.min(COVER_COLS, preview.widths?.length ?? rows[0]?.length ?? 1));
  const widths = Array.from({ length: cols }, (_, j) => Math.max(40, preview.widths?.[j] ?? 100));
  const total = widths.reduce((a, b) => a + b, 0);
  return (
    <View style={styles.fill}>
      <View style={[styles.sheetRow, styles.sheetHead, { backgroundColor: c.sunken, borderColor: c.line2 }]}>
        {widths.map((w, j) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: a static drawing
            key={j}
            style={[styles.sheetCell, { width: `${(w / total) * 100}%`, borderColor: c.line2 }]}
          >
            <RNText allowFontScaling={false} style={[styles.sheetLetter, { color: c.faint }]}>
              {String.fromCharCode(65 + j)}
            </RNText>
          </View>
        ))}
      </View>
      {Array.from({ length: Math.max(rows.length, 4) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static drawing
        <View key={i} style={[styles.sheetRow, { borderColor: c.line2 }]}>
          {widths.map((w, j) => {
            const text = rows[i]?.[j] ?? "";
            const align = preview.align?.[i]?.[j] ?? "l";
            return (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: a static drawing
                key={j}
                style={[styles.sheetCell, { width: `${(w / total) * 100}%`, borderColor: c.line2 }]}
              >
                <RNText
                  allowFontScaling={false}
                  numberOfLines={1}
                  ellipsizeMode="clip"
                  style={[
                    styles.sheetText,
                    { color: c.ink2, textAlign: align === "r" ? "right" : align === "c" ? "center" : "left" },
                    preview.bold?.[i]?.[j] && styles.bold,
                  ]}
                >
                  {text}
                </RNText>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
});

/** A presentation's first slide on the box's sunken ground, fitted with a margin. */
export const SlidesCover = memo(function SlidesCover({
  preview,
  width,
  height,
}: {
  preview: { theme: ThemeId; first: SlideView | null };
  width: number;
  height: number;
}) {
  const { colors: c } = useTheme();
  const room = { w: Math.max(0, width - 24), h: Math.max(0, height - 20) };
  const w = Math.min(room.w, (room.h * SLIDE_W) / SLIDE_H);
  return (
    <View style={[styles.fill, styles.center, { backgroundColor: c.sunken }]}>
      {w > 0 ? <SlideSketch theme={preview.theme} slide={preview.first} width={w} /> : null}
    </View>
  );
});

/** An element as a sketch draws it: a live slide's, or an uploaded deck's (no id, its picture by media name). */
export type SketchElement = Omit<ElementView, "id" | "z"> & { id?: string };

/** A slide as a sketch draws it. */
export interface SketchSlide {
  bg?: SlideBackground;
  elements: readonly SketchElement[];
}

/** A picture's address and the session's headers (a live file's pictures are the file's, ADR 0196 §8). */
export type SketchPicture = (ref: string) => { uri: string; headers?: Record<string, string> } | null;

/**
 * One slide drawn small, in slide units scaled to `width` (16:9): the theme's ground (or the slide's own), its texts
 * in the theme's look, its shapes, pictures, tables and charts as plain blocks. A sketch for covers and lists: the
 * presentation's own screen draws slides whole. `picture` turns an element's asset (or an uploaded deck's media name)
 * into an address; without one, pictures are quiet blocks.
 */
export const SlideSketch = memo(function SlideSketch({
  theme: themeId,
  slide,
  width,
  picture,
}: {
  theme: ThemeId | undefined;
  slide: SketchSlide | null;
  width: number;
  picture?: SketchPicture;
}) {
  const theme = themeOf(themeId);
  const k = width / SLIDE_W;
  const height = SLIDE_H * k;
  const bg = slide?.bg;
  const ground = typeof bg === "string" ? bg : theme.colors.bg;
  const bgPicture = bg && typeof bg === "object" ? picture?.(bg.asset) : null;
  return (
    <View
      style={[styles.slide, { width, height, backgroundColor: ground, borderRadius: Math.max(2, 16 * k) }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {bgPicture ? (
        <Image
          source={bgPicture}
          cachePolicy="memory-disk"
          contentFit="cover"
          style={StyleSheet.absoluteFill}
          accessible={false}
        />
      ) : null}
      {(slide?.elements ?? []).map((el, i) => (
        <SketchPart
          // Elements of a deck read from a file have no ids: their place in the slide is theirs.
          key={el.id ?? i}
          el={el}
          k={k}
          theme={theme}
          picture={picture}
        />
      ))}
    </View>
  );
});

function SketchPart({
  el,
  k,
  theme,
  picture,
}: {
  el: SketchElement;
  k: number;
  theme: ReturnType<typeof themeOf>;
  picture: SketchPicture | undefined;
}) {
  const box = {
    left: el.x * k,
    top: el.y * k,
    width: Math.max(1, el.w * k),
    height: Math.max(1, el.h * k),
    ...(el.rot ? { transform: [{ rotate: `${el.rot}deg` }] } : {}),
  };
  const opacity = el.style?.opacity;
  if (el.type === "image") {
    const source = el.asset ? picture?.(el.asset) : null;
    return (
      <View style={[styles.abs, box, { backgroundColor: theme.colors.surface, borderRadius: 4 * k }]}>
        {source ? (
          <Image
            source={source}
            cachePolicy="memory-disk"
            contentFit={el.fit ?? "cover"}
            style={[StyleSheet.absoluteFill, { borderRadius: 4 * k }]}
            accessible={false}
          />
        ) : null}
      </View>
    );
  }
  if (el.type === "line") {
    return (
      <View
        style={[
          styles.abs,
          { left: box.left, top: box.top + box.height / 2, width: box.width, height: Math.max(1, 4 * k) },
          { backgroundColor: el.style?.stroke ?? theme.colors.text },
        ]}
      />
    );
  }
  if (el.type === "table" && el.table) {
    const rows = el.table.rows.slice(0, 8);
    return (
      <View style={[styles.abs, box, { borderColor: theme.colors.line, borderWidth: Math.max(0.5, 2 * k) }]}>
        {rows.map((row, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: a static drawing
            key={i}
            style={[styles.tableRow, { borderColor: theme.colors.line, borderBottomWidth: Math.max(0.5, 2 * k) }]}
          >
            {row.slice(0, 6).map((cell, j) => (
              <RNText
                // biome-ignore lint/suspicious/noArrayIndexKey: a static drawing
                key={j}
                allowFontScaling={false}
                numberOfLines={1}
                style={[
                  styles.tableCell,
                  { fontSize: Math.max(2, 26 * k), color: theme.colors.text, paddingHorizontal: 8 * k },
                  i === 0 && el.table?.header && styles.bold,
                ]}
              >
                {cell}
              </RNText>
            ))}
          </View>
        ))}
      </View>
    );
  }
  if (el.type === "chart") {
    const values = el.chart?.series[0]?.values.slice(0, 8) ?? [];
    const max = Math.max(1, ...values.map((v) => Math.abs(v)));
    return (
      <View style={[styles.abs, box, styles.chart, { gap: 8 * k, padding: 16 * k }]}>
        {values.map((v, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: a static drawing
            key={i}
            style={[
              styles.bar,
              { height: `${(Math.abs(v) / max) * 100}%`, backgroundColor: theme.colors.accent, borderRadius: 3 * k },
            ]}
          />
        ))}
      </View>
    );
  }
  const shape = el.type === "shape";
  const fill = shape ? shapeFill(theme, el.style) : undefined;
  const radius =
    el.style?.shape === "ellipse" ? Math.min(box.width, box.height) / 2 : shape ? (el.style?.radius ?? 12) * k : 0;
  const text = el.text ? richText(el.text) : "";
  const look = text ? textLook(theme, el) : null;
  return (
    <View
      style={[
        styles.abs,
        box,
        shape && fill && fill !== "none" ? { backgroundColor: fill, borderRadius: radius } : null,
        el.style?.stroke
          ? { borderColor: el.style.stroke, borderWidth: Math.max(0.5, (el.style.strokeWidth ?? 2) * k) }
          : null,
        opacity !== undefined ? { opacity } : null,
        {
          justifyContent: look?.valign === "middle" ? "center" : look?.valign === "bottom" ? "flex-end" : "flex-start",
        },
      ]}
    >
      {look ? (
        <RNText
          allowFontScaling={false}
          numberOfLines={Math.max(1, Math.floor(el.h / (look.size * look.lineHeight)))}
          style={{
            fontSize: Math.max(1, look.size * k),
            lineHeight: Math.max(1, look.size * look.lineHeight * k),
            color: look.color,
            fontWeight: look.weight >= 700 ? "700" : look.weight >= 600 ? "600" : "400",
            textAlign: look.align,
          }}
        >
          {text}
        </RNText>
      ) : null}
    </View>
  );
}

/** A canvas as a small map: its frames, notes, pictures, texts and arrows where they are, fitted to the box. */
export const CanvasCover = memo(function CanvasCover({
  preview,
  width,
  height,
}: {
  preview: CanvasPreview;
  width: number;
  height: number;
}) {
  const { colors: c, scheme } = useTheme();
  const dark = scheme === "dark";
  const b = preview.bounds;
  if (!b || preview.shapes.length === 0 || width <= 0 || height <= 0)
    return (
      <View style={[styles.fill, styles.center]}>
        <Icon name="canvas" size={24} color={c.faint} />
      </View>
    );
  const pad = 14;
  const k = Math.min((width - pad * 2) / Math.max(1, b.w), (height - pad * 2) / Math.max(1, b.h), 0.5);
  const ox = (width - b.w * k) / 2 - b.x * k;
  const oy = (height - b.h * k) / 2 - b.y * k;
  const X = (x: number) => ox + x * k;
  const Y = (y: number) => oy + y * k;
  return (
    <Svg width={width} height={height} accessible={false}>
      {preview.shapes.map((s) => {
        const x = X(s.x);
        const y = Y(s.y);
        const w = Math.max(1, s.w * k);
        const h = Math.max(1, s.h * k);
        switch (s.type) {
          case "frame":
            return (
              <Rect
                key={s.id}
                x={x}
                y={y}
                width={w}
                height={h}
                rx={Math.min(6, 12 * k)}
                fill={c.sunken}
                fillOpacity={0.6}
                stroke={c.line2}
                strokeWidth={1}
              />
            );
          case "note":
            return (
              <Rect
                key={s.id}
                x={x}
                y={y}
                width={w}
                height={h}
                rx={Math.min(3, 6 * k)}
                fill={isNoteColor(s.color) ? NOTE_TINTS[s.color][dark ? "dark" : "light"] : NOTE_TINTS.yellow.light}
              />
            );
          case "arrow":
            return s.line ? (
              <Line
                key={s.id}
                x1={X(s.line.x1)}
                y1={Y(s.line.y1)}
                x2={X(s.line.x2)}
                y2={Y(s.line.y2)}
                stroke={c.ink2}
                strokeWidth={1}
              />
            ) : null;
          case "text":
            return (
              <Rect key={s.id} x={x} y={y + h * 0.3} width={w} height={Math.max(1.5, h * 0.4)} rx={1} fill={c.line2} />
            );
          case "draw":
            // A pen stroke: its points, from its box's corner, at the cover's scale.
            return s.points?.length ? (
              <G key={s.id} transform={`translate(${x} ${y}) scale(${k})`}>
                <Path
                  d={strokePath(s.points)}
                  fill="none"
                  stroke={s.stroke && s.stroke !== "none" ? s.stroke : c.ink2}
                  strokeWidth={(s.tool === "marker" ? 3 : 1) / k}
                  strokeOpacity={s.tool === "marker" ? 0.4 : 1}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </G>
            ) : null;
          case "shape":
            return (
              <Rect
                key={s.id}
                x={x}
                y={y}
                width={w}
                height={h}
                rx={Math.min(4, 8 * k)}
                fill={s.color ?? c.plate}
                stroke={c.line2}
                strokeWidth={0.5}
              />
            );
          default:
            // Pictures, pages, files and pictures being made: a quiet block where they are.
            return <Rect key={s.id} x={x} y={y} width={w} height={h} rx={Math.min(4, 8 * k)} fill={c.plate} />;
        }
      })}
    </Svg>
  );
});

/** A slide's ground as a color, for what draws around it (its picture's color is the theme's). */
export const slideGround = (bg: SlideBackground | undefined, themeId: ThemeId | undefined) =>
  typeof bg === "string" ? bg : themeOf(themeId).colors.bg;

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: "hidden" },
  center: { alignItems: "center", justifyContent: "center" },
  bold: { fontWeight: "700" },
  docPage: { paddingHorizontal: 12, paddingTop: 10, gap: 4 },
  docHeading: { fontSize: 12, fontWeight: "700" },
  docText: { fontSize: 9.5, lineHeight: 13 },
  docQuote: { borderLeftWidth: 2, paddingLeft: 6 },
  docPicture: { height: 28, borderRadius: 3 },
  docTable: { height: 22, borderWidth: StyleSheet.hairlineWidth, borderRadius: 3 },
  docRule: { height: StyleSheet.hairlineWidth },
  sheetRow: { flexDirection: "row", height: 18, borderBottomWidth: StyleSheet.hairlineWidth },
  sheetHead: { height: 14 },
  sheetCell: { justifyContent: "center", paddingHorizontal: 4, borderRightWidth: StyleSheet.hairlineWidth },
  sheetLetter: { fontSize: 8, fontWeight: "600", textAlign: "center" },
  sheetText: { fontSize: 9.5, fontVariant: ["tabular-nums"] },
  slide: { overflow: "hidden", boxShadow: "0px 1px 3px rgba(0, 0, 0, 0.12)" },
  abs: { position: "absolute", overflow: "hidden" },
  tableRow: { flex: 1, flexDirection: "row", alignItems: "center" },
  tableCell: { flex: 1 },
  chart: { flexDirection: "row", alignItems: "flex-end" },
  bar: { flex: 1 },
});
