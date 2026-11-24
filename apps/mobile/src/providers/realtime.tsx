import { type ConnectionStatus, keys, type Me, RealtimeConnection, realtimeUrl } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { lastCookie, readCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { createSocketFactory } from "@/lib/socket";
import { keepWhileActive } from "@/lib/useAppActive";
import { useOrgIdMaybe } from "./org";
import { catchUpQueries } from "./query";

export interface RealtimeState {
  /** The organization's WebSocket (null while signed out or without an organization; stopped in the background). */
  connection: RealtimeConnection | null;
  status: ConnectionStatus;
}

const RealtimeContext = createContext<RealtimeState>({ connection: null, status: "idle" });

/**
 * One WebSocket per organization (`/api/ws?orgId=`), with the session cookie and the app header on the upgrade. The
 * same connection while the organization is open: stopped in the background, started again with a fresh cookie when
 * the app comes back (`keepWhileActive`), and kept through a glance away (the notification shade, a Face ID prompt).
 * Its catch-up then reads again what it may have missed (realtime is best effort, the database is the truth).
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const orgId = useOrgIdMaybe();
  const queryClient = useQueryClient();
  const { i18n } = useTranslation();
  const [state, setState] = useState<RealtimeState>({ connection: null, status: "idle" });

  useEffect(() => {
    if (!orgId) {
      setState({ connection: null, status: "idle" });
      return;
    }
    const c = new RealtimeConnection({
      url: realtimeUrl(serverUrl(), orgId),
      createSocket: createSocketFactory(lastCookie),
      // The agent's browser stays base64 on this socket (ADR 0040 §7.1): React Native hands a binary message to JS
      // as base64 decoded in JS, and the image view takes the server's base64 as a data: URL with no pass of its own.
      browserFrameSockets: false,
    });
    const offs = [
      c.onStatus((status) => setState({ connection: c, status })),
      // At once when the app comes back, spread over a few seconds after a drop (every phone of a restarted server
      // back at once doesn't read at once); only what is on screen after a brief gap.
      c.onCatchUp((full) => void catchUpQueries(queryClient, full)),
      // Taken out of the workspace: said plainly (not when it was their own doing, `membership_ended`), then `me` without it opens another one (or the first run).
      c.onError((code) => {
        if (code === "membership_ended") void queryClient.invalidateQueries({ queryKey: keys.me });
        if (code !== "membership_revoked") return;
        const name = queryClient.getQueryData<Me>(keys.me)?.organizations.find((o) => o.id === orgId)?.name ?? "";
        Alert.alert(i18n.t("members.remove.goneTitle", { org: name }), i18n.t("members.remove.goneText"));
        void queryClient.invalidateQueries({ queryKey: keys.me });
      }),
    ];
    const offActive = keepWhileActive(c, readCookie);
    setState({ connection: c, status: c.status });
    return () => {
      offActive();
      for (const off of offs) off();
      c.stop();
    };
  }, [orgId, queryClient, i18n]);

  return <RealtimeContext.Provider value={state}>{children}</RealtimeContext.Provider>;
}

/** `{ connection, status }`: subscribe to channels with `connection.subscribe(channelId, listener)`. */
export const useRealtime = () => useContext(RealtimeContext);
