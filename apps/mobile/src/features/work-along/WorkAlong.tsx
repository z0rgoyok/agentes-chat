import { useTaskManager } from "@agenteschat/client";
import { markedPieces, markInk } from "@agenteschat/client/lib/activity";
import { taskTitle, todayStart } from "@agenteschat/client/lib/task-manager";
import type { WorkItem } from "@agenteschat/client/lib/working";
import { useIsFocused } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Platform, Pressable, StyleSheet, View } from "react-native";
import Animated, { SlideInDown, SlideOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LivePause } from "@/agent/live";
import { haptics, PixelOrbit, Text, useReducedMotion, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { useWaitingItems } from "../chats/useWaitingItems";
import { chooseAction } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { useActiveWork } from "../shared/queries";
import { askToStop, useStopper } from "../task-manager/hooks";
import {
  ALONG_STRIP,
  alongHref,
  alongRunId,
  alongStripBottom,
  alongWords,
  alongWork,
  givesWay,
  runMenuItems,
  workAlong,
} from "./logic";

/** How often the line looks again at how long each piece of work has gone on (a run shows once it is long). */
const ALONG_TICK_MS = 15_000;

/**
 * One clock for the line and for whether there is one: the tabs' layout and the line read the same moment, so the
 * layout never holds a place for a line that isn't there yet. It ticks only while something listens and the app is in
 * use; back in front it reads the time at once, as work may have grown long meanwhile.
 */
const alongClock = (() => {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  let appSub: { remove(): void } | null = null;
  const listeners = new Set<() => void>();
  const tick = () => {
    now = Date.now();
    for (const l of [...listeners]) l();
  };
  // `again`: coming back from the background, the time kept is old; on the first listener it is just read.
  const follow = (again: boolean, app: string | null | undefined = AppState.currentState) => {
    const run = listeners.size > 0 && app !== "background" && app !== "inactive";
    if (run && timer === null) {
      if (again) tick();
      else now = Date.now();
      timer = setInterval(tick, ALONG_TICK_MS);
    } else if (!run && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  return {
    now: () => now,
    subscribe(listener: () => void) {
      listeners.add(listener);
      appSub ??= AppState.addEventListener("change", (state) => follow(true, state));
      follow(false);
      return () => {
        listeners.delete(listener);
        follow(false);
        if (listeners.size === 0) {
          appSub?.remove();
          appSub = null;
        }
      };
    },
  };
})();

/** The work the line may show (`alongWork`): mine to answer first, then the rest. */
function useAlongPool() {
  const mine = useWaitingItems().items;
  const work = useActiveWork();
  return useMemo(() => alongWork(work, mine), [work, mine]);
}

/** The work the line carries across the tabs, or null: the accessory and the tab roots' strip read it. */
export function useWorkAlong() {
  const pool = useAlongPool();
  return workAlong(pool, useSyncExternalStore(alongClock.subscribe, alongClock.now));
}

/**
 * Whether there is a line at all, for the tabs' layout: it changes only when a line comes or goes, so the layout (and
 * the system tab bar it draws) isn't drawn again at every tick of the line's clock.
 */
export function useHasWorkAlong(): boolean {
  const pool = useAlongPool();
  return useSyncExternalStore(alongClock.subscribe, () => workAlong(pool, alongClock.now()) !== null);
}

/**
 * The line that goes with you, the phone's Agora: who works and on what ("Atlas · ajudando a Ada"), with the orbit in
 * their tones, or "Theo · esperando você" in amber; "+2" when more are at it. A tap opens that work's place, or the
 * task manager when there are several. A long press offers "Ver passos" and "Parar" for a run the task manager shows
 * the reader, else opens its place. `inline`: the short copy beside iOS 26's folded tab bar.
 */
export function WorkAlongLine({ lead, others, inline = false }: { lead: WorkItem; others: number; inline?: boolean }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const dir = useDirectory();
  const runMenu = useRunMenu();
  // Its face and orbit move only while the screen it is on shows (a tab root's strip, or the tabs under a pushed
  // screen for the accessory).
  const focused = useIsFocused();
  const agent = dir.anyAgent(lead.agentId);
  // An agent the directory doesn't know yet (just made, or gone) still reads as a sentence.
  const name = agent?.name ?? t("mobile.along.agent");
  const forName = lead.forAgentId ? dir.anyAgent(lead.forAgentId)?.name : undefined;
  const words = alongWords(t, lead, name, forName);
  // A long name or title gives way ("…"), the words between them and a short name stay whole: "Ada · ajudando o
  // Bartolomeu…".
  const pieces = markedPieces(alongWords(t, lead, name, forName, markInk));
  const runId = alongRunId(lead);
  return (
    <LivePause paused={!focused}>
      <Pressable
        onPress={() => router.push(alongHref(lead, others))}
        onLongPress={runId ? () => void runMenu(lead, runId, words) : undefined}
        accessibilityRole="button"
        accessibilityLabel={others > 0 ? `${words}, ${t("mobile.along.more", { count: others })}` : words}
        style={({ pressed }) => [styles.row, inline && styles.inline, pressed && styles.pressed]}
      >
        <AgentFace agentId={lead.agentId} size={24} mode={lead.waiting ? "idle" : "run"} live />
        <View style={styles.words}>
          {pieces.map((p, i) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
              key={i}
              variant="subhead"
              numberOfLines={1}
              style={[
                givesWay(p) ? styles.give : styles.keep,
                lead.waiting ? { color: colors.amber, fontWeight: "600" } : null,
              ]}
            >
              {p.text}
            </Text>
          ))}
        </View>
        {!inline ? (
          <View style={styles.end}>
            {lead.waiting ? null : <PixelOrbit color={agentLook(agent).color} size={14} />}
            {others > 0 ? (
              <Text variant="footnote" tone="muted" style={styles.count}>
                {t("mobile.along.more", { count: others })}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </LivePause>
  );
}

/**
 * iOS 26's tab bar accessory: the system draws two copies, the full line over the bar and a short one beside it. It
 * reads the line itself, so its clock redraws only it.
 */
export function AccessoryLine() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const along = useWorkAlong();
  if (!along) return null;
  return <WorkAlongLine lead={along.lead} others={along.others} inline={placement === "inline"} />;
}

/**
 * Android and iOS before 26 (no accessory there): the same line in a 48-point strip on the tab bar's top edge, on the
 * tab roots, sliding up from behind the bar. The lists keep its height at their end (`ALONG_STRIP`). It reads the line
 * itself, so its clock redraws only it.
 */
export function AlongStrip() {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const safe = useSafeAreaInsets();
  const along = useWorkAlong();
  if (!along) return null;
  return (
    <View pointerEvents="box-none" style={[styles.room, { bottom: alongStripBottom(Platform.OS, safe.bottom) }]}>
      <Animated.View
        entering={reduced ? undefined : SlideInDown.duration(200)}
        exiting={reduced ? undefined : SlideOutDown.duration(200)}
        style={[styles.strip, { backgroundColor: colors.raised, borderTopColor: colors.line }]}
      >
        <WorkAlongLine lead={along.lead} others={along.others} />
      </Animated.View>
    </View>
  );
}

/**
 * A long press on the line: "Ver passos" (the task's screen) and, for who may, "Parar" with the system's confirm, from
 * the task manager's list (asked again unless it was read in the last half minute). A run that list doesn't show the
 * reader opens its place instead (`runMenuItems`).
 */
function useRunMenu() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const tasks = useTaskManager(orgId, { since: todayStart(), enabled: false, pollMs: false });
  const { stop } = useStopper();
  return async (lead: WorkItem, runId: string, words: string) => {
    haptics.selection();
    const fresh = Date.now() - tasks.dataUpdatedAt < 30_000;
    const view = fresh ? tasks.data : (await tasks.refetch()).data;
    const task = view?.tasks.find((x) => x.runId === runId);
    const items = runMenuItems(task);
    if (items.length === 0 || !task) {
      router.push(alongHref(lead, 0));
      return;
    }
    const name = dir.anyAgent(task.agentId)?.name || t("mobile.along.agent");
    chooseAction(
      words,
      items.map((item) =>
        item === "steps"
          ? {
              icon: "list" as const,
              label: t("taskManager.actions.steps"),
              onPress: () => router.push(`/task-manager/${runId}`),
            }
          : {
              icon: "stop" as const,
              label: t("taskManager.actions.stop"),
              destructive: true,
              onPress: () => askToStop(t, task, taskTitle(t, task), name, stop),
            },
      ),
      t("mobile.common.cancel"),
    );
  };
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16 },
  inline: { paddingHorizontal: 12, gap: 8 },
  pressed: { opacity: 0.6 },
  words: { flex: 1, minWidth: 0, flexDirection: "row" },
  give: { flexShrink: 1 },
  keep: { flexShrink: 0 },
  end: { flexDirection: "row", alignItems: "center", gap: 8 },
  count: { fontVariant: ["tabular-nums"] },
  // Clips the strip while it slides up from behind the tab bar.
  room: { position: "absolute", left: 0, right: 0, height: ALONG_STRIP, overflow: "hidden" },
  strip: { height: ALONG_STRIP, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row" },
});
