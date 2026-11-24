# 0208. Comments on pictures, videos and PDFs: the file's conversation, with pins

- Status: Accepted (built)
- Date: 2026-11-20
- Extends: 0199 (a live file's conversation), 0196 §8 (a live file's pictures), 0157 (who sees a file), 0040 and 0054
  (the judge's `box` on an image)
- Code: engine `packages/engine/src/live/media.ts` (`mediaOfType`, `mediaKindOf`, `talkKindOf`), `live/conversation.ts`
  (`ensureFileConversation`, `openFileConversation`, `cleanSelection`, `isPinned`, `markWords`, `liveRefLine`,
  `fileConversationBrief`), `live/assets.ts` (`putMarkPicture`, `getAsset`), `artifacts.ts` (`mediaFileOf`),
  `live/resolve.ts` (`resolveComment`, `resolvedOf`), `live/comment-tools.ts` (`createCommentToolSource`,
  `isMediaConversation`), `events.ts` (`message.resolved`), `executor.ts` (the Drive's tools in such a conversation),
  `tools/directory.ts` (`LIVE_FILE_TOOLS`); server `routes/app/live.ts` (`POST …/artifacts/{id}/marks`,
  `POST …/messages/{id}/resolve`), `routes/app/schemas.ts` (`LiveSelection`); client `live/types.ts` (`TalkKind`,
  `FileMediaKind`, `isTalkKind`, `isPinnedSelection`, `resolvedOf`), `live/api.ts` (`uploadMark`, `resolveComment`),
  `api/queries.ts` (`cacheResolved`, `useResolveComment`), `lib/files.ts` (`mediaKindOfType`, `mediaKindOfArtifact`);
  web `components/live/media/*` (`ViewerComments`, `VideoStage`, `PdfStage`, `MediaPins`, `marks.ts`, `ResolveBits`,
  `ViewerBits`), `components/live/talk.ts`, `TalkBits.tsx`, `FileConversation.tsx` (`TalkGrip`),
  `pages/ChannelPage.tsx`, `pages/ThreadPage.tsx` (`headless`), `pages/DrivePage.tsx` (`?m=`),
  `components/artifacts/ArtifactViewer.tsx`, `ImageZoom.tsx` (`overlay`, `marking`, `tools`), `packages/ui`
  `VideoPlayer.tsx` (`onTime`, `onVideo`, `marks`); phone `features/files/ImageViewer.tsx`, `ZoomPicture.tsx`,
  `VideoPlayer.tsx` (`onMoment`), `DocumentViewer.tsx`, `PdfPages.tsx` (`react-native-pdf-light`), `source.ts`
  (`pdfCopy`), `features/live-files/talk/*` (`PicturePins`, `logic.ts`, `store.ts` (`showTalkSheet`, `askTalkSheet`),
  `TalkSheet.tsx` (`FileTalkSheet`), `TalkLine.tsx`), `app/(app)/file-talk/[channelId].tsx`, `app/(app)/_layout.tsx`
  (`fileTalk`), `features/chat/ChatScreen.tsx` (`sheet`), `features/chat/screen/sheet-mode.tsx`,
  `features/chat/sheets.tsx`

## Context

A picture, a video or a PDF posted in a conversation or kept in the Drive opened only in the viewer: people talked
about it in the channel, out of sight of the file, and had no way to say "here". Live files already have a
conversation of their own beside them, with a canvas comment pinned where it points (ADR 0199). People want the same
on what they upload, the way a design tool or a spreadsheet keeps comments on the file: a pin on the place, the
people and the agents answering beside it, and the comment closed once handled. An agent asked about a place has to
see that place, and no model here watches a video (`file-reader.ts`).

## Decision

### 1. One conversation per file, a comment is one of its messages

A `file` artifact whose current version is a picture (PNG, JPEG, GIF, WebP), a video (MP4, WebM, QuickTime) or a PDF
(`mediaOfType`, the list the apps preview) gets the file conversation of ADR 0199 unchanged: its own `file` channel
and hidden root, made on first use, read by whoever reads the file, agents admitted the same way. Its root and its
messages' `liveRef` name what it is (`kind` `image`, `video` or `pdf`, the conversation's `TalkKind`) rather than the
artifact's kind. Any other upload still has none (`artifact.no_conversation`).

A comment is a message of that conversation whose `meta.liveRef.selection` points at a place (`isPinned`):

- `mark`: a point (`x`, `y`) or an area (`x`, `y`, `w`, `h`), in fractions of the picture, of the video's frame or
  of the PDF's page, rounded to a ten-thousandth, an area kept inside the picture;
- `time`: a video's moment, in seconds; `page`: a PDF's page, from 1;
- `version`: the file's version it was made on (a newer version shows the older pins faded);
- `crop`, `frame`: the app's two pictures of the place (§2);
- `label`: its pin's number as the app wrote it.

There is no thread per pin: the conversation reads as one, pins number its comments oldest first (the apps and the
agents count the same way), and a message that names no place is about the file as a whole. One model for live files
and uploads, nothing new to store but the pictures.

### 2. The app's pictures of the place

What the person sees is the only picture of a video's moment or of a drawn PDF page, and a crop reads better than a
whole picture with coordinates. So the web app takes two small JPEGs when a place is marked: the crop of the area (or
of a window around a point), at most 800 pixels wide, and the whole picture, frame or page with the mark drawn, at
most 1024. They go up only with the message (`prepareAbout`, the send waits at most 8 s and goes without them past
it), to `POST …/artifacts/{id}/marks`: a reader of the file stores them as the file's pictures (`live_assets`, source
`mark`, PNG, JPEG or WebP by its bytes, at most 2 MB, counted in the workspace's storage, purged with the file), and
the message names them. They are served like a live file's pictures (`GET …/assets/{assetId}`) to whoever reads the
file, and the conversation's line shows the crop as a thumbnail. The phone sends none: its comments carry the place
alone.

### 3. Resolved

`POST …/messages/{id}/resolve` (`resolved` true or false), by whoever writes in the conversation, and the agent's
`resolve_comment`, set or clear `meta.resolved` (`by`, `at`) on a comment with a pin; anything else is
`message.not_comment`. The message stays where it is with "Resolved by … · time" under it; its pin leaves the file
until "N resolved" shows them again, faded. Everyone in the conversation gets `message.resolved`. Resolving twice
keeps the first.

### 4. What the agent sees and does

A run in such a conversation gets the file's brief (what it is, that comments point at places, the tools below) and
the Drive's tools as well as the `files` group, so it reads the picture or the PDF with `read_artifact`. Under each
comment its line says where it points in words (`markWords`: page, moment, the area in percentages, the version) and
names its pictures. Three tools, listed only there (`createCommentToolSource`, behind the channel's cached kind):

- `look_at_comment`: the comment's two pictures, where it points and its words (as outside text), by its number or
  the id its line gives;
- `comment_on_file`: the agent's own comment with a pin, posted as its answer (like a GIF, an empty reply after it
  posts nothing); on a picture a `target` in words is placed by the judge's `box` (Jev), else the agent gives `x`,
  `y` (and `w`, `h`), on a video a `time`, on a PDF a `page`;
- `resolve_comment`: by its number.

### 5. The apps

On the web everything happens in the viewer, where a picture, a video or a PDF opens from the chat or the Drive; it
has no page of its own. The viewer shows its open comments' pins over the file (their words on hover) and one
"Comments N" in its header, which opens the file's conversation as the viewer's right column: the card a live file's
conversation is (ADR 0199 §6), sized by the same handle and to the same width, with no header of its own. With it
open, a click on the file marks a point and a drag an area (the zoom's bar says so; the wheel, a pinch and the bar
still zoom), and the composer gets "About area 4 of the image" with the crop; closed, a click zooms as before and a
pin opens it at that comment. A video plays in our player with its comments as marks over the timeline; marking
pauses it at that moment (and a point or an area of the frame). A PDF is drawn by pdf.js (Apache-2.0, loaded only
when one opens), a page read and drawn as it comes near and let go when it goes far, the viewer as tall as a
picture's; a comment marks a page and a point or an area of it, and the versions give way to the conversation while
it is open. Narrow, the conversation takes the whole viewer and "Comments" goes back to the file. A file that already
has comments opens with them beside it, as it stood when it opened: one arriving later never moves the file under
whoever is looking at it, and closing them is the person's.

Under a file with comments the chat shows their line (who, how many, when), the thread line's look; it opens the
viewer with the comments open, as does a link to one (the Drive's `?artifact=…&m=…`; the file's page address of a
live file, `/drive/<id>?m=…`, sends a picture, a video or a PDF there). The phone's chat shows the same line under
the file; a tap opens the file, its conversation's line under it. The line counts a new comment at once for everyone
there: after a message in a file's conversation, the conversation the file was posted in hears `artifact.updated`
(`announceFileConversation`, with the task's in the `notifications.message` job), and its card reads the file again.

The phone opens a file's conversation the same way for every file, a picture, a video, a PDF and a live file alike:
the file's talk line is the one way in, and the conversation comes up in the system's sheet over the file (a route
sheet, `file-talk/[channelId]`), at half the screen with nothing behind it dimmed, so the file stays in sight and in
reach above it; pulled up it fills the screen and dims the file, down it goes. The sheet holds the conversation
itself (the chat in its sheet mode: the sheet's bar with the title and ×, the messages, the composer with the file's
quote); the keyboard raises the sheet as the person types, on the keyboard's own curve, and lowers it when it goes
(sent to the full height as well, the sheet moved twice at once and the dimmed full height shrank the file behind it).
The file behind follows the sheet through
a small store (which file it is over, at which height, how much of the screen it takes): the sheet slides over the
picture, which keeps its size and place (laid out anew above the sheet, it jumped as the sheet came up and moved), the
viewer hides its line and actions, and a tap on the picture marks a point (the quote "About point 4 of the
image", the person's pin on the spot); a video pauses and a tap on its frame marks that moment and that point, the
comments made near the moment pinned on the frame (the system's player draws its own timeline, so they are not on
it); a PDF is drawn page by page by the system's renderer (`react-native-pdf-light`, on Android too, where the web
view had none) and a tap marks a page and a point; a live file keeps the sheet's room under its content and its own
tools. Pins open the sheet at their message; a message's line about the file brings the sheet down to show it; a
link or a notice to one of the messages opens the file with the sheet at it. Resolve and Reopen are in the message's
menu.

## Consequences

- Uploads and live files share one conversation model, one `liveRef` and one set of screens; the selection grows by
  six optional fields.
- Comments made on the web carry two small pictures each, stored with the file; a comment dropped before it is sent
  stores nothing.
- The web app gains pdf.js, out of its first load (about 136 KB, and its worker about 379 KB, compressed, once).
- A video's comment is as good as the frame the person marked: the agent still never watches the video.
- Phone comments carry no pictures and no areas; their agents read the file itself.
- The phone gains `react-native-pdf-light` (MIT, native renderers, no web view) for PDFs; there is no pinch zoom on a
  PDF's pages, so its pins stand where the page is laid out.

## Addendum (2026-11-22): the phone pushes the conversation

The sheet over the file loaded heavily and moved as it came up, the keyboard and the file behind each moving with it.
The phone now pushes a file's conversation as a screen of the stack, the conversation as every other one is (the
thread at its root, the stack's bar and back), for every kind of file; the route sheet, its store and the chat's sheet
mode are gone. The picture viewer is a screen of the stack too (faded in, black), not a modal: what is pushed from it
shows over it, and its back comes back to the picture (a message's line about the picture, tapped in the
conversation, goes back to the viewer on that page rather than opening a second one). With no sheet to tap through, a
touch held on a picture or a PDF's page marks the point and pushes the conversation about it, the person's pin left on
the spot while the comment is unsent; a video's frame stays the system player's, and a video that has played opens its
conversation about the moment it is at. A video's frame no longer shows the pins made near its moment.
