import { useLinkingURL } from "expo-linking";
import { usePathname } from "expo-router";
import { ShareIntentModule, useShareIntent } from "expo-share-intent";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { reportError } from "@/lib/error-reports";
import { router } from "@/ui/navigation";
import { receiveShare, SHARE_ROUTE, sharedFromIntent } from "./inbox";

/**
 * After the app opens on a share's link, when to ask the system again for what was shared (ms). The extension writes
 * it and opens the app in the same breath, and the library asks once, as the link arrives: with nothing read then,
 * "Compartilhar com…" opened empty and stayed so.
 */
export const SHARE_ASK_AGAIN_MS = [250, 700, 1500];
/** With nothing by then, the reason is reported (the screen gives up at 3 s). */
const SHARE_LOST_MS = 2500;
/** The extension's link, whatever the app's scheme: `…://dataUrl=<key>#<kind>` (expo-share-intent). */
export const isShareLink = (url: string | null): url is string => Boolean(url?.includes("://dataUrl="));
/** What kind of thing a share's link says came (`media`, `text`, `weburl`, `file`), for a report: never its content. */
export const shareLinkKind = (url: string) => url.split("#")[1] ?? "";

/**
 * Listens for the system's share sheet (an iOS share extension and Android's send intent, from `expo-share-intent`):
 * what arrives is kept (`receiveShare`), the native copy is cleared so it never comes back, and "Compartilhar com…"
 * opens over whatever is on screen. On iOS the extension opens the app with a link `+native-intent` already sends to
 * that screen; on Android nothing navigates, so this does. Mounted in the signed-in app: shared while signed out, it
 * opens once the person is in. A build without the native part (the module missing) simply never hears anything.
 *
 * The share is cleared here, once taken, and not by the library each time the app stops being active
 * (`resetOnBackground`): a share arrives across exactly such a change, and nothing else here needs that clearing.
 * A share that never arrives is reported with what the library said and the link's kind, never its content.
 */
export function ShareInbox() {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntent({ resetOnBackground: false });
  const url = useLinkingURL();
  const pathname = usePathname();
  const where = useRef(pathname);
  where.current = pathname;
  const link = useRef(url);
  link.current = url;
  // The link whose share was taken (or reported lost): it is asked for no more.
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (!hasShareIntent) return;
    const shared = sharedFromIntent(shareIntent);
    resetShareIntent();
    if (!shared) return;
    settled.current = link.current;
    receiveShare(shared);
    if (where.current !== SHARE_ROUTE) router.push(SHARE_ROUTE);
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  useEffect(() => {
    if (Platform.OS !== "ios" || !isShareLink(url) || settled.current === url) return;
    const timers = SHARE_ASK_AGAIN_MS.map((ms) =>
      setTimeout(() => {
        if (settled.current !== url) void ShareIntentModule?.getShareIntent(url);
      }, ms),
    );
    const lost = setTimeout(() => {
      if (settled.current === url) return;
      settled.current = url;
      reportError(new Error("share: nothing arrived from the share extension"), { share_kind: shareLinkKind(url) });
    }, SHARE_LOST_MS);
    return () => {
      for (const timer of timers) clearTimeout(timer);
      clearTimeout(lost);
    };
  }, [url]);

  // What the library itself couldn't do (no shared group, a kind it doesn't know): its own words, reported.
  useEffect(() => {
    if (!error) return;
    reportError(new Error(`share: ${error}`), { share_kind: link.current ? shareLinkKind(link.current) : "" });
  }, [error]);
  return null;
}
