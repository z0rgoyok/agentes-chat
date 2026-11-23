import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import {
  blocksText,
  type DocBlock,
  type DocCell,
  type DocParagraph,
  type DocRun,
  deleteBlocks,
  documentBody,
  documentPreview,
  documentSource,
  documentText,
  documentToMarkdown,
  ensureBlockIds,
  insertBlocks,
  markdownToBlocks,
  normalizeBlocks,
  readBlock,
  readBlocks,
  readDocument,
  replaceBlocks,
  replaceDocument,
  replaceText,
  setDocumentSource,
  validateDocument,
  writeBlocks,
  writeDocument,
} from "../src/document";
import { DOC_SCHEMA_SPEC } from "../src/document/schema";
import { LiveEditError } from "../src/errors";
import { initLiveDoc } from "../src/kinds";
import { LOCAL, SYSTEM } from "../src/origins";

/** The web's schema: the shared spec as a ProseMirror schema (the web only adds how things look). */
const schema = new Schema({
  nodes: DOC_SCHEMA_SPEC.nodes as unknown as Record<string, never>,
  marks: DOC_SCHEMA_SPEC.marks,
});

type PMJson = { type: string; attrs?: Record<string, unknown>; content?: PMJson[]; text?: string; marks?: unknown[] };

function marksJson(run: DocRun): { type: string; attrs?: Record<string, unknown> }[] {
  const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
  if (run.bold) marks.push({ type: "bold" });
  if (run.italic) marks.push({ type: "italic" });
  if (run.underline) marks.push({ type: "underline" });
  if (run.strike) marks.push({ type: "strike" });
  if (run.code) marks.push({ type: "code" });
  if (run.color) marks.push({ type: "color", attrs: { color: run.color } });
  if (run.link) marks.push({ type: "link", attrs: { href: run.link } });
  return marks;
}

const inlineJson = (runs: readonly DocRun[]): PMJson[] =>
  runs.flatMap((run) =>
    run.text
      .split("\n")
      .flatMap((part, i): PMJson[] => [
        ...(i > 0 ? [{ type: "hard_break" }] : []),
        ...(part ? [{ type: "text", text: part, marks: marksJson(run) }] : []),
      ]),
  );

const paragraphJson = (p: DocParagraph): PMJson => ({
  type: "paragraph",
  attrs: { id: p.id ?? null, align: p.align ?? null, level: p.level ?? 0, list: p.list ?? null },
  content: inlineJson(p.runs),
});

/** The ProseMirror JSON the web's editor would hold for a block. */
function blockJson(block: DocBlock): PMJson {
  const id = block.id ?? null;
  switch (block.type) {
    case "paragraph":
      return paragraphJson(block);
    case "heading":
      return {
        type: "heading",
        attrs: { id, align: block.align ?? null, level: block.level },
        content: inlineJson(block.runs),
      };
    case "blockquote":
      return { type: "blockquote", attrs: { id }, content: block.blocks.map(blockJson) };
    case "code_block":
      return {
        type: "code_block",
        attrs: { id, language: block.language ?? null },
        content: block.text ? [{ type: "text", text: block.text }] : [],
      };
    case "horizontal_rule":
      return { type: "horizontal_rule", attrs: { id } };
    case "image":
      return {
        type: "image",
        attrs: { id, asset: block.asset, alt: block.alt ?? null, width: block.width ?? null },
      };
    case "table":
      return {
        type: "table",
        attrs: { id, header: block.header ?? null },
        content: block.rows.map((row) => ({
          type: "table_row",
          content: row.map((cell) => ({ type: "table_cell", content: cell.blocks.map(paragraphJson) })),
        })),
      };
  }
}

const docJson = (blocks: readonly DocBlock[]): PMJson => ({
  type: "doc",
  content: (blocks.length ? blocks : [{ type: "paragraph", runs: [] } as DocBlock]).map(blockJson),
});

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
function expectSameEncoding(input: DocBlock[]): void {
  const blocks = normalizeBlocks(input);
  const { ours, theirs } = fragments();
  writeBlocks(ours, blocks);
  prosemirrorJSONToYXmlFragment(schema, docJson(blocks), theirs);
  // What we store is what y-prosemirror stores.
  expect(dump(ours)).toEqual(dump(theirs));
  // We read what y-prosemirror wrote.
  expect(readBlocks(theirs)).toEqual(blocks.length ? blocks : [{ type: "paragraph", runs: [] }]);
  // y-prosemirror (the web's editor) reads what we wrote as the same document.
  const expected = schema.nodeFromJSON(docJson(blocks)).toJSON();
  expect(yXmlFragmentToProseMirrorRootNode(ours, schema).toJSON()).toEqual(expected);
  expect(yXmlFragmentToProseMirrorRootNode(theirs, schema).toJSON()).toEqual(expected);
}

const p = (text: string, more: Partial<DocParagraph> = {}): DocParagraph => ({
  type: "paragraph",
  runs: text ? [{ text }] : [],
  ...more,
});
const cell = (text: string): DocCell => ({ blocks: [p(text)] });

const CORPUS: [string, DocBlock[]][] = [
  ["empty", []],
  ["one paragraph with an id", [p("Olá, mundo", { id: "a1b2c3d4e5" })]],
  [
    "every mark",
    [
      {
        type: "paragraph",
        runs: [
          { text: "b", bold: true },
          { text: "i", italic: true },
          { text: "u", underline: true },
          { text: "s", strike: true },
          { text: "k", code: true },
          { text: "c", color: "#c00" },
          { text: "l", link: "https://example.com/a?b=c" },
          { text: "all", bold: true, italic: true, underline: true, strike: true, code: true, link: "mailto:a@b.c" },
        ],
      },
    ],
  ],
  [
    "headings",
    [
      { type: "heading", id: "h1", level: 1, runs: [{ text: "Title" }] },
      { type: "heading", level: 2, align: "center", runs: [{ text: "Sub", italic: true }] },
      { type: "heading", level: 3, runs: [{ text: "a\nb" }] },
    ],
  ],
  [
    "lists and line breaks",
    [
      p("one", { list: "bullet" }),
      p("nested", { list: "bullet", level: 1 }),
      p("first", { list: "ordered", level: 2, align: "right" }),
      { type: "paragraph", runs: [{ text: "\nstart" }, { text: "mid\ndle", bold: true }, { text: "end\n" }] },
    ],
  ],
  [
    "quotes, code and rules",
    [
      { type: "blockquote", id: "q1", blocks: [p("quoted"), p("item", { list: "bullet" })] },
      { type: "blockquote", blocks: [{ type: "blockquote", blocks: [{ type: "code_block", text: "x" }] }] },
      { type: "code_block", id: "c1", language: "ts", text: "const a = 1;\n\nconsole.log(a);" },
      { type: "code_block", text: "" },
      { type: "horizontal_rule", id: "r1" },
    ],
  ],
  [
    "images",
    [
      { type: "image", id: "i1", asset: "0193a7c2-1111-7000-8000-000000000001" },
      { type: "image", asset: "0193a7c2-1111-7000-8000-000000000002", alt: "A chart", width: 0.5 },
    ],
  ],
  [
    "tables",
    [
      {
        type: "table",
        id: "t1",
        header: true,
        rows: [
          [cell("Name"), cell("Total")],
          [{ blocks: [p("Ada"), p("and Atlas", { align: "center" })] }, cell("12")],
        ],
      },
      { type: "table", rows: [[cell(""), { blocks: [{ type: "paragraph", runs: [{ text: "x", bold: true }] }] }]] },
    ],
  ],
  ["unicode", [{ type: "paragraph", runs: [{ text: "emoji 🚀 and ç ã é", italic: true }, { text: " 漢字" }] }]],
];

describe("our encoding is y-prosemirror's", () => {
  test.each(CORPUS)("%s", (_name, blocks) => expectSameEncoding(blocks));

  test("random documents", () => {
    let seed = 4242;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
    const words = ["alpha", "beta ", " gamma", "δ", "🙂", "x\ny", "\n", "  ", "z"];
    const runs = (): DocRun[] => {
      const out: DocRun[] = [];
      const count = Math.floor(rand() * 4);
      for (let r = 0; r < count; r++) {
        const run: DocRun = { text: pick(words) };
        if (rand() < 0.3) run.bold = true;
        if (rand() < 0.2) run.italic = true;
        if (rand() < 0.15) run.underline = true;
        if (rand() < 0.15) run.code = true;
        if (rand() < 0.1) run.color = pick(["#123", "#abcdef"]);
        if (rand() < 0.1) run.link = pick(["https://a.b/c", "mailto:x@y.z"]);
        out.push(run);
      }
      return out;
    };
    const paragraph = (): DocParagraph => {
      const out: DocParagraph = { type: "paragraph", runs: runs() };
      if (rand() < 0.3) out.list = pick(["bullet", "ordered"] as const);
      if (rand() < 0.3) out.level = Math.floor(rand() * 5);
      if (rand() < 0.2) out.align = pick(["left", "center", "right"] as const);
      return out;
    };
    const block = (depth: number): DocBlock => {
      const kind = pick(["p", "p", "h", "q", "c", "r", "i", "t"] as const);
      const id = rand() < 0.5 ? { id: Math.floor(rand() * 1e9).toString(36) } : {};
      switch (kind) {
        case "h":
          return { type: "heading", level: pick([1, 2, 3] as const), runs: runs(), ...id };
        case "q":
          return depth > 1 ? paragraph() : { type: "blockquote", blocks: [block(depth + 1), paragraph()], ...id };
        case "c":
          return { type: "code_block", text: pick(["", "a\nb", "x  y"]), ...id };
        case "r":
          return { type: "horizontal_rule", ...id };
        case "i":
          return { type: "image", asset: `asset${Math.floor(rand() * 100)}`, ...id };
        case "t":
          return { type: "table", rows: [[{ blocks: [paragraph()] }], [{ blocks: [paragraph(), paragraph()] }]] };
        default:
          return { ...paragraph(), ...id };
      }
    };
    for (let n = 0; n < 150; n++) {
      const blocks: DocBlock[] = [];
      const count = Math.floor(rand() * 5);
      for (let b = 0; b < count; b++) blocks.push(block(0));
      expectSameEncoding(blocks);
    }
  });
});

describe("reading is lenient", () => {
  test("unknown blocks read as their words, unknown marks are left out, a picture needs one", () => {
    const doc = new Y.Doc();
    const body = documentBody(doc);
    const fancy = new Y.XmlElement("callout");
    const text = new Y.XmlText();
    fancy.insert(0, [text]);
    const image = new Y.XmlElement("image");
    body.insert(0, [fancy, image]);
    text.insert(0, "Hi", { sparkle: { level: 3 }, code: {} });
    expect(readDocument(doc)).toEqual([{ type: "paragraph", runs: [{ text: "Hi", code: true }] }]);
    expect(validateDocument(doc)).toEqual(["Block 1 is an unknown kind (callout)", "Block 2 is a picture without one"]);
  });
});

function make(markdown = ""): Y.Doc {
  const doc = new Y.Doc();
  initLiveDoc(doc, "document");
  if (markdown) writeDocument(doc, markdownToBlocks(markdown), SYSTEM);
  return doc;
}

const ids = (doc: Y.Doc) => readDocument(doc).map((b) => b.id as string);
const texts = (doc: Y.Doc) => readDocument(doc).map((b) => blocksText([b]));

describe("Markdown", () => {
  test("blocks", () => {
    const md = [
      "# Plano",
      "",
      "Um **texto** com *ênfase*, ~~riscado~~, `código`, <u>sublinhado</u> e [link](https://example.com).",
      "Segunda linha da mesma frase.  ",
      "Quebra antes desta.",
      "",
      "- um",
      "  - dois",
      "    - três",
      "- quatro",
      "",
      "1. primeiro",
      "2. segundo",
      "",
      "> citado",
      "> - em lista",
      "",
      "```sql",
      "select 1;",
      "```",
      "",
      "---",
      "",
      "| Nome | Total |",
      "| --- | ---: |",
      "| Ada | 12 |",
      "| Atlas \\| B | `a|b` |",
      "",
      "![Gráfico](asset:abc123)",
      "",
      "Título setext",
      "===",
      "#### fundo",
    ].join("\n");
    const blocks = markdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "blockquote",
      "code_block",
      "horizontal_rule",
      "table",
      "image",
      "heading",
      "heading",
    ]);
    expect(blocks[1]).toEqual({
      type: "paragraph",
      runs: [
        { text: "Um " },
        { text: "texto", bold: true },
        { text: " com " },
        { text: "ênfase", italic: true },
        { text: ", " },
        { text: "riscado", strike: true },
        { text: ", " },
        { text: "código", code: true },
        { text: ", " },
        { text: "sublinhado", underline: true },
        { text: " e " },
        { text: "link", link: "https://example.com" },
        { text: ". Segunda linha da mesma frase.\nQuebra antes desta." },
      ],
    });
    expect(blocks.slice(2, 8).map((b) => [(b as DocParagraph).list, (b as DocParagraph).level ?? 0])).toEqual([
      ["bullet", 0],
      ["bullet", 1],
      ["bullet", 2],
      ["bullet", 0],
      ["ordered", 0],
      ["ordered", 0],
    ]);
    expect(blocks[8]).toEqual({
      type: "blockquote",
      blocks: [p("citado"), p("em lista", { list: "bullet" })],
    });
    expect(blocks[9]).toEqual({ type: "code_block", language: "sql", text: "select 1;" });
    expect(blocks[11]).toEqual({
      type: "table",
      header: true,
      rows: [
        [cell("Nome"), cell("Total")],
        [cell("Ada"), cell("12")],
        [cell("Atlas | B"), { blocks: [{ type: "paragraph", runs: [{ text: "a|b", code: true }] }] }],
      ],
    });
    expect(blocks[12]).toEqual({ type: "image", asset: "abc123", alt: "Gráfico" });
    expect(blocks[13]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks[14]).toMatchObject({ type: "heading", level: 3, runs: [{ text: "fundo" }] });
  });

  test("links are only safe ones; bare addresses link; a picture with no known address stays words", () => {
    expect(markdownToBlocks("[x](javascript:alert(1)) and see https://ex.com/a.")[0]).toEqual({
      type: "paragraph",
      runs: [
        { text: "[x](javascript:alert(1)) and see " },
        { text: "https://ex.com/a", link: "https://ex.com/a" },
        { text: "." },
      ],
    });
    expect(markdownToBlocks("![logo](https://ex.com/l.png)")).toEqual([
      { type: "paragraph", runs: [{ text: "logo", link: "https://ex.com/l.png" }] },
    ]);
    const mapped = markdownToBlocks("![a](file:42)", { images: (src) => (src === "file:42" ? "asset42" : null) });
    expect(mapped).toEqual([{ type: "image", asset: "asset42", alt: "a" }]);
  });

  test("writing reads back the same", () => {
    const blocks: DocBlock[] = normalizeBlocks([
      { type: "heading", level: 2, runs: [{ text: "A " }, { text: "b", bold: true }] },
      {
        type: "paragraph",
        runs: [
          { text: "stars * and _under_ and [brackets] and `ticks` " },
          { text: "code `x`", code: true },
          { text: " " },
          { text: "both", bold: true, italic: true },
          { text: " " },
          { text: "u", underline: true },
          { text: " " },
          { text: "go", link: "https://ex.com/a_(b)" },
          { text: "\nnext" },
        ],
      },
      p("# not a heading"),
      p("1. not a list"),
      p("- not a bullet"),
      p("one", { list: "ordered" }),
      p("two", { list: "ordered" }),
      p("in", { list: "bullet", level: 1 }),
      p("indented", { level: 1 }),
      { type: "blockquote", blocks: [p("q"), { type: "code_block", text: "```\nx" }] },
      { type: "code_block", language: "js", text: "a\n\nb" },
      { type: "horizontal_rule" },
      { type: "image", asset: "abc", alt: "pic" },
      {
        type: "table",
        header: true,
        rows: [
          [cell("a|b"), cell("c")],
          [{ blocks: [{ type: "paragraph", runs: [{ text: "x\ny" }] }] }, cell("")],
          // Backslashes next to pipes: escaped once, by the text, never again by the cell.
          [cell("back\\ and \\|"), { blocks: [{ type: "paragraph", runs: [{ text: "c\\|d", code: true }] }] }],
        ],
      },
    ]);
    const md = documentToMarkdown(blocks);
    expect(markdownToBlocks(md)).toEqual(blocks);
    expect(documentToMarkdown(markdownToBlocks(md))).toBe(md);
  });

  test("with ids, each block's first line names it", () => {
    const doc = make("# T\n\n- a\n- b");
    const [h, a, b] = ids(doc);
    expect(documentToMarkdown(readDocument(doc), { ids: true })).toBe(`[#${h}] # T\n\n[#${a}] - a\n[#${b}] - b\n`);
  });

  test("random documents settle after one pass", () => {
    let seed = 99;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
    const words = ["alpha", "beta gamma", "x*y", "a_b", "[c]", "#h", "1. n", "- d", "`t`", "|", "ç", "~", "<b>", "\\"];
    for (let n = 0; n < 200; n++) {
      const blocks: DocBlock[] = [];
      for (let b = Math.floor(rand() * 6); b > 0; b--) {
        const runs: DocRun[] = [];
        for (let r = Math.floor(rand() * 4) + 1; r > 0; r--) {
          const run: DocRun = { text: pick(words) };
          if (rand() < 0.3) run.bold = true;
          if (rand() < 0.2) run.italic = true;
          if (rand() < 0.15) run.code = true;
          if (rand() < 0.1) run.link = "https://ex.com/p";
          runs.push(run, { text: " " });
        }
        const kind = pick(["p", "li", "h", "t", "q"] as const);
        if (kind === "h") blocks.push({ type: "heading", level: pick([1, 2, 3] as const), runs });
        else if (kind === "t")
          blocks.push({ type: "table", header: true, rows: [[{ blocks: [{ type: "paragraph", runs }] }]] });
        else if (kind === "q") blocks.push({ type: "blockquote", blocks: [{ type: "paragraph", runs }] });
        else
          blocks.push({
            type: "paragraph",
            runs,
            ...(kind === "li" ? { list: pick(["bullet", "ordered"] as const) } : {}),
          });
      }
      const once = markdownToBlocks(documentToMarkdown(normalizeBlocks(blocks)));
      const twice = markdownToBlocks(documentToMarkdown(once));
      expect(twice).toEqual(once);
      expect(blocksText(once).replace(/\s+/g, " ").trim()).toBe(
        blocksText(normalizeBlocks(blocks)).replace(/\s+/g, " ").trim(),
      );
    }
  });
});

describe("edits by block", () => {
  test("a new document is one empty paragraph with an id", () => {
    const doc = make();
    const blocks = readDocument(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "paragraph", runs: [] });
    expect(blocks[0]?.id).toMatch(/^[0-9a-z]{10}$/);
    expect(validateDocument(doc)).toEqual([]);
  });

  test("insert, replace and delete, by id, each one transaction with its origin", () => {
    const doc = make("one\n\ntwo\n\nthree");
    const [one, two, three] = ids(doc) as [string, string, string];
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
    const [start] = insertBlocks(doc, markdownToBlocks("zero"), { after: null }, LOCAL);
    insertBlocks(doc, markdownToBlocks("one and a half"), { after: one }, LOCAL);
    insertBlocks(doc, markdownToBlocks("two minus"), { before: two }, LOCAL);
    const [end] = insertBlocks(doc, markdownToBlocks("four"), {}, LOCAL);
    expect(texts(doc)).toEqual(["zero", "one", "one and a half", "two minus", "two", "three", "four"]);
    expect(new Set(ids(doc)).size).toBe(7);
    expect(origins).toEqual([LOCAL, LOCAL, LOCAL, LOCAL]);
    // One block for one of the same kind: changed in place, its id and element kept.
    const element = documentBody(doc).get(ids(doc).indexOf(two));
    expect(replaceBlocks(doc, two, undefined, markdownToBlocks("TWO"), LOCAL)).toEqual([two]);
    expect(documentBody(doc).get(ids(doc).indexOf(two))).toBe(element);
    expect(readBlock(doc, two)).toEqual({ type: "paragraph", id: two, runs: [{ text: "TWO" }] });
    // A span for several: the first keeps the first id.
    const made = replaceBlocks(doc, two, three, markdownToBlocks("# Two\n\nthree!"), LOCAL);
    expect(made[0]).toBe(two);
    expect(readBlock(doc, two)).toMatchObject({ type: "heading", level: 1 });
    expect(deleteBlocks(doc, start as string, one, LOCAL)).toBe(2);
    expect(texts(doc)).toEqual(["one and a half", "two minus", "Two", "three!", "four"]);
    expect(() => replaceBlocks(doc, end as string, two, [], LOCAL)).toThrow(LiveEditError);
    expect(() => deleteBlocks(doc, "nope", undefined, LOCAL)).toThrow(LiveEditError);
    // Deleting everything leaves one empty paragraph.
    const all = ids(doc);
    deleteBlocks(doc, all[0] as string, all[all.length - 1], LOCAL);
    expect(readDocument(doc)).toMatchObject([{ type: "paragraph", runs: [] }]);
  });

  test("replacing text keeps its marks", () => {
    const doc = make("Hello **Ada**, hello Ada.\n\nAda again");
    const [first, second] = ids(doc) as [string, string];
    expect(replaceText(doc, "Ada", "Atlas", {}, LOCAL)).toBe(1);
    expect(readBlock(doc, first)).toMatchObject({
      runs: [{ text: "Hello " }, { text: "Atlas", bold: true }, { text: ", hello Ada." }],
    });
    expect(replaceText(doc, "ada", "Eve", { all: true, ignoreCase: true }, LOCAL)).toBe(2);
    expect(texts(doc)).toEqual(["Hello Atlas, hello Eve.", "Eve again"]);
    expect(replaceText(doc, "Eve", "", { block: second }, LOCAL)).toBe(1);
    expect(texts(doc)).toEqual(["Hello Atlas, hello Eve.", " again"]);
    expect(replaceText(doc, "missing", "x", { all: true }, LOCAL)).toBe(0);
  });

  test("ids: missing and repeated ones are made new", () => {
    const doc = make("a\n\nb\n\nc");
    const body = documentBody(doc);
    const [a] = ids(doc) as [string];
    (body.get(1) as Y.XmlElement).setAttribute("id", a);
    (body.get(2) as Y.XmlElement).removeAttribute("id");
    expect(ensureBlockIds(doc, LOCAL)).toBe(true);
    const now = ids(doc);
    expect(now[0]).toBe(a);
    expect(new Set(now).size).toBe(3);
    expect(ensureBlockIds(doc, LOCAL)).toBe(false);
  });

  test("limits", () => {
    const doc = make();
    const rows = Array.from({ length: 1001 }, () => [cell("x")]);
    expect(() => insertBlocks(doc, [{ type: "table", rows }], {}, LOCAL)).toThrow(LiveEditError);
    expect(() => insertBlocks(doc, [p("x".repeat(1_000_001))], {}, LOCAL)).toThrow(LiveEditError);
    expect(() => insertBlocks(doc, [], {}, LOCAL)).toThrow(LiveEditError);
  });
});

describe("the document as a whole", () => {
  test("preview, text and where it came from", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"words ".repeat(20)}`).join("\n\n");
    const doc = make(`# Report\n\n${long}`);
    setDocumentSource(doc, { name: "Report.docx", file: "f1" }, SYSTEM);
    const preview = documentPreview(doc);
    expect(preview.count).toBe(41);
    expect(preview.blocks[0]).toMatchObject({ type: "heading" });
    expect(preview.blocks.length).toBeLessThan(16);
    expect(preview.chars).toBeGreaterThan(4000);
    expect(preview.source).toEqual({ name: "Report.docx", file: "f1" });
    expect(documentSource(doc)).toEqual({ name: "Report.docx", file: "f1" });
    expect(documentText(doc).startsWith("Report\nParagraph 0")).toBe(true);
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
  });

  test("restoring a version changes only what differs, in one transaction", () => {
    const doc = make("a\n\nb\n\nc");
    const old = new Y.Doc();
    Y.applyUpdate(old, Y.encodeStateAsUpdate(doc));
    const [, b] = ids(doc) as [string, string];
    replaceBlocks(doc, b, undefined, markdownToBlocks("B!"), LOCAL);
    insertBlocks(doc, markdownToBlocks("d"), {}, LOCAL);
    const first = documentBody(doc).get(0);
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
    replaceDocument(doc, old, SYSTEM);
    expect(texts(doc)).toEqual(["a", "b", "c"]);
    expect(documentBody(doc).get(0)).toBe(first);
    expect(origins).toEqual([SYSTEM]);
  });

  test("a document a newer app wrote with loose text fails its rules of shape", () => {
    const doc = make();
    documentBody(doc).insert(1, [new Y.XmlText("loose")]);
    expect(validateDocument(doc)).toEqual(["Block 2 is loose text"]);
  });
});

describe("tables in all (ADR 0200)", () => {
  const cell = (text: string): DocCell => ({ blocks: [{ type: "paragraph", runs: text ? [{ text }] : [] }] });
  const table = (rows: number, cols: number): DocBlock => ({
    type: "table",
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => cell(""))),
  });

  test("a document's tables hold a bounded number of cells together", () => {
    const doc = new Y.Doc();
    initLiveDoc(doc, "document");
    // Five full tables at once are refused before anything is written.
    const five = Array.from({ length: 5 }, () => table(1000, 50));
    expect(() => insertBlocks(doc, five, { after: null }, "test")).toThrow(LiveEditError);
    // What's there counts too: one stored, four more would pass the budget.
    insertBlocks(doc, [table(1000, 50)], { after: null }, "test");
    expect(() => insertBlocks(doc, five.slice(0, 4), { after: null }, "test")).toThrow(LiveEditError);
    expect(validateDocument(doc)).toEqual([]);
  });

  test("ragged rows are padded only within the budget, so a read never builds millions of cells", () => {
    const [read] = normalizeBlocks([
      {
        type: "table",
        rows: [Array.from({ length: 50 }, () => cell("")), ...Array.from({ length: 9999 }, () => [cell("")])],
      },
    ]);
    expect(read?.type).toBe("table");
    if (read?.type === "table") expect(read.rows[1]?.length).toBe(1);
    const [small] = normalizeBlocks([{ type: "table", rows: [[cell("a"), cell("b")], [cell("c")]] }]);
    if (small?.type === "table") expect(small.rows[1]?.length).toBe(2);
  });
});
