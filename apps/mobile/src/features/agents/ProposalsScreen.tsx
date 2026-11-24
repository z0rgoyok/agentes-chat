import { type Proposal, useProposals } from "@agenteschat/client";
import { proposalWhy } from "@agenteschat/client/lib/proposals";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import { Button, EmptyState, SkeletonList, Text } from "@/ui";
import { ChangeRequestRow } from "../right-hand/SettingsCard";
import { LoadFailed, useEmptyLook } from "../shared/FirstUse";
import { useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { ProposalRowsCard } from "./InstructionProposalCard";

/** Cards shown at first and added by "Show more" (the server sends the newest 200). */
const PAGE = 20;

/** When the last thing happened to it: put back, applied or left out, or proposed. */
const lastAt = (p: Proposal) => p.undoneAt ?? p.decidedAt ?? p.createdAt;

/**
 * Agent improvements (ADR 0219): what agents changed in their own or their teammates' instructions, roles, apps and
 * settings, a skill or the workspace's context, newest first. Nothing here waits on anyone: each card says how its
 * review ended ("Reviewing…" for the few seconds before), why, and Undo while the viewer may put it back.
 */
export function ProposalsScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const proposals = useProposals(orgId);
  const pull = usePullRefresh(proposals.refetch);
  const [shown, setShown] = useState(PAGE);
  // A row that went stale before it was weighed never changed anything: not part of what agents changed.
  const history = useMemo(
    () => (proposals.data ?? []).filter((p) => !p.stale).sort((a, b) => (lastAt(a) < lastAt(b) ? 1 : -1)),
    [proposals.data],
  );
  const look = useEmptyLook();
  return (
    <PushedLargeTitle
      title={t("mobile.proposals.title")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {/* The list's own shape while it loads, never a blank page. */}
      {proposals.isPending ? <SkeletonList rows={3} /> : null}
      {proposals.isError && !proposals.data ? <LoadFailed onRetry={() => void proposals.refetch()} /> : null}
      {proposals.isSuccess && history.length === 0 ? (
        // Nothing yet, the whole screen's: the agent at ease over the words, centered (as the audit's "Nothing to
        // review"). The compact form is a filtered list's, and left two lines stuck under the title on an empty page.
        <EmptyState
          size="page"
          agent={look}
          mood="deal"
          title={t("mobile.proposals.emptyTitle")}
          subtitle={t("mobile.proposals.empty")}
        />
      ) : null}
      <View style={styles.list}>
        {history.slice(0, shown).map((p) => {
          const why = proposalWhy(t, p);
          return (
            <View key={p.id} style={styles.item}>
              {why ? (
                <Text variant="subhead" tone="muted">
                  {why}
                </Text>
              ) : null}
              {p.target.type === "agent_settings" ? (
                <ChangeRequestRow p={p} />
              ) : (
                <ProposalRowsCard id={p.id} rows={[p]} />
              )}
            </View>
          );
        })}
        {history.length > shown ? (
          // Centred inside the list's margins (a button keeps to its own width at the row's start).
          <View style={styles.more}>
            <Button
              variant="secondary"
              size="sm"
              label={t("mobile.proposals.more")}
              onPress={() => setShown((n) => n + PAGE)}
            />
          </View>
        ) : null}
      </View>
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  list: { gap: 20, paddingHorizontal: 16 },
  item: { gap: 8 },
  more: { alignItems: "center" },
});
