# 0194. The same server on extra hostnames, each with its own look before sign-in

- Status: Accepted
- Date: 2026-11-17
- Extends: ADR 0056 (the operator API), ADR 0193 (a workspace's accent), `EXTRA_TRUSTED_ORIGINS`
- Code: schema `packages/db/src/schema/hosts.ts` (migration 0291); engine `packages/engine/src/hosts.ts` (`hostLook`,
  `hostOrigin`, `baseUrlFor`, `putHost`, `deleteHost`), `net-guard.ts` (`normalizeHost`), `cache.ts` (`caches.hosts`);
  server `app.ts` (`data-host` and `data-unknown-host` on the page), `apps/server/src/routes/app/context.ts` (`requestOriginAllowed`, `requestBaseUrl`), `realtime/ws.ts`
  (`personUpgrade`), `auth.ts` (`trustedOrigins`, `SOCIAL_STARTS`, the reset and confirmation links, `authUiConfig`),
  `http/human-check.ts` (`humanCheckRefusal`), `routes/app/account.ts` (`GET /api/app/auth-config`'s `host`),
  `routes/instance.ts` (`GET /api/host-look/logo`), `operator/hosts.ts`; web `apps/web/src/components/AuthLayout.tsx`
  (`AuthShell`, `AuthFrame`), `components/UnknownHost.tsx`, `i18n/index.ts` (`brandTabTitle`), `lib/app-icon.ts` (`showHostIcon`); tests
  `packages/engine/test/hosts.test.ts`, `apps/server/test/hosts.test.ts`, `apps/web/test/host-look.test.tsx`,
  `apps/web/test/unknown-host.test.tsx`

## Context

A server answers at `PUBLIC_URL` (and at the addresses in `EXTRA_TRUSTED_ORIGINS`, for one installation opened from a
LAN or a tunnel). Whoever runs a server for several groups of people may want each group to reach it at an address of
its own, with that group's name, logo and color on the pages people see before they sign in. Inside a workspace a
workspace's own logo and accent (ADR 0193) already decide the look.

Answering on another hostname widens which browser origins may hold a session and send writes, so every check has to
stay exact and be written once.

## Decision

1. **A table of hosts, kept by the operator.** `hosts`: `host` (the primary key: lower case, a hostname only, no
   scheme, port, path or trailing dot, at most 253 characters and at least one dot), `name` (1 to 60), `accent`
   (`#rrggbb` or null), `logo` (a stored file's key in the platform's bucket, as a workspace's logo is kept, or null),
   `powered_by` (true unless turned off, see 8; migration 0298) and the times. It is the server's, not a tenant's: no `org_id`. Only the operator API writes it:
   `GET /hosts`, `PUT /hosts/{host}` (creates or replaces; `accent`, `logo` and `poweredBy` left out are left as they
   are, null clears `accent` and `logo`; the logo takes a workspace logo's checks) and `DELETE /hosts/{host}` (also deletes its logo).
   Refusals: `host.invalid` (not a hostname), `host.own` (`PUBLIC_URL`'s host or one of `EXTRA_TRUSTED_ORIGINS`'),
   `host.too_many` (past 1,000), `host.needs_https` (409: `PUBLIC_URL` isn't https; see 4). Every write of the table holds one transaction lock, so a replace and a delete never
   interleave (a deleted host never comes back pointing at a logo the delete removed) and two creates never both pass
   1,000. A new logo is stored under a name of its own before its row is written, and a logo no row holds any more is
   removed only after the write commits. A server with none behaves exactly as before.
2. **One resolver.** `normalizeHost` reads a `Host` header (or a host an operator typed) as one comparable name or
   nothing: lower case, one trailing dot dropped, and anything with a port, an IP address, a single label, a scheme,
   a path or a user refused. `hostLook(db, host)` returns the registered row for it or null. Every check below goes
   through it. It is kept per process for 30 seconds (`caches.hosts`) and dropped at once on a write in this process,
   so a change applies here at once and on the other processes within 30 seconds; the same holds for a deleted host.
   A lookup that began before an invalidation (here, or one another process sent) answers but keeps nothing, so a read
   from before a write never stays in the cache after it.
3. **The origin rule.** An origin is allowed when it was allowed before, or when it is exactly `https://<host>` for a
   registered host **and** the request's own `Host` is that host (`hostOrigin`). The app API's CSRF check
   (`requestOriginAllowed`), the WebSocket upgrades (`personUpgrade`, also the desktop and terminal streams) and Better
   Auth's `trustedOrigins` (a function of the request; with none, Better Auth's start, the list it had before) all
   take that one function. The request's own host must match because a registered host's pages belong to whoever it
   was registered for: an origin trusted on every request would let one host's pages write with a session held on
   another host or on the main address. Plain `http://`, another port and a trailing dot in the origin are refused;
   `X-Forwarded-Host` and `Forwarded` are never read, so nothing in front of the server can name a host it did not
   receive.
4. **A session per host.** Better Auth's cookies carry no `Domain`, so a browser keeps a registered host's session to
   that host alone: signing in there signs in nowhere else, and the main address's session never reaches it. `baseURL`
   stays `PUBLIC_URL`, and Better Auth marks its cookies `Secure` (with the `__Secure-` prefix) from it, on every host
   alike. A registered host is always https, so a server whose `PUBLIC_URL` is plain http (one on a LAN address)
   registers none (`host.needs_https`): its cookies on a registered host would go without `Secure`, and a browser would
   send them over plain http to that host.
5. **Email only on a registered host.** There `GET /api/app/auth-config` says every provider is off and adds
   `host: { name, accent, logoUrl }` (null everywhere else; `GET /api/instance` says the same of the providers), and
   Better Auth's `before` hook refuses to start or link a provider's sign-in (`/sign-in/social`, `/link-social`) with
   the 404 `PROVIDER_NOT_FOUND` a server without that provider answers. A provider sends people back to the one
   callback address it knows, `PUBLIC_URL`'s, whose session the registered host can't read. Social sign-in there
   would need a hand-over: the main address finishes the sign-in, then passes a one-time code back to the registered
   host, which turns it into a session of its own. It is left for later.
   A registered host runs no bot check (ADR 0075): there `auth-config`'s `turnstileSiteKey` is null, so its pages load
   no widget and send no token, and `humanCheckRefusal` lets its requests through without asking Cloudflare. The
   e-mail's lookup gives no pass there, since a pass would stand for the check on the main address. Turnstile's widget
   takes a fixed list of hostnames, so it can't follow a list an operator keeps adding to. The waiting lists keep the
   check on every host: their forms are the landing page's. Only the request's own `Host`, through `hostLook`, decides.
   What that leaves unguarded, plainly: nothing ties an account to a host, so every account's email lookup, password
   sign-in and password reset can be asked on any registered host, where no bot check runs. On a server with
   registered hosts, the main address's bot check therefore no longer stands between a script and those calls for any
   account. What guards them is the limits per network, tighter on registered hosts (10 email lookups in 10 minutes and
   5 sign-ups in 15 minutes per network, for all of them together), and the wrong passwords per account (10 in 15
   minutes from one network, 50 from all), each counted in a server process's memory, so a restart starts them again
   (ADR 0075, points 10 and 11). Sign-up there can send confirmation emails with only the limit per network in front
   of it.
6. **The links that bring a person back.** `baseUrlFor(requestHost)` gives the registered host's address on a request
   for one, else `PUBLIC_URL`. The confirmation link of an account signed up on that host, an invitation's link and its
   email (the host it was created or re-sent from, by someone signed in there), the invitation links' list and the join
   code's email (a link to the page, the code in the text) use it. Nothing is kept on the invitation row: a re-send goes
   back to the host it is re-sent from, and there are no automatic reminders. The password reset link, and a
   confirmation link asked for later or for a new address, always go to `PUBLIC_URL`: anyone may ask for them for any
   account, without a session, and nothing ties an account to a host, so following the request's host would hand a token
   that takes over the account, on every host, to whoever serves that registered host's traffic (its owner, or whoever
   holds the domain once it lapses). Sending a reset back to its host would need the account's own host kept (where it
   signed up), and the request's host used only when the two match. Everything else keeps the server's own address, left
   for later: notifications and their emails, a join request's emails to admins and its answer, invitations agents send,
   connectors' and apps' OAuth returns, devices and computers, and the phone's links.
7. **The logo** is served without a session at `GET /api/host-look/logo` for the request's own host only (no
   parameter names a host), with the image checks a workspace's logo has and a five-minute cache lifetime;
   `auth-config`'s `logoUrl` carries the file's name so a new logo is fetched at once.
8. **The web.** On a registered host the pages before sign-in (sign-in, sign-up, an invitation, a new password) show its
   logo, or its name alone in the heading face, where the product's lockup is, set its accent's four tokens on the
   document while they show (the workspace shell does the same with the workspace's own accent; the screens in that look
   shown inside a workspace, such as a suspended one's, take no host accent, so the two never show at once), and end
   with one quiet "Powered by agentes.chat" line linking to the product's site. The sign-in steps' line naming the
   server it signs in to (on a Cloud server, the product's hosted service, with a Change that opens the product's own
   chooser) is not shown there. Before the app has asked who the host is, the server marks the page on a registered
   host (`data-host` on its `<html>`, in the one place every page from `WEB_DIR` passes), and `index.html`'s boot rules
   then hide the product's mark: the boot shows its sky alone. The tab's title names the host where it
   names the product, on every page of that host, and the tab's icon is its logo unless the browser picked another icon.
   The About screen and its license notice are unchanged.

   The powered-by line is shown by default: someone signing in at an address that isn't the product's can tell which
   software will hold their account. An operator may turn it off for one host (`poweredBy: false`, carried to the web
   in `auth-config`'s `host`); the main address never shows it.
9. **A hostname the server doesn't answer for.** On a server with the operator API on (`OPERATOR_API_TOKEN` set), a
   `GET` for the web app's page whose `Host` is an unknown hostname answers that page marked `data-unknown-host` on
   its `<html>`, with status 404 and `cache-control: no-store` (the hostname may be registered a moment later). A
   hostname is unknown when `normalizeHost` reads a name from it (never an IP address, a single label such as
   `localhost`, or anything with a port), the name is none of the server's own (`PUBLIC_URL`'s host and those of
   `EXTRA_TRUSTED_ORIGINS`, `ownHosts`), and `hostLook` finds no registered host for it. A registered host is marked
   `data-host` alone, never both. Only the app's page changes: the API, the build's files, the service worker, the
   emails' pictures, the installer and every other answer are the same on every host, since the phone and desktop
   apps, runners, webhooks and health checks call the server at names of their own. A server without the operator API
   registers no hosts, so it has none to tell apart and answers every `Host` as before. A marked page shows only one
   screen in the sign-in pages' look with the product's mark (`UnknownHost`): the address isn't set up yet, a
   short line to try again in a few minutes, and a button that loads the page again. The web's entry decides it first: no session, router,
   socket, service worker or notification starts on that page.
10. **Phone and desktop.** Nothing changes. The phone app is built for one address. The desktop app's server check
   (`checkServer`, shared with the phone) asks `GET /api/instance`, whose `url` is `PUBLIC_URL`'s origin on every
   host, and uses a server at the address it names: a registered host typed in its server field opens the main
   address, with the product's own look and sign-in. `url` stays the main address on purpose: the phone app and the
   desktop app's check for a server on this computer read it as the server's one address.

## Consequences

- An operator registers a host only after pointing the hostname at the server and serving a certificate for it (the
  server only answers what reaches it, over HTTPS). A proxy in front must pass the `Host` the browser sent; one that
  rewrites it makes the host look unregistered, which fails closed. On a server with the operator API on, a rewritten
  `Host` that is a real hostname gets the "not set up yet" page (point 9): pass the browser's `Host` through, or list
  that name in `EXTRA_TRUSTED_ORIGINS`.
- A session cookie someone still holds at a hostname that stopped being registered reads through the API as before:
  point 9 changes the page, not the API.
- Deleting a host does not end the sessions people hold there: they stop being reachable there once its traffic stops
  reaching the server, and its origin is no longer trusted at once on this process and within 30 seconds elsewhere.
- Every request to Better Auth, and every write and WebSocket upgrade with an origin outside the old list, reads the
  cache: the database once per host per 30 seconds per process.
