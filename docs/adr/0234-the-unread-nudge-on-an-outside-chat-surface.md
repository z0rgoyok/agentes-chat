# 0234. The unread nudge on an outside chat surface: decided by core, sent by the service

- Status: Accepted
- Date: 2026-11-24
- Extends: ADR 0187 (outside chat surfaces; "what a surface may send first" was left for later), ADR 0046
  (notifications)
- Code: db `packages/db/src/schema/surfaces.ts` (`surface_links.nudge_on`, `nudge_after_hours`, `quiet_from`,
  `quiet_to`, `nudged_at`; `surface_deliveries.kind` gains `nudge`), migration 0353; engine
  `packages/engine/src/surfaces/nudge.ts` (`queueSurfaceNudges`, `unreadFor`, `setNudge`, `inQuietHours`) and
  `deliveries.ts` (`listSurfaceDeliveries`'s `nudges`); the sweep `surfaceNudges` in `apps/server/src/workers.ts`;
  bridge `GET /api/surface/v1/deliveries?nudges=true` (contract `apps/server/test/surface-openapi.json`); app route
  `PATCH /api/app/me/surface-links/{id}/nudge`; web `SurfaceLink.tsx` (`SurfaceNudgeRows`), phone
  `apps/mobile/src/features/me/SurfaceLink.tsx` (`NudgeRows`)

## Context

A person who linked a chat app often doesn't open ours, so what waits for them there (a reply, an approval, a
question) can sit unread for hours. The operator's design for its chat service asked for a nudge with these defaults:
on, after 4 hours unread, at most once a day, never between 22:00 and 08:00 in the person's time zone, only when no
phone push reached them, and only to people who wrote through the chat app in the last 30 days. Each person changes it
(on or off, the delay, the quiet hours) in the app's settings. Outside the chat app's reply window, the service can
only send an approved template. That approval is the service's business and may not be granted yet.

Two places could decide when a nudge goes: the service, or core. Only core knows what is unread, where its pushes go,
and each person's time zone and settings. The service would have to poll all of that through the bridge, and the
bridge exists to carry one person's conversation, not to read their inbox.

## Decision

### 1. Core decides, the service sends
- Every 15 minutes the process that sweeps runs `queueSurfaceNudges`. It queues one `nudge` delivery for each active
  link that meets all of these:
  - nudges are on;
  - the person wrote through the surface in the last 30 days (`last_seen_at`);
  - they got no nudge in the last 24 hours;
  - it is outside their quiet hours (member's time zone, else the workspace's, else UTC);
  - none of their phones (iOS or Android) registered for pushes in the last 30 days, since a push already reaches
    them there;
  - something has waited unread in the link's workspace's inbox (not read, done or snoozed) for longer than their
    delay.
- Claiming `nudged_at` is one conditional update, so two processes sweeping at once queue one nudge.
- The service lists nudges only when it asks (`GET /deliveries?nudges=true`). A service that doesn't ask never sees
  the new kind, so deploying core first breaks nothing.
- A listed nudge carries `nudge: { unread, waiting }`, counted when it is listed. `waiting` is what blocks someone
  (an approval, a question), so the service can pick its more specific template. If nothing is unread by then, the
  delivery is dropped. Taken `sent` or `unsent`, a nudge never falls back to an in-app notification: it is about
  things already in the app. Older than 5 minutes, it is no longer listed, as for every delivery.

### 2. The person's settings
On the surface link: `nudge_on` (default on), `nudge_after_hours` (1 to 24, default 4), `quiet_from` and `quiet_to`
(whole hours 0 to 23, default 22 and 8; equal means no quiet hours), checked in the database. They go with the link.
`PATCH /api/app/me/surface-links/{id}/nudge` changes them on the person's own active link, and the links' list shows
them. The web (Settings › Notifications) and the phone (Notificações) show, under the linked chat app: a switch, a
delay of 1, 2, 4, 8, 12 or 24 hours, and the quiet hours, each saved at once. The words are in all 14 languages.

### 3. Left to the service
- The template's wording and its approval by the chat app.
- The free-form line it may send inside the reply window instead of a template.
- The person's stop word, which turns off everything sent first, nudges included, without touching these settings.

## Consequences

- The nudge reaches people who rely on the chat app, and never someone whose phone already got a push.
- One more sweep every 15 minutes, reading the links that are due (few) and, for each, one push-device lookup and one
  inbox sum.
- A self-hoster's bridge gets nudges only by asking for them, and decides how to word them.
