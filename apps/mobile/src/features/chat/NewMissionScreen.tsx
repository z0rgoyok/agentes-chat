import { type MissionEligibleAgent, useCreateMission, useEligibleAgents, useMe } from "@agenteschat/client";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, OPTION_ROW, SkeletonList, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";
import { missionComputerText } from "../missions/logic";
import { Gap, SettingsPage, useUnsavedGuard } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useEdition, useNamesComputers, useOrgId } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import type { NewMissionStart } from "./new-mission";

/**
 * "Começar uma missão" / "Transformar em missão", a screen pushed over the conversation: the goal, who does it (the
 * agents that can run one for you, each with its computer or why it can't) and the bar's word that asks for the plan.
 * The agent makes a plan and waits for "Começar". Leaving with a goal typed asks first. The goal's field waits for the
 * person's tap: the screen never opens with the keyboard up over who does it.
 */
export function NewMissionScreen({
  channelId,
  threadId,
  goal: initialGoal = "",
  agentId,
  currentThreadId,
}: NewMissionStart) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const eligible = useEligibleAgents(orgId);
  // On the Cloud missions wait for the workspace's own computer: nobody connects one.
  const waitCloud = useCloudMissionWait();
  const cloud = useEdition() === "cloud";
  const names = useNamesComputers();
  const create = useCreateMission(orgId);
  const [goal, setGoal] = useState(initialGoal);
  const [picked, setPicked] = useState<string | null>(null);
  const leave = useUnsavedGuard(goal.trim() !== "" && goal.trim() !== initialGoal.trim() && !create.isSuccess);
  const list = eligible.data ?? [];
  const usable = list.filter((a) => a.eligible !== false);
  const chosen =
    picked ?? (agentId && usable.some((a) => a.agentId === agentId) ? agentId : null) ?? usable[0]?.agentId ?? null;
  const agent = list.find((a) => a.agentId === chosen);
  const ready = Boolean(chosen && goal.trim());
  const submit = () => {
    if (!chosen || !goal.trim() || create.isPending) return;
    create.mutate(
      { agentId: chosen, goal: goal.trim(), ...(threadId ? { threadId } : { channelId }) },
      {
        onSuccess: (mission) => {
          successHaptic();
          toast({ title: t("mobile.newMission.created", { name: agent?.name ?? "" }), agentId: mission.agentId });
          leave();
          // Its home is the thread on screen: back to it. Elsewhere (a new thread): that thread takes this screen's place.
          if (mission.threadId === (currentThreadId ?? null)) goBack();
          else router.replace(chatHref(mission.channelId, mission.threadId));
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  };

  return (
    <SettingsPage
      title={t("mobile.newMission.title")}
      action={{ label: t("mobile.newMission.submit"), disabled: !ready, onPress: submit }}
      busy={create.isPending}
    >
      <Gap />
      <TextArea
        value={goal}
        onChangeText={setGoal}
        placeholder={t("mobile.newMission.placeholder")}
        accessibilityLabel={t("mobile.newMission.placeholder")}
      />
      <GroupedFooter>{t("mobile.newMission.intro")}</GroupedFooter>
      <GroupedHeader>{t("mobile.newMission.who")}</GroupedHeader>
      {eligible.isPending ? (
        <SkeletonList rows={2} />
      ) : eligible.isError ? (
        <LoadFailed onRetry={() => void eligible.refetch()} />
      ) : list.length === 0 ? (
        <GroupedFooter>{waitCloud ?? t("mobile.newMission.noAgents")}</GroupedFooter>
      ) : (
        <GroupedList>
          {list.map((a) => {
            const why = (waitCloud && !a.machine ? waitCloud : whereText(t, a, { cloud, names })) ?? undefined;
            return (
              <GroupedRow
                key={a.agentId}
                leading={<AgentFace agentId={a.agentId} size={OPTION_ROW.face} live={false} />}
                label={a.name}
                {...(why ? { sub: why, subLines: 0 } : {})}
                checked={a.agentId === chosen}
                disabled={a.eligible === false}
                {...(a.eligible === false ? {} : { onPress: () => setPicked(a.agentId) })}
              />
            );
          })}
        </GroupedList>
      )}
    </SettingsPage>
  );
}

/**
 * "Missions start once Acme's computer is ready." on the Cloud (a personal workspace's: once your agents' computer is,
 * ADR 0159); null elsewhere.
 */
function useCloudMissionWait() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const org = useMe().data?.organizations.find((o) => o.id === orgId);
  if (useEdition() !== "cloud") return null;
  return t("missions.waitingCloud", {
    computer: t(modeKey(org, "computerSetup.titleInSentence"), { org: org?.name ?? "" }),
  });
}

/**
 * "MacBook do Walter · ligado" (`missionComputerText`: by name only where the workspace has more than one), or why
 * it can't do a mission for you; the Cloud's computer is never off.
 */
function whereText(t: TFunction, a: MissionEligibleAgent, where: { cloud: boolean; names: boolean }) {
  if (a.eligible === false && a.reason) return t(`mobile.newMission.reason.${a.reason}`);
  if (!a.machine) return t("mobile.newMission.reason.no_computer");
  return missionComputerText(t, a.machine, where);
}
