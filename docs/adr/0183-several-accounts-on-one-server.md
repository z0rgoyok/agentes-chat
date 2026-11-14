# 0183. Several accounts on one server

- Status: Accepted
- Date: 2026-11-13
- Amends: 0154 (one account per server in the phone and desktop apps; another account on the same server was left for
  later)
- Code: server `auth.ts` (`multiSession`, `deviceAccountsOf`, `switchDeviceAccount`, `signOutDeviceAccount`),
  `routes/app/account.ts` (`/device-accounts`), `routes/app/push.ts`; engine `push.ts` (`registerPushDevice`,
  `data.user`); web `lib/accounts.ts`, `lib/workspaces.ts`, `hooks/useWorkspaceGroups.ts`, the workspace menus in
  `components/Sidebar.tsx`; desktop `workspaces.rs`, `windows/prefs/Servers.tsx`; phone `lib/server-choice.ts`,
  `lib/server.ts`, `features/me/WorkspacesPages.tsx`

## Context

People have more than one account on the same agentes.chat: a personal one and a work one on agentes.chat Cloud, say.
A browser held one session per server, so the second account took the first one's place and coming back meant signing
in again. The phone and the desktop apps listed workspaces across servers (ADR 0154), with one account on each.

## Decision

Every app keeps several accounts signed in on one server and moves between them where the workspaces are listed.
Nothing signs out when one is added or opened.

### 1. The server

- Better Auth's multi-session plugin: every sign-in also leaves an HttpOnly cookie of its own, so the session before
  it stays, and one of them is the browser's active session. Five at most per browser.
- The plugin's own paths take and answer session tokens, and no token reaches JavaScript (ADR 0006), so they are off
  over HTTP. The apps use `/api/app/device-accounts`, which names accounts by person and calls the plugin in the
  server's process:
  - `GET /device-accounts`: each account signed in on this browser, the active one first, with its workspaces and
    their unread counts. No session guards it: a browser whose active session ended still lists the others.
  - `POST /device-accounts/switch { userId }`: that account becomes the active one.
  - `POST /device-accounts/sign-out { userId? }`: one account leaves (the active one by default), the others stay;
    when the active one left, the browser moves to the next.
- Listing, switching and signing out give every session the browser holds its cookie again, and extend the ones not
  in use (Better Auth only extends the one in use): an account stays signed in while the browser is used, whichever
  account it is on, and a session from before this, which had no cookie of its own, gets one.
- Signing one account out never calls Better Auth's own sign-out, which with the plugin ends every session the
  browser holds.
- A push says whose it is (`data.user`).
- A push token (a browser's endpoint) is to belong to the accounts signed in on its device, one row each. Registering
  it as someone else takes it from whoever isn't signed in on that device any more: a phone says which other accounts
  it has on that server (`sharedWith`), and a browser's are read from its own cookies. Naming an account in
  `sharedWith` only keeps a row that account itself made with that token.
- In two steps, because a deploy migrates while the version before still serves, and that version registers a token
  by its own unique constraint. This change registers without relying on that constraint and leaves the table as it
  is: a token is still one person's, the last to register, so a phone registers the account in use last. A later
  migration, once this is deployed, makes it unique per account (`push_devices (user_id, token)`); from then each
  account of a device hears its own pushes, with no change in the apps.

### 2. The web (and the desktop app's window, which is the site)

- **Your workspaces** lists every account's workspaces under a line per account, with unread counts. Choosing one of
  another account moves the browser to it and loads the app again from the start: what the account before had saved
  for a quick start or left waiting to send stays behind, and the browser's other tabs inside a workspace load again
  too.
- **Add account** opens the sign-in with the current account still signed in, and a way back to it.
- **Sign out** signs out of the account in use only.
- An address may name the account it is for (`?as=<user id>`): the page moves the browser to it before anything loads.
  The desktop app and browser notifications use it.

### 3. The desktop

- For each server, the app also asks `GET /device-accounts` with the window's cookies: Your workspaces in the site
  and Preferences › Servers list each account's workspaces. A server from before this lists the one account.
- Opening a workspace of another server goes there as the account it belongs to (`?as=`). Preferences › Servers opens
  a server as one of its accounts and adds one more (`/login?add=1`).
- New unread notifications of an account the window isn't on are told as the system's notification too, the open
  server's other accounts included.

### 4. The phone

- A session is kept per place. A place is a server (its first account, exactly as before, so nobody signs in again)
  or `server#id` for each other account there. What was kept per server is kept per place: the session's prefix, the
  remembered workspace, the chats snapshot, the outboxes, the push registration.
- **Workspaces** groups by place, naming the account where a server has several. **Add workspace** has "Sign in to
  another account" on the server the app is on: its sign-in opens with the way back.
- Signing in to an added account as someone the phone already has there lands on theirs; no second copy is kept.
- A tapped push opens as the account it is for.

## Consequences

- In the desktop app, an address of a server with `?as=` moves the window to that account of the person's own, a link
  in a chat included: it signs nobody in and shows nothing of another person. In a browser the name moves nothing.
- "Sign out of this server" in the desktop app's Preferences ends every account the window has there.
- A tab can't be told of every way the browser's session changes (a provider's sign-in coming back in another tab):
  inside a workspace it asks who is signed in when it is looked at again, and loads again when that changed.

- Two accounts on one server stay signed in on the web, the desktop and the phone, one tap apart.
- A shared computer keeps every account that didn't sign out reachable from the workspace menu: Sign out is per
  account, on purpose.
- An account's session cookie exists once per account in the browser; all are HttpOnly and signed like the session
  cookie.
- Until the push migration, two accounts of one server on the same phone or browser share its notifications one at a
  time: the account in use hears them.
