import { currentOf, keys, useAgentBrain, useAiAccounts, useApi, useModels, useSetupPreview } from "@agenteschat/client";
import {
  autonomyName,
  changes,
  setupOfBrain,
  setupOutcome,
  setupResultLine,
  sortedResults,
  takers,
} from "@agenteschat/client/lib/agent-setup";
import { type AiChoice, aiChoiceRows, aiChoiceSetup } from "@agenteschat/client/lib/ai-choice";
import { setupPlanOpens, setupPlanQuestion } from "@agenteschat/client/lib/audience";
import { brainLine } from "@agenteschat/client/lib/brain";
import { firstName } from "@agenteschat/client/lib/format";
import { accountPlan } from "@agenteschat/client/lib/plans";
import { isAuto } from "@agenteschat/client/lib/providers";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { AgentAvatar, Button, GroupedFooter, GroupedList, GroupedRow, SkeletonList, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { confirmQuestion } from "../chat/ReachLines";
import { Gap } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { BottomBar, PushedHeader } from "../shared/parts";
import { advancedOf } from "./AgentAdvancedScreen";
import { AiChoiceFields } from "./AiChoice";
import { choiceText } from "./hub";
import { setupWords } from "./logic";

/*
 * "Usar em outros agentes" on the phone (ADR 0094), the web's dialog as a screen of its own and the one way to give
 * several agents one AI: from "Pensa com" (the agent's setup), a coding plan's key ("Usar em todos os agentes") or a
 * reply's stand-in model. The one choice on top, then every other agent with what the setup would do to it (the
 * server's preview), those that can take it first, "Todos" on top. "Usar" sends them in one call; the server checks
 * each again.
 */

/** Opens "Usar em outros agentes" for an agent's saved setup. */
export const openAgentSetup = (agentId: string) => router.push(`/agent-setup/${agentId}` as never);

/** Opens "Usar em outros agentes" on a plan account (`model`: one it may run), every agent that can take it picked. */
export const openKeyForAll = (machineId: string, accountId: string, model?: string) =>
  router.push(
    `/key-for-all/${accountId}?machineId=${encodeURIComponent(machineId)}${model ? `&model=${encodeURIComponent(model)}` : ""}` as never,
  );

export function AgentSetupScreen({
  agentId,
  account,
}: {
  /** The agent whose setup the others take (it is left out of the list). */
  agentId?: string;
  /** Or a plan account the others take, on its `model` when one is given. */
  account?: { id: string; machineId: string; model?: string | undefined };
}) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const meId = useMeId();
  const brain = useAgentBrain(orgId, agentId ?? "", Boolean(agentId));
  const models = useModels();
  // "Levar a autonomia" off: the others keep their own.
  const [withAutonomy, setWithAutonomy] = useState(true);
  const view = brain.data && !withAutonomy ? { ...brain.data, autonomy: undefined } : brain.data;
  const others = dir.agents.filter((a) => a.id !== agentId);
  const ai = useAiAccounts(orgId);
  const hub = ai.data?.hub ?? null;
  // An older server has no hub: the account is still in its plain list.
  const login = account
    ? [...(hub?.accounts ?? []), ...(ai.data?.accounts ?? [])].find(
        (a) => a.id === account.id && a.machineId === account.machineId,
      )
    : undefined;
  // The agent's AI as it is (or the account's), or another one picked here (the one choice): what the others take.
  const [picked, setChoice] = useState<AiChoice | null>(null);
  const choice: AiChoice | null =
    picked ??
    (login
      ? { brain: login.kind, account: login.id, machineId: login.machineId, model: account?.model ?? null }
      : null);
  const target = { kind: "agents" as const, agentIds: others.map((a) => a.id) };
  const base = view ? setupOfBrain(view) : null;
  const setup = choice ? { ...base, ...aiChoiceSetup(choice) } : base;
  const pickedRow = choice
    ? aiChoiceRows(hub, { target, viewerId: meId ?? "", current: choice }).find((r) => r.selected)
    : null;
  const preview = useSetupPreview(
    orgId,
    setup,
    others.map((a) => a.id),
  );
  // null: as it opens (a plan account's: every agent that can take it), again after another AI is picked.
  const [agentsPicked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const results = sortedResults(preview.data ?? []);
  const can = takers(results);
  const chosenSet = agentsPicked ?? new Set(account ? can : []);
  const chosen = can.filter((id) => chosenSet.has(id));
  const setupText = pickedRow
    ? choiceText(t, pickedRow, i18n.language).label
    : view
      ? setupWords(t, i18n.language, view, { now: advancedOf(view) })
      : (accountPlan(login)?.label ?? "");
  const toggle = (id: string) => {
    const next = new Set(chosenSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const use = async () => {
    if (!setup || chosen.length === 0) return;
    // Letting more people talk to agents on other people's plans asks once, before anything saves.
    const opens = setupPlanOpens(
      results,
      chosen,
      (id) => dir.agentById.get(id),
      (id) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
    );
    const provider = pickedRow
      ? (pickedRow.account?.provider ?? null)
      : (view?.accounts.find((a) => a.id === view.account)?.provider ?? null);
    const kind = setup.brain;
    if (!(await confirmQuestion(t, setupPlanQuestion(t, { kind, provider }, opens)))) return;
    setBusy(true);
    try {
      const results = await api.agents.applySetup(orgId, { setup, agentIds: chosen });
      const { done, autonomyOnly, missed } = setupOutcome(results, chosen.length);
      // One toast for the whole save, never three in a row: what changed first, the rest under it.
      const [title, ...rest] = [
        done > 0 ? t("agentPage.work.brain.copy.done", { count: done, setup: setupText }) : null,
        autonomyOnly > 0 ? t("agentPage.work.brain.copy.autonomyOnly", { count: autonomyOnly }) : null,
        missed > 0 ? t("agentPage.work.brain.copy.missed", { count: missed }) : null,
      ].filter((line) => line !== null);
      if (title)
        toast({
          title,
          ...(rest.length > 0 ? { subtitle: rest.join(" ") } : {}),
          icon: done + autonomyOnly > 0 ? "check" : "x",
        });
      router.back();
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    } finally {
      for (const key of [
        ...chosen.map((id) => keys.agentBrain(orgId, id)),
        keys.agents(orgId),
        keys.aiStatus(orgId),
        keys.aiAccounts(orgId),
        keys.newAgentSetup(orgId),
        // Nova missão starts from each agent's Autonomia.
        [...keys.missions(orgId), "eligible"],
      ])
        void qc.invalidateQueries({ queryKey: key });
      setBusy(false);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("agentPage.work.brain.copy.title")} solid={false} grouped />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.in, { paddingBottom: 24 }]}>
        {(agentId ? brain.isPending : ai.isLoading) ? (
          <SkeletonList rows={4} />
        ) : !setup || preview.isError ? (
          <LoadFailed
            onRetry={() => {
              // The preview is asked again only once there is a setup to preview (a refetch ignores `enabled`).
              if (setup) void preview.refetch();
              else if (agentId) void brain.refetch();
              else void ai.refetch();
            }}
          />
        ) : (
          <>
            {/* What goes, said once over the lists, on their headers' edge; another AI picked here instead. */}
            <GroupedFooter>{t("agentPage.work.brain.copy.sub", { setup: setupText })}</GroupedFooter>
            <AiChoiceFields
              target={target}
              value={
                choice ??
                (brain.data ? currentOf({ kind: "agent", agentId: agentId ?? "" }, { brain: brain.data }) : null)
              }
              onChange={(next) => {
                setChoice(next);
                setPicked(null);
              }}
              disabled={busy}
            />
            {brain.data?.autonomy ? (
              <>
                <Gap />
                <GroupedList>
                  <GroupedRow
                    icon="shield"
                    label={t("agentPage.work.brain.copy.withAutonomy")}
                    sub={t("agentPage.work.brain.copy.withAutonomyLine", {
                      value: autonomyName(t, brain.data.autonomy),
                    })}
                    subLines={2}
                    toggle={withAutonomy}
                    disabled={busy}
                    onPress={() => setWithAutonomy((on) => !on)}
                  />
                </GroupedList>
              </>
            ) : null}
            {preview.isPending ? (
              <SkeletonList rows={4} />
            ) : (
              <>
                <Gap />
                <GroupedList>
                  <GroupedRow
                    icon="members"
                    label={t("agentPage.work.brain.copy.all")}
                    sub={
                      can.length === 0
                        ? t("agentPage.work.brain.copy.none")
                        : t("agentPage.work.brain.copy.allLine", { count: can.length })
                    }
                    checked={can.length > 0 && chosen.length === can.length}
                    disabled={busy || can.length === 0}
                    onPress={() => setPicked(new Set(chosen.length === can.length ? [] : can))}
                  />
                </GroupedList>
                <Gap />
                <GroupedList>
                  {results.map((r) => {
                    const a = dir.agentById.get(r.agentId);
                    if (!a) return null;
                    const ownerName = a.ownerUserId ? dir.memberById.get(a.ownerUserId)?.name : undefined;
                    const owner = ownerName ? firstName(ownerName) : undefined;
                    const api = isAuto(a.model)
                      ? t("brain.auto.label")
                      : (models.data?.models.find((m) => m.id === a.model)?.label ?? a.model);
                    const now = brainLine(t, a.brain, api).text;
                    return (
                      <GroupedRow
                        key={a.id}
                        leading={<AgentAvatar agent={{ ...agentLook(a), id: a.id }} size={32} live={false} />}
                        label={a.name}
                        sub={setupResultLine(t, r, { now, owner })}
                        checked={changes(r) && chosenSet.has(a.id)}
                        disabled={busy || !changes(r)}
                        onPress={() => toggle(a.id)}
                      />
                    );
                  })}
                </GroupedList>
              </>
            )}
          </>
        )}
      </ScrollView>
      <BottomBar bottom={insets.bottom}>
        <Button
          variant="primary"
          wide
          label={
            chosen.length === 0
              ? t("agentPage.work.brain.copy.pick")
              : t("agentPage.work.brain.copy.use", { count: chosen.length })
          }
          loading={busy}
          disabled={chosen.length === 0}
          onPress={() => void use()}
        />
      </BottomBar>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
});
