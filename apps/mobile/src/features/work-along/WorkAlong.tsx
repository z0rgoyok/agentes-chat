import { useTaskManager } from "@agenteschat/client";
import { markedPieces, markInk } from "@agenteschat/client/lib/activity";
import { taskTitle, todayStart } from "@agenteschat/client/lib/task-manager";
import type { WorkItem } from "@agenteschat/client/lib/working";
import { NativeTabs } from "expo-router/native-tabs";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import Animated, { SlideInDown, SlideOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptics, PixelOrbit, Text, useReducedMotion, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { useWaitingItems } from "../chats/useWaitingItems";
import { AgentFace } from "../shared/Face";
import { useDirectory, useNow, useOrgId } from "../shared/hooks";
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

/** The work the line carries across the tabs, or null: the layout's accessory and the tab roots' strip read it. */
export function useWorkAlong() {
  const mine = useWaitingItems().items;
  const work = useActiveWork();
  return workAlong(alongWork(work, mine), useNow(15_000));
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
  );
}

/** iOS 26's tab bar accessory: the system draws two copies, the full line over the bar and a short one beside it. */
export function AccessoryLine({ lead, others }: { lead: WorkItem; others: number }) {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  return <WorkAlongLine lead={lead} others={others} inline={placement === "inline"} />;
}

/**
 * Android and iOS before 26 (no accessory there): the same line in a 48-point strip on the tab bar's top edge, on the
 * tab roots, sliding up from behind the bar. The lists keep its height at their end (`ALONG_STRIP`).
 */
export function AlongStrip({ lead, others }: { lead: WorkItem; others: number }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const safe = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.room, { bottom: alongStripBottom(Platform.OS, safe.bottom) }]}>
      <Animated.View
        entering={reduced ? undefined : SlideInDown.duration(200)}
        exiting={reduced ? undefined : SlideOutDown.duration(200)}
        style={[styles.strip, { backgroundColor: colors.raised, borderTopColor: colors.line }]}
      >
        <WorkAlongLine lead={lead} others={others} />
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
    showMenu(
      t,
      words,
      items.map((item) =>
        item === "steps"
          ? { label: t("taskManager.actions.steps"), run: () => router.push(`/task-manager/${runId}`) }
          : {
              label: t("taskManager.actions.stop"),
              danger: true,
              run: () => askToStop(t, task, taskTitle(t, task), name, stop),
            },
      ),
    );
  };
}

/** The system's own menu: an action sheet on iOS, an alert's buttons on Android. */
function showMenu(t: TFunction, title: string, items: { label: string; danger?: boolean; run: () => void }[]) {
  if (Platform.OS === "ios") {
    const danger = items.findIndex((i) => i.danger);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...items.map((i) => i.label), t("mobile.common.cancel")],
        cancelButtonIndex: items.length,
        ...(danger >= 0 ? { destructiveButtonIndex: danger } : {}),
      },
      (i) => items[i]?.run(),
    );
    return;
  }
  Alert.alert(title, undefined, [
    { text: t("mobile.common.cancel"), style: "cancel" },
    ...items.map((i) => ({
      text: i.label,
      style: i.danger ? ("destructive" as const) : ("default" as const),
      onPress: i.run,
    })),
  ]);
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
