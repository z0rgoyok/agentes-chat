import { useMe } from "@agenteschat/client";
import { membershipIn, settingUp } from "@agenteschat/client/lib/guards";
import { can } from "@agenteschat/client/lib/permissions";
import { createFileRoute, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { requireUserIn } from "@/app/guards";
import { usePageTextSize } from "@/chat/look";
import { useFollowPickedAgent } from "@/components/AppIconPicker";
import { Arrival } from "@/components/arrival/Arrival";
import { FeedbackHost } from "@/components/arrival/FeedbackDialog";
import { ArtifactViewerProvider } from "@/components/artifacts/viewer-context";
import { CommandMenu } from "@/components/CommandMenu";
import { ConfirmEmailBanner } from "@/components/ConfirmEmail";
import { ComputerDialogProvider } from "@/components/computer/provider";
import { ConnectAiProvider } from "@/components/connect-ai-context";
import { DesktopDragStrip } from "@/components/DesktopDragStrip";
import { MenuBarActions } from "@/components/DesktopMenus";
import { DesktopTitleBar } from "@/components/DesktopTitleBar";
import { DetailsHost } from "@/components/DetailsHost";
import { InviteDialogProvider } from "@/components/invite/InviteDialog";
import { LeaveChannelDialog } from "@/components/LeaveChannelDialog";
import { OutageNotices } from "@/components/MachineOutages";
import { NavDrawerProvider, NavScrim, ShellBar } from "@/components/NavDrawer";
import { NoticeIsland } from "@/components/NoticeIsland";
import { PushOpens } from "@/components/NotificationOpen";
import { NotMember } from "@/components/NotMember";
import { NewAgentProvider } from "@/components/new-agent/new-agent-context";
import { OrgProvider } from "@/components/org-context";
import { RemoveMemberProvider } from "@/components/RemoveMember";
import { Sidebar } from "@/components/Sidebar";
import { BootSplash } from "@/components/Sky";
import { DeletingBanner, HoldBanner, SuspendedScreen } from "@/components/Standing";
import { useWebPushClear, useWebPushRefresh } from "@/components/WebPush";
import { ComputerSetupNotice } from "@/components/WorkspaceComputer";
import { HeaderSearchProvider } from "@/hooks/useWorkspaceSearch";
import { useServerLocale } from "@/i18n";
import { inDesktopApp } from "@/lib/desktop";
import { preloadDialogs } from "@/lib/lazy-dialog";
import { prefetchShell } from "@/lib/prefetch";
import { notePlace } from "@/lib/return-to";
import { rememberPlace, showWorkspace } from "@/lib/start";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useWorkspaceAccent } from "@/lib/theme";
import { RealtimeProvider } from "@/realtime/context";

/** A live file's own page (`org.$orgId.drive_.$fileId`): `/org/<org>/drive/<file>`. */
const LIVE_FILE_PATH = /\/drive\/[^/]+\/?$/;
/** That page presenting (`?present`): the slide takes the window, the sidebar steps aside (ADR 0196 §9). */
const PRESENTING = /[?&]present=(true|1)(&|$)/;

/** The workspace shell of an organization: sidebar + page, and its WebSocket. */
export const Route = createFileRoute("/org/$orgId")({
  beforeLoad: async ({ context, location, params }) => {
    const me = await requireUserIn(context, location.href, params.orgId);
    const membership = membershipIn(me, params.orgId);
    // Back from its plan (`org.$orgId.onboarding.tsx`, ADR 0079) goes on to the onboarding with what it brings back.
    if (membership && settingUp(membership) && location.pathname !== `/org/${params.orgId}/onboarding`)
      throw redirect({ to: "/onboarding" });
    return { me, membership };
  },
  // The shell's lists start with the page's own reads (`prefetchShell`), not after its code loads.
  loader: ({ context: { queryClient, api }, params: { orgId } }) => prefetchShell(queryClient, api, orgId),
  component: OrgLayout,
  // Opening the workspace takes a moment (the session check): the sky rises meanwhile.
  pendingComponent: BootSplash,
});

function OrgLayout() {
  const loaded = Route.useRouteContext();
  const { orgId } = Route.useParams();
  // The cached person, so a new logo or workspace name shows at once, not at the next navigation.
  const me = useMe().data ?? loaded.me;
  const membership = membershipIn(me, orgId);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const href = useRouterState({ select: (s) => s.location.href });
  // "Criar agente" is a focused flow with its own rail: no sidebar while it's open (admins only; others see why not).
  // A live file's page is a page of the app with the sidebar (ADR 0199), but presenting takes the whole window.
  const focused =
    (/\/agents\/new\/?$/.test(path) && can(membership, "create_agents")) ||
    (LIVE_FILE_PATH.test(path) && PRESENTING.test(href));
  // Notifications in this browser (ADR 0071), when already on: the server hears of them again, quietly.
  useWebPushRefresh(me.user.id);
  useServerLocale(me.user);
  // …and the ones it still shows for what was already read elsewhere close.
  useWebPushClear();
  usePageTextSize(membership?.chatPrefs);
  useWorkspaceAccent(membership?.accent);
  // An agent picked as the app icon follows its name and look in its workspace (ADR 0179).
  useFollowPickedAgent(orgId);
  // The dialogs the shell and its pages open (Connect AI, a new agent, a file, a computer, details) left the first
  // load: their code comes in the background once this page is up, so opening one doesn't wait for it either.
  useEffect(() => preloadDialogs(), []);
  useEffect(() => {
    if (!membership) return;
    storage.set(STORAGE_KEYS.lastOrg, membership.id);
    // Where "Onde você parou" opens, and the workspace on screen: its bare address now means Início (ADR 0108).
    showWorkspace(membership.id);
    rememberPlace(membership.id, path);
  }, [membership, path]);
  // Where "Criar agente" and the other flows go back to when left.
  useEffect(() => notePlace(href), [href]);
  // A workspace shown as being deleted that leaves `GET /me` was deleted for good: on to the person's start.
  const closing = useRef<string | null>(null);
  if (membership) closing.current = membership.deletion ? orgId : null;
  const gone = !membership && closing.current === orgId;
  // A workspace on screen that leaves `GET /me` otherwise: they were taken out of it (`membership_revoked`).
  const shown = useRef<{ id: string; name: string } | null>(null);
  if (membership) shown.current = { id: orgId, name: membership.name };
  const removedFrom = !membership && shown.current?.id === orgId ? shown.current.name : null;
  const navigate = useNavigate();
  useEffect(() => {
    if (gone) void navigate({ to: "/", replace: true });
  }, [gone, navigate]);
  // A workspace its owner reset (`org.reset` reads `GET /me` again) is theirs to set up again, as opening it would be.
  const restart = Boolean(membership && settingUp(membership)) && path !== `/org/${orgId}/onboarding`;
  useEffect(() => {
    if (restart) void navigate({ to: "/onboarding", replace: true });
  }, [restart, navigate]);
  // Outside the shell the app's window has no title bar: the page's top drags it.
  const strip = inDesktopApp() && <DesktopDragStrip />;

  if (gone) return strip || null;
  if (!membership) return <NotMember me={me} orgId={orgId} removedFrom={removedFrom} strip={strip} />;

  // Suspended: its own screen, the socket still open so lifting it brings the workspace back at once.
  if (membership.standing?.state === "suspended") {
    return (
      <OrgProvider org={membership} me={me}>
        <RealtimeProvider orgId={membership.id}>
          {strip}
          <SuspendedScreen org={membership} me={me} />
        </RealtimeProvider>
      </OrgProvider>
    );
  }

  return (
    <OrgProvider org={membership} me={me}>
      <RealtimeProvider orgId={membership.id}>
        <HeaderSearchProvider>
          <ArtifactViewerProvider>
            <NavDrawerProvider>
              {inDesktopApp() && <DesktopTitleBar />}
              {inDesktopApp() && <MenuBarActions orgId={membership.id} />}
              {/* One invite dialog for the workspace (ADR 0090): the menu, ⌘K, Members and a channel open it. */}
              <InviteDialogProvider>
                <RemoveMemberProvider>
                  {/* Connect AI for every page, and over the new agent's dialog (ADR 0164), which sits under it. */}
                  <ConnectAiProvider>
                    {/* One new agent's dialog for every way in (ADR 0164): the sidebar, the pages and the menus. */}
                    <NewAgentProvider>
                      <div className="shell">
                        <CommandMenu />
                        <LeaveChannelDialog />
                        {!focused && (
                          <>
                            <NavScrim />
                            <Sidebar />
                            <ShellBar />
                          </>
                        )}
                        {/* The work area: notices on top (agents paused, the workspace's computer on its way, a computer
                    the agents run on went offline), then the page. Being deleted, it reads as ever under one line that
                    says so (ADR 0088 §7), in the Criar agente flow too: its work stopped, nothing else is news. */}
                        <div className={focused ? "shell__work shell__work--bare" : "shell__work"}>
                          {membership.deletion && <DeletingBanner />}
                          {!focused && !membership.deletion && (
                            <>
                              <ConfirmEmailBanner />
                              <HoldBanner />
                              <ComputerSetupNotice />
                              <OutageNotices />
                            </>
                          )}
                          <div className="shell__pages">
                            <ComputerDialogProvider>
                              <DetailsHost>
                                <PushOpens />
                                {/* What reaches me while I'm here, at the top of the work area (ADR 0071 §9). */}
                                {!focused && <NoticeIsland />}
                                <Arrival />
                                <FeedbackHost />
                                <Outlet />
                              </DetailsHost>
                            </ComputerDialogProvider>
                          </div>
                        </div>
                      </div>
                    </NewAgentProvider>
                  </ConnectAiProvider>
                </RemoveMemberProvider>
              </InviteDialogProvider>
            </NavDrawerProvider>
          </ArtifactViewerProvider>
        </HeaderSearchProvider>
      </RealtimeProvider>
    </OrgProvider>
  );
}
