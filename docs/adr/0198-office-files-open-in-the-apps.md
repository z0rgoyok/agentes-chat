# 0198. Office files open in the apps

- Status: Accepted
- Date: 2026-11-17
- Amends: 0025 §3 (uploads past images, PDF and video were download only)
- Amended by: 0200 (a Word document opens as a live document, its pictures kept; documents download as `.docx`,
  `.md` and PDF)
- Code: engine `packages/engine/src/office/*` (`readXlsx`, `writeXlsx`, `readCsv`, `readXls`, `readPptx`,
  `writePptx`, `docxToHtml`, `slidesPdf`), routes in `apps/server/src/routes/app/live.ts` (`…/preview`,
  `…/open-as`, export formats), the readers' shared shapes `WorkbookData` and `DeckData` in `@agenteschat/live`

## Context

Spreadsheets, presentations and Word documents are most of what people upload, and the apps only offer to
download them. Since ADR 0196 the apps draw spreadsheets and slides themselves, so they can draw uploaded ones too.

## Decision

**The server reads the file; the apps draw what it read.** An uploaded `xlsx`, `xls`, `ods`, `csv` or `tsv` is read
into `WorkbookData` (sheets, values, formulas, styles, number formats, merges, column widths, frozen panes) and
drawn read-only by the same spreadsheet view as a live file. A `pptx` is read into `DeckData` (slides, text with
its formatting, pictures, shapes, tables, backgrounds, placeholders resolved through their layout and master) and
drawn by the slides view. A `docx` becomes plain, clean HTML (headings, paragraphs, lists, tables, links, pictures
inline) drawn in the isolated frame of ADR 0019, never on the app's own origin. Nothing in a file runs: macros,
external links, embedded objects and fields are left out. The server reads every one of these formats with its
own code, on its own zip reader and XML scanners (`@xmldom/xmldom` for the small parts): the legacy binary `xls`
(Excel 97 to 2003, BIFF8) through its own compound-file reader (`cfb.ts`), with formulas written back from their
tokens (`xls-formula.ts`, the value Excel last calculated where a token isn't known), and `ods` through its own
OpenDocument reader (`ods-read.ts`, OpenFormula written back in A1). No third-party spreadsheet library is involved,
so the build pulls nothing from outside the npm registry. Excel 95 and older files say so and ask for `.xlsx`;
`.doc` and `.ppt` stay download only.

Reading is bounded: files up to 25 MB, 200,000 cells, 300 slides, 40 MB unpacked, as `file-reader.ts` already
guards against zip bombs. The result is cached per version in the process, since versions never change.

**Open as a live file.** Editar como planilha, Editar como apresentação and Editar como documento make a new live
file from the upload (a Word document becomes a live document, ADR 0200), beside it: same conversation, same
sharing, a note saying where it came from. The upload stays as it was.

**Live files export to Office.** A spreadsheet downloads as `xlsx` (values and formulas, styles, merges, widths,
frozen panes) or `csv`; a presentation as `pptx` (text boxes with their formatting, pictures, shapes, tables,
speaker notes, the theme's fonts and colors) or `pdf`, written on the server, since the desktop app can't print a
page.

## Consequences

- Office files are seen on every device without an Office suite, including the phone, which can't unzip them.
- What Excel or PowerPoint does that we don't (charts, pivot tables, conditional formats, animations, SmartArt) is
  left out of the view, and the download still has it.
