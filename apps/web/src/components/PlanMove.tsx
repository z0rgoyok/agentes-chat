import type { PlanMove } from "@agenteschat/client";
import { Button, Icon, InfoHint } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/** A button per workspace the plan can go to, the one asked busy and every one disabled meanwhile. */
export function PlanMoveButtons({ plan, size }: { plan: PlanMove; size?: "sm" }) {
  const { t } = useTranslation();
  const { move } = plan;
  return plan.targets.map((to) => (
    <Button
      key={to.id}
      type="button"
      size={size}
      loading={move.isPending && move.variables === to.id}
      disabled={move.isPending}
      onClick={() => plan.start(to)}
    >
      {t("planMove.button", { name: to.name })}
    </Button>
  ));
}

/** `planMove.how` behind an ⓘ, beside a line about the plan. */
export function PlanMoveHow({ label }: { label: string }) {
  const { t } = useTranslation();
  return <InfoHint name={t("common.about", { label })}>{t("planMove.how")}</InfoHint>;
}

/**
 * The line in the dialog that deletes the workspace, for its payer with another workspace to move the plan to: what
 * happens to the plan, with a button per workspace under it; once asked, where it is going.
 */
export function PlanMoveLine({ plan }: { plan: PlanMove }) {
  const { t } = useTranslation();
  const warning = t("planMove.warning");
  return (
    <li className="ac-iconline">
      <Icon name="coin" size={16} />
      {plan.movedTo ? (
        <span role="status">{t("planMove.moving", { name: plan.movedTo })}</span>
      ) : (
        <div>
          <span className="ac-hintline">
            {warning}
            <PlanMoveHow label={warning} />
          </span>
          <div className="deletion-acts">
            <PlanMoveButtons plan={plan} size="sm" />
          </div>
        </div>
      )}
    </li>
  );
}
