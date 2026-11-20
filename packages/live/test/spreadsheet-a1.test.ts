import { describe, expect, test } from "bun:test";
import {
  colIndexOf,
  colName,
  formatA1,
  formatA1Range,
  parseA1,
  parseA1Range,
  quoteSheetName,
  r1c1ToA1,
  shiftA1Formula,
} from "../src/spreadsheet/a1";
import { addMonths, dateSerial, daysInMonth, serialDate, serialTime, timeSerial } from "../src/spreadsheet/dates";
import { currencyAfter, localeNames, sheetLocale } from "../src/spreadsheet/locale";
import {
  booleanFromText,
  booleanText,
  errorFromText,
  errorKey,
  errorText,
  isError,
  isErrorCode,
} from "../src/spreadsheet/values";

describe("columns and cells", () => {
  test("column names both ways", () => {
    expect(colName(0)).toBe("A");
    expect(colName(25)).toBe("Z");
    expect(colName(26)).toBe("AA");
    expect(colName(701)).toBe("ZZ");
    expect(colName(702)).toBe("AAA");
    expect(colName(16383)).toBe("XFD");
    expect(colName(-1)).toBe("");
    for (const i of [0, 1, 25, 26, 51, 52, 700, 701, 702, 16383]) expect(colIndexOf(colName(i))).toBe(i);
    expect(colIndexOf("aa")).toBe(26);
    expect(colIndexOf("XFE")).toBe(-1);
    expect(colIndexOf("A1")).toBe(-1);
    expect(colIndexOf("")).toBe(-1);
  });

  test("one cell's address", () => {
    expect(parseA1("B2")).toEqual({ row: 1, col: 1, absRow: false, absCol: false });
    expect(parseA1("$B$2")).toEqual({ row: 1, col: 1, absRow: true, absCol: true });
    expect(parseA1("b$10")).toEqual({ row: 9, col: 1, absRow: true, absCol: false });
    expect(parseA1(" C3 ")).toEqual({ row: 2, col: 2, absRow: false, absCol: false });
    expect(parseA1("A0")).toBeNull();
    expect(parseA1("XFE1")).toBeNull();
    expect(parseA1("A1048577")).toBeNull();
    expect(parseA1("Sheet1")).toBeNull();
    expect(formatA1(1, 1)).toBe("B2");
    expect(formatA1(1, 1, { row: true, col: true })).toBe("$B$2");
  });

  test("ranges, whole columns and rows, and sheet names", () => {
    expect(parseA1Range("B2:E9")).toEqual({ r1: 1, c1: 1, r2: 8, c2: 4 });
    expect(parseA1Range("E9:B2")).toEqual({ r1: 1, c1: 1, r2: 8, c2: 4 });
    expect(parseA1Range("C3")).toEqual({ r1: 2, c1: 2, r2: 2, c2: 2 });
    expect(parseA1Range("A:A")).toEqual({ r1: 0, c1: 0, r2: 19999, c2: 0, whole: "cols" });
    expect(parseA1Range("3:5")).toEqual({ r1: 2, c1: 0, r2: 4, c2: 499, whole: "rows" });
    expect(parseA1Range("Sheet 2!A1")).toEqual({ sheet: "Sheet 2", r1: 0, c1: 0, r2: 0, c2: 0 });
    expect(parseA1Range("'My sheet'!B2:C3")).toEqual({ sheet: "My sheet", r1: 1, c1: 1, r2: 2, c2: 2 });
    expect(parseA1Range("'It''s'!A1")).toEqual({ sheet: "It's", r1: 0, c1: 0, r2: 0, c2: 0 });
    expect(parseA1Range("Vendas!$A$1:$B$2")).toEqual({ sheet: "Vendas", r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(parseA1Range("nope")).toBeNull();
    expect(parseA1Range("A1:")).toBeNull();
    expect(parseA1Range("!A1")).toBeNull();
  });

  test("ranges as the name box shows them", () => {
    expect(formatA1Range(1, 1, 8, 4)).toBe("B2:E9");
    expect(formatA1Range(8, 4, 1, 1)).toBe("B2:E9");
    expect(formatA1Range(2, 2, 2, 2)).toBe("C3");
    expect(formatA1Range(0, 1, 99, 2, { rows: 100, cols: 26 })).toBe("B:C");
    expect(formatA1Range(4, 0, 6, 25, { rows: 100, cols: 26 })).toBe("5:7");
  });

  test("sheet names in references", () => {
    expect(quoteSheetName("Sales")).toBe("Sales");
    expect(quoteSheetName("Vendas_2026")).toBe("Vendas_2026");
    expect(quoteSheetName("Sheet 2")).toBe("'Sheet 2'");
    expect(quoteSheetName("It's")).toBe("'It''s'");
    expect(quoteSheetName("A1")).toBe("'A1'");
    expect(quoteSheetName("R1C1")).toBe("'R1C1'");
    expect(quoteSheetName("2026")).toBe("'2026'");
  });
});

describe("moving A1 formulas", () => {
  test("relative parts move, $ parts stay", () => {
    expect(shiftA1Formula("=A1*2", 1, 0)).toBe("=A2*2");
    expect(shiftA1Formula("=SUM(B2:B9)+$C$1", 2, 1)).toBe("=SUM(C4:C11)+$C$1");
    expect(shiftA1Formula("=$A1+A$1", 3, 4)).toBe("=$A4+E$1");
    expect(shiftA1Formula("=SUM(A:A)", 5, 1)).toBe("=SUM(B:B)");
    expect(shiftA1Formula("=SUM(2:3)", 1, 4)).toBe("=SUM(3:4)");
  });

  test("sheets, quotes and names are left alone", () => {
    expect(shiftA1Formula("=Sheet2!B3+'My sheet'!A1:B2", 1, 1)).toBe("=Sheet2!C4+'My sheet'!B2:C3");
    expect(shiftA1Formula('="A1 and B2"&A1', 1, 0)).toBe('="A1 and B2"&A2');
    expect(shiftA1Formula("=LOG10(A1)+ATAN2(B1,C1)", 1, 0)).toBe("=LOG10(A2)+ATAN2(B2,C2)");
    expect(shiftA1Formula("=TRUE+DAYS360(A1,B1)", 0, 1)).toBe("=TRUE+DAYS360(B1,C1)");
    expect(shiftA1Formula("=1.5E+10*A1", 1, 0)).toBe("=1.5E+10*A2");
    expect(shiftA1Formula("=A1B", 1, 0)).toBe("=A1B");
  });

  test("a reference pushed off the grid becomes #REF!", () => {
    expect(shiftA1Formula("=A1+B5", -1, 0)).toBe("=#REF!+B4");
    expect(shiftA1Formula("=SUM(A1:A3)", 0, -1)).toBe("=SUM(#REF!)");
    expect(shiftA1Formula("=Sheet2!A1", -1, 0)).toBe("=#REF!");
  });

  test("R1C1 from another spreadsheet's clipboard, read where it lands", () => {
    expect(r1c1ToA1("=R[0]C[-1]*2", 0, 1)).toBe("=A1*2");
    expect(r1c1ToA1("=SUM(R[-3]C:R[-1]C)", 4, 2)).toBe("=SUM(C2:C4)");
    expect(r1c1ToA1("=R1C1+RC[1]", 9, 0)).toBe("=$A$1+B10");
    expect(r1c1ToA1("=SUM(C[-1])", 0, 3)).toBe("=SUM(C:C)");
    expect(r1c1ToA1("=SUM(R2:R3)", 0, 0)).toBe("=SUM($2:$3)");
    expect(r1c1ToA1("=Sheet2!R[1]C[1]", 0, 0)).toBe("=Sheet2!B2");
    expect(r1c1ToA1("='My sheet'!R1C2", 5, 5)).toBe("='My sheet'!$B$1");
    expect(r1c1ToA1('=ROUND(R[0]C[-1],2)&"RC"', 0, 1)).toBe('=ROUND(A1,2)&"RC"');
    expect(r1c1ToA1("=R[-1]C", 0, 0)).toBe("=#REF!");
  });
});

describe("values and errors", () => {
  test("errors in the reader's language", () => {
    const pt = sheetLocale("pt-BR");
    const en = sheetLocale("en-US");
    expect(errorText("#N/A", pt)).toBe("#N/D");
    expect(errorText("#NUM!", pt)).toBe("#NÚM!");
    expect(errorText("#NULL!", pt)).toBe("#NULO!");
    expect(errorText("#SPILL!", pt)).toBe("#DESPEJAR!");
    expect(errorText("#CALC!", pt)).toBe("#CALC!");
    expect(errorText("#CYCLE!", pt)).toBe("#REF!");
    expect(errorText("#CYCLE!", en)).toBe("#REF!");
    expect(errorText("#DIV/0!", en)).toBe("#DIV/0!");
    expect(errorFromText("#n/d")).toBe("#N/A");
    expect(errorFromText("#VALOR!")).toBe("#VALUE!");
    expect(errorFromText(" #REF! ")).toBe("#REF!");
    expect(errorFromText("#CYCLE!")).toBeNull();
    expect(errorFromText("#oops")).toBeNull();
    expect(errorKey("#DIV/0!")).toBe("live.sheet.errors.div0");
    expect(errorKey("#REF!", true)).toBe("live.sheet.errors.circular");
    expect(isError({ error: "#N/A" })).toBe(true);
    expect(isError("#N/A")).toBe(false);
    expect(isError(null)).toBe(false);
    expect(isErrorCode("#N/A")).toBe(true);
    expect(isErrorCode("#N/D")).toBe(false);
  });

  test("booleans in both languages", () => {
    expect(booleanText(true, sheetLocale("pt-BR"))).toBe("VERDADEIRO");
    expect(booleanText(false, sheetLocale("en"))).toBe("FALSE");
    expect(booleanFromText("verdadeiro")).toBe(true);
    expect(booleanFromText(" False ")).toBe(false);
    expect(booleanFromText("yes")).toBeNull();
  });
});

describe("locales", () => {
  test("the app's languages", () => {
    expect(sheetLocale("pt-BR")).toEqual({
      tag: "pt-BR",
      decimal: ",",
      group: ".",
      argSep: ";",
      dateOrder: "dmy",
      currency: "R$",
      fnNames: "pt",
    });
    expect(sheetLocale("en-US")).toEqual({
      tag: "en-US",
      decimal: ".",
      group: ",",
      argSep: ",",
      dateOrder: "mdy",
      currency: "$",
      fnNames: "en",
    });
    expect(sheetLocale("en").tag).toBe("en-US");
    expect(sheetLocale("pt").tag).toBe("pt-BR");
    expect(sheetLocale("pt_br").tag).toBe("pt-BR");
    expect(sheetLocale("de").argSep).toBe(";");
    expect(sheetLocale("ja").dateOrder).toBe("ymd");
    expect(sheetLocale("en-GB").dateOrder).toBe("dmy");
    expect(sheetLocale("zh-Hans").tag).toBe("zh-CN");
  });

  test("other tags come from Intl, with ; wherever the decimal is a comma", () => {
    const sv = sheetLocale("sv-SE");
    expect(sv.decimal).toBe(",");
    expect(sv.argSep).toBe(";");
    expect(sv.fnNames).toBe("en");
    const anything = sheetLocale("xx-YY");
    expect(anything.decimal === "." || anything.decimal === ",").toBe(true);
  });

  test("currency side and names", () => {
    expect(currencyAfter(sheetLocale("de-DE"))).toBe(true);
    expect(currencyAfter(sheetLocale("pt-BR"))).toBe(false);
    expect(localeNames(sheetLocale("pt-BR")).monthsShort[10]).toBe("nov");
    expect(localeNames(sheetLocale("en-US")).days[2]).toBe("Tuesday");
    expect(localeNames(sheetLocale("es-ES")).months.length).toBe(12);
  });
});

describe("Excel's date serials", () => {
  test("dates both ways", () => {
    expect(dateSerial(2026, 11, 17)).toBe(46343);
    expect(dateSerial(1900, 1, 1)).toBe(1);
    expect(dateSerial(1900, 2, 28)).toBe(59);
    expect(dateSerial(1900, 2, 29)).toBe(60);
    expect(dateSerial(1900, 3, 1)).toBe(61);
    expect(dateSerial(2026, 13, 1)).toBe(dateSerial(2027, 1, 1));
    expect(dateSerial(2026, 3, 0)).toBe(dateSerial(2026, 2, 28));
    expect(serialDate(46343)).toEqual({ year: 2026, month: 11, day: 17, weekday: 2 });
    expect(serialDate(60)).toEqual({ year: 1900, month: 2, day: 29, weekday: 3 });
    expect(serialDate(1).weekday).toBe(0);
    for (const serial of [1, 59, 61, 365, 36526, 46343, 2958465]) {
      const d = serialDate(serial);
      expect(dateSerial(d.year, d.month, d.day)).toBe(serial);
    }
  });

  test("times and months", () => {
    expect(timeSerial(18, 0, 0)).toBe(0.75);
    expect(serialTime(46343.75)).toEqual({ hour: 18, minute: 0, second: 0, ms: 0 });
    expect(serialTime(timeSerial(10, 30, 15, 250))).toEqual({ hour: 10, minute: 30, second: 15, ms: 250 });
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(addMonths(dateSerial(2026, 1, 31), 1)).toBe(dateSerial(2026, 2, 28));
    expect(addMonths(dateSerial(2026, 11, 17), -12)).toBe(dateSerial(2025, 11, 17));
    expect(addMonths(dateSerial(2026, 11, 17) + 0.5, 1)).toBe(dateSerial(2026, 12, 17) + 0.5);
  });
});
