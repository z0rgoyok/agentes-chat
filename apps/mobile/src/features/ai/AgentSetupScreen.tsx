import { keys, useAgentBrain, useApi, useModels, useSetupPreview } from "@agenteschat/client";
import {
  autonomyName,
  changes,
  setupOfBrain,
  setupOutcome,
  setupResultLine,
  sortedResults,
  takers,
} from "@agenteschat/client/lib/agent-setup";
import { setupPlanOpens, setupPlanQuestion } from "@agenteschat/client/lib/audience";
import { brainLine } from "@agenteschat/client/lib/brain";
import { firstName } from "@agenteschat/client/lib/format";
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
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { BottomBar, PushedHeader } from "../shared/parts";
import { advancedOf } from "./AgentAdvancedScreen";
import { setupWords } from "./logic";

/*
 * "Usar em outros agentes" on the phone (ADR 0094), the web's dialog over "Quem pensa" as a screen of its own, from
 * "Pensa com": every other agent with what the agent's setup would do to it (the server's preview), those that can
 * take it first, "Todos" on top. "Usar" sends them in one call; the server checks each again.
 */

/** Opens "Usar em outros agentes" for an agent's saved setup. */
export const openAgentSetup = (agentId: string) => router.push(`/agent-setup/${agentId}` as never);

export function AgentSetupScreen({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const brain = useAgentBrain(orgId, agentId);
  const models = useModels();
  // "Levar a autonomia" off: the others keep their own.
  const [withAutonomy, setWithAutonomy] = useState(true);
  const view = brain.data && !withAutonomy ? { ...brain.data, autonomy: undefined } : brain.data;
  const setup = view ? setupOfBrain(view) : null;
  const others = dir.agents.filter((a) => a.id !== agentId);
  const preview = useSetupPreview(
    orgId,
    setup,
    others.map((a) => a.id),
  );
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const results = sortedResults(preview.data ?? []);
  const can = takers(results);
  const chosen = can.filter((id) => picked.has(id));
  const setupText = view ? setupWords(t, i18n.language, view, { now: advancedOf(view) }) : "";
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const use = async () => {
    if (!setup || !view || chosen.length === 0) return;
    // Letting more people talk to agents on other people's plans asks once, before anything saves.
    const opens = setupPlanOpens(
      results,
      chosen,
      (id) => dir.agentById.get(id),
      (id) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
    );
    const provider = view.accounts.find((a) => a.id === view.account)?.provider ?? null;
    if (!(await confirmQuestion(t, setupPlanQuestion(t, { kind: view.brain, provider }, opens)))) return;
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
        {brain.isPending ? (
          <SkeletonList rows={4} />
        ) : !setup || preview.isError ? (
          <LoadFailed
            onRetry={() => {
              // The preview is asked again only once there is a setup to preview (a refetch ignores `enabled`).
              if (setup) void preview.refetch();
              else void brain.refetch();
            }}
          />
        ) : (
          <>
            {/* What goes, said once over the lists, on their headers' edge. */}
            <GroupedFooter>{t("agentPage.work.brain.copy.sub", { setup: setupText })}</GroupedFooter>
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
                        checked={changes(r) && picked.has(a.id)}
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
