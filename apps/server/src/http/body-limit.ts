import { FEEDBACK_INBOX_BYTES } from "@agenteschat/engine";
import { SKILL_ZIP_BASE64_CHARS } from "@agenteschat/tokens/skills";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { MULTIPART_PATHS } from "../routes/app/context";
import { apiError } from "./errors";

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * The most an `/api/*` request may send unless its path says otherwise below. Above the largest thing the apps send
 * as plain JSON (a table of `ARTIFACT_LIMITS.tableBytes`), so no route has to ask for it.
 */
export const API_BODY_BYTES = 8 * MIB;

/**
 * Routes that cap their own body: the uploads and imports with their own answer when it is too large, the webhooks
 * and a computer's upload, which count the bytes as they read them, and the git proxy, which passes a push through
 * without holding it.
 */
const OWN_LIMIT = [
  ...MULTIPART_PATHS,
  /\/organizations\/[^/]+\/imports$/,
  /\/organizations\/[^/]+\/vault\/import$/,
  /^\/api\/machines\/uploads\//,
  /^\/api\/webhooks\//,
  /^\/api\/hooks\//,
  /^\/api\/github-app\/webhook$/,
  /^\/api\/git\//,
];

/** A skill's folder as a base64 zip: what the import's own schema accepts, and the fields around it. */
const SKILL_ZIP_BYTES = SKILL_ZIP_BASE64_CHARS + MIB;

/**
 * Paths with a limit of their own, first match wins, and before the routes that cap themselves: nothing under
 * `/api/auth/` is left without a limit by how its path ends. A new route with a large JSON body gets a line here.
 */
const LIMITS: [RegExp, number][] = [
  // Signing in and up: read before anyone is known, and never more than a few fields.
  [/^\/api\/auth\//, 256 * KIB],
  [/\/organizations\/[^/]+\/skills\/import$/, SKILL_ZIP_BYTES],
  // A batch of notes: the web app keeps one under 8 Mi characters of JSON, and a character is up to 3 bytes on the wire.
  [/\/organizations\/[^/]+\/wiki\/import$/, 32 * MIB],
  // Another server's feedback with its pictures as base64 (ADR 0160 §13).
  [/^\/api\/feedback\/inbox$/, FEEDBACK_INBOX_BYTES],
];

/** The most a request to `path` may send, or null where the route caps it itself. */
export function apiBodyMax(path: string): number | null {
  const own = LIMITS.find(([p]) => p.test(path))?.[1];
  if (own !== undefined) return own;
  return OWN_LIMIT.some((p) => p.test(path)) ? null : API_BODY_BYTES;
}

const tooLarge = (c: Context) => apiError(c, 413, "too_large", "The request is too large");
const limiters = new Map<number, ReturnType<typeof bodyLimit>>();
const limiter = (maxSize: number) => {
  const made = limiters.get(maxSize) ?? bodyLimit({ maxSize, onError: tooLarge });
  limiters.set(maxSize, made);
  return made;
};

/**
 * Upload bodies this process holds at once, by their `Content-Length`: each route reads its body whole (a form, its
 * bytes, a copy for storage), so ten files of 50 MB at once held over a gigabyte. Past it a new upload waits up to
 * `UPLOAD_WAIT_MS` for room, then gets `503 server_busy` with a `Retry-After`; an upload alone may be larger.
 */
export const UPLOAD_BUDGET_BYTES = 128 * MIB;
export const UPLOAD_WAIT_MS = 30_000;

/** Uploads take their declared size from `budget` while their route runs; `apiBodyLimit` holds the process's one. */
export function uploadRoom(budget = UPLOAD_BUDGET_BYTES, waitMs = UPLOAD_WAIT_MS) {
  let held = 0;
  const waiting = new Set<() => void>();
  return async (c: Context, next: () => Promise<void>): Promise<void> => {
    const size = Number(c.req.header("content-length") ?? 0);
    if (!(size > 0) || !UPLOADS.some((p) => p.test(c.req.path))) return next();
    const deadline = Date.now() + waitMs;
    while (held > 0 && held + size > budget) {
      const left = deadline - Date.now();
      if (left <= 0) {
        c.header("retry-after", "10");
        // Set, not returned: it runs as another middleware's `next`, whose answer is the context's.
        c.res = apiError(c, 503, "server_busy", "Too many uploads at once here: try again in a moment");
        return;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiting.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        waiting.add(done);
      });
    }
    held += size;
    try {
      await next();
    } finally {
      held -= size;
      for (const wake of [...waiting]) wake();
    }
  };
}
const withUploadRoom = uploadRoom();

/** The bodies `withUploadRoom` counts: files, imports and another server's feedback. */
const UPLOADS = [
  ...MULTIPART_PATHS,
  /\/organizations\/[^/]+\/imports$/,
  /\/organizations\/[^/]+\/vault\/import$/,
  /\/organizations\/[^/]+\/skills\/import$/,
  /\/organizations\/[^/]+\/wiki\/import$/,
  /^\/api\/feedback\/inbox$/,
];

/**
 * Refuses a body past its path's limit before any route reads it: without it a request nobody signed could make the
 * server hold as much as the HTTP server accepts. Uploads then wait for room (`withUploadRoom`).
 */
export const apiBodyLimit = createMiddleware((c, next) => {
  const max = apiBodyMax(c.req.path);
  const route = () => withUploadRoom(c, next);
  return max === null ? route() : limiter(max)(c, route);
});
