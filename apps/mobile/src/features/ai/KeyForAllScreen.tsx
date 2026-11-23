import type { AgentSetup } from "@agenteschat/client";
import { keys, useAiAccounts, useApi, useSetupPreview } from "@agenteschat/client";
import { setupOutcome, takers } from "@agenteschat/client/lib/agent-setup";
import { type KeyModel, keyModelFirst, keyModelGroups } from "@agenteschat/client/lib/brain-picker";
import { planOf } from "@agenteschat/client/lib/plans";
import { providerLabel } from "@agenteschat/client/lib/providers";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Button, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SkeletonList, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Gap } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory } from "../shared/hooks";
import { BottomBar, PushedHeader } from "../shared/parts";
import { Note } from "./parts";

/*
 * "Usar em todos os agentes" on the phone, the web's dialog on a coding plan key's row as a screen of its own: the
 * key's models in runs by what the key did with each (`keyModelGroups`), each run under its header (the untested ones
 * too: this screen is the picker, nothing opens in place), the one picked checked, then how many agents take it (the
 * server's preview). "Usar", pinned under the list, saves it like "Usar em outros agentes" (`applySetup`).
 */

/** Opens "Usar em todos os agentes" for a coding plan key account, on `model` when the key may run it. */
export const openKeyForAll = (machineId: string, accountId: string, model?: string) =>
  router.push(
    `/key-for-all/${accountId}?machineId=${encodeURIComponent(machineId)}${model ? `&model=${encodeURIComponent(model)}` : ""}` as never,
  );

export function KeyForAllScreen({
  accountId,
  machineId,
  model: preferred,
}: {
  accountId: string;
  machineId: string;
  model?: string | undefined;
}) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const ai = useAiAccounts(orgId);
  const account = ai.data?.accounts.find((a) => a.id === accountId && a.machineId === machineId);
  const plan = planOf(account?.provider);
  const groups = plan ? keyModelGroups(plan, account?.usage) : null;
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usable = groups ? [...groups.works, ...groups.untested] : [];
  const model = picked ?? (groups ? keyModelFirst(groups, preferred) : "");
  const chosen = usable.find((m) => m.value === model);
  const setup: AgentSetup | null = account
    ? { brain: account.kind, machineId: account.machineId, account: account.id, model: model || null }
    : null;
  const preview = useSetupPreview(
    orgId,
    model ? setup : null,
    dir.agents.map((a) => a.id),
  );
  const can = takers(preview.data ?? []);
  const maker = plan?.maker ?? "";
  const row = (m: KeyModel, sub: string) => (
    <GroupedRow
      key={m.value}
      label={m.label}
      sub={m.textOnly ? `${sub} · ${t("aiAccounts.page.textOnly")}` : sub}
      checked={!m.refused && m.value === model}
      disabled={busy || Boolean(m.refused)}
      faint={Boolean(m.refused)}
      onPress={() => setPicked(m.value)}
    />
  );
  const use = async () => {
    if (!setup || !chosen || can.length === 0) return;
    setBusy(true);
    try {
      const results = await api.agents.applySetup(orgId, { setup, agentIds: can });
      const { done, missed } = setupOutcome(results, can.length);
      // One toast for the whole save, never two in a row: what changed, and what didn't under it.
      const [title, ...rest] = [
        done > 0 ? t("aiAccounts.page.useAllDone", { count: done, model: chosen.label }) : null,
        missed > 0 ? t("aiAccounts.page.useAllMissed", { count: missed }) : null,
      ].filter((line) => line !== null);
      if (title)
        toast({ title, ...(rest.length > 0 ? { subtitle: rest.join(" ") } : {}), icon: done > 0 ? "check" : "x" });
      router.back();
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    } finally {
      for (const key of [keys.agents(orgId), keys.aiStatus(orgId), keys.aiAccounts(orgId), keys.newAgentSetup(orgId)])
        void qc.invalidateQueries({ queryKey: key });
      setBusy(false);
    }
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("aiAccounts.page.useAll")} subtitle={plan?.label} solid={false} grouped />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.in}>
        {ai.isPending ? (
          <SkeletonList rows={4} />
        ) : !account || !plan || !groups ? (
          <LoadFailed onRetry={() => void ai.refetch()} />
        ) : (
          <>
            <GroupedFooter>{t("aiAccounts.page.useAllSub")}</GroupedFooter>
            {groups.works.length > 0 ? (
              <>
                <GroupedHeader>{t("aiAccounts.page.useAllWorks")}</GroupedHeader>
                <GroupedList>{groups.works.map((m) => row(m, t("aiAccounts.page.useAllAnswered")))}</GroupedList>
              </>
            ) : null}
            {groups.untested.length > 0 ? (
              <>
                <GroupedHeader>{t("aiAccounts.page.useAllUntested", { count: groups.untested.length })}</GroupedHeader>
                <GroupedList>
                  {groups.untested.map((m) => row(m, m.maker ? providerLabel(m.maker) : maker))}
                </GroupedList>
              </>
            ) : null}
            {groups.refused.length > 0 ? (
              <>
                <GroupedHeader>{t("aiAccounts.page.useAllRefused")}</GroupedHeader>
                <GroupedList>
                  {groups.refused.map((m) =>
                    row(
                      m,
                      m.refused === "region"
                        ? t("aiAccounts.page.useAllRegion", { maker })
                        : t("aiAccounts.page.useAllOff", { maker }),
                    ),
                  )}
                </GroupedList>
              </>
            ) : null}
            {chosen?.textOnly ? (
              <Note icon="info" inset>
                {t("aiAccounts.page.useAllTextOnly", { model: chosen.label })}
              </Note>
            ) : null}
            {/* Whom it goes to: every agent that may take it, said, never a choice to make here. */}
            <Gap />
            <GroupedList>
              <GroupedRow
                icon="members"
                label={t("aiAccounts.page.useAllAgents")}
                {...(preview.isPending
                  ? {}
                  : {
                      sub:
                        can.length === 0
                          ? t("aiAccounts.page.useAllNone")
                          : t("aiAccounts.page.useAllAgentsLine", { count: can.length }),
                    })}
                subLines={2}
              />
            </GroupedList>
          </>
        )}
      </ScrollView>
      <BottomBar bottom={insets.bottom}>
        <Button
          variant="primary"
          wide
          label={chosen ? t("aiAccounts.page.useAllGo", { count: can.length }) : t("aiAccounts.page.useAllPick")}
          loading={busy}
          disabled={!chosen || can.length === 0}
          onPress={() => void use()}
        />
      </BottomBar>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
});
