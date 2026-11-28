import { useAuthConfig } from "@agenteschat/client";
import { planOfferOf } from "@agenteschat/client/lib/billing";
import { useQuery } from "@tanstack/react-query";

/** How long the plan list may take: past it the onboarding names no plan rather than wait. */
const PLANS_WAIT_MS = 4000;

/**
 * The plan the onboarding offers (or the one `key` names, a paid return's), read by the browser from the billing service's public plan list in the person's
 * language: this server never names a plan nor a price (ADR 0079 §6). `offer` is null without a billing service, and
 * when the list can't be read in time: the onboarding then names no plan. `loading` while the list is on its way.
 * `alone`: a personal workspace, offered the plan for one person.
 */
export function usePlanOffer(
  locale: string,
  { key, alone = false, enabled = true }: { key?: string; alone?: boolean; enabled?: boolean } = {},
) {
  const billingUrl = useAuthConfig().data?.billingUrl ?? null;
  const plans = useQuery({
    queryKey: ["planOffer", billingUrl, locale],
    queryFn: async () => {
      const res = await fetch(`${billingUrl?.replace(/\/+$/, "")}/plans.json?locale=${encodeURIComponent(locale)}`, {
        signal: AbortSignal.timeout(PLANS_WAIT_MS),
      });
      return res.ok ? ((await res.json()) as unknown) : null;
    },
    select: (json: unknown) => planOfferOf(json, key, alone),
    enabled: billingUrl !== null && enabled,
    retry: 0,
    staleTime: 10 * 60_000,
  });
  // Not asked for: no plan, even from the list another caller already read.
  return { offer: enabled ? (plans.data ?? null) : null, loading: plans.isLoading };
}
