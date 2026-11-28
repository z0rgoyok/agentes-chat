import { type ReconnectCause, reconnectCause, useReconnectCause } from "@agenteschat/client";
import { Button, Icon } from "@agenteschat/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { browserOffline } from "@/chat/offline";
import { useConnectionStatus, useRealtimeConnection } from "@/realtime/context";

const ICON = { device: "globe", server: "cloud", signedOut: "lock" } as const satisfies Record<ReconnectCause, string>;

/**
 * A dropped live connection, said small and late: nothing for its first two minutes (it retries by itself), then a
 * pill with why (no internet here, the server not answering, signed out) and one way out. It leaves once it reconnects.
 */
export function ReconnectPill() {
  const { t } = useTranslation();
  const api = useApi();
  const connection = useRealtimeConnection();
  const status = useConnectionStatus();
  const navigate = useNavigate();
  const here = useRouterState({ select: (s) => s.location.href });
  const { cause, recheck } = useReconnectCause(status, () => reconnectCause(browserOffline(), () => api.account.me()));
  if (!cause) return null;
  return (
    <div className="reconnect-pill" role="status">
      <span className="reconnect-pill__text ac-iconline">
        <Icon name={ICON[cause]} size={16} />
        <span>{t(`reconnect.${cause}`)}</span>
      </span>
      {cause === "signedOut" ? (
        <Button size="sm" variant="default" onClick={() => void navigate({ to: "/login", search: { redirect: here } })}>
          {t("reconnect.signIn")}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="default"
          onClick={() => {
            connection?.checkAlive();
            recheck();
          }}
        >
          {t("reconnect.retry")}
        </Button>
      )}
    </div>
  );
}
