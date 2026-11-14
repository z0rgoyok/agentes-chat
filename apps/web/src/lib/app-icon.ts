import { type AppIconId, DEFAULT_APP_ICON, isAppIcon } from "@agenteschat/client/lib/app-icons";
import { normalizeAppearance } from "@agenteschat/ui";
import { type AgentIcon, agentDesktopPictures, agentFavicon, sameAgent } from "./agent-app-icon";
import { desktopPicksAppIcon, inDesktopApp, thisMac } from "./desktop";
import { STORAGE_KEYS, storage } from "./storage";

/**
 * The app icon on this device (ADR 0179): one of the app's icons, or one of a workspace's agents (web and desktop
 * only: a phone takes only the icons its build carries). In a browser it is the tabs' icon, kept in this browser
 * like the theme. In the desktop app it is the Dock's (the taskbar's on Windows and Linux), kept by the app itself,
 * so every server's pages show the same; an app from before it can't (`desktopPicksAppIcon`) and the row stays hidden.
 */
export type AppIconPick = AppIconId | { agent: AgentIcon };
export type { AgentIcon };

const CHANGE_EVENT = "agentes:app-icon";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An agent as kept (this browser's storage, or the desktop app's answer): ids, a name and a look, or nothing. */
export function agentOf(raw: unknown): AgentIcon | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.orgId !== "string" || !ID.test(a.orgId) || typeof a.id !== "string" || !ID.test(a.id)) return null;
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (!name || name.length > 80) return null;
  return { orgId: a.orgId, id: a.id, name, look: normalizeAppearance(a.look) };
}

/** The pick as this browser keeps it: an icon's id, or `{"agent": …}`. */
export function parsePick(value: string | null): AppIconPick {
  if (isAppIcon(value)) return value;
  if (value?.startsWith("{")) {
    try {
      const agent = agentOf((JSON.parse(value) as { agent?: unknown }).agent);
      if (agent) return { agent };
    } catch {
      // Not ours: the default.
    }
  }
  return DEFAULT_APP_ICON;
}
const keptValue = (pick: AppIconPick) => (typeof pick === "string" ? pick : JSON.stringify({ agent: pick.agent }));

/** The agent of a pick, if it is one. */
export const pickedAgent = (pick: AppIconPick) => (typeof pick === "string" ? null : pick.agent);

let current: AppIconPick = inDesktopApp() ? DEFAULT_APP_ICON : parsePick(storage.get(STORAGE_KEYS.appIcon));

/** The icon's picture in the picker (packages/ui/scripts/app-icons.mjs writes them). */
export const appIconPicture = (id: AppIconId) => `/app-icons/${id}.png`;
/** The tab's icon: the shipped one at the address browsers ask for on their own. */
export const faviconOf = (id: AppIconId) => (id === DEFAULT_APP_ICON ? "/favicon.ico" : `/app-icons/${id}.ico`);

/** Whether this device can change its icon here (a browser, or a desktop app that keeps one). */
export const picksAppIcon = () => !inDesktopApp() || desktopPicksAppIcon();

export const appIcon = () => current;
export const onAppIconChange = (cb: () => void) => {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
};

function show(pick: AppIconPick) {
  current = pick;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const href =
    typeof pick === "string" ? faviconOf(pick) : agentFavicon(pick.agent.look) || faviconOf(DEFAULT_APP_ICON);
  if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Changes the icon. In the desktop app the app keeps it (an agent with the pictures drawn here); a refusal rejects. */
export async function setAppIcon(pick: AppIconPick) {
  if (inDesktopApp()) {
    if (typeof pick === "string") await thisMac.appIcon({ icon: pick });
    else await thisMac.appIcon({ agent: { ...pick.agent, ...(await agentDesktopPictures(pick.agent.look)) } });
  } else storage.set(STORAGE_KEYS.appIcon, keptValue(pick));
  show(pick);
}

/**
 * The picked agent as its workspace has it now (`agents`, when they are the picked agent's workspace's): a new name
 * or look redraws the icon; an agent no longer there keeps the icon as it was.
 */
export function followPickedAgent(orgId: string, agents: { id: string; name: string; appearance?: unknown }[]) {
  const picked = pickedAgent(current);
  if (!picked || picked.orgId !== orgId) return;
  const now = agents.find((a) => a.id === picked.id);
  if (!now) return;
  const fresh: AgentIcon = { ...picked, name: now.name, look: normalizeAppearance(now.appearance) };
  if (!sameAgent(picked, fresh)) void setAppIcon({ agent: fresh }).catch(() => undefined);
}

/** At start: the tab shows the icon kept in this browser; the desktop app answers the one it keeps. */
export function startAppIcon() {
  if (!inDesktopApp()) {
    if (current !== DEFAULT_APP_ICON) show(current);
    return;
  }
  if (!desktopPicksAppIcon()) return;
  void thisMac
    .appIcon()
    .then(({ icon, agent }) => {
      const kept = agentOf(agent);
      if (kept) show({ agent: kept });
      else if (isAppIcon(icon) && icon !== current) show(icon);
    })
    .catch(() => undefined);
}
