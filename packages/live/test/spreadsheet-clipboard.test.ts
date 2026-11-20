import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { LOCAL } from "../src/origins";
import {
  type ClipCell,
  copyRange,
  moveRange,
  parseHtmlTable,
  parseTsv,
  pasteCells,
  toTsv,
} from "../src/spreadsheet/clipboard";
import { colIds, getCell, readMerges, rowIds, SheetError, sheetSize } from "../src/spreadsheet/doc";
import { SheetEngine } from "../src/spreadsheet/engine";
import { addSheet, ensureSize, formatRange, mergeRange, setValues } from "../src/spreadsheet/ops";
import { cell, cells, EN, PT, range, sheetDoc, storedValues } from "./spreadsheet-fixtures";

/** What Excel puts on the clipboard as HTML for a small block (trimmed of Office's namespaces). */
const EXCEL_HTML = `<html xmlns:v="urn:schemas-microsoft-com:vml"
xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:x="urn:schemas-microsoft-com:office:excel"
xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv=Content-Type content="text/html; charset=utf-8">
<meta name=ProgId content=Excel.Sheet>
<meta name=Generator content="Microsoft Excel 15">
<style>
<!--table
	{mso-displayed-decimal-separator:"\\.";
	mso-displayed-thousand-separator:"\\,";}
@page
	{margin:.75in .7in .75in .7in;
	mso-header-margin:.3in;
	mso-footer-margin:.3in;}
tr
	{mso-height-source:auto;}
col
	{mso-width-source:auto;}
br
	{mso-data-placement:same-cell;}
td
	{padding-top:1px;
	padding-right:1px;
	padding-left:1px;
	mso-ignore:padding;
	color:black;
	font-size:11.0pt;
	font-weight:400;
	font-style:normal;
	text-decoration:none;
	font-family:Calibri, sans-serif;
	mso-font-charset:0;
	mso-number-format:General;
	text-align:general;
	vertical-align:bottom;
	border:none;
	mso-background-source:auto;
	mso-pattern:auto;
	mso-protection:locked visible;
	white-space:nowrap;
	mso-rotate:0;}
.xl65
	{font-weight:700;
	font-family:Calibri, sans-serif;
	mso-font-charset:0;}
.xl66
	{mso-number-format:"\\#\\,\\#\\#0\\.00";}
.xl67
	{mso-number-format:"Short Date";}
.xl68
	{color:red;
	background:yellow;
	mso-pattern:black none;}
.xl69
	{mso-number-format:"\\0022R$\\0022\\\\ \\#\\,\\#\\#0\\.00";}
.xl70
	{border-top:none;
	border-right:none;
	border-bottom:.5pt solid windowtext;
	border-left:none;
	white-space:normal;}
.xl71
	{mso-number-format:Percent;
	text-align:center;}
.xl72
	{font-size:14.0pt;
	text-align:center;}
-->
</style>
</head>
<body link="#0563C1" vlink="#954F72">
<table border=0 cellpadding=0 cellspacing=0 width=256 style='border-collapse:
 collapse;width:192pt'>
<!--StartFragment-->
 <col width=64 span=4 style='width:48pt'>
 <tr height=20 style='height:15.0pt'>
  <td height=20 class=xl65 width=64 style='height:15.0pt;width:48pt'>Product</td>
  <td class=xl65 width=64 style='width:48pt'>Price</td>
  <td class=xl65 width=64 style='width:48pt'>Date</td>
  <td class=xl65 width=64 style='width:48pt'>Share</td>
 </tr>
 <tr height=20 style='height:15.0pt'>
  <td height=20 class=xl68 style='height:15.0pt'>Widget</td>
  <td class=xl66 align=right x:num="1234.5">1,234.50</td>
  <td class=xl67 align=right x:num="46343">11/17/2026</td>
  <td class=xl71 x:num="0.125">12.50%</td>
 </tr>
 <tr height=40 style='height:30.0pt'>
  <td height=40 class=xl70 style='height:30.0pt'>Two<br>
    lines</td>
  <td class=xl69 align=right x:num="99">R$ 99.00</td>
  <td colspan=2 style='mso-ignore:colspan'>Spills over, not merged</td>
 </tr>
 <tr height=20 style='height:15.0pt'>
  <td height=20 style='height:15.0pt' x:str>007</td>
  <td align=right x:num>42</td>
  <td x:bool="TRUE">TRUE</td>
  <td x:err="#DIV/0!">#DIV/0!</td>
 </tr>
 <tr height=25 style='height:18.75pt'>
  <td colspan=2 height=25 class=xl72 style='height:18.75pt'>Merged title</td>
  <td>Atlas &amp; Co &lt;3</td>
  <td></td>
 </tr>
<!--EndFragment-->
</table>
</body>
</html>`;

/** What Google Sheets puts on the clipboard as HTML. */
const SHEETS_HTML =
  '<meta charset="utf-8"><google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}br {mso-data-placement:same-cell;}--></style>' +
  '<table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1" style="table-layout:fixed;font-size:10pt;font-family:Arial;width:0px;border-collapse:collapse;border:none" data-sheets-root="1">' +
  '<colgroup><col width="100"/><col width="100"/><col width="100"/></colgroup><tbody>' +
  '<tr style="height:21px;">' +
  '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;font-weight:bold;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;Item&quot;}">Item</td>' +
  '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;font-weight:bold;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;Qtd&quot;}">Qtd</td>' +
  '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;font-weight:bold;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;Total&quot;}">Total</td>' +
  "</tr>" +
  '<tr style="height:21px;">' +
  '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;Caneta&quot;}">Caneta</td>' +
  '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;text-align:right;" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:3}">3</td>' +
  '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;text-align:right;background-color:#fff2cc;" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:7.5}" data-sheets-numberformat="{&quot;1&quot;:4,&quot;2&quot;:&quot;\\&quot;R$\\&quot; #,##0.00&quot;,&quot;3&quot;:1}" data-sheets-formula="=R[0]C[-1]*2.5">R$ 7,50</td>' +
  "</tr>" +
  '<tr style="height:21px;">' +
  '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;border-bottom:1px solid #000000;" colspan="2" rowspan="1" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;Mesclado&quot;}">Mesclado</td>' +
  '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;text-align:right;" data-sheets-value="{&quot;1&quot;:4,&quot;4&quot;:1}">TRUE</td>' +
  "</tr>" +
  "</tbody></table>";

/** What LibreOffice Calc puts on the clipboard as HTML. */
const CALC_HTML = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN">
<html>
<head>
	<meta http-equiv="content-type" content="text/html; charset=utf-8"/>
	<title></title>
	<meta name="generator" content="LibreOffice 24.2.7.2 (Linux)"/>
	<style type="text/css">
		body,div,table,thead,tbody,tfoot,tr,th,td,p { font-family:"Liberation Sans"; font-size:x-small }
		a.comment-indicator:hover + comment { background:#ffd; position:absolute; display:block; border:1px solid black; padding:0.5em;  }
		a.comment-indicator { background:red; display:inline-block; border:1px solid black; width:0.5em; height:0.5em;  }
		comment { display:none;  }
	</style>
</head>
<body>
<table cellspacing="0" border="0">
	<colgroup width="85"></colgroup>
	<colgroup span="3" width="85"></colgroup>
	<tr>
		<td height="17" align="left"><b>Name</b></td>
		<td align="left"><b>Paid</b></td>
		<td align="left"><b><i>When</i></b></td>
		<td align="left"><b>Done</b></td>
	</tr>
	<tr>
		<td height="17" align="left"><font color="#C9211E">Ada</font></td>
		<td align="right" sdval="1234.5" sdnum="1033;0;#,##0.00">1,234.50</td>
		<td align="right" sdval="46343" sdnum="1033;0;MM/DD/YY">11/17/26</td>
		<td align="right" sdval="1" sdnum="1033;0;BOOLEAN">TRUE</td>
	</tr>
	<tr>
		<td height="17" align="left"><b>Atlas</b> &amp; Co</td>
		<td align="right" sdval="99" sdnum="1046;0;#.##0,00">99,00</td>
		<td align="right" sdval="0.5" sdnum="1033;0;0%">50%</td>
		<td align="left"><br></td>
	</tr>
</table>
</body>
</html>`;

/** A cell's row and column ids, for the engine. */
function ids(doc: Y.Doc, sheet: string, row: number, col: number): [string, string] {
  return [rowIds(doc, sheet)[row] as string, colIds(doc, sheet)[col] as string];
}

describe("text", () => {
  test("tab-separated text both ways", () => {
    expect(parseTsv("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseTsv("a\tb\r\nc\td\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseTsv('"two\nlines"\t"tab\there"\t"say ""hi"""')).toEqual([["two\nlines", "tab\there", 'say "hi"']]);
    expect(parseTsv('5" screen\t"open')).toEqual([['5" screen', '"open']]);
    expect(parseTsv("a\t\tc\n\tb\t")).toEqual([
      ["a", "", "c"],
      ["", "b", ""],
    ]);
    expect(parseTsv("one")).toEqual([["one"]]);
    expect(parseTsv("")).toEqual([]);
    expect(parseTsv("a\n\nb")).toEqual([["a"], [""], ["b"]]);
    const rows = [
      ["x", "tab\there"],
      ['q"uote', "line\nbreak"],
    ];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
  });
});

describe("copying", () => {
  test("cells with their formulas, formats and merges; text and HTML of what they show", () => {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        [1234.5, "=A1*2"],
        ["a\tb", "<b>&"],
        ["two\nlines", null],
      ],
      EN,
      LOCAL,
    );
    formatRange(doc, range(sheet, "A1"), { nf: "#,##0.00", b: 1, bg: "#fff2cc" }, LOCAL);
    mergeRange(doc, range(sheet, "A3:B3"), LOCAL);
    const copied = copyRange(doc, range(sheet, "A1:B3"), storedValues(doc), PT);
    expect(copied.cells[0]?.[0]).toEqual({
      v: 1234.5,
      s: { nf: "#,##0.00", b: 1, bg: "#fff2cc" },
      display: "1.234,50",
    });
    expect(copied.cells[0]?.[1]?.f?.startsWith("{")).toBe(true);
    expect(copied.cells[0]?.[1]?.a1).toBe("=A1*2");
    expect(copied.cells[2]?.[0]?.span).toEqual({ rows: 1, cols: 2 });
    expect(copied.cells[2]?.[1]).toEqual({});
    expect(copied.tsv).toBe('1.234,50\t\n"a\tb"\t<b>&\n"two\nlines"\t');
    expect(copied.html).toContain(
      '<td style="font-weight:bold;background-color:#fff2cc;white-space:nowrap">1.234,50</td>',
    );
    expect(copied.html).toContain("<td>&lt;b&gt;&amp;</td>");
    expect(copied.html).toContain('<td colspan="2">two<br>lines</td>');
    expect(copyRange(doc, range(sheet, "A200:B300"), storedValues(doc), EN)).toEqual({
      cells: [],
      tsv: "",
      html: '<meta charset="utf-8"><table style="border-collapse:collapse"><tbody></tbody></table>',
    });
  });

  test("formulas copy what they compute, and paste as values where asked", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[1234.5, "=A1*2", "=1/0", '=A1&" kg"']], EN, LOCAL);
    const engine = new SheetEngine(doc, { locale: PT });
    const copied = copyRange(doc, range(sheet, "A1:C1"), engine, PT);
    expect(copied.cells[0]?.[1]).toMatchObject({ v: 2469, display: "2469", a1: "=A1*2" });
    expect(copied.cells[0]?.[2]).toMatchObject({ e: "#DIV/0!", display: "#DIV/0!", a1: "=1/0" });
    expect(copied.tsv).toBe("1234,5\t2469\t#DIV/0!");
    const all = copyRange(doc, range(sheet, "A1:E1"), engine, PT);
    pasteCells(doc, { sheet, row: 2, col: 0 }, { cells: all.cells, source: { sheet, r1: 0, c1: 0 } }, PT, LOCAL, {
      valuesOnly: true,
    });
    expect(cells(doc, sheet, "A3:E3")).toEqual([["1234.5", "2469", "=#DIV/0!", "1234,5 kg", ""]]);
    expect(engine.valueAt(sheet, 0, 3)).toBe("1234,5 kg");
    expect(engine.valueAt(sheet, 2, 3)).toBe("1234,5 kg");
    engine.destroy();
  });
});

describe("copying a big selection", () => {
  test("a whole large sheet copies as far as something is there", () => {
    const { doc, sheet } = sheetDoc();
    ensureSize(doc, sheet, 2000, 100, LOCAL);
    setValues(doc, { sheet, row: 2, col: 1 }, [["Ada"]], EN, LOCAL);
    mergeRange(doc, range(sheet, "E10:F11"), LOCAL);
    const copied = copyRange(doc, range(sheet, "A1:CV2000"), storedValues(doc), EN);
    expect(copied.cells).toHaveLength(11);
    expect(copied.cells[0]).toHaveLength(6);
    expect(copied.cells[2]?.[1]).toEqual({ v: "Ada", display: "Ada" });
    expect(copied.cells[9]?.[4]?.span).toEqual({ rows: 2, cols: 2 });
    // A small selection keeps its empty edges, so pasting it empties what it lands on.
    expect(copyRange(doc, range(sheet, "A1:H20"), storedValues(doc), EN).cells).toHaveLength(20);
  });

  test("a merge over most of a sheet copies as one span", () => {
    const { doc, sheet } = sheetDoc();
    ensureSize(doc, sheet, 3000, 200, LOCAL);
    setValues(doc, { sheet, row: 0, col: 0 }, [["Title"]], EN, LOCAL);
    mergeRange(doc, range(sheet, "A1:GR3000"), LOCAL);
    const copied = copyRange(doc, range(sheet, "A1:GR3000"), storedValues(doc), EN);
    expect(copied.cells).toHaveLength(3000);
    expect(copied.cells[0]?.[0]).toEqual({ v: "Title", display: "Title", span: { rows: 3000, cols: 200 } });
    expect(copied.cells[2999]?.[199]).toEqual({});
  });
});

describe("pasting the app's own cells", () => {
  function source() {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        [1, "=A1*10"],
        [2, "=A2*10+$C$1"],
      ],
      EN,
      LOCAL,
    );
    formatRange(doc, range(sheet, "B1"), { b: 1 }, LOCAL);
    const copied = copyRange(doc, range(sheet, "A1:B2"), storedValues(doc), EN);
    return { doc, sheet, copied };
  }

  test("on the same sheet, formulas move as copies do", () => {
    const { doc, sheet, copied } = source();
    const at = pasteCells(
      doc,
      { sheet, row: 4, col: 0 },
      { cells: copied.cells, source: { sheet, r1: 0, c1: 0 } },
      EN,
      LOCAL,
    );
    expect(at).toEqual({ sheet, r1: 4, c1: 0, r2: 5, c2: 1 });
    expect(cells(doc, sheet, "A5:B6")).toEqual([
      ["1", "=A5*10"],
      ["2", "=A6*10+$C$1"],
    ]);
    expect(getCell(doc, sheet, 4, 1)?.s).toEqual({ b: 1 });
  });

  test("on another sheet, references land on that sheet's cells", () => {
    const { doc, sheet, copied } = source();
    const other = addSheet(doc, "Other", LOCAL);
    pasteCells(
      doc,
      { sheet: other, row: 2, col: 1 },
      { cells: copied.cells, source: { sheet, r1: 0, c1: 0 } },
      EN,
      LOCAL,
    );
    expect(cells(doc, other, "B3:C4")).toEqual([
      ["1", "=B3*10"],
      ["2", "=B4*10+$C$1"],
    ]);
  });

  test("in another file, formulas travel as English A1", () => {
    const { copied, sheet } = source();
    const { doc: elsewhere, sheet: target } = sheetDoc("Planilha 1");
    pasteCells(
      elsewhere,
      { sheet: target, row: 2, col: 0 },
      { cells: copied.cells, source: { sheet, r1: 0, c1: 0 } },
      PT,
      LOCAL,
    );
    expect(cells(elsewhere, target, "A3:B4")).toEqual([
      ["1", "=A3*10"],
      ["2", "=A4*10+$C$1"],
    ]);
  });

  test("values only keep the formats already there", () => {
    const { doc, sheet } = sheetDoc();
    formatRange(doc, range(sheet, "A1"), { fc: "#cf222e" }, LOCAL);
    const clip: ClipCell[][] = [
      [
        { v: 20, f: "{x,y}*2", s: { b: 1 }, display: "20" },
        { e: "#N/A", display: "#N/A" },
      ],
    ];
    pasteCells(doc, { sheet, row: 0, col: 0 }, { cells: clip }, EN, LOCAL, { valuesOnly: true });
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: 20, s: { fc: "#cf222e" } });
    expect(cell(doc, sheet, "B1")).toBe("=#N/A");
  });

  test("empty cells empty the cells they land on; merges are made again", () => {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        ["old", "old"],
        ["old", "old"],
      ],
      EN,
      LOCAL,
    );
    mergeRange(doc, range(sheet, "A2:B2"), LOCAL);
    const clip: ClipCell[][] = [
      [{}, { v: 5 }],
      [{ v: "title", span: { rows: 1, cols: 2 } }, {}],
    ];
    pasteCells(doc, { sheet, row: 0, col: 0 }, { cells: clip }, EN, LOCAL);
    expect(cells(doc, sheet, "A1:B2")).toEqual([
      ["", "5"],
      ["title", ""],
    ]);
    expect(readMerges(doc, sheet).map(({ r1, c1, r2, c2 }) => [r1, c1, r2, c2])).toEqual([[1, 0, 1, 1]]);
  });

  test("a copy repeats over a selection it fits a whole number of times", () => {
    const { doc, sheet } = sheetDoc();
    const clip: ClipCell[][] = [[{ v: 7 }]];
    const at = pasteCells(doc, { sheet, row: 0, col: 2 }, { cells: clip }, EN, LOCAL, {
      into: range(sheet, "C1:E3"),
    });
    expect(at).toEqual({ sheet, r1: 0, c1: 2, r2: 2, c2: 4 });
    expect(cells(doc, sheet, "C1:E3")).toEqual([
      ["7", "7", "7"],
      ["7", "7", "7"],
      ["7", "7", "7"],
    ]);
    const two: ClipCell[][] = [[{ v: 1 }, { v: 2 }]];
    const plain = pasteCells(doc, { sheet, row: 5, col: 0 }, { cells: two }, EN, LOCAL, {
      into: range(sheet, "A6:C6"),
    });
    expect(plain).toEqual({ sheet, r1: 5, c1: 0, r2: 5, c2: 1 });
  });

  test("the sheet grows to what is pasted", () => {
    const { doc, sheet } = sheetDoc();
    pasteCells(doc, { sheet, row: 99, col: 25 }, { tsv: "a\tb\nc\td\ne\tf" }, EN, LOCAL);
    expect(sheetSize(doc, sheet)).toEqual({ rows: 102, cols: 27 });
  });
});

describe("pasting from other apps", () => {
  test("text is read as typed, in the person's language", () => {
    const { doc, sheet } = sheetDoc();
    formatRange(doc, range(sheet, "A1"), { b: 1 }, LOCAL);
    pasteCells(
      doc,
      { sheet, row: 0, col: 0 },
      { tsv: "Produto\tPreço\nCaneta\tR$ 1.234,50\nLápis\t12,5%\n17/11/2026\t=SOMA(B2:B3)\n" },
      PT,
      LOCAL,
    );
    expect(cells(doc, sheet, "A1:B4")).toEqual([
      ["Produto", "Preço"],
      ["Caneta", "1234.5"],
      ["Lápis", "0.125"],
      ["46343", "=SUM(B2:B3)"],
    ]);
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: "Produto", s: { b: 1 } });
    expect(getCell(doc, sheet, 1, 1)?.s).toEqual({ nf: '"R$" #,##0.00' });
    expect(getCell(doc, sheet, 3, 0)?.s).toEqual({ nf: "dd/mm/yyyy" });
  });

  test("Excel's HTML: values, number formats, styles, line breaks and merges", () => {
    const grid = parseHtmlTable(EXCEL_HTML, EN);
    expect(grid?.length).toBe(5);
    const { doc, sheet } = sheetDoc();
    pasteCells(doc, { sheet, row: 0, col: 0 }, { html: EXCEL_HTML, tsv: "ignored" }, EN, LOCAL);
    expect(cells(doc, sheet, "A1:C5")).toEqual([
      ["Product", "Price", "Date"],
      ["Widget", "1234.5", "46343"],
      ["Two\nlines", "99", "Spills over, not merged"],
      ["007", "42", "true"],
      ["Merged title", "", "Atlas & Co <3"],
    ]);
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: "Product", s: { b: 1 } });
    expect(getCell(doc, sheet, 1, 0)).toEqual({ v: "Widget", s: { fc: "#ff0000", bg: "#ffff00" } });
    expect(getCell(doc, sheet, 1, 1)).toEqual({ v: 1234.5, s: { nf: "#,##0.00" } });
    expect(getCell(doc, sheet, 1, 2)).toEqual({ v: 46343, s: { nf: "m/d/yyyy" } });
    expect(getCell(doc, sheet, 1, 3)).toEqual({ v: 0.125, s: { nf: "0.00%", ha: "c" } });
    expect(getCell(doc, sheet, 2, 0)).toEqual({ v: "Two\nlines", s: { w: 1, bd: { b: { w: 1 } } } });
    expect(getCell(doc, sheet, 2, 1)).toEqual({ v: 99, s: { nf: '"R$"\\ #,##0.00' } });
    expect(getCell(doc, sheet, 3, 0)).toEqual({ v: "007" });
    expect(getCell(doc, sheet, 3, 2)).toEqual({ v: true });
    expect(getCell(doc, sheet, 3, 3)).toEqual({ f: "#DIV/0!" });
    expect(getCell(doc, sheet, 4, 0)).toEqual({ v: "Merged title", s: { fs: 14, ha: "c" } });
    expect(readMerges(doc, sheet).map(({ r1, c1, r2, c2 }) => [r1, c1, r2, c2])).toEqual([[4, 0, 4, 1]]);
  });

  test("Google Sheets' HTML: typed values, its number formats and its formulas", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 5, col: 5 }, [["keep"]], EN, LOCAL);
    pasteCells(doc, { sheet, row: 0, col: 0 }, { html: SHEETS_HTML }, PT, LOCAL);
    expect(cells(doc, sheet, "A1:C3")).toEqual([
      ["Item", "Qtd", "Total"],
      ["Caneta", "3", "=B2*2.5"],
      ["Mesclado", "", "true"],
    ]);
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: "Item", s: { b: 1 } });
    expect(getCell(doc, sheet, 1, 1)).toEqual({ v: 3 });
    expect(getCell(doc, sheet, 1, 2)?.s).toEqual({ bg: "#fff2cc", nf: '"R$" #,##0.00' });
    expect(getCell(doc, sheet, 2, 0)).toEqual({ v: "Mesclado", s: { bd: { b: { w: 1 } } } });
    expect(readMerges(doc, sheet).map(({ r1, c1, r2, c2 }) => [r1, c1, r2, c2])).toEqual([[2, 0, 2, 1]]);
    expect(cell(doc, sheet, "F6")).toBe("keep");
  });

  test("LibreOffice's HTML: its values, its formats spelled as Excel's, booleans and inline looks", () => {
    const { doc, sheet } = sheetDoc();
    pasteCells(doc, { sheet, row: 0, col: 0 }, { html: CALC_HTML }, EN, LOCAL);
    expect(cells(doc, sheet, "A1:C3")).toEqual([
      ["Name", "Paid", "When"],
      ["Ada", "1234.5", "46343"],
      ["Atlas & Co", "99", "0.5"],
    ]);
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: "Name", s: { b: 1 } });
    expect(getCell(doc, sheet, 0, 2)).toEqual({ v: "When", s: { b: 1, i: 1 } });
    expect(getCell(doc, sheet, 1, 0)).toEqual({ v: "Ada", s: { fc: "#c9211e" } });
    expect(getCell(doc, sheet, 1, 1)).toEqual({ v: 1234.5, s: { nf: "#,##0.00" } });
    expect(getCell(doc, sheet, 1, 2)).toEqual({ v: 46343, s: { nf: "MM/DD/YY" } });
    expect(getCell(doc, sheet, 1, 3)).toEqual({ v: true });
    // Only some of the words are bold: the cell isn't.
    expect(getCell(doc, sheet, 2, 0)).toEqual({ v: "Atlas & Co" });
    // A code spelled in Portuguese ("#.##0,00") would read wrong as Excel's: the value comes without it.
    expect(getCell(doc, sheet, 2, 1)).toEqual({ v: 99 });
    expect(getCell(doc, sheet, 2, 2)).toEqual({ v: 0.5, s: { nf: "0%" } });
    expect(getCell(doc, sheet, 2, 3)).toBeUndefined();
    const engine = new SheetEngine(doc, { locale: PT });
    // The code says month first, so it shows that way in any language.
    expect(engine.display(sheet, ...ids(doc, sheet, 1, 2), PT)).toBe("11/17/26");
    expect(engine.display(sheet, ...ids(doc, sheet, 1, 1), PT)).toBe("1.234,50");
    engine.destroy();
  });

  test("a whole cell inside a styled span or bold tag takes that look", () => {
    const html =
      "<table><tr>" +
      '<td><span style="font-weight:700;color:rgb(204, 0, 0)">Ada</span></td>' +
      "<td><strong> Atlas </strong></td>" +
      '<td><span style="text-decoration:underline"><em>#eng</em></span></td>' +
      '<td><s>old</s> <span style="color:#0b6bcb">new</span></td>' +
      "</tr></table>";
    const grid = parseHtmlTable(html, EN);
    expect(grid?.[0]?.map((c) => c.s)).toEqual([{ b: 1, fc: "#cc0000" }, { b: 1 }, { i: 1, u: 1 }, undefined]);
    expect(grid?.[0]?.map((c) => c.display)).toEqual(["Ada", "Atlas", "#eng", "old new"]);
  });

  test("a web page's table, and values only from HTML", () => {
    const html =
      "<p>Before</p><table><thead><tr><th>Name</th><th>Joined</th><th>Score</th></tr></thead>" +
      "<tbody><tr><td>Ada</td><td>2026-11-17</td><td>9.5</td></tr>" +
      "<tr><td><b>Atlas</b> &amp; Co</td><td>11/17/2026</td><td>1,234</td></tr></tbody></table>";
    const { doc, sheet } = sheetDoc();
    formatRange(doc, range(sheet, "C3"), { fc: "#0b6bcb" }, LOCAL);
    pasteCells(doc, { sheet, row: 0, col: 0 }, { html }, EN, LOCAL, { valuesOnly: true });
    expect(cells(doc, sheet, "A1:C3")).toEqual([
      ["Name", "Joined", "Score"],
      ["Ada", "46343", "9.5"],
      ["Atlas & Co", "46343", "1234"],
    ]);
    expect(getCell(doc, sheet, 2, 2)).toEqual({ v: 1234, s: { fc: "#0b6bcb", nf: "#,##0" } });
    expect(parseHtmlTable("<p>no table</p>", EN)).toBeNull();
  });

  test("rows spanned from above push cells to their right", () => {
    const grid = parseHtmlTable(
      "<table><tr><td rowspan=2>a</td><td>b</td></tr><tr><td>c</td></tr><tr><td>d</td><td>e</td></tr></table>",
      EN,
    );
    expect(grid?.map((row) => row.map((c) => c.display ?? (c as { covered?: boolean }).covered))).toEqual([
      ["a", "b"],
      [true, "c"],
      ["d", "e"],
    ]);
  });

  test("a page written to be slow to read: comments, selectors and <style>s left open take linear time", () => {
    // Each of these took a regex quadratic time in the page's length.
    const html =
      `<style>${"/*a".repeat(60_000)}</style>` +
      "<style><!--td.blue {color:#0b6bcb} /* a note */--></style>" +
      "<style>".repeat(60_000) +
      '<table><tr><td class="blue">Ada</td></tr></table>';
    const started = performance.now();
    const grid = parseHtmlTable(html, EN);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(grid?.[0]?.[0]).toMatchObject({ display: "Ada", s: { fc: "#0b6bcb" } });
  });
});

describe("cutting and pasting", () => {
  const merged = (doc: Y.Doc, sheet: string) => readMerges(doc, sheet).map(({ r1, c1, r2, c2 }) => [r1, c1, r2, c2]);

  test("cells move; their formulas keep pointing where they did, and formulas pointing at them follow", () => {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        [1, "=SUM(A1:A2)", "=A1*10", "=SUM(A1:A9)", "=SUM(A:A)"],
        [2, "", "", "", ""],
        ["=A1+A2+C1", "", "", "", ""],
      ],
      EN,
      LOCAL,
    );
    formatRange(doc, range(sheet, "A1"), { b: 1 }, LOCAL);
    expect(moveRange(doc, range(sheet, "A1:A3"), { sheet, row: 4, col: 5 }, LOCAL)).toEqual(range(sheet, "F5:F7"));
    expect(cells(doc, sheet, "F5:F7")).toEqual([["1"], ["2"], ["=F5+F6+C1"]]);
    expect(getCell(doc, sheet, 4, 5)).toEqual({ v: 1, s: { b: 1 } });
    expect(cells(doc, sheet, "A1:A3")).toEqual([[""], [""], [""]]);
    expect(getCell(doc, sheet, 0, 0)).toBeUndefined();
    // A cell or a range wholly inside follows; a range partly inside and whole columns stay.
    expect(cells(doc, sheet, "B1:E1")).toEqual([["=SUM(F5:F6)", "=F5*10", "=SUM(A1:A9)", "=SUM(A:A)"]]);
  });

  test("moving a block down by one row over itself", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[1], [2], [3]], EN, LOCAL);
    setValues(doc, { sheet, row: 0, col: 2 }, [["=SUM(A1:A3)"]], EN, LOCAL);
    moveRange(doc, range(sheet, "A1:A3"), { sheet, row: 1, col: 0 }, LOCAL);
    expect(cells(doc, sheet, "A1:A4").map((r) => r[0])).toEqual(["", "1", "2", "3"]);
    expect(cell(doc, sheet, "C1")).toBe("=SUM(A2:A4)");
  });

  test("onto another sheet, moved formulas name their old sheet and the others name the new one", () => {
    const { doc, sheet } = sheetDoc();
    const two = addSheet(doc, "Two", LOCAL);
    setValues(doc, { sheet, row: 0, col: 0 }, [[5], ["=A1*2+C1"]], EN, LOCAL);
    setValues(doc, { sheet, row: 0, col: 2 }, [[1, null, "=A2"]], EN, LOCAL);
    setValues(doc, { sheet: two, row: 0, col: 0 }, [["='Sheet 1'!A1+1"]], EN, LOCAL);
    moveRange(doc, range(sheet, "A1:A2"), { sheet: two, row: 1, col: 1 }, LOCAL);
    expect(cells(doc, two, "B2:B3")).toEqual([["5"], ["=B2*2+'Sheet 1'!C1"]]);
    expect(cells(doc, sheet, "A1:A2")).toEqual([[""], [""]]);
    expect(cell(doc, sheet, "E1")).toBe("=Two!B3");
    expect(cell(doc, two, "A1")).toBe("=B2+1");
    const engine = new SheetEngine(doc, { locale: EN });
    expect(engine.valueAt(two, 2, 1)).toBe(11);
    expect(engine.valueAt(sheet, 0, 4)).toBe(11);
    engine.destroy();
  });

  test("merges inside move with the cells; one only partly inside can't be moved", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [["Title"]], EN, LOCAL);
    mergeRange(doc, range(sheet, "A1:B1"), LOCAL);
    mergeRange(doc, range(sheet, "F2:G3"), LOCAL);
    moveRange(doc, range(sheet, "A1:B2"), { sheet, row: 1, col: 4 }, LOCAL);
    expect(merged(doc, sheet)).toEqual([[1, 4, 1, 5]]);
    expect(cell(doc, sheet, "E2")).toBe("Title");
    mergeRange(doc, range(sheet, "A5:C5"), LOCAL);
    let reason: string | null = null;
    try {
      moveRange(doc, range(sheet, "A5:B6"), { sheet, row: 10, col: 0 }, LOCAL);
    } catch (e) {
      reason = e instanceof SheetError ? e.reason : null;
    }
    expect(reason).toBe("merged");
  });

  test("a move is one step to undo, and the sheet grows to fit", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[1, "=A1"]], EN, LOCAL);
    const undo = new Y.UndoManager([doc.getMap("sheets"), doc.getArray("sheetOrder")], {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: 0,
    });
    moveRange(doc, range(sheet, "A1"), { sheet, row: 149, col: 29 }, LOCAL);
    expect(sheetSize(doc, sheet)).toEqual({ rows: 150, cols: 30 });
    expect(cell(doc, sheet, "B1")).toBe("=AD150");
    undo.undo();
    expect(cells(doc, sheet, "A1:B1")).toEqual([["1", "=A1"]]);
    expect(sheetSize(doc, sheet)).toEqual({ rows: 100, cols: 26 });
    undo.destroy();
  });
});
