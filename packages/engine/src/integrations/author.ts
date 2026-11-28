/**
 * An integration app's message (ADR 0251): `meta.app`, written by the server at post time, never by a client. The
 * name and color are the app's then; `sender` is the outside person's display name the app passed, if any.
 */
export interface AppAuthor {
  id: string;
  name: string;
  color: string;
  sender: string | null;
}

/** `meta.app` of an app's message, or null. */
export function appAuthorOf(meta: Record<string, unknown> | null | undefined): AppAuthor | null {
  const app = meta?.app;
  if (!app || typeof app !== "object") return null;
  const { id, name, color, sender } = app as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return {
    id,
    name,
    color: typeof color === "string" ? color : "graphite",
    sender: typeof sender === "string" && sender ? sender : null,
  };
}

/** Who wrote a message, as views name it: a person's or an agent's id, an app's `meta.app.id`. */
export const authorIdOf = (m: {
  authorType: string;
  authorUserId: string | null;
  authorAgentId: string | null;
  meta: Record<string, unknown> | null;
}): string | null =>
  m.authorType === "person"
    ? m.authorUserId
    : m.authorType === "app"
      ? (appAuthorOf(m.meta)?.id ?? null)
      : m.authorAgentId;

/** The webhook job of an agent's message where an app reads (queued by the message's own insert). */
export const INTEGRATION_DELIVERY_JOB = "integration_app.deliver";
/** Tries of one delivery, with the outbox's backoff between them (about a day in all). */
export const INTEGRATION_DELIVERY_ATTEMPTS = 8;
