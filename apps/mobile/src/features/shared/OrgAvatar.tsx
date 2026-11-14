import { useMemo } from "react";
import { Image } from "react-native";
import { appHeaders, lastCookie } from "@/lib/auth";
import { photoSource } from "@/lib/photo";
import { placeKey } from "@/lib/server";
import { serverOf } from "@/lib/server-choice";
import { LogoMark } from "@/ui";

/**
 * A workspace's face, as the web's `OrgMark`: its logo in the agent's shape (rounded, the bottom-left corner cut
 * closer), else the agent mark.
 */
export function OrgAvatar({
  logo,
  size = 30,
  server,
}: {
  logo?: string | null | undefined;
  size?: number;
  /** The place the logo is read from (another server or account signed in to, in Workspaces); the current one by default. */
  server?: string;
}) {
  // Stable per logo, so the image isn't fetched again on every render.
  const source = useMemo(() => {
    const on = server ?? placeKey();
    return photoSource(logo, serverOf(on), appHeaders(lastCookie(on)));
  }, [logo, server]);
  if (!source) return <LogoMark size={size} />;
  const round = size * 0.3;
  return (
    <Image
      source={source}
      style={{
        width: size,
        height: size,
        borderTopLeftRadius: round,
        borderTopRightRadius: round,
        borderBottomRightRadius: round,
        borderBottomLeftRadius: size * 0.09,
      }}
      accessibilityIgnoresInvertColors
    />
  );
}
