import { keys, useApi, useChannelMembers, useCodeSession } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedList, GroupedRow, MEDIA_ROW, SCREEN_X, SkeletonList, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { Face } from "../shared/Face";
import { useDirectory, useErrorToast, useMeId, useOrgId } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { CODING_HREF } from "./logic";

/**
 * Who is in a session (ADR 0215), pushed from its "…": its agent first ("trabalha na worktree"), whoever opened it,
 * then whoever an @ brought in. Whoever opened it, or an admin, takes someone out (the row's button, as the app's
 * lists remove); anyone else leaves (and goes back to Code). Bringing someone in is an @ in the conversation.
 */
export function PeopleScreen({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const c = useTheme().colors;
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory();
  const failed = useErrorToast();
  const session = useCodeSession(orgId, sessionId).data;
  const members = useChannelMembers(orgId, session?.channelId ?? "", Boolean(session));
  const remove = useMutation({
    mutationFn: (m: { type: "agent" | "person"; id: string }) =>
      api.chat.removeMember(orgId, session?.channelId ?? "", m.type === "agent" ? { agentId: m.id } : { userId: m.id }),
    onSuccess: (_, m) => {
      void qc.invalidateQueries({ queryKey: keys.channelMembers(orgId, session?.channelId ?? "") });
      void qc.invalidateQueries({ queryKey: keys.roster(orgId, session?.channelId ?? "") });
      // Out of it myself: the session isn't mine to see any more.
      if (m.type === "person" && m.id === meId) router.dismissTo(CODING_HREF as never);
    },
    onError: failed,
  });
  const rank = (m: { type: string; id: string }) =>
    m.type === "agent" && m.id === session?.agentId ? 0 : m.id === session?.createdBy ? 1 : 2;
  const people = [...(members.data ?? [])]
    .filter((m): m is { type: "agent" | "person"; id: string } => m.type === "agent" || m.type === "person")
    .sort((a, b) => rank(a) - rank(b));
  const manages = Boolean(session && (session.createdBy === meId || can(org, "manage_channels")));
  return (
    <>
      <PushedHeader title={t("codeSessions.who.label")} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: c.grouped }}
        contentContainerStyle={styles.body}
      >
        {!session || members.isLoading ? (
          <SkeletonList rows={3} />
        ) : (
          <>
            <GroupedList>
              {people.map((p) => {
                const core = rank(p) < 2;
                const self = p.type === "person" && p.id === meId;
                const name = dir.nameOf(p);
                return (
                  <GroupedRow
                    key={`${p.type}:${p.id}`}
                    leading={<Face who={p} size={MEDIA_ROW.row.face} live={false} />}
                    label={name}
                    {...(core
                      ? { sub: rank(p) === 0 ? t("codeSessions.who.agent") : t("codeSessions.who.opener") }
                      : {})}
                    {...(!core && (self || manages)
                      ? {
                          remove: {
                            label: self ? t("codeSessions.who.leave") : t("codeSessions.who.remove", { name }),
                            onPress: () => remove.mutate(p),
                          },
                        }
                      : {})}
                  />
                );
              })}
            </GroupedList>
            <GroupedFooter>{t("codeSessions.who.invite")}</GroupedFooter>
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: SCREEN_X, paddingTop: 12, paddingBottom: 40 },
});
