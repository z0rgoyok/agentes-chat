import {
  useAiAccounts,
  useBrainMachines,
  useCredentials,
  useModels,
  useNewAgentSetup,
  usePlatformKey,
} from "@agenteschat/client";
import { newAgentStart } from "@agenteschat/client/lib/agent-setup";
import { accountInLine } from "@agenteschat/client/lib/ai-accounts";
import { type AiChoice, aiChoiceBrainInput } from "@agenteschat/client/lib/ai-choice";
import {
  brainPickInput,
  brainPickOptions,
  planAccountOption,
  planAccountOptionOf,
} from "@agenteschat/client/lib/brain-picker";
import { can } from "@agenteschat/client/lib/permissions";
import { AUTO, modelChoices, usableModels } from "@agenteschat/client/lib/providers";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import type { PlanChoice } from "@/components/AgentFields";
import { usePlanHold } from "@/components/ai/plan-hold";
import { useOrg } from "@/components/org-context";

/**
 * What a new agent made from its card thinks with (ADR 0164), as "Criar agente" starts it (ADR 0094): the last setup
 * saved or used on other agents, where it can think for it; else a plan account of the person's own with room for one
 * more agent; else Automático on the API. `hasAi`: it will be able to think right away (else its chat asks for an AI).
 * `accountId`: a plan account of the person's own it starts on instead ("Criar um agente com este plano").
 */
export function useNewAgentBrain(accountId?: string, picked: AiChoice | null = null) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const models = useModels();
  const credentials = useCredentials(org.id);
  const platform = usePlatformKey(org.id);
  const brainMachines = useBrainMachines(org.id);
  const aiAccounts = useAiAccounts(org.id);
  const lastSetup = useNewAgentSetup(org.id);
  const held = usePlanHold() !== null;
  const choices = useMemo(
    () => modelChoices(models.data?.models ?? [], credentials.data ?? [], platform.data ?? false),
    [models.data, credentials.data, platform.data],
  );
  const usable = useMemo(() => usableModels(choices), [choices]);
  const start = newAgentStart(lastSetup.data, {
    ownerIsMe: true,
    admin: can(org, "manage_agents"),
    usable,
    keys: credentials.data ?? [],
  });
  const options = useMemo(
    () =>
      brainPickOptions(t, i18n.language, {
        api: choices,
        machines: brainMachines.data ?? [],
        accounts: aiAccounts.data?.accounts ?? [],
        ownerIsMe: true,
        held,
      }),
    [t, i18n.language, choices, brainMachines.data, aiAccounts.data, held],
  );
  const asked = accountId ? planAccountOptionOf(options, accountId)?.pick : undefined;
  const last = asked ? null : start;
  const own = asked ?? (start === null ? planAccountOption(options)?.pick : undefined);
  const plan: PlanChoice | null =
    last && last.brain !== "model"
      ? {
          kind: last.brain,
          machineId: last.machineId,
          ...(last.account ? { accountId: last.account.id, label: accountInLine(t, last.account) } : {}),
        }
      : own && "accountId" in own && own.accountId
        ? { kind: own.kind, machineId: own.machineId, accountId: own.accountId, label: own.account, model: AUTO }
        : null;
  const onModel = last?.brain === "model" ? last : null;
  /** What it starts on, as the "Quem pensa" field shows it. */
  const choice: AiChoice | null = plan
    ? { brain: plan.kind, machineId: plan.machineId, account: plan.accountId ?? null, model: null }
    : usable.size > 0 || onModel
      ? { brain: "model", model: onModel?.model ?? AUTO, key: onModel?.key ?? null }
      : null;
  // Picked in the field: that, applied the same way once the agent exists.
  if (picked)
    return {
      hasAi: !held,
      choice: picked,
      input: {
        model: picked.brain === "model" ? (picked.model ?? AUTO) : AUTO,
        credentialId: picked.brain === "model" ? (picked.key ?? null) : null,
        ...(start?.autonomy ? { autonomy: start.autonomy } : {}),
      },
      apply: async (agentId: string) => {
        if (picked.brain === "model") {
          if (picked.effort !== undefined) await api.agents.setBrain(org.id, agentId, { effort: picked.effort });
          return;
        }
        if (picked.machineId) await api.sandbox.setTarget(org.id, agentId, picked.machineId);
        await api.agents.setBrain(org.id, agentId, aiChoiceBrainInput(picked));
      },
    };
  return {
    choice,
    hasAi: !held && (plan !== null || onModel !== null || usable.size > 0),
    input: {
      model: onModel?.model ?? AUTO,
      credentialId: onModel?.key ?? null,
      ...(start?.autonomy ? { autonomy: start.autonomy } : {}),
    },
    /** Its plan, once it exists: the computer it thinks on, then its "Quem pensa". */
    apply: async (agentId: string) => {
      if (!plan) return;
      await api.sandbox.setTarget(org.id, agentId, plan.machineId);
      await api.agents.setBrain(org.id, agentId, last && last.brain !== "model" ? last.input : brainPickInput(plan));
    },
  };
}
