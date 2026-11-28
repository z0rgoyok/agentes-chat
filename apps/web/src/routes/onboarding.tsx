import { meQuery, useMe } from "@agenteschat/client";
import { type PaidReturn, paidSearch } from "@agenteschat/client/lib/billing";
import { joinInstead, settingUp } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireUser } from "@/app/guards";
import { ConfirmEmailScreen } from "@/components/ConfirmEmail";
import { useServerLocale } from "@/i18n";
import { ARRIVAL_PARAM } from "@/lib/arrival";
import { OnboardingPage } from "@/pages/OnboardingPage";

export const Route = createFileRoute("/onboarding")({
  // `?resume=<orgId>`: back from that workspace's plan (`/org/$orgId/onboarding`, ADR 0079), `paid` after paying, with
  // what was bought; `?delete=1`: its dialog that deletes the workspace.
  validateSearch: (search: Record<string, unknown>): { resume?: string; paid?: true; delete?: 1 } & PaidReturn => ({
    ...(typeof search.resume === "string" ? { resume: search.resume } : {}),
    ...paidSearch(search),
    ...(search.delete === undefined ? {} : { delete: 1 as const }),
  }),
  // An invitation waiting for someone with no workspace set up opens instead of making one; back from billing or
  // deleting the one they started, the onboarding stays.
  beforeLoad: async ({ context, location, search }) => {
    const me = await requireUser(context, location.href);
    const invitation = joinInstead(me);
    if (invitation && !search.resume && !search.delete && !search.paid) {
      throw redirect({ to: "/invite/$token", params: { token: invitation } });
    }
  },
  loaderDeps: ({ search }) => ({ resume: search.resume, paid: paidSearch(search) }),
  // Back from the billing page, paid or not, the onboarding resumes where its data is: paid, on its plan step, the
  // payment said as received until the hold lifts, then on connecting an AI (ADR 0162, amended 2026-11-10). A
  // workspace set up meanwhile (another tab) opens as it is, on its arrival when it was paid for.
  loader: async ({ context, deps: { resume, paid } }) => {
    if (!resume) return;
    const me = await context.queryClient.fetchQuery({ ...meQuery(context.api), staleTime: 0 }).catch(() => null);
    const org = me?.organizations.find((o) => o.id === resume);
    if (!org || settingUp(org)) return;
    if (paid.paid)
      throw redirect({
        to: "/org/$orgId",
        params: { orgId: resume },
        search: { ...paid, [ARRIVAL_PARAM]: 1 } as never,
      });
    throw redirect({ to: "/org/$orgId", params: { orgId: resume } });
  },
  component: function Onboarding() {
    const user = useMe().data?.user;
    useServerLocale(user);
    // A new account makes its first workspace once its address is confirmed (ADR 0006, addendum 2026-11-22).
    if (user?.emailConfirmation === "required") return <ConfirmEmailScreen email={user.email} />;
    return <OnboardingPage />;
  },
});
