import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { RICH_SCHEMA_SPEC } from "../src/rich/schema";
import {
  clipRich,
  isRichHref,
  normalizeRich,
  plainRich,
  richFromText,
  richLength,
  richText,
  richToMarkdown,
  sameRich,
} from "../src/rich/text";
import type { RichDoc, RichParagraph, RichRun } from "../src/rich/types";
import { editParagraphTexts, fragmentText, readRich, richFragment, setRichText, writeRich } from "../src/rich/yjs";

/** The web's schema: the shared spec as a ProseMirror schema (the web only adds how things look). */
const schema = new Schema({ nodes: RICH_SCHEMA_SPEC.nodes, marks: RICH_SCHEMA_SPEC.marks });

type PMJson = { type: string; attrs?: Record<string, unknown>; content?: PMJson[]; text?: string; marks?: unknown[] };

function marksJson(run: RichRun): { type: string; attrs?: Record<string, unknown> }[] {
  const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
  if (run.bold) marks.push({ type: "bold" });
  if (run.italic) marks.push({ type: "italic" });
  if (run.underline) marks.push({ type: "underline" });
  if (run.strike) marks.push({ type: "strike" });
  if (run.color) marks.push({ type: "color", attrs: { color: run.color } });
  if (run.link) marks.push({ type: "link", attrs: { href: run.link } });
  return marks;
}

/** The ProseMirror JSON the web's editor would hold for a rich text. */
function pmJson(rich: RichDoc): PMJson {
  const paragraphs = rich.length ? rich : [{ runs: [] }];
  return {
    type: "doc",
    content: paragraphs.map((p: RichParagraph) => ({
      type: "paragraph",
      attrs: { align: p.align ?? null, level: p.level ?? 0, list: p.list ?? null },
      content: p.runs.flatMap((run) =>
        run.text
          .split("\n")
          .flatMap((part, i): PMJson[] => [
            ...(i > 0 ? [{ type: "hard_break" }] : []),
            ...(part ? [{ type: "text", text: part, marks: marksJson(run) }] : []),
          ]),
      ),
    })),
  };
}

/** A fragment's structure, exactly: names, attributes, and each text's inserts with their attributes. */
function dump(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): unknown {
  if (node instanceof Y.XmlText) return { delta: node.toDelta() };
  const children = node.toArray().map((child) => dump(child as Y.XmlElement | Y.XmlText));
  return node instanceof Y.XmlElement ? { name: node.nodeName, attrs: node.getAttributes(), children } : children;
}

function fragments(): { ours: Y.XmlFragment; theirs: Y.XmlFragment } {
  const doc = new Y.Doc();
  return { ours: doc.getXmlFragment("ours"), theirs: doc.getXmlFragment("theirs") };
}

/** Writes with our writer and with y-prosemirror, and checks all four directions agree. */
function expectSameEncoding(input: RichDoc): void {
  const rich = normalizeRich(input);
  const { ours, theirs } = fragments();
  writeRich(ours, rich);
  prosemirrorJSONToYXmlFragment(schema, pmJson(rich), theirs);
  // What we store is what y-prosemirror stores.
  expect(dump(ours)).toEqual(dump(theirs));
  // We read what y-prosemirror wrote.
  expect(readRich(theirs)).toEqual(normalizeRich(rich.length ? rich : [{ runs: [] }]));
  // y-prosemirror (the web's editor) reads what we wrote as the same document.
  const expected = schema.nodeFromJSON(pmJson(rich)).toJSON();
  expect(yXmlFragmentToProseMirrorRootNode(ours, schema).toJSON()).toEqual(expected);
  expect(yXmlFragmentToProseMirrorRootNode(theirs, schema).toJSON()).toEqual(expected);
}

const CORPUS: [string, RichDoc][] = [
  ["empty", []],
  ["one empty paragraph", [{ runs: [] }]],
  ["plain", [{ runs: [{ text: "Olá, mundo" }] }]],
  [
    "every mark",
    [
      {
        runs: [
          { text: "b", bold: true },
          { text: "i", italic: true },
          { text: "u", underline: true },
          { text: "s", strike: true },
          { text: "c", color: "#c00" },
          { text: "l", link: "https://example.com/a?b=c" },
          {
            text: "all",
            bold: true,
            italic: true,
            underline: true,
            strike: true,
            color: "#0063d1",
            link: "mailto:a@b.c",
          },
        ],
      },
    ],
  ],
  [
    "line breaks",
    [
      { runs: [{ text: "\nstart" }] },
      { runs: [{ text: "mid\ndle", bold: true }] },
      { runs: [{ text: "end\n" }] },
      { runs: [{ text: "two\n\nbreaks" }] },
      { runs: [{ text: "\n" }] },
    ],
  ],
  [
    "paragraph attributes",
    [
      { align: "center", runs: [{ text: "Title" }] },
      { list: "bullet", runs: [{ text: "one" }] },
      { list: "bullet", level: 1, runs: [{ text: "nested" }] },
      { list: "ordered", level: 4, align: "right", runs: [{ text: "deep" }] },
      { align: "left", runs: [] },
    ],
  ],
  ["unicode", [{ runs: [{ text: "emoji 🚀 and ç ã é", italic: true }, { text: " 漢字" }] }]],
];

describe("our encoding is y-prosemirror's", () => {
  test.each(CORPUS)("%s", (_name, rich) => expectSameEncoding(rich));

  test("random documents", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
    const words = ["alpha", "beta ", " gamma", "δ", "🙂", "x\ny", "\n", "  ", "z"];
    for (let n = 0; n < 150; n++) {
      const rich: RichDoc = [];
      const paragraphs = Math.floor(rand() * 4);
      for (let p = 0; p < paragraphs; p++) {
        const runs: RichRun[] = [];
        const count = Math.floor(rand() * 5);
        for (let r = 0; r < count; r++) {
          const run: RichRun = { text: pick(words) };
          if (rand() < 0.3) run.bold = true;
          if (rand() < 0.3) run.italic = true;
          if (rand() < 0.2) run.underline = true;
          if (rand() < 0.2) run.strike = true;
          if (rand() < 0.2) run.color = pick(["#123", "#abcdef", "#C0FFEE"]);
          if (rand() < 0.15) run.link = pick(["https://a.b/c", "mailto:x@y.z"]);
          runs.push(run);
        }
        const paragraph: RichParagraph = { runs };
        if (rand() < 0.3) paragraph.align = pick(["left", "center", "right"] as const);
        if (rand() < 0.3) paragraph.level = Math.floor(rand() * 5);
        if (rand() < 0.3) paragraph.list = pick(["bullet", "ordered"] as const);
        rich.push(paragraph);
      }
      expectSameEncoding(rich);
    }
  });

  test("a mark y-prosemirror names with a hash (one that may overlap itself) still reads", () => {
    const overlapping = new Schema({
      nodes: RICH_SCHEMA_SPEC.nodes,
      marks: { ...RICH_SCHEMA_SPEC.marks, bold: { excludes: "" } },
    });
    const { theirs } = fragments();
    prosemirrorJSONToYXmlFragment(
      overlapping,
      {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "b", marks: [{ type: "bold" }] }] }],
      },
      theirs,
    );
    const delta = (theirs.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    expect(Object.keys(delta.toDelta()[0].attributes)[0]).toMatch(/^bold--/);
    expect(readRich(theirs)).toEqual([{ runs: [{ text: "b", bold: true }] }]);
  });
});

describe("reading is lenient", () => {
  test("unknown marks and blocks read as their words", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("f");
    const heading = new Y.XmlElement("heading");
    const text = new Y.XmlText();
    heading.insert(0, [text]);
    fragment.insert(0, [heading]);
    text.insert(0, "Hi", { sparkle: { level: 3 }, bold: {} });
    const loose = new Y.XmlText();
    fragment.insert(1, [loose]);
    loose.insert(0, "loose");
    expect(readRich(fragment)).toEqual([{ runs: [{ text: "Hi", bold: true }] }, { runs: [{ text: "loose" }] }]);
    expect(fragmentText(fragment)).toBe("Hi\nloose");
  });
});

describe("plain data", () => {
  test("normalize drops what isn't allowed and merges neighbors", () => {
    expect(
      normalizeRich([
        {
          level: 9,
          align: "justify" as never,
          runs: [
            { text: "a", bold: true },
            { text: "b", bold: true },
            { text: "c", color: "red" },
            { text: "d", link: "javascript:alert(1)" },
            { text: "" },
          ],
        },
      ]),
    ).toEqual([{ level: 4, runs: [{ text: "ab", bold: true }, { text: "cd" }] }]);
    expect(isRichHref("http://ok.example")).toBe(true);
    expect(isRichHref("data:text/html,x")).toBe(false);
  });

  test("text, length, clip, equality", () => {
    const rich: RichDoc = [{ runs: [{ text: "Hello " }, { text: "world", bold: true }] }, { runs: [{ text: "Bye" }] }];
    expect(richText(rich)).toBe("Hello world\nBye");
    expect(richLength(rich)).toBe(15);
    expect(clipRich(rich, 8)).toEqual([{ runs: [{ text: "Hello " }, { text: "wo", bold: true }] }]);
    expect(
      sameRich(rich, [
        { runs: [{ text: "Hello " }, { text: "wor", bold: true }, { text: "ld", bold: true }] },
        { runs: [{ text: "Bye" }] },
      ]),
    ).toBe(true);
    expect(plainRich("a\n**b**")).toEqual([{ runs: [{ text: "a" }] }, { runs: [{ text: "**b**" }] }]);
  });
});

describe("light Markdown", () => {
  test("marks", () => {
    expect(richFromText("Plain **bold** *it* _it2_ ~~gone~~ __strong__")).toEqual([
      {
        runs: [
          { text: "Plain " },
          { text: "bold", bold: true },
          { text: " " },
          { text: "it", italic: true },
          { text: " " },
          { text: "it2", italic: true },
          { text: " " },
          { text: "gone", strike: true },
          { text: " " },
          { text: "strong", bold: true },
        ],
      },
    ]);
    expect(richFromText("***both***")).toEqual([{ runs: [{ text: "both", bold: true, italic: true }] }]);
    expect(richFromText("*italic with **bold** inside*")).toEqual([
      {
        runs: [
          { text: "italic with ", italic: true },
          { text: "bold", italic: true, bold: true },
          { text: " inside", italic: true },
        ],
      },
    ]);
  });

  test("lists, levels and headings", () => {
    expect(richFromText("- one\n  - nested\n\t* tab\n1. first\n2) second\n# Big")).toEqual([
      { list: "bullet", runs: [{ text: "one" }] },
      { list: "bullet", level: 1, runs: [{ text: "nested" }] },
      { list: "bullet", level: 1, runs: [{ text: "tab" }] },
      { list: "ordered", runs: [{ text: "first" }] },
      { list: "ordered", runs: [{ text: "second" }] },
      { runs: [{ text: "Big", bold: true }] },
    ]);
  });

  test("links are https or mailto only", () => {
    expect(richFromText("[site](https://example.com) and [mail](mailto:a@b.co)")).toEqual([
      {
        runs: [
          { text: "site", link: "https://example.com" },
          { text: " and " },
          { text: "mail", link: "mailto:a@b.co" },
        ],
      },
    ]);
    expect(richFromText("[x](javascript:alert(1))")).toEqual([{ runs: [{ text: "[x](javascript:alert(1))" }] }]);
    expect(richFromText("[x](http://plain.example)")).toEqual([{ runs: [{ text: "[x](http://plain.example)" }] }]);
  });

  test("what isn't Markdown stays as typed", () => {
    expect(richFromText("snake_case_name and a * b and 3 * 4")).toEqual([
      { runs: [{ text: "snake_case_name and a * b and 3 * 4" }] },
    ]);
    expect(richFromText("\\*not italic\\* and \\[x\\]")).toEqual([{ runs: [{ text: "*not italic* and [x]" }] }]);
    expect(richFromText("\n\n  \nonly\n\n")).toEqual([{ runs: [{ text: "only" }] }]);
  });

  test("Markdown out reads back the same", () => {
    const rich: RichDoc = [
      { list: "bullet", runs: [{ text: "a " }, { text: "bold", bold: true }, { text: " end" }] },
      { list: "ordered", level: 1, runs: [{ text: "x*y_z [k]" }] },
      { list: "ordered", level: 1, runs: [{ text: "go", link: "https://example.com", italic: true }] },
      { runs: [{ text: "struck", strike: true }] },
    ];
    const markdown = richToMarkdown(rich);
    expect(markdown).toBe("- a **bold** end\n  1. x\\*y_z \\[k\\]\n  2. [*go*](https://example.com)\n~~struck~~");
    expect(richFromText(markdown)).toEqual(normalizeRich(rich));
  });
});

describe("writing and the phone's editor", () => {
  function fragmentWith(rich: RichDoc): { doc: Y.Doc; fragment: Y.XmlFragment } {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("f");
    writeRich(fragment, rich);
    return { doc, fragment };
  }

  test("an empty text is one empty paragraph; writes replace everything", () => {
    const { fragment } = fragmentWith([]);
    expect(fragment.length).toBe(1);
    expect(readRich(fragment)).toEqual([{ runs: [] }]);
    setRichText(fragment, "- **a**\n- b");
    expect(readRich(fragment)).toEqual([
      { list: "bullet", runs: [{ text: "a", bold: true }] },
      { list: "bullet", runs: [{ text: "b" }] },
    ]);
    const doc = new Y.Doc();
    doc.getMap("m").set("text", richFragment("*hi*"));
    expect(readRich(doc.getMap("m").get("text") as Y.XmlFragment)).toEqual([{ runs: [{ text: "hi", italic: true }] }]);
  });

  test("changed paragraphs keep their attributes and the marks around the change", () => {
    const { fragment } = fragmentWith([
      { list: "bullet", runs: [{ text: "Hello ", bold: true }, { text: "world" }] },
      { align: "center", runs: [{ text: "Second" }] },
    ]);
    editParagraphTexts(fragment, ["Hello there world", "Second"]);
    expect(readRich(fragment)).toEqual([
      { list: "bullet", runs: [{ text: "Hello there ", bold: true }, { text: "world" }] },
      { align: "center", runs: [{ text: "Second" }] },
    ]);
    editParagraphTexts(fragment, ["Hello there world", "New line", "Second"]);
    expect(readRich(fragment)[1]).toEqual({ list: "bullet", runs: [{ text: "New line" }] });
    editParagraphTexts(fragment, ["Hello there world", "Second!"]);
    expect(readRich(fragment)).toEqual([
      { list: "bullet", runs: [{ text: "Hello there ", bold: true }, { text: "world" }] },
      { align: "center", runs: [{ text: "Second!" }] },
    ]);
    editParagraphTexts(fragment, []);
    expect(readRich(fragment)).toEqual([{ list: "bullet", runs: [] }]);
  });

  test("line breaks inside a paragraph survive an edit", () => {
    const { fragment } = fragmentWith([{ runs: [{ text: "one\ntwo", italic: true }] }]);
    editParagraphTexts(fragment, ["one\ntwo three"]);
    expect(readRich(fragment)).toEqual([
      { runs: [{ text: "one", italic: true }, { text: "\n" }, { text: "two three", italic: true }] },
    ]);
  });

  test("two people editing different paragraphs both land", () => {
    const a = fragmentWith([{ runs: [{ text: "first" }] }, { runs: [{ text: "second" }] }]);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
    const fb = b.getXmlFragment("f");
    editParagraphTexts(a.fragment, ["first, by Ada", "second"]);
    editParagraphTexts(fb, ["first", "second, by Atlas"]);
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
    const expected = [{ runs: [{ text: "first, by Ada" }] }, { runs: [{ text: "second, by Atlas" }] }];
    expect(readRich(a.fragment)).toEqual(expected);
    expect(readRich(fb)).toEqual(expected);
  });
});
