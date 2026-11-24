import { useAuthConfig, useComputerSetup } from "@agenteschat/client";
import type { BillingHold } from "@agenteschat/client/lib/billing";
import { computerEdition } from "@agenteschat/client/lib/computer";
import { planHoldOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { SettingNote } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { useOrg } from "@/components/org-context";

// Apart from the plans' steps (`ConnectAiSteps.tsx`): cards everywhere (a message's, the Home's first steps) read the
// hold, and the steps come only with the dialog that shows them.

/** The billing hold on this workspace that stops its plans (`planHoldOf`). */
export function usePlanHold() {
  const { org } = useOrg();
  return planHoldOf(computerEdition(useComputerSetup(org.id).data), org.standing);
}

/**
 * A plan a workspace with no agentes.chat plan in force can't use, in place of its steps: why, and the way to that
 * plan for whoever pays (anyone else reads who can). A hold stops the Model Gateway for keys too, so no key is offered
 * as a way around it.
 */
export function PlanHold({ hold }: { hold: BillingHold }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const billingUrl = useAuthConfig().data?.billingUrl;
  const canPay = can(org, "manage_billing") && Boolean(billingUrl);
  return (
    <>
      <SettingNote icon="alert">{t("connectAi.billing")}</SettingNote>
      {canPay ? (
        <span className="ac-acts">
          <BillingLinkButton orgId={org.id} from="hold" size="sm" variant="primary">
            {t(`standing.billing.cta.${hold}`)}
          </BillingLinkButton>
        </span>
      ) : (
        <SettingNote icon="lock">{t("standing.billing.askAdmin")}</SettingNote>
      )}
    </>
  );
}
