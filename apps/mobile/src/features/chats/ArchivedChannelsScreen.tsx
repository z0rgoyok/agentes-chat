import { type ArchivedChannel, useArchivedChannels, useUnarchiveChannel } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import { EmptyState, GroupedList, GroupedRow, SkeletonList, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";
import { chooseAction } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { successHaptic } from "../shared/parts";

/**
 * "Canais arquivados", as the web's: the archived channels this person may bring back (their creator or who manages
 * channels), each opening Restaurar, which brings it back as it was and opens it.
 */
export function ArchivedChannelsScreen() {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const list = useArchivedChannels(orgId);
  const pull = usePullRefresh(list.refetch);
  const restore = useUnarchiveChannel(orgId);
  const channels = list.data ?? [];
  const ask = (ch: ArchivedChannel) =>
    chooseAction(
      `#${ch.name}`,
      [
        {
          label: t("channel.restore"),
          onPress: () =>
            restore.mutate(ch.id, {
              onSuccess: () => {
                successHaptic();
                toast({ title: t("channel.restored", { channel: ch.name }), icon: "check" });
                router.replace(chatHref(ch.id));
              },
              onError: (error) => toast({ title: errorText(t, error, i18n.language), icon: "x" }),
            }),
        },
      ],
      t("common.cancel"),
    );
  return (
    <PushedLargeTitle
      title={t("channel.archivedTitle")}
      grouped
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {/* Loading: the rows' own shape; failed: what happened and the way to ask again; empty: says so. */}
      {list.isLoading ? <SkeletonList rows={3} /> : null}
      {list.isError && !list.data ? <LoadFailed onRetry={() => void list.refetch()} /> : null}
      {list.isSuccess && channels.length === 0 ? (
        <EmptyState size="panel" icon="archive" title={t("channel.archivedNone")} />
      ) : null}
      {channels.length > 0 ? (
        <View style={styles.in}>
          <GroupedList>
            {channels.map((ch) => (
              <GroupedRow
                key={ch.id}
                icon={ch.visibility === "private" ? "lock" : "hash"}
                label={`#${ch.name}`}
                labelLines={3}
                sub={t("channel.archivedOn", { date: formatShortDate(i18n.language, ch.archivedAt) })}
                media
                // Its tap opens the choice to bring it back: the three dots say a menu opens.
                more
                disabled={restore.isPending}
                onPress={() => ask(ch)}
              />
            ))}
          </GroupedList>
        </View>
      ) : null}
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  // The grouped card on the screen's 16 margin, as every grouped page's.
  in: { paddingHorizontal: 16, paddingTop: 4 },
});
