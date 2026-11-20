# 0196. Live files: spreadsheets, presentations and canvases people and agents edit together

- Status: Accepted
- Date: 2026-11-17
- Amends: 0019 (artifacts, versions), 0010 (realtime: a socket of its own for documents), 0157 (who sees a file is
  also who edits a live file)
- Code: `packages/live` (`@agenteschat/live`: the documents' shape, formulas, number formats, rich text, the sync
  protocol, presence), engine `packages/engine/src/live/*` (`createLiveDocs`, tools, assets, checkpoints), server
  `apps/server/src/realtime/live.ts` (`/api/live`) and `apps/server/src/routes/app/live.ts`, client
  `packages/client/src/live/*`, web `apps/web/src/components/live/*` and the route `org.$orgId.drive_.$fileId`,
  phone `apps/mobile/src/features/live-files/*`; tables `live_docs`, `live_doc_updates`, `live_assets`; pictures an
  agent draws or finds (§8): `live/svg.ts` (`sanitizeSvg`, `rasterPicture`), `live/web-pictures.ts`
  (`fetchWebPicture`), `live/pictures.ts`, `image_search` in `web-tools.ts`, migration `0300_live_files`

## Context

The Drive keeps what agents and people make, but a file there is a finished thing: a document or a table is saved
whole as a new version, two people saving at once get "someone saved a newer version", and the only things that
change while you look are polls and blocks. People who work with agents want the files they share to be the place
where the work happens: a spreadsheet the team and an agent fill in at once, a presentation built while everyone
watches, a canvas where the images an agent makes for a campaign land side by side, next to the notes and frames
people arrange them in. They also want to see who is in the file now, who is changing what, and the agent's hand
at work, the way they see an agent's cursor in its browser (ADR 0040).

## Decision

### 1. Three new kinds of file, and what stays the same

`spreadsheet`, `slides` and `canvas` are artifact kinds (`artifact_kind` enum, migration in this change), in the
Drive (`in_drive` true), never untrusted: what they hold is data the apps draw with their own components, and any
agent-written page on a canvas is a separate `html` file drawn in the isolated frame of ADR 0019. Everything an
artifact already has keeps working unchanged for them: where it lives and who sees it (`personCanRead`, the
sharing of ADR 0157, an agent's reach), the trash, search, links (`filePath`), cards in messages
(`meta.artifacts`), the audit log.

**Who edits.** Whoever reads a live file edits it, as with documents and tables today (`writable` equals `readable`
for people). Viewer and editor levels stay out, as ADR 0157 left them. The socket still knows two modes, `edit` and
`view`, so a workspace being deleted (`closedRefusal`) or a file in the trash is read-only without a second path.
Agents write where they reach (`agentReaches`), as with every Drive write.

### 2. The document is a CRDT, shared by every app and the server

Each live file is one Yjs document (MIT, `yjs` + `y-protocols` + `lib0`). Concurrent edits merge without a lock or
a "newer version" error, offline edits sync when the connection comes back, and the same code runs in the browser,
the desktop app, the phone (Hermes, with `crypto.getRandomValues` from `expo-crypto` through a Metro alias of
`lib0/webcrypto`) and the server.

`@agenteschat/live` (pure TypeScript, no DOM, no React) holds everything all of them must agree on:

- **Spreadsheet.** Sheets in order (`sheetOrder`, `sheets`), each with its rows and columns as arrays of ids and its
  cells in a map keyed `rowId:colId`. A cell is one plain object replaced whole (`v` a value or `f` a formula, `s`
  its style), so the last writer wins per cell and two people never mix halves of one. Rows and columns are ids,
  not numbers, so a row inserted by one person while another types below it moves the second one's cell with its
  row. Column widths, row heights, merges and frozen panes are kept by id too.
- **Formulas** are stored by ids, never by A1 addresses: `SUM({r8k2,c3xa}:{r9b1,c3xa})`. A1 is only how they are
  shown and typed, worked out from the current order, so an insert anywhere never breaks a reference, a range
  grows when rows are added inside it, and a deleted row turns references to it into `#REF!`, as in other
  spreadsheets. Our own engine evaluates them (a permissively licensed one with Excel's syntax doesn't exist, and
  the GPL ones can't come in, ADR 0180): around 200 functions with Excel's names and behavior, ranges, absolute
  references, cross-sheet references, a dependency graph that recomputes only what changed, cycle detection and a
  step budget. Each app computes values itself; values are never stored, so nothing two people compute can
  disagree in the document. `RAND` is seeded per cell from the document, so everyone sees the same numbers.
  Formulas are typed and shown in the person's language: in Portuguese `=SOMA(B2:B9;C2)` with Excel's Brazilian
  names, the semicolon and the decimal comma; the English names are always accepted too.
- **Number formats** follow Excel's format codes (`#,##0.00`, `0%`, `"R$" #,##0.00`, `dd/mm/yyyy`…), shown with the
  reader's separators, so a file imported from Excel keeps its look.
- **Slides.** The deck's theme and size (1920×1080 units), the slides in order, each with a layout, a background,
  speaker notes and elements (text, shape, image, chart, table) placed in slide units. Text is rich text
  (paragraphs with alignment, levels and lists; bold, italic, underline, strike, color, link) kept as a
  `Y.XmlFragment` in the ProseMirror encoding of `y-prosemirror`, so the web edits it with ProseMirror and live
  text cursors, while the phone and the server read and write it with our own reader and writer, which tests keep
  equal to `y-prosemirror`'s.
- **Canvas.** Shapes in a map: images, notes, text, frames, shapes, arrows and lines, pen strokes, a file's card,
  an agent's page (an `html` file) and a placeholder for an image being generated. Each has a position and size in
  world units, a stacking key (fractional indexing, so two people bringing things forward never collide), the frame
  it sits in, who made it (`by`: a person or an agent, set from the change's origin when it is made; the apps' own
  edits name the person) and whether it is hidden (the layers' eye: kept and read, never drawn, left out of covers).
  - A shape is a rectangle, an ellipse, a diamond, a triangle or a star, with a fill, a border's color and width
    (1–24) and, on a rectangle, a corner radius (0–200).
  - An arrow runs between two shapes (it follows them) or free points, straight, curved or in right angles, with a
    head at either end or none: a line is an arrow without heads. It may be dashed, and has a color and a width.
  - A pen stroke (`draw`) is its points (x, y pairs from its box's corner, at most 4,000 numbers), a color, a width
    and its tool, the pen or the marker (wide, 40% opacity). Its box is its points' extent: stretching the box
    stretches the stroke. People draw them; agents rarely do.
  - A picture may show part of itself (`crop`: fractions of the natural picture).
  - Comments pinned on the canvas aren't shapes: they are messages of the file's conversation that point at a spot
    (ADR 0199).
  - A document written before any of these fields reads as before: what isn't there is the default.
- **Rules of shape** (`validate*`) and limits (`LIVE_LIMITS`: sheets, rows, columns, cells, slides, elements,
  shapes, bytes): the server refuses an update that would break them, so a buggy or hostile client can't leave a
  document no app can open.

### 3. A socket of its own per open file

`GET /api/live?orgId=…&fileId=…` upgrades to a WebSocket that carries only that file (ADR 0010's `/api/ws` stays
for chat): binary frames in y-websocket's framing (sync step 1 and 2, updates, awareness), JSON text frames for
control (`live.ready` with the mode, `live.mode` when access changes in place, `live.saved`, `live.error`), and
base64 text frames when the phone asks with `text=1`, since React Native turns binary frames into base64 in
JavaScript anyway. The upgrade is checked like every person socket (`personUpgrade`: origin or the phone's header,
session, membership, standing), then the file (`liveFileAccess`: read, and the mode). The first state comes over
HTTP as bytes (`GET …/artifacts/{id}/live`), so a large file never waits behind the socket, and the socket only
catches up from its state vector.

An app counts its changes as unsent until the server says they are stored: `live.saved` ("everything
this socket sent up to now is stored") goes only once none of the socket's frames still waits in its line, and the
pong to an app's ping, which waits in that line behind the frames sent before it, says `unsaved` while what they
brought still waits to be stored. A change that waits on another one the hosting process doesn't hold yet (Yjs
keeps it aside) is stored as it came, so it never depends on that process staying up.

While it is open the server checks the session every 15 seconds and the file every 30, and at once on
`membership.revoked`, the file's sharing changing, the file going to the trash and the workspace closing. A frame
is at most 1 MiB, a socket sends at most 512 KiB a second, a person opens at most 30 sockets a minute and keeps 12
open, the server pings every 30 seconds and closes a socket that falls 8 MiB behind (1013). Close codes are the
streams' (`4400`, `4403`, `4404`, `4429`, `1013`, `1001`, `1011`); the apps reconnect after any but 4403 and 4404.

### 4. Postgres keeps every change; NOTIFY tells the other processes

A document has a compacted state and a log of the changes after it (`live_docs`, `live_doc_updates`, base64 text
like every other byte column here). Updates from one socket are merged for up to 40 ms into one row, numbered under
the document's row lock (`head_seq`), and published after the commit on `liveTopic(fileId)` with the update inline
when it fits NOTIFY's 7900 bytes, else its number alone. Every process that holds sockets of that document applies
it (or reads the numbers it missed), skips its own, and reads the tail every 10 seconds anyway, since NOTIFY is
best effort. So nothing depends on which replica a socket landed on, and an agent's tool running in a worker
process edits the same document. A job compacts the log into the state once it holds 200 changes or 512 KiB, and
when the last socket closes.

### 5. Presence: who is here, who is editing, and where

Presence is Yjs awareness, never stored. The server owns identity: it binds each awareness client id to the socket
that first used it, drops states that claim another's, writes the person's id and kind over what the client sent,
caps a state at 4 KiB and turns `mode` into `viewing` on a read-only socket. A person whose availability is hidden
(ADR 0084) is not shown to others in a file either: their edits still arrive, their presence doesn't.

What a state says: who (person or agent), `viewing` or `editing`, where (the sheet, the slide), the selection (a
cell range, slide elements, canvas shapes), the pointer (canvas and slide units), the viewport (to follow someone),
`presenting` (a slide), whom they follow, and for an agent what it is doing (a message key with its parameters,
words the apps translate). The apps draw a stack of faces in the file's header (people as circles, agents with
their living face while they work), the text "editando B4:D10" or "no slide 3" in the person's color, each one's
selection and cursor with their name, and Follow, which moves your view with theirs. People get a stable color from
a palette of ten (`peerColor`), chosen to stand apart from each other and from the agents' own colors.

### 6. Agents are participants

Agents edit through tools, never a socket. `create_spreadsheet`, `read_spreadsheet`, `edit_spreadsheet`,
`create_presentation`, `read_presentation`, `edit_presentation`, `create_canvas`, `read_canvas`, `edit_canvas`
(reads under `drive:read`, writes under `drive:write`, a tool group of their own) take compact batches of
operations in A1 and plain words, apply each batch as one transaction whose origin is the agent and its run, and
publish the agent's presence from whatever process runs the tool: its face in the header, "escrevendo em B2:D40",
its cursor gliding to the cells, the slide or the shape it works on (the glide of ADR 0040's cursor). A large
write lands in steps over at most three seconds, so people see it being filled in. Undo in the apps only ever
undoes the person's own changes (`UndoManager` tracking local origins), never an agent's. What an agent reads of a
live file comes through `untrustedBlock`, like any text people typed.

On a canvas, `edit_canvas` adds every kind of shape, lines between points and, when asked, pen strokes, and restyles
what is there (`style`: fill, border, corners, form, route, heads, crop, hidden); `read_canvas` says each shape's
look and who made it (the workspace's people and other agents; never a name a client wrote), and reads pen strokes as
people's marks pointing at what they cover. `create_canvas` may start with pictures the agent reads (`images`: picture
files, such as the ones posted in the conversation), checked and copied into the new canvas before it is made (§8),
side by side in the order given, so "make a canvas with the third image" is one call.

People ask an agent from inside the file: Ask an agent sends a message to it, in the file's conversation (a DM
when the file lives in the shared Drive), carrying the file and a description of the selection
(`meta.liveRef`), and the agent's tools act on that file while everyone in it watches.

### 7. Versions are checkpoints

`artifact_versions` keeps snapshots of the document (the Yjs state as one blob, `application/vnd.agentes.live`),
written by `insertVersion` as any version: when the file is made; when an agent's batch of changes lands, at most
once a minute per agent and file, with the run (so every rule that reads a version's run, like `filesOfRun` and the
hand-off cards, keeps working); after five quiet minutes of people's changes, at most every 30 minutes while they
go on; when someone saves a version with a name; and when one is restored. A snapshot equal to the last one is
skipped. The history lists them with who changed what; restoring writes the old content into the live document as
one change, so everyone in it sees the file go back, and records a version saying so. `GET …/artifacts/{id}` with
no version returns the head; `content` for these kinds is a small preview (the top-left cells, the first slide,
the canvas's biggest shapes, hidden ones left out, a pen stroke's points thinned) that cards and the Drive draw,
never the whole document. It is refreshed with the compaction and, so a card shows what an agent just drew within
seconds, by the process holding the document 2.5 seconds after its changes are stored (once per span, written only
when it changed, one at a time per document), which then tells the file's conversation (`artifact.updated`) so its
cards read the file again. Exports turn the head into `xlsx` or `csv`, `pptx` and
`pdf`.

### 8. Pictures belong to the file

Images on a canvas or a slide are assets of that file (`live_assets`: blob, type, size, hash, dimensions, where it
came from), stored through the workspace's storage (ADR 0019) and counted in its storage, served only to whoever
reads the file (`GET …/artifacts/{id}/assets/{assetId}`, immutable, sandboxed type headers) and purged with it. So
an image someone drops or an agent generates is seen by exactly who sees the canvas, also after it is shared, and a
picture taken from elsewhere in the Drive is copied in under the reader's check of where it came from.

*Amended 2026-11-17: pictures an agent draws or finds.* Asked to "draw a computer icon", an agent built one out of
rectangles and ellipses; asked for "a picture of a sky", it had nothing to place. The edit tools now take a picture
three ways, on a canvas, on a slide (an image element) and in a document (an image block), with `add_image`:

- `image`: a Drive picture's file id or one of the file's own assets, as before.
- `svg`: an SVG the agent writes, for icons, logos, diagrams and simple illustrations. What is stored is never the
  text sent: it is parsed (a document type with declarations, the way to entity bombs and outside files, is refused
  first) and rebuilt from an allowlist of SVG's static drawing elements and attributes, so scripts, event handlers,
  `foreignObject`, embedded or linked pictures, animations, links, any address that isn't a reference inside the
  picture (`#id`), CSS at-rules, escapes and outside references go, and the agent is told what was left out. Sizes
  are capped (1 MB of text, 10,000 elements 48 deep, 300,000 characters per attribute, 50,000 elements drawn once
  `<use>` is expanded, which also refuses a `<use>` that draws itself). It is written with explicit `width`, `height`
  and `viewBox`, its natural size between 512 and 4096 on its longer side, and stored as `image/svg+xml` (source
  `drawn`). The same sanitizer takes an SVG a person uploads or one downloaded from the web.
- `url`: a picture on the public web, typically one `image_search` found (Brave's image search with
  `BRAVE_SEARCH_API_KEY`, SearXNG's images with `SEARXNG_URL`, else Wikimedia Commons, which needs no key and gives
  each picture's author and license; one usage row per search, like `web_search`, ADR 0109). It passes the outbound
  check (ADR 0117) and is downloaded by the server one GET at a time through the public-address guard (https only,
  every address the host resolves to public, the socket pinned), each redirect checked the same way, at most 15 MB
  read while it streams, and kept only when the server calls it a picture and its bytes are a PNG, JPEG, WebP or GIF
  (or an SVG, sanitized). It is stored with where it came from (`live_assets.origin`: its address and the credit the
  agent gave, author and license) and the audit row says it too.

`alt` gives the placed picture its alt text (an SVG's own `<title>` when none is given). The agent sees a web
picture it placed, so it can tell whether it fits. The apps only ever show an SVG as a picture (`<img>`, an SVG
`<image>`, the phone's image view), where nothing runs or loads, and the server serves it with `nosniff` and
`default-src 'none'; style-src 'unsafe-inline'; sandbox`. What can't take an SVG (a model looking at a picture,
references sent to an image AI, Word, PowerPoint and our PDFs) gets a PNG drawn from it when the server has a
rasterizer (`setSvgRasterizer`), and leaves it out otherwise.

Which picture, as the tools and the prompt say it: an SVG for icons, logos, diagrams and simple illustrations; a
picture from the web when someone asks for a real photo or a specific existing image; `generate_image` (ADR 0197) for
new artwork or photos where the workspace has an image model; shapes and notes only for a diagram people will keep
editing piece by piece.

### 9. Where they open

The web opens a live file on a page of its own, without the sidebar (`/org/<org>/drive/<id>`); every link to a file
stays `filePath`, and the Drive sends live kinds to that page. The desktop app is the same page. The phone opens
pushed screens of its own for each kind, with the same presence, light editing (cells, a slide's text and order,
moving, adding and drawing on the canvas, a document's blocks) and follow mode; pictures come from the agents in the
file's conversation (ADR 0199). The Drive's New menu makes each kind, and the
three kinds join the Drive's filters, its cards and message cards with a live preview and the faces of who is in.

## Consequences

- Concurrent editing has no conflicts to resolve and works offline, at the price of a CRDT library in every app
  (about 70 KB) and a document that only grows between compactions.
- Every change is a database row before anyone else sees it, so a file survives any process dying, and replicas
  need no affinity; the cost is one row and one NOTIFY per 40 ms per active file.
- Values are computed on every device, not stored: a formula's value can't be read without the engine, which is
  why the server runs the same engine for agents, exports and previews.
- Presence is ephemeral and per process: a process that dies takes its sockets' presence with it until the apps
  reconnect elsewhere.
- Viewer and editor levels, comments anchored to a cell or a shape, charts inside a spreadsheet and dynamic arrays
  are left for later.
