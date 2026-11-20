import { describe, expect, test } from "bun:test";
import { dateSerial, timeSerial } from "../src/spreadsheet/dates";
import { formatValue } from "../src/spreadsheet/format";
import { parseInput, parseNumber, valueInput } from "../src/spreadsheet/input";
import { sheetLocale } from "../src/spreadsheet/locale";

const EN = sheetLocale("en-US");
const PT = sheetLocale("pt-BR");
const NOW = { now: new Date(Date.UTC(2026, 10, 17, 12)) };
const NOV_17 = 46343;

const en = (text: string) => parseInput(text, EN, NOW);
const pt = (text: string) => parseInput(text, PT, NOW);

describe("parseInput", () => {
  test("empty, formulas and the apostrophe", () => {
    expect(en("")).toEqual({});
    expect(en("'00123")).toEqual({ v: "00123" });
    expect(en("'")).toEqual({});
    expect(en("'=1+1")).toEqual({ v: "=1+1" });
    expect(en("=SUM(A1:B2)")).toEqual({ f: "=SUM(A1:B2)" });
    expect(pt("=SOMA(A1;B2)")).toEqual({ f: "=SOMA(A1;B2)" });
    expect(en("=")).toEqual({ v: "=" });
    expect(en(" =1+1")).toEqual({ v: " =1+1" });
  });

  test("numbers in English", () => {
    expect(en("123")).toEqual({ v: 123 });
    expect(en("-12.5")).toEqual({ v: -12.5 });
    expect(en("+5")).toEqual({ v: 5 });
    expect(en(".5")).toEqual({ v: 0.5 });
    expect(en("00123")).toEqual({ v: 123 });
    expect(en("1,234")).toEqual({ v: 1234, nf: "#,##0" });
    expect(en("1,234.50")).toEqual({ v: 1234.5, nf: "#,##0.00" });
    expect(en("1,234,567")).toEqual({ v: 1234567, nf: "#,##0" });
    expect(en("1.5e3")).toEqual({ v: 1500, nf: "0.00E+00" });
    expect(en("(100)")).toEqual({ v: -100 });
    expect(en("  12  ")).toEqual({ v: 12 });
    expect(en("1,5")).toEqual({ v: "1,5" });
    expect(en("12,34")).toEqual({ v: "12,34" });
  });

  test("numbers in Portuguese", () => {
    expect(pt("1.234,5")).toEqual({ v: 1234.5, nf: "#,##0.00" });
    expect(pt("1234,5")).toEqual({ v: 1234.5 });
    expect(pt("-0,25")).toEqual({ v: -0.25 });
    expect(pt("1.234")).toEqual({ v: 1234, nf: "#,##0" });
    expect(pt("1,5e3")).toEqual({ v: 1500, nf: "0.00E+00" });
    expect(pt("1.5")).toEqual({ v: "1.5" });
  });

  test("too many digits stay text, as card and ID numbers should", () => {
    expect(en("1234567890123456")).toEqual({ v: "1234567890123456" });
    expect(en("123456789012345")).toEqual({ v: 123456789012345 });
  });

  test("percentages", () => {
    expect(en("12%")).toEqual({ v: 0.12, nf: "0%" });
    expect(en("12.5%")).toEqual({ v: 0.125, nf: "0.00%" });
    expect(pt("12,5%")).toEqual({ v: 0.125, nf: "0.00%" });
    expect(en("-3%")).toEqual({ v: -0.03, nf: "0%" });
    expect(en("%")).toEqual({ v: "%" });
  });

  test("currency, on either side", () => {
    expect(en("$10")).toEqual({ v: 10, nf: "$#,##0.00" });
    expect(en("-$1,234.50")).toEqual({ v: -1234.5, nf: "$#,##0.00" });
    expect(pt("R$ 1.234,50")).toEqual({ v: 1234.5, nf: '"R$" #,##0.00' });
    expect(pt("-R$ 10,00")).toEqual({ v: -10, nf: '"R$" #,##0.00' });
    expect(pt("R$ -10")).toEqual({ v: -10, nf: '"R$" #,##0.00' });
    expect(pt("10 €")).toEqual({ v: 10, nf: '#,##0.00 "€"' });
    expect(en("€ 10")).toEqual({ v: 10, nf: '"€" #,##0.00' });
    expect(en("US$ 5")).toEqual({ v: 5, nf: '"US$" #,##0.00' });
    expect(en("¥1000")).toEqual({ v: 1000, nf: '"¥" #,##0' });
    expect(en("$")).toEqual({ v: "$" });
    expect(en("$10%")).toEqual({ v: "$10%" });
  });

  test("booleans in both languages", () => {
    expect(en("TRUE")).toEqual({ v: true });
    expect(en("false")).toEqual({ v: false });
    expect(en("VERDADEIRO")).toEqual({ v: true });
    expect(pt("Falso")).toEqual({ v: false });
    expect(pt("TRUE")).toEqual({ v: true });
  });

  test("dates in the locale's order, ISO and with month names", () => {
    expect(en("11/17/2026")).toEqual({ v: NOV_17, nf: "m/d/yyyy" });
    expect(en("17/11/2026")).toEqual({ v: "17/11/2026" });
    expect(pt("17/11/2026")).toEqual({ v: NOV_17, nf: "dd/mm/yyyy" });
    expect(pt("17-11-2026")).toEqual({ v: NOV_17, nf: "dd/mm/yyyy" });
    expect(pt("17.11.26")).toEqual({ v: NOV_17, nf: "dd/mm/yyyy" });
    expect(en("2026-11-17")).toEqual({ v: NOV_17, nf: "yyyy-mm-dd" });
    expect(pt("2026-11-17")).toEqual({ v: NOV_17, nf: "yyyy-mm-dd" });
    expect(en("2026/11/17")).toEqual({ v: NOV_17, nf: "m/d/yyyy" });
    expect(en("Nov 17, 2026")).toEqual({ v: NOV_17, nf: "m/d/yyyy" });
    expect(en("17-Nov-2026")).toEqual({ v: NOV_17, nf: "m/d/yyyy" });
    expect(pt("17 de novembro de 2026")).toEqual({ v: NOV_17, nf: "dd/mm/yyyy" });
    expect(pt("17/nov/2026")).toEqual({ v: NOV_17, nf: "dd/mm/yyyy" });
    expect(pt("17/11")).toEqual({ v: NOV_17, nf: "dd/mm/yyyy" });
    expect(en("1/2")).toEqual({ v: dateSerial(2026, 1, 2), nf: "m/d/yyyy" });
    expect(en("2/30/2026")).toEqual({ v: "2/30/2026" });
    expect(en("1900-02-29")).toEqual({ v: 60, nf: "yyyy-mm-dd" });
  });

  test("dates with a time of day", () => {
    expect(en("2026-11-17 10:30")).toEqual({ v: NOV_17 + timeSerial(10, 30, 0), nf: "yyyy-mm-dd hh:mm" });
    expect(en("2026-11-17T10:30:15Z")).toEqual({
      v: NOV_17 + timeSerial(10, 30, 15),
      nf: "yyyy-mm-dd hh:mm:ss",
    });
    expect(pt("17/11/2026 18:00")).toEqual({ v: NOV_17 + 0.75, nf: "dd/mm/yyyy hh:mm" });
    expect(en("11/17/2026 6:00 PM")).toEqual({ v: NOV_17 + 0.75, nf: "m/d/yyyy h:mm" });
  });

  test("times", () => {
    expect(en("10:30")).toEqual({ v: timeSerial(10, 30, 0), nf: "hh:mm" });
    expect(en("10:30:15")).toEqual({ v: timeSerial(10, 30, 15), nf: "hh:mm:ss" });
    expect(en("10:30 PM")).toEqual({ v: timeSerial(22, 30, 0), nf: "h:mm AM/PM" });
    expect(en("12:00 am")).toEqual({ v: 0, nf: "h:mm AM/PM" });
    expect(en("9 pm")).toEqual({ v: timeSerial(21, 0, 0), nf: "h:mm AM/PM" });
    expect(en("25:30")).toEqual({ v: timeSerial(25, 30, 0), nf: "[h]:mm" });
    expect(en("10:75")).toEqual({ v: "10:75" });
  });

  test("fractions", () => {
    expect(en("1 1/2")).toEqual({ v: 1.5, nf: "# ?/?" });
    expect(en("0 3/16")).toEqual({ v: 0.1875, nf: "# ??/??" });
    expect(en("-2 1/4")).toEqual({ v: -2.25, nf: "# ?/?" });
  });

  test("text stays as typed", () => {
    expect(en("hello")).toEqual({ v: "hello" });
    expect(en("  hello ")).toEqual({ v: "  hello " });
    expect(en("Item 1")).toEqual({ v: "Item 1" });
    expect(en("1st")).toEqual({ v: "1st" });
    expect(pt("ABC-123")).toEqual({ v: "ABC-123" });
  });

  test("parseNumber reads only plain numbers", () => {
    expect(parseNumber("1.234,5", PT)).toBe(1234.5);
    expect(parseNumber("1,234.5", EN)).toBe(1234.5);
    expect(parseNumber("12%", EN)).toBeNull();
    expect(parseNumber("$5", EN)).toBeNull();
    expect(parseNumber("abc", EN)).toBeNull();
  });
});

describe("valueInput", () => {
  test("what the editor shows for each stored value", () => {
    expect(valueInput(NOV_17, "dd/mm/yyyy", PT)).toBe("17/11/2026");
    expect(valueInput(NOV_17, "m/d/yyyy", EN)).toBe("11/17/2026");
    expect(valueInput(NOV_17, "yyyy-mm-dd", PT)).toBe("2026-11-17");
    expect(valueInput(NOV_17 + 0.75, "dd/mm/yyyy hh:mm", PT)).toBe("17/11/2026 18:00:00");
    expect(valueInput(NOV_17 + 0.75, "dd/mm/yyyy", PT)).toBe("17/11/2026 18:00:00");
    expect(valueInput(timeSerial(10, 30, 0), "hh:mm", EN)).toBe("10:30:00");
    expect(valueInput(1.5, "[h]:mm", EN)).toBe("36:00:00");
    expect(valueInput(0.125, "0.00%", PT)).toBe("12,5%");
    expect(valueInput(0.07, "0%", EN)).toBe("7%");
    expect(valueInput(1234.5, '"R$" #,##0.00', PT)).toBe("1234,5");
    expect(valueInput(0.1 + 0.2, undefined, EN)).toBe("0.3");
    expect(valueInput(true, undefined, EN)).toBe("TRUE");
    expect(valueInput(true, undefined, PT)).toBe("VERDADEIRO");
    expect(valueInput(null, undefined, EN)).toBe("");
    expect(valueInput("hello", undefined, EN)).toBe("hello");
  });

  test("text that would read as something else gets an apostrophe", () => {
    expect(valueInput("00123", undefined, EN)).toBe("'00123");
    expect(valueInput("TRUE", undefined, EN)).toBe("'TRUE");
    expect(valueInput("=x", undefined, EN)).toBe("'=x");
    expect(valueInput("12%", undefined, PT)).toBe("'12%");
    expect(valueInput("17/11", undefined, PT)).toBe("'17/11");
    expect(valueInput("'quoted", undefined, EN)).toBe("''quoted");
  });

  test("typing back what the editor shows gives the same value", () => {
    const cases: [number, string | undefined][] = [
      [1234.5678, undefined],
      [-0.000125, "0.00"],
      [0.125, "0.00%"],
      [NOV_17, "dd/mm/yyyy"],
      [NOV_17 + timeSerial(9, 15, 30), "dd/mm/yyyy hh:mm:ss"],
      [timeSerial(23, 59, 59), "hh:mm:ss"],
      [123456789.123, "#,##0.00"],
    ];
    for (const locale of [EN, PT]) {
      for (const [v, nf] of cases) {
        const back = parseInput(valueInput(v, nf, locale), locale, NOW);
        expect(typeof back.v).toBe("number");
        expect(Math.abs((back.v as number) - v)).toBeLessThan(1e-9);
      }
    }
  });

  test("what a typed value shows with the format it implies", () => {
    const shown = (text: string, locale = PT) => {
      const parsed = parseInput(text, locale, NOW);
      return formatValue(parsed.v ?? null, parsed.nf, locale).text;
    };
    expect(shown("R$ 1.234,5")).toBe("R$ 1.234,50");
    expect(shown("17/11/2026")).toBe("17/11/2026");
    expect(shown("12,5%")).toBe("12,50%");
    expect(shown("1.234")).toBe("1.234");
    expect(shown("$1,234.5", EN)).toBe("$1,234.50");
    expect(shown("11/17/2026", EN)).toBe("11/17/2026");
  });
});
