import type { ApiClient } from "@agenteschat/client";
import { newClientId } from "@agenteschat/client";
import { addPushToStartTokenListener, widgetsDirectory } from "expo-widgets";
import { useEffect } from "react";
import { AppState } from "react-native";
import type { AgentLookInput } from "@/agent/looks";
import { iosPushTarget } from "@/lib/push";
import { readValueSync, STORED, writeValue } from "@/lib/storage";
import AgentsActivity from "./AgentsActivity";
import { writeFaces } from "./faces";
import { useLiveActivityOn } from "./switch";

/**
 * The agents' Live Activity on this iPhone (ADR 0210): the server makes and sends what it shows; the app tells it where
 * to send (this install's push-to-start token, each running activity's id and token, the widgets directory its faces
 * are read from) and draws those faces, while its switch (Você › Notificações) is on. iOS only: Android's build takes
 * `useLiveActivity.ts`, which does nothing (expo-widgets' Live Activities are iOS's).
 */

/** How often, while the app is open, it looks for an activity the server started (its token reaches only the app). */
export const SYNC_MS = 15_000;

/** This install's id for the registration, made once. */
function installId(): string {
  let id = readValueSync(STORED.liveActivityInstall);
  if (!id) {
    id = newClientId();
    void writeValue(STORED.liveActivityInstall, id);
  }
  return id;
}

/**
 * Registers this install with the server and keeps it current: the push-to-start token as iOS hands it over, and every
 * running activity's token (an activity the server started tells its token only to the app, so it looks again when
 * the app opens and every `SYNC_MS` while it is open). Off: the registration goes and the activities end.
 */
export function useLiveActivity(
  api: ApiClient | null,
  locale: string,
  agents: readonly { id: string; look: AgentLookInput }[] | undefined,
) {
  const on = useLiveActivityOn();

  // The faces the island reads, drawn again only when a look changed.
  useEffect(() => {
    if (!on || !widgetsDirectory || !agents?.length) return;
    writeFaces(widgetsDirectory, agents);
  }, [on, agents]);

  useEffect(() => {
    if (!api || !widgetsDirectory) return;
    const id = installId();
    if (!on) {
      void api.push.liveActivityOff(id).catch(() => undefined);
      for (const activity of AgentsActivity.getInstances()) void activity.end("immediate").catch(() => undefined);
      return;
    }
    let live = true;
    const watched = new Set<string>();
    const subscriptions: { remove: () => void }[] = [];
    const register = async (fields: { pushToStartToken?: string; activity?: { id: string; token: string } }) => {
      const target = await iosPushTarget();
      if (!live) return;
      await api.push
        .liveActivity({ installId: id, widgetsDir: widgetsDirectory, locale, ...target, ...fields })
        .catch(() => undefined);
    };
    // Every running activity's token, and its next one when iOS changes it. One at a time: a second (a start the
    // server sent again while the first one's token hadn't reached it) ends, the newest staying.
    const sync = async () => {
      const running = AgentsActivity.getInstances();
      for (const extra of running.slice(0, -1)) await extra.end("immediate").catch(() => undefined);
      for (const activity of running.slice(-1)) {
        const activityId = activity.getId();
        if (!watched.has(activityId)) {
          watched.add(activityId);
          subscriptions.push(
            activity.addPushTokenListener((event) => {
              void register({ activity: { id: event.activityId, token: event.pushToken } });
            }),
          );
        }
        const token = await activity.getPushToken().catch(() => null);
        if (token && live) await register({ activity: { id: activityId, token } });
      }
    };
    subscriptions.push(
      addPushToStartTokenListener((event) => {
        void register({ pushToStartToken: event.activityPushToStartToken });
      }),
    );
    void register({});
    void sync();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void sync();
    }, SYNC_MS);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    return () => {
      live = false;
      clearInterval(timer);
      appState.remove();
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [api, on, locale]);
}
