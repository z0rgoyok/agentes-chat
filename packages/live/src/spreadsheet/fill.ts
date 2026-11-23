/**
 * The fill handle (ADR 0196 §2): dragging a selection extends it the way Excel does. Two or more numbers continue
 * their trend (1, 2 → 3, 4, 5), a date steps a day (a time of day an hour), dates a month apart keep stepping by
 * months, text ending or starting with a number counts on ("Item 1" → "Item 2", "1st" → "2nd"), month and weekday
 * names go round ("jan" → "fev", "Mon" → "Tue"), and anything else repeats, formulas moving as copies do
 * (`=A1*2` filled down reads `=A2*2`). Formats repeat with the cells they came from.
 */
import type * as Y from "yjs";
import type { LiveOrigin } from "../origins";
import { addMonths, dateSerial, daysInMonth, serialDate } from "./dates";
import {
  type CellData,
  cellKey,
  colIds,
  readCell,
  rowIds,
  SheetError,
  type SheetValues,
  sheetMap,
  sheetParts,
} from "./doc";
import { formatKind, isDateFormat } from "./format";
import { shiftFormula } from "./formula";
import { ENGLISH_NAMES, localeNames } from "./locale";
import { checkCellRoom, checkSize, growTo, normalizeRange, type RangeIds, writeCell } from "./write";

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Floating noise out of a computed step (0.1 + 0.2 → 0.3), as Excel's 15 digits do. */
function tidy(x: number): number {
  return Number(x.toPrecision(15));
}

type Series =
  | { kind: "copy" }
  | { kind: "linear"; a: number; b: number }
  | { kind: "months"; first: number; step: number; monthEnd: boolean }
  | { kind: "text"; seeds: (TextSeed | null)[]; step: number | null }
  | { kind: "names"; list: readonly string[]; first: number; step: number; style: Case };

const COPY: Series = { kind: "copy" };

interface TextSeed {
  prefix: string;
  num: number;
  width: number;
  suffix: string;
}

const TRAILING = /^([\s\S]*?)(\d{1,15})$/;
const LEADING = /^(\d{1,15})(\D*)$/;

function textSeed(text: string): TextSeed | null {
  let m = TRAILING.exec(text);
  if (m) return { prefix: m[1] ?? "", num: Number(m[2]), width: (m[2] ?? "").length, suffix: "" };
  m = LEADING.exec(text);
  if (m) return { prefix: "", num: Number(m[1]), width: (m[1] ?? "").length, suffix: m[2] ?? "" };
  return null;
}

const ORDINAL = /^(st|nd|rd|th)$/i;

function ordinalSuffix(n: number, like: string): string {
  const tens = n % 100;
  const ones = n % 10;
  const plain = tens >= 11 && tens <= 13 ? "th" : ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th";
  return like === like.toUpperCase() ? plain.toUpperCase() : plain;
}

function seedText(seed: TextSeed, num: number): string {
  const n = Math.abs(num);
  const digits = String(n).padStart(seed.width, "0");
  const suffix = ORDINAL.test(seed.suffix) && seed.prefix === "" ? ordinalSuffix(n, seed.suffix) : seed.suffix;
  return `${seed.prefix}${digits}${suffix}`;
}

type Case = "upper" | "title" | "lower";

function caseOf(text: string): Case {
  if (text === text.toUpperCase() && text !== text.toLowerCase()) return "upper";
  const first = text.charAt(0);
  return first !== first.toLowerCase() ? "title" : "lower";
}

function inCase(text: string, style: Case): string {
  if (style === "upper") return text.toUpperCase();
  if (style === "lower") return text.toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[áàâãä]/g, "a")
    .replace(/[éèêë]/g, "e")
    .replace(/[íìîï]/g, "i")
    .replace(/[óòôõö]/g, "o")
    .replace(/[úùûü]/g, "u")
    .replace(/ç/g, "c")
    .replace(/\.$/, "");
}

const PT = localeNames({ tag: "pt-BR" });
/** Weekdays as people also write them in Portuguese, without "-feira". */
const PT_DAYS_SHORT_WORDS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** Lists that go round, in the languages people type them: English and Portuguese months and weekdays. */
const NAME_LISTS: readonly (readonly string[])[] = [
  ENGLISH_NAMES.months,
  ENGLISH_NAMES.monthsShort,
  PT.months,
  PT.monthsShort,
  ENGLISH_NAMES.days,
  ENGLISH_NAMES.daysShort,
  PT.days,
  PT.daysShort,
  PT_DAYS_SHORT_WORDS,
];

/**
 * Names that go round. Lists written exactly as typed win ("jan" is Portuguese, "Jan" English), then any list ignoring
 * case and accents ("JAN", "marco").
 */
function nameSeries(values: readonly string[]): Series | null {
  const typed = values.map((v) => v.trim());
  for (const exact of [true, false]) {
    for (const list of NAME_LISTS) {
      const names = exact ? list : list.map(fold);
      const indexes = typed.map((v) => names.indexOf(exact ? v : fold(v)));
      if (indexes.some((i) => i < 0)) continue;
      const first = indexes[0] as number;
      let step = 1;
      if (indexes.length > 1) {
        step = mod((indexes[1] as number) - first, list.length);
        for (let i = 2; i < indexes.length; i++) {
          if (mod((indexes[i] as number) - (indexes[i - 1] as number), list.length) !== step) return null;
        }
        if (step === 0) return null;
      }
      return { kind: "names", list, first, step, style: caseOf(typed[0] ?? "") };
    }
  }
  return null;
}

function textSeries(values: readonly string[]): Series | null {
  const seeds = values.map(textSeed);
  if (seeds.every((s) => s === null)) return null;
  const first = seeds[0];
  // One pattern ("Item 1", "Item 3"): the numbers keep their step. Otherwise each cell counts on by itself.
  if (
    first &&
    seeds.length > 1 &&
    seeds.every((s) => s !== null && s.prefix === first.prefix && s.suffix === first.suffix)
  ) {
    const nums = seeds.map((s) => (s as TextSeed).num);
    const step = (nums[1] as number) - (nums[0] as number);
    if (nums.every((n, i) => i === 0 || n - (nums[i - 1] as number) === step) && step !== 0) {
      return { kind: "text", seeds, step };
    }
  }
  return { kind: "text", seeds, step: null };
}

function isMonthEnd(serial: number): boolean {
  const d = serialDate(serial);
  return d.day === daysInMonth(d.year, d.month);
}

/** Months between consecutive dates when they keep the same day (or all fall on a month's end); null otherwise. */
function monthStep(serials: readonly number[]): { step: number; monthEnd: boolean } | null {
  const dates = serials.map((s) => serialDate(s));
  const time = (s: number) => s - Math.floor(s);
  const monthEnd = serials.every(isMonthEnd);
  let step: number | null = null;
  for (let i = 1; i < dates.length; i++) {
    const a = dates[i - 1] as ReturnType<typeof serialDate>;
    const b = dates[i] as ReturnType<typeof serialDate>;
    if (!monthEnd && a.day !== b.day) return null;
    if (time(serials[i] as number) !== time(serials[i - 1] as number)) return null;
    const diff = b.year * 12 + b.month - (a.year * 12 + a.month);
    if (diff === 0 || (step !== null && diff !== step)) return null;
    step = diff;
  }
  return step === null ? null : { step, monthEnd };
}

/** The least-squares line through the values at 0, 1, 2…: exact steps for evenly spaced ones. */
function linearFit(nums: readonly number[]): Series {
  const n = nums.length;
  const meanX = (n - 1) / 2;
  const meanY = nums.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  nums.forEach((y, x) => {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  });
  const b = den === 0 ? 0 : num / den;
  return { kind: "linear", a: meanY - b * meanX, b };
}

/** How a line of source cells (a column filled down, a row filled across) goes on. */
function seriesOf(line: readonly (CellData | undefined)[]): Series {
  if (line.length === 0 || line.some((c) => !c || c.f !== undefined || c.v === undefined)) return COPY;
  const values = line.map((c) => (c as CellData).v);
  if (values.every((v) => typeof v === "number")) {
    const nums = values as number[];
    const dates = line.every((c) => isDateFormat(c?.s?.nf));
    if (nums.length === 1) {
      if (!dates) return COPY;
      return { kind: "linear", a: nums[0] as number, b: formatKind(line[0]?.s?.nf) === "time" ? 1 / 24 : 1 };
    }
    if (dates) {
      const months = monthStep(nums);
      if (months) return { kind: "months", first: nums[0] as number, ...months };
    }
    return linearFit(nums);
  }
  if (values.every((v) => typeof v === "string")) {
    const strings = values as string[];
    return nameSeries(strings) ?? textSeries(strings) ?? COPY;
  }
  return COPY;
}

function endOfMonthAdd(serial: number, months: number): number {
  const d = serialDate(serial);
  const index = d.year * 12 + (d.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return dateSerial(year, month, daysInMonth(year, month)) + (serial - Math.floor(serial));
}

/**
 * The cell at offset `k` along a line (0 is the line's first source cell; negative before it), and how far the
 * source it repeats lies from it (for moving formulas).
 */
function cellOf(
  series: Series,
  line: readonly (CellData | undefined)[],
  k: number,
): { cell: CellData | undefined; offset: number } {
  const n = line.length;
  const j = mod(k, n);
  const seed = line[j];
  const offset = k - j;
  const withValue = (v: CellData["v"]): CellData => (seed?.s ? { v, s: seed.s } : { v });
  switch (series.kind) {
    case "copy":
      return { cell: seed, offset };
    case "linear":
      return { cell: withValue(tidy(series.a + series.b * k)), offset };
    case "months":
      return {
        cell: withValue(
          series.monthEnd ? endOfMonthAdd(series.first, series.step * k) : addMonths(series.first, series.step * k),
        ),
        offset,
      };
    case "names": {
      const name = series.list[mod(series.first + series.step * k, series.list.length)] ?? "";
      return { cell: withValue(inCase(name, series.style)), offset };
    }
    case "text": {
      if (series.step !== null) {
        const first = series.seeds[0] as TextSeed;
        return { cell: withValue(seedText(first, first.num + series.step * k)), offset };
      }
      const own = series.seeds[j];
      if (!own) return { cell: seed, offset };
      return { cell: withValue(seedText(own, own.num + offset / n)), offset };
    }
  }
}

/**
 * Fills `to` from `from`, as dragging the fill handle does: `to` is the whole range dragged over (it may contain
 * `from`, or lie next to it). A range with `from`'s columns fills down or up, one with its rows fills across, and any
 * other shape repeats `from` over it (Ctrl+Enter's way). Only cells outside `from` change. The sheet grows to fit.
 */
export function fillRange(
  doc: Y.Doc,
  from: RangeIds,
  to: RangeIds,
  _values: SheetValues | null,
  origin: LiveOrigin,
): void {
  const src = normalizeRange(from);
  const dst = normalizeRange(to);
  if (src.sheet !== dst.sheet) throw new SheetError("range", "Fill within one sheet");
  if (!sheetMap(doc, src.sheet)) throw new SheetError("no_sheet", `There is no sheet ${src.sheet}`);
  const rows = rowIds(doc, src.sheet);
  const cols = colIds(doc, src.sheet);
  if (src.r2 >= rows.length || src.c2 >= cols.length) throw new SheetError("range", "Fill from cells on the sheet");
  checkSize(Math.max(rows.length, dst.r2 + 1), Math.max(cols.length, dst.c2 + 1));
  const sameCols = dst.c1 === src.c1 && dst.c2 === src.c2;
  const sameRows = dst.r1 === src.r1 && dst.r2 === src.r2;
  if (sameCols && sameRows) return;
  const cellsMap = sheetMap(doc, src.sheet)?.get("cells");
  const read = (r: number, c: number): CellData | undefined => {
    const row = rows[r];
    const col = cols[c];
    if (row === undefined || col === undefined || !cellsMap || typeof cellsMap !== "object") return undefined;
    return readCell((cellsMap as Y.Map<unknown>).get(cellKey(row, col)));
  };
  const inside = (r: number, c: number) => r >= src.r1 && r <= src.r2 && c >= src.c1 && c <= src.c2;
  // Formulas move once the sheet has grown, so references below its old end land on rows that exist.
  const writes: { r: number; c: number; cell: CellData | undefined; dr: number; dc: number }[] = [];
  if (sameCols) {
    for (let c = src.c1; c <= src.c2; c++) {
      const line: (CellData | undefined)[] = [];
      for (let r = src.r1; r <= src.r2; r++) line.push(read(r, c));
      const series = seriesOf(line);
      for (let r = dst.r1; r <= dst.r2; r++) {
        if (inside(r, c)) continue;
        const { cell, offset } = cellOf(series, line, r - src.r1);
        writes.push({ r, c, cell, dr: offset, dc: 0 });
      }
    }
  } else if (sameRows) {
    for (let r = src.r1; r <= src.r2; r++) {
      const line: (CellData | undefined)[] = [];
      for (let c = src.c1; c <= src.c2; c++) line.push(read(r, c));
      const series = seriesOf(line);
      for (let c = dst.c1; c <= dst.c2; c++) {
        if (inside(r, c)) continue;
        const { cell, offset } = cellOf(series, line, c - src.c1);
        writes.push({ r, c, cell, dr: 0, dc: offset });
      }
    }
  } else {
    const h = src.r2 - src.r1 + 1;
    const w = src.c2 - src.c1 + 1;
    for (let r = dst.r1; r <= dst.r2; r++) {
      for (let c = dst.c1; c <= dst.c2; c++) {
        if (inside(r, c)) continue;
        const sr = src.r1 + mod(r - src.r1, h);
        const sc = src.c1 + mod(c - src.c1, w);
        writes.push({ r, c, cell: read(sr, sc), dr: r - sr, dc: c - sc });
      }
    }
  }
  let added = 0;
  for (const w of writes) if (w.cell && !read(w.r, w.c)) added++;
  checkCellRoom(doc, added);
  doc.transact(() => {
    const parts = sheetParts(doc, src.sheet);
    growTo(parts, Math.max(parts.rows.length, dst.r2 + 1), Math.max(parts.cols.length, dst.c2 + 1));
    const ctx = { doc, sheetId: src.sheet };
    for (const w of writes) {
      const cell =
        w.cell?.f && (w.dr !== 0 || w.dc !== 0) ? { ...w.cell, f: shiftFormula(w.cell.f, w.dr, w.dc, ctx) } : w.cell;
      writeCell(parts.cells, cellKey(parts.rows.get(w.r), parts.cols.get(w.c)), cell);
    }
  }, origin);
}
