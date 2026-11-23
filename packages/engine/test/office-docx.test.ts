import { describe, expect, test } from "bun:test";
import { docxToHtml, docxToMarkdown } from "../src/office";
import { zip } from "../src/zip";
import { DOC_PICTURE, docxDocument } from "./office-fixtures";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const documentOf = (body: string) =>
  zip([
    ["word/document.xml", `<w:document ${W}><w:body>${body}</w:body></w:document>`],
    [
      "word/_rels/document.xml.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    ],
  ]);

describe("a Word document as clean HTML", () => {
  test("headings by style (named in any language), runs, links, a field, lists, a table with merges, pictures", async () => {
    const html = await docxToHtml(docxDocument());
    const logo = `data:image/png;base64,${Buffer.from(DOC_PICTURE).toString("base64")}`;
    expect(html).toBe(
      [
        "<h1>Plano &amp; metas</h1>",
        "<h2>Resumo</h2>",
        "<p>Texto com <strong>negrito</strong>, <em><u>itálico</u></em><s>riscado</s> e &lt;script&gt;alert(1)&lt;/script&gt; inserido</p>",
        '<p><a href="https://acme.example">o site</a> perigo<br><a href="mailto:ada@acme.example">Ada</a></p>',
        "<ul><li>Item um<ul><li>Sub item</li></ul></li><li>Item dois</li></ul>",
        "<ol><li>Primeiro</li><li>Segundo</li></ol>",
        '<table><tbody><tr><th colspan="2"><p>Região</p></th><th><p>Total</p></th></tr>',
        '<tr><td rowspan="2"><p>Sul</p></td><td><p>A</p></td><td><p>10</p></td></tr>',
        "<tr><td><p>B</p></td><td><p>20</p></td></tr></tbody></table>",
        `<p><img src="${logo}" alt="Logo da Acme"></p>`,
      ].join(""),
    );
  });

  test("safe by construction: only its own tags and attributes, no script, no unsafe link, no other picture type", async () => {
    const html = await docxToHtml(docxDocument());
    const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
    const allowed = [
      "h1",
      "h2",
      "p",
      "strong",
      "em",
      "u",
      "s",
      "a",
      "br",
      "ul",
      "ol",
      "li",
      "table",
      "tbody",
      "tr",
      "th",
      "td",
      "img",
    ];
    for (const tag of tags) expect(allowed).toContain(tag as string);
    const attrs = new Set([...html.matchAll(/\s([a-z-]+)="/g)].map((m) => m[1]));
    for (const a of attrs) expect(["href", "src", "alt", "colspan", "rowspan"]).toContain(a as string);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("svg");
    expect(html).not.toContain("hidden");
    expect(html).not.toContain("removed");
  });

  test("a list whose numbering is missing reads as bullets; it ends at what isn't one; empty paragraphs are left out", async () => {
    const numbering =
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>One</w:t></w:r></w:p>' +
      "<w:p/>" +
      '<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>Next</w:t></w:r></w:p>';
    expect(await docxToHtml(documentOf(numbering))).toBe("<ul><li>One</li></ul><h3>Next</h3>");
  });

  test("a damaged, locked or foreign file is refused with the Office codes", async () => {
    await expect(docxToHtml(new TextEncoder().encode("plain"))).rejects.toMatchObject({ code: "office.unreadable" });
    await expect(docxToHtml(zip([["xl/workbook.xml", "<workbook/>"]]))).rejects.toMatchObject({
      code: "office.unreadable",
    });
    const locked = new Uint8Array(512);
    locked.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(docxToHtml(locked)).rejects.toMatchObject({ code: "office.encrypted" });
  });
});

describe("a Word document as Markdown", () => {
  test("headings, marks, links and line breaks, lists, a table kept aligned under merged cells, no pictures", async () => {
    const md = await docxToMarkdown(docxDocument());
    expect(md).toBe(
      [
        "# Plano & metas",
        "",
        "## Resumo",
        "",
        "Texto com **negrito**, *itálico*~~riscado~~ e \\<script\\>alert(1)\\</script\\> inserido",
        "",
        "[o site](https://acme.example) perigo  ",
        "[Ada](mailto:ada@acme.example)",
        "",
        "- Item um",
        "  - Sub item",
        "- Item dois",
        "1. Primeiro",
        "1. Segundo",
        "",
        "| Região |  | Total |",
        "| --- | --- | --- |",
        "| Sul | A | 10 |",
        "|  | B | 20 |",
        "",
      ].join("\n"),
    );
  });

  test("what Markdown would read as its own marks stays text", async () => {
    const body =
      '<w:p><w:r><w:t xml:space="preserve"># not a heading *nor* [a link](x)</w:t></w:r></w:p>' +
      "<w:p><w:r><w:t>1. not a list</w:t></w:r></w:p>";
    expect(await docxToMarkdown(documentOf(body))).toBe(
      "\\# not a heading \\*nor\\* \\[a link\\](x)\n\n1\\. not a list\n",
    );
  });
});
