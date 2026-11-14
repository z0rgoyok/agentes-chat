import { authConfigQuery, invitationQuery, meQuery } from "@agenteschat/client";
import { safeRedirect, signInFor } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { fallBackToAccount } from "@/lib/accounts";
import { AuthPage } from "@/pages/AuthPage";

export const Route = createFileRoute("/login")({
  // `error`: a provider sign-in the server refused comes back here with its code. `add`: another account beside the
  // one signed in ("Add account", ADR 0183), so the page shows with someone signed in.
  validateSearch: (
    search: Record<string, unknown>,
  ): { redirect?: string; email?: string; error?: string; add?: boolean } => ({
    redirect: safeRedirect(search.redirect),
    email: typeof search.email === "string" ? search.email : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
    ...(search.add === true || search.add === "1" || search.add === 1 ? { add: true } : {}),
  }),
  beforeLoad: async ({ context, search }) => {
    const goal = signInFor(search.redirect);
    const [me, config] = await Promise.all([
      context.queryClient.ensureQueryData(meQuery(context.api)),
      context.queryClient.ensureQueryData(authConfigQuery(context.api)),
      // The page names the invitation's workspace from the first frame (`AuthPage`).
      goal && "invite" in goal ? context.queryClient.prefetchQuery(invitationQuery(context.api, goal.invite)) : null,
    ]);
    // An OAuth callback that waited for a sign-in (under /api/) is the server's: a full load.
    if (me && !search.add) {
      throw redirect({ href: search.redirect ?? "/", reloadDocument: search.redirect?.startsWith("/api/") });
    }
    // Signed out, with another of the browser's accounts still in (ADR 0183): the app opens as that one. The page
    // is loading again by then, so this one waits.
    if (!me && !search.add && !config.firstRun && (await fallBackToAccount(context.api, search.redirect ?? "/"))) {
      await new Promise(() => {});
    }
    // A brand-new instance has nobody to sign in: go straight to the first account.
    if (config.firstRun) throw redirect({ to: "/signup", search: { redirect: search.redirect } });
  },
  component: function Login() {
    const search = Route.useSearch();
    return (
      <AuthPage
        start="in"
        redirect={search.redirect}
        email={search.email}
        refused={search.error}
        adding={search.add === true}
      />
    );
  },
});
