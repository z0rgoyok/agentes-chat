import { RECENT_PREFETCH, usePrefetchRecent, useSendWaiting } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Sheet } from "@lodev09/react-native-true-sheet/navigation/expo-router";
import type { ErrorBoundaryProps } from "expo-router";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { NoticeIsland } from "@/features/island/NoticeIsland";
import { noteWorkspaceOnScreen } from "@/features/links/on-screen";
import { LiveActivityWork } from "@/features/live-activity/LiveActivityWork";
import { ShareInbox } from "@/features/share/ShareInbox";
import { useConnection, useRememberAgentLooks } from "@/features/shared/hooks";
import { useAppIconBadge } from "@/features/shared/queries";
import { ScreenError } from "@/features/shared/ScreenError";
import { useUserEvents } from "@/features/shared/userEvents";
import { useVaultEvents } from "@/features/vault/live";
import { useVoiceOutbox } from "@/features/voice/useVoiceOutbox";
import { useSounds } from "@/lib/sounds";
import { useOrg, useOrgGate } from "@/providers/org";
import { useRouteSheetOptions, useTheme, useToast } from "@/ui";

/** A link straight to a sheet still has the app's screens under it (closing it leaves them in sight). */
export const unstable_settings = { anchor: "(main)" };

/** A screen that breaks while drawing shows what happened and a way back, instead of closing the app. */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ScreenError {...props} />;
}

/**
 * The signed-in app: its screens (`(main)`: the native tabs and the screens pushed over them), and the sheets that
 * present over whatever is on screen: requests, "New" (the "+" of the tabs) and the forms it opens, a message's code
 * or chart opened whole. Every sheet is the system's own through TrueSheet, as the sheets the screens open themselves
 * (`Sheet`): routes here, so a link or a notification opens one.
 */
export default function AppLayout() {
  const { colors } = useTheme();
  const org = useOrgGate();
  // Signed in, the organization not known yet (the splash or `Entering` covers this) or none (the first run's steps, pushed over this, cover it):
  // the screens need one, so they mount once it's chosen, at the URL the app opened with.
  if (!org.state) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return (
    <>
      <AppSheets />
      <AppWork />
      {/* The agents at work in the iPhone's Dynamic Island and on its Lock Screen (ADR 0210). */}
      <LiveActivityWork />
      {/* What reaches me while the app is open, out of the camera's island (ADR 0071 §9). */}
      <NoticeIsland />
      {/* What other apps share through the system's share sheet opens "Compartilhar com…". */}
      <ShareInbox />
    </>
  );
}

/**
 * What the signed-in app keeps doing whatever screen is open, in a leaf that draws nothing: the lists and events it
 * follows change all the time, and each change redraws this leaf alone, never the sheets' navigator over every screen.
 */
function AppWork() {
  useUserEvents();
  // The Vault's screens follow changes made anywhere (ADR 0144).
  useVaultEvents();
  useVoiceOutbox();
  useAppIconBadge();
  // The app's sounds (ADR 0070): the player and its audio session.
  useSounds();
  useRememberAgentLooks();
  const { orgId } = useOrg();
  // A web link to this workspace opens its screen straight away (`app/+native-intent.tsx`).
  useEffect(() => {
    noteWorkspaceOnScreen(orgId);
    return () => noteWorkspaceOnScreen(null);
  }, [orgId]);
  // The unread and latest conversations load while the app is idle, each with what its rows wait for before it shows
  // (`prefetchConversation`: the threads' links, the agents' questions): opening one is instant.
  usePrefetchRecent(orgId, RECENT_PREFETCH, { whole: true });
  // What I sent while the connection was down goes out once it's back, whatever screen is open.
  const { t, i18n } = useTranslation();
  const toast = useToast();
  useSendWaiting(orgId, useConnection(), (error) => toast({ title: errorText(t, error, i18n.language), icon: "x" }));
  return null;
}

function AppSheets() {
  // The heights the sheets come up at, as fractions of the screen; each can be dragged to the full height. Made once
  // per look: the navigator is handed the same options until the theme or the language changes.
  const sheet = useRouteSheetOptions();
  const o = useMemo(
    () => ({
      auto: sheet(["auto"]),
      full: sheet([1]),
      newMessage: sheet([0.66, 1]),
      shareTo: sheet([0.72, 1]),
      switchComputer: sheet([0.8, 1]),
      computerSetup: sheet([0.7, 1]),
      workspaces: sheet([0.76, 1]),
      wikiNew: sheet([0.55, 1]),
      newChannel: sheet([0.45, 1]),
      fileShare: sheet([0.7, 1]),
    }),
    [sheet],
  );
  const { auto, full } = o;
  return (
    <Sheet screenOptions={auto}>
      <Sheet.Screen name="(main)" />
      {/* Two agents' conversation, read only, over the one it was asked from (the web's dialog). */}
      <Sheet.Screen name="consultation/[id]" options={full} />
      {/* "New" over the tabs as the system's new message: two thirds at rest, the whole screen once typing. */}
      <Sheet.Screen name="new" options={o.newMessage} />
      <Sheet.Screen name="share-to" options={o.shareTo} />
      <Sheet.Screen name="switch-computer/[machineId]" options={o.switchComputer} />
      <Sheet.Screen name="computer-setup" options={o.computerSetup} />
      {/* The workspaces as a sheet, from a long press on the workspace's mark in the bar (ADR 0154). */}
      <Sheet.Screen name="workspaces-sheet" options={o.workspaces} />
      {/* Another workspace (ADR 0154): a short sheet fitted to its rows. */}
      <Sheet.Screen name="me/add-workspace" options={auto} />
      <Sheet.Screen name="push-ask" options={auto} />
      <Sheet.Screen name="wiki-new" options={o.wikiNew} />
      <Sheet.Screen name="new-channel" options={o.newChannel} />
      <Sheet.Screen name="new-chat" options={full} />
      <Sheet.Screen name="file-share" options={o.fileShare} />
      <Sheet.Screen name="code" options={full} />
      <Sheet.Screen name="chart" options={full} />
    </Sheet>
  );
}
