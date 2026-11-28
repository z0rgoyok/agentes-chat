import { useApi, useMe } from "@agenteschat/client";
import { createRootRouteWithContext, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import type { RouterContext } from "@/app/router-context";
import { DesktopDragStrip } from "@/components/DesktopDragStrip";
import { ContextMenuHost } from "@/components/DesktopMenus";
import { ErrorScreen, NotFoundScreen } from "@/components/ErrorScreen";
import { AccountDeletingScreen } from "@/components/Standing";
import { useBackCloses } from "@/hooks/useBackCloses";
import { switchAccount } from "@/lib/accounts";
import { askForPhone, asksForPhone, inDesktopApp, routeNewWindowLinks } from "@/lib/desktop";
import { dispatchPushOpen } from "@/lib/push-open";
import { firstScreenPainted } from "@/lib/vitals";
import { listenForPushOpens } from "@/lib/web-push";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFoundScreen,
  errorComponent: ErrorScreen,
});

function Root() {
  // agentes for Mac: the workspace has its title bar (org.$orgId.tsx); every other page drags from the top.
  const inWorkspace = useRouterState({ select: (s) => s.location.pathname.startsWith("/org/") });
  const router = useRouter();
  const me = useMe().data;
  const deletion = me?.user.deletion;
  const api = useApi();
  const myId = me?.user.id ?? null;
  useBackCloses();
  // Once this first screen is on the glass: the opening's time, and in the app, the cover over the window goes.
  useEffect(firstScreenPainted, []);
  // In the app: a link to another site opens in the browser, one to this server in the window (main_window.rs).
  useEffect(() => (inDesktopApp() ? routeNewWindowLinks() : undefined), []);
  // The app opens a page of the site that is already open (the tray, a notification, ⌘-click) without
  // loading it again: the route moves (main_window.rs). Downloads and the API go as a plain load.
  useEffect(() => {
    if (!inDesktopApp()) return;
    const w = window as { __agentesNavigate?: (path: string) => void };
    w.__agentesNavigate = (path) => {
      if (!path.startsWith("/") || path.startsWith("//")) return;
      // "Show QR code" in the app: the dialog over the page the person is on.
      if (asksForPhone(new URL(path, window.location.origin).search)) askForPhone();
      else if (path.startsWith("/api/")) window.location.assign(path);
      else router.history.push(path);
    };
    return () => {
      delete w.__agentesNavigate;
    };
  }, [router]);
  // A click on a browser notification while the app is open in a tab (ADR 0071): the open workspace opens it
  // where its inbox would (`PushOpens`); on any other page the tab moves to its address.
  // One for another account signed in on this browser (ADR 0183): the browser moves to it, then opens it.
  useEffect(
    () =>
      listenForPushOpens((click) => {
        const theirs = click.data?.user;
        if (theirs && myId && theirs !== myId) return void switchAccount(api, theirs, click.path).catch(() => {});
        dispatchPushOpen(click, (path) => router.history.push(path));
      }),
    [router, api, myId],
  );
  return (
    <>
      {inDesktopApp() && !inWorkspace && <DesktopDragStrip />}
      <ContextMenuHost />
      {deletion ? <AccountDeletingScreen dueAt={deletion.dueAt} /> : <Outlet />}
    </>
  );
}
