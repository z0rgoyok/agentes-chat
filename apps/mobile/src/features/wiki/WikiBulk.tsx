import { useWikiBulk, useWikiTrash, type WikiBulkTarget } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  GROUPED_ROW,
  GroupedFooter,
  GroupedList,
  GroupedRow,
  Icon,
  LIST_AVATAR,
  ListRow,
  Locked,
  padPastFold,
  SCREEN_X,
  SkeletonList,
  Text,
  useFoldRoom,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { useFailed } from "../routines/hooks";
import { Gap, SettingsPage } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { successHaptic, Tile } from "../shared/parts";

/** The wiki's Lixeira on the phone. */
export const openWikiTrash = () => router.push("/wiki-trash");
/** Which agents read the chosen pages. */
export const openWikiAgents = (ids: string[]) =>
  router.push({ pathname: "/wiki-agents", params: { ids: ids.join(",") } });

/**
 * "Apagar" for many pages (a folder, an import or a selection): an alert that says how many and where they go, then
 * one call. `title` is the alert's question, already with the count.
 */
export function useWikiBulkDelete() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const bulk = useWikiBulk(orgId);
  const ask = (target: WikiBulkTarget, count: number, title: string, onDone?: () => void) =>
    Alert.alert(title, t("wiki.bulk.deleteText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("wiki.bulk.deleteGo", { count }),
        style: "destructive",
        onPress: () =>
          bulk.mutate(
            { type: "delete", target },
            {
              onSuccess: (r) => {
                successHaptic();
                toast({
                  title: [
                    t("wiki.bulk.deleted", { count: r.count }),
                    r.kept ? t("wiki.bulk.kept", { count: r.kept }) : "",
                  ]
                    .filter(Boolean)
                    .join(" "),
                });
                onDone?.();
              },
              onError: failed,
            },
          ),
      },
    ]);
  return { ask, pending: bulk.isPending };
}

/**
 * The Lixeira: pages deleted in the last 30 days. A tap chooses a page; the bar restores the chosen ones or deletes
 * them for good, and "Esvaziar" empties it, each after an alert that says how many.
 */
export function WikiTrashScreen() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { orgId, org } = useOrg();
  const toast = useToast();
  const failed = useFailed();
  const trash = useWikiTrash(orgId);
  const pull = usePullRefresh(trash.refetch);
  const bulk = useWikiBulk(orgId);
  const writes = can(org, "edit_wiki");
  // Folded like a book (ADR 0212), the bar's buttons keep to the half past the fold, never across it.
  const foldSide = useFoldRoom();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const pages = trash.data ?? [];
  const busy = bulk.isPending;
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const restore = () =>
    bulk.mutate(
      { type: "restore", ids: [...picked] },
      {
        onSuccess: (r) => {
          setPicked(new Set());
          successHaptic();
          const why = r.failed[0]?.code === "wiki.restore_slug_taken" ? t("errors.wiki.restoreSlugTaken") : "";
          toast({
            title: r.count ? t("wiki.trash.restored", { count: r.count }) : why,
            ...(r.failed.length ? { icon: "x" as const, subtitle: why } : {}),
          });
        },
        onError: failed,
      },
    );
  const purge = (ids?: string[]) =>
    Alert.alert(t("wiki.trash.emptyTitle", { count: ids ? ids.length : pages.length }), t("wiki.trash.emptyText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: ids ? t("wiki.trash.purge") : t("wiki.trash.empty"),
        style: "destructive",
        onPress: () =>
          bulk.mutate(
            { type: "purge", ids },
            {
              onSuccess: (r) => {
                setPicked(new Set());
                toast({ title: t("wiki.trash.purged", { count: r.count }) });
              },
              onError: failed,
            },
          ),
      },
    ]);
  // Pages chosen: what to do with them stays at the screen's foot, over the list.
  const bar =
    picked.size > 0 ? (
      <View
        style={[
          styles.bar,
          { paddingBottom: insets.bottom + 12, backgroundColor: c.bg, borderColor: c.line },
          foldSide && padPastFold(foldSide, 16),
        ]}
      >
        <Button variant="secondary" label={t("wiki.trash.purge")} disabled={busy} onPress={() => purge([...picked])} />
        <View style={styles.grow}>
          <Button
            variant="primary"
            wide
            label={t("wiki.trash.restoreMany", { count: picked.size })}
            loading={busy}
            disabled={busy}
            onPress={restore}
          />
        </View>
      </View>
    ) : null;
  return (
    // The large title's scroll view is the screen's own first view (the system folds the title as it scrolls): the
    // chosen pages' bar goes in its dock, never in a view around it.
    <PushedLargeTitle
      title={t("wiki.trash.title")}
      bottomInset={picked.size ? 110 : 24}
      dock={bar}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <Text variant="subhead" tone="muted" style={styles.lead}>
        {t("wiki.trash.text")}
      </Text>
      {/* Loading: the rows' own shape; failed: what happened and the way to ask again; empty: says so. */}
      {trash.isLoading ? <SkeletonList rows={4} /> : null}
      {trash.isError && !trash.data ? <LoadFailed onRetry={() => void trash.refetch()} /> : null}
      {trash.isSuccess && pages.length === 0 ? (
        <EmptyState size="panel" icon="trash" title={t("wiki.trash.none")} />
      ) : null}
      {pages.length > 0 ? (
        <Locked when={busy}>
          {/* The wiki's own rows (its tile, the title, where it was and when it went), chosen as the wiki's are. */}
          {pages.map((p, i) => {
            const on = picked.has(p.id);
            return (
              <ListRow
                key={p.id}
                divider={i > 0}
                leading={<Tile icon="file" size={LIST_AVATAR} />}
                title={p.title}
                sub={[
                  p.folder || t("wiki.root"),
                  p.deletedAt ? t("wiki.trash.deletedWhen", { when: relativeTime(t, i18n.language, p.deletedAt) }) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                subLines={1}
                {...(writes
                  ? {
                      trailing: <Icon name={on ? "checkc" : "circle"} size={22} color={on ? c.ink : c.faint} />,
                      accessibilityState: { selected: on },
                      onPress: () => toggle(p.id),
                    }
                  : {})}
              />
            );
          })}
          {writes ? (
            <View style={styles.empty}>
              <Button variant="secondary" size="sm" label={t("wiki.trash.empty")} onPress={() => purge()} />
            </View>
          ) : null}
        </Locked>
      ) : null}
    </PushedLargeTitle>
  );
}

/** Which agents read the chosen pages: every agent, or the ones ticked (none is a choice too). People's access stays. */
export function WikiAgentsScreen({ ids }: { ids: string[] }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const failed = useFailed();
  const bulk = useWikiBulk(orgId);
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const save = () =>
    bulk.mutate(
      { type: "agents", ids, agentIds: all ? null : [...picked] },
      {
        onSuccess: (r) => {
          successHaptic();
          toast({ title: t("wiki.bulk.agentsSaved", { count: r.count }) });
          router.back();
        },
        onError: failed,
      },
    );
  return (
    // A settings form: every agent, or the ones ticked, in groups on the grouped gray; Salvar in the bar.
    <SettingsPage
      title={t("wiki.bulk.agentsTitle", { count: ids.length })}
      action={{ label: t("common.save"), onPress: save, disabled: bulk.isPending }}
      busy={bulk.isPending}
    >
      <GroupedList>
        <GroupedRow label={t("wiki.audienceAgentsAll")} toggle={all} onPress={() => setAll(!all)} />
      </GroupedList>
      <GroupedFooter>{t("wiki.bulk.agentsText")}</GroupedFooter>
      {all ? null : (
        <>
          <Gap />
          <GroupedList>
            {dir.agents.map((a) => {
              const on = picked.has(a.id);
              return (
                <GroupedRow
                  key={a.id}
                  leading={<AgentFace agentId={a.id} size={GROUPED_ROW.lead} live={false} />}
                  label={a.name}
                  checked={on}
                  onPress={() => {
                    const next = new Set(picked);
                    if (on) next.delete(a.id);
                    else next.add(a.id);
                    setPicked(next);
                  }}
                />
              );
            })}
          </GroupedList>
        </>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  lead: { paddingHorizontal: SCREEN_X, paddingBottom: 8 },
  empty: { alignItems: "center", paddingTop: 16 },
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
