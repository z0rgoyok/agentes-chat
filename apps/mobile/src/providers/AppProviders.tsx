import { ApiProvider, createSnapshot, outbox } from "@agenteschat/client";
import { textSizeOf } from "@agenteschat/client/lib/chat-look";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo } from "react";
import { I18nextProvider } from "react-i18next";
import { AppState } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { frameClock } from "@/agent/clock";
import { WorkspaceRowData } from "@/features/chat/row-data";
import { PickerHost } from "@/features/shared/PickerSheet";
import { createApi } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { outboxStoreFor } from "@/lib/outbox";
import { startPerfReports } from "@/lib/perf";
import { usePlace } from "@/lib/server";
import { snapshotStoreFor } from "@/lib/snapshot";
import { hintTouches } from "@/ui/hints";
import { ToastHost } from "@/ui/Toast";
import { DuoProvider } from "@/ui/TwoPane";
import { TextScaleProvider } from "@/ui/text-scale";
import { AccentProvider, ThemeProvider } from "@/ui/theme";
import { setupI18n } from "./i18n";
import { OrgProvider, useOrgMaybe } from "./org";
import { PushProvider } from "./push";
import { bindFocusToAppState, createQueryClient } from "./query";
import { RealtimeProvider } from "./realtime";
import { SessionProvider } from "./session";

const i18n = setupI18n();

/**
 * While the app is in use, the conversations snapshot is saved at most this often; as it leaves, whatever changed
 * since is saved then.
 */
const SNAPSHOT_EVERY_MS = 60_000;

/**
 * Everything the screens rely on, outermost first: gestures, the window's size class and fold (`useWide`,
 * `useWindowFold`), safe areas, the keyboard (its height and position on the UI thread, for the chat), theme, i18n,
 * React Query, the API client (`useApi`), the session, the current organization (`useOrg`), realtime (`useRealtime`),
 * push and toasts (`useToast`). Living agents pause while the app is in the background.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  // The place: a server, or one of its accounts (ADR 0183).
  const server = usePlace();
  // Each place gets its own cache, API client and auth client, so no data or session crosses servers or accounts.
  const scope = useMemo(
    () => ({ server, queryClient: createQueryClient(), api: createApi(server), auth: authClient(server) }),
    [server],
  );

  useEffect(() => bindFocusToAppState(), []);
  // How fast the app runs here, for its server: per place, as its reads count in that place's cache.
  useEffect(() => startPerfReports(scope.api, scope.queryClient), [scope]);
  // The last lists and chats saved on this phone show at once; everything revalidates as usual. A save turns every
  // list into one string on the thread that also moves the screens: while the app is in use, at most every
  // `SNAPSHOT_EVERY_MS` at a quiet moment; in full as the app leaves the screen (iOS's app switcher passes through
  // `inactive`, where a swipe kills it with no `background`). Leaving a server clears its cache, and with it the
  // saved snapshot.
  useEffect(() => {
    const { queryClient } = scope;
    const snapshot = createSnapshot(queryClient, snapshotStoreFor(scope.server), { saveAfterMs: SNAPSHOT_EVERY_MS });
    const stop = snapshot.start();
    // What waits for the connection outlives the app being closed, and shows again in its conversation.
    const stopOutbox = outbox.keep(queryClient, outboxStoreFor(scope.server));
    void snapshot.restore().then(() => outbox.show(queryClient));
    // Once per stay away (`inactive` and then `background` save once), and only after the app was in use: a launch
    // that passes through `inactive` saves nothing.
    let saved = AppState.currentState !== "active";
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") saved = false;
      else if (!saved) {
        saved = true;
        void snapshot.flush();
      }
    });
    return () => {
      // Another server (ADR 0154): this one's snapshot and waiting messages stay in its own files. They let go of
      // them before the cache clears, which would otherwise empty both as if the person had signed out.
      stopOutbox();
      stop();
      queryClient.clear();
      sub.remove();
    };
  }, [scope]);
  useEffect(() => {
    frameClock.setPaused(AppState.currentState !== "active");
    const sub = AppState.addEventListener("change", (s) => frameClock.setPaused(s !== "active"));
    return () => sub.remove();
  }, []);

  return (
    // Every touch passes here: a tap away from an open ⓘ hint closes it.
    <GestureHandlerRootView style={{ flex: 1 }} {...hintTouches}>
      {/* The window's size class and fold (`useWide`, `useWindowFold`, ADR 0212): a hidden view filling the root. */}
      <DuoProvider>
        <SafeAreaProvider>
          <KeyboardProvider>
            <ThemeProvider>
              <I18nextProvider i18n={i18n}>
                {/* Keyed by server: a query hook keeps the client it mounted with (TanStack's observer is made once),
                    so without a fresh tree the screens kept the first server's cache across a switch and asked this
                    server for another one's workspace (ADR 0154). */}
                <QueryClientProvider key={scope.server} client={scope.queryClient}>
                  <ApiProvider client={scope.api}>
                    <SessionProvider auth={scope.auth} server={server}>
                      <OrgProvider>
                        {/* What every row reads alike (the directory, who I am), read once for the app. */}
                        <WorkspaceRowData>
                          <AppTextSize>
                            <RealtimeProvider>
                              <PushProvider>
                                <ToastHost>
                                  {children}
                                  {/* Every picker (`pickOne`) and Android's action menus, in the app's sheet, once for the whole app. */}
                                  <PickerHost />
                                </ToastHost>
                              </PushProvider>
                            </RealtimeProvider>
                          </AppTextSize>
                        </WorkspaceRowData>
                      </OrgProvider>
                    </SessionProvider>
                  </ApiProvider>
                </QueryClientProvider>
              </I18nextProvider>
            </ThemeProvider>
          </KeyboardProvider>
        </SafeAreaProvider>
      </DuoProvider>
    </GestureHandlerRootView>
  );
}

/**
 * The person's text size (Você › Conversa) for every screen, read from the workspace they are in; the default before
 * one is chosen (sign-in, the first run).
 */
function AppTextSize({ children }: { children: ReactNode }) {
  const org = useOrgMaybe()?.org;
  return (
    <AccentProvider accent={org?.accent}>
      <TextScaleProvider size={textSizeOf(org?.chatPrefs)}>{children}</TextScaleProvider>
    </AccentProvider>
  );
}
