import { describe, expect, test } from "bun:test";
import { documentToMarkdown, LiveEditError, markdownToBlocks } from "@agenteschat/live";
import { docxToDocument, readCsv, readXls } from "../src/office";
import { parseXml, tagCount } from "../src/office/xml";
import { zip } from "../src/zip";
import { docxDocument } from "./office-fixtures";

/**
 * What a hostile file or text can make the server do while it reads one (ADR 0198, 0200): Markdown, Word tables,
 * OpenDocument repeats and CSV lines that would cost the square of their size, or millions of cells, on the server's
 * own thread. Each case would take minutes or fill the memory without its bound; here it is refused or read in a
 * blink, and ordinary input reads as before.
 */

/** Runs `fn` and says how long it took, in milliseconds. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

const blocks = (markdown: string) => markdownToBlocks(markdown, { images: () => null });
const textOf = (markdown: string) =>
  blocks(markdown)
    .flatMap((b) => ("runs" in b ? b.runs.map((r) => r.text) : []))
    .join("");

describe("Markdown into a document reads in linear time", () => {
  test("a heading line of spaces that can't end (the old pattern took cubic time: minutes for 8 KB)", () => {
    const { value, ms } = timed(() => blocks(`#${" ".repeat(20_000)}\u2028`));
    expect(ms).toBeLessThan(2000);
    expect(value[0]?.type).toBe("paragraph");
  });

  test("headings read as before: closing #s, a lone run of #s, no space after the #s", () => {
    expect(blocks("## Title ##")).toEqual([{ type: "heading", level: 2, runs: [{ text: "Title" }] }]);
    expect(blocks("# a#b ##")).toEqual([{ type: "heading", level: 1, runs: [{ text: "a#b" }] }]);
    expect(blocks("# ##")).toEqual([{ type: "heading", level: 1, runs: [{ text: "##" }] }]);
    expect(blocks("#hashtag")[0]?.type).toBe("paragraph");
    expect(blocks("####### seven")[0]?.type).toBe("paragraph");
  });

  test("list items, fences and table rules on long lines that then fail", () => {
    const long = " ".repeat(200_000);
    const lines = [`-${long}\u2028`, `\`\`\`${long}\``, `a|b\n-${long}x`, `a\n${"\\".repeat(200_000)}x\nb`];
    for (const markdown of lines) {
      const { ms } = timed(() => blocks(markdown));
      expect(ms).toBeLessThan(2000);
    }
    expect(blocks("```js\nconst a = 1;\n```")).toEqual([{ type: "code_block", language: "js", text: "const a = 1;" }]);
    expect(blocks("``` `x`")[0]?.type).toBe("paragraph");
    const table = blocks("| a | b |\n| --- | :-: |\n| 1 | 2 |")[0];
    expect(table?.type).toBe("table");
    expect(table?.type === "table" ? table.rows.length : 0).toBe(2);
    expect(blocks("- item")).toEqual([{ type: "paragraph", list: "bullet", runs: [{ text: "item" }] }]);
    expect(blocks("line one\\\nline two")[0]).toEqual({ type: "paragraph", runs: [{ text: "line one\nline two" }] });
  });

  test("text full of openers that never close reads as words, fast", () => {
    for (const markdown of [
      " _a".repeat(40_000),
      "[".repeat(200_000),
      "![".repeat(100_000),
      "[a](".repeat(50_000),
      "<u>".repeat(60_000),
      "http://a.".repeat(20_000),
    ]) {
      const { value, ms } = timed(() => textOf(markdown));
      expect(ms).toBeLessThan(3000);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  test("marks, links and addresses read as before", () => {
    expect(blocks("**bold** and _it_ [site](https://acme.example) at https://acme.example/a(b)).")[0]).toEqual({
      type: "paragraph",
      runs: [
        { text: "bold", bold: true },
        { text: " and " },
        { text: "it", italic: true },
        { text: " " },
        { text: "site", link: "https://acme.example" },
        { text: " at " },
        { text: "https://acme.example/a(b)", link: "https://acme.example/a(b)" },
        { text: ")." },
      ],
    });
    expect(blocks("<u>under</u> `code`")[0]).toEqual({
      type: "paragraph",
      runs: [{ text: "under", underline: true }, { text: " " }, { text: "code", code: true }],
    });
  });

  test("a document with a long run of spaces inside a mark writes its Markdown fast", () => {
    const run = { text: `a${" ".repeat(200_000)}b`, bold: true as const };
    const { value, ms } = timed(() => documentToMarkdown([{ type: "paragraph", runs: [run] }]));
    expect(ms).toBeLessThan(2000);
    expect(value.startsWith("**a")).toBe(true);
    expect(
      documentToMarkdown([{ type: "paragraph", runs: [{ text: "x " }, { text: "bold ", bold: true }] }]),
    ).toContain("x **bold** ");
  });

  test("short table rows under a wide header can't ask for millions of cells", () => {
    // Each table: a header of 50 columns, a rule, 999 rows of a single "|": 2 KB asking for 50,000 cells.
    const table = `${"|".repeat(51)}\n-\n${"|\n".repeat(999)}\n`;
    const { value, ms } = timed(() => {
      try {
        blocks(table.repeat(400));
        return null;
      } catch (error) {
        return error;
      }
    });
    expect(ms).toBeLessThan(3000);
    expect(value).toBeInstanceOf(LiveEditError);
    expect((value as LiveEditError).code).toBe("too_large");
    // A table past a document's limits is refused with the words the document's own check uses.
    expect(() => blocks(`${"|a".repeat(60)}|\n-\n|1|\n`)).toThrow("A table holds at most 50 columns");
    expect(() => blocks(`|a|\n-\n${"|1|\n".repeat(1000)}`)).toThrow("A table holds at most 1000 rows");
    // One table within them reads as before.
    expect(blocks(table)[0]?.type).toBe("table");
  });
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docxOf = (body: string) =>
  zip([
    ["word/document.xml", `<w:document ${W}><w:body>${body}</w:body></w:document>`],
    [
      "word/_rels/document.xml.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    ],
  ]);
const asDocument = (bytes: Uint8Array) =>
  docxToDocument(bytes, { pictureId: () => crypto.randomUUID(), maxPictureBytes: 1e6, maxEachBytes: 1e6 });

describe("a Word document's tables as a live document", () => {
  test("a few hundred bytes of short rows under a row of wide cells is refused before it is filled out", () => {
    const wide = `<w:tr>${'<w:tc><w:tcPr><w:gridSpan w:val="63"/></w:tcPr></w:tc>'.repeat(200)}</w:tr>`;
    const bytes = docxOf(`<w:tbl>${wide}${"<w:tr><w:tc/></w:tr>".repeat(200)}</w:tbl>`);
    expect(bytes.byteLength).toBeLessThan(2000);
    const { ms } = timed(() => expect(() => asDocument(bytes)).toThrow("A table holds at most 50 columns"));
    expect(ms).toBeLessThan(1000);
  });

  test("many tables within a document's limits are refused past the Office files' cells", () => {
    const table = `<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="50"/></w:tcPr></w:tc></w:tr>${"<w:tr><w:tc/></w:tr>".repeat(999)}</w:tbl>`;
    const bytes = docxOf(table.repeat(10));
    let error: unknown = null;
    try {
      asDocument(bytes);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: "office.too_large_to_edit" });
    // One such table is fine, and an ordinary document still reads.
    expect(asDocument(docxOf(table)).blocks[0]?.type).toBe("table");
    expect(asDocument(docxDocument()).blocks.some((b) => b.type === "table")).toBe(true);
  });
});

const ODS_NAMESPACES = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
].join(" ");

/** A one-sheet `.ods` whose sheet holds `rows`, with one cell style (`ce1`, a red fill). */
function odsWith(rows: string): Uint8Array {
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODS_NAMESPACES} office:version="1.3"><office:automatic-styles><style:style style:name="ce1" style:family="table-cell"><style:table-cell-properties fo:background-color="#ff0000"/></style:style></office:automatic-styles><office:body><office:spreadsheet><table:table table:name="S">${rows}</table:table></office:spreadsheet></office:body></office:document-content>`;
  return zip(
    [
      ["mimetype", "application/vnd.oasis.opendocument.spreadsheet"],
      ["content.xml", content],
    ],
    { store: (path) => path === "mimetype" },
  );
}

const floatCell = (cols: number, extra = "") =>
  `<table:table-cell office:value-type="float" office:value="1" table:number-columns-repeated="${cols}"${extra}><text:p>1</text:p></table:table-cell>`;

describe("an OpenDocument spreadsheet's repeats", () => {
  test("a cell asking for a million rows of a thousand columns is refused before a cell is made", async () => {
    const bomb = odsWith(`<table:table-row table:number-rows-repeated="1000000">${floatCell(1000)}</table:table-row>`);
    const start = performance.now();
    await expect(readXls(bomb)).rejects.toMatchObject({ code: "office.too_large" });
    expect(performance.now() - start).toBeLessThan(2000);
  });

  test("a comment hides nothing, and a repeat is a whole number (anything else is one)", async () => {
    const commented = odsWith(
      `<table:table-row table:number-rows-repeated="1000000"><!-- <table:table-row> --><!-- </table:table-row> -->${floatCell(1000)}</table:table-row>`,
    );
    await expect(readXls(commented)).rejects.toMatchObject({ code: "office.too_large" });
    for (const odd of ["1e6", "Infinity", "-5", "abc"]) {
      const book = await readXls(
        odsWith(`<table:table-row table:number-rows-repeated="${odd}">${floatCell(1000)}</table:table-row>`),
      );
      expect(book.sheets[0]?.cells.length).toBe(1000);
    }
  });

  test("small repeats read; a long empty or styled tail makes no cells past the content", async () => {
    const book = await readXls(
      odsWith(
        `<table:table-row table:number-rows-repeated="3">${floatCell(2)}<table:table-cell table:style-name="ce1"/></table:table-row><table:table-row table:number-rows-repeated="1048570"><table:table-cell table:style-name="ce1" table:number-columns-repeated="16384"/></table:table-row>`,
      ),
    );
    const sheet = book.sheets[0];
    // Six numbers; the styled cell beside them is past their last column, and the styled tail past their last row.
    expect(sheet?.cells.length).toBe(6);
    expect(sheet?.rows).toBe(3);
    expect(sheet?.cols).toBe(2);
    const inside = await readXls(
      odsWith(`<table:table-row><table:table-cell table:style-name="ce1"/>${floatCell(1)}</table:table-row>`),
    );
    expect(inside.sheets[0]?.cells).toEqual([
      { r: 0, c: 1, v: 1 },
      { r: 0, c: 0, s: { bg: "#ff0000" } },
    ]);
  });
});

describe("CSV lines", () => {
  test("a file of nothing but line breaks is refused past a grid's rows before it is split", () => {
    const lines = new TextEncoder().encode("\n".repeat(2_000_000));
    const { value, ms } = timed(() => {
      try {
        return readCsv(lines, "x.csv");
      } catch (error) {
        return error;
      }
    });
    expect(value).toMatchObject({ code: "office.too_large" });
    expect(ms).toBeLessThan(2000);
    expect(readCsv(new TextEncoder().encode("a,b\n\n\n1,2\n"), "x.csv").sheets[0]?.rows).toBe(4);
  });
});

describe("Word and PowerPoint parts", () => {
  test("a part of millions of empty tags is refused before any tree is built", () => {
    const text = `<w:document>${"<w:p/>".repeat(1_100_000)}</w:document>`;
    const { value, ms } = timed(() => {
      try {
        return parseXml(text, "word/document.xml");
      } catch (error) {
        return error;
      }
    });
    expect(value).toMatchObject({ code: "office.unreadable" });
    expect(ms).toBeLessThan(2000);
    expect(tagCount("<a><b/></a>")).toBe(3);
  });
});
