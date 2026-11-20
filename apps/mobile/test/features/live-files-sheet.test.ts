import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initLiveDoc, LOCAL } from "@agenteschat/live";
import {
  colWidths,
  mergeRange,
  SheetEngine,
  setFrozen,
  sheetIds,
  sheetLocale,
  type WorkbookData,
} from "@agenteschat/live/spreadsheet";
import * as Y from "yjs";
import {
  boxLabel,
  cellLabel,
  commitCell,
  formulaKeys,
  formulaProblem,
  insertReference,
  takesReference,
} from "../../src/features/live-files/spreadsheet/edit";
import {
  dataGridSource,
  liveGridLayout,
  liveGridSource,
  liveSheetTabs,
  selectionStats,
  tableWorkbook,
  workbookTabs,
} from "../../src/features/live-files/spreadsheet/model";

const PT = sheetLocale("pt-BR");
const EN = sheetLocale("en-US");
const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

function sheet(name = "Planilha 1") {
  const doc = new Y.Doc();
  initLiveDoc(doc, "spreadsheet", { sheetName: name });
  const id = sheetIds(doc)[0] as string;
  const engine = new SheetEngine(doc);
  const source = (locale = PT) => liveGridSource(doc, engine, id, liveGridLayout(doc, id), locale);
  return { doc, id, engine, source };
}

describe("typing into a cell on the phone, in the person's language (ADR 0196)", () => {
  test("Portuguese: decimal comma, semicolons between arguments, Excel's Brazilian names", () => {
    const { doc, id, engine, source } = sheet();
    engine.setLocale(PT);
    expect(commitCell(doc, { sheet: id, row: 0, col: 1 }, "12,5", PT)).toEqual({ ok: true });
    expect(commitCell(doc, { sheet: id, row: 1, col: 1 }, "7,5", PT)).toEqual({ ok: true });
    expect(commitCell(doc, { sheet: id, row: 2, col: 1 }, "=SOMA(B1;B2)", PT)).toEqual({ ok: true });
    const s = source();
    expect(s.value(2, 1)).toBe(20);
    expect(s.input(2, 1)).toBe("=SOMA(B1;B2)");
    expect(s.input(0, 1)).toBe("12,5");
    // The same file read in English shows the English way.
    expect(source(EN).input(2, 1)).toBe("=SUM(B1,B2)");
  });

  test("English: decimal point, commas, the English names", () => {
    const { doc, id, source } = sheet("Sheet 1");
    expect(commitCell(doc, { sheet: id, row: 0, col: 0 }, "1.5", EN)).toEqual({ ok: true });
    expect(commitCell(doc, { sheet: id, row: 1, col: 0 }, "=A1*2", EN)).toEqual({ ok: true });
    expect(source(EN).value(1, 0)).toBe(3);
  });

  test("a formula that can't be read is not written: the bar says why, in words", () => {
    const { doc, id, source } = sheet();
    const result = commitCell(doc, { sheet: id, row: 0, col: 0 }, "=SOMA(B1;B2", PT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.key).toBe("paren");
    expect(source().input(0, 0)).toBe("");
    expect(formulaProblem({ code: "args", fn: "SOMA", min: 1, max: 255 } as never)).toEqual({
      key: "args",
      params: { fn: "SOMA", min: 1, max: 255 },
    });
  });

  test("each edit is one step of the person's own undo, never an agent's", () => {
    const { doc, id, source } = sheet();
    const undo = new Y.UndoManager(doc.getMap("sheets"), { trackedOrigins: new Set([LOCAL]) });
    commitCell(doc, { sheet: id, row: 0, col: 0 }, "Ada", PT);
    undo.stopCapturing();
    expect(source().input(0, 0)).toBe("Ada");
    undo.undo();
    expect(source().input(0, 0)).toBe("");
  });
});

describe("formulas typed with taps", () => {
  test("a tap on a cell puts its address where a formula takes one", () => {
    expect(takesReference("=SOMA(", 6, PT)).toBe(true);
    expect(takesReference("=SOMA(B1;", 9, PT)).toBe(true);
    expect(takesReference("=SUM(B1,", 8, EN)).toBe(true);
    expect(takesReference("=SOMA(B1", 8, PT)).toBe(false);
    expect(takesReference("SOMA(", 5, PT)).toBe(false);
  });

  test("tapping around swaps the address just put for the new one", () => {
    const first = insertReference("=SOMA(", 6, "B2", null);
    expect(first).toEqual({ text: "=SOMA(B2", caret: 8, inserted: { start: 6, end: 8 } });
    const second = insertReference(first.text, first.caret, "C10", first.inserted);
    expect(second.text).toBe("=SOMA(C10");
    // Typed on after it: the next tap adds, never swaps.
    expect(insertReference("=SOMA(C10;", 10, "E1", second.inserted).text).toBe("=SOMA(C10;E1");
  });

  test("the keys over the keyboard follow the person's separator", () => {
    expect(formulaKeys(PT)).toContain(";");
    expect(formulaKeys(EN)).toContain(",");
    expect(formulaKeys(EN)).not.toContain(";");
  });

  test("addresses as the bar says them", () => {
    expect(cellLabel(3, 1)).toBe("B4");
    expect(boxLabel({ r1: 1, c1: 1, r2: 8, c2: 4 }, { rows: 100, cols: 26 })).toBe("B2:E9");
  });
});

describe("what the grid draws", () => {
  test("only the cells holding something, in the reader's language, numbers on the right", () => {
    const { doc, id, source } = sheet();
    commitCell(doc, { sheet: id, row: 0, col: 0 }, "Total", PT);
    commitCell(doc, { sheet: id, row: 0, col: 1 }, "1234,5", PT);
    const cells = source().cells({ r1: 0, c1: 0, r2: 5, c2: 3 });
    expect(cells.map((c) => [c.r, c.c, c.text, c.align])).toEqual([
      [0, 0, "Total", "l"],
      [0, 1, "1234,5", "r"],
    ]);
  });

  test("text runs over the empty cells on its right, until one holds something", () => {
    const { doc, id, source } = sheet();
    commitCell(doc, { sheet: id, row: 0, col: 0 }, "Um título bem comprido", PT);
    commitCell(doc, { sheet: id, row: 0, col: 3 }, "x", PT);
    const [title] = source().cells({ r1: 0, c1: 0, r2: 0, c2: 4 });
    const widths = colWidths(doc, id);
    expect(title?.spill).toBe((widths[1] ?? 0) + (widths[2] ?? 0));
  });

  test("an error shows in the reader's words; a merge covers its block", () => {
    const { doc, id, source } = sheet();
    commitCell(doc, { sheet: id, row: 0, col: 0 }, "=1/0", PT);
    mergeRange(doc, { sheet: id, r1: 2, c1: 0, r2: 3, c2: 2 }, LOCAL);
    const cells = source().cells({ r1: 0, c1: 0, r2: 4, c2: 3 });
    expect(cells[0]?.error?.code).toBe("#DIV/0!");
    const merged = cells.find((c) => c.r === 2 && c.c === 0);
    expect(merged).toMatchObject({ rows: 2, cols: 3 });
    // A merge reaching into the window from above still draws from its top-left cell.
    expect(
      source()
        .cells({ r1: 3, c1: 1, r2: 4, c2: 2 })
        .find((c) => c.r === 2),
    ).toMatchObject({ c: 0 });
  });

  test("the sheets as tabs, and frozen panes in the shape", () => {
    const { doc, id } = sheet();
    setFrozen(doc, id, 1, 0, LOCAL);
    expect(liveSheetTabs(doc)).toEqual([{ id, name: "Planilha 1" }]);
    expect(liveGridLayout(doc, id)).toMatchObject({ rows: 100, cols: 26, frozenRows: 1, frozenCols: 0 });
  });

  test("the selection's sum, average and count; nothing for one cell", () => {
    const { doc, id, source } = sheet();
    commitCell(doc, { sheet: id, row: 0, col: 0 }, "10", PT);
    commitCell(doc, { sheet: id, row: 1, col: 0 }, "20", PT);
    commitCell(doc, { sheet: id, row: 2, col: 0 }, "nota", PT);
    expect(selectionStats(source(), { r1: 0, c1: 0, r2: 3, c2: 0 })).toEqual({
      sum: 30,
      average: 15,
      count: 3,
      numbers: 2,
    });
    expect(selectionStats(source(), { r1: 0, c1: 0, r2: 0, c2: 0 })).toBeNull();
  });
});

describe("read-only workbooks: uploads and old tables (ADR 0198)", () => {
  const workbook: WorkbookData = {
    sheets: [
      {
        name: "Vendas",
        rows: 3,
        cols: 2,
        cells: [
          { r: 0, c: 0, v: "Mês", s: { b: 1 } },
          { r: 1, c: 1, v: 1234.5, s: { nf: "#,##0.00" } },
          { r: 2, c: 1, v: 99, f: "SUM(B2:B2)" },
          { r: 2, c: 0, e: "#N/A" },
        ],
        frozen: { rows: 1, cols: 0 },
        colWidths: { 0: 140 },
      },
      { name: "Custos", rows: 1, cols: 1, cells: [] },
    ],
  };

  test("values in the reader's language with the file's formats; formulas as the file wrote them", () => {
    const s = dataGridSource(workbook.sheets[0] as WorkbookData["sheets"][number], PT, "0");
    expect(s.layout).toMatchObject({ rows: 3, cols: 2, frozenRows: 1 });
    expect(s.layout.colStarts).toEqual([0, 140, 240]);
    const cells = s.cells({ r1: 0, c1: 0, r2: 2, c2: 1 });
    expect(cells.find((c) => c.r === 1)?.text).toBe("1.234,50");
    expect(cells.find((c) => c.r === 0)?.bold).toBe(true);
    expect(cells.find((c) => c.r === 2 && c.c === 0)?.text).toBe("#N/D");
    expect(s.input(2, 1)).toBe("=SUM(B2:B2)");
    expect(workbookTabs(workbook)).toEqual([
      { id: "0", name: "Vendas" },
      { id: "1", name: "Custos" },
    ]);
  });

  test("an old table is a one-sheet workbook: its header bold and kept on top, numbers on the right", () => {
    const book = tableWorkbook(
      "Leads",
      ["Nome", "Valor"],
      [
        ["Acme", "R$ 1.200"],
        ["Ada", "300"],
      ],
    );
    const only = book.sheets[0];
    expect(only).toMatchObject({ name: "Leads", rows: 3, cols: 2, frozen: { rows: 1, cols: 0 } });
    expect(only?.cells).toContainEqual({ r: 0, c: 0, v: "Nome", s: { b: 1 } });
    expect(only?.cells).toContainEqual({ r: 1, c: 1, v: "R$ 1.200", s: { ha: "r" } });
    expect(only?.cells).toContainEqual({ r: 1, c: 0, v: "Acme" });
  });

  test("the file screen draws them in the same grid, the upload's preview from the server", () => {
    const pages = src("features/live-files/office/OfficePages.tsx");
    expect(pages).toContain("useOfficePreview(orgId, table ? null : detail.id, detail.shownVersion)");
    expect(pages).toContain("<WorkbookView workbook={workbook}");
    const viewer = src("features/files/DocumentViewer.tsx");
    expect(viewer).toContain('info.view === "sheet" ? (');
    expect(viewer).toContain("<WordPage detail={detail} />");
  });
});

describe("the screen keeps to the kit and the app's rules", () => {
  const screen = src("features/live-files/spreadsheet/SpreadsheetScreen.tsx");
  const grid = src("features/live-files/spreadsheet/SheetGrid.tsx");

  test("cells and labels keep their size whatever the person's text size; the grid is a gesture surface", () => {
    expect(grid.match(/allowFontScaling=\{false\}/g)?.length).toBeGreaterThanOrEqual(3);
    expect(grid).toContain("useSimultaneousGestures(pinch, pan, tap, hold)");
  });

  test("the person's own selection is ink, never the agents' blue", () => {
    expect(grid).toContain("borderColor: c.ink");
    expect(grid).not.toMatch(/c\.agent|colors\.agent/);
  });

  test("the cell bar rides the keyboard, and every edit goes in the person's own origin", () => {
    expect(screen).toContain('<KeyboardAvoidingView behavior="padding" automaticOffset');
    expect(src("features/live-files/spreadsheet/edit.ts")).toContain("setInput(doc, at, text, locale, LOCAL");
    expect(screen).not.toMatch(/, (REMOTE|SYSTEM)\)/);
  });

  test("a load failure and a file that can't open have their own states, never a spinner alone", () => {
    expect(screen).toContain("<LiveUnavailable reason={closed} />");
    expect(screen).toContain("<GridBones />");
  });
});
