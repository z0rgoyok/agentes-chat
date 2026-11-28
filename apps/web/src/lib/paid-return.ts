import type { OrgStanding } from "@agenteschat/client";
import { isPaidReturn, type PaidReturn, paidReturnOf, standingActive } from "@agenteschat/client/lib/billing";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS, sessionStore, storage } from "@/lib/storage";

/**
 * Back from a paid Checkout (`isPaidReturn`), until the hold lifts. Read from the address itself, since only some
 * routes keep `paid` in their search, and kept for the tab, since the first move to another page drops it.
 */
export function usePaidReturn(orgId: string, held: boolean) {
  const key = `${STORAGE_KEYS.paidReturn}.${orgId}`;
  const search = useSearch({ strict: false });
  const inAddress =
    isPaidReturn(search) || isPaidReturn(Object.fromEntries(new URLSearchParams(window.location.search)));
  useEffect(() => {
    if (!held) sessionStore.remove(key);
    else if (inAddress) sessionStore.set(key, "1");
  }, [held, inAddress, key]);
  return held && (inAddress || sessionStore.get(key) === "1");
}

/**
 * A moment shown keeps the same payment from showing it again for this long: the billing service's return opened
 * twice (a second tab, or Back through Checkout to it). A reload or Back inside the app finds no return at all, since
 * the address drops it as the moment shows. Past it, a paid return is a new payment.
 */
export const PAID_MOMENT_ONCE_MS = 30 * 60_000;

const readPending = (key: string): PaidReturn | null => {
  const raw = sessionStore.get(key);
  if (raw === null) return null;
  try {
    return paidReturnOf({ ...(JSON.parse(raw) as Record<string, unknown>), paid: 1 });
  } catch {
    return null;
  }
};

/** The address without a paid return's marks. */
const withoutPaid = ({ paid: _p, plan: _k, period: _d, ...rest }: Record<string, unknown>) => rest;

/**
 * How the moment comes: in full (`dialog`) on the page the return landed on, or as a card in the corner when the plan
 * turned on after the person went elsewhere, or while a dialog of their own was open (never two at once).
 */
export type PaidForm = "dialog" | "card";

/**
 * The moment right after a paid Checkout (ADR 0079): what the address said was bought, once the plan is in force.
 * The return is kept for the tab until then (the hold lifts on the billing service's next pass), and shown once per
 * payment: once its card, dialog or onboarding page is on screen (`onScreen`), the return is used up and this browser
 * notes when, so a reload, Back or the same return again shows nothing. Until then the tab keeps it: a page left before
 * the moment painted (another page loaded, the tab reloaded) shows it on the next one. The address drops it as soon as
 * the plan is in force. A plain visit has no return to show. `moment` stays until `done`, whatever the address does
 * meanwhile, and only in the workspace it was paid for. `busy`: a dialog the caller doesn't sequence itself is open now.
 */
export function usePaidMoment(orgId: string, standing: OrgStanding | undefined, busy = false) {
  const pendingKey = `${STORAGE_KEYS.paidMoment}.${orgId}`;
  const shownKey = `${STORAGE_KEYS.paidMomentShown}.${orgId}`;
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const navigate = useNavigate();
  const [shown, setShown] = useState<{ orgId: string; moment: PaidReturn; form: PaidForm } | null>(null);
  const seen = Number(storage.get(shownKey) ?? 0) > Date.now() - PAID_MOMENT_ONCE_MS;
  const inAddress = paidReturnOf(search) !== null;
  const pending = paidReturnOf(search) ?? readPending(pendingKey);
  const active = standingActive(standing);
  const mine = shown?.orgId === orgId ? shown : null;
  const due = mine === null && !seen && pending !== null && active;
  // Still where the return landed (the address has it): the moment in full. Decided as it comes, then kept.
  const form: PaidForm = inAddress && !busy ? "dialog" : "card";
  const pendingJson = pending && JSON.stringify(pending);
  useEffect(() => {
    if (pendingJson === null) return;
    // What was bought outlives the moment for the tab: the plan card names it (`usePaidPlan`).
    sessionStore.set(`${STORAGE_KEYS.paidPlan}.${orgId}`, pendingJson);
    if (!active) {
      sessionStore.set(pendingKey, pendingJson);
      return;
    }
    // Shown lately in this browser (another tab): used up. Else kept for the tab until the moment is on screen.
    if (seen) sessionStore.remove(pendingKey);
    else sessionStore.set(pendingKey, pendingJson);
    if (due) setShown({ orgId, moment: JSON.parse(pendingJson) as PaidReturn, form });
    if (inAddress) void navigate({ to: ".", replace: true, search: withoutPaid as never });
  }, [active, due, form, inAddress, navigate, orgId, pendingJson, pendingKey, seen]);
  const done = useCallback(() => setShown(null), []);
  const onScreen = useCallback(() => {
    storage.set(shownKey, String(Date.now()));
    sessionStore.remove(pendingKey);
  }, [pendingKey, shownKey]);
  return { moment: mine?.moment ?? (due ? pending : null), form: mine?.form ?? form, done, onScreen };
}

/**
 * What this tab came back from buying for the workspace, the moment's own source (ADR 0079): the paid return in the
 * address, else the one `usePaidMoment` kept for the tab. Null without one, and while the plan isn't in force. The
 * server never says the plan, so a tab that saw no return knows none.
 */
export function usePaidPlan(orgId: string, standing: OrgStanding | undefined): PaidReturn | null {
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  if (!standingActive(standing)) return null;
  return paidReturnOf(search) ?? readPending(`${STORAGE_KEYS.paidPlan}.${orgId}`);
}
