# 0189. Conversation backgrounds

- Status: Accepted
- Date: 2026-11-17
- Code: types and choices `packages/client/src/lib/wallpaper.ts` (`Wallpaper`, `wallpaperFor`, `resolveWallpaper`,
  `wallpaperName`, `WALLPAPER_FAMILIES`), `ChatPrefs.wallpaper`/`wallpapers` (`chat-look.ts`); engine
  `packages/engine/src/chat-prefs.ts` (`wallpaperOf`, `assertOwnWallpaper`, `saveConversationWallpaper`),
  `organizations.ts` (`setChatPrefs`, `setConversationWallpaper`), `wallpaper-photos.ts`; routes
  `apps/server/src/routes/app/management.ts` (`…/channels/{channelId}/wallpaper`), `account.ts`
  (`…/me/wallpaper-photo`, `/api/app/wallpapers/{userId}/{file}`); the painting numbers
  `packages/ui/src/sky/wallpaper.ts`; web `apps/web/src/components/ChatWallpaper.tsx`, `WallpaperDialog.tsx`,
  `ConversationMenu.tsx`, `lib/wallpaper-paint.ts`, `chat/look.ts`; phone `apps/mobile/src/features/chat/ChatWallpaper.tsx`,
  `wallpaper-logic.ts`, `wallpaper-photo.ts`, `features/me/WallpaperPage.tsx`, `WallpaperPhotoPage.tsx`; tests
  `apps/server/test/chat-wallpaper.test.ts`, `packages/client/test/wallpaper-lib.test.ts`,
  `packages/ui/test/sky-wallpaper.test.ts`, `apps/mobile/test/features/wallpaper.test.ts`

## Context

People spend the day in their conversations and asked to make them their own: a background behind the messages, as
chat apps let them choose. A conversation is white today; its look (density, bubbles, text size) is already each
person's choice on every device (`chatPrefs`).

## Decision

A background behind a conversation, chosen by each person for themselves.

1. **Whose.** A person's choice in a workspace, on every device, seen by no one else: one background behind every
   conversation (`chatPrefs.wallpaper`), and any conversation of theirs may have its own, which wins
   (`chatPrefs.wallpapers`, by channel id; `{ kind: "none" }` there is "none here", and no entry is "as the others").
   Nothing chosen is no background, the app as it was. One choice for channels and DMs alike: a split by kind read as
   a background that didn't apply.
2. **What.** Five kinds: `sky` (the brand's pixel sky in an agent's color), `drawings` (line drawings in the app's
   icon style, tone on tone, on an even grid), `agents` (the agent symbol many times over, faint, each in its color),
   `color` (one flat color: three quiet neutrals or an agent's color) and `photo` (a photo of one's own). `auto`
   (sky and drawings) is the conversation's color: the agent's in a DM with an agent, the workspace's sky elsewhere.
3. **Legible.** The sky is strong only at the top and at the horizon; drawings and agents barely stand off their page;
   the looks with no bubbles (the words straight on the background) take any background at half strength. Over a
   background someone else's bubble is lifted (white, or a step over the dark page) and every bubble takes the cards'
   light shadow. The dark theme has its own version of each, and a photo darkens by how much its owner chose (`dim`,
   up to 0.8), around the point of interest they dragged to (`x`, `y`).
4. **The API.** `PUT …/me/chat` takes `wallpaper` (never the per-conversation map, which changes one conversation at a
   time); `PUT`/`DELETE …/channels/{channelId}/wallpaper` set and clear a conversation's own, members only. Unknown
   kinds and colors are refused (400). Every change goes to the person's other devices as `chat.prefs` on their topic.
5. **Photos.** Sent like a profile photo (`PUT …/me/wallpaper-photo`: JPEG, PNG or WebP up to 2 MB, checked by its
   bytes, metadata removed; the apps shrink it first), kept in the platform bucket and served only to its owner
   (`GET /api/app/wallpapers/{userId}/{file}`, 404 to anyone else). A background may only use one of its owner's own
   photos (`wallpaper.photo_not_yours`). Sending a photo removes the ones none of the person's backgrounds shows.
6. **One painting.** The numbers (tones, the sky's field and dither, the drawings, the grid, the agents' tints, the
   strength) live once in `packages/ui/src/sky/wallpaper.ts`; the web paints them on a canvas, the phone with Skia,
   each painted once per size, theme and choice and never while the list scrolls.

## Consequences

- No migration: the choices live in `organization_members.chat_prefs` with the rest of the conversation's look.
- On the web the background sits behind the message column and the composer, never the header, the sidebar or the
  members. Choosing is in Settings › Conversations and in a conversation's ⋯ menu (a new header button that holds the
  conversation's right-click actions too); on the phone, You › Conversations and a conversation's options.
- A photo is one more object in the platform bucket per person in use, removed when it stops being shown.
