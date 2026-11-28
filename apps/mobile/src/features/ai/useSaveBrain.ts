import type { AgentBrain, AgentBrainInput, BrainScope } from "@agenteschat/client";
import { keys, useApi } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useToast } from "@/ui";

type Field = keyof AgentBrainInput;
const fieldsOf = (input: AgentBrainInput) => Object.keys(input) as Field[];

/**
 * Saves a change to the agent's AI at once and says so (or that it failed). The change shows before the server answers:
 * `pending` holds the fields still on their way, which the screen draws over what is saved, so a switch flips and a
 * check moves on the tap. Only that row waits; another one can change meanwhile, and a newer change of the same field
 * wins (the older one's answer says nothing). A failure says so and the row goes back to what is saved. `undo`: what
 * the saved toast's Desfazer saves back, then `giveBack` runs (a login taken from other agents goes back to them).
 * `scope`: which of the right hand's two AIs (its own cache entry).
 */
export function useSaveBrain(agentId: string, scope?: BrainScope) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState<AgentBrainInput>({});
  // The same fields, read when an answer comes in (the state is the render's, possibly older).
  const live = useRef<AgentBrainInput>({});
  const put = (next: AgentBrainInput) => {
    live.current = next;
    setPending(next);
  };
  // Every field this change set is still the newest of its field.
  const newest = (input: AgentBrainInput) => fieldsOf(input).every((k) => live.current[k] === input[k]);
  /**
   * `done`: what the toast says once saved; null says nothing (the screen says it in place). `then` runs once the change
   * is saved, before it is said (a Desfazer's `giveBack`). The saved view, or null.
   */
  const save = async (
    input: AgentBrainInput,
    done: string | ((saved: AgentBrain) => string) | null,
    undo?: AgentBrainInput,
    giveBack?: () => Promise<void>,
    then?: () => Promise<void>,
  ): Promise<AgentBrain | null> => {
    put({ ...live.current, ...input });
    try {
      const saved = await api.agents.setBrain(orgId, agentId, { ...(scope ? { scope } : {}), ...input });
      qc.setQueryData(scope ? [...keys.agentBrain(orgId, agentId), scope] : keys.agentBrain(orgId, agentId), saved);
      await then?.();
      if (newest(input) && done !== null)
        toast({
          title: typeof done === "string" ? done : done(saved),
          icon: "check",
          ...(undo
            ? {
                action: {
                  label: t("agentPage.work.brain.v2.undo"),
                  onPress: () => void save(undo, t("agentPage.work.brain.v2.undone"), undefined, undefined, giveBack),
                },
              }
            : {}),
        });
      return saved;
    } catch {
      if (newest(input)) toast({ title: t("agentPage.work.failed"), icon: "x" });
      return null;
    } finally {
      // Its fields show what the server says now, unless a newer change of the same field is still on its way.
      put(
        Object.fromEntries(
          Object.entries(live.current).filter(([k, value]) => !(k in input) || input[k as Field] !== value),
        ) as AgentBrainInput,
      );
      for (const key of [
        keys.agentBrain(orgId, agentId),
        keys.agents(orgId),
        keys.aiAccounts(orgId),
        keys.aiStatus(orgId),
      ])
        void qc.invalidateQueries({ queryKey: key });
    }
  };
  return { pending, save };
}
