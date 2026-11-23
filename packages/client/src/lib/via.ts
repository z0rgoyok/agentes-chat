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
