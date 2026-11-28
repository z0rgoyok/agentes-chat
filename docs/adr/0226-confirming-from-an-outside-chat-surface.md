# 0226. Confirming from an outside chat surface: a PIN, and page links with short lives

- Status: Accepted
- Date: 2026-11-24
- Extends: ADR 0187 (outside chat surfaces; its §6 refusals and its "Later"), ADR 0015 (approvals)
- Code: db `packages/db/src/schema/surfaces.ts` (`surface_links.pin_hash`, `pin_failures`, `pin_locked_until`,
  `pin_lockouts`; `surface_page_links`), migrations 0341 and 0342; engine `packages/engine/src/surfaces/turn.ts`
  (`surfaceGate`, called by the tool gateway), `pages.ts` (`mintPageLink`, `openSurfacePage`, `setSurfacePin`,
  `setMySurfacePin`, `checkPin`, `decideOnSurfacePage`, `emailPinLink`, `setPinFromEmail`, `prunePageLinks`),
  `deliveries.ts` (an approval's card opens its page); the `surface_pin_reset` and `surface_pin_locked` emails; routes
  `apps/server/src/routes/app/surfaces.ts` (`/surface-page/open`, `/surface-page/decide`, `/surface-page/pin-email`,
  `/surface-pin`, `PUT /me/surface-links/{id}/pin`); web `apps/web/src/pages/SurfacePage.tsx` (`/surface-page`),
  `SurfacePinResetPage` (`/email-undo?kind=surface-pin`) and the PIN row in Settings › Notifications
  (`SurfaceLink.tsx`, `?pin=1`); phone `apps/mobile/src/features/me/SurfaceLink.tsx` (the PIN row in Notificações)

## Context

ADR 0187 §6 refuses, on a surface turn, everything that needs a person's say or that deletes, sends, pays, or changes
roles, budgets or money: what someone types on a chat app proves nothing about who typed it, and a card can't be
answered there. People asked from the chat app are told to open the app, which they mostly don't have open. The
operator's design for the chat service settled the rest: a six-digit PIN, chosen the first time one is needed, typed
in a hidden field and never in the chat; three wrong ones lock it for 15 minutes; a forgotten one is reset by email.
Links to our pages open once within 10 minutes, then stay open for an hour (an agent's screen 30 minutes, control 15),
and end early on an unlink, a password change or lost access. A chat app keeps a sent button forever, so the short
first open is what makes an old message safe.

The chat app's own native form (where the chat app offers one) waits on the chat app's business verification. A page
of ours works with any chat app on the day the bridge is on, and stays as the fallback once a native form exists.

## Decision

### 1. What a surface turn confirms instead of refusing
`surfaceGate` replaces `surfaceRefusal`. On the right hand's own surface turn (the run's latest person message came
through the bridge), a call of class `approval`, `sends_deletes_pays` or `roles_budgets_money` becomes an approval
request instead of a refusal:
- An act that would run without asking anyone in the app (its level, "Aprovar sempre", an allowed merge repository,
  a routine's own job) asks the person behind the turn alone: `approvers` names them, `requesterDecides` and
  `required` true, so neither an admin nor someone covering them decides it in the app in their place. The PIN stands
  in for the person's own say, never for someone else's: no rule or level skips it.
- An act that asks someone anyway asks them as usual; the person decides it only if the app's rule lets them.
Cards and blocks, and routines that post elsewhere or act for another agent, stay refused. An agent the right hand
asked or told is still refused (no person stands behind its turn). The turn's "# Where you are" line tells the model
to call the tool and say in one line that the person confirms it on the page.

### 2. A page link
`surface_page_links` (`org_id`, `link_id` cascading with the surface link, `user_id`, `kind`, `target_id`,
`token_hash`, `browser_hash`, `created_at`, `opened_at`). The token is 32 random bytes, kept only as its SHA-256.
- Minted when a delivery is listed: the card of an approval the person decides now (`card.kind = "approval"`)
  carries `PUBLIC_URL/surface-page?token=…` instead of the app's link to the message. Other cards, and an approval
  that waits on someone else, keep the app's link. A
  delivery listed twice carries two links; each opens in one browser only.
- The page posts its token (`POST /api/app/surface-page/open`); a GET of the page opens nothing, so a chat app's
  link preview, which only fetches, spends nothing. The first open must come within 10 minutes of minting
  (`PAGE_FIRST_OPEN_MS`). It sets an HttpOnly, SameSite=Strict cookie scoped to `/api/app/surface-page` holding a
  random secret, whose hash is `browser_hash`; from then on only that browser reopens it
  (`surface.page_elsewhere`), until its kind's time from the first open runs out (`PAGE_OPEN_MS`: `confirm` 60
  minutes, `screen` 30, `control` 15; `surface.page_gone`).
- It ends early with the surface link (an unlink from either side, the emailed undo, a new password, "This wasn't
  me", a block, a deleted account: they all delete the link, and the page row cascades), when the person leaves the
  workspace, and when they can no longer see what it shows (`getApproval`'s visibility). Rows are pruned after a day.
- 30 calls per 10 minutes per IP address on the page's routes.

### 3. The PIN
Six digits, on the surface link (`pin_hash`, Bun's argon2id; `pin_failures`; `pin_locked_until`; `pin_lockouts`),
never in the chat, the logs or the service. Kept when the same sender moves to another workspace; a new sender or a
new link starts without one, so a new password (which ends the link) clears it too.
- Only a context that proves who the person is chooses a PIN, the first one and any one after "Forgot your PIN?"
  (`setSurfacePin`). A page link never does: whoever holds the chat, a forwarded message or the bridge's token can open
  one. The trusted contexts:
  - the person's signed-in session: Settings › Notifications in the web and desktop app, or Notificações on the phone
    (`PUT /me/surface-links/{id}/pin`, 10 an account per 10 minutes), or the page itself when the browser that opened
    it is signed in as the same person (`pin.canChoose`; approving there takes the PIN typed twice and keeps it);
  - a link emailed to the person's verified address (`surface_pin_reset`, from "Email me a link" or "Forgot your
    PIN?" on the page): `/email-undo?kind=surface-pin&token=` chooses the PIN, typed twice, once, within an hour,
    replacing any PIN and clearing its lock. Only that page's button spends the link (mail scanners open links), and a
    PIN of the wrong shape spends nothing. An address never verified gets no link (`surface.email_unverified`), and
    the link stops choosing once the account's address changes or stops being verified.
    3 emails an hour per IP address, and 3 an hour for the person whatever the address; 10 tries per 10 minutes per
    IP address on `/surface-pin`. Offered only where the server sends email (`pin.resetByEmail`).
- `confirm` page with a PIN: approving takes it. With none, and nobody signed in as the person there, the page says
  "Set your PIN first" with the way out (choose it in the app, which `/org/{orgId}/settings/notifications?pin=1`
  opens, or get the email) and reads itself again when the person comes back; approving answers
  `surface.pin_unset` and the approval waits in the app as before. Refusing takes no PIN. Who may decide is
  `decideApproval`'s rule, unchanged. `checkPin`, which the chat app's native form will use too, never sets a PIN.
- Three wrong ones in a row lock approving (`surface.pin_locked` with `until`), longer each time since the last right
  PIN: 15 minutes, then an hour, then a day for each further lock (`PIN_LOCKS_MS`). A lock that ended more than a day
  ago starts the count over, and so do a right PIN and a new one. Each lock emails the person (`surface_pin_locked`):
  for how long, and the way out if it wasn't them (unlink in the notification settings). Only a verified address
  gets it: an account can take anyone's address unconfirmed, and lock its own PIN at will. Each try is counted before
  its hash is checked, so tries sent at once never get past three.

### 4. Not built here
- The `screen` and `control` pages: their lifetimes are set (§2), and a control link will open only after the PIN, but
  showing an agent's live screen outside a signed-in session needs the screen stream to accept a page link instead
  of a session. Until then those links aren't minted and the app's own link stays.
- The chat app's native form for the PIN, which waits on its business verification. It will post to the same
  check (`checkPin`) through the bridge.
- Billing and payment links: paying stays by email, never through a page link from the chat.

## Consequences

- A person on the chat app can now delete, send, change roles and settings, merge or deploy through the right hand
  after typing their PIN on a page of ours, where before they had to open the app.
- A stolen bridge token still can't decide anything once the person has a PIN: it sees page links, but the PIN is
  never sent through it. A person who forwards a fresh page link lets the first browser to open it see the request;
  approving there still takes the PIN. A PIN is never chosen from a page link alone (no trust on first use): before
  one exists, the page only points to the signed-in app or the email to the verified address, so someone holding the
  phone, a forwarded link or the bridge's token can't choose it. Forgetting the PIN never reopens that gap: the
  emailed link chooses the new one itself.
- Guessing is slow and loud: three tries, then locks that grow to a day, and the person hears of each one by email.
- Self-hosters with a bridge get the same pages; nothing changes without `SURFACE_BRIDGE_TOKEN`.
