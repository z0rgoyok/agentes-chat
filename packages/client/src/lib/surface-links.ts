import type { SurfaceLink, SurfaceLinkCode, SurfaceLinks } from "../api/types";
import { CONNECTOR_MARK } from "./connected";
import { capitalize } from "./format";

/** What the outside chat surface's settings row shows (ADR 0187). `surface` is the server's name for it. */
export type SurfaceRow =
  | { kind: "hidden" }
  | { kind: "none"; surface: string }
  | { kind: "pending"; surface: string; link: SurfaceLink }
  | { kind: "active"; surface: string; link: SurfaceLink };

/**
 * Hidden unless the server bridges a surface and this account may link it. A pending link still in its 10 minutes
 * comes first, since it waits on the person's confirm; one past `expiresAt` counts as none.
 */
export function surfaceRowOf(data: SurfaceLinks | null | undefined, now = Date.now()): SurfaceRow {
  if (!data?.surface || !data.allowed) return { kind: "hidden" };
  const surface = data.surface.name;
  const pending = data.links.find((l) => l.status === "pending" && (!l.expiresAt || Date.parse(l.expiresAt) > now));
  if (pending) return { kind: "pending", surface, link: pending };
  const active = data.links.find((l) => l.status === "active");
  return active ? { kind: "active", surface, link: active } : { kind: "none", surface };
}

/** While a code waits to come back from the surface, the links are read this often besides the live event. */
export const LINK_POLL_MS = 3000;

/** A fresh code this long before the shown one runs out: someone still typing it never holds a dead one. */
export const RENEW_BEFORE_MS = 30_000;

/** How long the server keeps a code (ADR 0187 §2). */
export const CODE_TTL_MS = 10 * 60_000;

/**
 * When the code stops working, on this device's clock: the server's `expiresAt`, unless the two clocks disagree so
 * much that it reads as gone or past the server's own 10 minutes; then 10 minutes from the answer. Read as-is, a
 * device running minutes fast would ask for a new code on every repaint.
 */
export function codeDeadline(code: Pick<SurfaceLinkCode, "expiresAt">, receivedAt: number) {
  const left = Date.parse(code.expiresAt) - receivedAt;
  return left > 2 * RENEW_BEFORE_MS && left <= CODE_TTL_MS ? receivedAt + left : receivedAt + CODE_TTL_MS;
}

/**
 * An active link that wasn't among `before` (the active ids when the code was shown): the person confirmed it on
 * another device meanwhile, so this one says linked rather than making another code. Ids, not times: the server's
 * clock and this device's may disagree.
 */
export function newlyLinked(data: SurfaceLinks | null | undefined, before: readonly string[]): SurfaceLink | null {
  return data?.links.find((l) => l.status === "active" && !before.includes(l.id)) ?? null;
}

/** The surface's name for a message's `via` (its id, the name lower-cased): the server's when it matches, else the id. */
export function surfaceViaName(id: string, name: string | null | undefined, locale?: string): string {
  return name && name.toLowerCase() === id.toLowerCase() ? name : capitalize(id, locale);
}

/**
 * The connector mark named like the surface (`/connectors/<name>.svg`, a one-color brand icon), or null when its name
 * can't name one. The name is the operator's own, so the file may not exist: the apps load it before showing it.
 */
export function surfaceMarkUrl(name: string): string | null {
  const url = `/connectors/${name.trim().toLowerCase()}.svg`;
  return CONNECTOR_MARK.test(url) ? url : null;
}
