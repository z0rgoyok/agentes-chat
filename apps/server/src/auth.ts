import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, sign as signWithKey } from "node:crypto";
import type { HumanAction, HumanCheck, PubSub, RateLimiter } from "@agenteschat/adapters";
import { jwtClaims, nameIsPassword } from "@agenteschat/client/lib/text";
import type { Config } from "@agenteschat/config";
import { and, type Database, eq, ne, schema } from "@agenteschat/db";
import {
  accountBlock,
  addressHeld,
  announceProfile,
  askEmailChange,
  CODE_LIMITS,
  ConflictError,
  changeAsked,
  clearPassword,
  countUsers,
  deriveSecret,
  EARLY_ACCESS_HEADER,
  EARLY_ACCESS_TOKEN,
  earlyAccessLink,
  emailLocale,
  enqueueAccountContact,
  ForbiddenError,
  feedbackDestination,
  finishEmailChange,
  holdsInvitation,
  INVITATION_MAIL_HEADER,
  INVITATION_TOKEN_HEADER,
  isAgentesCloud,
  isFeedbackRelay,
  onUserCreated,
  queueEmail,
  recordSession,
  recordSignUp,
  requestLocale,
  revokeUserApps,
  type SignupPolicy,
  sendProofCode,
  sha256,
  signupAdmission,
  signupOpenToAll,
  spendDeletionCode,
  spendProofCode,
  TooManyError,
  UnauthorizedError,
  undoneSince,
  useEarlyAccess,
  ValidationError,
  type WorkspacePolicy,
} from "@agenteschat/engine";
import { expo } from "@better-auth/expo";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  formCsrfMiddleware,
  getOAuthState,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { deleteSessionCookie, expireCookie, parseCookies, setSessionCookie } from "better-auth/cookies";
import { multiSession } from "better-auth/plugins/multi-session";
import { z } from "zod";
import { listOf } from "./app-links";
import { desktopSignIn, FRESH_SIGN_IN_MS } from "./desktop-sign-in";
import { humanCheckRefusal } from "./http/human-check";
import { humanPassesFor } from "./http/human-pass";
import type { Logger } from "./logger";
import { ownerSignIn } from "./owner-claim";
import { phoneBrowserSignIn, phoneFlowStarted } from "./phone-browser-sign-in";

/**
 * Sign-in for people, built on Better Auth (ADR 0006):
 * Better Auth owns users, sessions, passwords and social sign-in; agentes.chat
 * owns organizations, memberships, roles and invitations
 * (`@agenteschat/engine` organizations). Agents are not users.
 * See docs/adr/0006-auth-and-tenancy.md.
 *
 * Mounted at `/api/auth/*`. The web app is served from the same origin, so
 * the session is an HttpOnly cookie — no tokens in the browser. The phone
 * app (ADR 0035) signs in through the Expo plugin: its scheme
 * `agenteschat://` is trusted, it keeps the cookie in the device's secure
 * store and sends it back in a `Cookie` header with `X-Agentes-Client: mobile`.
 * The Mac app's window loads the site itself and signs in like the web; for
 * Google and Apple it borrows the browser (`desktop-sign-in.ts`, ADR 0036).
 */
export function createAuth(deps: {
  db: Database;
  config: Config;
  log: Logger;
  emailDelivers?: boolean;
  /** Counts the reset and confirmation emails per address. */
  rateLimiter: RateLimiter;
  /** The bot check of the email forms (ADR 0075); absent: none. */
  humanCheck?: HumanCheck | null;
  /** Tells a person's workspaces their name changed. */
  pubsub?: PubSub;
}) {
  const { db, config, log, rateLimiter } = deps;
  const emailEnabled = deps.emailDelivers === true;
  // Better Auth answers the same whether an email went out, so a flood from many addresses only stops quietly.
  const emailAllowed = async (kind: "reset-email" | "verify-email", email: string) =>
    (await rateLimiter.consume(`${kind}:${sha256(email.toLowerCase())}`, EMAILS_PER_ADDRESS)).allowed;

  const policy = signupPolicy(config);
  // An invitation link never opens sign-up (ADR 0068): only an email invitation to that address, or an early-access
  // link sent to it (ADR 0078), does.
  const assertSignupAllowed = async (email: string, access: string | null) => {
    const admission = await signupAdmission(db, email, policy, { access });
    if (admission) {
      // An address an account just left stays held for it, so "This wasn't me" can put it back (`email-change.ts`).
      if (await addressHeld(db, email)) {
        throw new APIError("FORBIDDEN", { code: EMAIL_HELD, message: EMAIL_HELD_MESSAGE });
      }
      return admission;
    }
    if (policy.ownerByLink && (await countUsers(db)) === 0) {
      throw new APIError("FORBIDDEN", {
        code: OWNER_CLAIM_REQUIRED,
        message: "This server waits for its owner: open its owner link.",
      });
    }
    // Only whoever holds the link learns it is for another address, and never which one.
    const link = await earlyAccessLink(db, access);
    if (link && link.expiresAt > new Date() && link.email !== email.trim().toLowerCase()) {
      throw new APIError("FORBIDDEN", {
        code: EARLY_ACCESS_OTHER_EMAIL,
        message: "This invitation is for another address. Sign up with the address it was sent to.",
      });
    }
    throw new APIError("FORBIDDEN", {
      code: SIGNUP_CLOSED,
      message: "Sign-up is closed on this server. If you were invited, open the link in the invitation email.",
    });
  };

  const devOrigins = config.NODE_ENV === "development" ? ["http://localhost:5173"] : [];
  // The phone app (ADR 0035); Expo Go and dev builds use `exp://` outside production.
  const appOrigins = [APP_SCHEME, ...(config.NODE_ENV !== "production" ? ["exp://", "exp://**"] : [])];
  const apple = appleSignIn(config);
  const authorizations = socialAuthorizations(config, apple?.clientId ?? null);
  // A sign-in under way when "This wasn't me" ran read the account as it was: the session, sign-in method or password
  // it makes lands after the undo took every one back, and goes too.
  const undoneMeanwhile = async (userId: string) => {
    const startedAt = await signInStartedAt();
    return startedAt !== null && (await undoneSince(db, userId, startedAt));
  };

  return betterAuth({
    appName: "agentes.chat",
    baseURL: config.PUBLIC_URL,
    basePath: "/api/auth",
    // Over HTTP each would tell any session whether a password is right, with none of the limit `deletionProof` keeps:
    // a stolen session could guess the account's password there, then sign in with it anywhere, or delete with it on
    // a server that sends no email. No app calls them, `deletionProof` calls `verifyPassword` in this process (which
    // this leaves open), and a forgotten password is reset by email. A new address goes only through
    // `changeAccountEmail`, which takes a code or a fresh sign-in first and calls `/change-email` in this process.
    // The multi-session paths take and answer session tokens, and no token reaches the browser: the apps go through
    // `/api/app/device-accounts`, which names accounts by person and calls these in this process (ADR 0183).
    disabledPaths: [
      "/verify-password",
      "/change-password",
      "/change-email",
      "/multi-session/list-device-sessions",
      "/multi-session/set-active",
      "/multi-session/revoke",
      KEEP_DEVICE_SESSIONS,
      LEAVE_DEVICE_SESSION,
    ],
    // Derived from AGENTES_SECRET so self-hosters manage a single secret.
    secret: deriveSecret(config.AGENTES_SECRET, "sessions"),
    // Apple posts the sign-in result back from its own origin (`response_mode=form_post`).
    trustedOrigins: [config.PUBLIC_URL, ...devOrigins, ...appOrigins, ...(apple ? [APPLE_ORIGIN] : [])],
    plugins: [
      expo(),
      // Several accounts signed in on one browser (ADR 0183): every sign-in also leaves a cookie of its own, so the
      // one before it stays signed in and the browser moves between them.
      multiSession({ maximumSessions: MAX_DEVICE_ACCOUNTS }),
      deviceAccounts,
      phoneSignIn,
      phoneBrowserSignIn(),
      desktopSignIn(),
      ownerSignIn({ db, config, log, mint: (adapter, userId) => mintSignIn(adapter, `${FOR_USER}${userId}`) }),
    ],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    user: {
      additionalFields: { locale: { type: "string", required: false, input: false } },
      // The same account under a new address (Sua conta › Perfil), only through `changeAccountEmail`: a link to the new
      // one confirms it, and a server that sends no e-mail can't, so the address changes at once there.
      changeEmail: { enabled: true, updateEmailWithoutVerification: !emailEnabled },
    },
    session: {
      additionalFields: { activeOrganizationId: { type: "string", required: false, input: false } },
      // No signed cookie cache: every request reads its session from the database (once, `sessionOf`), so a session
      // that ends (signing out, a new password, "This wasn't me", a block) stops working at once everywhere.
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      // The reset email says the link works for an hour.
      resetPasswordTokenExpiresIn: 60 * 60,
      // Only when a real email sender is configured (MillionSend or SMTP); sent through the outbox.
      ...(emailEnabled
        ? {
            sendResetPassword: async (
              {
                user,
                token,
              }: {
                user: { email: string; locale?: string | null };
                url: string;
                token: string;
              },
              request?: Request,
            ) => {
              if (!(await emailAllowed("reset-email", user.email))) return;
              // Straight to our page (not Better Auth's redirect): the same link opens the phone app when it is
              // installed (universal link / App Link, app-links.ts) and the website otherwise; both reset with it.
              const url = `${config.PUBLIC_URL.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
              // An account with no language yet (made by the owner link, or before sign-up kept one): the request's.
              const locale = emailLocale(user.locale ?? requestLocale(request?.headers.get("accept-language")));
              await queueEmail(db, {
                orgId: null,
                key: `password-reset:${sha256(token)}`,
                to: [user.email],
                template: { kind: "password_reset", locale, url },
              });
            },
          }
        : {}),
      onPasswordReset: async ({ user }: { user: { id: string } }) => {
        // Its link read before "This wasn't me" dropped it, the new password landed after the undo cleared the old one.
        if (await undoneMeanwhile(user.id)) {
          await clearPassword(db, user.id);
          throw new APIError("UNAUTHORIZED", SIGN_IN_UNDONE);
        }
        // An emailed link reached the mailbox, as a confirmation link would, and the password nobody proved is gone
        // with every session: the address counts as confirmed, so a provider can join the account (ADR 0006). A link
        // an owner made on a server without email proves nothing about the mailbox (ADR 0158).
        if (emailEnabled) {
          await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, user.id));
        }
        // A new password cuts off every AI app and personal token the old one let in (ADR 0119).
        await revokeUserApps(db, user.id);
      },
    },
    ...(emailEnabled
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            // The onboarding says the link works for an hour (`onboarding.confirmation.sent`).
            expiresIn: 60 * 60,
            sendVerificationEmail: async (
              {
                user,
                url,
                token,
              }: {
                user: { id: string; email: string; locale?: string | null };
                url: string;
                token: string;
              },
              request?: Request,
            ) => {
              // Signing up from an email invitation's page opened from its email (`x-invitation-token` and the proof
              // only the message carries, `x-invitation-mail`): accepting it confirms the address (ADR 0090), so no
              // "confirm your email" follows. From a copied link, another address's invitation, or asked for later, it
              // goes as always.
              const signingUp = request ? new URL(request.url).pathname.endsWith("/sign-up/email") : false;
              const invitation = request?.headers.get(INVITATION_TOKEN_HEADER);
              const mail = { secret: config.AGENTES_SECRET, proof: request?.headers.get(INVITATION_MAIL_HEADER) };
              if (signingUp && invitation && (await holdsInvitation(db, user.email, invitation, mail))) return;
              if (!(await emailAllowed("verify-email", user.email))) return;
              const locale = emailLocale(user.locale ?? requestLocale(request?.headers.get("accept-language")));
              // A new address (`changeAccountEmail`): the account still has its old one until this link is opened.
              const [stored] = await db
                .select({ email: schema.users.email })
                .from(schema.users)
                .where(eq(schema.users.id, user.id));
              const change = stored !== undefined && stored.email !== user.email.toLowerCase();
              await queueEmail(db, {
                orgId: null,
                key: `verify-email:${sha256(token)}`,
                to: [user.email],
                template: change
                  ? { kind: "email_change_link", locale, url: confirmationLanding(url) }
                  : { kind: "verify_email", locale, url: confirmationLanding(url) },
              });
            },
          },
        }
      : {}),
    socialProviders: {
      ...(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: config.GOOGLE_CLIENT_ID,
              clientSecret: config.GOOGLE_CLIENT_SECRET,
              mapProfileToUser: noteProviderEmail,
            },
          }
        : {}),
      ...(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: config.GITHUB_CLIENT_ID,
              clientSecret: config.GITHUB_CLIENT_SECRET,
              mapProfileToUser: noteProviderEmail,
            },
          }
        : {}),
      ...(apple ? { apple: { ...apple, mapProfileToUser: noteProviderEmail } } : {}),
    },
    rateLimit: {
      enabled: config.NODE_ENV !== "test",
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 15 * 60, max: 10 },
        "/request-password-reset": { window: 15 * 60, max: 3 },
        // The app opens one hand-over request per sign-in; keep it cheap for an unauthenticated caller.
        "/desktop/open": { window: 60, max: 10 },
        "/desktop/request": { window: 60, max: 30 },
        // The app's window asks every 2 s while the browser signs in.
        "/desktop/redeem": { window: 60, max: 40 },
        "/desktop/handoff": { window: 60, max: 10 },
        // The phone app trades once per sign-in through the browser.
        "/phone/redeem": { window: 60, max: 10 },
        "/owner-claim": { window: 60, max: 10 },
        "/owner-key": { window: 60, max: 10 },
      },
    },
    advanced: {
      ipAddress: { trustedProxies: config.TRUSTED_PROXIES },
    },
    // Better Auth answers what its endpoints throw with a 500 of its own, so the app's onError never sees it: this
    // is that error's log line, and its report (ADR 0104). Its refusals (below 500) stay quiet, as before.
    onAPIError: {
      // A sign-in that failed (a provider's refusal, an expired state) lands on our sign-in page, which says why:
      // never Better Auth's own page (it shows outside production, where native installs set NODE_ENV too late),
      // nor production's silent `/?error=`.
      errorURL: signInPageUrl(config.PUBLIC_URL),
      onError: (error) => {
        if (!isAPIError(error) || error.statusCode >= 500) log.error("auth request failed", { error });
      },
    },
    hooks: {
      // Checked before the endpoint runs so the person sees the real reason.
      // The database hook below also guards social sign-in.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === EXPO_PROXY_PATH) {
          const target =
            (ctx.query as { authorizationURL?: unknown } | undefined)?.authorizationURL ??
            (ctx.request ? new URL(ctx.request.url).searchParams.get("authorizationURL") : undefined);
          if (
            !expoProxyAllowed(target, authorizations, ctx.context.baseURL) ||
            !(await phoneFlowStarted(ctx.context, target))
          ) {
            throw new APIError("BAD_REQUEST", { message: "Invalid authorizationURL" });
          }
        }
        if (ctx.path === "/verify-email") {
          // Better Auth's link to a new address is a token signed for an hour that names both addresses and works while
          // the account has the old one: after "This wasn't me" puts it back, or after a newer ask, it would move the
          // account again, telling nobody. Only the change its account asked last goes on (`changeAsked`). Read
          // unchecked: this only refuses, and Better Auth checks the signature next.
          const claims = jwtClaims(String((ctx.query as { token?: unknown } | undefined)?.token ?? ""));
          if (
            claims?.updateTo !== undefined &&
            !(await changeAsked(
              db,
              typeof claims.email === "string" ? claims.email : "",
              typeof claims.updateTo === "string" ? claims.updateTo : "",
            ))
          ) {
            // Where a link that no longer works lands: never the link's own callbackURL, which nothing checked yet.
            throw ctx.redirect(`${CONFIRMATION_LANDING}&error=INVALID_TOKEN`);
          }
        }
        const action = HUMAN_ACTIONS[ctx.path];
        // Before the sign-up policy: a bot gets the cheap refusal first.
        if (action && ctx.headers) {
          // The lookup of this address passed the check a moment ago: its pass stands for this step's (ADR 0075).
          const address = (ctx.body as { email?: unknown } | undefined)?.email;
          const refused = await humanCheckRefusal(
            deps.humanCheck,
            ctx.headers,
            action,
            config.TRUSTED_PROXIES,
            typeof address === "string"
              ? { passes: humanPassesFor(deriveSecret(config.AGENTES_SECRET, "human-pass")), email: address }
              : undefined,
          );
          if (refused) throw new APIError("FORBIDDEN", refused);
        }
        if (ctx.path !== "/sign-up/email") return;
        const { email, name, password } = (ctx.body ?? {}) as { email?: unknown; name?: unknown; password?: unknown };
        if (typeof name === "string" && typeof password === "string" && nameIsPassword(name, password)) {
          throw new APIError("BAD_REQUEST", { code: NAME_IS_PASSWORD, message: NAME_IS_PASSWORD_MESSAGE });
        }
        if (typeof email !== "string") return;
        await assertSignupAllowed(email, await accessOf(ctx));
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Social sign-up too (the phone's Apple sign-in from an invitation).
          before: async (user, context) => {
            const admission = await assertSignupAllowed(user.email, await accessOf(context));
            // An early-access link opens sign-up for one address: a provider must vouch for it.
            if (admission === "early_access" && isSocial(context) && user.emailVerified !== true) {
              throw new APIError("FORBIDDEN", {
                code: EARLY_ACCESS_EMAIL_UNVERIFIED,
                message:
                  "Your sign-in provider hasn't confirmed this address. Confirm it there, or sign up with a password.",
              });
            }
            // The sign-up's own language from the start: the confirmation email goes out before any other choice.
            const locale = requestLocale(context?.headers?.get("accept-language"));
            return { data: { ...user, email: user.email.toLowerCase(), ...(locale ? { locale } : {}) } };
          },
          // After the account is committed: a failure is logged and never fails the sign-up.
          after: async (user, context) => {
            try {
              await onUserCreated(db, user.id);
            } catch (error) {
              log.error("post-signup setup failed", { userId: user.id, error });
            }
            await enqueueAccountContact(db, user.id).catch((error) =>
              log.error("account contact not queued", { userId: user.id, error }),
            );
            const access = await accessOf(context);
            if (access && (!isSocial(context) || user.emailVerified === true)) {
              await useEarlyAccess(db, { access, email: user.email, userId: user.id }).catch((error) =>
                log.error("early access not recorded", { userId: user.id, error }),
              );
            }
          },
        },
        update: {
          // Their name (`/update-user`, from the web or the phone): open apps show the new one at once. A new address
          // (its link opened): the one it left is told, with "This wasn't me".
          after: async (user) => {
            await announceProfile(db, deps.pubsub, user.id).catch((error) =>
              log.error("profile change not announced", { userId: user.id, error }),
            );
            const locale = typeof user.locale === "string" ? user.locale : null;
            await finishEmailChange(
              { db, publicUrl: config.PUBLIC_URL },
              { id: user.id, email: user.email, locale },
            ).catch((error) => log.error("email change notice not queued", { userId: user.id, error }));
          },
        },
      },
      // After the sign-in has committed: the operator API's events feed (ADR 0056), whose failure is logged and never
      // fails the sign-in, and a sign-in "This wasn't me" overtook (`undoneMeanwhile`), which fails.
      account: {
        create: {
          // A provider joined (a provider's return from a sign-in begun before the undo included) or a password added.
          after: async (account) => {
            if (await undoneMeanwhile(account.userId)) {
              await db.delete(schema.accounts).where(eq(schema.accounts.id, account.id));
              throw new APIError("UNAUTHORIZED", SIGN_IN_UNDONE);
            }
            await recordSignUp(db, account).catch((error) =>
              log.error("operator event failed", { type: "user.signed_up", error }),
            );
          },
        },
      },
      session: {
        create: {
          // A blocked account (ADR 0056 §9) gets no session, whatever the sign-in method. The code also
          // makes a social sign-in's callback send the person back to the sign-in page. On agentes.chat Cloud the
          // body adds the block's kind, never its reason.
          before: async (session) => {
            const block = await accountBlock(db, session.userId);
            if (block) {
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_BLOCKED",
                message: "This account can't sign in.",
                ...block,
              });
            }
          },
          // Here, not in `before`: the insert may wait for the undo's commit, and only after it can it see the undo.
          after: async (session) => {
            if (await undoneMeanwhile(session.userId)) {
              await db.delete(schema.sessions).where(eq(schema.sessions.id, session.id));
              throw new APIError("UNAUTHORIZED", SIGN_IN_UNDONE);
            }
            await recordSession(db, session).catch((error) =>
              log.error("operator event failed", { type: "session.created", error }),
            );
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * This request to Better Auth (`authHandler`): when it began, and the address a provider gave its sign-in
 * (`noteProviderEmail`).
 */
const authRequest = new AsyncLocalStorage<{ startedAt: number; email?: string }>();

/** Every provider's `mapProfileToUser`: notes the address, changes nothing. */
function noteProviderEmail(profile: { email?: unknown }) {
  const seen = authRequest.getStore();
  if (seen && typeof profile.email === "string") seen.email = profile.email;
  return {};
}

/** How long Better Auth's state for a provider's sign-in lasts from its start (`generateState`). */
const OAUTH_STATE_MS = 600_000;

/**
 * When this request's sign-in began: the request, or for a provider's return, the sign-in it finishes (a link to the
 * account names it in its state, and needs no session on its return). Null outside a request (`auth.api` in-process).
 */
async function signInStartedAt(): Promise<number | null> {
  const startedAt = authRequest.getStore()?.startedAt;
  if (startedAt === undefined) return null;
  const flow = await getOAuthState().catch(() => null);
  return typeof flow?.expiresAt === "number" ? Math.min(startedAt, flow.expiresAt - OAUTH_STATE_MS) : startedAt;
}

/**
 * Better Auth's handler. Better Auth refuses a provider sign-in to an existing account as `ACCOUNT_NOT_LINKED` when
 * that account's address isn't confirmed, and also when the provider hasn't confirmed its own. The first comes back to
 * the sign-in page with the provider's address, so the page can offer that account a new password by email; the
 * second as `PROVIDER_EMAIL_UNVERIFIED`, since a new password changes nothing there.
 */
export function authHandler(auth: Auth, db: Database) {
  return (request: Request) => {
    const seen: { startedAt: number; email?: string } = { startedAt: Date.now() };
    return authRequest.run(seen, async () => {
      const res = await auth.handler(request);
      const location = res.headers.get("location");
      if (!seen.email || !location) return res;
      const back = new URL(location, "http://localhost");
      if (back.searchParams.get("error") !== ACCOUNT_NOT_LINKED) return res;
      const [account] = await db
        .select({ emailVerified: schema.users.emailVerified })
        .from(schema.users)
        .where(eq(schema.users.email, seen.email.toLowerCase()));
      if (account && !account.emailVerified) back.searchParams.set("email", seen.email);
      else back.searchParams.set("error", PROVIDER_EMAIL_UNVERIFIED);
      const headers = new Headers(res.headers);
      headers.set("location", location.startsWith("/") ? `${back.pathname}${back.search}${back.hash}` : back.href);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    });
  };
}

export type SessionUser = { id: string; name: string; email: string; image?: string | null };

/** The web app's sign-in page (`/login`), with `query` (`error`, `redirect`) when given. */
export function signInPageUrl(publicUrl: string, query?: Record<string, string>) {
  const page = `${publicUrl.replace(/\/$/, "")}/login`;
  return query ? `${page}?${new URLSearchParams(query)}` : page;
}

/** Accounts a sign-in keeps beside it in one browser (ADR 0183): past these, the plugin adds no cookie by itself. */
export const MAX_DEVICE_ACCOUNTS = 5;
const KEEP_DEVICE_SESSIONS = "/device-accounts/keep";
const LEAVE_DEVICE_SESSION = "/device-accounts/leave";

/** The cookie the multi-session plugin keeps a session under, beside the browser's own session cookie. */
const deviceCookieName = (sessionCookie: string, token: string) => `${sessionCookie}_multi-${token.toLowerCase()}`;

/**
 * What the multi-session plugin leaves open, for the accounts a browser holds (ADR 0183). Only in this process: both
 * paths are off over HTTP, and they take session tokens, which never leave the server.
 */
const deviceAccounts = {
  id: "device-accounts",
  endpoints: {
    /**
     * Every session the browser holds gets its cookie again: the one in use that has none yet (signed in before a
     * browser kept several, or past the plugin's count) and the others, whose cookies the plugin sets once and never
     * renews. A session not in use is never read as the request's own, so it is extended here, as Better Auth
     * extends the one in use.
     */
    keepDeviceSessions: createAuthEndpoint(
      KEEP_DEVICE_SESSIONS,
      { method: "POST", requireHeaders: true },
      async (ctx) => {
        const cookie = ctx.context.authCookies.sessionToken;
        const tokens = new Set<string>();
        for (const name of parseCookies(ctx.headers?.get("cookie") ?? "").keys()) {
          if (!name.includes("_multi-")) continue;
          const token = await ctx.getSignedCookie(name, ctx.context.secret);
          if (typeof token === "string" && token) tokens.add(token);
        }
        const current = await getSessionFromCtx(ctx);
        if (current) tokens.add(current.session.token);
        if (tokens.size === 0) return ctx.json({ status: true });
        const now = Date.now();
        const { expiresIn, updateAge } = ctx.context.sessionConfig;
        const held = await ctx.context.internalAdapter.findSessions([...tokens], { onlyActiveSessions: true });
        for (const { session } of held) {
          const expiresAt = new Date(session.expiresAt).getTime();
          if (expiresAt <= now) continue;
          if (session.token !== current?.session.token && expiresAt - now < (expiresIn - updateAge) * 1000) {
            await ctx.context.internalAdapter.updateSession(session.token, {
              expiresAt: new Date(now + expiresIn * 1000),
            });
          }
          await ctx.setSignedCookie(
            deviceCookieName(cookie.name, session.token),
            session.token,
            ctx.context.secret,
            cookie.attributes,
          );
        }
        return ctx.json({ status: true });
      },
    ),
    /**
     * One session the browser holds ends, and only that one (Better Auth's own sign-out ends them all). When it was
     * the one in use, the browser moves to `nextToken`'s, or to none.
     */
    leaveDeviceSession: createAuthEndpoint(
      LEAVE_DEVICE_SESSION,
      {
        method: "POST",
        requireHeaders: true,
        body: z.object({ sessionToken: z.string(), nextToken: z.string().optional() }),
      },
      async (ctx) => {
        const cookie = ctx.context.authCookies.sessionToken;
        const current = await getSessionFromCtx(ctx);
        const holds = async (token: string) =>
          current?.session.token === token ||
          (await ctx.getSignedCookie(deviceCookieName(cookie.name, token), ctx.context.secret)) === token;
        const { sessionToken, nextToken } = ctx.body;
        if (!(await holds(sessionToken))) throw new APIError("UNAUTHORIZED");
        await ctx.context.internalAdapter.deleteSession(sessionToken);
        expireCookie(ctx, { name: deviceCookieName(cookie.name, sessionToken), attributes: cookie.attributes });
        if (current?.session.token !== sessionToken) return ctx.json({ signedIn: Boolean(current) });
        const next =
          nextToken && (await holds(nextToken)) ? await ctx.context.internalAdapter.findSession(nextToken) : null;
        if (next && new Date(next.session.expiresAt).getTime() > Date.now()) {
          await setSessionCookie(ctx, next);
          return ctx.json({ signedIn: true });
        }
        deleteSessionCookie(ctx);
        return ctx.json({ signedIn: false });
      },
    ),
  },
} satisfies BetterAuthPlugin;

/** A person signed in on this browser, and whether the request is theirs. */
export interface DeviceAccount {
  user: SessionUser;
  current: boolean;
  /** Stays in this process: accounts are named by person outside it. */
  token: string;
}

/**
 * The accounts signed in on the browser that sent `headers` (ADR 0183), the request's own first, the others by
 * address. `cookies`: every one's cookie again (`keepDeviceSessions`), to send back with the answer.
 */
export async function deviceAccountsOf(
  auth: Auth,
  headers: Headers,
): Promise<{ accounts: DeviceAccount[]; cookies: string[] }> {
  const [current, kept, renewed] = await Promise.all([
    sessionOf(auth, headers),
    auth.api.listDeviceSessions({ headers }),
    auth.api.keepDeviceSessions({ headers, returnHeaders: true }),
  ]);
  const cookies = renewed.headers.getSetCookie();
  const others = kept
    .filter((k) => k.user.id !== current?.user.id)
    .map((k) => ({ user: k.user as SessionUser, current: false, token: k.session.token }))
    .sort((a, b) => a.user.email.localeCompare(b.user.email));
  if (!current) return { accounts: others, cookies };
  return {
    accounts: [{ user: current.user as SessionUser, current: true, token: current.session.token }, ...others],
    cookies,
  };
}

/**
 * Makes `userId`'s session the browser's (ADR 0183): the cookies to send back, or null when that person isn't signed
 * in on it (their session ended meanwhile). The account it leaves keeps its own cookie, so it stays one switch away.
 */
export async function switchDeviceAccount(auth: Auth, headers: Headers, userId: string): Promise<string[] | null> {
  const { accounts, cookies } = await deviceAccountsOf(auth, headers);
  const target = accounts.find((a) => a.user.id === userId);
  if (!target) return null;
  if (target.current) return cookies;
  const moved = await auth.api
    .setActiveSession({ headers, body: { sessionToken: target.token }, returnHeaders: true })
    .catch(() => null);
  return moved ? [...cookies, ...moved.headers.getSetCookie()] : null;
}

/**
 * Signs one account out of the browser (ADR 0183), the request's own by default: its session ends and the others stay.
 * When it was the request's own, the browser moves to the next one still signed in (`signedIn`), else to none.
 */
export async function signOutDeviceAccount(
  auth: Auth,
  headers: Headers,
  userId?: string,
): Promise<{ cookies: string[]; signedIn: boolean } | null> {
  const { accounts, cookies } = await deviceAccountsOf(auth, headers);
  const target = userId ? accounts.find((a) => a.user.id === userId) : accounts.find((a) => a.current);
  if (!target) return null;
  const next = target.current ? accounts.find((a) => !a.current) : undefined;
  const left = await auth.api.leaveDeviceSession({
    headers,
    body: { sessionToken: target.token, ...(next ? { nextToken: next.token } : {}) },
    returnHeaders: true,
  });
  // The leaving account's cookie was renewed a moment before: its removal comes after, so it wins.
  return { cookies: [...cookies, ...left.headers.getSetCookie()], signedIn: left.response.signedIn };
}

const sessionReads = new WeakMap<Headers, ReturnType<Auth["api"]["getSession"]>>();

/**
 * The session of the request whose `headers` these are, read from the database once for the whole request: its
 * middleware and route share the read. Only a request's own `headers`, never a set kept across requests.
 */
export function sessionOf(auth: Auth, headers: Headers) {
  let read = sessionReads.get(headers);
  if (!read) {
    read = auth.api.getSession({ headers });
    sessionReads.set(headers, read);
  }
  return read;
}

/** Resolves the signed-in person from request headers (cookie), or null. Used by HTTP and WebSocket. */
export async function sessionUser(auth: Auth, headers: Headers): Promise<SessionUser | null> {
  const session = await sessionOf(auth, headers);
  return session ? (session.user as SessionUser) : null;
}

/**
 * Whether this request's session, as `userId`, signed in within `FRESH_SIGN_IN_MS`, as adding a password requires. A
 * session minted from another keeps that one's sign-in time.
 */
export async function signedInLately(auth: Auth, headers: Headers, userId: string) {
  const current = await sessionOf(auth, headers);
  if (current?.user.id !== userId) return false;
  return Date.now() - new Date(current.session.createdAt).getTime() < FRESH_SIGN_IN_MS;
}

/** Links to a new address an account may ask for, after its proof, in an hour and in a day. */
const EMAIL_LINKS = [
  ["hour", CODE_LIMITS.hour, 3_600_000],
  ["day", CODE_LIMITS.day, 86_400_000],
] as const;

/**
 * A new address for the signed-in account `userId` (Sua conta › E-mail; ADR 0088 §2, addendum 2026-11-13): the only way
 * to one, since `/change-email` is off over HTTP. Refused for the address it has (`email.same`) and one another account
 * just left (`email.held`). On a server that sends email, it takes the code emailed to the account's current address
 * (`code`, bound to `newEmail`) or a sign-in in the last 10 minutes: without either it emails that code and answers
 * `code`, or `reauth.sign_in` for an address the account never confirmed. Then Better Auth's link goes to the new
 * address, which changes once it is opened (`sent`), and the old one is told then (`finishEmailChange`) when the
 * account had confirmed it or typed its code. On a server that sends none, Better Auth changes it at once, as before
 * (`changed`): an unconfirmed address only (`email.no_mail` for a confirmed one), and `email.taken` when another account
 * has it.
 */
export async function changeAccountEmail(
  auth: Auth,
  deps: {
    db: Database;
    rateLimiter: RateLimiter;
    emailDelivers: boolean;
    emails: { publicUrl: string; support?: string | null };
  },
  headers: Headers,
  userId: string,
  input: { newEmail: string; code?: string },
): Promise<{ status: "changed" | "sent"; email: string } | { status: "code"; email: string; resendIn: number }> {
  const { db } = deps;
  const newEmail = input.newEmail.trim().toLowerCase();
  const current = async () =>
    (
      await db
        .select({ email: schema.users.email, verified: schema.users.emailVerified })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
    )[0];
  const account = await current();
  if (!account) throw new UnauthorizedError();
  const from = account.email;
  if (from === newEmail) throw new ValidationError("That's already your email", "email.same");
  if (await addressHeld(db, newEmail, { except: userId })) {
    throw new ConflictError("This address left another account a moment ago", "email.held");
  }
  const noMail = () => new ConflictError("This server sends no email to confirm the new address", "email.no_mail");
  const change = () =>
    auth.api.changeEmail({ body: { newEmail, callbackURL: "/" }, headers }).catch((error: unknown) => {
      if (!isAPIError(error)) throw error;
      if (error.statusCode === 401) throw new UnauthorizedError();
      if (/verification email isn't enabled|change email is disabled/i.test(error.message)) throw noMail();
      if (/email is the same/i.test(error.message))
        throw new ValidationError("That's already your email", "email.same");
      throw error;
    });
  if (!deps.emailDelivers) {
    // Better Auth changes only an unconfirmed address at once: a confirmed one waits for a link that can't go.
    if (account.verified) throw noMail();
    await change();
    // Better Auth answers the same when the address is another account's: only the account says whether it changed.
    if ((await current())?.email !== newEmail)
      throw new ConflictError("Another account has this address", "email.taken");
    return { status: "changed", email: newEmail };
  }
  if (input.code) await spendProofCode({ db }, userId, "email", input.code, newEmail);
  else if (!(await signedInLately(auth, headers, userId))) {
    // Nobody proved that mailbox is the account's: a code there would tell whoever holds it the new address.
    if (!account.verified) throw new ForbiddenError("Sign in again to change your email", "reauth.sign_in");
    const sent = await sendProofCode(deps, userId, "email", {
      bound: newEmail,
      template: (code, account) => ({
        kind: "email_change_code",
        locale: account.locale,
        code,
        email: account.email,
        newEmail,
        support: deps.emails.support ?? null,
        url: deps.emails.publicUrl.replace(/\/$/, ""),
      }),
    });
    return { status: "code", ...sent };
  }
  for (const [span, limit, windowMs] of EMAIL_LINKS) {
    if (!(await deps.rateLimiter.consume(`email-link:${span}:${userId}`, { limit, windowMs })).allowed) {
      throw new TooManyError("Too many new addresses. Try again later.");
    }
  }
  // A code typed just now proves the old mailbox (`spendProofCode` throws otherwise), a fresh sign-in doesn't: an
  // address never confirmed gets no "This wasn't me", which would hand whoever holds it the account.
  await askEmailChange(db, { userId, from, to: newEmail, proven: account.verified || Boolean(input.code) });
  await change();
  return { status: "sent", email: newEmail };
}

/** Passwords an account may try in 15 minutes to prove it's them. */
const PROOF_TRIES = { limit: 5, windowMs: 15 * 60_000 };

/**
 * Proof that the person at this session is the account's own, before deleting the workspace `orgId`, or their account
 * when it is null (ADR 0088 §2): the code emailed to them (`spendDeletionCode`). On a server that sends no email, their
 * password instead, with 5 tries per 15 minutes per account (429 after). Throws `reauth.code` without a code, and
 * `reauth.password` without a password or with a wrong one.
 */
export async function deletionProof(
  auth: Auth,
  deps: { db: Database; rateLimiter: RateLimiter; emailDelivers: boolean },
  headers: Headers,
  userId: string,
  orgId: string | null,
  proof: { code?: string; password?: string },
) {
  if (deps.emailDelivers) {
    if (!proof.code) throw new ForbiddenError("Type the code we emailed you", "reauth.code");
    return spendDeletionCode(deps, userId, orgId, proof.code);
  }
  const { password } = proof;
  if (!password) throw new ForbiddenError("Give your password to confirm it's you", "reauth.password");
  // Counted before the check: a guess past the limit learns nothing.
  if (!(await deps.rateLimiter.consume(`deletion-proof:${userId}`, PROOF_TRIES)).allowed) {
    throw new TooManyError("Too many tries. Try again in a few minutes.");
  }
  const right = await auth.api.verifyPassword({ body: { password }, headers }).then(
    () => true,
    () => false,
  );
  if (!right) throw new ForbiddenError("That password isn't right", "reauth.password");
}

/**
 * The Expo plugin's `/expo-authorization-proxy` (the phone app's social sign-in, ADR 0035) redirects to any
 * https address and signs that address's `state` into the visitor's state cookie: an open redirect, and a way
 * to move someone else's sign-in into the visitor's browser. It only goes on to a configured provider's own
 * authorization endpoint, for our client id and our callback, so the provider sends the person nowhere but back
 * here (`expoProxyAllowed`), and only with the state of a sign-in a phone app started, which leaves no session in
 * the browser (`phoneFlowStarted`, phone-browser-sign-in.ts).
 */
const EXPO_PROXY_PATH = "/expo-authorization-proxy";

export interface SocialAuthorization {
  id: string;
  /** Better Auth's authorization endpoint for the provider (origin + path). */
  endpoint: string;
  clientId: string;
}

function socialAuthorizations(config: Config, appleClientId: string | null): SocialAuthorization[] {
  const list: SocialAuthorization[] = [];
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    const endpoint = "https://accounts.google.com/o/oauth2/v2/auth";
    list.push({ id: "google", endpoint, clientId: config.GOOGLE_CLIENT_ID });
  }
  if (config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET) {
    const endpoint = "https://github.com/login/oauth/authorize";
    list.push({ id: "github", endpoint, clientId: config.GITHUB_CLIENT_ID });
  }
  if (appleClientId) {
    list.push({ id: "apple", endpoint: "https://appleid.apple.com/auth/authorize", clientId: appleClientId });
  }
  return list;
}

/** Whether the proxy may go on to `target` (`EXPO_PROXY_PATH`). `authBaseURL`: Better Auth's, with its path. */
export function expoProxyAllowed(
  target: unknown,
  allowed: SocialAuthorization[],
  authBaseURL: string,
): target is string {
  if (typeof target !== "string" || target.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const one = (name: string) => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 ? values[0] : null;
  };
  const endpoint = `${url.origin}${url.pathname}`;
  const base = authBaseURL.replace(/\/$/, "");
  return allowed.some(
    (p) =>
      p.endpoint === endpoint && one("client_id") === p.clientId && one("redirect_uri") === `${base}/callback/${p.id}`,
  );
}

/** Better Auth's paths that a bot check guards (ADR 0075), with the action their widget runs. */
const HUMAN_ACTIONS: Record<string, HumanAction> = {
  "/sign-in/email": "sign-in",
  "/sign-up/email": "sign-up",
  "/request-password-reset": "password-reset",
};

/** Reset and confirmation emails to one address in an hour. */
const EMAILS_PER_ADDRESS = { limit: 3, windowMs: 3600_000 };

/**
 * `APIError` code of a sign-up with an address an account just left, held for it while its "This wasn't me" works
 * (mirrored in packages/client errors.ts).
 */
export const EMAIL_HELD = "EMAIL_HELD";
const EMAIL_HELD_MESSAGE = "This address just left an account here, and stays its own for 7 days.";
/** A sign-up whose name is its password: the name step got the password (mirrored in packages/client errors.ts). */
export const NAME_IS_PASSWORD = "NAME_IS_PASSWORD";
export const NAME_IS_PASSWORD_MESSAGE = "Is this your name? It's the same as the password you typed.";
/** `APIError` code of a sign-up refused because the first account waits for its owner's link or key. */
export const OWNER_CLAIM_REQUIRED = "OWNER_CLAIM_REQUIRED";
/**
 * `APIError` code of a sign-up refused because sign-up is closed, the same for an address invited to early access
 * that came without its link. A provider's callback sends a refusal to `/login?error=` only when it has a code.
 */
export const SIGNUP_CLOSED = "SIGNUP_CLOSED";
/** An early-access link used to sign up another address than the one it was sent to (ADR 0078). */
export const EARLY_ACCESS_OTHER_EMAIL = "EARLY_ACCESS_OTHER_EMAIL";
/** An early-access sign-up through a provider that hasn't confirmed the address (ADR 0078). */
export const EARLY_ACCESS_EMAIL_UNVERIFIED = "EARLY_ACCESS_EMAIL_UNVERIFIED";
/**
 * Better Auth's refusal of a provider sign-in to an address whose password account isn't confirmed yet: it links
 * none, since whoever made that account may not own the address (mirrored in packages/client errors.ts).
 */
export const ACCOUNT_NOT_LINKED = "account_not_linked";
/**
 * Ours for Better Auth's `ACCOUNT_NOT_LINKED` when the account here is confirmed: the provider hasn't confirmed its own
 * address, so it joins no account (`authHandler`, mirrored in packages/client errors.ts).
 */
export const PROVIDER_EMAIL_UNVERIFIED = "provider_email_unverified";
/** A sign-in "This wasn't me" overtook (`undoneMeanwhile`): what it made is gone, and a new one starts over. */
const SIGN_IN_UNDONE = { code: "UNAUTHORIZED", message: "Sign in again." };

/** Every sign-up but the password form's is through a provider (the redirect's callback, or the phone's id token). */
const isSocial = (context: { path?: string } | null | undefined) => context?.path !== "/sign-up/email";

/**
 * The early-access link's token on a sign-up (ADR 0078): the password form's header, else what the web put in a
 * provider sign-in's state. Untrusted either way, so only the token's shape is kept, and the rule checks the rest.
 */
async function accessOf(context: { headers?: Headers | null } | null | undefined): Promise<string | null> {
  const value =
    context?.headers?.get(EARLY_ACCESS_HEADER) ??
    // Outside a request (the adapter called directly) there is no state to read.
    (await getOAuthState().catch(() => null))?.earlyAccess;
  return typeof value === "string" && EARLY_ACCESS_TOKEN.test(value) ? value : null;
}

/** Where a confirmation link lands: the web app says how it went there (apps/web/src/lib/email-confirmation.ts). */
const CONFIRMATION_LANDING = "/?email_confirmed=1";

/**
 * The confirmation link, landing on `CONFIRMATION_LANDING` whenever the request named no other page: the phone app's
 * sign-up, a new link asked for later and every new address name none.
 */
function confirmationLanding(verifyUrl: string): string {
  const url = new URL(verifyUrl);
  const back = url.searchParams.get("callbackURL");
  if (!back || back === "/") url.searchParams.set("callbackURL", CONFIRMATION_LANDING);
  return url.toString();
}

/** Who may sign up here (ADR 0006; the owner's link or key, ADR 0060 §6). */
export function signupPolicy(config: Config): SignupPolicy {
  return {
    allowSignup: config.ALLOW_SIGNUP,
    ownerByLink: Boolean(config.OWNER_CLAIM_SHA256 || config.OWNER_KEY_SHA256),
    hostComputer: Boolean(config.HOST_COMPUTER_TOKEN),
  };
}

/**
 * Whether anyone may sign up now (`users`: how many accounts exist): the first account unless the owner's link or key
 * makes it, then `ALLOW_SIGNUP` or the operator's live mode (ADR 0078).
 */
export async function signupOpen(db: Database, config: Config, users: number) {
  const policy = signupPolicy(config);
  return users === 0 ? !policy.ownerByLink : signupOpenToAll(db, policy);
}

/** Whether making a workspace needs an account early access allowed (ADR 0078 §4): only on agentes.chat Cloud. */
export const workspacePolicy = (config: Config): WorkspacePolicy => ({
  paidMachines: config.MACHINE_PROVISIONING === "external" && isAgentesCloud(config.PUBLIC_URL),
  allowSignup: config.ALLOW_SIGNUP,
});

/** Sign-in options the login and sign-up pages need to render. */
export function authUiConfig(config: Config) {
  return {
    socialProviders: {
      google: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
      github: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
      apple: appleConfigured(config),
    },
    termsUrl: config.TERMS_URL ?? null,
    privacyUrl: config.PRIVACY_URL ?? null,
    supportEmail: config.SUPPORT_EMAIL ?? null,
    feedback: Boolean(feedbackDestination(config)),
    feedbackRelay: isFeedbackRelay(feedbackDestination(config)),
  };
}

/** How long the sign-in in "Abrir no celular" (the web app's QR code) lasts. */
const PHONE_SIGN_IN_TTL_MS = 3 * 60_000;
const phoneSignInKey = (token: string) => `phone-sign-in:${sha256(token)}`;
/** A minted sign-in for a user rather than for a session's user (the owner key's, `owner-claim.ts`). */
const FOR_USER = "user:";

/** Single use, a few minutes long, stored as a hash: for the session with this token, or `user:<id>`. */
async function mintSignIn(
  adapter: { createVerificationValue: (v: { identifier: string; value: string; expiresAt: Date }) => Promise<unknown> },
  value: string,
) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PHONE_SIGN_IN_TTL_MS);
  await adapter.createVerificationValue({ identifier: phoneSignInKey(token), value, expiresAt });
  return { token, expiresIn: PHONE_SIGN_IN_TTL_MS / 1000 };
}

/**
 * A one-time sign-in for the phone, minted from a signed-in session: void once that session ends
 * (signing out on the web voids a QR code still on screen).
 */
export async function mintPhoneSignIn(auth: Auth, sessionToken: string) {
  const { internalAdapter } = await auth.$context;
  return mintSignIn(internalAdapter, sessionToken);
}

/**
 * A one-time sign-in for an account an approved request made (ADR 0090), traded by the page that asked through
 * `POST /api/auth/sign-in/one-time-token`, as the phone's.
 */
export async function mintUserSignIn(auth: Auth, userId: string) {
  const { internalAdapter } = await auth.$context;
  return mintSignIn(internalAdapter, `${FOR_USER}${userId}`);
}

/** The password hash Better Auth would store for `password` (ADR 0090: a request keeps it until an approval). */
export async function hashPassword(auth: Auth, password: string) {
  const context = await auth.$context;
  return context.password.hash(password);
}

/**
 * A new password in place of the account's own, after a fresh sign-in (ADR 0158 §4: the server's owner after
 * Continue on this Mac, or anyone who just signed in). As a reset does: every other session ends and every AI app
 * and personal token the old password let in is cut off (ADR 0119); the session that asked stays.
 */
export async function replacePassword(auth: Auth, db: Database, userId: string, password: string, keepToken: string) {
  const context = await auth.$context;
  await context.internalAdapter.updatePassword(userId, await context.password.hash(password));
  await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.token, keepToken)));
  await revokeUserApps(db, userId);
}

/**
 * `POST /api/auth/sign-in/one-time-token { token }`: the phone trades the token for a session of its own.
 * Better Auth's `oneTimeToken` plugin would hand it the browser's session instead, so signing out on one
 * device would sign out the other.
 */
const phoneSignIn = {
  id: "phone-sign-in",
  endpoints: {
    signInOneTimeToken: createAuthEndpoint(
      "/sign-in/one-time-token",
      { method: "POST", body: z.object({ token: z.string().min(1).max(200) }), use: [formCsrfMiddleware] },
      async (ctx) => {
        const { internalAdapter } = ctx.context;
        const minted = await internalAdapter.consumeVerificationValue(phoneSignInKey(ctx.body.token));
        let user: Awaited<ReturnType<typeof internalAdapter.findUserById>> = null;
        let signedIn: Date | undefined;
        if (minted?.value.startsWith(FOR_USER))
          user = await internalAdapter.findUserById(minted.value.slice(FOR_USER.length));
        else if (minted) {
          const from = await internalAdapter.findSession(minted.value);
          if (from && from.session.expiresAt >= new Date()) {
            user = from.user;
            signedIn = from.session.createdAt;
          }
        }
        if (!user) throw new APIError("UNAUTHORIZED", { message: "This code expired or was already used" });
        // Minted from a session, it signed in when that one did: it proves no fresher sign-in (`signedInLately`).
        const session = signedIn
          ? await internalAdapter.createSession(user.id, undefined, { createdAt: signedIn }, true)
          : await internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ user: { id: user.id, name: user.name, email: user.email } });
      },
    ),
  },
} satisfies BetterAuthPlugin;

/** The phone app's URL scheme (deep links back from social sign-in). */
export const APP_SCHEME = "agenteschat://";
export const APPLE_ORIGIN = "https://appleid.apple.com";
/** Apple accepts a client secret valid for at most 6 months; we sign one per boot for 150 days. */
const APPLE_SECRET_TTL_S = 150 * 24 * 3600;

const appleConfigured = (config: Config) =>
  Boolean(config.APPLE_CLIENT_ID && config.APPLE_TEAM_ID && config.APPLE_KEY_ID && config.APPLE_PRIVATE_KEY);

/**
 * "Sign in with Apple" (App Store 4.8), when its four variables are set. The
 * client secret Apple wants is an ES256 JWT signed with the Sign in with
 * Apple key (iss = team, sub = services id, aud = appleid.apple.com).
 * `APPLE_APP_BUNDLE_ID` lets the iOS app sign in natively (its id tokens
 * carry the bundle id as audience).
 */
export function appleSignIn(config: Config, now = Date.now()) {
  if (!appleConfigured(config)) return null;
  const clientId = config.APPLE_CLIENT_ID as string;
  // Several bundle ids (the store's app and its preview builds, for app links): the first, the store's, signs in.
  const [bundle] = listOf(config.APPLE_APP_BUNDLE_ID);
  return {
    clientId,
    clientSecret: appleClientSecret({
      clientId,
      teamId: config.APPLE_TEAM_ID as string,
      keyId: config.APPLE_KEY_ID as string,
      privateKey: config.APPLE_PRIVATE_KEY as string,
      now,
    }),
    ...(bundle ? { appBundleIdentifier: bundle } : {}),
  };
}

/** The ES256 client secret JWT for Apple's token endpoint. */
export function appleClientSecret(input: {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  now?: number;
}): string {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "ES256", kid: input.keyId, typ: "JWT" })}.${encode({
    iss: input.teamId,
    iat,
    exp: iat + APPLE_SECRET_TTL_S,
    aud: APPLE_ORIGIN,
    sub: input.clientId,
  })}`;
  // JWS wants the raw r||s signature, not DER.
  const signature = signWithKey("sha256", Buffer.from(signingInput), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

/** Revokes one Apple token (best effort; throws on failure, callers swallow it). */
export type AppleTokenRevoker = (token: { value: string; hint: "refresh_token" | "access_token" }) => Promise<void>;

/**
 * Apple's token revocation (required when an account that signed in with
 * Apple is deleted), with the same client secret as sign-in, signed fresh
 * for each call. Null when Sign in with Apple isn't configured. Tests
 * inject a fake instead (`AppExtras.appleRevoke`).
 */
export function appleTokenRevoker(config: Config, http: typeof fetch = fetch): AppleTokenRevoker | null {
  if (!appleConfigured(config)) return null;
  const clientId = config.APPLE_CLIENT_ID as string;
  return async (token) => {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: appleClientSecret({
        clientId,
        teamId: config.APPLE_TEAM_ID as string,
        keyId: config.APPLE_KEY_ID as string,
        privateKey: config.APPLE_PRIVATE_KEY as string,
      }),
      token: token.value,
      token_type_hint: token.hint,
    });
    const res = await http(APPLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Apple refused the token revocation (${res.status})`);
  };
}
