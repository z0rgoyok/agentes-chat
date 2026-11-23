import { newId } from "@agenteschat/live";
import { isBlockId } from "@agenteschat/live/document";
import type { Node as PMNode } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { ySyncPluginKey } from "y-prosemirror";
import { listNumbers } from "../rich/schema";
import { N } from "./schema";

/**
 * The document editor's own plugins (ADR 0200): every top-level block keeps an id of its own, numbered items show
 * their numbers, an empty document shows its hint, and a part of the document a message pointed at lights up a moment.
 */

/** A change that came in from the document (someone else's, an agent's, or this person's undo), not typed here. */
const fromDocument = (tr: Transaction) =>
  (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin === true;

/** The span of the final document the transactions touched (null: nothing changed). */
function touched(trs: readonly Transaction[]): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  trs.forEach((tr, t) => {
    tr.mapping.maps.forEach((map, i) => {
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        const rest = tr.mapping.slice(i + 1);
        let a = rest.map(newStart, -1);
        let b = rest.map(newEnd, 1);
        for (let k = t + 1; k < trs.length; k++) {
          const later = trs[k];
          if (!later) continue;
          a = later.mapping.map(a, -1);
          b = later.mapping.map(b, 1);
        }
        lo = Math.min(lo, a);
        hi = Math.max(hi, b);
      });
    });
  });
  return lo <= hi ? [lo, hi] : null;
}

/**
 * Block ids (ADR 0200): after a change typed here, a top-level block without an id, or with one an earlier block
 * has (a split, a paste, a copy), gets a new one, and a block that went inside a quote or a table drops its own (only
 * top-level blocks are named). Changes that come in from the document are left alone: whoever made them names their
 * blocks, and the server names any left without one.
 */
export function blockIds(): Plugin {
  return new Plugin({
    key: new PluginKey("docBlockIds"),
    appendTransaction(trs, _old, state) {
      const typed = trs.filter((tr) => tr.docChanged && !fromDocument(tr));
      if (!typed.length) return null;
      const tr = state.tr;
      const seen = new Set<string>();
      state.doc.forEach((node, offset) => {
        if (!("id" in node.attrs)) return;
        const id = node.attrs.id as unknown;
        if (isBlockId(id) && !seen.has(id)) {
          seen.add(id);
          return;
        }
        let next = newId();
        while (seen.has(next)) next = newId();
        seen.add(next);
        tr.setNodeAttribute(offset, "id", next);
      });
      const span = touched(typed);
      if (span) {
        const [from, to] = span;
        state.doc.nodesBetween(Math.max(0, from), Math.min(state.doc.content.size, to), (node, pos, parent) => {
          if (parent !== state.doc && node.attrs.id != null && "id" in node.attrs) tr.setNodeAttribute(pos, "id", null);
          return node.isBlock && !node.isTextblock;
        });
      }
      return tr.docChanged ? tr.setMeta("addToHistory", false) : null;
    },
  });
}

// ── Numbers ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The numbers of numbered items, per container (the page, a quote, a table's cell), as node decorations. */
function numberDecorations(doc: PMNode): DecorationSet {
  const found: Decoration[] = [];
  const visit = (parent: PMNode, start: number) => {
    const kids: { node: PMNode; pos: number }[] = [];
    parent.forEach((node, offset) => {
      kids.push({ node, pos: start + offset });
    });
    const numbers = listNumbers(kids.map(({ node }) => (node.type === N.paragraph ? node.attrs : {})));
    kids.forEach(({ node, pos }, i) => {
      const n = numbers[i];
      if (n !== null && n !== undefined) found.push(Decoration.node(pos, pos + node.nodeSize, { "data-n": String(n) }));
      if (node.type === N.blockquote) visit(node, pos + 1);
      else if (node.type === N.table) {
        node.forEach((row, rowOffset) => {
          const rowPos = pos + 1 + rowOffset;
          row.forEach((cell, cellOffset) => {
            visit(cell, rowPos + 1 + cellOffset + 1);
          });
        });
      }
    });
  };
  visit(doc, 0);
  return found.length ? DecorationSet.create(doc, found) : DecorationSet.empty;
}

/** Numbered items show their number (`data-n`, drawn by document.css), counted per list and level. */
export function listNumbering(): Plugin<DecorationSet> {
  const key = new PluginKey<DecorationSet>("docNumbers");
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => numberDecorations(state.doc),
      apply: (tr, old, _before, state) => (tr.docChanged ? numberDecorations(state.doc) : old),
    },
    props: { decorations: (state) => key.getState(state) },
  });
}

// ── Hint ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The document's hint while it is one empty paragraph. */
export function emptyHint(text: () => string | undefined): Plugin {
  return new Plugin({
    key: new PluginKey("docHint"),
    props: {
      decorations(state) {
        const words = text();
        const first = state.doc.firstChild;
        if (!words || state.doc.childCount !== 1 || !first || first.type !== N.paragraph || first.content.size > 0)
          return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(0, first.nodeSize, { class: "lf-doc__empty", "data-placeholder": words }),
        ]);
      },
    },
  });
}

// ── A part shown ───────────────────────────────────────────────────────────────────────────────────────────────────

export const revealKey = new PluginKey<DecorationSet>("docReveal");

/** What `revealKey`'s meta says: light up a span (or a whole block), or put the light out. */
export type RevealMeta = { from: number; to: number; block: boolean } | null;

/** The part of the document a message pointed at, lit until the next `null` (the editor puts it out after a while). */
export function revealLight(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: revealKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old) {
        const meta = tr.getMeta(revealKey) as RevealMeta | undefined;
        if (meta === undefined) return old.map(tr.mapping, tr.doc);
        if (meta === null) return DecorationSet.empty;
        const deco = meta.block
          ? Decoration.node(meta.from, meta.to, { class: "lf-doc__reveal" })
          : Decoration.inline(meta.from, meta.to, { class: "lf-doc__reveal" });
        return DecorationSet.create(tr.doc, [deco]);
      },
    },
    props: { decorations: (state) => revealKey.getState(state) },
  });
}

/** The top-level block with `id`, and where it starts. */
export function findBlock(state: EditorState, id: string): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  state.doc.forEach((node, offset) => {
    if (!found && node.attrs.id === id) found = { node, pos: offset };
  });
  return found;
}

/** Where `text` first appears in a node's words (from `start`, the node's own position), or null. */
export function findText(node: PMNode, start: number, text: string): { from: number; to: number } | null {
  const want = text.trim();
  if (!want) return null;
  /** In one textblock whose words start at `base`: offsets of its words are positions (a line break is one, "\n"). */
  const within = (block: PMNode, base: number) => {
    const at = block.textBetween(0, block.content.size, "\n", "\n").indexOf(want);
    return at >= 0 ? { from: base + at, to: base + at + want.length } : null;
  };
  if (node.isTextblock) return within(node, start + 1);
  let hit: { from: number; to: number } | null = null;
  node.descendants((child, pos) => {
    if (hit) return false;
    if (!child.isTextblock) return true;
    hit = within(child, start + 1 + pos + 1);
    return false;
  });
  return hit;
}
