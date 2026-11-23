import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SheetData } from "@agenteschat/live";
import {
  odsFormula,
  officeFormatOf,
  readBiff,
  readCsv,
  readOds,
  readWorkbook,
  readXls,
  writeCsv,
  writeXlsx,
} from "../src/office";
import { type FormulaContext, formulaText } from "../src/office/xls-formula";
import { zip } from "../src/zip";

const cellAt = (sheet: SheetData | undefined, r: number, c: number) => sheet?.cells.find((x) => x.r === r && x.c === c);
const bytes = (text: string) => new TextEncoder().encode(text);

/** Where `pattern` first appears in `data`, or -1. */
function indexOfBytes(data: Uint8Array, pattern: number[]): number {
  outer: for (let i = 0; i + pattern.length <= data.byteLength; i++) {
    for (let k = 0; k < pattern.length; k++) if (data[i + k] !== pattern[k]) continue outer;
    return i;
  }
  return -1;
}

describe("CSV and TSV", () => {
  test("semicolons with decimal commas, quoted fields with separators and line breaks, codes kept as text", () => {
    const book = readCsv(
      bytes(
        'Item;Preço\r\nCafé;12,50\r\n"Moído; fino";1.234,5\r\nCódigo;007\r\n"Nota ""longa""\nem duas linhas";-3\r\n',
      ),
      "precos.csv",
    );
    const sheet = book.sheets[0];
    expect(sheet?.name).toBe("precos");
    expect(sheet?.rows).toBe(5);
    expect(sheet?.cols).toBe(2);
    expect(cellAt(sheet, 0, 1)?.v).toBe("Preço");
    expect(cellAt(sheet, 1, 1)?.v).toBe(12.5);
    expect(cellAt(sheet, 2, 0)?.v).toBe("Moído; fino");
    expect(cellAt(sheet, 2, 1)?.v).toBe(1234.5);
    expect(cellAt(sheet, 3, 1)?.v).toBe("007");
    expect(cellAt(sheet, 4, 0)?.v).toBe('Nota "longa"\nem duas linhas');
    expect(cellAt(sheet, 4, 1)?.v).toBe(-3);
  });

  test("commas with decimal points, grouped thousands in quotes, a formula-looking field stays text", () => {
    const sheet = readCsv('name,total,note\nAda,"1,234.5",=SUM(A1)\nAtlas,2.5e3,\n').sheets[0];
    expect(cellAt(sheet, 1, 1)?.v).toBe(1234.5);
    expect(cellAt(sheet, 1, 2)).toEqual({ r: 1, c: 2, v: "=SUM(A1)" });
    expect(cellAt(sheet, 2, 1)?.v).toBe(2500);
    expect(cellAt(sheet, 2, 2)).toBeUndefined();
  });

  test("tabs by the name, Windows-1252 text and a byte order mark", async () => {
    const tsv = await readWorkbook(bytes("a\tb\n1\t2\n"), "data.tsv", "text/tab-separated-values");
    expect(tsv.sheets[0]?.cells).toHaveLength(4);
    const latin = new Uint8Array([0x50, 0x72, 0x65, 0xe7, 0x6f, 0x3b, 0x31, 0x0a]);
    expect(cellAt(readCsv(latin, "old.csv").sheets[0], 0, 0)?.v).toBe("Preço");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("x,y\n")]);
    expect(cellAt(readCsv(bom).sheets[0], 0, 0)?.v).toBe("x");
  });

  test("a sheet written as CSV: quoted where it must be, dates as they show, every row as wide as the widest", () => {
    const csv = writeCsv({
      name: "A",
      rows: 4,
      cols: 3,
      cells: [
        { r: 0, c: 0, v: "Item, with comma" },
        { r: 0, c: 2, v: 'say "hi"' },
        { r: 1, c: 0, v: 46343, s: { nf: "dd/mm/yyyy" }, t: "17/11/2026" },
        { r: 1, c: 1, v: 0.1 + 0.2 },
        { r: 2, c: 0, v: true },
        { r: 2, c: 1, f: "1/0", e: "#DIV/0!" },
        { r: 3, c: 2, v: "two\nlines" },
      ],
    });
    expect(csv).toBe(
      '"Item, with comma",,"say ""hi"""\r\n17/11/2026,0.30000000000000004,\r\nTRUE,#DIV/0!,\r\n,,"two\nlines"\r\n',
    );
    // And back.
    const back = readCsv(csv).sheets[0];
    expect(cellAt(back, 0, 0)?.v).toBe("Item, with comma");
    expect(cellAt(back, 3, 2)?.v).toBe("two\nlines");
  });

  test("past 200,000 cells it is too large", () => {
    const row = `${Array.from({ length: 50 }, (_, i) => i).join(",")}\n`;
    expect(() => readCsv(row.repeat(4001))).toThrow(expect.objectContaining({ code: "office.too_large" }));
  });
});

/** The fixtures' first sheet: B15 down holds these formulas (the workbook LibreOffice saved them from). */
const LEGACY_FORMULAS = [
  "SUM(E2:E13)",
  "AVERAGE(B2:B13)",
  "MAX(B2:B13)-MIN(B2:B13)",
  'COUNTIF(C2:C13,">3")',
  'IF(E2>10,"high","low")',
  'IFERROR(1/0,"error")',
  'VLOOKUP("Item 5 — ação",A2:E13,5,FALSE)',
  'INDEX(B2:B13,MATCH("Item 9 — ação",A2:A13,0))',
  'TEXT(F2,"dd/mm/yyyy")',
  'CONCATENATE(A2," & ",A3)',
  "ROUND(B5/3,2)",
  "SUMPRODUCT(B2:B11,C2:C11)",
  "'Other sheet'!A1*2",
  "SUM(C:C)",
  "-B2^2+(B3-B4)*2",
  "B2%",
  "AND($D2,NOT($D3))",
  "DATE(2024,1,31)+TIME(12,30,0)",
  'LEN(A2)&"x"',
  "ABS(-3)+MOD(10,3)+INT(2.7)+SQRT(16)",
  "1/0",
  "UPPER(LEFT(A2,3))",
  "SUMIF(C2:C13,2,B2:B13)",
  "PMT(0.01,12,1000)",
];

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, "fixtures/office", name)));

describe("legacy Excel and OpenDocument workbooks", () => {
  // legacy.xls and legacy.ods were saved by LibreOffice from one workbook: Costs (values, formulas, styles, a
  // merge), Other sheet, Hidden (a hidden sheet) and Texts (300 strings and two long enough to cross the legacy
  // format's record size, one byte and two bytes per character).
  for (const name of ["legacy.xls", "legacy.ods"]) {
    test(`${name}: values, formulas, styles and merges on the server's own reader; hidden sheets left out`, async () => {
      const book = await readWorkbook(fixture(name), name);
      expect(book.sheets.map((s) => s.name)).toEqual(["Costs", "Other sheet", "Texts"]);
      const sheet = book.sheets[0];
      expect(cellAt(sheet, 0, 0)).toEqual({
        r: 0,
        c: 0,
        v: "Item",
        s: { b: 1, bg: "#ffe599", ha: "c", bd: { b: { w: 2, c: "#000000" } } },
      });
      expect(cellAt(sheet, 1, 0)?.v).toBe("Item 1 — ação");
      expect(cellAt(sheet, 1, 1)).toMatchObject({ v: 1.5, s: { nf: "#,##0.00" } });
      expect(cellAt(sheet, 1, 5)).toMatchObject({ v: 45001, s: { nf: "dd/mm/yyyy" } });
      expect(cellAt(sheet, 2, 3)?.v).toBe(true);
      expect(cellAt(sheet, 4, 6)).toMatchObject({ v: 'note 4 🙂 "quoted" ünïcödé', s: { i: 1, fc: "#c00000", w: 1 } });
      expect(cellAt(sheet, 3, 4)).toMatchObject({ f: "B4*C4", v: 13.5 });
      for (const [i, f] of LEGACY_FORMULAS.entries()) expect(cellAt(sheet, 14 + i, 1)?.f).toBe(f);
      let total = 0;
      for (let i = 1; i <= 12; i++) total += 1.5 * i * (i % 7);
      expect(cellAt(sheet, 14, 1)?.v).toBe(total);
      expect(cellAt(sheet, 19, 1)?.v).toBe("error");
      expect(cellAt(sheet, 34, 1)?.e).toBe("#DIV/0!");
      expect(cellAt(sheet, 14, 0)).toMatchObject({ v: "Summary", s: { b: 1, fs: 14, va: "m" } });
      expect(sheet?.merges).toEqual([{ r1: 14, c1: 0, r2: 16, c2: 0 }]);
      expect(sheet?.rowHeights?.[0]).toBe(32);
      const texts = book.sheets[2];
      expect(cellAt(texts, 0, 1)?.v).toBe("Z".repeat(9000));
      expect(cellAt(texts, 1, 1)?.v).toBe(`${"ç".repeat(5000)}${"汉".repeat(5000)}`);
      expect(cellAt(texts, 299, 0)?.v).toBe("text 299");
    });
  }

  test(".xls: column widths and the tab's color from the file's own palette", () => {
    const sheet = readBiff(fixture("legacy.xls")).sheets[0];
    expect(sheet?.colWidths).toEqual({ 0: 180, 6: 300 });
    expect(sheet?.tab).toBe("#4472c4");
  });

  test(".xls: a file locked with a password, or saved by an Excel older than 97, says so", () => {
    const file = fixture("legacy.xls");
    // The workbook globals' BOF (BIFF8, globals), then the next record: made a FILEPASS of the same length.
    const at = indexOfBytes(file, [0x09, 0x08, 0x10, 0x00, 0x00, 0x06, 0x05, 0x00]);
    expect(at).toBeGreaterThan(0);
    const locked = file.slice();
    locked[at + 20] = 0x2f;
    locked[at + 21] = 0x00;
    expect(() => readBiff(locked)).toThrow(expect.objectContaining({ code: "office.encrypted" }));
    const old = file.slice();
    old[at + 5] = 0x05;
    expect(() => readBiff(old)).toThrow(expect.objectContaining({ code: "office.unreadable" }));
    expect(() => readBiff(old)).toThrow(/older than 97/);
  });

  test("damaged files are refused as damaged, never anything worse, and quickly", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const started = performance.now();
    for (const name of ["legacy.xls", "legacy.ods"]) {
      const file = fixture(name);
      const read = name.endsWith(".xls") ? readBiff : readOds;
      for (let i = 0; i < 150; i++) {
        const broken = i % 10 === 0 ? file.slice(0, rnd(file.byteLength)) : file.slice();
        if (i % 10 !== 0) for (let k = 0; k < 1 + rnd(8); k++) broken[rnd(broken.byteLength)] = rnd(256);
        try {
          read(broken);
        } catch (error) {
          expect((error as { code?: string }).code ?? String(error)).toMatch(/^office\./);
        }
      }
    }
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  test("an .ods past the unpacked budget is refused before its part is inflated", async () => {
    const bomb = zip(
      [
        ["mimetype", "application/vnd.oasis.opendocument.spreadsheet"],
        ["content.xml", new Uint8Array(41 * 1024 * 1024)],
      ],
      { store: (path) => path === "mimetype" },
    );
    await expect(readXls(bomb)).rejects.toMatchObject({ code: "office.too_large" });
  });

  test("a file named for one format and holding another is read for what it is", async () => {
    const xlsx = writeXlsx({ sheets: [{ name: "A", rows: 1, cols: 1, cells: [{ r: 0, c: 0, v: "real xlsx" }] }] });
    expect(cellAt((await readWorkbook(xlsx, "old.xls")).sheets[0], 0, 0)?.v).toBe("real xlsx");
    expect(cellAt((await readWorkbook(bytes("a,b\n"), "export.xls")).sheets[0], 0, 1)?.v).toBe("b");
    await expect(readWorkbook(bytes("x"), "notes.docx")).rejects.toMatchObject({ code: "office.unsupported" });
    await expect(readXls(bytes("not a workbook"))).rejects.toMatchObject({ code: "office.unreadable" });
  });

  test("formats by name first, then by declared type", () => {
    expect(officeFormatOf("Costs.XLSX")).toBe("xlsx");
    expect(officeFormatOf("deck.pptm")).toBe("pptx");
    expect(officeFormatOf("file", "application/vnd.ms-excel")).toBe("xls");
    expect(officeFormatOf("file", "text/csv; charset=utf-8")).toBe("csv");
    expect(officeFormatOf("old.doc", "application/msword")).toBeNull();
  });
});

describe("OpenDocument formulas in A1", () => {
  test("references, sheets, separators, strings and arrays are written as Excel writes them", () => {
    expect(odsFormula("of:=SUM([.A1:.B2];[$Sheet2.C3])")).toBe("SUM(A1:B2,Sheet2!C3)");
    expect(odsFormula("of:=['My sheet'.$A$1]*2")).toBe("'My sheet'!$A$1*2");
    expect(odsFormula("of:=SUM(['It''s'.A1:.A3])")).toBe("SUM('It''s'!A1:A3)");
    expect(odsFormula('of:=IF([.A1]>0;"a;[b]";"c")')).toBe('IF(A1>0,"a;[b]","c")');
    expect(odsFormula("of:=SUM([.A:.A])+SUM([.2:.3])")).toBe("SUM(A:A)+SUM(2:3)");
    expect(odsFormula("of:=COM.MICROSOFT.CONCAT([.A1];[.B1])")).toBe("CONCAT(A1,B1)");
    expect(odsFormula("of:=IF(TRUE();1;FALSE())")).toBe("IF(TRUE,1,FALSE)");
    expect(odsFormula("of:=SUM({1;2|3;4})")).toBe("SUM({1,2;3,4})");
    expect(odsFormula("of:=[.#REF!]+1")).toBe("#REF!+1");
    expect(odsFormula("msoxl:=SUM(A1:A3)")).toBe("SUM(A1:A3)");
  });

  test("what a live sheet can't hold is left out, and the cell keeps its value", () => {
    expect(odsFormula("of:=SUM([.A1]~[.B1])")).toBeNull();
    expect(odsFormula("of:=[.A1:.C3]![.B2:.D4]")).toBeNull();
    expect(odsFormula("of:=ORG.OPENOFFICE.WEEKS([.A1];[.B1];0)")).toBeNull();
    expect(odsFormula("of:=['file:///other.ods'#$Sheet1.A1]")).toBeNull();
    expect(odsFormula("of:=[.A1:Other.B2]")).toBeNull();
    expect(odsFormula('of:="never closed')).toBeNull();
    expect(odsFormula("SUM(A1)")).toBeNull();
  });
});

describe("legacy Excel formulas from their tokens", () => {
  const ctx: FormulaContext = {
    sheets: ["Sheet1", "Data 2"],
    names: [],
    externSheets: [{ first: 1, last: 1 }],
    externNames: () => null,
  };
  /** A reference's row and column fields; relative unless `abs`. */
  const loc = (row: number, col: number, abs = false) => [row & 0xff, row >> 8, col & 0xff, abs ? 0 : 0xc0];
  const text = (tokens: number[], at = { row: 0, col: 0 }, shared = false) =>
    formulaText(new Uint8Array(tokens), ctx, at, shared);

  test("operators, functions, absolute and 3-D references", () => {
    expect(text([0x24, ...loc(0, 0), 0x1e, 2, 0, 0x05])).toBe("A1*2");
    // Postfix with no parenthesis token still keeps its order.
    expect(text([0x24, ...loc(0, 0), 0x24, ...loc(0, 1), 0x03, 0x1e, 2, 0, 0x05])).toBe("(A1+B1)*2");
    expect(text([0x24, ...loc(0, 0), 0x24, ...loc(0, 1), 0x24, ...loc(0, 2), 0x04, 0x04])).toBe("A1-(B1-C1)");
    expect(text([0x24, ...loc(4, 1, true)])).toBe("$B$5");
    expect(text([0x3a, 0, 0, ...loc(4, 1)])).toBe("'Data 2'!B5");
    expect(text([0x25, 0, 0, 2, 0, 0, 0xc0, 0, 0xc0, 0x19, 0x10, 0, 0])).toBe("SUM(A1:A3)");
    expect(text([0x24, ...loc(0, 0), 0x1e, 1, 0, 0x1e, 2, 0, 0x42, 3, 1, 0])).toBe("IF(A1,1,2)");
    expect(text([0x17, 3, 0, 0x61, 0x22, 0x62])).toBe('"a""b"');
  });

  test("a shared formula's references are offsets from each cell that uses it", () => {
    // From row 5, column 2: one row up and one column right is row 4, column 3.
    expect(text([0x2c, 0xff, 0xff, 0x01, 0xc0], { row: 5, col: 2 }, true)).toBe("D5");
  });

  test("an unknown token or a broken program reads as no formula", () => {
    expect(text([0x18, 0, 0])).toBeNull();
    expect(text([0x24, ...loc(0, 0), 0x24, ...loc(0, 1)])).toBeNull();
    expect(text([0x05])).toBeNull();
    expect(text([0x1e, 1])).toBeNull();
    expect(text([0x21, 0xff, 0x7f])).toBeNull();
  });
});
