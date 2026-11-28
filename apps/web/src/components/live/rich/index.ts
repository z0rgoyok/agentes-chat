/**
 * Rich text in live files (ADR 0196 §2): `RichText` edits a box's `Y.XmlFragment` with others (ProseMirror and
 * y-prosemirror), `RichView` draws a `RichDoc`. The commands are what toolbars run on an open box; the `whole*`
 * helpers format a box that is only selected.
 */
export {
  NO_FORMAT,
  normalizeHref,
  type RichFormat,
  type RichMarkKey,
  type RichTypeMark,
  richFormat,
  setRichAlign,
  setRichCaps,
  setRichColor,
  setRichLineHeight,
  setRichLink,
  setRichType,
  shiftRichLevel,
  toggleRichList,
  toggleRichMark,
} from "./commands";
export type { CaretLook } from "./cursors";
export { RichText, type RichTextHandle, type RichTextProps, richViewOf } from "./RichText";
export { RichView } from "./RichView";
export { listNumbers, richSchema } from "./schema";
export {
  capsWholeText,
  colorWholeText,
  markWholeText,
  setWholeParagraphs,
  shiftWholeLevels,
  typeWholeText,
  wholeFormat,
} from "./yformat";
