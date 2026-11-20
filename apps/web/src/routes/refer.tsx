import { createFileRoute, notFound } from "@tanstack/react-router";
import { requireUser } from "@/app/guards";
import { BootSplash } from "@/components/Sky";
import { navigateAway } from "@/lib/navigate";

/**
 * `/refer` (ADR 0192): the address other sites link to. A signed-in person, with or without a workspace, leaves for
 * the referral service at once; signed out, they sign in first and come back here. No referral service, or a link
 * that can't be made: the page that doesn't exist, with its way back.
 */
export const Route = createFileRoute("/refer")({
  beforeLoad: ({ context, location }) => requireUser(context, location.href),
  loader: async ({ context }) => {
    const link = await context.api.account.referralsLink("/").catch(() => null);
    if (!link) throw notFound();
    // Out of the history: Back from the referral service would land here and mint a link again.
    navigateAway(link.url, { replace: true });
    // The splash stays while the browser leaves.
    await new Promise(() => {});
  },
  pendingComponent: BootSplash,
  pendingMs: 0,
});
