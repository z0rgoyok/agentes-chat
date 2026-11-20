/**
 * The shapes office files are read into and written from (ADR 0198): a workbook (`WorkbookData`, what the server reads
 * out of `.xlsx`, `.xls`, `.ods`, `.csv` and `.tsv`, and what it writes to `.xlsx` and `.csv`) and a deck (`DeckData`,
 * what it reads out of `.pptx`). The apps draw them read-only with the same views as live files. Types only: importing
 * this module loads no code.
 */
export type { CanvasPreview } from "./canvas/types";
export type { RichAlign, RichDoc, RichList, RichParagraph, RichRun } from "./rich/types";
export type {
  DeckData,
  DeckElementData,
  DeckMedia,
  DeckSlideData,
  DeckView,
  ElementStyle,
  ElementType,
  ElementView,
  ShapeKind,
  SlideBackground,
  SlideChart,
  SlideLayout,
  SlideRole,
  SlidesPreview,
  SlideTable,
  SlideView,
  ThemeId,
} from "./slides/types";
export type { CellStyle, SheetData, SheetPreview, WorkbookData } from "./spreadsheet";
