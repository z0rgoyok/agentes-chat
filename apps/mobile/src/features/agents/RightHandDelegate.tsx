import type { CardDelegate } from "@agenteschat/client";
import { useUndoRightHand } from "@agenteschat/client";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { can } from "@agenteschat/client/lib/permissions";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { Button } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useDirectory, useMeId } from "../shared/hooks";

/**
 * Desfazer on what the right hand approved (ADR 0139 §2), while it lasts: for the person it decided for, and who
 * manages the agent it made or changed (`targetAgentId`; the server's `undoRightHandDecision`, ADR 0085 addendum of
 * 2026-11-17), so a private agent's decision offers no Undo to who only holds "Edit agents". Not knowing that agent,
 * the key decides. `undo` is null when it can't be undone (any more, or by this person).
 */
function useDelegateUndo(d: CardDelegate | null | undefined, targetAgentId?: string | null) {
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const failed = useFailed();
  const undo = useUndoRightHand(orgId);
  const id = d?.decisionId;
  const target = targetAgentId ? dir.agentById.get(targetAgentId) : undefined;
  const manages = target ? managesAgent(target) : can(org, "manage_agents");
  const open =
    d?.state === "approved" &&
    id &&
    d.undoUntil &&
    Date.parse(d.undoUntil) > Date.now() &&
    (d.forUserId === meId || manages);
  return { undo: open && id ? () => undo.mutate(id, { onError: failed }) : null, pending: undo.isPending };
}

/** "Undo" as an action of the decided request's pill (`AskDone`), or nothing (no empty slot in the pill). */
export function useDelegateUndoAction(d: CardDelegate | null | undefined, targetAgentId?: string | null): ReactNode {
  const { t } = useTranslation();
  const { undo, pending } = useDelegateUndo(d, targetAgentId);
  return undo ? (
    <Button variant="ghost" size="card" label={t("rightHandApprovals.card.undo")} loading={pending} onPress={undo} />
  ) : null;
}
