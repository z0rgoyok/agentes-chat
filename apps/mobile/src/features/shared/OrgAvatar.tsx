import { logoPlate } from "@agenteschat/ui/org-logo";
import { workspaceSky } from "@agenteschat/ui/sky/accent";
import { Image } from "expo-image";
import { useMemo } from "react";
import { appHeaders, lastCookie } from "@/lib/auth";
import { photoSource } from "@/lib/photo";
import { placeKey } from "@/lib/server";
import { serverOf } from "@/lib/server-choice";
import { LogoMark, useTheme } from "@/ui";

/**
 * A workspace's face, as the web's `OrgMark`: its whole logo (a wordmark arrives uncropped) in the agent's shape
 * (rounded, the bottom-left corner cut closer), on a plate where the surface would hide its ink (`logoPlate`), else the
 * agent mark. The logo is cached in memory and on disk (its address changes with its content) and drawn with no fade,
 * as the bars and lists show it again and again.
 */
export function OrgAvatar({
  logo,
  accent,
  size = 30,
  server,
}: {
  logo?: string | null | undefined;
  /** That workspace's own accent (null: none), for a list that shows several; absent, the active workspace's. */
  accent?: string | null | undefined;
  size?: number;
  /** The place the logo is read from (another server or account signed in to, in Workspaces); the current one by default. */
  server?: string;
}) {
  const { scheme } = useTheme();
  // Stable per logo, so the image isn't fetched again on every render.
  const source = useMemo(() => {
    const on = server ?? placeKey();
    return photoSource(logo, serverOf(on), appHeaders(lastCookie(on)));
  }, [logo, server]);
  if (!source) return <LogoMark size={size} {...(accent !== undefined ? { sky: workspaceSky(accent) } : {})} />;
  const round = size * 0.3;
  return (
    <Image
      source={source}
      cachePolicy="memory-disk"
      recyclingKey={source.uri}
      transition={0}
      contentFit="contain"
      style={{
        width: size,
        height: size,
        backgroundColor: logoPlate(logo, scheme === "dark") ?? "transparent",
        borderTopLeftRadius: round,
        borderTopRightRadius: round,
        borderBottomRightRadius: round,
        borderBottomLeftRadius: size * 0.09,
      }}
      accessibilityIgnoresInvertColors
    />
  );
}
