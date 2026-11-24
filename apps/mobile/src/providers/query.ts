import { busyRetryDelay, retryBusy } from "@agenteschat/client/lib/busy-retry";
import { LiveQueryClient } from "@agenteschat/client/lib/live-query-client";
import { focusManager, onlineManager, type QueryClient } from "@tanstack/react-query";
import * as Network from "expo-network";
import { followAppActive, INACTIVE_GRACE_MS } from "@/lib/useAppActive";

/**
 * One query client for the app; reads again when the phone is back on a network (`bindOnlineToNetwork`). As on the
 * web, coming back to the app reads nothing by itself: the workspace's socket started again catches up
 * (`catchUpQueries`), and only the queries that ask for it (`refetchOnWindowFocus`) read on their own. Requests still
 * go out with no network ("always"), as they did before the phone's network was known: a screen says it couldn't
 * load, a change says it failed, rather than waiting unseen.
 */
export function createQueryClient() {
  bindOnlineToNetwork();
  return new LiveQueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: retryBusy((count) => count < 1),
        retryDelay: busyRetryDelay,
        refetchOnWindowFocus: false,
        networkMode: "always",
      },
      mutations: { retry: 0, networkMode: "always" },
    },
  });
}

/**
 * What the socket's catch-up reads again (`RealtimeConnection.onCatchUp`): after a long gap everything (what is shown
 * now, the rest when it shows), after a brief one what is shown. A read already on its way, a query's own on the
 * app's return, is joined rather than asked for again.
 */
export function catchUpQueries(queryClient: QueryClient, full: boolean) {
  const options = { cancelRefetch: false };
  return full
    ? queryClient.invalidateQueries(undefined, options)
    : queryClient.refetchQueries({ type: "active" }, options);
}

/**
 * React Query's "window focus" is the app in front: polls pause in the background, not for a glance away
 * (`INACTIVE_GRACE_MS`). Returns the unsubscribe.
 */
export function bindFocusToAppState(): () => void {
  return followAppActive((active) => focusManager.setFocused(active), INACTIVE_GRACE_MS);
}

/**
 * React Query's "online" is the phone being on a network, so what went stale or failed while it had none is read
 * again as soon as it has one. Any network counts (a team's server on the office Wi-Fi answers with no internet), and
 * a state the system can't tell counts as online. The manager keeps this and sets it up again whenever a client
 * starts listening.
 */
export function bindOnlineToNetwork() {
  onlineManager.setEventListener((setOnline) => {
    const sub = Network.addNetworkStateListener((state) => setOnline(state.isConnected !== false));
    // The listener hears changes only: where the phone stands now, once.
    void Network.getNetworkStateAsync().then(
      (state) => setOnline(state.isConnected !== false),
      () => undefined,
    );
    return () => sub.remove();
  });
}
