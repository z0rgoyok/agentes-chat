# 0220. Type, fonts and native layouts in live files

- Status: Proposed
- Date: 2026-11-24
- Amends: 0196 (rich text marks, slide and canvas styles, groups, fonts as file assets), 0200 (document marks and
  fonts)
- Code: `packages/live/src/fonts.ts` (`FONT_CATALOG`, `FontRef`), `packages/live/src/rich/*` (the new marks and
  paragraph spacing), `slides/*`, `canvas/*`, `document/*`; fonts built by `scripts/fonts/build.py` from
  `scripts/fonts/fonts.lock.json` into `FONTS_DIR`, served at `/api/fonts/*`; engine `packages/engine/src/live/layout/*`
  (`add_html`), `live/look.ts` (what an agent sees of its edit), `live/file-fonts.ts` and `fonts/*` (fonts from the
  Drive, reading and measuring fonts, embedding rights), the exports in `office/pptx-write.ts`, `office/docx-write.ts`
  and `office/slides-pdf.ts`

## Context

Live files couldn't hold a designed piece. A canvas drew every text box in the app's default font, one size and one
weight per box, so a card's title weighed as much as its body, and there was no room for an icon inside a card.
Presentations were tighter still: two fonts (the theme's heading and body), weights 400, 600 and 700, and no free text
box, shape, move or style through `edit_presentation`. Documents had the same marks as slides and no font of their own.

An agent asked for a slide or a diagram in a company's look had one way out: write it as a web page on a computer,
take a screenshot with a headless browser and place the picture in the file. It looks right, but nobody can change a
word in it, every change ("wider", "a badge on this card", "rename this column") means a new picture, and the agent
only sees its own picture, never the file.

The fix is not a better picture: it is letting the native files hold what the picture held, and letting the agent
build it the way it already knows how.

## Decision

### 1. Fonts the server ships

A catalog of 44 families ships with the server (`FONT_CATALOG`, plain data every app reads: id, family, category,
weights, italics, scripts):

- Sans: Source Sans 3, Onest, Inter, Geist, Manrope, DM Sans, Plus Jakarta Sans, Outfit, Figtree, Work Sans,
  Roboto, Open Sans, Montserrat, Poppins, Nunito, Rubik, Space Grotesk, Sora, Instrument Sans.
- Serif: Fraunces, Source Serif 4, Newsreader, EB Garamond, Literata, Crimson Pro, Instrument Serif, Roboto Slab.
- Display: Funnel Display, Bricolage Grotesque, Syne, Anton, Bebas Neue, Archivo Black, Unbounded, Oswald, Doto.
- Mono: JetBrains Mono, Martian Mono, Geist Mono, Fira Code, Space Mono, DM Mono, Roboto Mono.
- Handwriting: Caveat.

**Licenses.** Every family is under the SIL Open Font License 1.1 with no Reserved Font Name, except Roboto Slab
(Apache 2.0) and Source Sans 3 (OFL with the reserved name "Source"). Both licenses allow bundling with any software,
serving to browsers and embedding in documents; the fonts stay under their own license beside the AGPL code (and
beside the commercial license of ADR 0180). A family with a reserved name may only be shipped as its authors' own
files, so Source Sans 3 goes as Adobe's files, unchanged; the others are subset and converted freely. Families
with a reserved name were left out for that reason (among them Lato, Lora, Merriweather, Playfair Display, Raleway,
Libre Baskerville, Lexend, IBM Plex and DM Serif Display), as were licenses that aren't OFL or Apache. Each family's
license text ships beside its files and in `NOTICE`.

**Files.** `scripts/fonts/build.py` (Python with fontTools, run in the image build) downloads each family from a
pinned commit of the `google/fonts` repository (Source Sans 3 from Adobe's release), checks every file against the
SHA-256 in `fonts.lock.json`, and writes to `FONTS_DIR`: a WOFF2 per family and style for browsers (the variable
file, every script it has), static TrueType instances cut to Latin (every 100 from 300 to 800 the family covers, and
italic 400 and 700) for the server's measuring, pictures and PDFs and for the phone, and `catalog.json`. About 36 MB;
the build stage is cached until the lock or the script changes. The server serves them at `/api/fonts/<id>/<file>` with a year's immutable cache;
they hold no workspace data, so they need no session. Without `FONTS_DIR` (tests, development) the catalog still
lists them and every app falls back to its system fonts. Chinese, Japanese and Korean text falls back to the system's
fonts, as today.

### 2. A workspace's own fonts come from the Drive

A person or an agent uploads a `.ttf`, `.otf` or `.woff` to the Drive like any file (`.woff2` isn't taken: its tables
need a decoder the server doesn't carry). The upload is checked before it is kept (`readFont`): at most 10 MB, a
font the server can parse, its tables within bounds. A person brings one into a file from the font list ("Bring a
font from the Drive", the Drive's picker showing only fonts); an agent with `add_font {font_file}`. The file's own
fonts then show in its font list under their family names (`GET …/artifacts/{id}/fonts`).

Using one in a live file copies it into the file's assets (ADR 0196 §8), under the reader's check that they can read
it, like a picture from the Drive: the file refers to it as `asset:<id>`, so whoever opens the file draws it right,
also when the font sits in one person's private Drive, and the font goes away with the file. What the font is (its
family and style names, weight, slant and embedding rights) is kept with it (`live_assets.font`), so people and
agents name it by its family. The apps load it through
the file's asset route, with `nosniff` and the font's own type.

Exports respect the font's embedding rights (`OS/2.fsType`): a font marked restricted is never embedded in a PDF,
PowerPoint or Word file; that text falls back to the theme's font and the export says so. The upload says, in one
line, that the workspace needs the right to use that font on the web and in documents.

### 3. What the files hold

All in `@agenteschat/live`, read and written the same way by the web, the phone and the server. A font is a
`FontRef`: a catalog id (`inter`), a file's font (`asset:<id>`) or a theme role (`heading`, `body`).

- **Rich text** (slides, canvas, the document's paragraphs) gains marks: `font`, `size`, `weight` (100 to 900),
  `highlight` (a background color), `tracking` (letter spacing, in thousandths of the size) and `caps`. Paragraphs
  gain `lineHeight` and `spaceAfter`. An app that doesn't know a mark leaves it out when it reads, so older apps keep
  opening newer files.
- **Slides.** A deck may set its own fonts over the theme's (`fonts: { heading, body }`). An element's style gains
  `font` as any `FontRef`, any weight, `lineHeight`, `tracking`, `caps`, `padding`, `shadow`, `gradient` (two colors
  and an angle) and `dash`. Elements may share a `group`: they select, move and scale together, and a group may sit
  in a group.
- **Canvas.** Every shape that holds text (text, note, shape, frame title) takes the same text style: font, size,
  weight, color, alignment, vertical alignment, padding, line height, tracking, caps. Shapes gain `shadow`,
  `gradient` and `dash`, and may share a `group` like slide elements (frames still contain, groups only hold
  together).
- **Documents** gain the same marks and a document's own fonts for headings and body (`meta.fonts`).

The limits and the server's rules of shape (`validate*`, `LIVE_LIMITS`) cover the new fields like the old ones.

### 4. Agents build natively, in the language they write best

The edit tools take the new fields as ops (`style`, `group`, `ungroup`, `add_text`, `add_shape` on slides), and each
takes `add_html`: a fragment of HTML and CSS the server lays out and turns into native pieces, never a picture.

- It reads markup as agents write it for a browser: a fragment or a whole page (its head's `<style>` included),
  custom properties on `:root` with `var()`, `::before`/`::after` content, `@font-face` names (matched to the catalog
  by the font file's name).
- Layout is CSS flexbox, grid (column tracks in px, `fr`, `repeat()`, `minmax()`; spans) and block flow computed with
  Yoga (MIT) and the fonts' real metrics, so a line wraps where a browser would wrap it.
- Each box with a background, border, radius or shadow becomes a shape; each run of text a text box with its marks;
  each `<img>` (a Drive picture or the file's own) and inline `<svg>` (sanitized as ADR 0196 §8) a picture. Icons
  come from the app's own set (`icon:<name>`, drawn in the CSS color around them). What one box held becomes one group,
  named after its `id` or `data-name`, so "the pricing card" can be found and changed later.
- `data-arrow-to="<id>"` asks for an arrow between two boxes: a connector that follows its shapes on a canvas, a
  line with a head on a slide.
- On slides, `add_html` fills a box (the whole slide when none is given); on a canvas it goes at a point, in a frame;
  in a document it becomes blocks (headings, paragraphs with their marks, pictures, tables).
- CSS it doesn't support (floats, absolute positioning past one box, transforms, filters, animations, web fonts by
  address) is ignored, and the result says what was left out. Fonts are `font-family` names from the
  catalog or the file's fonts.

### 5. Agents see what they built

Every edit's result carries a picture of what changed: the slide, or the region of the canvas around the shapes it
touched, drawn by the server from the native document with the same fonts (an SVG from the model, rasterized with
resvg as in ADR 0196 §8). The agent checks cut text and alignment before it says it is done, instead of saying it
only saw its own picture.

### 6. The prompt

Placing a picture of text, a screenshot of a page or a rendered slide in a live file is what the tools tell agents
not to do: a live file is built from its own pieces. When the workspace has its own fonts in the Drive, an agent
asked for the brand uses them.

### 7. Exports

PDF embeds each font and weight a slide uses, as subsets (the static instances; a file's own TrueType font when its
rights allow, an OpenType one falls back to the engine's font). PowerPoint and Word name each run's typeface (a file's
own font under its family name), with its size, weight, letter spacing, capitals and highlight; they don't embed the
fonts, so a computer without one shows its own substitute. Shadows, gradients and dashes go into PowerPoint as its
own effects. A document's PDF stays the Drive's Markdown PDF.

### 8. The apps

The web and the desktop app load a font when a file uses it (`@font-face` from `/api/fonts` or the file's asset
route); the phone loads the static files with `expo-font`.

People change fonts and the new text styles from the toolbars of slides, canvases and documents, the same controls
in the three (`apps/web/src/components/live/type/`), chosen among three prototyped directions:

- A font list beside the size: a search, then the file's heading and text fonts (a canvas, which has none, lists the
  fonts it already uses), the company's fonts brought into the file, and the catalog by kind, each name in its own
  face (loaded when the list opens). Under it, the file's own heading and text fonts (a dialog, presentations and
  documents) and bringing a font from the Drive.
- A text style menu "Aa": the weights the font draws, letter spacing, line height (not in documents, whose blocks
  keep theirs), all caps and a highlight.
- On a shape, an effects menu: no, soft or strong shadow; solid, dashed or dotted border; four gradients.

Each choice is a preset written as the file stores it (§3). A chosen box takes the style whole and loses its words'
own marks of that kind, so the choice shows; words chosen while typing take marks. A deck's heading or text font
equal to its theme's isn't stored, so a new theme still changes it.

## Consequences

- An agent can match a brand with pieces people can edit one by one, and sees its result.
- The image grows by about 40 MB and its build needs network access and fontTools; development and tests need
  neither.
- A workspace's own font may be one it has no right to serve on the web; the upload says so, and exports respect
  what the font itself allows.
- `add_html` is a subset of CSS: layouts past it come out simpler than in a browser, and the tool says what it left
  out.
