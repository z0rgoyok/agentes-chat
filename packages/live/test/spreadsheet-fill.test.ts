import { describe, expect, test } from "bun:test";
import { LOCAL } from "../src/origins";
import { dateSerial, timeSerial } from "../src/spreadsheet/dates";
import { getCell, SheetError, sheetSize } from "../src/spreadsheet/doc";
import { fillRange } from "../src/spreadsheet/fill";
import { addSheet, formatRange, setValues } from "../src/spreadsheet/ops";
import { cells, EN, range, sheetDoc, storedValues } from "./spreadsheet-fixtures";

function filled(values: (string | number | boolean | null)[], to: string, nf?: string): string[] {
  const { doc, sheet } = sheetDoc();
  setValues(
    doc,
    { sheet, row: 0, col: 0 },
    values.map((v) => [v]),
    EN,
    LOCAL,
  );
  if (nf) formatRange(doc, range(sheet, `A1:A${values.length}`), { nf }, LOCAL);
  fillRange(doc, range(sheet, `A1:A${values.length}`), range(sheet, to), storedValues(doc), LOCAL);
  return cells(doc, sheet, to).map((row) => row[0] ?? "");
}

describe("series", () => {
  test("numbers continue their trend; one number repeats", () => {
    expect(filled([1, 2], "A1:A6")).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(filled([10, 7.5], "A1:A4")).toEqual(["10", "7.5", "5", "2.5"]);
    expect(filled([0.1, 0.2], "A1:A4")).toEqual(["0.1", "0.2", "0.3", "0.4"]);
    expect(filled([1, 2, 4], "A1:A5")).toEqual(["1", "2", "4", "5.33333333333333", "6.83333333333333"]);
    expect(filled([5], "A1:A3")).toEqual(["5", "5", "5"]);
  });

  test("a date steps a day, a time an hour, dates a month apart keep stepping by months", () => {
    const nov17 = dateSerial(2026, 11, 17);
    expect(filled([nov17], "A1:A3", "dd/mm/yyyy")).toEqual([String(nov17), String(nov17 + 1), String(nov17 + 2)]);
    const nine = timeSerial(9, 0, 0);
    const shown = filled([nine], "A1:A3", "hh:mm").map(Number);
    expect(shown[1]).toBeCloseTo(timeSerial(10, 0, 0), 12);
    expect(shown[2]).toBeCloseTo(timeSerial(11, 0, 0), 12);
    const jan15 = dateSerial(2026, 1, 15);
    const feb15 = dateSerial(2026, 2, 15);
    expect(filled([jan15, feb15], "A1:A4", "dd/mm/yyyy")).toEqual(
      [jan15, feb15, dateSerial(2026, 3, 15), dateSerial(2026, 4, 15)].map(String),
    );
    const jan31 = dateSerial(2026, 1, 31);
    const feb28 = dateSerial(2026, 2, 28);
    expect(filled([jan31, feb28], "A1:A4", "dd/mm/yyyy")).toEqual(
      [jan31, feb28, dateSerial(2026, 3, 31), dateSerial(2026, 4, 30)].map(String),
    );
    const y2026 = dateSerial(2026, 6, 1);
    const y2027 = dateSerial(2027, 6, 1);
    expect(filled([y2026, y2027], "A1:A3", "yyyy-mm-dd")[2]).toBe(String(dateSerial(2028, 6, 1)));
    expect(filled([nov17, nov17 + 7], "A1:A3", "dd/mm/yyyy")[2]).toBe(String(nov17 + 14));
  });

  test("text with a number counts on", () => {
    expect(filled(["Item 1"], "A1:A3")).toEqual(["Item 1", "Item 2", "Item 3"]);
    expect(filled(["Item 1", "Item 3"], "A1:A4")).toEqual(["Item 1", "Item 3", "Item 5", "Item 7"]);
    expect(filled(["Lote 007"], "A1:A3")).toEqual(["Lote 007", "Lote 008", "Lote 009"]);
    expect(filled(["Q1 2026"], "A1:A2")).toEqual(["Q1 2026", "Q1 2027"]);
    expect(filled(["1st"], "A1:A5")).toEqual(["1st", "2nd", "3rd", "4th", "5th"]);
    expect(filled(["11th"], "A1:A3")).toEqual(["11th", "12th", "13th"]);
    expect(filled(["2 apples"], "A1:A2")).toEqual(["2 apples", "3 apples"]);
    expect(filled(["Item 1", "Total"], "A1:A6")).toEqual(["Item 1", "Total", "Item 2", "Total", "Item 3", "Total"]);
  });

  test("month and weekday names go round, in English and Portuguese, keeping their case", () => {
    expect(filled(["Jan"], "A1:A3")).toEqual(["Jan", "Feb", "Mar"]);
    expect(filled(["jan", "mar"], "A1:A4")).toEqual(["jan", "mar", "mai", "jul"]);
    expect(filled(["dezembro"], "A1:A3")).toEqual(["dezembro", "janeiro", "fevereiro"]);
    expect(filled(["MONDAY"], "A1:A3")).toEqual(["MONDAY", "TUESDAY", "WEDNESDAY"]);
    expect(filled(["segunda"], "A1:A3")).toEqual(["segunda", "terça", "quarta"]);
    expect(filled(["Sábado"], "A1:A2")).toEqual(["Sábado", "Domingo"]);
  });

  test("anything else repeats", () => {
    expect(filled(["a", "b"], "A1:A5")).toEqual(["a", "b", "a", "b", "a"]);
    expect(filled([true], "A1:A2")).toEqual(["true", "true"]);
    expect(filled([1, "x"], "A1:A4")).toEqual(["1", "x", "1", "x"]);
  });

  test("filling up continues backwards", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 4, col: 0 }, [[10], [20]], EN, LOCAL);
    fillRange(doc, range(sheet, "A5:A6"), range(sheet, "A3:A6"), storedValues(doc), LOCAL);
    expect(cells(doc, sheet, "A3:A6").map((r) => r[0])).toEqual(["-10", "0", "10", "20"]);
  });
});

describe("shapes of a fill", () => {
  test("across, with formats", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[1, 2]], EN, LOCAL);
    formatRange(doc, range(sheet, "A1:B1"), { b: 1 }, LOCAL);
    fillRange(doc, range(sheet, "A1:B1"), range(sheet, "A1:E1"), storedValues(doc), LOCAL);
    expect(cells(doc, sheet, "A1:E1")).toEqual([["1", "2", "3", "4", "5"]]);
    expect(getCell(doc, sheet, 0, 4)).toEqual({ v: 5, s: { b: 1 } });
  });

  test("a range next to the source fills like one that contains it", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[1], [2]], EN, LOCAL);
    fillRange(doc, range(sheet, "A1:A2"), range(sheet, "A3:A4"), storedValues(doc), LOCAL);
    expect(cells(doc, sheet, "A1:A4").map((r) => r[0])).toEqual(["1", "2", "3", "4"]);
  });

  test("formulas move as copies do", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[1, "=A1*2+$C$1"]], EN, LOCAL);
    fillRange(doc, range(sheet, "B1"), range(sheet, "B1:B3"), storedValues(doc), LOCAL);
    expect(cells(doc, sheet, "B1:B3").map((r) => r[0])).toEqual(["=A1*2+$C$1", "=A2*2+$C$1", "=A3*2+$C$1"]);
    fillRange(doc, range(sheet, "B1"), range(sheet, "B1:C1"), storedValues(doc), LOCAL);
    expect(cells(doc, sheet, "C1")[0]?.[0]).toBe("=B1*2+$C$1");
  });

  test("any other shape repeats the source over it", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 1, col: 1 }, [["x", "=B2"]], EN, LOCAL);
    fillRange(doc, range(sheet, "B2:C2"), range(sheet, "A1:C3"), storedValues(doc), LOCAL);
    expect(cells(doc, sheet, "A1:C3")).toEqual([
      ["=#REF!", "x", "=B1"],
      ["=#REF!", "x", "=B2"],
      ["=#REF!", "x", "=B3"],
    ]);
  });

  test("the sheet grows to the fill; another sheet is refused", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 98, col: 0 }, [[1], [2]], EN, LOCAL);
    fillRange(doc, range(sheet, "A99:A100"), range(sheet, "A99:A105"), storedValues(doc), LOCAL);
    expect(sheetSize(doc, sheet).rows).toBe(105);
    expect(cells(doc, sheet, "A105")[0]?.[0]).toBe("7");
    const other = addSheet(doc, "Other", LOCAL);
    let error: unknown;
    try {
      fillRange(doc, range(sheet, "A1"), range(other, "A1:A3"), storedValues(doc), LOCAL);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SheetError);
  });
});
