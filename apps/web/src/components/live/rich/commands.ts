import { isRichColor, isRichHref, RICH_MAX_LEVEL, type RichAlign, type RichList } from "@agenteschat/live/rich";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { InputRule, inputRules } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Mark, MarkType, Node as PMNode } from "prosemirror-model";
import type { Command, EditorState, Plugin, Transaction } from "prosemirror-state";
import { richSchema } from "./schema";

/**
 * What the rich text editor does to its text (ADR 0196 §2): marks, colors, links, alignment, lists and levels, the
 * keys (⌘B ⌘I ⌘U, ⌘⇧X strike, ⌘K link, Tab and ⇧Tab for levels, Enter that keeps a list going, Backspace that leaves
 * one) and the typed shortcuts ("- " starts a bullet list, "1. " a numbered one). The toolbars of slides and the
 * canvas call the same commands, and read `richFormat` to show what is on.
 */

export type RichMarkKey = "bold" | "italic" | "underline" | "strike";

/** What is on where the caret or the selection is: the toolbar's pressed buttons. */
export interface RichFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** The selection's color mark, when it has one throughout. */
  color: string | null;
  link: string | null;
  /** The first selected paragraph's attributes. */
  align: RichAlign | null;
  list: RichList | null;
  level: number;
  /** The type marks (ADR 0220 §3) the selection has throughout; null where none or mixed (the box's own shows). */
  font: string | null;
  weight: number | null;
  tracking: number | null;
  highlight: string | null;
  caps: boolean;
  /** The first selected paragraph's own line height. */
  lineHeight: number | null;
}

export const NO_FORMAT: RichFormat = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: null,
  link: null,
  align: null,
  list: null,
  level: 0,
  font: null,
  weight: null,
  tracking: null,
  highlight: null,
  caps: false,
  lineHeight: null,
};

const { marks: M, nodes: N } = richSchema;

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

/** A mark's attribute where the caret is, or across the selection when every character has the same; else null. */
export function markValue(state: EditorState, type: MarkType, attr: string): unknown {
  const { from, $from, to, empty } = state.selection;
  if (empty) {
    const mark = type.isInSet(state.storedMarks ?? $from.marks());
    return mark ? (mark.attrs[attr] ?? null) : null;
  }
  let found: unknown;
  let mixed = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText || mixed) return;
    const mark = type.isInSet(node.marks);
    const value = mark ? (mark.attrs[attr] ?? null) : null;
    if (found === undefined) found = value;
    else if (found !== value) mixed = true;
  });
  return mixed ? null : (found ?? null);
}

function markAttr(state: EditorState, type: MarkType, attr: string): string | null {
  const value = markValue(state, type, attr);
  return value === null || value === undefined ? null : String(value);
}

/** Whether every character of the selection (or what is typed next) has the mark. */
export function markEverywhere(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  let all = true;
  let any = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText || !all) return;
    any = true;
    if (!type.isInSet(node.marks)) all = false;
  });
  return any && all;
}

const numberOr = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** The paragraphs the selection touches, with their positions. */
function selectedParagraphs(state: EditorState): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === N.paragraph) {
      out.push({ node, pos });
      return false;
    }
    return true;
  });
  if (!out.length) {
    const $from = state.selection.$from;
    if ($from.parent.type === N.paragraph) out.push({ node: $from.parent, pos: $from.before() });
  }
  return out;
}

export function richFormat(state: EditorState): RichFormat {
  const first = selectedParagraphs(state)[0]?.node;
  const level = typeof first?.attrs.level === "number" ? first.attrs.level : 0;
  return {
    bold: markActive(state, M.bold),
    italic: markActive(state, M.italic),
    underline: markActive(state, M.underline),
    strike: markActive(state, M.strike),
    color: markAttr(state, M.color, "color"),
    link: markAttr(state, M.link, "href"),
    align: (first?.attrs.align as RichAlign | null) ?? null,
    list: (first?.attrs.list as RichList | null) ?? null,
    level,
    font: markAttr(state, M.font as MarkType, "font"),
    weight: numberOr(markValue(state, M.weight as MarkType, "weight")),
    tracking: numberOr(markValue(state, M.tracking as MarkType, "tracking")),
    highlight: markAttr(state, M.highlight as MarkType, "color"),
    caps: markEverywhere(state, M.caps as MarkType),
    lineHeight: numberOr(first?.attrs.lineHeight),
  };
}

export function sameFormat(a: RichFormat, b: RichFormat): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.color === b.color &&
    a.link === b.link &&
    a.align === b.align &&
    a.list === b.list &&
    a.level === b.level &&
    a.font === b.font &&
    a.weight === b.weight &&
    a.tracking === b.tracking &&
    a.highlight === b.highlight &&
    a.caps === b.caps &&
    a.lineHeight === b.lineHeight
  );
}

export const toggleRichMark = (key: RichMarkKey): Command => toggleMark(M[key] as MarkType);

/** Sets a mark with attributes over the selection (or for what is typed next), or takes it away with null. */
function setMarkAttrs(type: MarkType, attrs: Record<string, unknown> | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (!dispatch) return true;
    const tr = state.tr;
    if (empty) {
      const marks = type.removeFromSet(state.storedMarks ?? state.selection.$from.marks());
      tr.setStoredMarks(attrs ? type.create(attrs).addToSet(marks) : marks);
    } else {
      tr.removeMark(from, to, type);
      if (attrs) tr.addMark(from, to, type.create(attrs));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Colors the selection ("#rrggbb"), or brings it back to the box's own color with null. */
export function setRichColor(color: string | null): Command {
  if (color !== null && !isRichColor(color)) return () => false;
  return setMarkAttrs(M.color as MarkType, color ? { color } : null);
}

/** The type marks people set from the toolbars (ADR 0220 §3), with the attribute each keeps its value in. */
export type RichTypeMark = "font" | "weight" | "tracking" | "highlight";

const TYPE_ATTR: Record<RichTypeMark, string> = {
  font: "font",
  weight: "weight",
  tracking: "tracking",
  highlight: "color",
};

/**
 * Sets a type mark on the selection (or for what is typed next): a font ref, a weight, letter spacing in thousandths
 * of the size, a highlight color; null (or no spacing) takes it away, so the box's own shows.
 */
export function setRichType(mark: RichTypeMark, value: string | number | null): Command {
  const off = value === null || (mark === "tracking" && value === 0);
  return setMarkAttrs(M[mark] as MarkType, off ? null : { [TYPE_ATTR[mark]]: value });
}

/** Capitals on the selection, or off. */
export const setRichCaps = (on: boolean): Command => setMarkAttrs(M.caps as MarkType, on ? {} : null);

/** The selected paragraphs' own line height, or theirs taken away with null. */
export const setRichLineHeight = (lineHeight: number | null): Command => setParagraphs(() => ({ lineHeight }));

/**
 * Links the selection to `href` (https, http or mailto; a bare address gets https), or unlinks it with null. With an
 * empty selection inside a link, the whole link changes.
 */
export function setRichLink(href: string | null): Command {
  const clean = href === null ? null : normalizeHref(href);
  if (href !== null && !clean) return () => false;
  return (state, dispatch) => {
    const type = M.link as MarkType;
    let { from, to } = state.selection;
    if (state.selection.empty) {
      const range = markRange(state, type);
      if (!range) return clean ? insertLinked(clean)(state, dispatch) : false;
      ({ from, to } = range);
    }
    if (!dispatch) return true;
    const tr = state.tr.removeMark(from, to, type);
    if (clean) tr.addMark(from, to, type.create({ href: clean }));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** An address as typed ("acme.com", "ada@acme.com") as a link we keep, or null. */
export function normalizeHref(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  if (isRichHref(value)) return value;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(value)) return `mailto:${value}`;
  if (/^[^\s:/]+\.[^\s:]+/.test(value)) {
    const https = `https://${value}`;
    return isRichHref(https) ? https : null;
  }
  return null;
}

/** With nothing selected and no link around the caret: the address itself, linked. */
function insertLinked(href: string): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const text = href.replace(/^mailto:/, "");
      const mark = (M.link as MarkType).create({ href });
      dispatch(state.tr.replaceSelectionWith(richSchema.text(text, [mark]), false).scrollIntoView());
    }
    return true;
  };
}

/** The extent of the mark of `type` around the caret. */
function markRange(state: EditorState, type: MarkType): { from: number; to: number } | null {
  const { $from } = state.selection;
  const parent = $from.parent;
  const start = $from.parentOffset;
  let found: Mark | null = null;
  let from = -1;
  let to = -1;
  let offset = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const end = offset + child.nodeSize;
    const mark = type.isInSet(child.marks);
    if (mark && start >= offset && start <= end && !found) {
      found = mark;
      from = offset;
      to = end;
      // Neighbors with the same link are one link.
      for (let j = i - 1; j >= 0; j--) {
        const prev = parent.child(j);
        if (!mark.isInSet(prev.marks)) break;
        from -= prev.nodeSize;
      }
      for (let j = i + 1; j < parent.childCount; j++) {
        const next = parent.child(j);
        if (!mark.isInSet(next.marks)) break;
        to += next.nodeSize;
      }
    }
    offset = end;
  }
  if (!found) return null;
  const base = $from.start();
  return { from: base + from, to: base + to };
}

/** Changes the selected paragraphs' attributes. */
function setParagraphs(patch: (attrs: Record<string, unknown>) => Record<string, unknown> | null): Command {
  return (state, dispatch) => {
    const targets = selectedParagraphs(state);
    let changed = false;
    const tr = state.tr;
    for (const { node, pos } of targets) {
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

export const setRichAlign = (align: RichAlign | null): Command => setParagraphs(() => ({ align }));

/** Turns the selected paragraphs into a list of `kind`, or out of it when they all are already. */
export function toggleRichList(kind: RichList): Command {
  return (state, dispatch) => {
    const all = selectedParagraphs(state).every(({ node }) => node.attrs.list === kind);
    return setParagraphs(() => ({ list: all ? null : kind }))(state, dispatch);
  };
}

/** Indents (1) or outdents (-1) the selected paragraphs, between 0 and 4. */
export function shiftRichLevel(delta: 1 | -1): Command {
  return setParagraphs((attrs) => {
    const level = typeof attrs.level === "number" ? attrs.level : 0;
    const next = Math.min(RICH_MAX_LEVEL, Math.max(0, level + delta));
    return next === level ? null : { level: next };
  });
}

/** Enter: a new paragraph that keeps the list, level and alignment; on an empty list item, the list ends there. */
export const splitParagraph: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if ($from.parent.type !== N.paragraph || !$from.sameParent($to)) return false;
  const attrs = $from.parent.attrs;
  if ($from.parent.content.size === 0 && (attrs.list || (attrs.level ?? 0) > 0)) {
    // An empty item: out of the list (or one level up), as every editor does.
    return setParagraphs((a) =>
      a.list ? { list: null } : { level: Math.max(0, (typeof a.level === "number" ? a.level : 0) - 1) },
    )(state, dispatch);
  }
  if (dispatch) {
    const tr = state.tr;
    if (!state.selection.empty) tr.deleteSelection();
    const pos = tr.selection.from;
    tr.split(pos, 1, [{ type: N.paragraph as NonNullable<typeof N.paragraph>, attrs: { ...attrs } }]);
    // Marks being typed with carry over.
    const marks = state.storedMarks ?? $from.marks();
    if (marks.length) tr.ensureMarks(marks);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Backspace at the start of a list item leaves the list; at the start of an indented paragraph, outdents it. */
export const liftParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.parent.type !== N.paragraph) return false;
  const attrs = $from.parent.attrs;
  if (attrs.list) return setParagraphs(() => ({ list: null }))(state, dispatch);
  if ((attrs.level ?? 0) > 0) return shiftRichLevel(-1)(state, dispatch);
  return false;
};

/** Shift-Enter: a line break inside the paragraph. */
export const lineBreak: Command = (state, dispatch) => {
  const br = N.hard_break;
  if (!br) return false;
  dispatch?.(state.tr.replaceSelectionWith(br.create()).scrollIntoView());
  return true;
};

/** A list starts from a typed "- ", "* " or "1. " at the start of a paragraph. */
function listRule(pattern: RegExp, kind: RichList): InputRule {
  return new InputRule(pattern, (state, _match, start, end): Transaction | null => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type !== N.paragraph || $start.parentOffset !== 0) return null;
    if ($start.parent.attrs.list === kind) return null;
    return state.tr
      .delete(start, end)
      .setNodeMarkup($start.before(), undefined, { ...$start.parent.attrs, list: kind });
  });
}

export function richInputRules(): Plugin {
  return inputRules({ rules: [listRule(/^\s*[-*•]\s$/, "bullet"), listRule(/^\s*1[.)]\s$/, "ordered")] });
}

export interface RichKeyOptions {
  undo?: Command;
  redo?: Command;
  /** ⌘K: the box's owner asks for the address (the desktop app keeps ⌘K, so a toolbar button does it too). */
  onLink?: () => void;
  /** Esc: leave the text. */
  onEscape?: () => void;
}

/** The keys, before ProseMirror's own. */
export function richKeymap(options: RichKeyOptions): Plugin[] {
  const keys: Record<string, Command> = {
    "Mod-b": toggleRichMark("bold"),
    "Mod-i": toggleRichMark("italic"),
    "Mod-u": toggleRichMark("underline"),
    "Mod-Shift-x": toggleRichMark("strike"),
    Enter: splitParagraph,
    "Shift-Enter": lineBreak,
    "Mod-Enter": lineBreak,
    Backspace: liftParagraph,
    Tab: (state, dispatch) => shiftRichLevel(1)(state, dispatch) || true,
    "Shift-Tab": (state, dispatch) => shiftRichLevel(-1)(state, dispatch) || true,
  };
  if (options.undo) {
    keys["Mod-z"] = options.undo;
    keys["Mod-Shift-z"] = options.redo ?? options.undo;
    if (options.redo) keys["Mod-y"] = options.redo;
  }
  if (options.onLink) {
    const open = options.onLink;
    keys["Mod-k"] = () => {
      open();
      return true;
    };
  }
  if (options.onEscape) {
    const leave = options.onEscape;
    keys.Escape = () => {
      leave();
      return true;
    };
  }
  return [keymap(keys), keymap(baseKeymap)];
}
