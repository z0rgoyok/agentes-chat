import { RICH_MAX_LEVEL, type RichAlign, type RichList } from "@agenteschat/live/rich";
import { lift, toggleMark, wrapIn } from "prosemirror-commands";
import type { Attrs, MarkType, NodeType, Node as PMNode, ResolvedPos } from "prosemirror-model";
import { type Command, type EditorState, NodeSelection, Selection, TextSelection } from "prosemirror-state";
import { normalizeHref } from "../rich/commands";
import { M, N } from "./schema";

/**
 * What the document editor does to its text (ADR 0200): the block's style (text, headings 1 to 3, quote, code), marks,
 * links, lists and levels (the rich text's model: `list` + `level` on a paragraph), pictures, rules and tables. Every
 * command keeps a block's `id` where the block stays the same block (a paragraph turned into a heading is still the
 * block an agent or a message named); new blocks get theirs from `blockIds`.
 */

export type DocStyle = "text" | "h1" | "h2" | "h3" | "quote" | "code";
export type DocMarkKey = "bold" | "italic" | "underline" | "strike" | "code";

/** What is on where the caret or the selection is: the toolbar's pressed buttons and its style menu. */
export interface DocFormat {
  style: DocStyle;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  link: string | null;
  list: RichList | null;
  /** The caret is in a table. */
  table: boolean;
  /** A picture is selected. */
  image: boolean;
  /** The selection holds text (not only a caret). */
  ranged: boolean;
}

export const NO_DOC_FORMAT: DocFormat = {
  style: "text",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  link: null,
  list: null,
  table: false,
  image: false,
  ranged: false,
};

export function sameDocFormat(a: DocFormat, b: DocFormat): boolean {
  return (Object.keys(a) as (keyof DocFormat)[]).every((k) => a[k] === b[k]);
}

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

/** The extent of the mark of `type` around the caret (a link's whole words). */
function markRange(state: EditorState, type: MarkType): { from: number; to: number; href: string | null } | null {
  const { $from } = state.selection;
  const parent = $from.parent;
  const at = $from.parentOffset;
  let offset = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const end = offset + child.nodeSize;
    const mark = type.isInSet(child.marks);
    if (mark && at >= offset && at <= end) {
      let from = offset;
      let to = end;
      for (let j = i - 1; j >= 0 && mark.isInSet(parent.child(j).marks); j--) from -= parent.child(j).nodeSize;
      for (let j = i + 1; j < parent.childCount && mark.isInSet(parent.child(j).marks); j++)
        to += parent.child(j).nodeSize;
      const base = $from.start();
      return { from: base + from, to: base + to, href: typeof mark.attrs.href === "string" ? mark.attrs.href : null };
    }
    offset = end;
  }
  return null;
}

function linkAt(state: EditorState): string | null {
  const type = M.link;
  const { from, to, empty } = state.selection;
  if (empty) return markRange(state, type)?.href ?? null;
  let found: string | null | undefined;
  let mixed = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText || mixed) return;
    const href = (type.isInSet(node.marks)?.attrs.href as string | undefined) ?? null;
    if (found === undefined) found = href;
    else if (found !== href) mixed = true;
  });
  return mixed ? null : (found ?? null);
}

/** The textblock the selection starts in, and whether it sits in a quote. */
function styleAt(state: EditorState): DocStyle {
  const $from = state.selection.$from;
  const parent = $from.parent;
  if (parent.type === N.code_block) return "code";
  if (parent.type === N.heading) {
    const level = parent.attrs.level;
    return level === 2 ? "h2" : level === 3 ? "h3" : "h1";
  }
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === N.blockquote) return "quote";
  return "text";
}

/** The depth of the nearest node of `type` around a position, or -1. */
function depthOf($pos: ResolvedPos, type: NodeType): number {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type === type) return d;
  return -1;
}

export function docFormat(state: EditorState): DocFormat {
  const sel = state.selection;
  const image = sel instanceof NodeSelection && sel.node.type === N.image;
  const first = selectedParagraphs(state)[0]?.node;
  return {
    style: styleAt(state),
    bold: markActive(state, M.bold),
    italic: markActive(state, M.italic),
    underline: markActive(state, M.underline),
    strike: markActive(state, M.strike),
    code: markActive(state, M.code),
    link: linkAt(state),
    list: (first?.attrs.list as RichList | null) ?? null,
    table: depthOf(sel.$from, N.table_cell) > 0 || (sel instanceof NodeSelection && sel.node.type === N.table),
    image,
    ranged: !sel.empty && !(sel instanceof NodeSelection),
  };
}

export const toggleDocMark = (key: DocMarkKey): Command => toggleMark(M[key]);

/** The paragraphs the selection touches, with their positions. */
export function selectedParagraphs(state: EditorState): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === N.paragraph) {
      out.push({ node, pos });
      return false;
    }
    return !node.isTextblock;
  });
  if (!out.length) {
    const $from = state.selection.$from;
    if ($from.parent.type === N.paragraph && $from.depth > 0) out.push({ node: $from.parent, pos: $from.before() });
  }
  return out;
}

/** Changes the selected paragraphs' attributes. */
function setParagraphs(patch: (attrs: Attrs) => Record<string, unknown> | null): Command {
  return (state, dispatch) => {
    const tr = state.tr;
    let changed = false;
    for (const { node, pos } of selectedParagraphs(state)) {
      const next = patch(node.attrs);
      if (!next) continue;
      const attrs = { ...node.attrs, ...next };
      if (Object.keys(attrs).every((k) => attrs[k] === node.attrs[k])) continue;
      tr.setNodeMarkup(pos, undefined, attrs);
      changed = true;
    }
    if (!changed) return false;
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

/** Turns the selected textblocks into `type` with `attrs`, each keeping its id and alignment. */
function setTextblocks(type: NodeType, attrs: Record<string, unknown> = {}): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    let applicable = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (applicable) return false;
      if (!node.isTextblock || node.hasMarkup(type, { ...node.attrs, ...attrs })) return true;
      if (node.type === type) {
        applicable = true;
        return false;
      }
      const $pos = state.doc.resolve(pos);
      const index = $pos.index();
      applicable = $pos.parent.canReplaceWith(index, index + 1, type);
      return false;
    });
    if (!applicable) return false;
    if (dispatch) {
      const tr = state.tr.setBlockType(from, to, type, (old) => {
        const keep: Record<string, unknown> = { id: old.attrs.id ?? null };
        if ("align" in (type.spec.attrs ?? {})) keep.align = old.attrs.align ?? null;
        return { ...keep, ...attrs };
      });
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Out of the quote around the selection (one level), or false when there is none. */
const liftQuote: Command = (state, dispatch) => {
  if (depthOf(state.selection.$from, N.blockquote) < 0) return false;
  return lift(state, dispatch);
};

const wrapQuote: Command = (state, dispatch) => wrapIn(N.blockquote)(state, dispatch);

/** Sets the style of the selected blocks ("Text ▾"): a style already on goes back to text. */
export function setDocStyle(style: DocStyle): Command {
  return (state, dispatch, view) => {
    const now = styleAt(state);
    switch (style) {
      case "text":
        if (now === "quote") return liftQuote(state, dispatch, view);
        return setTextblocks(N.paragraph, { level: 0, list: null })(state, dispatch, view);
      case "h1":
      case "h2":
      case "h3": {
        const level = Number(style.slice(1));
        if (now === style) return setTextblocks(N.paragraph, { level: 0, list: null })(state, dispatch, view);
        return setTextblocks(N.heading, { level })(state, dispatch, view);
      }
      case "quote":
        return now === "quote" ? liftQuote(state, dispatch, view) : wrapQuote(state, dispatch, view);
      case "code":
        if (now === "code") return setTextblocks(N.paragraph, { level: 0, list: null })(state, dispatch, view);
        return setTextblocks(N.code_block, { language: null })(state, dispatch, view);
    }
  };
}

/** Turns the selected paragraphs into a list of `kind`, or out of it when they all are already. */
export function toggleDocList(kind: RichList): Command {
  return (state, dispatch, view) => {
    // A heading or code turned into a list item becomes a paragraph first.
    if (state.selection.$from.parent.type !== N.paragraph) {
      const made = setTextblocks(N.paragraph, { level: 0, list: kind })(state, dispatch, view);
      if (made) return true;
    }
    const all = selectedParagraphs(state).every(({ node }) => node.attrs.list === kind);
    return setParagraphs(() => ({ list: all ? null : kind }))(state, dispatch);
  };
}

export const setDocAlign = (align: RichAlign | null): Command => setParagraphs(() => ({ align }));

/** Indents (1) or outdents (-1) the selected paragraphs, between 0 and 4. */
export function shiftDocLevel(delta: 1 | -1): Command {
  return setParagraphs((attrs) => {
    const level = typeof attrs.level === "number" ? attrs.level : 0;
    const next = Math.min(RICH_MAX_LEVEL, Math.max(0, level + delta));
    return next === level ? null : { level: next };
  });
}

/**
 * Links the selection to `href` (https, http or mailto; a bare address gets https), or unlinks it with null. With an
 * empty selection inside a link the whole link changes; outside one, the address itself goes in, linked.
 */
export function setDocLink(href: string | null): Command {
  const clean = href === null ? null : normalizeHref(href);
  if (href !== null && !clean) return () => false;
  return (state, dispatch) => {
    const type = M.link;
    let { from, to } = state.selection;
    if (state.selection.empty) {
      const range = markRange(state, type);
      if (!range) {
        if (!clean) return false;
        if (dispatch) {
          const words = clean.replace(/^mailto:/, "");
          dispatch(state.tr.replaceSelectionWith(state.schema.text(words, [type.create({ href: clean })]), false));
        }
        return true;
      }
      ({ from, to } = range);
    }
    if (!dispatch) return true;
    const tr = state.tr.removeMark(from, to, type);
    if (clean) tr.addMark(from, to, type.create({ href: clean }));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Enter in a paragraph: a new one that keeps the list, level and alignment (never the id: `blockIds` gives the new
 * block its own). At the start of a paragraph with words, the empty one goes above and the words keep their block's
 * id. On an empty list item or indented line, the list ends there (or it comes one level out).
 */
export const splitDocParagraph: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if ($from.parent.type !== N.paragraph || !$from.sameParent($to)) return false;
  const attrs = $from.parent.attrs;
  if ($from.parent.content.size === 0 && (attrs.list || (attrs.level ?? 0) > 0)) {
    return setParagraphs((a) =>
      a.list ? { list: null } : { level: Math.max(0, (typeof a.level === "number" ? a.level : 0) - 1) },
    )(state, dispatch);
  }
  if (dispatch) {
    const tr = state.tr;
    if (!state.selection.empty) tr.deleteSelection();
    const pos = tr.selection.from;
    const $pos = tr.doc.resolve(pos);
    const atStart = $pos.parentOffset === 0 && $pos.parent.content.size > 0;
    const after = atStart ? { ...attrs } : { ...attrs, id: null };
    tr.split(pos, 1, [{ type: N.paragraph, attrs: after }]);
    if (atStart) tr.setNodeAttribute($pos.before(), "id", null);
    const marks = state.storedMarks ?? $from.marks();
    if (marks.length) tr.ensureMarks(marks);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Backspace at the start of a list item leaves the list; at the start of an indented paragraph, outdents it. */
export const liftDocParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.parent.type !== N.paragraph) return false;
  const attrs = $from.parent.attrs;
  if (attrs.list) return setParagraphs(() => ({ list: null }))(state, dispatch);
  if ((attrs.level ?? 0) > 0) return shiftDocLevel(-1)(state, dispatch);
  return false;
};

/** Shift-Enter: a line break (a new line in code). */
export const docLineBreak: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.spec.code) {
    dispatch?.(state.tr.insertText("\n").scrollIntoView());
    return true;
  }
  dispatch?.(state.tr.replaceSelectionWith(N.hard_break.create()).scrollIntoView());
  return true;
};

/** "```ts" then Enter on a paragraph of its own: a code block in that language. */
export const fenceToCode: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== N.paragraph || $from.parentOffset !== $from.parent.content.size) return false;
  const m = /^```([a-z0-9_+#.-]{0,40})$/i.exec($from.parent.textContent);
  if (!m) return false;
  if (dispatch) {
    const start = $from.start();
    const tr = state.tr.delete(start, $from.end());
    tr.setBlockType(start, start, N.code_block, (old) => ({ id: old.attrs.id ?? null, language: m[1] || null }));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Enter on the last of two empty lines at a code block's end: out of the code, into a new paragraph under it. */
export const leaveCodeOnEmptyLines: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const code = $from.parent;
  if (!empty || code.type !== N.code_block || $from.parentOffset !== code.content.size) return false;
  if (!code.textContent.endsWith("\n\n")) return false;
  if (dispatch) {
    const tr = state.tr.delete($from.pos - 2, $from.pos);
    const after = tr.mapping.map($from.after());
    tr.insert(after, N.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Where a new block goes: in place of the empty paragraph the caret is in, else after the top block it is in. */
function insertionPoint(state: EditorState): { from: number; to: number } {
  const sel = state.selection;
  const $from = sel.$from;
  if ($from.depth === 0) return { from: sel.to, to: sel.to };
  const top = $from.node(1);
  const start = $from.before(1);
  const end = $from.after(1);
  if (top.type === N.paragraph && top.content.size === 0 && $from.depth === 1) return { from: start, to: end };
  return { from: end, to: end };
}

/**
 * Puts `nodes` (top-level blocks) where a new block goes, with an empty paragraph after the last when nothing would
 * follow it, and the caret after them (or in `caret`, an offset into the first node).
 */
function insertBlocks(nodes: PMNode[], caret?: number): Command {
  return (state, dispatch) => {
    if (!nodes.length) return false;
    if (!dispatch) return true;
    const { from, to } = insertionPoint(state);
    const tr = state.tr.replaceWith(from, to, nodes);
    let end = from + nodes.reduce((n, node) => n + node.nodeSize, 0);
    if (end >= tr.doc.content.size || !tr.doc.resolve(end).nodeAfter) {
      tr.insert(end, N.paragraph.create());
    }
    if (caret !== undefined) tr.setSelection(TextSelection.near(tr.doc.resolve(from + caret)));
    else {
      const next = tr.doc.resolve(end).nodeAfter;
      if (next?.isTextblock) end += 1;
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size))));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** A picture of the file (`asset`), as a block of its own. */
export function insertDocImage(asset: string, alt: string | null): Command {
  return insertBlocks([N.image.create({ asset, alt: alt ? alt.slice(0, 500) : null, width: null })]);
}

/** A line across the page. */
export const insertDocRule: Command = (state, dispatch) => insertBlocks([N.horizontal_rule.create()])(state, dispatch);

/** Changes the picture that is selected (its width as a fraction of the page). */
export function setImageWidth(width: number | null): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    if (!(sel instanceof NodeSelection) || sel.node.type !== N.image) return false;
    dispatch?.(state.tr.setNodeAttribute(sel.from, "width", width));
    return true;
  };
}

// ── Tables ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const emptyCell = () => N.table_cell.create(null, N.paragraph.create());

/** A new table of `rows` × `cols` empty cells, its first row a header. */
export function insertDocTable(rows = 3, cols = 3): Command {
  const table = N.table.create(
    { header: true },
    Array.from({ length: rows }, () => N.table_row.create(null, Array.from({ length: cols }, emptyCell))),
  );
  // Into the first cell: the table, its first row, its first cell, its paragraph.
  return insertBlocks([table], 4);
}

/** Where the caret is in a table: the table, its position, the row and the column. */
export interface TableAt {
  table: PMNode;
  pos: number;
  row: number;
  col: number;
}

export function tableAt(state: EditorState): TableAt | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type === N.table) {
    return { table: sel.node, pos: sel.from, row: 0, col: 0 };
  }
  const $from = sel.$from;
  const cell = depthOf($from, N.table_cell);
  if (cell < 3) return null;
  return {
    table: $from.node(cell - 2),
    pos: $from.before(cell - 2),
    row: $from.index(cell - 2),
    col: $from.index(cell - 1),
  };
}

/** The positions of each row of a table (where each starts), from its own position. */
function rowStarts(at: TableAt): number[] {
  const out: number[] = [];
  at.table.forEach((_row, offset) => {
    out.push(at.pos + 1 + offset);
  });
  return out;
}

/** The position where cell `col` of the row at `rowPos` starts (or the row's end, past its last cell). */
function cellStart(doc: PMNode, rowPos: number, col: number): number {
  const row = doc.nodeAt(rowPos);
  if (!row) return rowPos + 1;
  let pos = rowPos + 1;
  for (let i = 0; i < Math.min(col, row.childCount); i++) pos += row.child(i).nodeSize;
  return pos;
}

/** The caret into a cell, its words selected (as moving between cells does). */
function selectCell(doc: PMNode, cellPos: number): Selection {
  const cell = doc.nodeAt(cellPos);
  if (!cell) return Selection.near(doc.resolve(cellPos));
  const start = cellPos + 2;
  const end = cellPos + cell.nodeSize - 2;
  return end > start ? TextSelection.create(doc, start, end) : TextSelection.create(doc, start);
}

/** The offset of cell `col` inside a row node (its last cell past the end). */
function cellOffset(row: PMNode, col: number): number {
  let offset = 0;
  for (let i = 0; i < Math.min(col, row.childCount - 1); i++) offset += row.child(i).nodeSize;
  return offset;
}

/** A row of empty cells above (-1) or below (1) the caret's, the caret into its cell `col`. */
function addRow(state: EditorState, at: TableAt, side: -1 | 1, col: number) {
  const cols = at.table.child(at.row).childCount;
  const row = N.table_row.create(null, Array.from({ length: cols }, emptyCell));
  const rowPos = rowStarts(at)[at.row] as number;
  const pos = side < 0 ? rowPos : rowPos + at.table.child(at.row).nodeSize;
  const tr = state.tr.insert(pos, row);
  tr.setSelection(selectCell(tr.doc, pos + 1 + cellOffset(row, col)));
  return tr.scrollIntoView();
}

/** A row above (-1) or below (1) the caret's. */
export function addDocRow(side: -1 | 1): Command {
  return (state, dispatch) => {
    const at = tableAt(state);
    if (!at) return false;
    dispatch?.(addRow(state, at, side, at.col));
    return true;
  };
}

/** A column left (-1) or right (1) of the caret's, in every row. */
export function addDocColumn(side: -1 | 1): Command {
  return (state, dispatch) => {
    const at = tableAt(state);
    if (!at) return false;
    if (dispatch) {
      const tr = state.tr;
      const col = side < 0 ? at.col : at.col + 1;
      // From the last row up, so the rows above keep their positions.
      for (const rowPos of rowStarts(at).reverse()) tr.insert(cellStart(tr.doc, rowPos, col), emptyCell());
      const rowPos = rowStarts({ ...at, table: tr.doc.nodeAt(at.pos) as PMNode })[at.row] as number;
      tr.setSelection(selectCell(tr.doc, cellStart(tr.doc, rowPos, col)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** The whole table, gone (the caret to where it was). */
export const deleteDocTable: Command = (state, dispatch) => {
  const at = tableAt(state);
  if (!at) return false;
  if (dispatch) {
    const tr = state.tr.delete(at.pos, at.pos + at.table.nodeSize);
    if (tr.doc.childCount === 0) tr.insert(0, N.paragraph.create());
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(at.pos, tr.doc.content.size))));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** The caret's row, gone (the last row takes the table with it). */
export const deleteDocRow: Command = (state, dispatch, view) => {
  const at = tableAt(state);
  if (!at) return false;
  if (at.table.childCount <= 1) return deleteDocTable(state, dispatch, view);
  if (dispatch) {
    const rowPos = rowStarts(at)[at.row] as number;
    const tr = state.tr.delete(rowPos, rowPos + at.table.child(at.row).nodeSize);
    const table = tr.doc.nodeAt(at.pos) as PMNode;
    const row = Math.min(at.row, table.childCount - 1);
    const nextRow = rowStarts({ ...at, table })[row] as number;
    tr.setSelection(selectCell(tr.doc, cellStart(tr.doc, nextRow, at.col)));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** The caret's column, gone from every row (the last column takes the table with it). */
export const deleteDocColumn: Command = (state, dispatch, view) => {
  const at = tableAt(state);
  if (!at) return false;
  const cols = at.table.child(at.row).childCount;
  if (cols <= 1) return deleteDocTable(state, dispatch, view);
  if (dispatch) {
    const tr = state.tr;
    for (const rowPos of rowStarts(at).reverse()) {
      const row = tr.doc.nodeAt(rowPos);
      if (!row || row.childCount <= at.col) continue;
      const start = cellStart(tr.doc, rowPos, at.col);
      tr.delete(start, start + row.child(at.col).nodeSize);
    }
    const table = tr.doc.nodeAt(at.pos) as PMNode;
    const rowPos = rowStarts({ ...at, table })[at.row] as number;
    tr.setSelection(selectCell(tr.doc, cellStart(tr.doc, rowPos, Math.min(at.col, cols - 2))));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** The first row as a header, or not. */
export const toggleDocHeaderRow: Command = (state, dispatch) => {
  const at = tableAt(state);
  if (!at) return false;
  dispatch?.(state.tr.setNodeAttribute(at.pos, "header", at.table.attrs.header ? null : true));
  return true;
};

/** Whether the table the caret is in has a header row. */
export const tableHasHeader = (state: EditorState) => Boolean(tableAt(state)?.table.attrs.header);

/** Tab and Shift-Tab in a table: the next or previous cell; Tab in the last cell adds a row. */
export function goToCell(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const at = tableAt(state);
    if (!at || state.selection instanceof NodeSelection) return false;
    const rows = at.table.childCount;
    const cols = at.table.child(at.row).childCount;
    let row = at.row;
    let col = at.col + dir;
    if (col >= cols) {
      row++;
      col = 0;
    } else if (col < 0) {
      row--;
      col = Math.max(0, (row >= 0 ? at.table.child(row).childCount : 1) - 1);
    }
    if (row < 0) return true;
    if (row >= rows) {
      // Past the last cell: a new row, into its first cell.
      dispatch?.(addRow(state, at, 1, 0));
      return true;
    }
    if (dispatch) {
      const rowPos = rowStarts(at)[row] as number;
      dispatch(state.tr.setSelection(selectCell(state.doc, cellStart(state.doc, rowPos, col))).scrollIntoView());
    }
    return true;
  };
}

/**
 * Arrow keys at the very end (or start) of a document whose last (or first) block can't hold a caret after it (a
 * table, a code block, a quote, a picture): a new paragraph there, so the caret never gets stuck.
 */
export function escapeEdge(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    const doc = state.doc;
    const edge = dir > 0 ? doc.lastChild : doc.firstChild;
    if (!edge || edge.type === N.paragraph || edge.type === N.heading) return false;
    if (sel instanceof NodeSelection) {
      if (dir > 0 ? sel.to !== doc.content.size : sel.from !== 0) return false;
    } else {
      if (!sel.empty) return false;
      const end = dir > 0 ? Selection.atEnd(doc) : Selection.atStart(doc);
      if (sel.head !== end.head) return false;
    }
    if (dispatch) {
      const pos = dir > 0 ? doc.content.size : 0;
      const tr = state.tr.insert(pos, N.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Enter on a selected picture or rule: a new paragraph under it. */
export const paragraphAfterNode: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof NodeSelection) || sel.$from.depth !== 0 || sel.node.isTextblock) return false;
  if (dispatch) {
    const tr = state.tr.insert(sel.to, N.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, sel.to + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};
