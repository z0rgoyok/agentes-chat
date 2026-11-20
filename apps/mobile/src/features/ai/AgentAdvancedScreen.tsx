import type { AgentBrain, AgentBrainInput, BrainSpeed } from "@agenteschat/client";
import { useAgentBrain, useAiAccounts, useModels } from "@agenteschat/client";
import { signInPlan } from "@agenteschat/client/lib/ai-accounts";
import { EVERYONE_AUDIENCE } from "@agenteschat/client/lib/audience";
import {
  type Advanced,
  advancedSummary,
  effortOf,
  isAdvancedDefault,
  SPEEDS,
  viewSpeedFits,
} from "@agenteschat/client/lib/brain-advanced";
import {
  autoContextLine,
  type ContextLimit,
  contextChoices,
  contextSize,
  isContextLimit,
} from "@agenteschat/client/lib/context-limits";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { planOf } from "@agenteschat/client/lib/plans";
import { isAuto } from "@agenteschat/client/lib/providers";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { GROUPED_ROW, GroupedHeader, GroupedList, GroupedRow, SkeletonList } from "@/ui";
import { router } from "@/ui/navigation";
import { useWidenAsk } from "../chat/ReachLines";
import { Gap } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedHeader } from "../shared/parts";
import { EffortRamp, useBrainChoice, useEffortChoice } from "./EffortRamp";
import { accountKindOf, advancedResetInput, agentAccounts, agentChain } from "./logic";
import { PlanReplies } from "./parts";
import { useSaveBrain } from "./useSaveBrain";

/*
 * An agent's "Configuração avançada" on the phone (ADR 0086), the web's dialog over "Quem pensa" as a screen of its
 * own, opened from "Pensa com" by its owner or an admin: how it thinks (effort on its computer, a ramp with a fixed
 * model and a row that says "Automático" picks it otherwise; Velocidade where it applies; the context window, any
 * brain), who it answers ("Atende outras pessoas") and "Só esta conta" where its account could move on at a limit.
 * Each choice saves at once, like the rest of "Pensa com"; "Voltar ao padrão" puts them all back.
 */

/** Opens an agent's advanced settings. */
export const openAgentAdvanced = (agentId: string) => router.push(`/agent-advanced/${agentId}` as never);

/** What the agent's view says for the advanced settings (a limit past its model's window reads as none). */
export const advancedOf = (view: AgentBrain, options?: readonly ContextLimit[]): Advanced => {
  const tokens = isContextLimit(view.contextTokens) ? view.contextTokens : null;
  return {
    effort: effortOf(view.brain, view.effort),
    speed: viewSpeedFits(view) ? view.speed : "standard",
    contextTokens: tokens !== null && (!options || options.includes(tokens)) ? tokens : null,
    onlyOwner: view.onlyOwner,
  };
};

/** The settings as saved, with the changes still on their way over them: each row shows its pick on the tap. */
const withPending = (view: AgentBrain, now: Advanced, pending: AgentBrainInput): Advanced => ({
  effort: pending.effort === undefined ? now.effort : effortOf(view.brain, pending.effort),
  speed: pending.speed ?? now.speed,
  contextTokens:
    pending.contextTokens === undefined
      ? now.contextTokens
      : isContextLimit(pending.contextTokens)
        ? pending.contextTokens
        : null,
  onlyOwner: pending.onlyOwner ?? now.onlyOwner,
  ...(now.accountPinned === undefined ? {} : { accountPinned: pending.accountPinned ?? now.accountPinned }),
});

export function AgentAdvancedScreen({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const agent = dir.agentById.get(agentId);
  const ask = useWidenAsk(agent);
  const name = agent?.name ?? "";
  const ownerFirst = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name.split(" ")[0] : undefined;
  const g = agentGrammar(name);
  const brain = useAgentBrain(orgId, agentId);
  const models = useModels();
  const { pending, save: send } = useSaveBrain(agentId);
  const view = brain.data;
  const kind = accountKindOf(view?.brain);
  // Its computer's row, where the computer's own sign-in's plan is (a seat has its own words).
  const row = useAiAccounts(orgId, view?.canUsePlans === true && kind !== null).data?.computers.find(
    (r) => r.machineId === view?.computer?.machineId,
  );
  const current =
    view && kind ? agentAccounts(view, kind, agent?.ownerUserId, name).find((a) => a.id === view.account) : undefined;
  const autoModel = view?.brain === "model" ? isAuto(agent?.model) : isAuto(view?.effectiveModel);
  // The sizes under the window of the model it thinks with ("Automático": any of its line).
  const options = !view
    ? []
    : view.brain === "model"
      ? contextChoices(autoModel ? undefined : models.data?.models.find((m) => m.id === agent?.model))
      : contextChoices(
          autoModel
            ? undefined
            : view.options.find((o) => o.kind === view.brain)?.models.find((m) => m.value === view.effectiveModel),
        );
  // "Só esta conta" where its account could move on, or where it is on: a right hand's own plan never moves.
  const pinShown =
    view !== undefined &&
    !view.scope &&
    (agentChain(view, agentId, agent?.ownerUserId).moves || view.accountPinned === true);
  const advancedNow = (v: AgentBrain) => ({
    ...advancedOf(v, options),
    ...(pinShown ? { accountPinned: v.accountPinned === true } : {}),
  });
  const now = view ? advancedNow(view) : null;
  const shown = view && now ? withPending(view, now, pending) : null;
  const may = view?.canEdit === true;
  const effort = useEffortChoice(agentId, shown?.effort);
  const speed = useBrainChoice<BrainSpeed>(agentId, shown?.speed ?? "standard", (value) => ({ speed: value }));

  /**
   * Saves at once and says what the row on "Pensa com" will say now (or `done`). The row shows its pick on the tap and
   * only it waits for the answer (`useSaveBrain`).
   */
  const save = (input: AgentBrainInput, done?: string) =>
    send(
      input,
      (next) => done ?? advancedSummary(t, i18n.language, { kind: next.brain, autoModel, now: advancedNow(next) }),
    );
  const putBack = () => {
    if (!view || !now) return;
    void save(advancedResetInput(view, now, autoModel));
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("agentPage.work.brain.advanced.title")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        {brain.isPending ? (
          <SkeletonList rows={4} />
        ) : !view || !now || !shown ? (
          <LoadFailed onRetry={() => void brain.refetch()} />
        ) : (
          <>
            {kind || view.brain === "model" ? (
              <>
                <Gap />
                <GroupedList>
                  {autoModel ? (
                    // "Automático" picks the effort too: the row says so and, on a plan, leads to a model, which
                    // brings the ramp (a key's model is chosen on its AI's screen).
                    <GroupedRow
                      label={t("agentPage.work.brain.effort")}
                      sub={t("agentPage.work.brain.effortText.auto")}
                      chevron={kind !== null}
                      onPress={kind ? () => router.push(`/agent-model/${agentId}` as never) : undefined}
                    />
                  ) : (
                    <View style={styles.ramp}>
                      <EffortRamp
                        value={effort.value}
                        onChange={effort.change}
                        color={agentLook(agent).color}
                        kind={view.brain}
                        disabled={!view.canEdit}
                      />
                    </View>
                  )}
                </GroupedList>
              </>
            ) : null}
            {viewSpeedFits(view) ? (
              <>
                <GroupedHeader
                  hint={{
                    name: t("common.about", { label: t("agentPage.work.brain.speed") }),
                    text: t("agentPage.work.brain.speedText"),
                  }}
                >
                  {t("agentPage.work.brain.speed")}
                </GroupedHeader>
                <GroupedList>
                  {SPEEDS.map((s) => (
                    <GroupedRow
                      key={s}
                      label={t(`agentPage.work.brain.speeds.${s}`)}
                      checked={speed.value === s}
                      disabled={!view.canEdit}
                      onPress={() => s !== speed.value && speed.change(s)}
                    />
                  ))}
                </GroupedList>
              </>
            ) : null}
            <GroupedHeader>{t("agentPage.work.brain.context")}</GroupedHeader>
            <GroupedList>
              <GroupedRow
                label={t("brain.auto.label")}
                sub={autoContextLine(t, view.brain)}
                subLines={2}
                checked={shown.contextTokens === null}
                disabled={!may}
                onPress={() => shown.contextTokens !== null && void save({ contextTokens: null })}
              />
              {options.map((n) => (
                <GroupedRow
                  key={n}
                  label={contextSize(n)}
                  sub={t(`agentPage.work.brain.contextText.${n}`)}
                  subLines={2}
                  checked={shown.contextTokens === n}
                  disabled={!may}
                  onPress={() => n !== shown.contextTokens && void save({ contextTokens: n })}
                />
              ))}
            </GroupedList>
            {kind ? (
              <>
                <GroupedHeader>{t("agentPage.work.brain.advanced.answers")}</GroupedHeader>
                {agent?.ownerUserId ? (
                  <PlanReplies
                    agent={name}
                    owner={view.canUsePlans ? undefined : ownerFirst}
                    on={!shown.onlyOwner}
                    onChange={async (on) => {
                      // The switch waits for its own save before it flips again.
                      if (pending.onlyOwner !== undefined) return;
                      // Letting more people in on someone else's plan asks first: it spends their plan.
                      if (on && view.onlyOwner && !(await ask(EVERYONE_AUDIENCE)([]))) return;
                      void save(
                        { onlyOwner: !on },
                        on
                          ? t("aiAccounts.share.savedEveryone", g)
                          : view.canUsePlans
                            ? t("aiAccounts.share.savedOwner", g)
                            : t("aiAccounts.share.savedOwnerOf", { ...g, owner: ownerFirst ?? "" }),
                      );
                    }}
                    brain={kind}
                    plan={signInPlan(view, row, kind)}
                    coding={planOf(current?.provider)}
                    keep
                  />
                ) : null}
              </>
            ) : null}
            {shown.accountPinned !== undefined ? (
              <>
                <Gap />
                <GroupedList>
                  <GroupedRow
                    label={t("agentPage.work.brain.pinned")}
                    hint={{
                      name: t("common.about", { label: t("agentPage.work.brain.pinned") }),
                      text: t("agentPage.work.brain.pinnedHint"),
                    }}
                    toggle={shown.accountPinned}
                    disabled={!may}
                    onPress={() =>
                      pending.accountPinned === undefined && void save({ accountPinned: !shown.accountPinned })
                    }
                  />
                </GroupedList>
              </>
            ) : null}
            <Gap />
            <GroupedList>
              <GroupedRow
                icon="undo"
                label={t("agentPage.work.brain.advanced.defaults")}
                disabled={!may || isAdvancedDefault(view.brain, shown)}
                onPress={putBack}
              />
            </GroupedList>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
  // On a grouped row's edges, as the rows around it.
  ramp: { paddingHorizontal: GROUPED_ROW.padX, paddingVertical: 12 },
});
