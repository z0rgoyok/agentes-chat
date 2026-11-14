import {
  asksPicture,
  isWaitingHandoff,
  PICTURE_IDLE_MS,
  useBrowserHandoffActions,
  useDesktopPicture,
} from "@agenteschat/client";
import { entryLine, entryState, pictureWhen } from "@agenteschat/client/lib/agent-computer";
import { computerName } from "@agenteschat/client/lib/computer";
import type { Seat } from "@agenteschat/client/lib/seat";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Image } from "expo-image";
import { useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedRow, useTheme, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useDirectory, useNow } from "../shared/hooks";
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
 * The agent's computer on its profile, one card in Hoje: the last picture of its screen on top, when there is one and
 * this person may see it, and under it a row with its name and the entry's status line ("Ligado · trabalhando agora"),
 * which a button's one word couldn't carry, with when the picture was taken at its end. Without a picture (the computer
 * off, none yet) the row alone, the same card. Only for whoever may watch the computer, the wait included; nothing
 * while that loads. On a request of the agent's for this person the row says "Ajudar" and helps (takes control, then
 * opens): the word is the signal, no dot. The picture is asked for only while the screen is in view; it never opens a
 * stream.
 */
export function AgentComputerCard({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { org, orgId } = useOrg();
  const { colors, shadows } = useTheme();
  const dir = useDirectory();
  const toast = useToast();
  const actions = useBrowserHandoffActions(orgId);
  const focused = useIsFocused();
  const view = useAgentComputer(agentId, focused ? PICTURE_IDLE_MS : false);
  const wait = useSetupWait(view.setup);
  const f = view.facts;
  const asks = !view.forbidden && asksPicture(focused, view.desktopQ.data ?? null);
  const shot = useDesktopPicture(orgId, agentId, { enabled: asks, working: Boolean(f?.working) });
  // A request's minutes left move on too. While the computer is on its way, the time every other line reads.
  const requestNow = useNow(f?.handoff && isWaitingHandoff(f.handoff) ? 15_000 : 60_000);
  // Only for whoever may watch it; nothing while that loads, never one edition's words before the other's.
  if (view.forbidden || !view.ready || !f) return null;
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
    // The lists' own card (`GroupedList`'s corner and relief), so it stands as one of them in Hoje.
    <View style={[styles.card, { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}>
      {picture ? (
        // The picture opens the computer too; the row under it is what a screen reader hears.
        <Pressable
          onPress={press}
          accessible={false}
          style={{ borderBottomColor: colors.line2, ...styles.pictureEdge }}
        >
          <Image
            source={{ uri: `data:image/jpeg;base64,${picture.data}` }}
            contentFit="cover"
            contentPosition="left top"
            style={styles.picture}
            accessible={false}
          />
        </Pressable>
      ) : null}
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

const styles = StyleSheet.create({
  // 16 under what comes before it in Hoje, as the page's other blocks.
  card: { marginTop: 16, borderRadius: 14, overflow: "hidden" },
  picture: { width: "100%", aspectRatio: 16 / 10 },
  pictureEdge: { borderBottomWidth: StyleSheet.hairlineWidth },
});
