import { describe, expect, test } from "bun:test";
import type { SheetData, WorkbookData } from "@agenteschat/live";
import { readWorkbook, readXlsx, writeXlsx } from "../src/office";
import { shiftA1, stripFunctionPrefixes } from "../src/office/formulas";
import { readZip, zip } from "../src/zip";
import { packageProblems } from "./office-fixtures";

const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const RELS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet ${MAIN}>
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot; #,##0.00"/></numFmts>
<fonts count="4">
  <font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
  <font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  <font><i/><u/><strike/><sz val="11"/><color theme="4" tint="-0.249977111117893"/><name val="Calibri"/></font>
  <font><b val="0"/><sz val="11"/><color indexed="10"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor theme="4"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
  <border><left/><right/><top/><bottom/><diagonal/></border>
  <border><left style="thin"><color rgb="FF000000"/></left><right style="medium"><color auto="1"/></right><top/><bottom style="double"><color theme="4"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="10" fontId="2" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0"><alignment horizontal="right"/></xf>
</cellXfs>
</styleSheet>`;

const STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst ${MAIN} count="6" uniqueCount="5">
<si><t>Item</t></si>
<si><t>Quantity</t></si>
<si><r><rPr><b/></rPr><t xml:space="preserve">Café, </t></r><r><t>moído</t></r><rPh sb="0" eb="1"><t>カフェ</t></rPh></si>
<si><t>Price &amp; tax</t></si>
<si><t>Total</t></si>
</sst>`;

/** A styled table: a merged title, a header row, shared formulas down a column, a total, a frozen header. */
const COSTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${MAIN} ${RELS}>
<sheetPr><tabColor rgb="FF00B050"/></sheetPr>
<dimension ref="A1:C6"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="1" max="1" width="24.7109375" customWidth="1"/><col min="2" max="3" width="12.7109375" customWidth="1"/></cols>
<sheetData>
<row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="inlineStr"><is><t>Costs 2026</t></is></c><c r="B1" s="1"/><c r="C1" s="1"/></row>
<row r="2"><c r="A2" s="1" t="s"><v>0</v></c><c r="B2" s="1" t="s"><v>1</v></c><c r="C2" s="1" t="s"><v>3</v></c></row>
<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><v>2</v></c><c r="C3" s="2"><f t="shared" ref="C3:C5" si="0">B3*12.5</f><v>25</v></c></row>
<row r="4"><c r="A4" t="str"><v>Tea</v></c><c r="B4"><v>3</v></c><c r="C4" s="2"><f t="shared" si="0"/><v>37.5</v></c></row>
<row r="5"><c r="A5" t="b"><v>1</v></c><c r="B5"><v>0.5</v></c><c r="C5" s="2"><f t="shared" si="0"/><v>6.25</v></c></row>
<row r="6"><c r="A6" t="s"><v>4</v></c><c r="C6" s="2"><f>SUM(C3:C5)</f><v>68.75</v></c></row>
</sheetData>
<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;

const OTHER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${MAIN} ${RELS}><sheetData>
<row r="1"><c r="A1" s="3"><v>46343</v></c><c r="B1" t="d"><v>2026-11-17T12:00:00</v></c><c r="C1" s="4"><v>0.125</v></c></row>
<row r="2"><c r="A2" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="B2"><f>_xlfn.XLOOKUP(A1,A1:A3,B1:B3)</f><v>1</v></c><c r="C2" s="5"><v>-4</v></c></row>
<row r="4"><c r="E4" t="str"><f t="array" ref="E4:E5">_xlfn._xlws.SORT(A1:A2)</f><v>x</v></c></row>
</sheetData></worksheet>`;

function workbookXlsx(extra: { date1904?: boolean } = {}): Uint8Array {
  return zip([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<Relationships ${PKG}><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `<workbook ${MAIN} ${RELS}><workbookPr${extra.date1904 ? ' date1904="1"' : ""}/><sheets><sheet name="Costs" sheetId="1" r:id="rId1"/><sheet name="Secret" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Other" sheetId="3" r:id="rId3"/></sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<Relationships ${PKG}><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/worksheet" Target="/xl/worksheets/sheet3.xml"/><Relationship Id="rId4" Type="${REL}/theme" Target="theme/theme1.xml"/><Relationship Id="rId5" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId6" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ],
    ["xl/theme/theme1.xml", THEME],
    ["xl/styles.xml", STYLES],
    ["xl/sharedStrings.xml", STRINGS],
    ["xl/worksheets/sheet1.xml", COSTS],
    [
      "xl/worksheets/sheet2.xml",
      `<worksheet ${MAIN}><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
    ],
    ["xl/worksheets/sheet3.xml", OTHER],
  ]);
}

const cellAt = (sheet: SheetData | undefined, r: number, c: number) => sheet?.cells.find((x) => x.r === r && x.c === c);

describe("reading an Excel workbook", () => {
  const book = readXlsx(workbookXlsx());
  const [costs, other] = book.sheets;

  test("visible sheets in order, hidden ones left out", () => {
    expect(book.sheets.map((s) => s.name)).toEqual(["Costs", "Other"]);
    expect(costs?.rows).toBe(6);
    expect(costs?.cols).toBe(3);
  });

  test("shared strings (rich runs joined, phonetic hints left out), inline strings, numbers and booleans", () => {
    expect(cellAt(costs, 0, 0)?.v).toBe("Costs 2026");
    expect(cellAt(costs, 1, 2)?.v).toBe("Price & tax");
    expect(cellAt(costs, 2, 0)?.v).toBe("Café, moído");
    expect(cellAt(costs, 3, 0)?.v).toBe("Tea");
    expect(cellAt(costs, 4, 0)?.v).toBe(true);
    expect(cellAt(costs, 4, 1)?.v).toBe(0.5);
  });

  test("shared formulas are expanded to each cell, with the cached values", () => {
    expect(cellAt(costs, 2, 2)).toMatchObject({ f: "B3*12.5", v: 25 });
    expect(cellAt(costs, 3, 2)).toMatchObject({ f: "B4*12.5", v: 37.5 });
    expect(cellAt(costs, 4, 2)).toMatchObject({ f: "B5*12.5", v: 6.25 });
    expect(cellAt(costs, 5, 2)).toMatchObject({ f: "SUM(C3:C5)", v: 68.75 });
  });

  test("styles: fonts, theme colors with tint, solid fills, borders, alignment, number formats", () => {
    expect(cellAt(costs, 0, 0)?.s).toEqual({
      b: 1,
      fc: "#ffffff",
      fs: 14,
      bg: "#4472c4",
      bd: { l: { w: 1, c: "#000000" }, r: { w: 2 }, b: { w: 3, c: "#4472c4" } },
      ha: "c",
      va: "m",
      w: 1,
    });
    // Styled empty cells under a merge keep their look.
    expect(cellAt(costs, 0, 1)?.s?.bg).toBe("#4472c4");
    expect(cellAt(costs, 2, 2)?.s).toEqual({ nf: '"R$" #,##0.00' });
    const tinted = cellAt(other, 0, 2)?.s;
    expect(tinted).toMatchObject({ i: 1, u: 1, x: 1, nf: "0.00%" });
    expect(tinted?.fc).toMatch(/^#[0-9a-f]{6}$/);
    expect(tinted?.fc).not.toBe("#4472c4");
    expect(cellAt(other, 1, 2)?.s).toEqual({ fc: "#ff0000", ha: "r" });
  });

  test("merges, column widths in pixels, row heights, frozen panes, tab color", () => {
    expect(costs?.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 2 }]);
    expect(costs?.colWidths).toEqual({ 0: 173, 1: 89, 2: 89 });
    expect(costs?.rowHeights).toEqual({ 0: 40 });
    expect(costs?.frozen).toEqual({ rows: 2, cols: 0 });
    expect(costs?.tab).toBe("#00b050");
  });

  test("dates by their number format, ISO dates, errors, and newer functions without their file prefix", () => {
    expect(cellAt(other, 0, 0)).toMatchObject({ v: 46343, s: { nf: "dd/mm/yyyy" } });
    expect(cellAt(other, 0, 1)?.v).toBeCloseTo(46343.5, 6);
    expect(cellAt(other, 1, 0)).toMatchObject({ f: "1/0", e: "#DIV/0!" });
    expect(cellAt(other, 1, 1)?.f).toBe("XLOOKUP(A1,A1:A3,B1:B3)");
    expect(cellAt(other, 3, 4)).toMatchObject({ f: "SORT(A1:A2)", v: "x" });
  });

  test("a workbook in the 1904 date system shows the same dates", () => {
    const shifted = readXlsx(workbookXlsx({ date1904: true })).sheets[1];
    expect(cellAt(shifted, 0, 0)?.v).toBe(46343 + 1462);
    expect(cellAt(shifted, 1, 2)?.v).toBe(-4);
  });

  test("parts that leave their namespaces out still read (some writers do)", async () => {
    const loose = zip([
      ["xl/workbook.xml", '<workbook><sheets><sheet name="Costs" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      [
        "xl/_rels/workbook.xml.rels",
        '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
      ],
      ["xl/sharedStrings.xml", "<sst><si><t>Item</t></si></sst>"],
      [
        "xl/worksheets/sheet1.xml",
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12.5</v></c><c r="C1"><f>B1*2</f><v>25</v></c></row></sheetData></worksheet>',
      ],
    ]);
    const read = await readWorkbook(loose, "costs.xlsx");
    expect(read.sheets[0]?.cells).toEqual([
      { r: 0, c: 0, v: "Item" },
      { r: 0, c: 1, v: 12.5 },
      { r: 0, c: 2, v: 25, f: "B1*2" },
    ]);
  });
});

describe("limits and damaged files", () => {
  const sheetOf = (rows: string) =>
    zip([
      [
        "xl/workbook.xml",
        `<workbook ${MAIN} ${RELS}><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<Relationships ${PKG}><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ],
      ["xl/worksheets/sheet1.xml", `<worksheet ${MAIN}><sheetData>${rows}</sheetData></worksheet>`],
    ]);

  test("past 200,000 cells it is too large", () => {
    const row = (r: number) =>
      `<row r="${r}">${["A", "B", "C", "E"].map((c) => `<c r="${c}${r}"><v>${r}</v></c>`).join("")}</row>`;
    const rows = Array.from({ length: 50_001 }, (_, i) => row(i + 1)).join("");
    expect(() => readXlsx(sheetOf(rows))).toThrow(expect.objectContaining({ code: "office.too_large" }));
  });

  test("a cell past Excel's last column or row is no cell: the sheet keeps its real size", () => {
    const first = '<row r="1"><c r="B1"><v>1</v></c><c r="XFE1"><v>2</v></c></row>';
    const past = '<row r="1048577"><c r="A1048577"><v>3</v></c><c><v>4</v></c></row>';
    const sheet = readXlsx(sheetOf(`${first}${past}`)).sheets[0];
    expect(sheet?.cells).toEqual([{ r: 0, c: 1, v: 1 }]);
    expect(sheet).toMatchObject({ rows: 1, cols: 2 });
  });

  test("a part that inflates past the budget is refused before it is inflated", () => {
    const bomb = zip([
      [
        "xl/workbook.xml",
        `<workbook ${MAIN} ${RELS}><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<Relationships ${PKG}><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ],
      ["xl/worksheets/sheet1.xml", new Uint8Array(41 * 1024 * 1024)],
    ]);
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    expect(() => readXlsx(bomb)).toThrow(expect.objectContaining({ code: "office.too_large" }));
  });

  test("a file locked with a password, a damaged one and one that isn't a zip", () => {
    const locked = new Uint8Array(512);
    locked.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => readXlsx(locked)).toThrow(expect.objectContaining({ code: "office.encrypted" }));
    expect(() => readXlsx(new TextEncoder().encode("hello"))).toThrow(
      expect.objectContaining({ code: "office.unreadable" }),
    );
    expect(() => readXlsx(zip([["xl/workbook.xml", "<workbook><sheets>"]]))).toThrow(
      expect.objectContaining({ code: "office.unreadable" }),
    );
  });

  test("a part declaring a document type is refused (no entity is ever expanded)", () => {
    const evil = zip([
      [
        "xl/workbook.xml",
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><workbook><sheets><sheet name="&a;" r:id="rId1"/></sheets></workbook>',
      ],
    ]);
    expect(() => readXlsx(evil)).toThrow(expect.objectContaining({ code: "office.unreadable" }));
  });
});

describe("writing an Excel workbook", () => {
  const data: WorkbookData = {
    sheets: [
      {
        name: "Budget: Q1/Q2",
        rows: 6,
        cols: 3,
        cells: [
          { r: 0, c: 0, v: "Costs 2026", s: { b: 1, fs: 14, fc: "#ffffff", bg: "#0063d1", ha: "c", va: "m", w: 1 } },
          { r: 0, c: 1, s: { b: 1, fs: 14, fc: "#ffffff", bg: "#0063d1", ha: "c", va: "m", w: 1 } },
          { r: 1, c: 0, v: "Item", s: { b: 1, bd: { b: { w: 2, c: "#000000" } } } },
          { r: 1, c: 1, v: "Price", s: { b: 1, bd: { b: { w: 2, c: "#000000" } } } },
          { r: 2, c: 0, v: "  Coffee & tea  " },
          { r: 2, c: 1, v: 12.5, s: { nf: '"R$" #,##0.00' } },
          { r: 3, c: 0, v: "Due" },
          { r: 3, c: 1, v: 46343, s: { nf: "dd/mm/yyyy", i: 1, u: 1, x: 1 } },
          { r: 4, c: 0, v: true },
          { r: 4, c: 1, f: "B3*2", v: 25, s: { nf: "0.00%" } },
          { r: 5, c: 0, f: "1/0", e: "#DIV/0!" },
          { r: 5, c: 1, f: "XLOOKUP(A3,A3:A4,B3:B4)", v: 12.5 },
          { r: 5, c: 2, f: 'IF(B3>1,"big","small")', v: "big" },
        ],
        colWidths: { 0: 180, 1: 120, 2: 120 },
        rowHeights: { 0: 40 },
        merges: [{ r1: 0, c1: 0, r2: 0, c2: 1 }],
        frozen: { rows: 2, cols: 1 },
        tab: "#0b7a6c",
      },
      { name: "Budget: Q1/Q2", rows: 1, cols: 1, cells: [{ r: 0, c: 0, v: "second" }] },
    ],
  };
  const bytes = writeXlsx(data);
  const parts = Object.fromEntries(
    readZip(bytes, { maxFiles: 50, maxBytes: 5_000_000 }).map((e) => [e.path, new TextDecoder().decode(e.data)]),
  );

  test("a complete package: content types, relationships, workbook, styles, shared strings, sheets", () => {
    expect(packageProblems(bytes)).toEqual([]);
    expect(Object.keys(parts).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/app.xml",
      "docProps/core.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/sharedStrings.xml",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]);
    expect(parts["xl/workbook.xml"]).toContain('<sheet name="Budget  Q1 Q2" sheetId="1" r:id="rId1"/>');
    expect(parts["xl/workbook.xml"]).toContain('<sheet name="Budget  Q1 Q2 (2)" sheetId="2" r:id="rId2"/>');
    expect(parts["xl/workbook.xml"]).toContain('fullCalcOnLoad="1"');
    // Excel requires the two built-in fills first, and every style once.
    expect(parts["xl/styles.xml"]).toContain('<fills count="3">');
    expect(parts["xl/styles.xml"]).toContain('<patternFill patternType="gray125"/>');
    expect(parts["xl/styles.xml"]?.match(/FF0063D1/g)?.length).toBe(1);
    expect(parts["xl/worksheets/sheet1.xml"]).toContain("<f>_xlfn.XLOOKUP(A3,A3:A4,B3:B4)</f>");
    expect(parts["xl/worksheets/sheet1.xml"]).toContain(
      '<pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/>',
    );
    expect(parts["xl/sharedStrings.xml"]).toContain('<t xml:space="preserve">  Coffee &amp; tea  </t>');
  });

  test("what it writes reads back the same", () => {
    const back = readXlsx(bytes);
    const sheet = back.sheets[0] as SheetData;
    expect(back.sheets.map((s) => s.name)).toEqual(["Budget  Q1 Q2", "Budget  Q1 Q2 (2)"]);
    const original = data.sheets[0] as SheetData;
    const strip = (cells: SheetData["cells"]) => cells.map(({ t: _t, ...rest }) => rest);
    expect(strip(sheet.cells)).toEqual(strip(original.cells));
    expect(sheet.merges).toEqual(original.merges);
    expect(sheet.colWidths).toEqual({ 0: 180, 1: 120, 2: 120 });
    expect(sheet.rowHeights).toEqual({ 0: 40 });
    expect(sheet.frozen).toEqual({ rows: 2, cols: 1 });
    expect(sheet.tab).toBe("#0b7a6c");
  });

  test("an empty workbook is still a valid file", () => {
    const empty = readXlsx(writeXlsx({ sheets: [] }));
    expect(empty.sheets).toHaveLength(1);
    expect(empty.sheets[0]?.cells).toEqual([]);
  });
});

describe("formulas as files hold them", () => {
  test("a shared formula moves its relative parts only", () => {
    expect(shiftA1("B3*12.5", 1, 0)).toBe("B4*12.5");
    expect(shiftA1("$B$3+B$3+$B3+B3", 2, 1)).toBe("$B$3+C$3+$B5+C5");
    expect(shiftA1("SUM(A1:B2)/LOG10(A1)", 1, 1)).toBe("SUM(B2:C3)/LOG10(B2)");
    expect(shiftA1("'My sheet'!A1+Sheet2!B$1", 3, 0)).toBe("'My sheet'!A4+Sheet2!B$1");
    expect(shiftA1('CONCAT("A1",A1)', 1, 0)).toBe('CONCAT("A1",A2)');
    expect(shiftA1("SUM(A:B)+SUM(1:2)", 1, 1)).toBe("SUM(B:C)+SUM(2:3)");
    expect(shiftA1("Table1[Total]+A1", 0, 1)).toBe("Table1[Total]+B1");
    expect(shiftA1("A1+1", -1, 0)).toBe("#REF!+1");
    expect(shiftA1("TRUE+A1+1.5E+3", 1, 0)).toBe("TRUE+A2+1.5E+3");
  });

  test("file prefixes of newer functions come off", () => {
    expect(stripFunctionPrefixes("=_xlfn.XLOOKUP(A1,B:B,C:C)")).toBe("XLOOKUP(A1,B:B,C:C)");
    expect(stripFunctionPrefixes("_xlfn._xlws.FILTER(A1:A9,B1:B9>0)")).toBe("FILTER(A1:A9,B1:B9>0)");
    expect(stripFunctionPrefixes('"_xlfn.X"&A1')).toBe('"_xlfn.X"&A1');
  });
});
