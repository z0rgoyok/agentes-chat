import type { PlanUsage } from "@agenteschat/client";
import { planWord as planStateWord } from "@agenteschat/client/lib/plan-usage";
import { planState } from "@agenteschat/ui";
import type { TFunction } from "i18next";

// The words of the usage views live in the client, shared with the phone (ADR 0063).
export {
  accountName,
  accountOwner,
  accountShares,
  brandOf,
  groupUsageAccounts,
  loginsText,
  modelLimitText,
  notSharedText,
  noWindowsText,
  ownPlanLines,
  partedUsage,
  planMeterText,
  servesTerms,
  servesText,
  shareFacts,
  splitUsage,
  usageShown,
  usageSourceName,
  usageSourcePart,
  workspaceUsesApi,
} from "@agenteschat/client/lib/plan-usage";
// At the limit, the owner's other accounts that could think instead: shared with the phone.
export { limitOffers } from "@agenteschat/ui";

/** The plan's state in a few words, for a line that has no room for the meter; null when it is fine. */
export const planWord = (t: TFunction, locale: string, usage: PlanUsage | null | undefined, now = new Date()) =>
  planStateWord(t, locale, usage ? planState(usage, now.getTime()) : null, now);

/**
 * Of the viewer's plans, the one to warn about: at its limit first, then the fullest from `PLAN_ALMOST` (80%). Null
 * while every plan is under it.
 */
export function planNearLimit<P extends { usage: PlanUsage }>(plans: readonly P[], now = new Date()): P | null {
  const near = plans
    .map((plan) => ({ plan, ...planState(plan.usage, now.getTime()) }))
    .filter((p) => p.state !== "ok")
    .sort((a, b) => Number(b.state === "limited") - Number(a.state === "limited") || b.used - a.used);
  return near[0]?.plan ?? null;
}
