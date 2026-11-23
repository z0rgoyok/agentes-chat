import { describe, expect, test } from "bun:test";
import { initLiveDoc, LOCAL } from "@agenteschat/live";
import {
  formatRange,
  type SheetData,
  SheetEngine,
  setFrozen,
  setValues,
  sheetIds,
  sheetLocale,
} from "@agenteschat/live/spreadsheet";
import * as Y from "yjs";
import {
  alignOf,
  drawGrid,
  fillOf,
  type GridTheme,
  luminance,
  mix,
  panesOf,
  parseColor,
  textColorOf,
  withAlpha,
  wrapLines,
} from "@/components/live/spreadsheet/draw";
import {
  canPoint,
  fnKey,
  fold,
  matchFunctions,
  placeFunction,
  placeRef,
  signatureParts,
} from "@/components/live/spreadsheet/formula-ui";
import {
  Axis,
  anchorOf,
  cellAtPoint,
  collapsed,
  cycleWithin,
  fillTarget,
  jumpFrom,
  MergeIndex,
  rangeA1,
  rangeBox,
  screenX,
  scrollToShow,
  selectionLabel,
  selectionRange,
  statsOf,
  stepFrom,
  type Viewport,
  visibleSpan,
} from "@/components/live/spreadsheet/model";
import { cursorPoint } from "@/components/live/spreadsheet/presence";
import { DocSource, WorkbookSource } from "@/components/live/spreadsheet/source";

/**
 * The spreadsheet editor's pure parts (ADR 0196): positions on screen, the selection and the keys that move it, the
 * formula bar's help, the canvas drawing of the visible window, and the sources the grid draws from (a live document
 * and an uploaded workbook, ADR 0198).
 */

const PT = sheetLocale("pt-BR");
const EN = sheetLocale("en-US");

const view = (over: Partial<Viewport> = {}): Viewport => ({
  width: 600,
  height: 300,
  scrollX: 0,
  scrollY: 0,
  frozenRows: 0,
  frozenCols: 0,
  ...over,
});

describe("positions", () => {
  test("an axis finds the item at a position and the edge near it", () => {
    const axis = new Axis([100, 50, 100]);
    expect(axis.total).toBe(250);
    expect([axis.indexAt(0), axis.indexAt(99), axis.indexAt(100), axis.indexAt(149), axis.indexAt(9999)]).toEqual([
      0, 0, 1, 1, 2,
    ]);
    expect(axis.edgeNear(101, 4)).toBe(0);
    expect(axis.edgeNear(148, 4)).toBe(1);
    expect(axis.edgeNear(120, 4)).toBe(-1);
  });

  test("frozen columns stay put while the rest scroll; a point finds its cell", () => {
    const cols = new Axis([100, 100, 100, 100]);
    const rows = new Axis(Array(10).fill(24));
    const v = view({ scrollX: 150, frozenCols: 1 });
    expect(screenX(cols, 0, v)).toBe(48);
    expect(screenX(cols, 2, v)).toBe(48 + 200 - 150);
    // Over the frozen column: column A whatever the scroll.
    expect(cellAtPoint(60, 30, rows, cols, v)).toEqual({ r: 0, c: 0 });
    // Past it: the scrolled columns.
    expect(cellAtPoint(48 + 100 + 10, 30, rows, cols, v)).toEqual({ r: 0, c: 2 });
    // Headers answer -1 on their axis.
    expect(cellAtPoint(10, 10, rows, cols, v)).toEqual({ r: -1, c: -1 });
  });

  test("bringing a range into view scrolls only as far as needed", () => {
    const cols = new Axis(Array(30).fill(100));
    const rows = new Axis(Array(200).fill(24));
    const v = view();
    expect(scrollToShow({ r1: 2, c1: 1, r2: 2, c2: 1 }, rows, cols, v)).toEqual({ x: 0, y: 0 });
    const far = scrollToShow({ r1: 100, c1: 10, r2: 100, c2: 10 }, rows, cols, v);
    expect(far.y).toBe(101 * 24 - (300 - 24));
    expect(far.x).toBe(11 * 100 - (600 - 48));
    expect(visibleSpan(rows, 0, far.y, 300 - 24)).toEqual([rows.indexAt(far.y), rows.indexAt(far.y + 275)]);
  });

  test("a range's box spans the frozen line when it crosses it", () => {
    const cols = new Axis(Array(10).fill(100));
    const rows = new Axis(Array(10).fill(24));
    const box = rangeBox({ r1: 0, c1: 0, r2: 0, c2: 3 }, rows, cols, view({ frozenCols: 2, scrollX: 100 }));
    expect(box).toEqual({ x: 48, y: 24, w: 300, h: 24 });
  });
});

describe("the selection", () => {
  const size = { rows: 20, cols: 10 };
  const merges = new MergeIndex([{ r1: 1, c1: 1, r2: 2, c2: 3 }]);

  test("part of a merge selects all of it; whole rows, columns and the sheet", () => {
    expect(
      selectionRange({ active: { r: 0, c: 2 }, anchor: { r: 0, c: 2 }, corner: { r: 1, c: 2 } }, size, merges),
    ).toEqual({
      r1: 0,
      c1: 1,
      r2: 2,
      c2: 3,
    });
    expect(selectionRange({ ...collapsed({ r: 4, c: 0 }), corner: { r: 5, c: 0 }, whole: "rows" }, size)).toEqual({
      r1: 4,
      c1: 0,
      r2: 5,
      c2: 9,
    });
    expect(selectionRange({ ...collapsed({ r: 0, c: 2 }), whole: "cols" }, size)).toEqual({
      r1: 0,
      c1: 2,
      r2: 19,
      c2: 2,
    });
    expect(selectionRange({ ...collapsed({ r: 3, c: 3 }), whole: "all" }, size)).toEqual({
      r1: 0,
      c1: 0,
      r2: 19,
      c2: 9,
    });
  });

  test("arrows step across a merge as one cell and stop at the sheet's edges", () => {
    expect(stepFrom({ r: 1, c: 1 }, 0, 1, size, merges)).toEqual({ r: 1, c: 4 });
    expect(stepFrom({ r: 2, c: 2 }, 1, 0, size, merges)).toEqual({ r: 3, c: 2 });
    expect(anchorOf({ r: 2, c: 3 }, merges)).toEqual({ r: 1, c: 1 });
    expect(stepFrom({ r: 0, c: 0 }, -1, -1, size, merges)).toEqual({ r: 0, c: 0 });
  });

  test("⌘ with an arrow jumps as in Excel: to the block's end, the next filled cell, or the edge", () => {
    const filled = new Set(["0:0", "1:0", "2:0", "6:0"]);
    const has = (r: number, c: number) => filled.has(`${r}:${c}`);
    expect(jumpFrom({ r: 0, c: 0 }, 1, 0, size, has)).toEqual({ r: 2, c: 0 });
    expect(jumpFrom({ r: 2, c: 0 }, 1, 0, size, has)).toEqual({ r: 6, c: 0 });
    expect(jumpFrom({ r: 6, c: 0 }, 1, 0, size, has)).toEqual({ r: 19, c: 0 });
    expect(jumpFrom({ r: 0, c: 0 }, 0, 1, size, has)).toEqual({ r: 0, c: 9 });
  });

  test("Enter and Tab walk inside a selection of several cells, wrapping", () => {
    const range = { r1: 0, c1: 0, r2: 1, c2: 1 };
    expect(cycleWithin(range, { r: 0, c: 0 }, "row", false)).toEqual({ r: 1, c: 0 });
    expect(cycleWithin(range, { r: 1, c: 0 }, "row", false)).toEqual({ r: 0, c: 1 });
    expect(cycleWithin(range, { r: 1, c: 1 }, "row", false)).toEqual({ r: 0, c: 0 });
    expect(cycleWithin(range, { r: 0, c: 0 }, "col", false)).toEqual({ r: 0, c: 1 });
    expect(cycleWithin(range, { r: 0, c: 0 }, "col", true)).toEqual({ r: 1, c: 1 });
  });

  test("the fill handle reaches along the axis the pointer went farther on", () => {
    const range = { r1: 0, c1: 0, r2: 1, c2: 0 };
    expect(fillTarget(range, { r: 5, c: 1 })).toEqual({ r1: 0, c1: 0, r2: 5, c2: 0 });
    expect(fillTarget(range, { r: 1, c: 4 })).toEqual({ r1: 0, c1: 0, r2: 1, c2: 4 });
    expect(fillTarget(range, { r: 1, c: 0 })).toBeNull();
  });

  test("its words: the name box and Ask an agent", () => {
    expect(rangeA1({ r1: 1, c1: 1, r2: 8, c2: 4 })).toBe("B2:E9");
    expect(rangeA1({ r1: 3, c1: 2, r2: 3, c2: 2 })).toBe("C4");
    expect(selectionLabel("Planilha 1", { r1: 1, c1: 1, r2: 8, c2: 4 })).toBe("Planilha 1!B2:E9");
  });

  test("the status line sums numbers and counts what isn't empty", () => {
    const stats = statsOf([
      { value: 10, nf: "#,##0.00" },
      { value: "texto" },
      { value: 2.5 },
      { value: null },
      { value: { error: "#DIV/0!" } },
    ]);
    expect(stats).toEqual({ count: 4, numbers: 2, sum: 12.5, nf: "#,##0.00" });
  });
});

describe("formula help", () => {
  const options = [
    { name: "SOMA", canonical: "SUM" },
    { name: "SOMASE", canonical: "SUMIF" },
    { name: "MÉDIA", canonical: "AVERAGE" },
    { name: "SE", canonical: "IF" },
  ];

  test("functions found by their name in the reader's language, accents or not, or in English", () => {
    expect(fold("média")).toBe("MEDIA");
    expect(matchFunctions("som", options).map((o) => o.name)).toEqual(["SOMA", "SOMASE"]);
    expect(matchFunctions("medi", options).map((o) => o.name)).toEqual(["MÉDIA"]);
    expect(matchFunctions("aver", options).map((o) => o.canonical)).toEqual(["AVERAGE"]);
    expect(matchFunctions("", options)).toEqual([]);
  });

  test("the signature marks the argument the cursor is on, the repeating tail too", () => {
    const help = { name: "SOMA", args: ["live.sheet.args.number1", "live.sheet.args.number2"], min: 1, repeat: 1 };
    const label = (key: string) => (key.endsWith("number1") ? "núm1" : "núm2");
    const parts = signatureParts(help, 4, PT, label);
    expect(parts.map((p) => p.text).join("")).toBe("SOMA(núm1; [núm2]; …)");
    expect(parts.find((p) => p.current)?.text).toBe("[núm2]");
    expect(signatureParts(help, 0, EN, label).find((p) => p.current)?.text).toBe("núm1");
  });

  test("a reference goes where a value is expected: after =, (, an operator or the separator", () => {
    expect(canPoint("=SOMA(", 6, PT)).toBe(true);
    expect(canPoint("=SOMA(B2;", 9, PT)).toBe(true);
    // In Portuguese the comma is the decimal mark, not a separator.
    expect(canPoint("=1,", 3, PT)).toBe(false);
    expect(canPoint("=SUM(B2,", 8, EN)).toBe(true);
    expect(canPoint("=B2", 3, PT)).toBe(false);
    expect(canPoint("texto", 5, PT)).toBe(false);
  });

  test("a pointed reference goes in at the cursor, then replaces itself as the pointer moves", () => {
    const first = placeRef("=SOMA(", 6, "B2");
    expect(first).toEqual({ text: "=SOMA(B2", caret: 8, span: { start: 6, end: 8 } });
    expect(placeRef(first.text, first.caret, "B2:C5", first.span).text).toBe("=SOMA(B2:C5");
  });

  test("a picked function replaces the name typed and opens its parenthesis", () => {
    expect(placeFunction("=so", { start: 1, end: 3 }, "SOMA")).toEqual({ text: "=SOMA(", caret: 6 });
    expect(placeFunction("=so(B2)", { start: 1, end: 3 }, "SOMA")).toEqual({ text: "=SOMA(B2)", caret: 6 });
  });

  test("a function's description key never nests on the dots of its name", () => {
    expect(fnKey("STDEV.S")).toBe("live.sheet.fn.STDEV_S");
    expect(fnKey("SUM")).toBe("live.sheet.fn.SUM");
  });
});

describe("colors", () => {
  test("hex and rgb read; luminance, mixes and alphas", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255, 1]);
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30, 0.5]);
    expect(parseColor("nope")).toBeNull();
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(mix("#000000", "#ffffff", 0.5)).toBe("rgb(128, 128, 128)");
    expect(withAlpha("#102030", 0.25)).toBe("rgba(16, 32, 48, 0.25)");
  });

  test("text stays readable: black on the dark theme, ink on a dark fill turns light", () => {
    const dark = theme(true);
    expect(textColorOf({ text: "x", kind: "text", style: { fc: "#000000" } }, dark)).toBe(dark.ink);
    expect(textColorOf({ text: "x", kind: "text", style: { bg: "#202020" } }, theme(false))).toBe("#f4f4f1");
    expect(textColorOf({ text: "#DIV/0!", kind: "error" }, dark)).toBe(dark.danger);
    expect(fillOf("#ff0000", theme(false))).toBe("#ff0000");
    expect(fillOf("#ff0000", dark)).not.toBe("#ff0000");
  });

  test("numbers right, text left, booleans and errors centered, unless the cell says", () => {
    expect(alignOf({ text: "1", kind: "number" })).toBe("r");
    expect(alignOf({ text: "a", kind: "text" })).toBe("l");
    expect(alignOf({ text: "VERDADEIRO", kind: "bool" })).toBe("c");
    expect(alignOf({ text: "1", kind: "number", style: { ha: "l" } })).toBe("l");
  });
});

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function theme(dark: boolean): GridTheme {
  return {
    dark,
    cell: dark ? "#1c1c1b" : "#ffffff",
    header: dark ? "#0a0a09" : "#f3f3f0",
    line: "rgba(23, 23, 22, 0.12)",
    lineStrong: "#82827d",
    ink: dark ? "#efefec" : "#151514",
    muted: "#5c5c58",
    danger: dark ? "#f08a80" : "#b42a20",
    selFill: "rgba(21, 21, 20, 0.06)",
    headerSel: "rgba(21, 21, 20, 0.08)",
    font: "Test Sans",
  };
}

/** A 2D context that remembers what was drawn, with every character 7 px wide. */
function recorder() {
  const calls: { op: string; args: unknown[]; fill: string }[] = [];
  const ctx: Record<string, unknown> = { fillStyle: "", strokeStyle: "", font: "", lineWidth: 1 };
  for (const op of ["fillRect", "strokeRect", "fillText", "save", "restore", "beginPath", "rect", "clip"]) {
    ctx[op] = (...args: unknown[]) => calls.push({ op, args, fill: String(ctx.fillStyle) });
  }
  ctx.setTransform = () => {};
  ctx.setLineDash = () => {};
  ctx.measureText = (text: string) => ({
    width: text.length * 7,
    actualBoundingBoxAscent: 10,
    actualBoundingBoxDescent: 3,
  });
  const texts = () =>
    calls.filter((c) => c.op === "fillText").map((c) => ({ text: c.args[0], x: c.args[1], fill: c.fill }));
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, texts };
}

function sheetDoc(rows: (string | number | boolean | null)[][], at = { row: 0, col: 0 }) {
  const doc = new Y.Doc();
  initLiveDoc(doc, "spreadsheet", { sheetName: "Planilha 1" });
  const sheet = sheetIds(doc)[0] as string;
  setValues(doc, { sheet, ...at }, rows, EN, LOCAL);
  const engine = new SheetEngine(doc);
  engine.setLocale(PT);
  return { doc, sheet, engine, source: () => new DocSource(doc, engine, sheet, PT) };
}

describe("drawing the visible window", () => {
  test("text runs into empty neighbors, a number too wide shows hashes, an error is red", () => {
    const { doc, sheet, source } = sheetDoc([
      ["Uma frase longa que passa da célula", null, null],
      [null, 1234567890, null],
      [null, null, "=1/0"],
    ]);
    formatRange(doc, { sheet, r1: 1, c1: 1, r2: 1, c2: 1 }, { nf: "#,##0.00" }, LOCAL);
    const { ctx, texts } = recorder();
    drawGrid(ctx, {
      source: source(),
      view: view(),
      dpr: 2,
      theme: theme(false),
      selection: null,
      fillHandle: false,
      fillTo: null,
      marks: [],
      editing: null,
    });
    const drawn = texts();
    expect(drawn.some((d) => d.text === "Uma frase longa que passa da célula")).toBe(true);
    // "1.234.567.890,00" is 112 px, wider than the 88 px a cell leaves: hashes, as in Excel.
    expect(drawn.some((d) => typeof d.text === "string" && /^#+$/.test(d.text))).toBe(true);
    expect(drawn.find((d) => d.text === "#DIV/0!")?.fill).toBe(theme(false).danger);
    // Headers: letters and numbers.
    expect(drawn.some((d) => d.text === "A")).toBe(true);
    expect(drawn.some((d) => d.text === "3")).toBe(true);
  });

  test("only what is on screen is read: a value far below isn't drawn until scrolled to", () => {
    const { source } = sheetDoc([["longe"]], { row: 90, col: 0 });
    const near = recorder();
    const frame = {
      dpr: 1,
      theme: theme(false),
      selection: null,
      fillHandle: false,
      fillTo: null,
      marks: [],
      editing: null,
    };
    drawGrid(near.ctx, { ...frame, source: source(), view: view() });
    expect(near.texts().some((d) => d.text === "longe")).toBe(false);
    const far = recorder();
    drawGrid(far.ctx, { ...frame, source: source(), view: view({ scrollY: 85 * 24 }) });
    expect(far.texts().some((d) => d.text === "longe")).toBe(true);
  });

  test("the cell being typed in leaves its text to the editor", () => {
    const { source } = sheetDoc([["oculto"]]);
    const { ctx, texts } = recorder();
    drawGrid(ctx, {
      source: source(),
      view: view(),
      dpr: 1,
      theme: theme(false),
      selection: { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, active: { r: 0, c: 0 } },
      fillHandle: true,
      fillTo: null,
      marks: [],
      editing: { r: 0, c: 0 },
    });
    expect(texts().some((d) => d.text === "oculto")).toBe(false);
  });

  test("frozen panes: four panes, and a 2 px line at the frozen edge", () => {
    const { doc, sheet, source } = sheetDoc([["a"]]);
    setFrozen(doc, sheet, 1, 1, LOCAL);
    const s = source();
    expect(panesOf(s.rows, s.cols, view({ frozenRows: 1, frozenCols: 1 }))).toHaveLength(4);
    const { ctx, calls } = recorder();
    drawGrid(ctx, {
      source: s,
      view: view({ frozenRows: 1, frozenCols: 1 }),
      dpr: 1,
      theme: theme(false),
      selection: null,
      fillHandle: false,
      fillTo: null,
      marks: [],
      editing: null,
    });
    const strong = calls.filter((c) => c.op === "fillRect" && c.fill === theme(false).lineStrong);
    expect(strong.some((c) => c.args[1] === 24 + 24 - 1 && c.args[3] === 2)).toBe(true);
    expect(strong.some((c) => c.args[0] === 48 + 100 - 1 && c.args[2] === 2)).toBe(true);
  });

  test("wrapped text breaks between words to fit", () => {
    const { ctx } = recorder();
    expect(wrapLines(ctx, "13px Test", "uma duas três", 7 * 8)).toEqual(["uma duas", "três"]);
    expect(wrapLines(ctx, "13px Test", "linha\noutra", 1000)).toEqual(["linha", "outra"]);
  });
});

describe("where the grid's cells come from", () => {
  test("a live sheet: shown in the reader's language and format, typed as they read it", () => {
    const { doc, sheet, source } = sheetDoc([[1234.5, "=A1*2", true]]);
    formatRange(doc, { sheet, r1: 0, c1: 0, r2: 0, c2: 0 }, { nf: "#,##0.00" }, LOCAL);
    const s = source();
    expect(s.cell(0, 0)).toMatchObject({ text: "1.234,50", kind: "number" });
    expect(s.cell(0, 1)).toMatchObject({ text: "2469", kind: "number" });
    expect(s.cell(0, 2)).toMatchObject({ text: "VERDADEIRO", kind: "bool" });
    expect(s.input(0, 1)).toBe("=A1*2");
    expect(s.filled(0, 0)).toBe(true);
    expect(s.filled(5, 5)).toBe(false);
    expect(s.used()).toEqual({ r: 0, c: 2 });
    expect([...s.values({ r1: 0, c1: 0, r2: 0, c2: 2 })].map((v) => v.value)).toEqual([1234.5, 2469, true]);
  });

  test("an uploaded workbook: the file's values in the reader's formats, its errors in their words", () => {
    const data: SheetData = {
      name: "Vendas",
      rows: 3,
      cols: 3,
      cells: [
        { r: 0, c: 0, v: 0.5, s: { nf: "0%" } },
        { r: 0, c: 1, v: 1234.5, s: { nf: "#,##0.00" } },
        { r: 1, c: 0, e: "#N/A" },
        { r: 1, c: 1, f: "SUM(A1:B1)", v: 1235 },
        { r: 2, c: 2, f: "NOW()", t: "agora" },
      ],
      merges: [{ r1: 2, c1: 0, r2: 2, c2: 1 }],
      frozen: { rows: 1, cols: 0 },
      colWidths: { 0: 140 },
    };
    const s = new WorkbookSource(data, "0", PT);
    expect(s.cell(0, 0)?.text).toBe("50%");
    expect(s.cell(0, 1)?.text).toBe("1.234,50");
    expect(s.cell(1, 0)).toMatchObject({ text: "#N/D", kind: "error" });
    expect(s.input(1, 1)).toBe("=SUM(A1:B1)");
    expect(s.cell(2, 2)?.text).toBe("agora");
    expect(s.cols.size(0)).toBe(140);
    expect(s.frozen).toEqual({ rows: 1, cols: 0 });
    expect(s.merges.at(2, 1)).toEqual({ r1: 2, c1: 0, r2: 2, c2: 1 });
    expect(s.used()).toEqual({ r: 2, c: 2 });
  });

  test("an agent's arrow points just inside its range's last cell", () => {
    const rows = new Axis([24, 24, 24]);
    const cols = new Axis([100, 100, 100]);
    expect(cursorPoint({ r1: 0, c1: 0, r2: 1, c2: 1 }, rows, cols)).toEqual({ x: 188, y: 40 });
  });
});
