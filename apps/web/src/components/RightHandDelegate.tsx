import type { CardDelegate } from "@agenteschat/client";
import { useUndoRightHand } from "@agenteschat/client";
import { delegateLine } from "@agenteschat/client/lib/approval-words";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * What the right hand did with a card (ADR 0139 §2), in the viewer's words: "Aprovado por Gerente em nome de Ana", "Gerente
 * passou para você: …". Null when there is nothing to say to this viewer.
 */
export function useDelegateLine(d: CardDelegate | null | undefined) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  if (!d) return null;
  return delegateLine(t, d, me.user.id, (id) => dir.memberById.get(id)?.name, dir.anyAgent(d.agentId)?.name ?? "");
}

/** On an open card: the right hand's line above the decision (deciding, passed with why, out of its reach). */
export function DelegateNote({ d }: { d: CardDelegate | null | undefined }) {
  const line = useDelegateLine(d);
  if (!line || !d) return null;
  return (
    <p className="rq__delegate ac-iconline">
      <Icon name={d.state === "deciding" ? "clock" : "agent"} size={14} />
      <span>{line}</span>
    </p>
  );
}

/**
 * "Undo" on what it approved, while it lasts (in its card's footer): for the person it decided for, and who manages
 * the agent it made or changed (`agentId`; the server's `undoRightHandDecision`, ADR 0085 addendum of 2026-11-17), so
 * a private agent's decision shows no Undo to who only holds "Edit agents". Not knowing that agent, the key decides.
 */
export function DelegateUndo({ d, agentId }: { d: CardDelegate | null | undefined; agentId?: string | null }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const undo = useUndoRightHand(org.id);
  const target = agentId ? dir.agentById.get(agentId) : undefined;
  const manages = target ? managesAgent(target) : can(org, "manage_agents");
  const open =
    d?.state === "approved" &&
    d.decisionId &&
    d.undoUntil &&
    Date.parse(d.undoUntil) > Date.now() &&
    (d.forUserId === me.user.id || manages);
  if (!open || !d.decisionId) return null;
  const id = d.decisionId;
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={undo.isPending}
      onClick={() => undo.mutate(id, { onError: (e) => toast.show(errorText(t, e), "error") })}
    >
      {t("rightHandApprovals.card.undo")}
    </Button>
  );
}
