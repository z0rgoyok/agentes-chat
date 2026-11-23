import { type Routine, useCalendar } from "@agenteschat/client";
import { clockHour, dateFormat, whenAt } from "@agenteschat/client/lib/format";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, RowPressable, Text } from "@/ui";
import { CellCanvas } from "../browser/TrailPixels";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { useSurface } from "../shared/parts";
import {
  futureRuns,
  HORIZON_AGENTS,
  HORIZON_AHEAD,
  HORIZON_BACK,
  type HorizonAgent,
  horizonAgents,
  horizonLanes,
  horizonPos,
  horizonRange,
  horizonTicks,
  laneTag,
  routineTitle,
} from "./logic";
import { LaneTrack } from "./RunPixels";
import { LANE_ROWS, laneWidth, RUN_CELL, SPRITE, spriteX } from "./run-pixels";

/** The lanes' label column: the agent's face, as each section's head below draws it. */
const LABEL = 32;
const LANE_H = LANE_ROWS * RUN_CELL;
const LANE_GAP = 4;
const SCALE_H = 18;
/** A tick's box on the scale, centered on its time. */
const TICK = 56;
/** Room under the lanes for the "agora" tag. */
const BOTTOM = 30;
/** Past this share of the track the tag goes before the agent, so it never runs off the card. */
const TAG_BEFORE = 0.6;
/** Between the agent and its tag. */
const TAG_GAP = 4;

type Tag = NonNullable<ReturnType<typeof laneTag>>;

/**
 * "Próximas 20 horas", the web's horizon on the phone: one lane per agent (the list under it is broken the same way),
 * its last runs in pixels, its coming runs as pixels and the agent itself on the next one, tagged with its time (or
 * "em 10 min") and the routine's name; "agora" as a dotted pixel line. The agents at work and running soonest come
 * first; past four, "Mostrar todos" shows the rest. The coming runs come from the calendar (the server's schedule
 * math). A lane opens the agent's next routine.
 */
export const RoutineHorizon = memo(function RoutineHorizon({
  routines,
  now,
  open,
}: {
  routines: readonly Routine[];
  now: number;
  /** Opens a routine (a widget's, its widget). */
  open: (routine: Routine) => void;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const surface = useSurface();
  const [width, setWidth] = useState(0);
  const [all, setAll] = useState(false);
  // The window moves with the minute; the coming runs are asked once an hour (the calendar caches by start).
  const hour = Math.floor(now / 3_600_000);
  const range = useMemo(() => horizonRange(new Date(hour * 3_600_000)), [hour]);
  const slots = useCalendar(orgId, range.from, range.to);
  const scheduled = horizonLanes(routines);
  if (scheduled.length === 0) return null;
  const at = new Date(now);
  const from = new Date(now - HORIZON_BACK);
  const to = new Date(now + HORIZON_AHEAD);
  const futureOf = (r: Routine) => futureRuns(r, slots.data?.routines ?? [], at, to);
  const { agents, idle } = horizonAgents(scheduled, futureOf, from, at);
  const shown = all ? agents : agents.slice(0, HORIZON_AGENTS);
  const hidden = agents.length - shown.length;
  const hours = HORIZON_AHEAD / 3_600_000;
  const later = scheduled.filter((r) => futureOf(r).length === 0).length;
  const track = Math.max(0, width - LABEL);
  const nowX = track * horizonPos(at, from, to);
  const time = (iso: string | Date) =>
    dateFormat(i18n.language, { hour: clockHour(i18n.language), minute: "2-digit" }).format(new Date(iso));
  const weekday = (d: Date) => dateFormat(i18n.language, { weekday: "short" }).format(d).replace(/\./g, "");
  const tagText = (tag: Tag) => (tag.kind === "soon" ? t("format.inMinutes", { count: tag.minutes }) : time(tag.at));
  const sub = [
    t("routines.horizon.lanes", { count: scheduled.length }),
    later > 0 ? t("routines.horizon.later", { count: later }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const rest = [
    hidden > 0 ? t("routines.horizon.restLater", { count: hidden }) : null,
    idle > 0 ? t("routines.horizon.restIdle", { count: idle, hours }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={[styles.card, surface]}>
      <View style={styles.head}>
        <Text variant="footnote" tone="ink2" style={styles.bold} accessibilityRole="header">
          {t("routines.horizon.title", { count: hours })}
        </Text>
        <Text variant="caption" tone="faint">
          {sub}
        </Text>
      </View>
      {shown.length > 0 ? (
        <View style={styles.body} onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
          {track > 0 ? (
            <>
              <View style={styles.scale} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {horizonTicks(from, to, at).map((k) => (
                  <Text
                    key={k.at.getTime()}
                    variant="caption"
                    tone={k.day ? "ink2" : "faint"}
                    numberOfLines={1}
                    style={[styles.tick, k.day ? styles.bold : null, { left: LABEL + track * k.pos - TICK / 2 }]}
                  >
                    {k.day ? weekday(k.at) : time(k.at)}
                  </Text>
                ))}
              </View>
              {shown.map((a) => (
                <Lane
                  key={a.agentId}
                  agent={a}
                  track={track}
                  from={from}
                  to={to}
                  now={now}
                  tagText={tagText}
                  open={open}
                />
              ))}
              <NowLine
                left={LABEL + nowX}
                height={shown.length * (LANE_H + LANE_GAP)}
                label={t("routines.horizon.now")}
              />
            </>
          ) : null}
        </View>
      ) : null}
      {rest ? (
        <View style={styles.rest}>
          <Text variant="caption" tone="faint" style={styles.grow}>
            {rest.charAt(0).toLocaleUpperCase(i18n.language) + rest.slice(1)}
          </Text>
          {hidden > 0 ? (
            <Button size="sm" variant="ghost" label={t("routines.horizon.showAll")} onPress={() => setAll(true)} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

/**
 * An agent's lane: its face, then the track with the agent on its next run and that run's time and routine beside it
 * (before it past the track's middle, so it stays on the card). It opens that routine.
 */
function Lane({
  agent: a,
  track,
  from,
  to,
  now,
  tagText,
  open,
}: {
  agent: HorizonAgent<Routine>;
  track: number;
  from: Date;
  to: Date;
  now: number;
  tagText: (tag: Tag) => string;
  open: (routine: Routine) => void;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const name = dir.nameOf({ type: "agent", id: a.agentId }) || t("channel.unknownAgent");
  const next = a.next;
  const tag = laneTag(next?.at, a.running, new Date(now));
  const what = next
    ? next.together > 0
      ? t("routines.horizon.andMore", { name: routineTitle(next.routine), count: next.together })
      : routineTitle(next.routine)
    : "";
  // Where the agent stands on the track, in points: the tag after it, or before it near the track's end.
  const cells = laneWidth(track);
  const x = spriteX(cells, from, to, new Date(now), a.future, a.running);
  const cx = track / cells;
  const before = x !== null && x / cells > TAG_BEFORE;
  const start = x === null ? 0 : (x - 4) * cx;
  const end = x === null ? 0 : (x - 4 + SPRITE) * cx;
  const place = before
    ? { right: track - start + TAG_GAP, maxWidth: start - TAG_GAP }
    : { left: end + TAG_GAP, maxWidth: track - end - TAG_GAP };
  const target = next?.routine ?? a.routines[0];
  const label = next
    ? `${t("routines.horizon.lane", { name, when: whenAt(t, i18n.language, next.at) })}, ${what}`
    : t("routines.horizon.laneNone", { name });
  return (
    <RowPressable
      radius={6}
      hold
      onPress={target ? () => open(target) : undefined}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.lane}
    >
      <View style={styles.label}>
        <AgentFace agentId={a.agentId} size={24} live={false} />
      </View>
      <View style={[styles.track, { width: track }]}>
        <LaneTrack
          width={track}
          from={from.getTime()}
          to={to.getTime()}
          now={now}
          past={a.past}
          future={a.future}
          look={agentLook(dir.agentById.get(a.agentId))}
          running={a.running}
        />
        {tag && x !== null ? (
          <Text
            variant="caption"
            tone="ink2"
            numberOfLines={1}
            style={[styles.tag, place, before ? styles.tagBefore : null]}
          >
            <Text variant="caption" style={[styles.bold, { color: tag.kind === "soon" ? c.ink : c.ink2 }]}>
              {tagText(tag)}
            </Text>
            {what ? ` · ${what}` : ""}
          </Text>
        ) : null}
      </View>
    </RowPressable>
  );
}

/** "agora": a pixel line (2 points on, 2 off) down the lanes, with its tag under them. */
function NowLine({ left, height, label }: { left: number; height: number; label: string }) {
  const c = useColors();
  const n = Math.max(1, Math.floor(height / 4));
  const runs = useMemo(
    () => [{ color: c.ink, cells: Array.from({ length: n }, (_, i) => [0, i * 2]).flat() }],
    [c.ink, n],
  );
  return (
    <View
      pointerEvents="none"
      style={[styles.now, { left: left - 1 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <CellCanvas runs={runs} width={2} height={n * 4} cx={2} cy={2} />
      <View style={[styles.nowTag, { top: n * 4 + 4 }]}>
        <View style={[styles.nowPill, { backgroundColor: c.ink }]}>
          <Text variant="caption" style={[styles.bold, { color: c.bg }]}>
            {label}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // A card in the list's column, with a grouped list's corner: its sides line up with the sections under it.
  card: { marginTop: 4, paddingTop: 12, paddingHorizontal: 12, borderRadius: 14 },
  head: { gap: 2, marginBottom: 6 },
  bold: { fontWeight: "600" },
  grow: { flex: 1, minWidth: 0 },
  body: { paddingBottom: BOTTOM },
  scale: { height: SCALE_H },
  tick: { position: "absolute", top: 0, width: TICK, textAlign: "center" },
  lane: { flexDirection: "row", alignItems: "center", height: LANE_H, marginBottom: LANE_GAP, borderRadius: 6 },
  label: { width: LABEL, alignItems: "flex-start", justifyContent: "center" },
  track: { height: LANE_H, overflow: "hidden" },
  tag: { position: "absolute", top: (LANE_H - 16) / 2 },
  tagBefore: { textAlign: "right" },
  now: { position: "absolute", top: SCALE_H },
  nowTag: { position: "absolute", left: -29, width: 60, alignItems: "center" },
  nowPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  rest: { flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 8 },
});
