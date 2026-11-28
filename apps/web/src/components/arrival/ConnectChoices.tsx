import { joinNames } from "@agenteschat/client/lib/format";
import { type AiChoice, PLAN_CHOICES, type PlanChoice, planLabel, planMark } from "@agenteschat/client/lib/no-ai";
import { Icon, type OptionLinkItem, OptionLinks, ProviderLogo } from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

/** The two plans most people have, on top; OpenCode's free models last, as the way in without a plan. */
const FIRST: readonly PlanChoice[] = ["claude", "chatgpt"];
const FREE: PlanChoice = "zen";
const OTHERS = PLAN_CHOICES.filter((c) => !FIRST.includes(c) && c !== FREE);

/**
 * Which AI, as the first thing a new workspace's owner is asked (ADR 0160): one card each, in words, instead of the
 * picker's two controls. A pick opens that plan's own steps (`PlanPanel`, `KeyPanel`), unchanged.
 */
export function ConnectChoices({
  onPick,
  dims,
  mayAddKey,
  perAgent,
  offSystem,
}: {
  onPick: (choice: AiChoice) => void;
  /** A plan that can't sign in now: its mark dims, and its steps say why. */
  dims: (choice: PlanChoice) => boolean;
  /** The computer's system where a plan doesn't run there (`planOffSystem`): its card says so before it is picked. */
  offSystem?: (choice: PlanChoice) => string | null;
  mayAddKey: boolean;
  /**
   * For several agents: a plan that will ask for one login per agent there ends its card saying so, quietly, before
   * it is picked (ADR 0160, addendum).
   */
  perAgent?: (choice: PlanChoice) => boolean;
}) {
  const { t } = useTranslation();
  const [others, setOthers] = useState(false);
  const card = (
    choice: AiChoice,
    leading: ReactNode,
    title: string,
    description: string,
    more: Pick<OptionLinkItem, "tag" | "side"> = {},
  ): OptionLinkItem => ({ value: choice, leading, title, description, onSelect: () => onPick(choice), ...more });
  const off = (c: PlanChoice) => offSystem?.(c) ?? null;
  const plan = (c: PlanChoice) =>
    card(
      c,
      <ProviderLogo id={planMark(c)} size="tile" off={dims(c)} />,
      planLabel(t, c),
      off(c) ? t("connectAi.offSystem", { system: off(c) }) : t(`connectAi.plan.${c}.tiers`),
      // A plan that can't run there has no logins to count.
      perAgent?.(c) && !off(c) ? { side: t("connectAi.team.perAgent") } : {},
    );
  const offOthers = OTHERS.filter((c) => off(c));
  const more: OptionLinkItem = {
    value: "others",
    leading: (
      <span className="arrival-opts__tile arrival-opts__tile--four" aria-hidden="true">
        {OTHERS.slice(0, 4).map((c) => (
          <ProviderLogo key={c} id={planMark(c)} size="xs" />
        ))}
      </span>
    ),
    title: t("arrival.connect.others"),
    description: (
      <>
        {joinNames(
          OTHERS.map((c) => planLabel(t, c)),
          t,
        )}
        {offOthers.length > 0 && (
          <span className="ac-optrow__desc">
            {t("connectAi.offSystemSome", {
              count: offOthers.length,
              names: joinNames(
                offOthers.map((c) => planLabel(t, c)),
                t,
              ),
              system: off(offOthers[0] as PlanChoice),
            })}
          </span>
        )}
      </>
    ),
    end: "chevronDown",
    button: { "aria-expanded": false },
    onSelect: () => setOthers(true),
  };
  return (
    <OptionLinks
      className="arrival-opts"
      options={[
        ...FIRST.map(plan),
        ...(others ? OTHERS.map(plan) : [more]),
        ...(mayAddKey
          ? [
              card(
                "key",
                <span className="arrival-opts__tile" aria-hidden="true">
                  <Icon name="key" />
                </span>,
                t("connectAi.key.title"),
                t("connectAi.key.sub"),
              ),
            ]
          : []),
        card(
          FREE,
          <ProviderLogo id={planMark(FREE)} size="tile" off={dims(FREE)} />,
          t("arrival.connect.free"),
          t("arrival.connect.freeText"),
          { tag: t("arrival.connect.noPlan") },
        ),
      ]}
    />
  );
}
