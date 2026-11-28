# 0187. Outside chat surfaces: a bridge that lets a separate service carry a person's conversation with the right hand

- Status: Accepted
- Date: 2026-11-16
- Extends: ADR 0002 (nothing private runs in the server process), ADR 0056 (the operator API's listener; hooks are pulled), ADR 0117 (outside content), ADR 0119 (`meta.via`), ADR 0177 (the right hand acts first)
- Code: config `packages/config/src/schema.ts` (`SURFACE_BRIDGE_TOKEN`, `SURFACE_NAME`, `SURFACE_OPEN_URL`,
  `SURFACE_ONLY`) and its rules in `index.ts`; db `packages/db/src/schema/surfaces.ts` (`surface_links`,
  `surface_deliveries`, `surface_calls`) and `voice_clips.via`, migration 0293; engine
  `packages/engine/src/surfaces/config.ts` (`setSurface`, `surfaceOn`, `surfaceAllowed`) and `links.ts` (codes,
  claim, confirm, unlink; revoked with `revokeUserApps` and `setUserBlocked`) and `inbound.ts` (`postFromSurface`,
  with `voice_clips.via` carried by the voice job) and `deliveries.ts` (`queueSurfaceDelivery` from the
  `notifications.message` job, which shares `quietForPeople` with `notifyMessage`; the `surface.fallback` job;
  `pruneSurfaceRows` beside the message partitions upkeep) and `turn.ts` (`surfaceRefusal`, called by the tool gateway;
  the turn's line is in `context.ts`; a forwarded message steered into a run counts in `outside.ts`); the `surface_linked` and `surface_unlinked` emails in `email.ts`, undone by
  `undoSurfaceLink` (`POST /api/app/surface-undo`); server
  `apps/server/src/surface/app.ts` (`createSurfaceApp`), served by `operatorFetch` in
  `apps/server/src/operator/app.ts`; app routes `apps/server/src/routes/app/surfaces.ts`; contract `apps/server/test/surface-openapi.json`

## Context

People want to talk to the workspace's built-in assistant (the agent with `builtin = "right_hand"`, ADR 0177) from a
chat app they already have open, and read its answers there. A chat app's own API (keys, webhooks, templates, its
rules) is not something every server should carry, and an operator may keep that part in a service of their own.
ADR 0002 keeps such a service out of the server process, so it runs apart and needs a door.

Nothing today fits: the operator API (ADR 0056) has no message routes and its token reaches every workspace; AI apps
over MCP (ADR 0119) act per grant, mark what they send as outside content and poll for answers; and the server never
calls an operator's services (ADR 0056 §7). The engine already has the pieces: `postPersonMessage` posts as a person
from a trusted caller, idempotent by `clientId`; `acceptVoiceClip` takes voice notes; `createFileArtifact` takes files;
the `notifications.message` job runs once for every message a run posts; `meta.via` says where a message came from.

## Decision

### 1. Off unless configured, served apart, its own token
- `SURFACE_BRIDGE_TOKEN` (at least 32 characters, different from every operator token) turns the bridge on.
  `SURFACE_NAME` (what people and the agent read, e.g. "Example Chat") and `SURFACE_OPEN_URL` (`https://`, holding `{text}`
  once: opens a chat with the surface's account with a text typed in) are required with it; `SURFACE_ONLY` (emails)
  limits linking to some accounts while the operator tests. Unset: no route below answers, nothing is written, no row
  shows in the apps, and the right hand never hears of a surface. One surface per server; its id in rows is the
  lower-cased name.
- The routes live under `/api/surface/v1` on the operator listener (`OPERATOR_API_PORT`, never published), which now
  starts when either `OPERATOR_API_TOKEN` or `SURFACE_BRIDGE_TOKEN` is set. Each token opens only its own prefix.
  Bearer, constant-time compare, versioned, with a committed OpenAPI document (ADR 0056 §3).
- Every bridge call writes one `surface_calls` row (route, status, code, link, account, workspace, a hash of the sender
  id; never content), kept 90 days. Caps across all senders (posts a minute, claims an hour) answer 429 and raise an
  operator event `surface.cap_reached`.
- The server never calls the service: it pulls deliveries (§5). ADR 0056 §7 holds.

### 2. A link: one outside sender, one account
`surface_links`: `user_id` (cascade with the account), `surface`, `external_id`, `display`, `profile_name`, `status`
(`pending` | `active`), `org_id` (the workspace answering now, set null with it, checked on every use), `created_at`,
`confirmed_at`, `last_seen_at`. One active link per sender and per account (partial unique indexes).

- `external_id` is the surface's stable, opaque id for the sender. It must never be a phone number or any address that
  can pass to someone else: a reassigned number would otherwise reach the old owner's assistant. `display` (a phone
  number, a handle) is shown to the person and never used to look anything up.
- Linking takes two screens that agree, like the desktop hand-over: the signed-in person mints a code (10 minutes,
  8 characters, in `verifications`, 10 an hour); the service sees it arrive from a sender and claims it (the code is
  spent by one atomic delete; 5 claims an hour per sender; a wrong, used or expired code answers alike); the app then
  shows the full `display` and profile name, and only the person's confirm makes the link active. A pending link older
  than 10 minutes is gone when read; there is no sweep job.
- Confirming emails the account ("<name> was linked", with a one-tap undo on the existing `/email-undo` page, a token
  kind of its own) and queues a `linked` delivery so the surface says so.
- A link ends when the person unlinks it in the app, or from the surface with its unlink word; when the surface reports
  that the sender's identity changed (new number, new id, identity key), which also emails the account and leaves a
  line in the person's DM; with the emailed undo; on every path that cuts off AI apps (password reset, a new password,
  "This wasn't me"); on an account block; and with the account. A new confirm replaces the account's old link; the
  same sender confirmed from another workspace moves the link there. No idle expiry.
- Who sees the settings row is answered per account (`GET /api/app/me/surface-links` → `allowed`), never by the
  instance-wide config, which only says the bridge is on.

### 3. A message in
`POST /api/surface/v1/messages` (multipart: sender, the surface's message id, text, files, one voice note with its
length, `forwarded`, `replyTo`):
1. The active link, else 404 `surface.unlinked` (the service answers strangers itself).
2. The workspace: a member in good standing and the right hand allowed to talk to them, else 409.
3. 20 posts a minute and 300 a day per account.
4. Files become file artifacts. A voice note stays a voice note only within 16 MiB and 8 KB per second of its stated
   length, and within the workspace's voice rules; otherwise it is posted as a file. The length a file claims is not
   trusted beyond that.
5. Posted as the person in their DM with the right hand (`postPersonMessage`), with `clientId = "s:" +
   sha256(surface:messageId)[0..40]` and `meta.via = { kind: "surface", surface, linkId, forwarded? }`. Clients can't
   write `meta`, so the mark can't be forged. A message the surface marks as forwarded also gets `meta.readOutside`
   (ADR 0117): someone else's words, read as quoted text, never as the person's instruction. The person's own words
   carry no outside mark and get `meta.ownWords` (ADR 0250 §2, amended): they may keep a rule or a memory in the
   person's name, so the service marks as forwarded any post with a part the sender didn't write.
6. The DM is marked read up to it: the person is reading where they write.

### 4. Where the reply goes
A reply goes where the person last wrote; a notice goes to one place, and never to none.
- The rule: the surface of the latest person message the run read (its trigger, or a message queued into it).
  An app-started run that takes a surface message midway answers on the surface, and the reverse. One function decides
  it for the delivery, the agent's context and the tool policy.
- The hook: the `notifications.message` job. When the message is the right hand's, in the linked account's own DM with
  it, worth telling (the same predicate `notifyMessage` uses: no progress lines, no quiet notices), and the rule lands
  on the surface, it writes one delivery and skips the in-app notification. Everything else is unchanged.
  `insertMessageWithRuns` is untouched.
- Messages no run posted (the right hand's own unasked posts) are not surface replies; what a surface may send first
  is a later decision.

### 5. Deliveries are pulled
`surface_deliveries` (`link_id`, `kind` `reply` | `linked`, `message_id`, `in_reply_to`, `taken_at`, `outcome`), kept
7 days. A row outlives its link (`link_id` is set null when the link ends), so a reply still waiting falls back to
the app.
- `GET /deliveries` lists what is not taken and younger than 5 minutes, each read whole at that moment: text, files,
  GIF or sticker, a card's kind and its link into the app, a question's choices, the account's language. Membership and
  the right hand are checked again when listed.
- `POST /deliveries/taken { sent, unsent }`: `sent` marks the DM read up to that message; `unsent` (the service
  couldn't send it) runs the usual in-app notification. A delivery not taken within 5 minutes gets that notification
  and is no longer listed, so a service back from an outage never sends stale replies. Closing is one conditional
  update, so the fallback and a late `taken` can't both act.
- `GET /files/{id}?delivery=` streams a file only when it belongs to that delivery's message.

### 6. The agent knows where it is talking
- `viaLine` names the surface on the person's messages, and says when one was forwarded.
- On a surface turn the DM's "# Where you are" (a per-turn block: the cached prefix holds) says the person reads this
  on the surface: short, plain text with bold, italics, lists and links, files go through, no cards, blocks, polls or
  choices.
- On a surface turn the tool gateway refuses, with one line telling the person to do it in the app: card and block
  tools; anything that needs a person's approval (merge, deploy, rollback, any sensitive tool), whatever the agent's
  approval level; tools whose names send, delete or pay; tools about roles, budgets, billing or money; and routines that
  post elsewhere or act for another agent; the right hand's catch-all `workspace_action` beyond the person's own status,
  notifications and time zone, and its proposals to change an agent's settings or instructions; work that runs apart
  from the turn (an asking reminder, a routine run now, Vault keys for a routine); and a connector's executor unless
  every action its input names is neither sensitive nor about money or roles. An agent asked or told by a surface turn
  (`ask_agent`, `tell_agent`, up the chain) is held to the same refusals. Tools stay listed, so the prompt cache holds.
  A later decision may lift this per act.
- A forwarded message steered into a running turn makes that run one that read outside content (ADR 0117), as it
  would if it had started the run.
- The right hand deciding cards for the person (ADR 0139) never acts on a surface conversation: every one is with the
  right hand, so its cards are its own.

### 7. What the bridge can never do
Act for someone with no active link, in any conversation but their DM with the right hand, or in a workspace they are
not a member of in good standing; read anything but its own deliveries and their files; mint a sign-in, a session, a
password or email change; decide an approval; write `meta` other than `via` and the forwarded mark.

### Later
What a surface may send first, and a confirmation for sensitive acts, are later decisions, each with its own ADR. The confirmation is ADR 0226: §6's sensitive classes now wait for the person's PIN on a page linked from the surface. The first thing a surface sends first is the unread nudge, ADR 0234.

## Consequences

- A server without `SURFACE_BRIDGE_TOKEN` runs as before: empty tables, no new listener, no row in the apps.
- A self-hoster can connect any chat app by writing a small service against this contract.
- A stolen bridge token can post as any linked person into their own DM with the right hand (which then acts with the
  right hand's grants, minus what §6 refuses, and keeps rules, memories and routines in that person's name, ADR 0250), read every reply to linked people and its files, claim a code someone
  gives away (the owner still has to confirm, seeing a `display` the token wrote), and unlink anyone. It can't sign in,
  read other conversations or workspaces, or reach the operator API. Unsetting the value and restarting stops it.
- Replies read on a surface are not pushed or put in the inbox, unless the service couldn't send them within 5 minutes.
- Up to a second of extra delay per reply while the service polls, and one indexed query a second.
- Every new string ships in every ready language in the same change.
