import { meQuery } from "@agenteschat/client";
import { landingFor } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { showWorkspace } from "@/lib/start";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/**
 * Entry point: signed in, the last organization (opened anew: where the person chose, ADR 0108), an invitation
 * waiting for them, or onboarding;
 * signed out, sign-in (the landing page is its own site, `LANDING_URL`). `?open=jev` (the desktop app's Jev row) goes
 * on to Settings › AI accounts, where the server's owner finds Jev's key, after signing in if need be. `?open=password`
 * (the desktop app's "Add a password") opens the add-a-password dialog in the workspace (`?account=password`).
 * `?open=devices` (the desktop app's expired pair link) goes on to Settings › Devices, where a new link is made.
 */
export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { open?: "jev" | "password" | "devices" } =>
    search.open === "jev" || search.open === "password" || search.open === "devices" ? { open: search.open } : {},
  beforeLoad: async ({ context, search, preload }) => {
    const me = await context.queryClient.ensureQueryData(meQuery(context.api));
    if (!me)
      throw redirect({ to: "/login", ...(search.open ? { search: { redirect: `/?open=${search.open}` } } : {}) });
    const landing = landingFor(me, storage.get(STORAGE_KEYS.lastOrg));
    if ("to" in landing) throw redirect({ to: landing.to });
    if ("invitation" in landing) throw redirect({ to: "/invite/$token", params: { token: landing.invitation } });
    if (search.open === "jev") {
      throw redirect({
        to: "/org/$orgId/settings/$section",
        params: { orgId: landing.orgId, section: "usage" },
        hash: "jev",
      });
    }
    if (search.open === "devices") {
      throw redirect({
        to: "/org/$orgId/settings/$section",
        params: { orgId: landing.orgId, section: "devices" },
      });
    }
    if (search.open === "password") {
      throw redirect({ to: "/org/$orgId", params: { orgId: landing.orgId }, search: { account: "password" } as never });
    }
    if (!preload) showWorkspace(null);
    throw redirect({ to: "/org/$orgId", params: { orgId: landing.orgId } });
  },
});
