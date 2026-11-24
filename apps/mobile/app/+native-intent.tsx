import { openOwnPage } from "@/features/ai/parts";
import { appLinkFromUrl, liveActivityLinkHref } from "@/features/links/app-links";
import { workspaceOnScreen } from "@/features/links/on-screen";
import { rememberLink } from "@/features/links/pending";
import { SHARE_ROUTE } from "@/features/share/inbox";

/**
 * Every URL the system opens the app with (a universal link / App Link to the website, or `agenteschat://`), before
 * expo-router reads it: the website's address becomes the app's screen (`appLinkFromUrl`), and a page the app has no
 * screen for opens in the browser, the app staying where it was (on its start at launch). A screen of the workspace on
 * screen opens straight away; another workspace's, or one that needs a lookup, goes through `/link`. What another app
 * shared through the system's share sheet opens "Compartilhar com…"; the agents' island, the conversation it shows.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  try {
    // The share extension opens the app with `agenteschat://dataUrl=…` (expo-share-intent): "Compartilhar com…".
    if (path.includes("dataUrl=")) return SHARE_ROUTE;
    // A tap on the agents' island (ADR 0210): the conversation it shows.
    const island = liveActivityLinkHref(path, workspaceOnScreen());
    if (island) return island;
    const link = appLinkFromUrl(path, workspaceOnScreen());
    if (!link) return path;
    if ("web" in link) {
      openOwnPage(path);
      return initial ? "/" : "";
    }
    // Signed out, the sign-in comes first; the link is opened right after it.
    if (link.href.startsWith("/link?")) rememberLink(link.href);
    return link.href;
  } catch {
    return initial ? "/" : path;
  }
}
