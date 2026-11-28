import type { ControlFolderPick } from "@agenteschat/adapters/runner-control";
import type { TFunction } from "i18next";
import type { Host } from "../host/types";
import { baseName } from "../ui/time";
import { type Home, orgName } from "./store";

/**
 * Preferences › General › "Let me know about messages and requests" (on by default): the server's own
 * notifications while the app is in the background (`this_mac` `notify`, shown by Rust within its limits).
 */
export const SITE_NOTIFY_PREF = "notifySite";

/**
 * A folder asked for from the apps (`access.pick`): always told, and the popover opens on the card where the person
 * here answers. It stays up (`keep`) until they do: raised while another app is in front, it would go the moment it
 * showed.
 */
export function raisePick(host: Host, t: TFunction, home: Home, pick: ControlFolderPick) {
  const request = pick.requestId ? home.requests.find((r) => r.requestId === pick.requestId) : undefined;
  const name = pick.byName || orgName(home);
  const title = request
    ? t("desktop.tray.notifTitle", { agent: request.agent.name, folder: baseName(request.path) })
    : pick.agentName
      ? t("desktop.tray.pickTitleAgent", { name, agent: pick.agentName })
      : t("desktop.tray.pickTitle", { name });
  void host.notify(title, request ? request.reason : t("desktop.tray.pickBody")).catch(() => {});
  void host.showWindow("popover", { keep: true }).catch(() => {});
}
