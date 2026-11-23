import { LiveQueryClient } from "@agenteschat/client/lib/live-query-client";
import { focusManager, onlineManager } from "@tanstack/react-query";
import * as Network from "expo-network";
import { AppState, type AppStateStatus } from "react-native";

/**
 * One query client for the app; refetches when the app comes back to the foreground, and when the phone is back on a
 * network (`bindOnlineToNetwork`). Requests still go out with no network ("always"), as they did before the phone's
 * network was known: a screen says it couldn't load, a change says it failed, rather than waiting unseen.
 */
export function createQueryClient() {
  bindOnlineToNetwork();
  return new LiveQueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true, networkMode: "always" },
      mutations: { retry: 0, networkMode: "always" },
    },
  });
}

/** React Query's "window focus" is the app being active. Returns the unsubscribe. */
export function bindFocusToAppState(): () => void {
  const onChange = (s: AppStateStatus) => focusManager.setFocused(s === "active");
  const sub = AppState.addEventListener("change", onChange);
  return () => sub.remove();
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
