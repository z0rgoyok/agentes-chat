import { describe, expect, test } from "bun:test";
import {
  adjustForDeletion,
  FUNCTION_NAMES,
  functionHelp,
  functionNames,
  inspectFormula,
  parseCanonical,
  printCanonical,
  referencedRanges,
  shiftFormula,
  toCanonical,
  toDisplay,
} from "../src/spreadsheet/formula";
import { FUNCTIONS } from "../src/spreadsheet/formula/functions";
import { canonicalFromPt, PT_ALTERNATES, PT_NAMES, ptNameOf } from "../src/spreadsheet/formula/names-pt";
import { book, colsOf, EN, PT, put, rowsOf, stored } from "./formula-helpers";

const ctx = (b: ReturnType<typeof book>, sheet?: string, locale = EN) => ({
  doc: b.doc,
  sheetId: sheet === undefined ? b.first : (b.ids[sheet] as string),
  locale,
});

function canon(b: ReturnType<typeof book>, input: string, locale = EN, sheet?: string): string {
  const r = toCanonical(input, ctx(b, sheet, locale));
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.f;
}

describe("canonical form", () => {
  test.each([
    "SUM({r1,c2}:{r9,c2},{r1,c3})",
    "1+2*3",
    "(1+2)*3",
    "-{r0,c0}^2",
    '"a""b"&"c"',
    "{ 1,2;3,4 }",
    'IF({r0,c0},,"x")',
    "#N/A",
    "SUM({,c1}:{,c1})",
    "SUM({r3,}:{r3,})",
    "{s1!r1,c1}+{$r2,$c3}",
    "{s1!$r1,c1}:{s1!r9,$c1}",
    "TRUE<>FALSE",
    "1E+21*2.5E-7",
    "A1",
    "10%",
  ])("%s prints back the same", (f) => {
    expect(printCanonical(parseCanonical(f))).toBe(f);
  });

  test("operators follow Excel's precedence", () => {
    expect(parseCanonical("1+2*3")).toEqual({
      t: "bin",
      op: "+",
      a: { t: "num", v: 1 },
      b: { t: "bin", op: "*", a: { t: "num", v: 2 }, b: { t: "num", v: 3 } },
    });
    // Negation binds tighter than ^, which runs left to right.
    expect(parseCanonical("-2^2")).toEqual({
      t: "bin",
      op: "^",
      a: { t: "un", op: "-", a: { t: "num", v: 2 } },
      b: { t: "num", v: 2 },
    });
    expect(printCanonical(parseCanonical("2^3^2"))).toBe("2^3^2");
    expect(parseCanonical("1&2=3")).toMatchObject({ t: "bin", op: "=" });
  });

  test("trees built by code get the parentheses precedence needs", () => {
    expect(
      printCanonical({
        t: "bin",
        op: "*",
        a: { t: "bin", op: "+", a: { t: "num", v: 1 }, b: { t: "num", v: 2 } },
        b: { t: "num", v: 3 },
      }),
    ).toBe("(1+2)*3");
    expect(printCanonical({ t: "bin", op: "-", a: { t: "num", v: 1 }, b: { t: "num", v: -2 } })).toBe("1--2");
  });

  test("malformed stored formulas throw a FormulaError", () => {
    expect(() => parseCanonical("SUM(")).toThrow();
    expect(() => parseCanonical("1+")).toThrow();
    expect(() => parseCanonical("{r1,c1")).toThrow();
  });
});

describe("typing and reading A1", () => {
  const b = book(["Sheet1", "Sheet 2", "It's"]);

  test("English and Portuguese read to the same canonical form and back", () => {
    const f = canon(b, "=SUM(B2:B9,C1)");
    expect(f).toBe("SUM({r1,c1}:{r8,c1},{r0,c2})");
    expect(canon(b, "=SOMA(B2:B9;C1)", PT)).toBe(f);
    expect(toDisplay(f, ctx(b, undefined, PT))).toBe("=SOMA(B2:B9;C1)");
    expect(toDisplay(f, ctx(b))).toBe("=SUM(B2:B9,C1)");
  });

  test("Portuguese decimals, booleans, errors and English names", () => {
    expect(canon(b, "=1,5+2", PT)).toBe("1.5+2");
    expect(toDisplay("1.5+2", ctx(b, undefined, PT))).toBe("=1,5+2");
    expect(canon(b, "=SE(VERDADEIRO;1;FALSO)", PT)).toBe("IF(TRUE,1,FALSE)");
    expect(toDisplay("IF(TRUE,1,FALSE)", ctx(b, undefined, PT))).toBe("=SE(VERDADEIRO;1;FALSO)");
    expect(canon(b, "=SUM(1;2)", PT)).toBe("SUM(1,2)");
    expect(canon(b, "=média(1;2)", PT)).toBe("AVERAGE(1,2)");
    expect(canon(b, "=MEDIA(1;2)", PT)).toBe("AVERAGE(1,2)");
    expect(canon(b, "=MÁX(1;2)", PT)).toBe("MAX(1,2)");
    expect(canon(b, '=CONT.SE(A1:A9;">5")', PT)).toBe('COUNTIF({r0,c0}:{r8,c0},">5")');
    expect(canon(b, "=#N/D", PT)).toBe("#N/A");
    expect(toDisplay("#N/A", ctx(b, undefined, PT))).toBe("=#N/D");
    expect(toDisplay("#VALUE!+#NAME?", ctx(b, undefined, PT))).toBe("=#VALOR!+#NOME?");
    expect(canon(b, '=CONCATENAR("a;b";"c,d")', PT)).toBe('CONCATENATE("a;b","c,d")');
    expect(canon(b, "=PROCV(A1;A1:B9;2;FALSO)", PT)).toBe("VLOOKUP({r0,c0},{r0,c0}:{r8,c1},2,FALSE)");
  });

  test("English doesn't read Portuguese names (they stay unknown)", () => {
    expect(canon(b, "=SOMA(1,2)")).toBe("SOMA(1,2)");
    expect(canon(b, "=sum(1,2)")).toBe("SUM(1,2)");
  });

  test("array constants in both languages", () => {
    expect(canon(b, "={1,2;3,4}")).toBe("{ 1,2;3,4 }");
    expect(canon(b, "={1\\2;3\\4}", PT)).toBe("{ 1,2;3,4 }");
    expect(toDisplay("{ 1,2;3,4 }", ctx(b, undefined, PT))).toBe("={1\\2;3\\4}");
    expect(canon(b, '={1,-2.5,"a",TRUE}')).toBe('{ 1,-2.5,"a",TRUE }');
  });

  test("sheet names, quoted or not, and absolute parts", () => {
    expect(canon(b, "='Sheet 2'!A1+1")).toBe("{s1!s1r0,s1c0}+1");
    expect(toDisplay("{s1!s1r0,s1c0}+1", ctx(b))).toBe("='Sheet 2'!A1+1");
    expect(canon(b, "='It''s'!B2")).toBe("{s2!s2r1,s2c1}");
    expect(toDisplay("{s2!s2r1,s2c1}", ctx(b))).toBe("='It''s'!B2");
    expect(canon(b, "=sheet1!A1")).toBe("{s0!r0,c0}");
    expect(toDisplay("{s0!r0,c0}", ctx(b))).toBe("=Sheet1!A1");
    expect(canon(b, "=$A$1+A$2+$B3")).toBe("{$r0,$c0}+{$r1,c0}+{r2,$c1}");
    expect(toDisplay("{$r0,$c0}+{$r1,c0}+{r2,$c1}", ctx(b))).toBe("=$A$1+A$2+$B3");
    expect(canon(b, "=SUM('Sheet 2'!A1:B3)")).toBe("SUM({s1!s1r0,s1c0}:{s1!s1r2,s1c1})");
    expect(toDisplay("SUM({s1!s1r0,s1c0}:{s1!s1r2,s1c1})", ctx(b))).toBe("=SUM('Sheet 2'!A1:B3)");
  });

  test("whole columns and rows, and corners typed in any order", () => {
    expect(canon(b, "=SUM(A:B)")).toBe("SUM({,c0}:{,c1})");
    expect(toDisplay("SUM({,c0}:{,c1})", ctx(b))).toBe("=SUM(A:B)");
    expect(canon(b, "=SUM(2:3)")).toBe("SUM({r1,}:{r2,})");
    expect(toDisplay("SUM({r1,}:{r2,})", ctx(b))).toBe("=SUM(2:3)");
    expect(canon(b, "=SUM(B5:A1)")).toBe("SUM({r0,c0}:{r4,c1})");
    expect(canon(b, "=SUM($B5:A$1)")).toBe("SUM({$r0,c0}:{r4,$c1})");
    expect(toDisplay("SUM({$r0,c0}:{r4,$c1})", ctx(b))).toBe("=SUM(A$1:$B5)");
  });

  test("problems name the place", () => {
    const problem = (input: string, locale = EN) => {
      const r = toCanonical(input, ctx(b, undefined, locale));
      return r.ok ? null : r.error;
    };
    expect(problem("=")).toEqual({ code: "empty", at: 1 });
    expect(problem("=SUM(1,2")).toMatchObject({ code: "unclosed_paren", at: 4 });
    expect(problem("=1+")).toMatchObject({ code: "missing_operand" });
    expect(problem('="abc')).toMatchObject({ code: "unclosed_string", at: 1 });
    expect(problem("=Nope!A1")).toMatchObject({ code: "bad_sheet", text: "Nope" });
    expect(problem("=ROUND(1)")).toMatchObject({ code: "args", fn: "ROUND", min: 2, max: 2 });
    expect(problem("=ARRED(1)", PT)).toMatchObject({ code: "args", fn: "ARRED" });
    expect(problem("=1+)")).toMatchObject({ code: "unexpected" });
    expect(problem("=A20001")).toMatchObject({ code: "too_far", at: 1 });
    expect(problem("=ZZ1")).toMatchObject({ code: "too_far" });
    expect(problem("={1,2;3}")).toMatchObject({ code: "bad_array" });
    expect(problem(`=${"1+".repeat(5000)}1`)).toMatchObject({ code: "too_long" });
    expect(problem(`=${"(".repeat(120)}1${")".repeat(120)}`)).toMatchObject({ code: "too_deep" });
    expect(problem("=A1:'Sheet 2'!B2")).toMatchObject({ code: "bad_range" });
  });

  test("references past the grid say how far it must grow", () => {
    const r = toCanonical("=A50+M2+'Sheet 2'!B45", ctx(b));
    expect(r).toMatchObject({ ok: true, needs: { rows: 50, cols: 13 }, needsSheets: { s1: { rows: 45, cols: 12 } } });
  });

  test("leading spaces before the equals sign", () => {
    expect(canon(b, "  =1+1")).toBe("1+1");
  });
});

describe("references follow their rows and columns", () => {
  test("inserting rows and columns moves and grows ranges; deleting gives #REF!", () => {
    const b = book(["Sheet1"], { rows: 20, cols: 6 });
    put(b, "F1", "=SUM(A1:A5)+B3+$E$2");
    const f = stored(b, "F1") as string;
    const show = () => toDisplay(f, ctx(b));
    expect(show()).toBe("=SUM(A1:A5)+B3+$E$2");
    rowsOf(b).insert(2, ["n1", "n2"]);
    expect(show()).toBe("=SUM(A1:A7)+B5+$E$2");
    rowsOf(b).insert(0, ["n3"]);
    expect(show()).toBe("=SUM(A2:A8)+B6+$E$3");
    colsOf(b).insert(0, ["k1"]);
    expect(show()).toBe("=SUM(B2:B8)+C6+$F$3");
    // Deleting a row inside the range shrinks it; deleting the row of a single reference breaks that reference.
    rowsOf(b).delete(3, 1);
    expect(show()).toBe("=SUM(B2:B7)+C5+$F$3");
    rowsOf(b).delete(4, 1);
    expect(show()).toBe("=SUM(B2:B6)+#REF!+$F$3");
  });

  test("a range's deleted edge is pulled in when adjusted first, as in Excel", () => {
    const b = book(["Sheet1"], { rows: 12, cols: 4 });
    put(b, "C1", "=SUM(A2:A9)");
    const f = stored(b, "C1") as string;
    const gone = new Set([rowsOf(b).get(8), rowsOf(b).get(1)]);
    const adjusted = adjustForDeletion(f, { doc: b.doc, sheetId: b.first }, { sheet: b.first, rows: gone });
    expect(toDisplay(adjusted, ctx(b))).toBe("=SUM(A3:A8)");
    rowsOf(b).delete(8, 1);
    rowsOf(b).delete(1, 1);
    expect(toDisplay(adjusted, ctx(b))).toBe("=SUM(A2:A7)");
    expect(toDisplay(f, ctx(b))).toBe("=SUM(#REF!)");
    // Nothing to do for a formula the deletion doesn't touch.
    expect(adjustForDeletion("1+1", { doc: b.doc, sheetId: b.first }, { sheet: b.first, rows: gone })).toBe("1+1");
  });

  test("columns pulled in too", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 8 });
    put(b, "H1", "=SUM(A1:C1)");
    const f = stored(b, "H1") as string;
    const out = adjustForDeletion(
      f,
      { doc: b.doc, sheetId: b.first },
      { sheet: b.first, cols: new Set([colsOf(b).get(0)]) },
    );
    colsOf(b).delete(0, 1);
    expect(toDisplay(out, ctx(b))).toBe("=SUM(A1:B1)");
  });
});

describe("copy and fill", () => {
  const b = book(["Sheet1", "Sheet 2"], { rows: 10, cols: 6 });

  test("relative parts move, absolute parts stay", () => {
    const f = canon(b, "=A1+$B$1+B$2+$C3+SUM(A1:B2)");
    const moved = shiftFormula(f, 1, 1, { doc: b.doc, sheetId: b.first });
    expect(toDisplay(moved, ctx(b))).toBe("=B2+$B$1+C$2+$C4+SUM(B2:C3)");
    expect(shiftFormula(f, 0, 0, { doc: b.doc, sheetId: b.first })).toBe(f);
  });

  test("moving off the grid is #REF!", () => {
    const f = canon(b, "=A1+B2");
    expect(toDisplay(shiftFormula(f, -1, 0, { doc: b.doc, sheetId: b.first }), ctx(b))).toBe("=#REF!+B1");
    expect(toDisplay(shiftFormula(f, 9, 0, { doc: b.doc, sheetId: b.first }), ctx(b))).toBe("=A10+#REF!");
    expect(toDisplay(shiftFormula(canon(b, "=SUM(A1:A3)"), 8, 0, { doc: b.doc, sheetId: b.first }), ctx(b))).toBe(
      "=SUM(#REF!)",
    );
  });

  test("whole columns move sideways only, whole rows down only", () => {
    const f = canon(b, "=SUM(A:A)+SUM(2:2)");
    expect(toDisplay(shiftFormula(f, 3, 1, { doc: b.doc, sheetId: b.first }), ctx(b))).toBe("=SUM(B:B)+SUM(5:5)");
  });

  test("pasting on another sheet lands on that sheet's own cells", () => {
    const f = canon(b, "=A1+$B$2+'Sheet 2'!C3");
    const out = shiftFormula(f, 1, 0, { doc: b.doc, sheetId: b.first, toSheet: b.ids["Sheet 2"] as string });
    expect(toDisplay(out, ctx(b, "Sheet 2"))).toBe("=A2+$B$2+'Sheet 2'!C4");
  });

  test("references in order, for coloring", () => {
    const f = canon(b, "=SUM(A1:B2)+C3*'Sheet 2'!A1");
    expect(referencedRanges(f)).toEqual([
      [
        { row: "r0", col: "c0" },
        { row: "r1", col: "c1" },
      ],
      [{ row: "r2", col: "c2" }],
      [{ sheet: "s1", row: "s1r0", col: "s1c0" }],
    ]);
    expect(referencedRanges("SUM(")).toEqual([]);
  });
});

describe("function names", () => {
  test("about two hundred functions, every one with Excel's Brazilian name or its own", () => {
    expect(FUNCTION_NAMES.length).toBeGreaterThanOrEqual(200);
    for (const name of FUNCTION_NAMES) {
      const pt = ptNameOf(name);
      expect(canonicalFromPt(pt)).toBe(name);
    }
  });

  test("the Portuguese table matches Excel's names", () => {
    const pairs = `SUM SOMA, SUMIF SOMASE, SUMIFS SOMASES, SUMPRODUCT SOMARPRODUTO, PRODUCT MULT, AVERAGE MÉDIA,
      AVERAGEIF MÉDIASE, AVERAGEIFS MÉDIASES, AVERAGEA MÉDIAA, MIN MÍNIMO, MAX MÁXIMO, MINIFS MÍNIMOSES, MAXIFS MÁXIMOSES,
      COUNT CONT.NÚM, COUNTA CONT.VALORES, COUNTBLANK CONTAR.VAZIO, COUNTIF CONT.SE, COUNTIFS CONT.SES, ROUND ARRED,
      ROUNDUP ARREDONDAR.PARA.CIMA, ROUNDDOWN ARREDONDAR.PARA.BAIXO, INT INT, MOD MOD, ABS ABS, POWER POTÊNCIA,
      SQRT RAIZ, RAND ALEATÓRIO, RANDBETWEEN ALEATÓRIOENTRE, CEILING TETO, FLOOR ARREDMULTB, TRUNC TRUNCAR, SIGN SINAL,
      MEDIAN MED, MODE MODO, STDEV DESVPAD, STDEV.S DESVPAD.A, STDEV.P DESVPAD.P, VAR VAR, VAR.S VAR.A, VAR.P VAR.P,
      LARGE MAIOR, SMALL MENOR, RANK ORDEM, RANK.EQ ORDEM.EQ, PERCENTILE PERCENTIL, QUARTILE QUARTIL, IF SE, IFS SES,
      IFERROR SEERRO, IFNA SENÃODISP, AND E, OR OU, NOT NÃO, SWITCH PARÂMETRO, TRUE VERDADEIRO, FALSE FALSO,
      VLOOKUP PROCV, HLOOKUP PROCH, XLOOKUP PROCX, LOOKUP PROC, INDEX ÍNDICE, MATCH CORRESP, XMATCH CORRESPX,
      CHOOSE ESCOLHER, ROW LIN, COLUMN COL, ROWS LINS, COLUMNS COLS, OFFSET DESLOC, INDIRECT INDIRETO,
      TRANSPOSE TRANSPOR, CONCAT CONCAT, CONCATENATE CONCATENAR, TEXTJOIN UNIRTEXTO, LEFT ESQUERDA, RIGHT DIREITA,
      MID EXT.TEXTO, LEN NÚM.CARACT, UPPER MAIÚSCULA, LOWER MINÚSCULA, PROPER PRI.MAIÚSCULA, TRIM ARRUMAR, CLEAN TIRAR,
      SUBSTITUTE SUBSTITUIR, REPLACE MUDAR, FIND PROCURAR, SEARCH LOCALIZAR, TEXT TEXTO, VALUE VALOR, REPT REPT,
      EXACT EXATO, CHAR CARACT, CODE CÓDIGO, TODAY HOJE, NOW AGORA, DATE DATA, TIME TEMPO, YEAR ANO, MONTH MÊS, DAY DIA,
      HOUR HORA, MINUTE MINUTO, SECOND SEGUNDO, WEEKDAY DIA.DA.SEMANA, WEEKNUM NÚMSEMANA, ISOWEEKNUM NÚMSEMANAISO,
      EDATE DATAM, EOMONTH FIMMÊS, DATEDIF DATADIF, DAYS DIAS, NETWORKDAYS DIATRABALHOTOTAL, WORKDAY DIATRABALHO,
      DATEVALUE DATA.VALOR, TIMEVALUE VALOR.TEMPO, ISBLANK ÉCÉL.VAZIA, ISNUMBER ÉNÚM, ISTEXT ÉTEXTO, ISERROR ÉERROS,
      ISERR ÉERRO, ISNA É.NÃO.DISP, ISLOGICAL ÉLÓGICO, ISEVEN ÉPAR, ISODD ÉIMPAR, NA NÃO.DISP, PMT PGTO, FV VF, PV VP,
      NPV VPL, IRR TIR, RATE TAXA, NPER NPER, MROUND MARRED, GCD MDC, LCM MMC, FACT FATORIAL, COMBIN COMBIN,
      DEGREES GRAUS, RADIANS RADIANOS, SIN SEN, COS COS, TAN TAN, SUBTOTAL SUBTOTAL, CORREL CORREL, SLOPE INCLINAÇÃO,
      INTERCEPT INTERCEPÇÃO, FORECAST PREVISÃO, TEXTBEFORE TEXTOANTES, TEXTAFTER TEXTODEPOIS, UNIQUE ÚNICO,
      SORT CLASSIFICAR, FILTER FILTRAR, SEQUENCE SEQUÊNCIA`;
    for (const pair of pairs.split(",")) {
      const [en, pt] = pair.trim().split(/\s+/) as [string, string];
      expect(PT_NAMES[en]).toBe(pt);
      expect(FUNCTIONS[en]).toBeDefined();
      expect(canonicalFromPt(pt)).toBe(en);
    }
    // Excel's Brazilian XOR is OUEXCL; XOR itself is read as the English name.
    expect(ptNameOf("XOR")).toBe("OUEXCL");
  });

  test("other names people type in Portuguese", () => {
    for (const [pt, en] of Object.entries(PT_ALTERNATES)) {
      expect(canonicalFromPt(pt)).toBe(en);
      expect(FUNCTIONS[en]).toBeDefined();
    }
    expect(canonicalFromPt("MOEDA")).toBe("DOLLAR");
    expect(canonicalFromPt("diatrabalhototal")).toBe("NETWORKDAYS");
    expect(canonicalFromPt("NOPE")).toBeNull();
  });

  test("help for the formula bar, in the reader's language", () => {
    expect(functionHelp("SOMA", PT)).toEqual({
      name: "SOMA",
      args: ["live.sheet.args.number1", "live.sheet.args.number2"],
      min: 1,
      repeat: 1,
    });
    expect(functionHelp("vlookup", EN)).toMatchObject({ name: "VLOOKUP", min: 3 });
    expect(functionHelp("PROCV", PT)?.args).toEqual([
      "live.sheet.args.lookup_value",
      "live.sheet.args.table_array",
      "live.sheet.args.col_index_num",
      "live.sheet.args.range_lookup",
    ]);
    expect(functionHelp("NOPE", EN)).toBeNull();
    const pt = functionNames(PT);
    expect(pt.find((n) => n.canonical === "SUM")?.name).toBe("SOMA");
    expect(pt.length).toBe(FUNCTION_NAMES.length);
  });

  test("every function's spec is well formed", () => {
    for (const name of FUNCTION_NAMES) {
      const spec = FUNCTIONS[name];
      expect(spec).toBeDefined();
      if (!spec) continue;
      expect(spec.min).toBeLessThanOrEqual(spec.max);
      expect(Boolean(spec.fn) !== Boolean(spec.lazy)).toBe(true);
      for (const arg of spec.args) expect(arg).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("inspecting a formula being typed", () => {
  const b = book(["Sheet1", "Sheet 2"], { rows: 20, cols: 6 });

  test("references with their cells and colors, the call and the argument", () => {
    const input = "=SOMA(B2:B9;C1;B2:B9;'Sheet 2'!A1:A3)";
    const out = inspectFormula(input, input.indexOf(";C1") + 2, ctx(b, undefined, PT));
    expect(out.refs).toEqual([
      { start: 6, end: 11, sheet: "s0", r1: 1, c1: 1, r2: 8, c2: 1, color: 0 },
      { start: 12, end: 14, sheet: "s0", r1: 0, c1: 2, r2: 0, c2: 2, color: 1 },
      { start: 15, end: 20, sheet: "s0", r1: 1, c1: 1, r2: 8, c2: 1, color: 0 },
      { start: 21, end: 36, sheet: "s1", r1: 0, c1: 0, r2: 2, c2: 0, color: 2 },
    ]);
    expect(out.fn).toEqual({ name: "SUM", arg: 1 });
  });

  test("the name being typed and nested calls", () => {
    const out = inspectFormula("=SE(A1>0;MÁX(A1;", 16, ctx(b, undefined, PT));
    expect(out.fn).toEqual({ name: "MAX", arg: 1 });
    const typing = inspectFormula("=SO", 3, ctx(b, undefined, PT));
    expect(typing.word).toEqual({ start: 1, end: 3, text: "SO" });
    expect(inspectFormula('="abc', 5, ctx(b)).refs).toEqual([]);
    expect(inspectFormula("=SUM(A:A)", 9, ctx(b)).refs[0]).toMatchObject({ r1: 0, r2: 19, c1: 0, c2: 0 });
  });
});
