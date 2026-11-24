import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { PDF_MEDIA_TYPE } from "@agenteschat/providers";
import { docxText, markdownToDocx, markdownToPdf, pdfPages, pptxText, readForModel, xlsxText, zip } from "../src";
import { decodeXmlEntities } from "../src/format";
import { PNG, pptxFixture, xlsxFixture } from "./file-fixtures";

const bytesOf = (s: string) => new TextEncoder().encode(s);
const read = (name: string, bytes: Uint8Array, contentType = "application/octet-stream") =>
  readForModel({ name, contentType, bytes });
describe("readForModel", () => {
  test("a picture the model reads is shown; one past 3.5 MB says so with its size", () => {
    expect(read("print.png", PNG)).toEqual({
      images: [{ mediaType: "image/png", data: Buffer.from(PNG).toString("base64") }],
      note: "It is a picture: shown to you with this result.",
    });
    const big = new Uint8Array(3_600_000);
    big.set(PNG);
    const out = read("foto.png", big);
    expect(out.images).toBeUndefined();
    expect(out.note).toContain("It is a picture of 3.4 MB, past the 3.3 MB an AI is shown at once");
    expect(out.note).toContain("Tell the person exactly that");
  });

  test("a PDF goes as a document with its pages and name; a huge one gets the exact cause", () => {
    const pdf = markdownToPdf("# Relatório\n\nUm parágrafo.", { fonts: "standard" });
    const out = read("relatorio.pdf", pdf);
    expect(out.images).toEqual([
      { mediaType: PDF_MEDIA_TYPE, data: Buffer.from(pdf).toString("base64"), pages: 1, name: "relatorio.pdf" },
    ]);
    expect(out.note).toBe("It is a PDF (1 page): shown to you with this result.");
    const many = bytesOf(`%PDF-1.7\n${"<< /Type /Page >>\n".repeat(120)}<< /Type /Pages >>`);
    expect(read("livro.pdf", many).note).toContain("and 120 pages, past the 4.8 MB and 100 pages");
    // PDF 1.5+: the page objects and the page tree sit in compressed object streams.
    const objects = deflateSync(bytesOf(`${"<< /Type /Page >> ".repeat(3)}<< /Type /Pages /Kids [] /Count 140 >>`));
    const packed = Buffer.concat([
      bytesOf(`%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /N 4 /Filter /FlateDecode /Length ${objects.length} >>\nstream\n`),
      objects,
      bytesOf("\nendstream\nendobj\n"),
    ]);
    expect(pdfPages(packed)).toBe(140);
  });

  test("Word, PowerPoint and Excel come as their text; a zip as its listing", () => {
    const docx = read("contrato.docx", markdownToDocx("# Contrato\n\nOlá & bem-vindo, <Ana>."));
    expect(docx.note).toBe("Its text, read out of the Word document, follows.");
    expect(docx.text).toContain("Contrato");
    expect(docx.text).toContain("Olá & bem-vindo, <Ana>.");

    const pptx = read("deck.pptx", pptxFixture());
    expect(pptx.text).toBe("## Slide 2\nMetas & prazos\nQ4\n\n## Slide 10\nDez");

    const xlsx = read("precos.xlsx", xlsxFixture());
    expect(xlsx.note).toBe("Its sheets follow, each as CSV.");
    expect(xlsx.text).toBe(
      '## Sheet: Preços & prazos\nItem,,Preço,\r\n"Café, moído",sim,12.5,TRUE\n\n## Sheet: Vazia\n(empty)',
    );

    const archive = read(
      "fotos.zip",
      zip([
        ["a.txt", "oi"],
        ["pasta/b.png", PNG],
      ]),
    );
    expect(archive.text).toBe("a.txt (2 bytes)\npasta/b.png (10 bytes)");
    expect(archive.note).toContain("It is a zip archive (");
    expect(archive.note).toContain("import_file copies it there to unpack it");
  });

  test("code reads as text whatever type the browser gave (.ts arrives as video/mp2t)", () => {
    const ts = read("app.ts", bytesOf("export const a: number = 1;\n"), "video/mp2t");
    expect(ts).toEqual({ text: "export const a: number = 1;\n", note: "" });
    expect(read("dados.weird", bytesOf("a;b\n1;2"), "application/x-weird").text).toBe("a;b\n1;2");
    // A declared text type is read at any size; read_artifact pages it.
    const big = bytesOf("a,b\n".repeat(1_500_000));
    expect(read("grande.csv", big, "text/csv; charset=utf-8").text?.length).toBe(big.length);
  });

  test("audio is the caller's to transcribe; video, old Office, other pictures and binaries name the cause", () => {
    expect(read("voz.mp3", new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]), "audio/mpeg").audio).toBe(true);
    expect(read("clip.mp4", new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), "video/mp4").note).toContain(
      "It is a video (8 bytes), not shown to you as it is: review_media watches it",
    );
    expect(read("velho.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])).note).toContain(
      "older Office file (.doc), which can't be read here",
    );
    expect(read("foto.heic", new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74]), "image/heic").note).toContain(
      "a picture in a format AIs can't open (.heic)",
    );
    const bin = read("dados.bin", new Uint8Array([0, 1, 2, 3]));
    expect(bin.note).toBe(
      "It is a binary file (.bin, application/octet-stream, 4 bytes) that can't be shown to you as it is. Tell the person exactly that. With a computer, import_file copies it there to open with your own tools.",
    );
    expect(read("quebrado.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff])).note).toContain(
      "couldn't be opened: Not a zip file",
    );
  });

  test("XML entities decode, numeric ones too", () => {
    expect(decodeXmlEntities("a &amp; b &lt;c&gt; &#233; &#xE9; &bogus;")).toBe("a & b <c> é é &bogus;");
  });

  // Uploads are untrusted: a file built to make a pattern backtrack must still read in linear time.
  test("files crafted against the parsers read fast (no super-linear pattern)", () => {
    const MB = 2_000_000;
    const fast = (run: () => unknown) => {
      const t = performance.now();
      run();
      expect(performance.now() - t).toBeLessThan(500);
    };
    const pdf = (body: string) => bytesOf(`%PDF-1.7\n${body}`);
    fast(() => pdfPages(pdf("/Type/ObjStm".repeat(MB / 12))));
    fast(() => pdfPages(pdf(`${"/Type/ObjStm".repeat(MB / 12)}>>`)));
    fast(() => pdfPages(pdf(`/Count 0${"0".repeat(MB)}`)));
    fast(() => pdfPages(pdf("/Count 1 ".repeat(MB / 9))));
    fast(() => pdfPages(pdf(`${"/Type/ObjStm>>stream\n".repeat(MB / 20)}endstream`)));
    fast(() => docxText("<w:t ".repeat(MB / 5)));
    fast(() => docxText(`${"<w:t ".repeat(MB / 5)}>`));
    fast(() => pptxText("<a:t ".repeat(MB / 5)));
    const sheet = (files: Record<string, string>) => () => xlsxText((path) => files[path] ?? null);
    fast(sheet({ "xl/sharedStrings.xml": "<si>a".repeat(MB / 5) }));
    fast(sheet({ "xl/sharedStrings.xml": `<si>${"<t ".repeat(MB / 3)}></si>` }));
    fast(sheet({ "xl/_rels/workbook.xml.rels": "<Relationship ".repeat(MB / 14) }));
    fast(sheet({ "xl/workbook.xml": "<sheet ".repeat(MB / 7) }));
    fast(sheet({ "xl/workbook.xml": "<sheet/>", "xl/worksheets/sheet1.xml": "<c ".repeat(MB / 3) }));
    fast(sheet({ "xl/workbook.xml": "<sheet/>", "xl/worksheets/sheet1.xml": '<c r="A1">'.repeat(MB / 10) }));
    fast(sheet({ "xl/workbook.xml": "<sheet/>", "xl/worksheets/sheet1.xml": '<c r="ZZZZZZZZ1"><v>1</v></c>' }));
  });

  test("the linear readers keep what the patterns read: page trees, cells that close themselves, a cell left open", () => {
    expect(pdfPages(bytesOf("%PDF-1.7\n<< /Count 7 /Kids [] /Type /Pages >>"))).toBe(7);
    expect(pdfPages(bytesOf("%PDF-1.7\n<< /Type /Pages /Count 3 >> << /Count 9 >>"))).toBe(3);
    const files: Record<string, string> = {
      "xl/workbook.xml": '<sheet name="S"/>',
      "xl/sharedStrings.xml": '<si><t>um</t></si>x</si><si><r><t>do</t></r><r><t xml:space="preserve">is</t></r></si>',
      "xl/worksheets/sheet1.xml":
        '<c r="A1" t="s"><v>0</v></c><c r="B1"/><c r="C1" t="s"><v>1</v></c><c r="A2"><v>5</v><c r="B2" t="b"/>',
    };
    expect(xlsxText((path) => files[path] ?? null)).toBe("## Sheet: S\num,,dois\r\n,FALSE,");
  });
});
