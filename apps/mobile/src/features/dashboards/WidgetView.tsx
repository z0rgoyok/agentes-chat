import type {
  BarsWidgetSpec,
  GoalWidgetSpec,
  KpiWidgetSpec,
  LineWidgetSpec,
  ListWidgetSpec,
  TextWidgetSpec,
  WidgetKind,
  WidgetSchedule,
  WidgetSpec,
  WidgetStatus,
  WidgetWait,
} from "@agenteschat/client";
import { widgetCardStatus } from "@agenteschat/client";
import type { ChartSpec } from "@agenteschat/client/lib/chart";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import {
  areaCells,
  CHART_CELL,
  cellPaths,
  chartAreaTones,
  chartInk,
  lineTops,
  nearestPoint,
  smoothPath,
} from "@agenteschat/ui/sky/chart";
import { Canvas, DashPathEffect, Path, Rect, Skia, Line as SkiaLine } from "@shopify/react-native-skia";
import { type ComponentRef, memo, type ReactNode, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from "react-native";
import Animated, { Easing, FadeIn, useAnimatedStyle } from "react-native-reanimated";
import { useLivePaused } from "@/agent/live";
import { useDrawingClock } from "@/sky/clock";
import {
  CardHorizon,
  CHROME_MAX_SCALE,
  Icon,
  LineIcon,
  PixelOrbit,
  PressScale,
  Text,
  useReducedMotion,
  useTheme,
} from "@/ui";
import { Line, Picked } from "../chat/ChartCard";
import { AgentFace } from "../shared/Face";
import { useSurface } from "../shared/parts";
import { DitherShape } from "./Dither";
import { useAgentLook, useWidgetAiWay, useWidgetWords } from "./hooks";
import {
  barValueText,
  barWords,
  bleedPoints,
  bleedSeries,
  bleedTip,
  formatWidgetNumber,
  formatWithUnit,
  goalShare,
  isTall,
  pointTip,
  roundRectPath,
  shownWidgetTitle,
  softCardColor,
  topRoundedPath,
  widgetTones,
} from "./logic";

/**
 * The phone's widget (ADR 0135): a block an agent keeps up to date, drawn from its spec like the web's. Numbers in
 * the app's sans at weight 700 with tabular figures; charts as the chat draws them (a clean stroke in the agent's
 * deep tone over a dither in its light one: the line is the chat's own); bars and a goal's fill as outlined shapes
 * filled with the same 2-point Bayer dither. A chart's unit is one quiet word above it (each bar reads only its
 * number); a note is a muted caption under a hairline. A number's trend (and a bare line on a board) runs edge to
 * edge along the card's bottom. Text has four roles: the title a label (13 semibold); what the card shows leads (the
 * number, a summary's first sentence at 17 semibold); then text at 15 and the detail at 13. While the agent builds it, a dither sweep; while it updates, the last data stays,
 * dimmed; when it failed, dimmed with the reason under it.
 */

/** The card's padding: the edge-to-edge chart cancels it. */
const PAD_X = 18;
const PAD_Y = 16;
/** The home strip's card breathes the same all round (ADR 0135 §15). */
const COMPACT_PAD = 16;
/** The build's band crosses the field once in this long, easing in and out. */
const SWEEP_MS = 1400;
const SWEEP_EASE = Easing.inOut(Easing.quad);

function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, (e) => setWidth(Math.round(e.nativeEvent.layout.width))];
}

/** A series as the chat's chart spec, for its line. */
const lineSpec = (labels: string[], values: number[], unit?: string): ChartSpec => ({
  type: "line",
  title: "",
  labels,
  series: [{ name: "", values }],
  ...(unit ? { unit } : {}),
});

/** A card on the home's strip: its height, the same for every widget there. */
export const COMPACT_HEIGHT = 152;
/** The rows a list shows on the home's strip. */
const COMPACT_ROWS = 3;
/** A strip card is short: a number and its line leave less room than a board's card, and that room still earns it. */
const COMPACT_HORIZON_ROOM = 56;

/** What a widget shows: its data by kind, the building sweep, or a quiet line when it has nothing yet. */
export const WidgetBody = memo(function WidgetBody({
  spec,
  status,
  agentId,
  needsAi = false,
  big = false,
  bleed = false,
  compact = false,
  wide = false,
  mark,
  onLayout,
  pickable = false,
}: {
  spec: WidgetSpec | null;
  status: WidgetStatus;
  agentId: string;
  /** Its agent has no AI to build it with (`widgetNeedsAi`): with no data yet, the line says it builds once one is there. */
  needsAi?: boolean;
  /** The widget's own screen and the previews: bigger numbers and charts. */
  big?: boolean;
  /** The card draws the trend (or the bare line) along its bottom (`bleedSeries`): not here. */
  bleed?: boolean;
  /** The home's strip: the card's height, whole sentences only, the first rows only. */
  compact?: boolean;
  /** The strip's card takes two columns (an M or L widget): a line's note fits beside its number. */
  wide?: boolean;
  /** A state's mark (updating, waiting, failed) beside a number or a goal's share, where a small card has room. */
  mark?: ReactNode;
  /** Where the data ends: the card measures the room left under it (its horizon). */
  onLayout?: (e: LayoutChangeEvent) => void;
  /** Not a button itself (the widget's own screen): a tapped bar says its value. */
  pickable?: boolean;
}) {
  const { t } = useTranslation();
  const look = useAgentLook(agentId);
  if (!spec) {
    if (needsAi)
      return (
        <Text variant="footnote" tone="muted">
          {t("widgets.needsAi.body", { name: look.name })}
        </Text>
      );
    if (status === "failed")
      return (
        <Text variant="footnote" tone="faint">
          {t("widgets.status.failed")}
        </Text>
      );
    return <BuildingSweep color={look.color} text={t("widgets.status.building", { name: look.name })} />;
  }
  if (status === "building") {
    return <BuildingSweep color={look.color} text={t("widgets.status.building", { name: look.name })} />;
  }
  // On a board the data dims while it updates or failed; the home's strip says so on its title line instead.
  const dim = compact ? 1 : status === "updating" ? 0.45 : status === "failed" ? 0.5 : 1;
  return (
    // On the strip the columns take the card's room; anything else ends where its data does.
    <View
      onLayout={onLayout}
      style={[{ opacity: dim }, compact && (spec.kind === "bars" || spec.kind === "text") && styles.fill]}
    >
      <SpecBody
        spec={spec}
        color={look.color}
        big={big}
        bleed={bleed}
        compact={compact}
        wide={wide}
        mark={mark}
        pickable={pickable}
      />
    </View>
  );
});

function SpecBody({
  spec,
  color,
  big,
  bleed,
  compact,
  wide,
  mark,
  pickable,
}: {
  spec: WidgetSpec;
  color: AgentColorName;
  big: boolean;
  bleed: boolean;
  compact: boolean;
  wide: boolean;
  mark?: ReactNode;
  pickable: boolean;
}) {
  switch (spec.kind) {
    case "kpi":
      return <Kpi spec={spec} color={color} big={big} bleed={bleed} compact={compact} mark={mark} />;
    case "goal":
      return <Goal spec={spec} color={color} big={big} compact={compact} mark={mark} />;
    case "bars":
      return compact ? (
        <CompactBars spec={spec} color={color} />
      ) : (
        <Bars spec={spec} color={color} big={big} pickable={pickable} />
      );
    case "line":
      return compact ? (
        <CompactLine spec={spec} wide={wide} />
      ) : (
        <LineBody spec={spec} color={color} big={big} bleed={bleed} />
      );
    case "list":
      return <List spec={spec} compact={compact} />;
    case "text":
      return <Summary spec={spec} compact={compact} />;
  }
}

/** The big number: what comes before and after it smaller, how it moved and the note each on a line, its trend. */
function Kpi({
  spec,
  color,
  big,
  bleed,
  compact = false,
  mark,
}: {
  spec: KpiWidgetSpec;
  color: AgentColorName;
  big: boolean;
  bleed: boolean;
  compact?: boolean;
  mark?: ReactNode;
}) {
  const { i18n } = useTranslation();
  const { colors: c } = useTheme();
  const spark = spec.spark ?? [];
  const trend = useMemo(
    () =>
      !bleed && spark.length > 1
        ? lineSpec(
            spark.map((_, i) => String(i)),
            spark,
          )
        : null,
    [spark, bleed],
  );
  return (
    <View>
      {/* What comes before the number ("US$") is a text of its own on the number's baseline: as the first, smaller
          part of the number's text, Android set the line's height by it and cut the top off the digits. */}
      <View style={styles.numRow}>
        <View style={[styles.figure, styles.grow]}>
          {spec.prefix ? <Text style={[styles.affix, { color: c.muted }]}>{spec.prefix}</Text> : null}
          <Text
            variant="display"
            numberOfLines={1}
            style={[styles.num, big ? styles.numBig : null, styles.shrink, { color: c.ink }]}
          >
            {formatWidgetNumber(spec.value, i18n.language)}
            {spec.suffix ? <Text style={[styles.affix, { color: c.muted }]}>{` ${spec.suffix}`}</Text> : null}
          </Text>
        </View>
        {mark}
      </View>
      {/* How it moved, on a line of its own (the quiet ink on the strip, one accent per screen: the waiting strip's;
          its color on a board), then the agent's note: neither cuts the other. */}
      {spec.delta ? (
        <Text
          variant="label"
          numberOfLines={1}
          style={[styles.delta, { color: compact ? c.ink2 : spec.delta.up ? c.ok : c.danger }]}
        >
          {spec.delta.text}
        </Text>
      ) : null}
      {spec.note ? (
        <Text variant="footnote" tone={compact ? "faint" : "muted"} numberOfLines={compact ? 1 : 2}>
          {spec.note}
        </Text>
      ) : null}
      {trend ? (
        <View style={styles.spark}>
          <Line spec={trend} accent={color} big={false} spark height={big ? 60 : 30} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Progress towards a goal: the share, a track filled with the dither, the line and the note. On the strip a thinner
 * track and the line alone, whole in two lines (the note is on the widget's screen).
 */
function Goal({
  spec,
  color,
  big,
  compact = false,
  mark,
}: {
  spec: GoalWidgetSpec;
  color: AgentColorName;
  big: boolean;
  compact?: boolean;
  mark?: ReactNode;
}) {
  const { colors: c, scheme } = useTheme();
  const tones = widgetTones(color, scheme === "dark");
  const [width, onLayout] = useWidth();
  const height = big ? 16 : compact ? 8 : 12;
  // Inside the track's 1.5-point border.
  const inner = height - 3;
  const radius = Math.min(3, (inner - 1.5) / 2);
  const fill = Math.round(Math.max(0, width - 3) * goalShare(spec.pct));
  return (
    <View>
      <View style={styles.numRow}>
        <Text
          variant="display"
          numberOfLines={1}
          style={[styles.num, big ? styles.numBig : null, styles.shrink, { color: c.ink }]}
        >
          {Math.round(spec.pct)}
          <Text style={[styles.affix, { color: c.muted }]}>%</Text>
        </Text>
        {mark}
      </View>
      <View onLayout={onLayout} style={[styles.track, { height, borderColor: c.line2 }]}>
        {fill > 3 ? (
          <Canvas style={{ width: fill, height: inner }}>
            <DitherShape
              width={fill}
              height={inner}
              shape={roundRectPath(0.75, 0.75, fill - 1.5, inner - 1.5, radius)}
              fill={tones.fill}
              stroke={tones.stroke}
            />
          </Canvas>
        ) : null}
      </View>
      <Text variant="footnote" tone="ink2" numberOfLines={big ? 3 : 2}>
        {spec.line}
        {spec.note && !compact ? (
          <Text variant="footnote" tone="faint">
            {` · ${spec.note}`}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}

/** Columns with their value over them and their label under; the one an alert is about in the warning color. */
function Bars({
  spec,
  color,
  big,
  pickable,
}: {
  spec: BarsWidgetSpec;
  color: AgentColorName;
  big: boolean;
  pickable: boolean;
}) {
  const { i18n } = useTranslation();
  const { colors: c, scheme } = useTheme();
  const tones = widgetTones(color, scheme === "dark");
  const [width, onLayout] = useWidth();
  const n = spec.values.length;
  const gap = n > 12 ? 3 : 8;
  const slot = n > 0 ? Math.max(0, (width - gap * (n - 1)) / n) : 0;
  const bw = Math.min(44, slot);
  const words = barWords(n, width);
  const height = big ? 140 : 84;
  const room = height - 18;
  const max = Math.max(0, ...spec.values) || 1;
  const [picked, setPicked] = useState<number | null>(null);
  const tip = pointTip(spec.labels, spec.values, (v) => formatWithUnit(v, spec.unit, i18n.language));
  return (
    <View>
      <UnitTag unit={spec.unit} />
      <View onLayout={onLayout} style={[styles.bars, { height, gap }]}>
        {width > 0
          ? spec.values.map((v, i) => {
              const h = Math.max(4, Math.round((Math.max(0, v) / max) * room));
              const alert = spec.alertIndex === i;
              return (
                <Pressable
                  // biome-ignore lint/suspicious/noArrayIndexKey: the bars of one widget, in order
                  key={i}
                  disabled={!pickable}
                  onPress={() => setPicked((p) => (p === i ? null : i))}
                  style={[styles.bar, picked !== null && picked !== i ? styles.dim : null]}
                  accessible
                  accessibilityRole={pickable ? "button" : undefined}
                  accessibilityLabel={tip(i)}
                >
                  {words.values ? (
                    <Text
                      variant="caption"
                      numberOfLines={1}
                      // The short form already fits: this only guards a very large text size.
                      adjustsFontSizeToFit
                      minimumFontScale={0.75}
                      maxFontSizeMultiplier={CHROME_MAX_SCALE}
                      style={[styles.barValue, { color: alert ? c.warn : c.ink2 }]}
                    >
                      {barValueText(v, i18n.language, slot)}
                    </Text>
                  ) : null}
                  {bw > 1 ? (
                    <Canvas style={{ width: bw, height: h }}>
                      <DitherShape
                        width={bw}
                        height={h}
                        shape={topRoundedPath(0.75, 0.75, bw - 1.5, h - 0.75, 4)}
                        outline={topRoundedPath(0.75, 0.75, bw - 1.5, h - 0.75, 4, false)}
                        fill={tones.fill}
                        stroke={alert ? c.warn : tones.stroke}
                      />
                    </Canvas>
                  ) : null}
                </Pressable>
              );
            })
          : null}
      </View>
      <View style={[styles.axis, { gap, borderTopColor: c.line2 }]}>
        {spec.labels.map((label, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the labels, in order
          <Text key={i} variant="caption" tone="faint" numberOfLines={1} style={styles.axisLabel}>
            {i % words.every === 0 || i === n - 1 ? label : ""}
          </Text>
        ))}
      </View>
      {pickable ? <Picked text={picked === null ? null : tip(picked)} /> : null}
      <Note text={spec.note} />
    </View>
  );
}

/**
 * The home's strip: each column in a slot of its own over its label (every n-th when they don't all fit), as tall as
 * the card has room for. What they count is at the title line's end (`WidgetCard`); their values are on the widget's
 * screen (the card is one button named by its title).
 */
function CompactBars({ spec, color }: { spec: BarsWidgetSpec; color: AgentColorName }) {
  const { colors: c, scheme } = useTheme();
  const tones = widgetTones(color, scheme === "dark");
  const [box, setBox] = useState({ width: 0, height: 0 });
  const n = spec.values.length;
  const slot = n > 0 ? box.width / n : 0;
  // The slot less a gap, never wider than 26.
  const bw = Math.max(0, Math.min(26, slot - (n > 12 ? 3 : 10)));
  const words = barWords(n, box.width);
  const room = box.height;
  const max = Math.max(0, ...spec.values) || 1;
  return (
    <View style={[styles.fill, styles.compactBars]}>
      <View
        onLayout={(e) =>
          setBox({ width: Math.round(e.nativeEvent.layout.width), height: Math.round(e.nativeEvent.layout.height) })
        }
        style={[styles.fill, styles.barsCompact]}
      >
        {bw > 1 && room > 4
          ? spec.values.map((v, i) => {
              const h = Math.max(3, Math.round((Math.max(0, v) / max) * room));
              const alert = spec.alertIndex === i;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the bars of one widget, in order
                <View key={i} style={styles.slot}>
                  <Canvas style={{ width: bw, height: h }}>
                    <DitherShape
                      width={bw}
                      height={h}
                      shape={topRoundedPath(0.75, 0.75, bw - 1.5, h - 0.75, 4)}
                      outline={topRoundedPath(0.75, 0.75, bw - 1.5, h - 0.75, 4, false)}
                      fill={tones.fill}
                      stroke={alert ? c.warn : tones.stroke}
                    />
                  </Canvas>
                </View>
              );
            })
          : null}
      </View>
      <View style={styles.axisCompact}>
        {spec.labels.map((label, i) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: the labels, in order
            key={i}
            variant="caption"
            tone="faint"
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={styles.axisLabel}
          >
            {i % words.every === 0 || i === n - 1 ? label : ""}
          </Text>
        ))}
      </View>
    </View>
  );
}

/**
 * A line on the home's strip: what it is now (its last value, the unit after it) as the card's number and, on a wide
 * card, the note beside it. The line itself runs along the card's foot (`bleedSeries`).
 */
function CompactLine({ spec, wide }: { spec: LineWidgetSpec; wide: boolean }) {
  const { i18n } = useTranslation();
  const { colors: c } = useTheme();
  const last = spec.values[spec.values.length - 1];
  const unit = spec.unit?.trim();
  return (
    <View style={styles.numRow}>
      <Text variant="display" numberOfLines={1} style={[styles.num, styles.shrink, { color: c.ink }]}>
        {last === undefined ? "" : formatWidgetNumber(last, i18n.language)}
        {unit ? <Text style={[styles.affix, { color: c.muted }]}>{` ${unit}`}</Text> : null}
      </Text>
      {wide && spec.note ? (
        <Text variant="footnote" tone="muted" numberOfLines={2} style={styles.grow}>
          {spec.note}
        </Text>
      ) : null}
    </View>
  );
}

/** The chat's line: bare on a card, with its points and labels (tap one for its value) on the widget's screen. */
function LineBody({
  spec,
  color,
  big,
  bleed,
}: {
  spec: LineWidgetSpec;
  color: AgentColorName;
  big: boolean;
  bleed: boolean;
}) {
  // The unit is the tag above: a tapped point reads only its number.
  const chart = useMemo(() => lineSpec(spec.labels, spec.values), [spec.labels, spec.values]);
  return (
    <View>
      <UnitTag unit={spec.unit} />
      {bleed ? null : <Line spec={chart} accent={color} big={big} spark={!big} height={big ? 160 : 80} />}
      <Note text={spec.note} />
    </View>
  );
}

/** What a chart's values count, once, as a quiet word above it ("runs per day"): a word, never a tag on a plate. */
function UnitTag({ unit }: { unit?: string | undefined }) {
  if (!unit?.trim()) return null;
  return (
    <Text
      variant="footnote"
      tone="faint"
      numberOfLines={1}
      maxFontSizeMultiplier={CHROME_MAX_SCALE}
      style={styles.unit}
    >
      {unit.trim()}
    </Text>
  );
}

/** A chart's note: a muted caption of up to two lines, under a hairline. */
function Note({ text }: { text?: string | undefined }) {
  const { colors: c } = useTheme();
  if (!text) return null;
  return (
    <Text variant="footnote" tone="muted" numberOfLines={2} style={[styles.note, { borderTopColor: c.line2 }]}>
      {text}
    </Text>
  );
}

/**
 * A trend along the card's bottom, edge to edge (the card's rounded corners clip it): the chat's clean stroke in the
 * agent's deep tone over its dither, which fades out toward the bottom edge, and a square on the last point. Given
 * `tip` (the widget's own screen, where the card is no button), a tap marks the nearest point with a crosshair and
 * its square and says its value above it; a screen reader steps through the points (swipe up or down).
 */
function BleedLine({
  values,
  color,
  height,
  tip,
  label,
}: {
  values: number[];
  color: AgentColorName;
  height: number;
  tip?: ((i: number) => string) | null;
  label?: string;
}) {
  const { colors: c, scheme } = useTheme();
  const dark = scheme === "dark";
  const reduced = useReducedMotion();
  const [width, onLayout] = useWidth();
  const [picked, setPicked] = useState<number | null>(null);
  const [pill, setPill] = useState(0);
  const points = useMemo(() => (width > 10 ? bleedPoints(values, width, height) : []), [values, width, height]);
  const stroke = useMemo(() => (points.length > 1 ? Skia.Path.MakeFromSVGString(smoothPath(points)) : null), [points]);
  const area = useMemo(() => {
    if (points.length < 2) return [];
    const cols = Math.ceil(width / CHART_CELL);
    const rows = Math.ceil(height / CHART_CELL);
    const cells = cellPaths(areaCells(cols, rows, lineTops(points, cols)), cols, rows, CHART_CELL, true);
    return [...cells].flatMap(([v, d]) => {
      const path = Skia.Path.MakeFromSVGString(d);
      return path ? [{ v, path }] : [];
    });
  }, [points, width, height]);
  const [near, far] = chartAreaTones(color, dark);
  const ink = chartInk(color, dark);
  const last = points[points.length - 1];
  const on = tip && picked !== null ? points[picked] : undefined;
  // The square stands out of the line in a ring of the card's own color.
  const ring = softCardColor(c.raised, c.grouped, dark);
  const square = (at: readonly [number, number], size: number) => (
    <>
      <Rect x={at[0] - size / 2 - 1.5} y={at[1] - size / 2 - 1.5} width={size + 3} height={size + 3} color={ring} />
      <Rect x={at[0] - size / 2} y={at[1] - size / 2} width={size} height={size} color={ink} />
    </>
  );
  const step = (by: number) =>
    setPicked((p) => Math.max(0, Math.min(points.length - 1, (p ?? points.length - 1) + by)));
  const canvas =
    width > 0 && stroke ? (
      <Canvas style={{ width, height }}>
        {area.map((p) => (
          <Path key={p.v} path={p.path} color={p.v === 1 ? near : far} />
        ))}
        {on ? (
          <SkiaLine p1={{ x: on[0], y: 0 }} p2={{ x: on[0], y: height }} color={c.faint} strokeWidth={1}>
            <DashPathEffect intervals={[2, 3]} />
          </SkiaLine>
        ) : null}
        <Path path={stroke} color={ink} style="stroke" strokeWidth={2.4} strokeCap="round" strokeJoin="round" />
        {last && last !== on ? square(last, 7) : null}
        {on ? square(on, 9) : null}
      </Canvas>
    ) : null;
  if (!tip) {
    return (
      <View onLayout={onLayout} style={[styles.bleed, { height }]} accessible={false}>
        {canvas}
      </View>
    );
  }
  const text = on && picked !== null ? tip(picked) : null;
  return (
    <Pressable
      onLayout={onLayout}
      style={[styles.bleed, { height }]}
      onPress={(e) => {
        const i = nearestPoint(points, e.nativeEvent.locationX);
        setPicked((p) => (i < 0 || p === i ? null : i));
      }}
      accessible
      accessibilityRole="adjustable"
      {...(label ? { accessibilityLabel: label } : {})}
      accessibilityValue={{ text: tip(picked ?? Math.max(0, points.length - 1)) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => step(e.nativeEvent.actionName === "increment" ? 1 : -1)}
    >
      {canvas}
      {on && text ? (
        // The chat's tip: above its point, kept inside the card's sides.
        <Animated.View
          key={text}
          entering={reduced ? undefined : FadeIn.duration(120)}
          onLayout={(e) => setPill(Math.round(e.nativeEvent.layout.width))}
          pointerEvents="none"
          style={[
            styles.tip,
            {
              backgroundColor: c.ink,
              bottom: height - on[1] + 10,
              left: Math.max(4, Math.min(width - pill - 4, on[0] - pill / 2)),
              opacity: pill ? 1 : 0,
            },
          ]}
        >
          <Text variant="caption" numberOfLines={1} style={[styles.tipText, { color: c.raised }]}>
            {text}
          </Text>
        </Animated.View>
      ) : null}
    </Pressable>
  );
}

/** A few rows with a word each, in the warning or the good color when the agent says so. */
function List({ spec, compact = false }: { spec: ListWidgetSpec; compact?: boolean }) {
  const { colors: c } = useTheme();
  return (
    <View>
      {(compact ? spec.rows.slice(0, COMPACT_ROWS) : spec.rows).map((row, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one widget, in order
          key={i}
          style={[
            styles.row,
            compact ? styles.rowCompact : null,
            compact && i === 0 ? styles.rowFirst : null,
            i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line2 } : null,
          ]}
        >
          <Text variant="subhead" tone="ink" numberOfLines={1} style={styles.grow}>
            {row.text}
          </Text>
          {row.meta ? (
            <Text
              variant="footnote"
              numberOfLines={1}
              style={[
                styles.meta,
                row.tone ? styles.strong : null,
                { color: row.tone === "warn" ? c.warn : row.tone === "ok" ? c.ok : c.faint },
              ]}
            >
              {row.meta}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/**
 * A few sentences: the first leads (17 semibold), the rest quieter at 15. On the home's strip only whole sentences
 * show: one that would end past the card's room isn't drawn (it is on the widget's screen), never cut in the middle.
 */
function Summary({ spec, compact = false }: { spec: TextWidgetSpec; compact?: boolean }) {
  const [room, setRoom] = useState(0);
  const [ends, setEnds] = useState<number[]>([]);
  const [lead, ...rest] = spec.items;
  const fits = (i: number) => !compact || (room > 0 && (ends[i] ?? Number.POSITIVE_INFINITY) <= room);
  return (
    <View
      style={[styles.items, compact && styles.fill]}
      onLayout={compact ? (e) => setRoom(Math.floor(e.nativeEvent.layout.height)) : undefined}
    >
      {lead ? (
        <Text variant="title" numberOfLines={compact ? 3 : undefined}>
          {lead}
        </Text>
      ) : null}
      {rest.map((item, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: the sentences of one widget, in order
          key={i}
          variant="subhead"
          tone="muted"
          onLayout={
            compact
              ? (e) => {
                  const end = Math.ceil(e.nativeEvent.layout.y + e.nativeEvent.layout.height);
                  setEnds((was) => {
                    if (was[i] === end) return was;
                    const next = [...was];
                    next[i] = end;
                    return next;
                  });
                }
              : undefined
          }
          style={fits(i) ? null : styles.hidden}
        >
          {item}
        </Text>
      ))}
    </View>
  );
}

/**
 * The first build: a field of the agent's dither with a denser band sweeping across it (still with reduced
 * motion, or while its run waits: `still`), and what is happening under it.
 */
export function BuildingSweep({
  color,
  text,
  height = 56,
  still = false,
}: {
  color: AgentColorName;
  text: string;
  height?: number;
  still?: boolean;
}) {
  const { scheme } = useTheme();
  const reduced = useReducedMotion() || still;
  const tones = widgetTones(color, scheme === "dark");
  const [width, onLayout] = useWidth();
  const band = Math.max(24, Math.round(width * 0.4));
  // Off screen (a tab not shown, a screen pushed over the home) its time stops where it was, and it carries on from
  // there when it shows again: each pass is the eased crossing of `SWEEP_MS` on that time.
  const paused = useLivePaused();
  const clock = useDrawingClock(!reduced && !paused && width > 0);
  const sweep = useAnimatedStyle(() => {
    const at = SWEEP_EASE((clock.get() % SWEEP_MS) / SWEEP_MS);
    return { transform: [{ translateX: -band + at * (width + band) }] };
  });
  const box = roundRectPath(0, 0, width, height, 6);
  return (
    <View style={styles.building} accessibilityRole={still ? "text" : "progressbar"} accessibilityLabel={text}>
      <View onLayout={onLayout} style={[styles.field, { height }]}>
        {width > 0 ? (
          <>
            <Canvas style={StyleSheet.absoluteFill}>
              <DitherShape width={width} height={height} shape={box} fill={tones.fill} density={0.16} />
            </Canvas>
            <Animated.View
              style={[styles.band, { width: band, left: reduced ? (width - band) / 2 : 0 }, reduced ? null : sweep]}
            >
              <Canvas style={StyleSheet.absoluteFill}>
                <DitherShape
                  width={band}
                  height={height}
                  shape={roundRectPath(0, 0, band, height, 0)}
                  fill={tones.fill}
                  density={0.6}
                />
              </Canvas>
            </Animated.View>
          </>
        ) : null}
      </View>
      <Text variant="footnote" tone="muted" numberOfLines={3}>
        {text}
      </Text>
    </View>
  );
}

export interface WidgetCardData {
  /** Empty while the agent hasn't named it yet: the card says the kind's word or "New widget". */
  title: string;
  /** What it shows, when known (the word a widget without a title shows). */
  kind?: WidgetKind | null;
  spec: WidgetSpec | null;
  status: WidgetStatus;
  agentId: string;
  refreshedAt: string | null;
  schedule: WidgetSchedule;
  /** Its width on the board: 2 takes the whole row on the phone. */
  w: 1 | 2;
  /** Its height on the board: 2 (L) stands taller on the phone. */
  h?: 1 | 2;
  /** Its agent has no AI to build it with (`widgetNeedsAi`): it says so, and builds once one is connected. */
  needsAi?: boolean;
  /** What its refresh waits on: said in place of its sweep or "updating…". */
  wait?: WidgetWait | null;
}

/** The card's soft surface (no border, no shadow): its background, by theme. */
export function useWidgetSurface() {
  const { colors: c, scheme } = useTheme();
  return useMemo(
    () => ({ backgroundColor: softCardColor(c.raised, c.grouped, scheme === "dark") }),
    [c.raised, c.grouped, scheme],
  );
}

/**
 * A widget on a board: the agent's small face and the title in a quiet line, what it shows, and a light footer that
 * says when it last updated (and how often, when there's room): "updating…" while it does, the failure and Resolve
 * when it didn't. A number's trend runs edge to edge along the bottom. The card has the design system's cut corner
 * and a soft surface, neutral (the agent's tones are only in the data). `head` replaces the title line, `above` goes
 * between it and the data, `body` replaces the data and `footer` the footer (New widget's card is its form).
 */
export function WidgetCard({
  widget: w,
  big = false,
  head,
  above,
  body,
  footer,
  onPress,
  label,
  compact = false,
}: {
  widget: WidgetCardData;
  big?: boolean;
  head?: ReactNode;
  above?: ReactNode;
  body?: ReactNode;
  footer?: ReactNode;
  onPress?: () => void;
  /** What a screen reader says for the whole card when it opens. */
  label?: string;
  /**
   * The home's strip (ADR 0135 §15): every card as tall as the others (`COMPACT_HEIGHT`) and one or two columns wide
   * (`w`), the app's card breathing 16 all round, the data clipped to it and never dimmed, sentences only whole; its
   * state (updating, waiting, failed) a mark beside its number, or at the title line's end; the trend kept.
   */
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { colors: c } = useTheme();
  const soft = useWidgetSurface();
  const card = useSurface();
  // The home's strip: the app's card (lit top, cut corner), as every card that stands on the page.
  const surface = compact ? [card, styles.compact] : soft;
  const padX = compact ? COMPACT_PAD : PAD_X;
  const look = useAgentLook(w.agentId);
  const words = useWidgetWords();
  // A 2-high (L) widget on a board draws its data big, as on its own screen.
  const large = big || isTall(w.h ?? 1);
  const title = shownWidgetTitle(w.title, w.kind, (key) => t(key));
  // A refresh that waits stands still and says what for: its data as it was, or (with none yet) under a still sweep.
  const status = widgetCardStatus({ status: w.status, wait: w.wait ?? null }, words.now);
  const waits = status !== w.status;
  const shownBody =
    body !== undefined ? (
      body
    ) : waits && !w.spec ? (
      <BuildingSweep still color={look.color} text={words.wait(w)} />
    ) : undefined;
  const drawn = shownBody === undefined && (status === "ok" || status === "updating" || status === "failed");
  const kind = w.spec?.kind;
  const bleed = drawn ? bleedSeries(w.spec, large, compact) : null;
  const bleedHeight = compact ? (kind === "line" ? 56 : 34) : kind === "line" ? (large ? 120 : 76) : large ? 72 : 48;
  // The strip has no footer: updating is the agent's orbit, a wait or a failure a mark. Beside a number or a goal's
  // share, where there is room, else at the title line's end: a small card's title stays whole.
  const mark = compact ? (
    <>
      {status === "updating" ? <PixelOrbit color={look.color} size={16} /> : null}
      {waits ? <Icon name="pause" size={14} color={c.muted} /> : null}
      {status === "failed" ? <Icon name={w.needsAi ? "bolt" : "info"} size={14} color={c.warn} /> : null}
    </>
  ) : null;
  const markByNumber = drawn && (kind === "kpi" || kind === "goal");
  // What a strip's columns count, in words at the title line's end.
  const unitEnd = compact && w.spec?.kind === "bars" ? w.spec.unit?.trim() : undefined;
  const foot = footer !== undefined ? footer : compact ? null : <WidgetFoot widget={w} />;
  // A card with room to spare under its data gets the agents' horizon at its foot, as on the web: not under a trend
  // (it already runs along the foot), not on the big preview, not while it builds.
  const horizon = Boolean(onPress) && !big && drawn && !bleed;
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const frameRef = useRef<ComponentRef<typeof View>>(null);
  // Where the card stands on the screen: cards side by side continue one wave, as on the web.
  const [waveX, setWaveX] = useState(0);
  const [bodyTop, setBodyTop] = useState(0);
  const [dataHeight, setDataHeight] = useState(0);
  // From where the data ends to the card's bottom edge, its padding included (as the web measures it).
  const room = frame.height + PAD_Y - (bodyTop + dataHeight);
  const content = (
    <>
      {horizon ? (
        <>
          <View
            ref={frameRef}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              setFrame((f) => (f.width === width && f.height === height ? f : { width, height }));
              frameRef.current?.measureInWindow((x) => setWaveX(Math.round(x - padX)));
            }}
          />
          {dataHeight > 0 && frame.width > 0 ? (
            <CardHorizon
              width={frame.width + 2 * padX}
              room={room}
              surface={compact ? c.raised : soft.backgroundColor}
              x={waveX}
              {...(compact ? { minRoom: COMPACT_HORIZON_ROOM } : {})}
              style={compact ? [styles.horizon, styles.horizonCompact] : styles.horizon}
            />
          ) : null}
        </>
      ) : null}
      {head === undefined ? (
        <View style={[styles.head, large ? styles.headTop : null]}>
          {/* On the home's strip the title stands alone: whose it is shows when it works (the orbit), not before. */}
          {compact ? null : <AgentFace agentId={w.agentId} size={16} live={false} />}
          <Text variant="label" tone="muted" numberOfLines={large ? 2 : 1} style={[styles.title, styles.grow]}>
            {title}
          </Text>
          {unitEnd ? (
            <Text
              variant="footnote"
              tone="faint"
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_MAX_SCALE}
              style={styles.unitEnd}
            >
              {unitEnd}
            </Text>
          ) : null}
          {markByNumber ? null : mark}
        </View>
      ) : (
        head
      )}
      {above}
      <View
        style={compact ? styles.bodyCompact : styles.body}
        onLayout={horizon ? (e) => setBodyTop(e.nativeEvent.layout.y) : undefined}
      >
        {shownBody === undefined ? (
          <WidgetBody
            spec={w.spec}
            status={status}
            agentId={w.agentId}
            needsAi={w.needsAi}
            big={large}
            bleed={Boolean(bleed)}
            compact={compact}
            wide={w.w === 2}
            mark={markByNumber ? mark : undefined}
            pickable={!onPress}
            {...(horizon ? { onLayout: (e: LayoutChangeEvent) => setDataHeight(e.nativeEvent.layout.height) } : {})}
          />
        ) : (
          shownBody
        )}
      </View>
      {foot}
      {bleed ? (
        <View
          style={[
            styles.bleedBox,
            compact ? styles.bleedBoxCompact : null,
            status === "ok" || compact ? null : styles.dim,
          ]}
        >
          <BleedLine
            values={bleed}
            color={look.color}
            height={bleedHeight}
            tip={onPress ? null : bleedTip(w.spec, i18n.language)}
            label={title}
          />
        </View>
      ) : null}
    </>
  );
  if (!onPress) return <View style={[styles.card, surface]}>{content}</View>;
  return (
    <PressScale
      to={0.98}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      style={[styles.card, surface]}
      contentStyle={compact ? [styles.cardIn, styles.cardInCompact] : styles.cardIn}
      fill={false}
    >
      {content}
    </PressScale>
  );
}

/** "Needs an AI · Connect", Connect only for whoever may connect it (`useWidgetAiWay`): its screen has both. */
function NeedsAiFootWords({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const way = useWidgetAiWay(agentId);
  return way && "connect" in way ? `${t("widgets.needsAi.short")} · ${t("noAi.action")}` : t("widgets.needsAi.short");
}

/**
 * "12 min ago · every hour" (how often only when there's room), "Theo updating…", what its refresh waits for,
 * "Didn't update · Resolve", or "Needs an AI · Connect" (`NeedsAiFootWords`).
 */
function WidgetFoot({ widget: w }: { widget: WidgetCardData }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const look = useAgentLook(w.agentId);
  const words = useWidgetWords();
  if (w.status === "building") return null;
  const wait = words.wait(w);
  if (wait)
    return (
      <View style={styles.waitFoot}>
        <LineIcon variant="caption" name="pause" size={13} color={c.muted} />
        <Text variant="caption" tone="muted" style={styles.grow}>
          {wait}
        </Text>
      </View>
    );
  if (w.status === "updating")
    return (
      <View style={styles.foot}>
        <PixelOrbit color={look.color} size={12} />
        <Text variant="caption" tone="faint" numberOfLines={1} style={styles.grow}>
          {t("widgets.status.updating", { name: look.name })}
        </Text>
      </View>
    );
  if (w.status === "failed")
    return (
      <View style={styles.foot}>
        <Icon name={w.needsAi ? "bolt" : "info"} size={13} color={c.warn} />
        <Text variant="caption" numberOfLines={1} style={[styles.grow, { color: c.warn }]}>
          {w.needsAi ? (
            <NeedsAiFootWords agentId={w.agentId} />
          ) : (
            `${t("widgets.status.failed")} · ${t("widgets.failure.resolve")}`
          )}
        </Text>
      </View>
    );
  const when = w.refreshedAt ? words.ago(w.refreshedAt) : "";
  const often = w.w === 2 || !when ? t(`widgets.schedulesInline.${w.schedule}`) : "";
  const line = [when, often].filter(Boolean).join(" · ");
  if (!line) return null;
  return (
    <View style={styles.foot}>
      <Text variant="caption" tone="faint" numberOfLines={1} style={styles.grow}>
        {line}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 6,
    paddingHorizontal: PAD_X,
    paddingTop: PAD_Y,
    paddingBottom: PAD_Y,
    gap: 10,
    minWidth: 0,
    // The edge-to-edge trend is clipped by the rounded corners.
    overflow: "hidden",
    // Two widgets side by side stand as tall as each other.
    flexGrow: 1,
  },
  cardIn: { gap: 10, flexGrow: 1 },
  cardInCompact: { gap: 8 },
  head: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  // A big card's title may take two lines: the 16 face on the first (its line is 16 tall).
  headTop: { alignItems: "flex-start" },
  title: { fontWeight: "600", letterSpacing: 0.1 },
  body: { flexGrow: 1, minWidth: 0 },
  num: { fontSize: 30, lineHeight: 34, fontWeight: "700", letterSpacing: -0.9, fontVariant: ["tabular-nums"] },
  numBig: { fontSize: 40, lineHeight: 44, letterSpacing: -1.2 },
  affix: { fontSize: 15, fontWeight: "600", letterSpacing: 0 },
  // The prefix and the number on one baseline, a space's width apart.
  figure: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  // A long number gives way (and ends in "…"), never the prefix beside it.
  shrink: { flexShrink: 1, minWidth: 0 },
  strong: { fontWeight: "600" },
  spark: { marginTop: 6 },
  track: {
    borderRadius: 4,
    borderWidth: 1.5,
    overflow: "hidden",
    marginTop: 8,
    marginBottom: 6,
    justifyContent: "center",
  },
  unit: { marginBottom: 4 },
  // The strip's unit at the title line's end: the title gives way first.
  unitEnd: { flexShrink: 0, maxWidth: "45%" },
  bars: { flexDirection: "row", alignItems: "flex-end", paddingTop: 18 },
  bar: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "flex-end", height: "100%" },
  barValue: { fontWeight: "700", fontVariant: ["tabular-nums"], marginBottom: 3 },
  axis: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 4 },
  axisLabel: { flex: 1, minWidth: 0, textAlign: "center" },
  note: { marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "baseline", gap: 8, paddingVertical: 6 },
  meta: { flexShrink: 0, maxWidth: "45%", fontVariant: ["tabular-nums"] },
  grow: { flex: 1, minWidth: 0 },
  items: { gap: 6 },
  // A sentence that would end past the strip card's room keeps its place but isn't drawn.
  hidden: { opacity: 0 },
  building: { gap: 8 },
  field: { borderRadius: 6, overflow: "hidden" },
  band: { position: "absolute", top: 0, bottom: 0 },
  foot: { flexDirection: "row", alignItems: "center", gap: 6 },
  waitFoot: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  // Out to the card's edges and its bottom: the card's padding cancelled.
  bleedBox: { marginHorizontal: -PAD_X, marginBottom: -PAD_Y, marginTop: -4 },
  bleed: { width: "100%" },
  tip: { position: "absolute", paddingHorizontal: 9, paddingVertical: 5, borderRadius: 9 },
  tipText: { fontWeight: "600", fontVariant: ["tabular-nums"] },
  dim: { opacity: 0.45 },
  // Out to the card's sides and bottom edge, under its text: the card's corners clip it.
  horizon: { left: -PAD_X, bottom: -PAD_Y },
  compact: { height: COMPACT_HEIGHT, flexGrow: 0, gap: 8, paddingHorizontal: COMPACT_PAD },
  fill: { flex: 1, minHeight: 0 },
  compactBars: { gap: 4 },
  // Each column centred in its slot, over its label in the same slot.
  barsCompact: { flexDirection: "row", alignItems: "flex-end" },
  slot: { flex: 1, minWidth: 0, alignItems: "center" },
  axisCompact: { flexDirection: "row" },
  bodyCompact: { flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" },
  rowCompact: { paddingVertical: 7 },
  rowFirst: { paddingTop: 0 },
  // A number (or a line's last value) and what stands beside it: a state's mark, a wide line's note.
  numRow: { flexDirection: "row", alignItems: "center", gap: 12, minWidth: 0 },
  delta: { marginTop: 2 },
  bleedBoxCompact: { marginHorizontal: -COMPACT_PAD },
  horizonCompact: { left: -COMPACT_PAD },
});
