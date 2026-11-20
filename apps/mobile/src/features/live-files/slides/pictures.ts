import { useApi } from "@agenteschat/client";
import type { ImageSource } from "expo-image";
import { useMemo } from "react";
import { appHeaders, lastCookie } from "@/lib/auth";

/**
 * A live file's pictures on the phone (ADR 0196 §8): each one's address on the server with the session's headers (the
 * file's pictures are served only to whoever reads it), cached by the picture's id, which never changes, so a slide or
 * a canvas drawn again never downloads it twice nor flickers when the session's link would have.
 */
export function useFilePictures(orgId: string, fileId: string): (assetId: string) => ImageSource {
  const api = useApi();
  return useMemo(() => {
    const headers = appHeaders(lastCookie());
    return (assetId: string) => ({
      uri: api.live.assetUrl(orgId, fileId, assetId),
      headers,
      cacheKey: `live-asset:${fileId}:${assetId}`,
    });
  }, [api, orgId, fileId]);
}
