import { parseCustomModel } from "@agenteschat/providers/catalog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import {
  type AiChoice,
  type AiChoiceRow,
  type AiChoiceTarget,
  aiChoiceBrainInput,
  aiChoiceEfforts,
  aiChoiceModels,
  aiChoiceOf,
  aiChoiceRows,
  aiChoiceSetup,
} from "../lib/ai-choice";
import type { EffortLevel } from "../lib/brain-advanced";
import type { ModelRow } from "../lib/brain-picker";
import { useApi } from "./context";
import { keys } from "./keys";
import { useMissionBrain, useSetMissionBrain } from "./missions";
import {
  useAgentBrain,
  useAgentDetail,
  useAiAccounts,
  useBrainMachines,
  useMe,
  useModels,
  useNewAgentSetup,
  useSettings,
  useUpdateSettings,
} from "./queries";
import type { AccountPermissions, AgentSetupResult, AiAccounts, BrainOption } from "./types";

/**
 * "Contas de IA" as one view (`GET …/ai-accounts`'s `hub`): every plan account on the workspace's computers with the
 * viewer's rights, the API keys, the order of use and the API-key switch. `hub` null: still loading, or an older server.
 */
export function useAiHub(orgId: string, enabled = true) {
  const query = useAiAccounts(orgId, enabled);
  return {
    hub: query.data?.hub ?? null,
    loading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * An account's Gerenciar, Usar em agentes and Atender todos. Agents moved off it change their "Quem pensa", so those
 * and the order refetch too.
 */
export function useSetAccountPermissions(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, permissions }: { accountId: string; permissions: Partial<AccountPermissions> }) =>
      api.machines.setAccountPermissions(orgId, accountId, permissions),
    onSuccess: (saved, { accountId }) => {
      qc.setQueryData<AiAccounts>(keys.aiAccounts(orgId), (old) =>
        old?.hub
          ? {
              ...old,
              hub: {
                ...old.hub,
                accounts: old.hub.accounts.map((a) =>
                  a.id === accountId || a.sameAs === accountId ? { ...a, permissions: saved.permissions } : a,
                ),
              },
            }
          : old,
      );
      void qc.invalidateQueries({ queryKey: keys.aiAccounts(orgId) });
      if (saved.agentIds.length > 0) void qc.invalidateQueries({ queryKey: keys.agentPages(orgId) });
    },
  });
}

/** "Continuar com a chave de API quando todos os planos estiverem no limite" (admins). */
export function useSetKeyFallback(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) => api.machines.setKeyFallback(orgId, on),
    onSuccess: ({ on }) => {
      qc.setQueryData<AiAccounts>(keys.aiAccounts(orgId), (old) =>
        old?.hub ? { ...old, hub: { ...old.hub, keyFallback: on } } : old,
      );
      qc.setQueryData<{ keyFallback?: boolean }>(keys.accountOrder(orgId), (old) =>
        old ? { ...old, keyFallback: on } : old,
      );
    },
  });
}

/** What `useAiChoice` gives a picker. */
export interface AiChoiceState {
  /** The "Conta" select's options, grouped (`AiChoiceRow.group`) and in order; dimmed ones say why. */
  rows: AiChoiceRow[];
  /** What the target thinks with now; null: nothing yet (a new agent, several agents). */
  current: AiChoice | null;
  /** The row of `current`. */
  selected: AiChoiceRow | null;
  /** The "Modelo" select for a row, worded with the app's `t`. */
  models: (row: AiChoiceRow, t: TFunction) => ModelRow[];
  /** The "Esforço" select for a row. */
  efforts: (row: AiChoiceRow) => readonly EffortLevel[];
  /** The choice a row makes (its model and effort kept while the brain stays). */
  choose: (row: AiChoiceRow) => AiChoice;
  /**
   * Saves a choice for the target. `newAgent`: nothing is saved, the caller applies it once the agent exists.
   * `agents`: each agent's result (`preview`: what it would do, nothing kept).
   */
  save: (choice: AiChoice, options?: { preview?: boolean }) => Promise<AgentSetupResult[] | null>;
  saving: boolean;
  loading: boolean;
  /** The caller may change it (an agent's owner or who manages it; a mission before Start). */
  canEdit: boolean;
}

const agentId = (t: AiChoiceTarget) => (t.kind === "agent" || t.kind === "lodi" ? t.agentId : "");
const missionId = (t: AiChoiceTarget) => (t.kind === "mission" ? t.missionId : null);

/**
 * The one "Quem pensa" choice for any target: an agent, Lodi (`mine`, with "A do workspace" first, or `workspace`), a
 * new agent, a mission, several agents ("Usar em outros agentes") or an Automático tier. Built from `useAiHub` and the
 * target's own view; `save` goes where each target's choice is kept.
 */
export function useAiChoice(orgId: string, target: AiChoiceTarget): AiChoiceState {
  const api = useApi();
  const qc = useQueryClient();
  const me = useMe();
  const { hub, loading } = useAiHub(orgId);
  const viewerId = me.data?.user.id ?? "";
  const brainTarget = target.kind === "agent" || target.kind === "lodi";
  const brain = useAgentBrain(
    orgId,
    agentId(target),
    brainTarget,
    false,
    target.kind === "lodi" ? target.scope : undefined,
  );
  const apiAgent = target.kind === "agent" && brain.data?.brain === "model";
  const detail = useAgentDetail(orgId, agentId(target), apiAgent);
  const machines = useBrainMachines(orgId);
  const newSetup = useNewAgentSetup(orgId, target.kind === "newAgent");
  const mission = useMissionBrain(orgId, missionId(target), target.kind === "mission");
  const setMission = useSetMissionBrain(orgId, missionId(target) ?? "");
  const settings = useSettings(orgId);
  const updateSettings = useUpdateSettings(orgId);
  const models = useModels();

  const current = currentOf(target, {
    brain: brain.data,
    agent: detail.data,
    newSetup: newSetup.data,
    mission: mission.data,
    autoModels: settings.data?.autoModels,
  });
  const view = brain.data;
  const rows = aiChoiceRows(hub, {
    target,
    viewerId,
    current,
    // An agent's plan thinks on its computer; Lodi's on any.
    ...(target.kind === "agent" ? { machineId: view?.computer?.machineId ?? null } : {}),
    ...(target.kind === "agent" && view
      ? { usable: new Set(view.accounts.filter((a) => a.usable ?? a.serves !== "owner").map((a) => a.id)) }
      : {}),
    ...(mission.data ? { brains: mission.data.options } : {}),
  });
  const optionsFor = (row: AiChoiceRow): BrainOption[] => {
    if (target.kind === "mission") return mission.data?.options ?? [];
    if (target.kind === "agent" && view) return view.options;
    const machineId = row.account?.machineId;
    return machines.data?.find((m) => m.machineId === machineId)?.options ?? view?.options ?? [];
  };
  const catalog = models.data?.models ?? [];

  const mutation = useMutation({
    mutationFn: async ({ choice, preview }: { choice: AiChoice; preview?: boolean }) => {
      switch (target.kind) {
        case "agent":
        case "lodi": {
          const scope = target.kind === "lodi" ? target.scope : undefined;
          // On the API the model is the agent's own field (`…/brain` refuses one for the API brain); a person's own
          // Lodi on the API is the workspace's, whose model isn't theirs to change.
          if (choice.brain === "model") {
            const { model, ...rest } = choice;
            const fields = {
              ...(choice.key !== undefined ? { credentialId: choice.key } : {}),
              ...(model ? { model } : {}),
            };
            if (scope !== "mine" && Object.keys(fields).length > 0)
              await api.agents.update(orgId, target.agentId, fields);
            await api.agents.setBrain(orgId, target.agentId, aiChoiceBrainInput(rest, scope));
            return null;
          }
          await api.agents.setBrain(orgId, target.agentId, aiChoiceBrainInput(choice, scope));
          return null;
        }
        case "mission":
          // Its brain stays what it follows (the executor) unless another was picked.
          await setMission.mutateAsync({
            ...(choice.brain !== current?.brain ? { brain: choice.brain } : {}),
            model: choice.model ?? null,
          });
          return null;
        case "agents":
          return api.agents.applySetup(orgId, {
            setup: aiChoiceSetup(choice),
            agentIds: [...target.agentIds],
            ...(preview ? { preview } : {}),
          });
        case "autoTier": {
          const all = settings.data?.autoModels ?? {};
          await updateSettings.mutateAsync({
            autoModels: {
              ...all,
              [target.provider]: { ...all[target.provider], [target.tier]: choice.model ?? undefined },
            },
          });
          return null;
        }
        case "newAgent":
          return null;
      }
    },
    onSuccess: () => {
      if (brainTarget || target.kind === "agents")
        for (const key of [keys.agentPages(orgId), keys.agents(orgId), keys.aiStatus(orgId)])
          void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: keys.aiAccounts(orgId) });
    },
  });

  return {
    rows,
    current,
    selected: rows.find((r) => r.selected) ?? null,
    models: (row, t) => aiChoiceModels(t, row, { current, options: optionsFor(row), models: catalog }),
    efforts: aiChoiceEfforts,
    choose: (row) => aiChoiceOf(row, current),
    save: (choice, options) => mutation.mutateAsync({ choice, ...(options?.preview ? { preview: true } : {}) }),
    saving: mutation.isPending,
    loading:
      loading ||
      (brainTarget && brain.isLoading) ||
      (apiAgent && detail.isLoading) ||
      (target.kind === "mission" && mission.isLoading) ||
      (target.kind === "newAgent" && newSetup.isLoading),
    canEdit:
      target.kind === "mission" ? (mission.data?.canSetModel ?? false) : brainTarget ? (view?.canEdit ?? false) : true,
  };
}

/** What a target thinks with now, as its own view says it. */
export function currentOf(
  target: AiChoiceTarget,
  from: {
    brain?: {
      brain: AiChoice["brain"];
      account: string | null;
      model: string | null;
      effort: AiChoice["effort"];
      computer: { machineId: string } | null;
    };
    agent?: { model: string; credentialId: string | null };
    newSetup?: {
      brain: AiChoice["brain"];
      model: string | null;
      key: string | null;
      account?: { id: string } | null;
      computer?: { machineId: string };
      effort?: AiChoice["effort"];
    } | null;
    mission?: { effectiveBrain: AiChoice["brain"]; effectiveModel: string | null };
    autoModels?: Partial<Record<string, Partial<Record<string, string>>>>;
  },
): AiChoice | null {
  switch (target.kind) {
    case "agent":
    case "lodi": {
      const b = from.brain;
      if (!b) return null;
      // The brain view's model belongs to a plan; the API model and key live on the agent itself.
      if (target.kind === "agent" && b.brain === "model") {
        const a = from.agent;
        if (!a) return null;
        return {
          brain: b.brain,
          key: parseCustomModel(a.model)?.credentialId ?? a.credentialId,
          account: null,
          machineId: b.computer?.machineId ?? null,
          model: a.model,
          effort: b.effort,
        };
      }
      return {
        brain: b.brain,
        account: b.brain === "model" ? null : b.account,
        machineId: b.computer?.machineId ?? null,
        model: b.model,
        effort: b.effort,
      };
    }
    case "newAgent": {
      const s = from.newSetup;
      if (!s) return null;
      return {
        brain: s.brain,
        key: s.key,
        account: s.account?.id ?? null,
        machineId: s.computer?.machineId ?? null,
        model: s.model,
        ...(s.effort !== undefined ? { effort: s.effort } : {}),
      };
    }
    case "mission":
      return from.mission ? { brain: from.mission.effectiveBrain, model: from.mission.effectiveModel } : null;
    case "autoTier": {
      const model = from.autoModels?.[target.provider]?.[target.tier];
      return { brain: "model", model: model ?? null };
    }
    case "agents":
      return null;
  }
}
