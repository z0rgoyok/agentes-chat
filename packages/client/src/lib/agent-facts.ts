import type { TFunction } from "i18next";
import type { Agent, AgentDetail } from "../api/types";
import { answersOthers, audienceOf, seesDetails } from "./audience";
import { formatMonth, formatPercent, formatShortDate, formatTokensShort, relativeTime } from "./format";
import { agentGrammar } from "./grammar";

/**
 * A teammate's private agent I see by its facts alone (the server's `factsOnly`, through "Editar agentes"): listed on
 * Equipe with a lock, its page its facts and this month's usage, never how it works, nothing to change.
 */
export const seesFactsOnly = (agent: { factsOnly?: boolean } | undefined) => agent?.factsOnly === true;

/**
 * A private agent whose page doesn't open for me: neither its details nor its facts. The server answers its link with
 * a 404; its messages in shared channels still say who wrote them.
 */
export const hidesAgentPage = (agent: Agent | undefined) =>
  !!agent && !seesDetails(agent) && !seesFactsOnly(agent) && !answersOthers(audienceOf(agent), agent.ownerUserId);

export interface AgentFact {
  key: "thinks" | "runs" | "tokens" | "budget" | "last";
  label: string;
  value: string;
}

/** This month's usage on a facts page, web and phone alike: what thinks for it, runs, tokens, budget as a % (never money), last activity. */
export function agentUsageFacts(
  t: TFunction,
  locale: string,
  d: Pick<AgentDetail, "runsThisMonth" | "tokensThisMonth" | "budgetUsedPercent" | "lastActivityAt">,
  thinks: string | null,
  now = new Date(),
): AgentFact[] {
  return [
    ...(thinks ? [{ key: "thinks" as const, label: t("agentSide.thinksWith"), value: thinks }] : []),
    { key: "runs", label: t("agentPage.activity.runs"), value: String(d.runsThisMonth) },
    { key: "tokens", label: t("agentPage.activity.tokens"), value: formatTokensShort(t, locale, d.tokensThisMonth) },
    {
      key: "budget",
      label: t("agentPage.facts.budget"),
      value: t("agentPage.facts.budgetUsed", { percent: formatPercent(locale, d.budgetUsedPercent) }),
    },
    {
      key: "last",
      label: t("agentPage.facts.last"),
      value: d.lastActivityAt ? relativeTime(t, locale, d.lastActivityAt, now) : t("agentPage.facts.never"),
    },
  ];
}

/** "Usage in November": the facts page's usage card title. */
export const usageTitle = (t: TFunction, locale: string, now = new Date()) =>
  t("agentPage.facts.usage", { month: formatMonth(locale, now) });

/** Who made it and when ("João, Nov 13"), or only when when its maker is gone. */
export const createdText = (
  t: TFunction,
  locale: string,
  d: Pick<AgentDetail, "createdAt" | "createdByUserId">,
  nameOf: (id: string) => string | undefined,
) => {
  const date = formatShortDate(locale, d.createdAt);
  const name = d.createdByUserId ? nameOf(d.createdByUserId) : undefined;
  return name ? t("agentPage.facts.createdBy", { name, date }) : date;
};

/**
 * What the locked block says: its workings stay with its owner (by name), whoever they ask to edit it and the admins;
 * with no one person answering for it, with whoever edits it and the admins.
 */
export const lockedText = (t: TFunction, agent: Pick<Agent, "name">, ownerName: string | undefined) =>
  ownerName
    ? t("agentPage.facts.locked", { ...agentGrammar(agent.name), owner: ownerName })
    : t("agentPage.facts.lockedNoOwner", agentGrammar(agent.name));
