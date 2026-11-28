import {
  confirmLink,
  decideOnSurfacePage,
  emailPinLink,
  listLinks,
  mintLinkCode,
  openSurfacePage,
  removeLink,
  requireSurface,
  type SurfacePageView,
  setMySurfacePin,
  setNudge,
  setPinFromEmail,
  sha256,
  surfaceAllowed,
  surfaceOn,
  undoSurfaceLink,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { sessionUser } from "../../auth";
import { requestLimitIp } from "../../http/client-ip";
import { apiError, errorResponse } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Account"];

const CODES_PER_HOUR = { limit: 10, windowMs: 3_600_000 };
/** As "This wasn't me": room for a few retries, never for guessing a token. */
const UNDO_PER_IP = { limit: 10, windowMs: 10 * 60_000 };
/** A page reloads and decides a few times; its PIN has its own lock (three wrong ones). */
const PAGE_PER_IP = { limit: 30, windowMs: 10 * 60_000 };
const PIN_EMAILS_PER_IP = { limit: 3, windowMs: 3_600_000 };
/** Setting the PIN in the app: each one is a slow hash. */
const PIN_SETS_PER_USER = { limit: 10, windowMs: 10 * 60_000 };
const Pin = z
  .string()
  .regex(/^\d{6}$/)
  .openapi({ description: "Six digits." });

const PageToken = z.object({ token: z.string().min(16).max(200) });
const SurfacePage = z
  .object({
    kind: z.enum(["confirm", "screen", "control"]),
    expiresAt: z.string(),
    surface: z.string(),
    orgId: z.uuid().openapi({ description: "The approval's workspace: its settings choose the PIN in the app." }),
    pin: z.object({
      set: z.boolean().openapi({ description: "False: approving waits until the PIN is chosen somewhere trusted." }),
      lockedUntil: z.string().nullable(),
      canChoose: z.boolean().openapi({
        description:
          "None set and this browser is signed in as the person: approving here chooses it. A page link alone never does.",
      }),
      resetByEmail: z.boolean().openapi({
        description: "This server sends email and the address is verified, so a link to choose the PIN can be emailed.",
      }),
    }),
    approval: z
      .object({
        id: z.uuid(),
        tool: z.string(),
        params: z.record(z.string(), z.unknown()),
        title: z.string(),
        detail: z.string(),
        why: z.string().nullable(),
        kind: z.string(),
        titleParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        status: z.string(),
        canDecide: z.boolean(),
        approverLabel: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("SurfacePage");
const pageGone = errorResponse(
  "Ran out, its link ended, or no longer visible (`surface.page_gone`); opened in another browser (`surface.page_elsewhere`, 403)",
);

/** The cookie that binds one page link to the browser that opened it first. */
const pageCookie = (token: string) => `surface_page_${sha256(token).slice(0, 16)}`;

const hour = z.number().int().min(0).max(23);
const Nudge = z
  .object({
    on: z.boolean(),
    afterHours: z.number().int().min(1).max(24).openapi({ description: "Hours something stays unread first." }),
    quietFrom: hour.openapi({ description: "No nudge from this hour (the person's time zone)…" }),
    quietTo: hour.openapi({ description: "…until this one. Equal: no quiet hours." }),
  })
  .openapi("SurfaceNudge");

const SurfaceLink = z
  .object({
    id: z.uuid(),
    status: z.enum(["pending", "active"]),
    display: z
      .string()
      .nullable()
      .openapi({ description: "What the surface shows of the sender: shown, never trusted." }),
    profileName: z.string().nullable().openapi({ description: "The sender's own name on the surface. Untrusted." }),
    orgId: z.uuid().nullable(),
    orgName: z.string().nullable(),
    createdAt: z.string(),
    confirmedAt: z.string().nullable(),
    expiresAt: z.string().nullable().openapi({ description: "Pending only: when it stops counting (10 minutes)." }),
    pinSet: z.boolean().openapi({ description: "A PIN confirms actions asked from the surface (ADR 0226)." }),
    nudge: Nudge,
  })
  .openapi("SurfaceLink");

const LinkParams = z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) });
const off = errorResponse("Outside chat surfaces are off on this server (`surface.off`)");

/**
 * Linking an outside chat surface to the account (ADR 0187): the person mints a code here, types it on the surface,
 * then confirms the sender it came from. Per person, not per workspace; the link answers in one workspace at a time.
 */
export function surfaceRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/me/surface-links", requireSession(deps.auth));
  app.use("/me/surface-links/*", requireSession(deps.auth));
  app.use("/organizations/*", requireSession(deps.auth));
  const linkDeps = {
    db,
    pubsub: adapters.pubsub,
    publicUrl: adapters.email.delivers === true ? deps.config.PUBLIC_URL : null,
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/me/surface-links",
      tags,
      security,
      summary: "The outside chat surface this server bridges to, whether I may link it, and my links",
      description:
        "`surface` is null and `allowed` false when the bridge is off. `allowed` decides whether the apps offer linking. `links`: active first, then pending ones younger than 10 minutes.",
      responses: {
        200: json(
          z.object({
            surface: z.object({ name: z.string() }).nullable(),
            allowed: z.boolean(),
            links: z.array(SurfaceLink),
          }),
        ),
        401: errors[401],
      },
    }),
    async (c) => {
      const user = c.get("user");
      const surface = surfaceOn();
      if (!surface) return c.json({ surface: null, allowed: false, links: [] }, 200);
      return c.json(
        { surface: { name: surface.name }, allowed: surfaceAllowed(user.email), links: await listLinks(db, user.id) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/surface-link/code",
      tags,
      security,
      summary: "A code to type on the outside chat surface, linking it to me in this workspace",
      description:
        "Works for 10 minutes, once; earlier codes keep working until they expire. `openUrl` opens the surface with the code typed.",
      request: { params: OrgParams },
      responses: {
        201: json(z.object({ code: z.string(), openUrl: z.string(), expiresAt: z.string() })),
        401: errors[401],
        403: errorResponse("Not a member (`forbidden`), or not among who may link now (`surface.not_allowed`)"),
        404: off,
        409: errorResponse("The workspace's assistant can't talk to me (`surface.no_assistant`)"),
        429: errorResponse("More than 10 codes in an hour (`rate_limited`)"),
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const user = c.get("user");
      requireSurface();
      if (!surfaceAllowed(user.email)) {
        return apiError(c, 403, "surface.not_allowed", "Linking isn't open to this account yet");
      }
      if (!(await adapters.rateLimiter.consume(`surface-code:${user.id}`, CODES_PER_HOUR)).allowed) {
        return apiError(c, 429, "rate_limited", "Too many codes. Try again later.");
      }
      const minted = await mintLinkCode(db, user.id, orgId);
      return c.json({ ...minted, expiresAt: minted.expiresAt.toISOString() }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/me/surface-links/{id}/confirm",
      tags,
      security,
      summary: "Confirm a pending link: the sender it shows is me",
      description:
        "Replaces my other link (or moves this sender's link to the pending one's workspace). The surface then says the link is active.",
      request: { params: LinkParams },
      responses: {
        200: json(SurfaceLink),
        401: errors[401],
        404: errorResponse(
          "Not mine, not pending or older than 10 minutes (`surface.link_gone`), or off (`surface.off`)",
        ),
        403: errorResponse("Not among who may link now (`surface.not_allowed`)"),
        409: errorResponse("`surface.taken`, `surface.no_workspace` or `surface.no_assistant`"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const user = c.get("user");
      if (surfaceOn() && !surfaceAllowed(user.email)) {
        return apiError(c, 403, "surface.not_allowed", "Linking isn't open to this account yet");
      }
      return c.json(await confirmLink(linkDeps, user.id, id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/me/surface-links/{id}/nudge",
      tags,
      security,
      summary: "My unread nudge on the surface: on or off, its delay, its quiet hours",
      description:
        "ADR 0234. On an active link of mine. The nudge comes at most once a day, only when no phone of mine takes pushes and I wrote through the surface in the last 30 days.",
      request: { params: LinkParams, body: body(Nudge.partial()) },
      responses: {
        200: json(Nudge),
        401: errors[401],
        404: errorResponse("Not mine or not active (`surface.link_gone`), or off (`surface.off`)"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      requireSurface();
      return c.json(await setNudge(db, c.get("user").id, id, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/me/surface-links/{id}",
      tags,
      security,
      summary: "Cancel a pending link or unlink an active one",
      request: { params: LinkParams },
      responses: {
        ...noContent,
        401: errors[401],
        404: errorResponse("Not mine (`surface.link_gone`), or off (`surface.off`)"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      requireSurface();
      await removeLink(linkDeps, c.get("user").id, id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/me/surface-links/{id}/pin",
      tags,
      security,
      summary: "Choose my PIN for confirming actions from the outside chat surface",
      description:
        "The signed-in session is what lets it be chosen (ADR 0226): a page link from the chat alone never sets one. Replaces any PIN and clears its lock. 10 an account per 10 minutes.",
      request: { params: LinkParams, body: body(z.object({ pin: Pin })) },
      responses: {
        ...noContent,
        ...errors,
        404: errorResponse("Not my active link (`surface.link_gone`), or off (`surface.off`)"),
        429: errorResponse("Too many tries (`rate_limited`)"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const user = c.get("user");
      requireSurface();
      if (!(await adapters.rateLimiter.consume(`surface-pin-set:${user.id}`, PIN_SETS_PER_USER)).allowed) {
        return apiError(c, 429, "rate_limited", "Too many tries. Try again later.");
      }
      await setMySurfacePin(db, user.id, id, c.req.valid("json").pin);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/surface-undo",
      tags,
      summary: "“Not you? Unlink it”: end the outside chat surface link the email told about",
      description:
        'Public, from the undo page the "linked" email links to (`/email-undo?kind=surface&token=`), never from the link itself: mail scanners open links. Once, within 7 days: ends that link if it is still active (`unlinked` false when it already ended); `surface` and `display` name what the email told about. 404 `surface.undo_gone` once used or run out. 10 tries per 10 minutes per IP address (429 `rate_limited`).',
      request: { body: body(z.object({ token: z.string().min(16).max(200) })) },
      responses: {
        ...errors,
        200: json(z.object({ unlinked: z.boolean(), surface: z.string(), display: z.string().nullable() })),
        404: errorResponse("Used or run out (`surface.undo_gone`)"),
        429: errorResponse("Too many tries (`rate_limited`)"),
      },
    }),
    async (c) => {
      const ip = requestLimitIp(c.req.raw.headers, deps.config.TRUSTED_PROXIES);
      const limit = await adapters.rateLimiter.consume(`surface-undo:${ip}`, UNDO_PER_IP);
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      return c.json(await undoSurfaceLink(linkDeps, c.req.valid("json").token), 200);
    },
  );

  const resetByEmail = adapters.email.delivers === true;
  const shown = ({ pin: { emailVerified, ...pin }, ...view }: SurfacePageView) => ({
    ...view,
    pin: { ...pin, resetByEmail: resetByEmail && emailVerified },
  });
  /** Who this browser is signed in as in the app: with no PIN yet, only that person's session chooses one. */
  const signedIn = async (c: Context) => (await sessionUser(deps.auth, c.req.raw.headers))?.id ?? null;
  const pageLimited = async (c: Context, key: string, limit: { limit: number; windowMs: number }) => {
    const ip = requestLimitIp(c.req.raw.headers, deps.config.TRUSTED_PROXIES);
    return !(await adapters.rateLimiter.consume(`${key}:${ip}`, limit)).allowed;
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/surface-page/open",
      tags,
      summary: "Open a page the outside chat surface linked to",
      description:
        "Public (ADR 0226). The page posts its token: a chat app's link preview, which only GETs the page, opens nothing. The first open, within 10 minutes of the link, binds it to this browser with a cookie; then only that browser reopens it, for an hour (an agent's screen 30 minutes, control 15). It ends early when its surface link ends or the person can no longer see what it shows. 30 tries per 10 minutes per IP address.",
      request: { body: body(PageToken) },
      responses: {
        ...errors,
        200: json(SurfacePage),
        403: pageGone,
        404: pageGone,
        429: errorResponse("Too many tries (`rate_limited`)"),
      },
    }),
    async (c) => {
      if (await pageLimited(c, "surface-page", PAGE_PER_IP)) {
        return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      }
      const { token } = c.req.valid("json");
      const name = pageCookie(token);
      const opened = await openSurfacePage({ db }, token, getCookie(c, name) ?? null, await signedIn(c));
      if (opened.secret) {
        setCookie(c, name, opened.secret, {
          path: "/api/app/surface-page",
          httpOnly: true,
          secure: deps.config.PUBLIC_URL.startsWith("https://"),
          sameSite: "Strict",
          maxAge: Math.ceil((Date.parse(opened.view.expiresAt) - Date.now()) / 1000),
        });
      }
      return c.json(shown(opened.view), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/surface-page/decide",
      tags,
      summary: "Approve (with my PIN) or refuse the action the page shows",
      description:
        "Only from the browser that opened the page. Approving takes the six-digit PIN. With none set yet, it becomes the PIN only when this browser is signed in as the person; otherwise 409 `surface.pin_unset`, and the approval waits in the app. Three wrong PINs lock approving for 15 minutes, then an hour, then a day (`surface.pin_locked`, with `until`), and email the person. Who may decide is the app's rule.",
      request: {
        body: body(
          PageToken.extend({
            decision: z.enum(["approve", "refuse"]),
            pin: z.string().max(20).optional(),
          }),
        ),
      },
      responses: {
        ...errors,
        200: json(SurfacePage),
        403: errorResponse(
          "`surface.pin_wrong` (with `left`), `surface.page_elsewhere`, or not one who decides it (`forbidden`)",
        ),
        404: pageGone,
        409: errorResponse("No PIN set yet (`surface.pin_unset`), or already decided or expired (`conflict`)"),
        429: errorResponse("`surface.pin_locked` (with `until`) or `rate_limited`"),
      },
    }),
    async (c) => {
      if (await pageLimited(c, "surface-page", PAGE_PER_IP)) {
        return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      }
      const { token, decision, pin } = c.req.valid("json");
      const view = await decideOnSurfacePage(
        { db, pubsub: adapters.pubsub },
        token,
        getCookie(c, pageCookie(token)) ?? null,
        { decision, pin },
        await signedIn(c),
      );
      return c.json(shown(view), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/surface-page/pin-email",
      tags,
      summary: "Email me a link to choose my PIN (none set yet, or forgotten)",
      description:
        "Only from the browser that opened the page, on a server that sends email (else 404 `not_found`), to a verified address (else 403 `surface.email_unverified`). 3 emails an hour per IP address, and 3 an hour for the person.",
      request: { body: body(PageToken) },
      responses: {
        ...noContent,
        ...errors,
        403: errorResponse("`surface.email_unverified`, or opened in another browser (`surface.page_elsewhere`)"),
        404: pageGone,
        429: errorResponse("Too many emails (`rate_limited`)"),
      },
    }),
    async (c) => {
      if (!resetByEmail) return apiError(c, 404, "not_found", "This server sends no email");
      if (await pageLimited(c, "surface-pin-email", PIN_EMAILS_PER_IP)) {
        return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      }
      const { token } = c.req.valid("json");
      await emailPinLink({ db, publicUrl: deps.config.PUBLIC_URL }, token, getCookie(c, pageCookie(token)) ?? null);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/surface-pin",
      tags,
      summary: "Choose my PIN, from the emailed link",
      description:
        "Public, from the page the PIN email links to (`/email-undo?kind=surface-pin&token=`): the email to the verified address is what lets it be chosen. Once, within an hour; replaces any PIN and clears its lock. A PIN of the wrong shape (`surface.pin_shape`) spends nothing. 10 tries per 10 minutes per IP address.",
      request: { body: body(PageToken.extend({ pin: z.string().max(20) })) },
      responses: {
        ...errors,
        200: json(z.object({ surface: z.string() })),
        404: errorResponse("Used or run out (`surface.pin_reset_gone`)"),
        429: errorResponse("Too many tries (`rate_limited`)"),
      },
    }),
    async (c) => {
      if (await pageLimited(c, "surface-pin-reset", UNDO_PER_IP)) {
        return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      }
      const { token, pin } = c.req.valid("json");
      return c.json(await setPinFromEmail(db, token, pin), 200);
    },
  );

  return app;
}
