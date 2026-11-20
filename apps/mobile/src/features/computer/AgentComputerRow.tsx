import {
  asksPicture,
  isWaitingHandoff,
  PICTURE_IDLE_MS,
  useBrowserHandoffActions,
  useComputerSetup,
  useDesktopPicture,
} from "@agenteschat/client";
import { entryKind, entryLine, entryPortrait, entryState, pictureWhen } from "@agenteschat/client/lib/agent-computer";
import { computerName } from "@agenteschat/client/lib/computer";
import type { Seat } from "@agenteschat/client/lib/seat";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Image } from "expo-image";
import { useIsFocused } from "expo-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { useOrg } from "@/providers/org";
import { ComputerSky, GROUPED_ROW, GroupedRow, usePulse, useTheme, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { AgentFace } from "../shared/Face";
import { useDirectory, useNow } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { phoneEntryButton } from "./logic";
import { useSetupWait } from "./SetupWait";
import { useAgentComputer } from "./useAgentComputer";

/**
 * Opens an agent's computer full screen. `seat`: the right hand's shared place on the workspace's computer instead
 * of the viewer's own (ADR 0175).
 */
export const openComputer = (agentId: string, seat?: Seat) =>
  router.push(seat ? { pathname: "/computer/[agentId]", params: { agentId, seat } } : `/computer/${agentId}`);

/**
 * The agent's computer on its profile, one card above its views (it reads first, whichever view is open): a frame on
 * top, and under it a row with its name and the entry's status line ("On · working now"), which a button's
 * one word couldn't carry, with when the picture was taken at its end. The frame holds the last picture of its screen
 * when there is one and this person may see it; until then the computer itself, as the web's entry draws it: its kind
 * (a Mac, a PC, the workspace's server) lit, dimmed or dark with its state, on the agent's own sky, as its screen opens
 * on (no computer yet: the agent at rest, as its screen says it). While its facts load, the card's shape, so nothing
 * jumps in under the head; nothing for whoever may not watch it, and never one edition's words before the other's.
 * On a request of the agent's for this person the row says "Help" and helps (takes control, then opens): the word is
 * the signal, no dot. The picture is asked for only while the screen is in view; it never opens a stream.
 */
export function AgentComputerCard({ agentId, style }: { agentId: string; style?: StyleProp<ViewStyle> }) {
  const { t, i18n } = useTranslation();
  const { org, orgId } = useOrg();
  const { colors, shadows } = useTheme();
  const dir = useDirectory();
  const toast = useToast();
  const actions = useBrowserHandoffActions(orgId);
  const focused = useIsFocused();
  const view = useAgentComputer(agentId, focused ? PICTURE_IDLE_MS : false);
  // The same query the view reads its edition from: failed, there is nothing true to say, and no shape to hold.
  const setupFailed = useComputerSetup(orgId).isError;
  const wait = useSetupWait(view.setup);
  const f = view.facts;
  const asks = !view.forbidden && asksPicture(focused, view.desktopQ.data ?? null);
  const shot = useDesktopPicture(orgId, agentId, { enabled: asks, working: Boolean(f?.working) });
  // A request's minutes left move on too. While the computer is on its way, the time every other line reads.
  const requestNow = useNow(f?.handoff && isWaitingHandoff(f.handoff) ? 15_000 : 60_000);
  // One source per picture, never cached: each picture is shown once and replaced by the next.
  const shotData = asks ? shot.data?.picture?.data : undefined;
  const source = useMemo(() => (shotData ? { uri: `data:image/jpeg;base64,${shotData}` } : null), [shotData]);
  const surface = { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` };
  if (view.forbidden) return null;
  if (!view.ready || !f) return setupFailed ? null : <CardShape style={[styles.card, surface, style]} />;
  const now = wait.now ?? requestNow;
  const state = entryState(f, now);
  const line = entryLine(t, state, {
    edition: f.edition,
    locale: i18n.language,
    computer: computerName(t, org?.name ?? "", view.machine, isPersonal(org)),
    lastSeenAt: view.machine?.lastSeenAt ?? null,
    person: (id) => dir.nameOf({ type: "person", id }) || t("channel.unknownPerson"),
    step: null,
    emailPromised: wait.emailed,
    now: new Date(now),
  });
  const helps = phoneEntryButton(state) === "help";
  const open = () => openComputer(agentId);
  const help = async () => {
    if (state.kind !== "needsYou") return;
    try {
      await actions.takeControl(state.handoff.id);
      openComputer(agentId);
    } catch (err) {
      toast({
        title: (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"),
        icon: "x",
      });
    }
  };
  const press = helps ? () => void help() : open;
  const picture = asks ? shot.data?.picture : null;
  return (
    // The lists' own card (`GroupedList`'s corner and relief), at the page's width as every list under it.
    <View style={[styles.card, surface, style]}>
      {/* The frame opens the computer too; the row under it is what a screen reader hears. */}
      <Pressable onPress={press} accessible={false} style={[styles.frame, { borderBottomColor: colors.line2 }]}>
        {picture ? (
          <Image
            source={source}
            cachePolicy="none"
            contentFit="cover"
            contentPosition="left top"
            style={StyleSheet.absoluteFill}
            accessible={false}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.still, { backgroundColor: colors.sunken }]}>
            <ComputerSky color={agentLook(dir.anyAgent(agentId)).color} style={StyleSheet.absoluteFill} />
            {state.kind === "noComputer" ? (
              <AgentFace agentId={agentId} size={44} framed={false} live={false} mode="rest" />
            ) : (
              // One still frame (lit, dimmed or dark): the sky behind it already moves, on the UI thread, and a
              // living portrait would redraw from React all the while the page is read and scrolled.
              <ComputerPortrait
                kind={entryKind(f.edition, view.machine)}
                state={entryPortrait(state, f.setup)}
                size={96}
                live={false}
              />
            )}
          </View>
        )}
      </Pressable>
      <GroupedRow
        icon="laptop"
        label={helps ? t("agentComputer.help") : t("agentComputer.button")}
        {...(line ? { sub: line, subLines: 2 } : {})}
        {...(picture ? { value: pictureWhen(t, i18n.language, picture.capturedAt, new Date(now)) } : {})}
        chevron
        onPress={press}
      />
    </View>
  );
}

/**
 * The card's shape while what it says loads: the frame and a row's tile and two lines, pulsing together as the lists'
 * own skeleton, so the card comes in where its shape already was.
 */
function CardShape({ style }: { style: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  const pulse = usePulse();
  const bone = { backgroundColor: colors.sunken };
  return (
    <View style={style} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={pulse}>
        <View style={[styles.frame, bone, { borderBottomColor: colors.line2 }]} />
        <View style={styles.shapeRow}>
          <View style={styles.shapeLead}>
            <View style={[styles.shapeTile, bone]} />
          </View>
          <View style={styles.shapeText}>
            <View style={[styles.shapeBar, styles.shapeName, bone]} />
            <View style={[styles.shapeBar, styles.shapeLine, bone]} />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

/** A grouped row's icon tile (32, its corner 30%), as `GroupedRow` draws it. */
const TILE = 32;

const styles = StyleSheet.create({
  card: { borderRadius: 14, overflow: "hidden" },
  // The screen's own proportions (the web's entry too): a picture fills it from its top left corner.
  frame: { width: "100%", aspectRatio: 16 / 10, borderBottomWidth: StyleSheet.hairlineWidth },
  still: { alignItems: "center", justifyContent: "center" },
  // A row with a small line under its label: the grouped rows' 16 at the sides, 10 above and below.
  shapeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.padY,
  },
  shapeLead: { width: GROUPED_ROW.lead, alignItems: "center" },
  shapeTile: { width: TILE, height: TILE, borderRadius: Math.round(TILE * 0.3) },
  shapeText: { flex: 1, minWidth: 0, gap: 8 },
  shapeBar: { borderRadius: 6 },
  // Where the 17-point label and the 13-point line sit.
  shapeName: { height: 14, width: "34%" },
  shapeLine: { height: 12, width: "62%" },
});
