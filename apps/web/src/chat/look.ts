import { type ChatPrefs, chatLookOf, facesShown, textSizeOf } from "@agenteschat/client/lib/chat-look";
import {
  hasWallpaper,
  NO_WALLPAPER,
  resolveWallpaper,
  wallpaperFor,
  wallpaperHueOf,
} from "@agenteschat/client/lib/wallpaper";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { type AgentColor, agentGradient, MessageLookContext, useDarkTheme } from "@agenteschat/ui";
import { wallpaperStrength } from "@agenteschat/ui/sky/wallpaper";
import { useContext, useLayoutEffect, useMemo } from "react";
import { useOrg } from "@/components/org-context";
import { wallpaperVars } from "@/lib/wallpaper-paint";

/** The deep end of an agent's color: what my bubbles take in a DM. */
const deepOf = (color: AgentColor) => agentGradient(color)[1];

/**
 * How this conversation looks to me (`chatLookOf`). A thread opened inside a DM is that DM's: it keeps its bubbles'
 * color from the view around it. My bubbles take the color of the agent I talk to, and the workspace's sky elsewhere.
 * In a personal workspace every conversation opens in bubbles (ADR 0159) until I choose otherwise.
 */
export function useConversationLook(dm: boolean, agentColor?: AgentColor) {
  const { org } = useOrg();
  const around = useContext(MessageLookContext);
  const inDm = dm || (around !== null && !around.names);
  const { style, tone } = chatLookOf(org.chatPrefs, inDm, isPersonal(org));
  const mine = agentColor ? deepOf(agentColor) : inDm && around ? around.mine : deepOf("sky");
  return useMemo(
    () => ({ style, tone, mine, names: !inDm, faces: facesShown(style, inDm) }),
    [style, tone, mine, inDm],
  );
}

/**
 * The background behind this conversation for me (packages/client/src/lib/wallpaper.ts): its own, or the one behind
 * every conversation, "auto" made the color of the agent I talk to (`agentColor`), the workspace's sky elsewhere.
 * With it, how strongly it shows (half in the looks with no bubbles) and the variables what sits over it reads. Null:
 * none, or no `channelId` (a thread in the side panel keeps the plain page).
 */
export function useConversationWallpaper(dm: boolean, channelId: string | null, agentColor?: AgentColor) {
  const { org } = useOrg();
  const around = useContext(MessageLookContext);
  const dark = useDarkTheme();
  const inDm = dm || (around !== null && !around.names);
  const { style } = chatLookOf(org.chatPrefs, inDm, isPersonal(org));
  const chosen = channelId ? wallpaperFor(org.chatPrefs, channelId) : NO_WALLPAPER;
  const hue = wallpaperHueOf(agentColor);
  return useMemo(
    () =>
      hasWallpaper(chosen)
        ? {
            wallpaper: resolveWallpaper(chosen, hue),
            strength: wallpaperStrength(style === "bubbles"),
            vars: wallpaperVars(dark),
          }
        : null,
    [chosen, hue, style, dark],
  );
}

/**
 * My Tamanho do texto on the page (`html[data-text-size]`, packages/ui's components.css), so every conversation on
 * screen, the panels and the floating thread included, takes a new choice at once. Set before the first paint: rows
 * already in the cache (the device snapshot) would otherwise show at the default for a frame, then jump.
 */
export function usePageTextSize(prefs: ChatPrefs | undefined) {
  const size = textSizeOf(prefs);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.textSize = size;
    return () => {
      delete root.dataset.textSize;
    };
  }, [size]);
}
