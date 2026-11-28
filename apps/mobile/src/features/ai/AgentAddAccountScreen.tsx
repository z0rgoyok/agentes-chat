import { useAgentBrain, useMachines } from "@agenteschat/client";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { namesText } from "@agenteschat/client/lib/format";
import { PLAN_CHOICES, type PlanChoice, planLabel, planMark, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isPlanId } from "@agenteschat/client/lib/plans";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedList, GroupedRow, ProviderLogo, SkeletonList } from "@/ui";
import { router } from "@/ui/navigation";
import { Gap, SettingsPage } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { openConnectAi } from "./NoAiCard";
import { Note, usePlanHold } from "./parts";

/** The AIs "Add account" lists first, the most used; the others fold under "Another plan", as on the web. */
const ADD_FIRST: readonly PlanChoice[] = ["claude", "chatgpt", "gemini"];
const ADD_MORE = PLAN_CHOICES.filter((c) => !ADD_FIRST.includes(c));

/** "Add account" for an agent, pushed from the end of its AI's account list (`AgentAiScreen`). */
export const openAgentAddAccount = (agentId: string) => router.push(`/agent-add-account/${agentId}` as never);

/**
 * "Add account" for an agent (ADR 0032, addendum 2026-11-24, the web's "Quem pensa" add screen on the phone): one
 * row per AI, the person's accounts of it on the agent's computer at its end ("You have 1"), the other plans folded
 * under "Another plan" and opened in place, then "API key" for who adds the workspace's keys. A row opens that AI's
 * sign-in, Connect an AI's page for it, for this agent: the agent thinks with the account once it is in, and back on
 * its AI the change is said with "Undo". On a computer someone else connected, the line says who connects a plan
 * there; Connect then signs in elsewhere (the person's own computer) or takes a key.
 */
export function AgentAddAccountScreen({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const hold = usePlanHold(orgId, org);
  const brain = useAgentBrain(orgId, agentId, true);
  const view = brain.data;
  const [others, setOthers] = useState(false);
  const lockedHere = view?.canUsePlans === true && !view.canManageAccounts && view.computer !== null;
  const pairer = useMachines(orgId, lockedHere).data?.find((m) => m.id === view?.computer?.machineId)?.pairedBy;
  const computer = computerNameOf(t, org?.name ?? "", view?.computer?.name ?? "", isPersonal(org));
  const plans = view?.canUsePlans === true && !hold;
  const keys = can(org, "manage_credentials") && !hold;
  // The person's accounts of a plan on the agent's computer.
  const have = (c: PlanChoice) => view?.accounts.filter((a) => a.mine && planOfAccount(a) === c).length ?? 0;
  const add = (c: PlanChoice) => openConnectAi({ agentId, ...(isPlanId(c) ? { plan: c } : { intent: c }) });
  const row = (c: PlanChoice) => {
    const n = have(c);
    return (
      <GroupedRow
        key={c}
        leading={<ProviderLogo id={planMark(c)} size="sm" />}
        label={planLabel(t, c)}
        {...(n > 0 ? { value: t("agentPage.work.brain.add.have", { count: n }) } : {})}
        chevron
        onPress={() => add(c)}
      />
    );
  };
  return (
    <SettingsPage title={t("agentPage.work.brain.add.pickTitle")}>
      {brain.isPending ? (
        <SkeletonList rows={4} />
      ) : !view ? (
        <LoadFailed onRetry={() => void brain.refetch()} />
      ) : (
        <>
          {lockedHere ? (
            <Note icon="lock" inset>
              {t("connectAi.accountsLocked", { name: pairer?.name.split(" ")[0] ?? "", computer })}
            </Note>
          ) : null}
          <Gap />
          {plans ? (
            <GroupedList>
              {ADD_FIRST.map(row)}
              <GroupedRow
                key="others"
                icon="plus"
                label={t("agentPage.work.brain.add.others")}
                {...(others
                  ? {}
                  : {
                      value: namesText(
                        t,
                        ADD_MORE.map((c) => planLabel(t, c)),
                        2,
                      ),
                    })}
                chevron={!others}
                onPress={() => setOthers((v) => !v)}
              />
              {others ? ADD_MORE.map(row) : null}
            </GroupedList>
          ) : null}
          {keys ? (
            <>
              {plans ? <Gap /> : null}
              <GroupedList>
                <GroupedRow
                  icon="key"
                  label={t("agentPage.work.brain.add.key")}
                  value={t("agentPage.work.brain.add.keyLine")}
                  chevron
                  onPress={() => openConnectAi({ agentId, intent: "api_key" })}
                />
              </GroupedList>
            </>
          ) : null}
          {plans ? <GroupedFooter>{t("agentPage.work.brain.add.pickFoot")}</GroupedFooter> : null}
        </>
      )}
    </SettingsPage>
  );
}
