import { useAiStatus } from "@agenteschat/client";
import { teamThinks } from "@agenteschat/client/lib/no-ai";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnectAi, useMayConnectAi } from "@/components/connect-ai-context";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { ARRIVAL_BETA_ONLY, ARRIVAL_PARAM } from "@/lib/arrival";
import { useOpenParam } from "@/lib/open-param";
import { usePaidMoment } from "@/lib/paid-return";
import { BetaDialog } from "./BetaDialog";
import { PaidCard, PaidDialog, type PaidNext } from "./PaidMoment";

/**
 * Right after the onboarding (ADR 0160): the beta notice, then Connect an AI with the team on its stage, for a
 * person who has an AI to connect while some agent has none. Asked for by the address, once: the mark is dropped as
 * it opens, so a reload or Back shows neither again. `?arrival=beta` is the notice alone: the onboarding already
 * asked for the AI in its own step, or the plan was left for later and its row leads the right hand's card (ADR 0162).
 *
 * Right after paying (ADR 0079, `usePaidMoment`), the moment the plan turned on, once its hold lifts: in full on the
 * page the return landed on (before the beta notice when both came together, after it when the plan turned on during
 * it), else as a card in the corner. One thing at a time: never two dialogs, and the card never over one (it sits
 * under every dialog's scrim).
 */
export function Arrival() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [asked, clear] = useOpenParam(ARRIVAL_PARAM);
  // The value it was asked with, kept once the address drops it; null: nothing to show.
  const [beta, setBeta] = useState<string | null>(null);
  // A dialog of the person's own open as the plan turns on: the moment comes as the card, under it. The beta notice is
  // this component's, and the moment follows it.
  const paid = usePaidMoment(org.id, org.standing, beta === null && document.querySelector("[role='dialog']") !== null);
  // The paid moment was there as the notice was asked for: it comes first. One that comes during the notice waits.
  const [paidFirst, setPaidFirst] = useState(false);
  const connect = useConnectAi();
  const mayConnect = useMayConnectAi();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per link
  useEffect(() => {
    if (asked === null) return;
    setBeta(asked);
    setPaidFirst(paid.moment !== null);
    clear(null);
  }, [asked]);
  // Every agent already thinks (a workspace joined with its AI in place): nothing to connect.
  const allThink =
    teamThinks(
      dir.agents.map((a) => a.id),
      status.data,
    ) === true;
  const toConnect = mayConnect && !allThink && connect !== null;
  // Before the notice, the moment's way on is the notice itself (Continue).
  if (paid.moment && beta !== null && paidFirst)
    return <PaidDialog moment={paid.moment} next={null} onClose={paid.done} onScreen={paid.onScreen} />;
  if (beta !== null)
    return (
      <BetaDialog
        onContinue={() => {
          const was = beta;
          setBeta(null);
          // A paid moment waiting after the notice leads to Connect itself, as its one way on.
          if (was !== ARRIVAL_BETA_ONLY && toConnect && !paid.moment) connect?.open({ arrival: true });
        }}
      />
    );
  // Its one way on is known before it shows: never a button that changes under the person.
  if (!paid.moment || dir.loading || status.isPending) return null;
  // The one way on: an AI for the team to think with, else the first conversation, with the right hand.
  const lead = rightHandOf(dir.agents);
  const leadPath = lead ? `/org/${org.id}/dm/agent/${lead.id}` : null;
  const next: PaidNext = toConnect
    ? { label: t("paidMoment.next.ai"), run: () => connect?.open({}) }
    : lead && leadPath !== path
      ? {
          label: t("paidMoment.next.talk", { name: lead.name }),
          run: () =>
            void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: lead.id } }),
        }
      : null;
  return paid.form === "dialog" ? (
    <PaidDialog moment={paid.moment} next={next} onClose={paid.done} onScreen={paid.onScreen} />
  ) : (
    <PaidCard moment={paid.moment} next={next} onClose={paid.done} onScreen={paid.onScreen} />
  );
}
