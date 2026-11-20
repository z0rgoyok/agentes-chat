# 0200. Documents become live files

- Status: Accepted (built)
- Date: 2026-11-17
- Extends: 0196 (live files), 0198 (Office files open in the apps)
- Amends: 0019 (a document is no longer Markdown saved whole as a new version), 0198 ("Edit as document" makes a live
  document)
- Code: `packages/live/src/document/*` (`@agenteschat/live/document`: `DOC_SCHEMA_SPEC`, `DocBlock`,
  `readDocument`/`writeDocument`, `blockElement`/`readBlocks`, `insertBlocks`, `replaceBlocks`, `deleteBlocks`,
  `replaceText`, `rewriteDocument`, `ensureBlockIds`, `markdownToBlocks`, `documentToMarkdown`, `documentPreview`,
  `documentText`, `validateDocument`, `replaceDocument`, `setDocumentSource`), `limits.ts` (`LIVE_LIMITS.document`),
  `kinds.ts`; engine `packages/engine/src/live/document-tools.ts` (`read_document`, `edit_document`),
  `live/document-export.ts` (`documentExport`), `live/preview.ts` (`documentFromMarkdown`, `versionDoc`),
  `artifacts.ts` (`createArtifact` of a document, `adoptMarkdownDocument`), `office/docx-document.ts`
  (`docxToDocument`), `office/docx-write.ts` (`writeDocx`), `live/office.ts` (`openAsLive`, `writeLiveExport`); web
  `apps/web/src/components/live/document/*` (`DocumentEditor`, `docSchema`, `blockIds`, `docPresence`, `DocCover`)

## Context

The Drive has had documents from the start: an agent's report or plan, written in Markdown and saved whole, each
save a new version (ADR 0019). People can't write in one while an agent does, two people saving at once get "someone
saved a newer version", and nothing shows who is changing what. Spreadsheets, presentations and canvases are now
live files people and agents edit together (ADR 0196). A document is the file teams write together most, and the
Wiki already shows what a written page should look like. Keeping a second, older kind of document next to a live one
would give the Drive two things called "Documento" that behave differently.

## Decision

### 1. One kind of document, and it is live

`document` is a live kind (`LIVE_KINDS`, `LIVE_ARTIFACT_KINDS`): one Yjs document per file, synced, versioned and
shared exactly as ADR 0196 says for the other kinds. The Markdown document is gone: there is no other path that
writes one. `create_artifact` with kind `document` (the tool agents already know) and `POST …/artifacts` with a
document's Markdown make a live document from that Markdown; `POST …/live-files` makes an empty one ("Novo ›
Documento"). `updateArtifact` refuses a document like any live file (`artifact.live_only`, naming the tools that
change it). A document saved as Markdown before this change opens as a live document: the first time a process loads
it (a socket, an agent's tool, its first state over HTTP), its latest version's Markdown becomes its live document,
stored once (`adoptMarkdownDocument`); its older versions read and restore from their Markdown (`versionDoc`).
Nothing else changes for those files.

### 2. The document's shape

`meta` as every kind; `body`, a `Y.XmlFragment` in y-prosemirror's encoding of the document schema
(`DOC_SCHEMA_SPEC`, plain data the web turns into a ProseMirror `Schema`): paragraph (alignment, and the rich text's
list model: `list` + `level` on the paragraph), heading 1 to 3, blockquote, code block (a language word),
horizontal rule, image (a picture of the file, ADR 0196 §8, its description and a width as a fraction of the page),
table → row → cell (paragraphs; a header row), line break; marks bold, italic, underline, strike, code, color, link
(https, http, mailto). Every top-level block carries an `id`, so agents, a message's quote
(`liveRef.selection.block`) and an agent's presence (`sel.document`) can name a block. The phone and the server read
and write the same encoding without ProseMirror; tests keep our writer equal to y-prosemirror's, byte for byte,
both ways. What a block may hold and how big a document may grow is `LIVE_LIMITS.document` (20,000 blocks, a million
characters, tables of 1,000 rows by 50 columns), checked on every agent's write and by the server's rules of shape.
A document said to come from an upload keeps its name (`meta.source`), which its preview carries ("Imported from
X.docx").

### 3. Agents write Markdown and change blocks

`read_document` gives the document as Markdown with each block's id first (`[#k3j2h1a9x0] # Title`), paged by
blocks. `edit_document` applies one batch of ops by block id, tried on a copy first so it lands whole or not at all:
insert (after or before a block, at the start or the end), append, replace a block or a span (one block for one of
the same kind changes in place, so a person typing in it keeps their place), delete, replace text (found in place,
its formatting kept), and rewrite (the whole document, blocks that say the same keep their ids and place). Content
is Markdown (CommonMark's blocks, GitHub's tables, `<u>` for underline); a picture is a Drive image (`file:<id>`,
copied in under the agent's own check that it reads it), one of the document's own (`asset:<id>`) or, on a line of
its own, a picture on the web (`![a sky](https://…)`, downloaded into the document as ADR 0196 §8 says; an address
inside a paragraph stays a link). The op `add_image` places one picture as a block (after or before a block, at the
start or the end) the way the canvas and the slides take one: `image`, an SVG the agent writes (`svg`) or a web
picture (`url`), with its alt text. The agent's
face shows on the blocks it works on, as on the other kinds. `read_artifact` still reads a document whole, as its
Markdown.

### 4. Word in and out

An uploaded `.docx` opened to edit (ADR 0198's "Edit as document") becomes a live document read by the same safe
reader as its preview (`readDocx`): headings, paragraphs and their marks, lists by level, tables laid flat, links,
and its pictures stored as the document's own. A document downloads as `.docx` by default (its own writer: headings,
paragraphs with their alignment, numbered and bullet lists by level, quotes, code, rules, tables with a repeating
header row, pictures at the document's width, links and every mark), as `.md` (its title first) or as a PDF (the
Drive's Markdown PDF, without pictures), at its head or at a version.

### 5. The apps meanwhile

Until the web and the phone edit documents, they open one where files open, read-only, from the Markdown the server
sends with it (`content.markdown` beside its `preview`); people don't save a document as whole content any more
(`canEdit` is false for it).

The phone opens a document on its own screen (`/document/<id>`, `apps/mobile/src/features/live-files/document/*`):
the page as the Wiki reads it, everyone else's block flagged with their name (an agent with its face), and a block
edited in place by a tap. Each change typed there is the smallest edit of that block's own `Y.XmlText`s (one delete
and one insert across its texts and line breaks, `document/text.ts`), so two people typing in the same block both keep
their words; untouched words keep their marks, typed words take the marks before the caret (or the format bar's),
bold, italic and links go on the words chosen, and someone else's typing comes in under the caret without moving it.
Return and Delete at a block's start split and join blocks with the block ops (`insertBlocks` with a new id,
`deleteBlocks`); a style or a list changes the block whole (`replaceBlocks`). Pictures and tables are edited on a
computer. Its card draws the first blocks of its preview, and "New" makes one.

The web edits a document on its page (`apps/web/src/components/live/document/*`): the Wiki's page (its title renames
the file; the meta line says who made it, or who imported it from which Word file) over ProseMirror bound to the body
with y-prosemirror (the schema from `DOC_SCHEMA_SPEC`), the person's own undo, people's carets with their names and an
agent's face at the end of the blocks it works on (`sel.document`, lit while it writes), a plugin that names new, split
and pasted top-level blocks (`blockIds`; a block keeps its id when it only changes style), typed Markdown shortcuts and
Markdown pasted as text, links, pictures (uploaded or copied from the Drive into the file's own) and tables without cell
selection (rows, columns and a header row from the toolbar, Tab between cells). What is selected goes over the file's
conversation's composer as its words (at most 200 characters) and their block, with "Ask Atlas" floating over it; a
message's line about the document selects and lights them. Its card draws the first blocks of its preview, "New" makes
one, and it downloads as Word (the default), Markdown or PDF.

## Consequences

- People and agents write in a document at the same time, with presence and versions, and an agent changes one
  paragraph without resending the rest.
- Every document, old ones included, is one kind with one path; the older Markdown versions stay in the history.
- Markdown is now how documents are written and read by agents, not how they are stored: color and a picture's width
  have no Markdown and are kept only in the document itself.
- A Word file's look beyond these blocks (page layout, fonts, footnotes, comments, tracked changes) is left out when
  it becomes a document; the upload keeps it.
