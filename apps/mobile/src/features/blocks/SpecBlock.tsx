import { type BlockChange, useBlockReply, useBlockValues } from "@agenteschat/client";
import type { ChartSpec } from "@agenteschat/client/lib/chart";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import {
  type BlockViewPart,
  type BlockWords,
  compileBlock,
  inputValue,
  parseBlockSpec,
  viewBlock,
} from "@agenteschat/ui/blocks/spec";
import { randomUUID } from "expo-crypto";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  Button,
  haptics,
  motion,
  PressScale,
  Segmented,
  Text,
  TOUCH,
  ToggleSwitch,
  useReducedMotion,
  useToast,
} from "@/ui";
import { ChartView } from "../chat/ChartCard";
import { keepSize, keptHeightAfter, keptSize, PAST_RULE } from "../chat/kept-sizes";
import { useLayoutKey } from "../chat/look";
import { Table } from "../chat/MessageSpans";
import { useRowDirectory, useRowMeId } from "../chat/row-data";
import { useColors, useOrgId, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { TextArea } from "../shared/TextArea";
import { INLINE_HEIGHT } from "./logic";

type Sent = { text: string; at: string };
/** What this person sent from a block and whether they opened it whole, kept while the app runs. */
const kept = new Map<string, { sent?: Sent; open?: boolean }>();
const keptOf = (key: string) => {
  let k = kept.get(key);
  if (!k) {
    k = {};
    kept.set(key, k);
  }
  return k;
};

type Values = ReturnType<typeof useBlockValues>;

/**
 * A live block drawn by the app itself (ADR 0113): the parts the agent described, with the app's own controls, over
 * the state everyone in the conversation shares. Nothing the agent wrote runs on the phone: its words reach the screen
 * only as text, and its formulas are read by our interpreter (`@agenteschat/ui/blocks/spec`). So it needs no web view,
 * draws at once with the message, and any number of them can be on screen.
 */
export function SpecBlock({
  id,
  version,
  spec: raw,
  agentId,
  screen = false,
}: {
  id: string;
  version: number;
  spec: Record<string, unknown>;
  agentId: string;
  screen?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const when = useWhen();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useRowDirectory();
  const toast = useToast();
  const agent = dir.agentById.get(agentId);
  const accent = agentLook(agent).color;
  const blockKey = `${id}@${version}`;
  const compiled = useMemo(() => {
    try {
      return compileBlock(parseBlockSpec(raw));
    } catch {
      return null;
    }
  }, [raw]);
  const values = useBlockValues(orgId, id, version);
  const reply = useBlockReply(orgId, id);
  const thousand = t("mobile.blocks.thousand");
  const words = useMemo<BlockWords>(() => ({ locale: i18n.language, thousand }), [i18n.language, thousand]);
  const view = useMemo(
    () => (compiled ? viewBlock(compiled, values.state, words) : null),
    [compiled, values.state, words],
  );
  const [sent, setSent] = useState<Sent | null>(keptOf(blockKey).sent ?? null);
  const [open, setOpen] = useState(keptOf(blockKey).open ?? false);
  // How tall its parts are whole, kept across the list's unmounts (`kept-sizes.ts`): a block coming back is cut from
  // its first frame. Never measured yet, it shows no taller than the card, a point past it (`PAST_RULE`): a tall one
  // drew whole for a frame and then shrank, moving every row under it as the person scrolled. Its own for each version,
  // width and text size: the height of the one before is not this one's (a shorter one stayed cut over blank space).
  const sizeKey = `spec:${blockKey}:${useLayoutKey()}`;
  const [sized, setSized] = useState(() => ({ key: sizeKey, height: keptSize(sizeKey) ?? 0 }));
  if (sized.key !== sizeKey) setSized({ key: sizeKey, height: keptSize(sizeKey) ?? 0 });
  const height = sized.height;

  if (!compiled || !view) {
    return (
      <View style={styles.broken}>
        <Text variant="subhead" style={styles.bold}>
          {t("blocks.brokenTitle")}
        </Text>
        <Text variant="footnote" tone="muted">
          {t("blocks.brokenBody")}
        </Text>
      </View>
    );
  }

  const tall = !screen && height > INLINE_HEIGHT;
  // Cut at the card's height, or under the cap before the first measure: a text there reads no taller than its room,
  // so a measure taken then only ever raises the height kept (`keptHeightAfter`). Kept as measured, a block with one
  // long text read short cut, showed whole, read tall and was cut again, on every layout. Opened, it has no cap at all.
  const capped = !screen && !open && (tall || height === 0);
  const openWhole = () => {
    keptOf(blockKey).open = true;
    setOpen(true);
  };
  const send = () => {
    const draft = view.send;
    if (!draft?.ready || reply.isPending) return;
    const text = draft.text;
    reply.mutate(
      { text, clientId: randomUUID() },
      {
        onSuccess: () => {
          const done = { text, at: new Date().toISOString() };
          keptOf(blockKey).sent = done;
          setSent(done);
        },
        onError: () => toast({ title: t("mobile.blocks.sendFailed"), icon: "x" }),
      },
    );
  };
  const same = sent !== null && sent.text === view.send?.text;
  const time = sent ? when.time(sent.at) : "";

  return (
    <View>
      <View style={capped ? (tall ? styles.cut : styles.unmeasured) : undefined}>
        <View
          style={styles.body}
          onLayout={(e: LayoutChangeEvent) => {
            // Under the cut a clamped text fills its room, so a reading below the cut is the parts' whole height.
            const next = keptHeightAfter(height, Math.ceil(e.nativeEvent.layout.height), capped, INLINE_HEIGHT);
            if (next === null) return;
            keepSize(sizeKey, next);
            setSized((now) => (now.key === sizeKey ? { key: sizeKey, height: next } : now));
          }}
        >
          <Parts parts={view.parts} values={values} accent={accent} />
        </View>
        {tall && !open ? (
          <LinearGradient pointerEvents="none" colors={[`${c.raised}00`, c.raised]} style={styles.fade} />
        ) : null}
      </View>
      {tall && !open ? (
        <View style={styles.more}>
          <Button variant="ghost" size="sm" icon="down" label={t("channel.long.more")} onPress={openWhole} />
        </View>
      ) : null}
      {view.send ? (
        same ? (
          <View style={[styles.foot, { borderTopColor: c.line2 }]}>
            <View style={styles.sent}>
              <View style={[styles.mark, { backgroundColor: c.ok }]} />
              <Text variant="footnote" tone="muted">
                {t("mobile.blocks.sentAt", { time })}
              </Text>
            </View>
          </View>
        ) : (
          <View style={[styles.foot, { borderTopColor: c.line2 }]}>
            <Text variant="footnote" tone="muted">
              {view.send.ready
                ? `${t("mobile.blocks.goesTo", { name: agent?.name ?? "" })} ${view.send.text}`
                : view.send.hint}
            </Text>
            <Button
              variant="primary"
              wide
              label={view.send.label}
              disabled={!view.send.ready}
              loading={reply.isPending}
              onPress={send}
            />
          </View>
        )
      ) : null}
    </View>
  );
}

function Parts({ parts, values, accent }: { parts: BlockViewPart[]; values: Values; accent: AgentColorName }) {
  return (
    <>
      {parts.map((p) => (
        <Part key={p.key} part={p} values={values} accent={accent} />
      ))}
    </>
  );
}

function Part({ part: p, values, accent }: { part: BlockViewPart; values: Values; accent: AgentColorName }) {
  const c = useColors();
  const set = (raw: unknown) => {
    const name = "name" in p ? p.name : undefined;
    if (typeof name !== "string") return;
    const v = inputValue(p, raw);
    if (v !== undefined) values.set({ [name]: v });
  };
  switch (p.kind) {
    case "heading":
      return (
        <Text variant="callout" style={styles.heading}>
          {p.text}
        </Text>
      );
    case "text":
      return (
        <Text variant="subhead" tone="ink2">
          {p.text}
        </Text>
      );
    case "note":
      return (
        <Text variant="footnote" tone="faint">
          {p.text}
        </Text>
      );
    case "list":
      return (
        <View style={styles.list}>
          {p.items.map((item, i) => (
            // Lines of one list have no id but their place.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <View key={i} style={styles.listRow}>
              <Text variant="subhead" tone="faint">
                •
              </Text>
              <Text variant="subhead" tone="ink2" style={styles.flex}>
                {item}
              </Text>
            </View>
          ))}
        </View>
      );
    case "slider":
      return (
        <View>
          <Label text={p.label} value={p.shown} />
          <Slider part={p} onChange={set} />
        </View>
      );
    case "choice":
      return (
        <View>
          {p.label ? <Label text={p.label} /> : null}
          <Segmented items={p.options.map((o) => ({ key: o, label: o }))} value={p.value ?? ""} onChange={set} />
        </View>
      );
    case "field":
      return <Field part={p} onChange={set} />;
    case "switch":
      return (
        <Pressable
          onPress={() => {
            haptics.selection();
            set(!p.value);
          }}
          accessibilityRole="switch"
          accessibilityLabel={p.label}
          accessibilityState={{ checked: p.value }}
          style={styles.switch}
        >
          <Text variant="subhead" tone="ink2" style={[styles.flex, styles.semi]}>
            {p.label}
          </Text>
          <ToggleSwitch value={p.value} />
        </Pressable>
      );
    case "stats":
      return (
        <View style={styles.stats}>
          {p.items.map((s) => (
            <View key={s.key} style={[styles.stat, { backgroundColor: c.sunken, borderColor: c.line }]}>
              <Text variant="footnote" tone="muted">
                {s.label}
              </Text>
              <Text variant="title2" numberOfLines={1} adjustsFontSizeToFit style={styles.number}>
                {s.text}
              </Text>
              {s.sub ? (
                <Text variant="caption" tone={s.tone === "up" ? "ok" : s.tone === "down" ? "danger" : "faint"}>
                  {s.sub}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      );
    case "result":
      return <Result label={p.label} text={p.text} change={p.name ? values.changes[p.name] : undefined} />;
    case "progress":
      return (
        <View>
          <Label text={p.label} value={p.text} />
          <View style={[styles.track, { backgroundColor: c.plate }]}>
            <View style={[styles.fill, { width: `${p.share * 100}%`, backgroundColor: c.ink }]} />
          </View>
        </View>
      );
    case "chart":
      return <BlockChart part={p} accent={accent} />;
    case "table":
      return (
        <Table
          header={p.columns.map((text) => [{ kind: "text", text }])}
          rows={p.rows.map((row) => row.map((text) => [{ kind: "text", text }]))}
          align={p.columns.map(() => "left")}
          surface={c.raised}
        />
      );
    case "more":
      return <More label={p.label} parts={p.parts} values={values} accent={accent} />;
    case "row":
      return (
        <View style={styles.row}>
          {p.parts.map((child) => (
            <View key={child.key} style={styles.rowItem}>
              <Part part={child} values={values} accent={accent} />
            </View>
          ))}
        </View>
      );
    case "card": {
      const inner = (
        <>
          {p.label || p.sub ? (
            <View style={styles.cardHead}>
              {p.label ? (
                <Text variant="subhead" style={styles.bold}>
                  {p.label}
                </Text>
              ) : null}
              {p.sub ? (
                <Text variant="footnote" tone="faint">
                  {p.sub}
                </Text>
              ) : null}
            </View>
          ) : null}
          <Parts parts={p.parts} values={values} accent={accent} />
        </>
      );
      const look = [
        styles.card,
        { backgroundColor: c.raised, borderColor: p.selected ? c.ink : c.line2 },
        p.selected ? styles.cardOn : null,
      ];
      if (!p.pick) return <View style={look}>{inner}</View>;
      const pick = p.pick;
      return (
        // A pick among cards: the selection's tick, not a press's tap.
        <PressScale
          to={0.98}
          haptic={false}
          fill={false}
          accessibilityRole="button"
          accessibilityState={{ selected: p.selected }}
          onPress={() => {
            haptics.selection();
            values.set({ [pick.name]: pick.value });
          }}
          style={look}
        >
          {inner}
        </PressScale>
      );
    }
    case "actions":
      return (
        <View
          style={[
            styles.actions,
            { justifyContent: p.align === "center" ? "center" : p.align === "start" ? "flex-start" : "flex-end" },
          ]}
        >
          {p.buttons.map((b) => (
            <Button
              key={b.key}
              variant={b.lead ? "primary" : "secondary"}
              size="sm"
              label={b.label}
              onPress={() => {
                if (b.set) values.set(b.set);
                if (b.draw) void values.draw(b.draw.name, b.draw.options);
              }}
            />
          ))}
        </View>
      );
  }
}

function Label({ text, value }: { text: string; value?: string }) {
  return (
    <View style={styles.label}>
      <Text variant="footnote" tone="muted" style={[styles.flex, styles.semi]}>
        {text}
      </Text>
      {value !== undefined ? (
        <Text variant="footnote" style={[styles.bold, styles.number]}>
          {value}
        </Text>
      ) : null}
    </View>
  );
}

const THUMB = 22;
/** The slider's row (`styles.slider`): its touch area reaches 44 above and below it. */
const SLIDER_H = 36;
const SLIDER_SLOP = { top: (TOUCH - SLIDER_H) / 2, bottom: (TOUCH - SLIDER_H) / 2 };

/** A share of the track (0–1) as the part's value: snapped to its step and kept within its ends. */
function stepAt(to: number, min: number, max: number, step: number) {
  "worklet";
  const exact = min + Math.round((to * (max - min)) / step) * step;
  return Number(Math.min(max, Math.max(min, exact)).toFixed(10));
}

/**
 * The kit's slider on the phone: a track that fills with ink and a cut-corner thumb, dragged sideways (a vertical
 * drag stays the conversation's scroll) or tapped. It snaps to the part's step and says each new value as it lands:
 * the step is worked out on the UI thread as the thumb moves, and only a new one reaches the screen's state.
 */
function Slider({
  part,
  onChange,
}: {
  part: Extract<BlockViewPart, { kind: "slider" }>;
  onChange: (value: number) => void;
}) {
  const c = useColors();
  const [width, setWidth] = useState(0);
  const { min, max, step, value } = part;
  const share = (value - min) / (max - min);
  const x = useSharedValue(share);
  const track = useSharedValue(0);
  const dragging = useSharedValue(false);
  // The value the thumb last said, on the UI thread: the drag tells the screen only when it changes.
  const said = useSharedValue(value);
  useEffect(() => {
    if (!dragging.value) x.value = share;
  }, [share, x, dragging]);
  const last = useRef(value);
  // A value set from elsewhere (another device, the screen reader's step) is where the next drag starts from.
  useEffect(() => {
    last.current = value;
    said.value = value;
  }, [value, said]);
  const shareNow = useRef(share);
  shareNow.current = share;
  // Let go between two steps: the thumb lands on the step the value took.
  const settle = () => {
    x.value = withTiming(shareNow.current, { duration: 120, easing: motion.easeOut });
  };
  const land = (next: number) => {
    if (next === last.current) return;
    last.current = next;
    haptics.selection();
    onChange(next);
  };
  const follow = (px: number) => {
    "worklet";
    const w = track.value;
    if (w <= 0) return;
    const to = Math.min(1, Math.max(0, (px - THUMB / 2) / Math.max(1, w - THUMB)));
    x.value = to;
    const next = stepAt(to, min, max, step);
    if (next === said.value) return;
    said.value = next;
    scheduleOnRN(land, next);
  };
  const pan = usePanGesture({
    // Sideways, once the finger clearly means it: a move up or down first fails it and the conversation scrolls.
    activeOffsetX: [-10, 10],
    failOffsetY: [-6, 6],
    maxPointers: 1,
    hitSlop: SLIDER_SLOP,
    onActivate: (e) => {
      "worklet";
      dragging.value = true;
      follow(e.x);
    },
    onUpdate: (e) => {
      "worklet";
      follow(e.x);
    },
    onDeactivate: () => {
      "worklet";
      dragging.value = false;
      scheduleOnRN(settle);
    },
  });
  const tap = useTapGesture({
    hitSlop: SLIDER_SLOP,
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      follow(e.x);
      scheduleOnRN(settle);
    },
  });
  const gesture = useExclusiveGestures(pan, tap);
  const fill = useAnimatedStyle(() => ({ width: THUMB / 2 + x.value * Math.max(0, track.value - THUMB) }));
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * Math.max(0, track.value - THUMB) }] }));
  const nudge = (by: number) => onChange(Math.min(max, Math.max(min, Number((value + by).toFixed(10)))));
  return (
    <GestureDetector gesture={gesture}>
      <View
        // 44 points to the finger over a 36-point row (the gestures' own slop reaches past it only on Android).
        hitSlop={SLIDER_SLOP}
        style={styles.slider}
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
          track.value = e.nativeEvent.layout.width;
        }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={part.label}
        accessibilityValue={{ text: part.shown }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === "increment" ? step : -step)}
      >
        <View style={[styles.rail, { backgroundColor: c.line2 }]} />
        {width > 0 ? (
          <>
            <Animated.View style={[styles.rail, { backgroundColor: c.ink }, fill]} />
            <Animated.View style={[styles.thumb, { borderColor: c.line2 }, thumb]} />
          </>
        ) : null}
      </View>
    </GestureDetector>
  );
}

function Field({
  part,
  onChange,
}: {
  part: Extract<BlockViewPart, { kind: "field" }>;
  onChange: (value: string) => void;
}) {
  const big = part.input === "textarea";
  // The app's text field: one line, or a few for a long answer.
  return (
    <View>
      <Label text={part.label} />
      <TextArea
        value={part.value}
        onChangeText={onChange}
        placeholder={part.placeholder}
        multiline={big}
        minHeight={big ? 88 : 44}
        keyboardType={part.input === "number" ? "decimal-pad" : "default"}
        accessibilityLabel={part.label}
      />
    </View>
  );
}

function More({
  label,
  parts,
  values,
  accent,
}: {
  label: string;
  parts: BlockViewPart[];
  values: Values;
  accent: AgentColorName;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <View>
      {/* Its chevron says which way it goes; the text lines up with the block's (a button's own inset taken back). */}
      <View style={styles.moreHead}>
        <Button
          variant="ghost"
          size="sm"
          icon={open ? "chev" : "right"}
          label={label || t("mobile.blocks.more")}
          onPress={() => setOpen((o) => !o)}
        />
      </View>
      {open ? (
        <View style={styles.moreBody}>
          <Parts parts={parts} values={values} accent={accent} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The block's answer, large. A value the server just drew rolls into place, the same moment for everyone; the tap of
 * success only on the phone of who drew it.
 */
function Result({ label, text, change }: { label: string; text: string; change: BlockChange | undefined }) {
  const c = useColors();
  const meId = useRowMeId();
  const reduced = useReducedMotion();
  const y = useSharedValue(0);
  const fade = useSharedValue(1);
  const first = useRef(true);
  const drawnAt = change?.drawn ? change.at : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new draw is a new `at`
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!drawnAt) return;
    if (change?.by === meId) haptics.success();
    if (reduced) return;
    // In from above on the app's ease-out, no bounce: nothing was thrown.
    y.value = withSequence(withTiming(-28, { duration: 0 }), withTiming(0, { duration: 260, easing: motion.easeOut }));
    fade.value = withSequence(withTiming(0, { duration: 0 }), withTiming(1, { duration: 260, easing: motion.easeOut }));
  }, [drawnAt]);
  const rolled = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }], opacity: fade.value }));
  return (
    <View style={[styles.result, { backgroundColor: c.sunken, borderColor: c.line }]}>
      <Text variant="footnote" tone="muted">
        {label}
      </Text>
      <Animated.View style={rolled}>
        <Text variant="title2" style={styles.number} accessibilityLiveRegion="polite">
          {text}
        </Text>
      </Animated.View>
    </View>
  );
}

/** A chart in the block, drawn like a message's chart. Too few points to draw shows nothing. */
function BlockChart({ part, accent }: { part: Extract<BlockViewPart, { kind: "chart" }>; accent: AgentColorName }) {
  const values = part.chart === "pie" ? part.values.map((v) => Math.max(0, v)) : part.values;
  const spec: ChartSpec = {
    type: part.chart,
    title: part.label,
    labels: part.labels,
    series: [{ name: "", values }],
    ...(part.unit ? { unit: part.unit } : {}),
  };
  const enough =
    part.chart === "bar"
      ? values.length >= 1
      : values.length >= 2 && (part.chart !== "pie" || values.some((v) => v > 0));
  if (!enough) return null;
  return (
    <View>
      {part.label ? <Label text={part.label} /> : null}
      <ChartView spec={spec} accent={accent} still />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14, paddingHorizontal: 14, paddingTop: 6, paddingBottom: 14 },
  cut: { height: INLINE_HEIGHT, overflow: "hidden" },
  unmeasured: { maxHeight: INLINE_HEIGHT + PAST_RULE, overflow: "hidden" },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 56 },
  // "Ver mais" centred under the cut (a button keeps to its own width at the row's start).
  more: { flexDirection: "row", justifyContent: "center", paddingBottom: 8 },
  foot: { gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
  sent: { flexDirection: "row", alignItems: "center", gap: 8 },
  mark: { width: 5, height: 5 },
  broken: { gap: 2, padding: 14 },
  bold: { fontWeight: "600" },
  semi: { fontWeight: "500" },
  heading: { fontWeight: "600" },
  flex: { flex: 1 },
  number: { fontVariant: ["tabular-nums"], fontWeight: "600" },
  list: { gap: 2 },
  listRow: { flexDirection: "row", gap: 8 },
  label: { flexDirection: "row", alignItems: "baseline", gap: 12, marginBottom: 6 },
  slider: { height: SLIDER_H, justifyContent: "center" },
  rail: { position: "absolute", left: 0, height: 6, borderRadius: 999, right: 0 },
  thumb: {
    position: "absolute",
    left: 0,
    width: THUMB,
    height: THUMB,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
    borderBottomLeftRadius: 3,
    backgroundColor: "#ffffff",
    borderWidth: StyleSheet.hairlineWidth,
    boxShadow: "0px 2px 5px 0px rgba(23, 23, 22, 0.2)",
  },
  switch: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 36 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  stat: {
    flexGrow: 1,
    flexBasis: 96,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  result: {
    alignItems: "center",
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 12,
    borderRadius: 14,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  track: { height: 8, borderRadius: 999, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 999 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  rowItem: { flexGrow: 1, flexBasis: 140, gap: 12 },
  card: {
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardOn: { borderWidth: 1.6 },
  cardHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  moreHead: { flexDirection: "row", marginLeft: -12 },
  moreBody: { gap: 10, marginTop: 6 },
});
