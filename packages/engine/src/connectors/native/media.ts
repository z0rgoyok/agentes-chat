import { timingSafeEqual } from "node:crypto";
import { reachableFromInternet } from "../../apps/urls";
import { type ArtifactDeps, storedFileById } from "../../artifacts";
import { connectorMediaSignature } from "../../crypto";
import type { ResolveHost } from "../../net-guard";

/** How long a vendor may fetch a file from its link (ADR 0170 §4). */
export const MEDIA_LINK_SECONDS = 3600;
export const MEDIA_LINK_PATH = "/api/connector-media/";

/**
 * Links a vendor fetches a Drive file from (Threads' and TikTok's media come by URL): `{PUBLIC_URL}/api/connector-media/
 * {payload}.{signature}`, good for an hour, only on a server the internet reaches (null elsewhere). The tool makes one
 * only for a file the agent may read (`NativeCall.file` first).
 */
export function connectorMediaLinks(deps: { secret: string; publicUrl: string; resolveHost?: ResolveHost }) {
  return async (orgId: string, artifactId: string, now = Date.now()) => {
    if (!(await reachableFromInternet(deps.publicUrl, deps.resolveHost).catch(() => false))) return null;
    const payload = Buffer.from(
      JSON.stringify({ o: orgId, a: artifactId, e: Math.floor(now / 1000) + MEDIA_LINK_SECONDS }),
    ).toString("base64url");
    return `${deps.publicUrl.replace(/\/$/, "")}${MEDIA_LINK_PATH}${payload}.${connectorMediaSignature(deps.secret, payload)}`;
  };
}

/** The file a media link names, while it is good and its signature ours; null otherwise. */
export async function openConnectorMedia(deps: ArtifactDeps & { secret: string }, token: string, now = Date.now()) {
  const [payload = "", signature = ""] = token.split(".");
  const expected = connectorMediaSignature(deps.secret, payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }
  let claims: { o?: unknown; a?: unknown; e?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof claims.o !== "string" || typeof claims.a !== "string" || typeof claims.e !== "number") return null;
  if (claims.e * 1000 < now) return null;
  return storedFileById(deps, claims.o, claims.a);
}
