import { describe, expect, test } from "bun:test";
import { type DocBlock, type DocRun, documentBody, readDocument, writeDocument } from "@agenteschat/live/document";
import * as Y from "yjs";
import {
  appendRuns,
  applyDiff,
  deleteRange,
  editableElement,
  formatRange,
  hasMark,
  mapCaret,
  marksAt,
  plainOf,
  rangeHas,
  runsOf,
  runsSlice,
  textDiff,
  withMark,
} from "../../src/features/live-files/document/text";

/**
 * A document's block edited character by character on the phone (ADR 0200): a change of the field's text becomes one
 * delete and one insert across the block's texts and line breaks, the marks of untouched words stay, typed words take
 * the marks before the caret, and two people typing in the same block both keep what they wrote.
 */

/** A document holding `blocks`, and its first block's editable element. */
function docWith(blocks: DocBlock[]) {
  const doc = new Y.Doc();
  writeDocument(doc, blocks, null);
  const element = editableElement(documentBody(doc).get(0) as Y.XmlElement) as Y.XmlElement;
  return { doc, element };
}

const para = (runs: DocRun[]): DocBlock => ({ type: "paragraph", runs });

/** One edit as the field would send it, applied the way the screen does (marks of the caret's left). */
function type(doc: Y.Doc, element: Y.XmlElement, before: string, after: string) {
  const diff = textDiff(before, after);
  if (!diff) return;
  const marks = marksAt(element, diff.at);
  doc.transact(() => applyDiff(element, diff, marks));
}

describe("the field's text and the block's", () => {
  test("texts and line breaks laid end to end, each run with its marks", () => {
    const { element } = docWith([para([{ text: "Oi " }, { text: "forte", bold: true }, { text: "\nfim" }])]);
    expect(plainOf(element)).toBe("Oi forte\nfim");
    expect(runsOf(element)).toEqual([{ text: "Oi " }, { text: "forte", bold: true }, { text: "\n" }, { text: "fim" }]);
    expect(runsSlice(runsOf(element), 4, 10)).toEqual([{ text: "orte", bold: true }, { text: "\n" }, { text: "f" }]);
  });

  test("the smallest change between two texts, and a caret carried across someone else's", () => {
    expect(textDiff("abc", "abc")).toBeNull();
    expect(textDiff("abc", "abXc")).toEqual({ at: 2, remove: 0, insert: "X" });
    expect(textDiff("abcdef", "abef")).toEqual({ at: 2, remove: 2, insert: "" });
    expect(textDiff("hello", "help!")).toEqual({ at: 3, remove: 2, insert: "p!" });
    expect(textDiff("aa", "aaa")).toEqual({ at: 2, remove: 0, insert: "a" });
    const diff = { at: 2, remove: 1, insert: "XYZ" };
    expect(mapCaret(1, diff)).toBe(1);
    expect(mapCaret(2, diff)).toBe(2);
    expect(mapCaret(3, diff)).toBe(5);
    expect(mapCaret(9, diff)).toBe(11);
  });
});

describe("typing into a block", () => {
  test("words typed take the marks before the caret; the marks of the rest stay", () => {
    const { doc, element } = docWith([para([{ text: "Oi " }, { text: "forte", bold: true }, { text: " fim" }])]);
    type(doc, element, "Oi forte fim", "Oi forte!! fim");
    expect(runsOf(element)).toEqual([{ text: "Oi " }, { text: "forte!!", bold: true }, { text: " fim" }]);
    type(doc, element, "Oi forte!! fim", "Ola, forte!! fim");
    expect(runsOf(element)).toEqual([{ text: "Ola, " }, { text: "forte!!", bold: true }, { text: " fim" }]);
  });

  test("a change across a line break deletes it; at a line's start the words take the next character's marks", () => {
    const { doc, element } = docWith([para([{ text: "um" }, { text: "\n" }, { text: "dois", italic: true }])]);
    type(doc, element, "um\ndois", "um\nXdois");
    expect(runsOf(element)).toEqual([{ text: "um" }, { text: "\n" }, { text: "Xdois", italic: true }]);
    type(doc, element, "um\nXdois", "uXdois");
    expect(plainOf(element)).toBe("uXdois");
    expect(element.toArray().some((n) => n instanceof Y.XmlElement)).toBe(false);
  });

  test("an empty block gets its first text; a pasted line joins with a space; a code block keeps its lines", () => {
    const empty = docWith([para([])]);
    type(empty.doc, empty.element, "", "Oi");
    expect(plainOf(empty.element)).toBe("Oi");
    type(empty.doc, empty.element, "Oi", "Oi\ntodos");
    expect(plainOf(empty.element)).toBe("Oi todos");
    const code = docWith([{ type: "code_block", text: "a = 1" }]);
    type(code.doc, code.element, "a = 1", "a = 1\nb = 2");
    expect(plainOf(code.element)).toBe("a = 1\nb = 2");
    expect(runsOf(code.element)).toEqual([{ text: "a = 1\nb = 2" }]);
  });

  test("a link goes on inside it, never right after it", () => {
    const { doc, element } = docWith([para([{ text: "ver " }, { text: "site", link: "https://x.y" }])]);
    type(doc, element, "ver site", "ver site!");
    expect(runsOf(element)).toEqual([{ text: "ver " }, { text: "site", link: "https://x.y" }, { text: "!" }]);
    type(doc, element, "ver site!", "ver siXte!");
    expect(runsOf(element)[1]).toEqual({ text: "siXte", link: "https://x.y" });
  });

  test("a quote's one paragraph is what the phone edits; a picture has nothing to edit", () => {
    const quote = docWith([{ type: "blockquote", blocks: [{ type: "paragraph", runs: [{ text: "dito" }] }] }]);
    expect(plainOf(quote.element)).toBe("dito");
    const picture = new Y.Doc();
    writeDocument(picture, [{ type: "image", asset: "a1b2c3d4e5f6a7b8" }], null);
    expect(editableElement(documentBody(picture).get(0) as Y.XmlElement)).toBeNull();
  });
});

describe("marks on the words chosen", () => {
  test("bold on a range across texts, off when all of it has it", () => {
    const { doc, element } = docWith([para([{ text: "um " }, { text: "dois", italic: true }, { text: " tres" }])]);
    expect(rangeHas(element, 0, 7, "bold")).toBe(false);
    doc.transact(() => formatRange(element, 1, 6, { bold: {} }));
    expect(runsOf(element)).toEqual([
      { text: "u" },
      { text: "m ", bold: true },
      { text: "doi", bold: true, italic: true },
      { text: "s", italic: true },
      { text: " tres" },
    ]);
    expect(rangeHas(element, 1, 6, "bold")).toBe(true);
    doc.transact(() => formatRange(element, 1, 6, { bold: null }));
    expect(rangeHas(element, 1, 6, "bold")).toBe(false);
    expect(runsOf(element)[1]).toEqual({ text: "dois", italic: true });
  });

  test("the format bar's marks for the next words, turned on and off", () => {
    const on = withMark({ italic: {} }, "bold", true);
    expect(hasMark(on, "bold")).toBe(true);
    expect(hasMark(on, "italic")).toBe(true);
    expect(hasMark(withMark(on, "bold", false), "bold")).toBe(false);
  });

  test("a block joined to the one above brings its words with their marks", () => {
    const { doc, element } = docWith([para([{ text: "Oi" }]), para([{ text: "x" }])]);
    doc.transact(() => {
      appendRuns(element, [{ text: " todos", bold: true }, { text: "\n" }, { text: "fim" }]);
      deleteRange(element, 0, 0);
    });
    expect(runsOf(element)).toEqual([{ text: "Oi" }, { text: " todos", bold: true }, { text: "\n" }, { text: "fim" }]);
  });
});

describe("two people in one block", () => {
  /** Two copies of one document, as two phones hold it. */
  function pair(blocks: DocBlock[]) {
    const a = new Y.Doc();
    writeDocument(a, blocks, null);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const el = (d: Y.Doc) => editableElement(documentBody(d).get(0) as Y.XmlElement) as Y.XmlElement;
    const sync = () => {
      const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
      const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
      Y.applyUpdate(b, fromA);
      Y.applyUpdate(a, fromB);
    };
    return { a, b, ea: el(a), eb: el(b), sync };
  }

  test("each one's typing in the same block merges: nobody's words are lost", () => {
    const { a, b, ea, eb, sync } = pair([para([{ text: "O verão " }, { text: "chegou", bold: true }])]);
    type(a, ea, "O verão chegou", "Olá! O verão chegou");
    type(b, eb, "O verão chegou", "O verão chegou cedo");
    sync();
    expect(plainOf(ea)).toBe("Olá! O verão chegou cedo");
    expect(plainOf(eb)).toBe(plainOf(ea));
    expect(runsOf(ea)).toEqual([{ text: "Olá! O verão " }, { text: "chegou cedo", bold: true }]);
    // The document reads the same on both phones, its block keeping its id.
    expect(readDocument(a)).toEqual(readDocument(b));
    expect(readDocument(a)[0]?.id).toBeTruthy();
  });

  test("typing at the same place, and one deleting what the other types beside", () => {
    const { a, b, ea, eb, sync } = pair([para([{ text: "abc" }])]);
    type(a, ea, "abc", "abXc");
    type(b, eb, "abc", "abYc");
    sync();
    expect(plainOf(ea)).toBe(plainOf(eb));
    expect(plainOf(ea)).toMatch(/^ab(XY|YX)c$/);
    type(a, ea, plainOf(ea), plainOf(ea).replace("c", ""));
    type(b, eb, plainOf(eb), `${plainOf(eb)}!`);
    sync();
    expect(plainOf(ea)).toBe(plainOf(eb));
    expect(plainOf(ea).endsWith("!")).toBe(true);
    expect(plainOf(ea).includes("c")).toBe(false);
  });
});
