import { isRichColor, RICH_MAX_LEVEL, type RichAlign, type RichDoc, type RichList } from "@agenteschat/live/rich";
import * as Y from "yjs";
import type { RichFormat, RichMarkKey } from "./commands";

/**
 * Formatting a whole text box at once (ADR 0196 §2), when it is selected on a slide or a canvas but not being typed
 * in: the marks and paragraph attributes are changed in place in the box's `Y.XmlFragment`, in y-prosemirror's
 * encoding, so someone typing in the same box keeps their caret and their words. Each call is one transaction with the
 * caller's origin (`LOCAL` for the person's own undo).
 */

function paragraphsOf(fragment: Y.XmlFragment): Y.XmlElement[] {
  return fragment.toArray().filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === "paragraph");
}

function textsOf(fragment: Y.XmlFragment): Y.XmlText[] {
  const out: Y.XmlText[] = [];
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) out.push(child);
      else if (child instanceof Y.XmlElement) walk(child);
    }
  };
  walk(fragment);
  return out;
}

function transact(fragment: Y.XmlFragment, origin: unknown, fn: () => void) {
  const doc = fragment.doc;
  if (doc) doc.transact(fn, origin);
  else fn();
}

/** A mark on every character of the box (`on`), or off every character. */
export function markWholeText(fragment: Y.XmlFragment, mark: RichMarkKey, on: boolean, origin: unknown): void {
  transact(fragment, origin, () => {
    for (const text of textsOf(fragment)) if (text.length) text.format(0, text.length, { [mark]: on ? {} : null });
  });
}

/** Colors every character ("#rrggbb"), or takes the color marks away with null (the box's own color shows). */
export function colorWholeText(fragment: Y.XmlFragment, color: string | null, origin: unknown): void {
  if (color !== null && !isRichColor(color)) return;
  transact(fragment, origin, () => {
    for (const text of textsOf(fragment)) {
      if (text.length) text.format(0, text.length, { color: color ? { color } : null });
    }
  });
}

/** Sets an attribute on every paragraph (null takes it away, as y-prosemirror stores a null attribute). */
export function setWholeParagraphs(
  fragment: Y.XmlFragment,
  patch: { align?: RichAlign | null; list?: RichList | null; level?: number },
  origin: unknown,
): void {
  transact(fragment, origin, () => {
    for (const p of paragraphsOf(fragment)) {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (value === null) {
          if (p.getAttribute(key) !== undefined) p.removeAttribute(key);
        } else if (p.getAttribute(key) !== value) p.setAttribute(key, value as string);
      }
    }
  });
}

/** Indents (1) or outdents (-1) every paragraph. */
export function shiftWholeLevels(fragment: Y.XmlFragment, delta: 1 | -1, origin: unknown): void {
  transact(fragment, origin, () => {
    for (const p of paragraphsOf(fragment)) {
      const raw = p.getAttribute("level") as unknown;
      const level = typeof raw === "number" ? raw : Number(raw) || 0;
      const next = Math.min(RICH_MAX_LEVEL, Math.max(0, level + delta));
      // y-prosemirror stores level 0 too.
      if (next !== level || raw === undefined) p.setAttribute("level", next as unknown as string);
    }
  });
}

/** What the whole box has on (a mark only when every character has it): the toolbar's pressed buttons. */
export function wholeFormat(rich: RichDoc): RichFormat {
  const runs = rich.flatMap((p) => p.runs.filter((r) => r.text && r.text !== "\n"));
  const every = (pick: (r: (typeof runs)[number]) => unknown) => runs.length > 0 && runs.every((r) => !!pick(r));
  const colors = new Set(runs.map((r) => r.color ?? null));
  const links = new Set(runs.map((r) => r.link ?? null));
  const first = rich[0];
  return {
    bold: every((r) => r.bold),
    italic: every((r) => r.italic),
    underline: every((r) => r.underline),
    strike: every((r) => r.strike),
    color: colors.size === 1 ? ([...colors][0] ?? null) : null,
    link: links.size === 1 ? ([...links][0] ?? null) : null,
    align: first?.align ?? null,
    list: rich.length > 0 && rich.every((p) => p.list === first?.list) ? (first?.list ?? null) : null,
    level: first?.level ?? 0,
  };
}
