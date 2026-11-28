/** `message.meta.via` (ADR 0119, server-made): the person sent it through a connected AI app. */
export interface AppVia {
  name: string;
  brand: string | null;
}

/** The app a person's message came through, or null; read-only, the server writes it. */
export function appVia(meta: Record<string, unknown> | null | undefined): AppVia | null {
  const via = meta?.via;
  if (!via || typeof via !== "object") return null;
  const { kind, name, brand } = via as Record<string, unknown>;
  if (kind !== "app" || typeof name !== "string" || !name.trim()) return null;
  return { name: name.trim(), brand: typeof brand === "string" ? brand : null };
}

/** `message.meta.via` (ADR 0187, server-made): the person wrote it on the outside chat surface. */
export interface SurfaceVia {
  /** The surface's id: its name lower-cased. The apps show the server's `SurfaceLinks.surface.name`. */
  surface: string;
  linkId: string | null;
  /** Someone else's words the person passed on. */
  forwarded: boolean;
}

/** The outside chat surface a person's message came through, or null; read-only, the server writes it. */
export function surfaceVia(meta: Record<string, unknown> | null | undefined): SurfaceVia | null {
  const via = meta?.via;
  if (!via || typeof via !== "object") return null;
  const { kind, surface, linkId, forwarded } = via as Record<string, unknown>;
  if (kind !== "surface" || typeof surface !== "string" || !surface.trim()) return null;
  return { surface: surface.trim(), linkId: typeof linkId === "string" ? linkId : null, forwarded: forwarded === true };
}

/**
 * An integration app's message (ADR 0251, server-made `meta.app`): the app that posted it as itself, and the outside
 * sender it passed. Mirrors `appAuthorOf` in packages/engine/src/integrations/author.ts.
 */
export interface AppAuthor {
  id: string;
  name: string;
  color: string;
  sender: string | null;
}

/** The app behind an app's message, or null; read-only, the server writes it. */
export function appAuthor(meta: Record<string, unknown> | null | undefined): AppAuthor | null {
  const app = meta?.app;
  if (!app || typeof app !== "object") return null;
  const { id, name, color, sender } = app as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string" || !name.trim()) return null;
  return {
    id,
    name: name.trim(),
    color: typeof color === "string" ? color : "graphite",
    sender: typeof sender === "string" && sender.trim() ? sender.trim() : null,
  };
}
