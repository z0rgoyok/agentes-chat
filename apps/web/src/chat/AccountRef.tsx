import { type RunAccount, type RunAccountSwitch, useAccountOrder } from "@agenteschat/client";
import { accountCardFacts, accountInOrder, accountMark, accountTitle } from "@agenteschat/client/lib/ai-accounts";
import { PlanMeter, Popover, ProviderLogo, useHoverCard } from "@agenteschat/ui";
import { Trans, useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { HOVER_OPEN_MS } from "@/components/ProfileCard";
import { planMeterText } from "@/lib/plan-usage";

/**
 * An AI account a run thought with, as a pill like a #channel's: its maker's mark and the name it went by. Its card, on
 * hover, focus or a press, says which plan it is, whose, on which computer and how much of it is used.
 */
export function AccountRef({ account }: { account: RunAccount }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const order = useAccountOrder(org.id);
  const card = useHoverCard(HOVER_OPEN_MS);
  const found = accountInOrder(order.data?.groups, account.id);
  return (
    <Popover
      hover={card}
      label={t("accountRef.card", { name: account.name })}
      side="bottom"
      className="profile-card channel-card account-card"
      trigger={
        <button
          type="button"
          className={found ? "channel-ref id-ref account-ref" : "channel-ref"}
          aria-label={t("accountRef.label", { name: account.name })}
          aria-haspopup="dialog"
        >
          {found && <ProviderLogo id={accountMark(found.account)} size="xs" />}
          {account.name}
        </button>
      }
    >
      {card.open && <AccountCardBody account={account} />}
    </Popover>
  );
}

function AccountCardBody({ account }: { account: RunAccount }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const order = useAccountOrder(org.id);
  const found = accountInOrder(order.data?.groups, account.id);
  if (!found) {
    return (
      <div className="profile-card__body">
        <span className="profile-card__name">{account.name}</span>
        <p className="small muted channel-card__facts">
          {order.isPending ? t("channelRefs.loading") : t("accountRef.gone")}
        </p>
      </div>
    );
  }
  const a = found.account;
  return (
    <div className="profile-card__body">
      <div className="channel-card__head">
        <ProviderLogo id={accountMark(a)} size="sm" />
        <span className="profile-card__name">{accountTitle(t, a)}</span>
      </div>
      <p className="small muted channel-card__facts">{accountCardFacts(t, a, found.computer).join(" · ")}</p>
      {a.usage && <PlanMeter compact usage={a.usage} text={planMeterText(t, i18n.language)} />}
    </div>
  );
}

/** "Went on with the [B] account because the [A] account hit its limit": a run's switch, its accounts as pills. */
export function AccountSwitchLine({ move }: { move: RunAccountSwitch }) {
  return (
    <Trans
      i18nKey={`accountSwitch.${move.cause}` as "accountSwitch.limit"}
      components={{ to: <AccountRef account={move.to} />, from: <AccountRef account={move.from} /> }}
    />
  );
}
