/**
 * Documents (ADR 0200) on the web: the editor of a document's page (the Wiki's look, everyone writing at once), its
 * schema and commands. Covers draw from `DocCover` (no editor in it), which the Drive and messages load alone.
 */
export {
  type DocFormat,
  type DocStyle,
  docFormat,
  insertDocTable,
  setDocStyle,
  tableAt,
} from "./commands";
export { DocumentEditor, docState, docViewOf, selectionOf } from "./DocumentEditor";
export { docSchema } from "./schema";
