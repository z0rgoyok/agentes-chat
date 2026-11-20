import { describe, expect, test } from "bun:test";
import {
  changeDecimals,
  currencyFormat,
  formatGeneral,
  formatKind,
  formatPlain,
  formatValue,
  isDateFormat,
  isNumberFormatPreset,
  NUMBER_FORMATS,
  numberFormatCode,
  numberFormatPreset,
} from "../src/spreadsheet/format";
import { sheetLocale } from "../src/spreadsheet/locale";

const EN = sheetLocale("en-US");
const PT = sheetLocale("pt-BR");
const FR = sheetLocale("fr-FR");

const en = (value: Parameters<typeof formatValue>[0], nf?: string) => formatValue(value, nf, EN).text;
const pt = (value: Parameters<typeof formatValue>[0], nf?: string) => formatValue(value, nf, PT).text;

/** 2026-11-17, a Tuesday, as an Excel serial. */
const NOV_17 = 46343;

describe("General", () => {
  test("shows numbers in up to 11 characters, then scientific", () => {
    expect(en(0)).toBe("0");
    expect(en(1234.5)).toBe("1234.5");
    expect(en(-1234.5)).toBe("-1234.5");
    expect(en(0.1 + 0.2)).toBe("0.3");
    expect(en(1 / 3)).toBe("0.333333333");
    expect(en(2 / 3)).toBe("0.666666667");
    expect(en(12345678901)).toBe("12345678901");
    expect(en(123456789012)).toBe("1.23457E+11");
    expect(en(1e20)).toBe("1E+20");
    expect(en(0.000001)).toBe("0.000001");
    expect(en(0.0001234)).toBe("0.0001234");
    expect(en(1.5e-9)).toBe("1.5E-09");
    expect(en(1e-10)).toBe("1E-10");
    expect(en(100)).toBe("100");
  });

  test("uses the reader's decimal comma and no thousands", () => {
    expect(pt(1234.5)).toBe("1234,5");
    expect(pt(-0.25)).toBe("-0,25");
    expect(pt(1 / 3)).toBe("0,333333333");
    expect(pt(123456789012)).toBe("1,23457E+11");
  });

  test("the General code and an empty one are the same", () => {
    expect(en(1234.5, "General")).toBe("1234.5");
    expect(en(1234.5, "general")).toBe("1234.5");
    expect(en(1234.5, "")).toBe("1234.5");
  });

  test("formatGeneral and formatPlain", () => {
    expect(formatGeneral(1234.5, EN)).toBe("1234.5");
    expect(formatPlain(1234.5, PT)).toBe("1234,5");
    expect(formatPlain(0.1 + 0.2, EN)).toBe("0.3");
    expect(formatPlain(123456789012, EN)).toBe("123456789012");
    expect(formatPlain(1.5e22, EN)).toBe("1.5E+22");
    expect(formatPlain(-0.000125, EN)).toBe("-0.000125");
    expect(formatPlain(0, EN)).toBe("0");
  });

  test("numbers sit right, text left, booleans and errors centered", () => {
    expect(formatValue(1, undefined, EN).align).toBe("r");
    expect(formatValue("x", undefined, EN).align).toBe("l");
    expect(formatValue(true, undefined, EN).align).toBe("c");
    expect(formatValue({ error: "#N/A" }, undefined, EN).align).toBe("c");
    expect(formatValue(null, undefined, EN)).toEqual({ text: "" });
  });
});

describe("digit placeholders", () => {
  test("0 pads, # drops, ? keeps the room", () => {
    expect(en(7, "000")).toBe("007");
    expect(en(1.5, "00.00")).toBe("01.50");
    expect(en(0, "#")).toBe("");
    expect(en(0.5, "#.##")).toBe(".5");
    expect(en(1, "#.##")).toBe("1.");
    expect(en(1.5, "?.??")).toBe("1.5 ");
    expect(en(12.3, "??.??")).toBe("12.3 ");
  });

  test("rounds half away from zero, as Excel shows it", () => {
    expect(en(1234.5, "0")).toBe("1235");
    expect(en(-1234.5, "0")).toBe("-1235");
    expect(en(1.005, "0.00")).toBe("1.01");
    expect(en(2.675, "0.00")).toBe("2.68");
    expect(en(0.125, "0.00")).toBe("0.13");
    expect(en(9.995, "0.00")).toBe("10.00");
    expect(en(999.9999, "#,##0.00")).toBe("1,000.00");
  });

  test("a negative that rounds to zero shows no minus", () => {
    expect(en(-0.001, "0.00")).toBe("0.00");
    expect(en(-0.4, "0")).toBe("0");
  });

  test("thousands separators and scaling commas", () => {
    expect(pt(1234.5, "#,##0.00")).toBe("1.234,50");
    expect(en(1234.5, "#,##0.00")).toBe("1,234.50");
    expect(en(1234567.891, "#,##0.00")).toBe("1,234,567.89");
    expect(pt(1234567.891, "#,##0.00")).toBe("1.234.567,89");
    expect(formatValue(1234567.891, "#,##0.00", FR).text).toBe("1 234 567,89");
    expect(en(1234, "#,##0")).toBe("1,234");
    expect(en(0, "#,##0")).toBe("0");
    expect(en(0, "#,##0.00")).toBe("0.00");
    expect(en(-1234.5, "#,##0.00")).toBe("-1,234.50");
    expect(en(1234567890, "#,##0,,")).toBe("1,235");
    expect(en(1234567, "0.0,,")).toBe("1.2");
    expect(en(1500, '0.0,"K"')).toBe("1.5K");
    expect(pt(1234567, '#,##0.0,," mi"')).toBe("1,2 mi");
  });

  test("percentages multiply by 100", () => {
    expect(en(0.256, "0%")).toBe("26%");
    expect(en(0.12345, "0.00%")).toBe("12.35%");
    expect(pt(0.12345, "0.00%")).toBe("12,35%");
    expect(en(-0.05, "0%")).toBe("-5%");
    expect(en(1, "0%")).toBe("100%");
  });

  test("scientific, with engineering steps", () => {
    expect(en(12345, "0.00E+00")).toBe("1.23E+04");
    expect(en(0.000123, "0.00E+00")).toBe("1.23E-04");
    expect(en(0, "0.00E+00")).toBe("0.00E+00");
    expect(en(-12345, "0.00E+00")).toBe("-1.23E+04");
    expect(pt(12345, "0.00E+00")).toBe("1,23E+04");
    expect(en(12345, "0.0E-0")).toBe("1.2E4");
    expect(en(12345, "##0.0E+0")).toBe("12.3E+3");
    expect(en(1234567, "##0.0E+0")).toBe("1.2E+6");
    expect(en(9.999, "0.00E+00")).toBe("1.00E+01");
  });

  test("fractions", () => {
    expect(en(1.5, "# ?/?")).toBe("1 1/2");
    expect(en(0.75, "# ?/?")).toBe(" 3/4");
    expect(en(2, "# ?/?")).toBe("2    ");
    expect(en(Math.PI, "# ??/??")).toBe("3 14/99");
    expect(en(0.3, "# ?/8")).toBe(" 2/8");
    expect(en(1.25, "?/?")).toBe("5/4");
    expect(en(-1.5, "# ?/?")).toBe("-1 1/2");
  });
});

describe("literals, currency and sections", () => {
  test("quoted text, escapes and plain signs", () => {
    expect(en(1234.5, '"$"#,##0.00')).toBe("$1,234.50");
    expect(en(1234.5, "$#,##0.00")).toBe("$1,234.50");
    expect(en(5, '0 "units"')).toBe("5 units");
    expect(en(5, "0\\k")).toBe("5k");
    expect(en(-5, "(0)")).toBe("-(5)");
    expect(en(3, "0_)")).toBe("3 ");
    expect(en(3, "**0")).toBe("3");
  });

  test("currency by locale tag", () => {
    expect(pt(1234.5, "[$R$-416] #,##0.00")).toBe("R$ 1.234,50");
    expect(pt(1234.5, '"R$" #,##0.00')).toBe("R$ 1.234,50");
    expect(pt(-1234.5, '"R$" #,##0.00')).toBe("-R$ 1.234,50");
    expect(en(1234.5, "[$€-407] #,##0.00")).toBe("€ 1,234.50");
    expect(pt(46343, "[$-416]dd/mm/yyyy")).toBe("17/11/2026");
    expect(en(9.5, "[$$-409]#,##0.00")).toBe("$9.50");
  });

  test("negative and zero sections", () => {
    expect(en(-5, "#,##0.00;(#,##0.00)")).toBe("(5.00)");
    expect(en(5, "#,##0.00;(#,##0.00)")).toBe("5.00");
    expect(en(0, '0;-0;"zero"')).toBe("zero");
    expect(en(0, "0;-0;;@")).toBe("");
    expect(en(-2, "0;-0;;@")).toBe("-2");
    expect(en(-2, '0;"minus "0')).toBe("minus 2");
    const red = formatValue(-5, "#,##0.00;[Red]-#,##0.00", EN);
    expect(red).toEqual({ text: "-5.00", align: "r", color: "#ff0000" });
    expect(formatValue(5, "#,##0.00;[Red]-#,##0.00", EN).color).toBeUndefined();
  });

  test("text sections", () => {
    expect(en("x", '0.00;-0.00;0.00;"Text: "@')).toBe("Text: x");
    expect(en("abc", "@")).toBe("abc");
    expect(en(12, "@")).toBe("12");
    expect(en("abc", "0.00")).toBe("abc");
    expect(formatValue("x", '0;0;0;[Blue]"<"@">"', EN)).toEqual({ text: "<x>", align: "l", color: "#0000ff" });
  });

  test("colors by name and by Excel's palette", () => {
    expect(formatValue(1, "[Blue]0", EN).color).toBe("#0000ff");
    expect(formatValue(1, "[Color10]0", EN).color).toBe("#008000");
    expect(formatValue(1, "[COLOR 3]0", EN).color).toBe("#ff0000");
    expect(formatValue(1, "[Green]0", EN).color).toBe("#00ff00");
  });

  test("conditions", () => {
    const k = '[>=1000]#,##0,"K";0';
    expect(en(1500, k)).toBe("2K");
    expect(en(500, k)).toBe("500");
    const words = '[<0]"neg";[>0]"pos";"zero"';
    expect(en(-1, words)).toBe("neg");
    expect(en(1, words)).toBe("pos");
    expect(en(0, words)).toBe("zero");
    expect(en(-3, "[<0]0;0")).toBe("3");
  });

  test("accounting keeps its sign and padding", () => {
    const code = '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)';
    expect(en(1234.5, code)).toBe(" $1,234.50 ");
    expect(en(-1234.5, code)).toBe(" $(1,234.50)");
    expect(en(0, code).trim()).toBe("$-");
    expect(en("note", code)).toBe(" note ");
  });

  test("General inside a code", () => {
    expect(en(12.5, '"Total: "General')).toBe("Total: 12.5");
    expect(pt(12.5, 'General" kg"')).toBe("12,5 kg");
  });
});

describe("dates and times", () => {
  test("day, month and year in each order", () => {
    expect(en(NOV_17, "m/d/yyyy")).toBe("11/17/2026");
    expect(pt(NOV_17, "dd/mm/yyyy")).toBe("17/11/2026");
    expect(en(NOV_17, "yyyy-mm-dd")).toBe("2026-11-17");
    expect(en(NOV_17, "d-mmm-yy")).toBe("17-Nov-26");
    expect(pt(NOV_17, "d-mmm-yy")).toBe("17-nov-26");
    expect(en(NOV_17, "mmmmm")).toBe("N");
    expect(en(NOV_17, "m")).toBe("11");
    expect(en(45658, "d/m/yy")).toBe("1/1/25");
  });

  test("names of months and weekdays in the reader's language", () => {
    expect(en(NOV_17, "dddd, mmmm d, yyyy")).toBe("Tuesday, November 17, 2026");
    expect(pt(NOV_17, "dddd, d \\de mmmm \\de yyyy")).toBe("terça-feira, 17 de novembro de 2026");
    expect(en(NOV_17, "ddd")).toBe("Tue");
    expect(pt(NOV_17, "ddd")).toBe("ter");
  });

  test("times, 12-hour clocks and fractions of a second", () => {
    expect(en(NOV_17 + 0.75, "m/d/yyyy h:mm")).toBe("11/17/2026 18:00");
    expect(pt(NOV_17 + 0.75, "dd/mm/yyyy hh:mm")).toBe("17/11/2026 18:00");
    expect(en(0.75, "h:mm AM/PM")).toBe("6:00 PM");
    expect(en(0.5, "h:mm:ss AM/PM")).toBe("12:00:00 PM");
    expect(en(0, "h:mm:ss AM/PM")).toBe("12:00:00 AM");
    expect(en(0.25, "h:mm a/p")).toBe("6:00 a");
    expect(en(0.25, "hh:mm")).toBe("06:00");
    expect(en(1.5 / 86400, "mm:ss.0")).toBe("00:01.5");
    expect(pt(1.25 / 86400, "mm:ss.00")).toBe("00:01,25");
    expect(en((10 * 3600 + 30 * 60 + 45) / 86400, "h:mm")).toBe("10:30");
    expect(en((10 * 3600 + 30 * 60 + 59.6) / 86400, "h:mm:ss")).toBe("10:31:00");
  });

  test("elapsed time", () => {
    expect(en(1.5, "[h]:mm")).toBe("36:00");
    expect(en(1.25 + 30 / 86400, "[h]:mm:ss")).toBe("30:00:30");
    expect(en(0.0625, "[mm]:ss")).toBe("90:00");
    expect(en(100 / 86400, "[ss]")).toBe("100");
  });

  test("Excel's 1900 calendar, its leap day included", () => {
    expect(en(1, "yyyy-mm-dd")).toBe("1900-01-01");
    expect(en(59, "yyyy-mm-dd")).toBe("1900-02-28");
    expect(en(60, "yyyy-mm-dd")).toBe("1900-02-29");
    expect(en(61, "yyyy-mm-dd")).toBe("1900-03-01");
    expect(en(2958465, "yyyy-mm-dd")).toBe("9999-12-31");
  });

  test("dates out of range show #####", () => {
    expect(en(-1, "yyyy-mm-dd")).toBe("#####");
    expect(en(2958466, "yyyy-mm-dd")).toBe("#####");
  });
});

describe("booleans and errors", () => {
  test("ignore the format, in the reader's language", () => {
    expect(en(true, "0.00")).toBe("TRUE");
    expect(pt(false, "0.00")).toBe("FALSO");
    expect(en({ error: "#DIV/0!" })).toBe("#DIV/0!");
    expect(pt({ error: "#N/A" })).toBe("#N/D");
    expect(pt({ error: "#NAME?" })).toBe("#NOME?");
    expect(pt({ error: "#VALUE!" })).toBe("#VALOR!");
    expect(pt({ error: "#CYCLE!" })).toBe("#REF!");
    expect(en(Number.POSITIVE_INFINITY)).toBe("#NUM!");
  });
});

describe("presets and kinds", () => {
  test("each preset's code in each locale", () => {
    expect(numberFormatCode("number", EN)).toBe("#,##0.00");
    expect(numberFormatCode("integer", PT)).toBe("#,##0");
    expect(numberFormatCode("percent", EN)).toBe("0%");
    expect(numberFormatCode("percent2", EN)).toBe("0.00%");
    expect(numberFormatCode("currency", PT)).toBe('"R$" #,##0.00');
    expect(numberFormatCode("currency", EN)).toBe("$#,##0.00");
    expect(numberFormatCode("date", PT)).toBe("dd/mm/yyyy");
    expect(numberFormatCode("date", EN)).toBe("m/d/yyyy");
    expect(numberFormatCode("time", EN)).toBe("hh:mm");
    expect(numberFormatCode("text", EN)).toBe("@");
    expect(numberFormatCode("scientific", EN)).toBe("0.00E+00");
    expect(NUMBER_FORMATS.datetime(PT)).toBe("dd/mm/yyyy hh:mm");
    expect(NUMBER_FORMATS.general(EN)).toBe("General");
    expect(currencyFormat("€", sheetLocale("de-DE"))).toBe('#,##0.00 "€"');
    expect(currencyFormat("¥", sheetLocale("ja-JP"), 0)).toBe('"¥" #,##0');
  });

  test("the presets show what their names say", () => {
    expect(pt(1234.5, numberFormatCode("currency", PT))).toBe("R$ 1.234,50");
    expect(en(1234.5, numberFormatCode("currency", EN))).toBe("$1,234.50");
    expect(pt(NOV_17, numberFormatCode("date", PT))).toBe("17/11/2026");
    expect(en(NOV_17, numberFormatCode("date", EN))).toBe("11/17/2026");
    expect(pt(1234.5, numberFormatCode("number", PT))).toBe("1.234,50");
    expect(formatValue(1234.5, numberFormatCode("currency", sheetLocale("de-DE")), sheetLocale("de-DE")).text).toBe(
      "1.234,50 €",
    );
  });

  test("which preset a code is", () => {
    expect(numberFormatPreset(undefined, PT)).toBe("general");
    expect(numberFormatPreset('"R$" #,##0.00', PT)).toBe("currency");
    expect(numberFormatPreset("0.00%", EN)).toBe("percent2");
    expect(numberFormatPreset("0.000", EN)).toBeNull();
    expect(isNumberFormatPreset("currency")).toBe(true);
    expect(isNumberFormatPreset("toString")).toBe(false);
  });

  test("what kind of value a code shows", () => {
    expect(formatKind(undefined)).toBe("general");
    expect(formatKind("0%")).toBe("percent");
    expect(formatKind('"R$" #,##0.00')).toBe("currency");
    expect(formatKind("[$€-407] #,##0.00")).toBe("currency");
    expect(formatKind("0.00E+00")).toBe("scientific");
    expect(formatKind("# ?/?")).toBe("fraction");
    expect(formatKind("@")).toBe("text");
    expect(formatKind("hh:mm")).toBe("time");
    expect(formatKind("[h]:mm")).toBe("time");
    expect(formatKind("dd/mm/yyyy")).toBe("date");
    expect(formatKind("dd/mm/yyyy hh:mm")).toBe("datetime");
    expect(formatKind("#,##0.00")).toBe("number");
    expect(isDateFormat("m/d/yyyy")).toBe(true);
    expect(isDateFormat("0.00")).toBe(false);
  });

  test("more and fewer decimals", () => {
    expect(changeDecimals("#,##0", 1)).toBe("#,##0.0");
    expect(changeDecimals("#,##0.0", 1)).toBe("#,##0.00");
    expect(changeDecimals("0.00%", -1)).toBe("0.0%");
    expect(changeDecimals("0.0", -1)).toBe("0");
    expect(changeDecimals("0.00E+00", 1)).toBe("0.000E+00");
    expect(changeDecimals("#,##0.00;[Red]-#,##0.00", 1)).toBe("#,##0.000;[Red]-#,##0.000");
    expect(changeDecimals(undefined, 1, 1234.5)).toBe("0.00");
    expect(changeDecimals(undefined, -1, 1234.56)).toBe("0.0");
    expect(changeDecimals(undefined, -1, 12)).toBeUndefined();
    expect(changeDecimals("dd/mm/yyyy", 1)).toBe("dd/mm/yyyy");
  });
});
