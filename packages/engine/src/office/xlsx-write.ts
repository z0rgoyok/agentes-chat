import { type CellStyle, colName, type SheetData, type WorkbookData } from "@agenteschat/live";
import { zip } from "../zip";
import { addFunctionPrefixes } from "./formulas";
import { BUILTIN_NUMBER_FORMATS } from "./xlsx-read";
import { XML_HEAD, xmlAttr, xmlText } from "./xml";

/**
 * Workbooks written as Excel files (ADR 0198): values and formulas (with the values our engine computed cached in
 * them, and Excel told to compute again on open), styles (fonts, fills, borders, alignment, wrapping, number formats,
 * each distinct one written once), merged cells, column widths, row heights, frozen panes and tab colors, in a
 * package Excel, LibreOffice and Google Sheets open as is.
 */

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The app's own sizes: a column 100 px wide, a row 24 px (18 pt) high, text in 10 pt. */
const DEFAULT_COL_PX = 100;
const DEFAULT_ROW_PX = 24;
const DEFAULT_FONT_PT = 10;
const DEFAULT_FONT = "Arial";

/** Excel's limits on what a cell holds. */
const CELL_CHARS = 32_767;
const FORMULA_CHARS = 8192;

/** Pixels to Excel's column width (characters of a 7 px digit, padding included). */
export const pxToWidth = (px: number) => Math.trunc((px * 256) / 7) / 256;

const NOT_IN_SHEET_NAMES = "[]:*?/\\";

/** A sheet name Excel takes: no `[]:*?/\`, at most 31 characters, not blank, distinct from the others. */
function sheetNames(sheets: readonly SheetData[]): string[] {
  const seen = new Set<string>();
  return sheets.map((sheet, i) => {
    const raw = [...(sheet.name ?? "")]
      .map((ch) => (ch.charCodeAt(0) < 32 || NOT_IN_SHEET_NAMES.includes(ch) ? " " : ch))
      .join("");
    // Outer apostrophes out by index: `/'+$/` rescans each run of them (quadratic in the name's length).
    let start = 0;
    let end = raw.length;
    while (start < end && raw.charAt(start) === "'") start++;
    while (end > start && raw.charAt(end - 1) === "'") end--;
    let base = raw.slice(start, end).trim().slice(0, 31);
    if (!base || base.toLowerCase() === "history") base = `Sheet${i + 1}`;
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    seen.add(name.toLowerCase());
    return name;
  });
}

/** `#rrggbb` → Excel's ARGB. */
const argb = (hex: string) => `FF${hex.replace(/^#/, "").toUpperCase().padEnd(6, "0").slice(0, 6)}`;

interface StyleTable {
  /** The format index of a cell's style (0: the default). */
  xf(style: CellStyle | undefined): number;
  xml(): string;
}

/** Every distinct style once: fonts, fills, borders and number formats deduplicated, then their combinations. */
function styleTable(): StyleTable {
  const numFmts = new Map<string, number>();
  const fonts = new Map<string, number>();
  const fills = new Map<string, number>();
  const borders = new Map<string, number>();
  const xfs = new Map<string, number>();
  const fontXml: string[] = [];
  const fillXml: string[] = [];
  const borderXml: string[] = [];
  const xfXml: string[] = [];
  const byCode = new Map<string, number>();
  for (const [id, code] of Object.entries(BUILTIN_NUMBER_FORMATS)) {
    // The two dates Excel shows in the system's own form are written out, so they read the same everywhere.
    if (Number(id) !== 14 && Number(id) !== 22) byCode.set(code, Number(id));
  }

  const intern = (map: Map<string, number>, list: string[], xml: string) => {
    const known = map.get(xml);
    if (known !== undefined) return known;
    list.push(xml);
    map.set(xml, list.length - 1);
    return list.length - 1;
  };
  const font = (s: CellStyle | undefined) => {
    const parts = [
      s?.b ? "<b/>" : "",
      s?.i ? "<i/>" : "",
      s?.x ? "<strike/>" : "",
      s?.u ? "<u/>" : "",
      `<sz val="${s?.fs ?? DEFAULT_FONT_PT}"/>`,
      s?.fc ? `<color rgb="${argb(s.fc)}"/>` : "",
      `<name val="${DEFAULT_FONT}"/><family val="2"/>`,
    ];
    return intern(fonts, fontXml, `<font>${parts.join("")}</font>`);
  };
  const fill = (s: CellStyle | undefined) => {
    if (!s?.bg) return 0;
    const xml = `<fill><patternFill patternType="solid"><fgColor rgb="${argb(s.bg)}"/><bgColor indexed="64"/></patternFill></fill>`;
    return intern(fills, fillXml, xml);
  };
  const border = (s: CellStyle | undefined) => {
    const bd = s?.bd;
    const side = (tag: string, b: { w: number; c?: string } | undefined) => {
      if (!b) return `<${tag}/>`;
      const style = b.w >= 3 ? "thick" : b.w === 2 ? "medium" : "thin";
      const color = b.c ? `<color rgb="${argb(b.c)}"/>` : '<color indexed="64"/>';
      return `<${tag} style="${style}">${color}</${tag}>`;
    };
    const xml = `<border>${side("left", bd?.l)}${side("right", bd?.r)}${side("top", bd?.t)}${side("bottom", bd?.b)}<diagonal/></border>`;
    return intern(borders, borderXml, xml);
  };
  const numFmt = (s: CellStyle | undefined) => {
    const code = s?.nf;
    if (!code || code.toLowerCase() === "general") return 0;
    const builtin = byCode.get(code);
    if (builtin !== undefined) return builtin;
    const known = numFmts.get(code);
    if (known !== undefined) return known;
    const id = 164 + numFmts.size;
    numFmts.set(code, id);
    return id;
  };

  // The defaults first: font 0, the two fills Excel requires (none, gray125), an empty border, the plain format.
  font(undefined);
  intern(fills, fillXml, '<fill><patternFill patternType="none"/></fill>');
  intern(fills, fillXml, '<fill><patternFill patternType="gray125"/></fill>');
  border(undefined);
  intern(xfs, xfXml, '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');

  return {
    xf(style) {
      if (!style) return 0;
      const f = font(style);
      const fi = fill(style);
      const b = border(style);
      const n = numFmt(style);
      const horizontal = style.ha === "l" ? "left" : style.ha === "c" ? "center" : style.ha === "r" ? "right" : null;
      const vertical = style.va === "t" ? "top" : style.va === "m" ? "center" : style.va === "b" ? "bottom" : null;
      const align =
        horizontal || vertical || style.w
          ? `<alignment${horizontal ? ` horizontal="${horizontal}"` : ""}${vertical ? ` vertical="${vertical}"` : ""}${style.w ? ' wrapText="1"' : ""}/>`
          : "";
      const applies = [
        n ? ' applyNumberFormat="1"' : "",
        f ? ' applyFont="1"' : "",
        fi ? ' applyFill="1"' : "",
        b ? ' applyBorder="1"' : "",
        align ? ' applyAlignment="1"' : "",
      ].join("");
      const head = `<xf numFmtId="${n}" fontId="${f}" fillId="${fi}" borderId="${b}" xfId="0"${applies}`;
      return intern(xfs, xfXml, align ? `${head}>${align}</xf>` : `${head}/>`);
    },
    xml() {
      const fmts = [...numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xmlAttr(code)}"/>`);
      return [
        XML_HEAD,
        `<styleSheet xmlns="${MAIN}">`,
        fmts.length > 0 ? `<numFmts count="${fmts.length}">${fmts.join("")}</numFmts>` : "",
        `<fonts count="${fontXml.length}">${fontXml.join("")}</fonts>`,
        `<fills count="${fillXml.length}">${fillXml.join("")}</fills>`,
        `<borders count="${borderXml.length}">${borderXml.join("")}</borders>`,
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
        `<cellXfs count="${xfXml.length}">${xfXml.join("")}</cellXfs>`,
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
        '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>',
        "</styleSheet>",
      ].join("");
    },
  };
}

/** Shared strings: each distinct text once. */
function stringTable() {
  const index = new Map<string, number>();
  const list: string[] = [];
  let count = 0;
  return {
    of(text: string) {
      count++;
      const known = index.get(text);
      if (known !== undefined) return known;
      list.push(text);
      index.set(text, list.length - 1);
      return list.length - 1;
    },
    xml() {
      const items = list.map((text) => {
        const keep = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : "";
        return `<si><t${keep}>${xmlText(text)}</t></si>`;
      });
      return `${XML_HEAD}<sst xmlns="${MAIN}" count="${count}" uniqueCount="${list.length}">${items.join("")}</sst>`;
    },
  };
}

/** A number as XML Schema's double writes it (finite only). */
const numberText = (n: number) => (Object.is(n, -0) ? "0" : String(n));

/** Errors Excel knows; ours alone (a circular reference) is `#REF!` there, as Excel shows one. */
const excelError = (code: string) => (code === "#CYCLE!" ? "#REF!" : code);

function worksheetXml(
  sheet: SheetData,
  first: boolean,
  styles: StyleTable,
  strings: ReturnType<typeof stringTable>,
): string {
  const cells = [...sheet.cells]
    .filter((c) => Number.isInteger(c.r) && Number.isInteger(c.c) && c.r >= 0 && c.c >= 0)
    .sort((a, b) => a.r - b.r || a.c - b.c);
  const heights = sheet.rowHeights ?? {};
  const rows = new Map<number, string[]>();
  let previous = "";
  for (const cell of cells) {
    const ref = `${colName(cell.c)}${cell.r + 1}`;
    // One cell per address: a second one would make the file one Excel repairs.
    if (ref === previous) continue;
    previous = ref;
    const s = styles.xf(cell.s);
    const sAttr = s ? ` s="${s}"` : "";
    const formula =
      typeof cell.f === "string" && cell.f.trim() !== ""
        ? `<f>${xmlText(addFunctionPrefixes(cell.f.trim().replace(/^=/, "")).slice(0, FORMULA_CHARS))}</f>`
        : "";
    let xml: string;
    if (cell.e) {
      xml = `<c r="${ref}"${sAttr} t="e">${formula}<v>${xmlText(excelError(cell.e))}</v></c>`;
    } else if (typeof cell.v === "number" && Number.isFinite(cell.v)) {
      xml = `<c r="${ref}"${sAttr}>${formula}<v>${numberText(cell.v)}</v></c>`;
    } else if (typeof cell.v === "boolean") {
      xml = `<c r="${ref}"${sAttr} t="b">${formula}<v>${cell.v ? 1 : 0}</v></c>`;
    } else if (typeof cell.v === "string" && cell.v !== "") {
      const text = cell.v.slice(0, CELL_CHARS);
      xml = formula
        ? `<c r="${ref}"${sAttr} t="str">${formula}<v>${xmlText(text)}</v></c>`
        : `<c r="${ref}"${sAttr} t="s"><v>${strings.of(text)}</v></c>`;
    } else if (formula) {
      xml = `<c r="${ref}"${sAttr}>${formula}</c>`;
    } else if (s) {
      xml = `<c r="${ref}"${sAttr}/>`;
    } else continue;
    const list = rows.get(cell.r);
    if (list) list.push(xml);
    else rows.set(cell.r, [xml]);
  }
  for (const key of Object.keys(heights)) {
    const r = Number(key);
    if (Number.isInteger(r) && r >= 0 && !rows.has(r)) rows.set(r, []);
  }
  const rowXml = [...rows.keys()]
    .sort((a, b) => a - b)
    .map((r) => {
      const px = heights[r];
      const ht =
        typeof px === "number" && px > 0 && px !== DEFAULT_ROW_PX
          ? ` ht="${Math.round(px * 0.75 * 100) / 100}" customHeight="1"`
          : "";
      const content = rows.get(r) as string[];
      return content.length > 0 ? `<row r="${r + 1}"${ht}>${content.join("")}</row>` : `<row r="${r + 1}"${ht}/>`;
    });

  // Columns: runs of the same width in one element.
  const widths = Object.entries(sheet.colWidths ?? {})
    .map(([i, px]) => [Number(i), px] as const)
    .filter(([i, px]) => Number.isInteger(i) && i >= 0 && typeof px === "number" && px > 0 && px !== DEFAULT_COL_PX)
    .sort((a, b) => a[0] - b[0]);
  const cols: string[] = [];
  for (let k = 0; k < widths.length; ) {
    const [start, px] = widths[k] as readonly [number, number];
    let end = start;
    while (k + 1 < widths.length && widths[k + 1]?.[0] === end + 1 && widths[k + 1]?.[1] === px) {
      end++;
      k++;
    }
    k++;
    cols.push(`<col min="${start + 1}" max="${end + 1}" width="${pxToWidth(px)}" customWidth="1"/>`);
  }

  const lastRow = Math.max(sheet.rows, 1);
  const lastCol = Math.max(sheet.cols, 1);
  const frozenRows = Math.max(0, Math.min(sheet.frozen?.rows ?? 0, lastRow));
  const frozenCols = Math.max(0, Math.min(sheet.frozen?.cols ?? 0, lastCol));
  let pane = "";
  if (frozenRows > 0 || frozenCols > 0) {
    const active = frozenRows > 0 && frozenCols > 0 ? "bottomRight" : frozenRows > 0 ? "bottomLeft" : "topRight";
    const topLeft = `${colName(frozenCols)}${frozenRows + 1}`;
    pane = `<pane${frozenCols > 0 ? ` xSplit="${frozenCols}"` : ""}${frozenRows > 0 ? ` ySplit="${frozenRows}"` : ""} topLeftCell="${topLeft}" activePane="${active}" state="frozen"/><selection pane="${active}" activeCell="${topLeft}" sqref="${topLeft}"/>`;
  }
  const merges = (sheet.merges ?? [])
    .filter((m) => [m.r1, m.c1, m.r2, m.c2].every((n) => Number.isInteger(n) && n >= 0))
    .map((m) => {
      const a = `${colName(Math.min(m.c1, m.c2))}${Math.min(m.r1, m.r2) + 1}`;
      const b = `${colName(Math.max(m.c1, m.c2))}${Math.max(m.r1, m.r2) + 1}`;
      return a === b ? "" : `<mergeCell ref="${a}:${b}"/>`;
    })
    .filter(Boolean);
  const tab =
    sheet.tab && /^#[0-9a-f]{6}$/i.test(sheet.tab) ? `<sheetPr><tabColor rgb="${argb(sheet.tab)}"/></sheetPr>` : "";
  return [
    XML_HEAD,
    `<worksheet xmlns="${MAIN}" xmlns:r="${REL_NS}">`,
    tab,
    `<dimension ref="A1:${colName(lastCol - 1)}${lastRow}"/>`,
    `<sheetViews><sheetView${first ? ' tabSelected="1"' : ""} workbookViewId="0">${pane}</sheetView></sheetViews>`,
    `<sheetFormatPr baseColWidth="10" defaultColWidth="${pxToWidth(DEFAULT_COL_PX)}" defaultRowHeight="${DEFAULT_ROW_PX * 0.75}" customHeight="1"/>`,
    cols.length > 0 ? `<cols>${cols.join("")}</cols>` : "",
    rowXml.length > 0 ? `<sheetData>${rowXml.join("")}</sheetData>` : "<sheetData/>",
    merges.length > 0 ? `<mergeCells count="${merges.length}">${merges.join("")}</mergeCells>` : "",
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>',
    "</worksheet>",
  ].join("");
}

/** A workbook as an `.xlsx` file. */
export function writeXlsx(data: WorkbookData): Uint8Array {
  const sheets = data.sheets.length > 0 ? data.sheets : [{ name: "Sheet1", rows: 1, cols: 1, cells: [] }];
  const names = sheetNames(sheets);
  const styles = styleTable();
  const strings = stringTable();
  const worksheets = sheets.map((sheet, i) => worksheetXml(sheet, i === 0, styles, strings));
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const files: [string, string][] = [
    [
      "[Content_Types].xml",
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${worksheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `${XML_HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${DOC_REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    ],
    [
      "docProps/core.xml",
      `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
    ],
    [
      "docProps/app.xml",
      `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>agentes.chat</Application></Properties>`,
    ],
    [
      "xl/workbook.xml",
      `${XML_HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL_NS}"><workbookPr/><bookViews><workbookView activeTab="0"/></bookViews><sheets>${names.map((name, i) => `<sheet name="${xmlAttr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `${XML_HEAD}<Relationships xmlns="${PKG_REL}">${worksheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${DOC_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${worksheets.length + 1}" Type="${DOC_REL}/styles" Target="styles.xml"/><Relationship Id="rId${worksheets.length + 2}" Type="${DOC_REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ],
    ...worksheets.map((xml, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, xml]),
    ["xl/styles.xml", styles.xml()],
    ["xl/sharedStrings.xml", strings.xml()],
  ];
  return zip(files);
}
