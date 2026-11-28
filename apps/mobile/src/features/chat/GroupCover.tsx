import type { Channel, RosterMember } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import { groupFaceOf } from "@agenteschat/client/lib/group-conversations";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { WorkspaceSky } from "@/sky/Sky";
import { Text } from "@/ui";
import { GroupFace } from "../shared/GroupFace";
import { useDirectory, useMeId } from "../shared/hooks";

/** A group conversation's face on its cover. */
const COVER_FACE = 88;
/** The cover's sky band, the face standing on its horizon. */
const BAND = 136;

export interface GroupConversation {
  /** Its agents (the roster's once read, else the channel list's first ones) and how many in all. */
  agentIds: string[];
  count: number;
  /** Who is in it, me first: "Você, Ana, Teo e Rita". */
  who: string;
}

/**
 * A personal workspace's group conversation (ADR 0159, amendment of 2026-11-26), from a server that lists channels'
 * agents: its face and who is in it. Null in a team's workspace, for a DM, or from an older server (the channel's #
 * stays).
 */
export function useGroupConversation(
  channel: Pick<Channel, "agentIds" | "agentCount"> | null | undefined,
  roster: RosterMember[] | undefined,
): GroupConversation | null {
  const { t } = useTranslation();
  const { org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const personal = isPersonal(org);
  return useMemo(() => {
    const face = channel && personal ? groupFaceOf(channel) : null;
    if (!face) return null;
    const agents = roster?.filter((r) => r.type === "agent") ?? [];
    const people = roster?.filter((r) => r.type !== "agent" && r.id !== meId) ?? [];
    const names = [...people, ...agents].map((r) => dir.nameOf(r)).filter(Boolean);
    return {
      agentIds: roster ? agents.map((r) => r.id) : face.agentIds,
      count: roster ? agents.length : face.count,
      who: joinNames([t("channel.groupYou"), ...names], t),
    };
  }, [channel, personal, roster, meId, dir, t]);
}

/**
 * The start of a group conversation with messages in it, as the web's cover: its agents as its face on the workspace's
 * sky, its name and who is in it. (An empty one says the same in its greeting, `ChannelHello`.)
 */
export const GroupCover = memo(function GroupCover({ name, group }: { name: string; group: GroupConversation }) {
  return (
    <View style={styles.cover}>
      <View style={styles.band} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <WorkspaceSky fadeTop={0.5} fade={0.6} style={StyleSheet.absoluteFill} />
        <View style={styles.face}>
          <GroupFace agentIds={group.agentIds} count={group.count} size={COVER_FACE} />
        </View>
      </View>
      <View style={styles.words}>
        <Text variant="title2" style={styles.center} accessibilityRole="header">
          {name}
        </Text>
        <Text variant="subhead" tone="muted" style={styles.center} numberOfLines={2}>
          {group.who}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  cover: { paddingBottom: 24 },
  band: { height: BAND, marginBottom: 16, justifyContent: "flex-end" },
  // The face centered on the horizon, standing 16 above the band's foot.
  face: { alignItems: "center", paddingBottom: 16 },
  words: { gap: 8, paddingHorizontal: 32 },
  center: { textAlign: "center" },
});
