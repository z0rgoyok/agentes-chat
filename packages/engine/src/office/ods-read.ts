import {
  type CellStyle,
  type ErrorCode,
  isErrorCode,
  MAX_A1_COLS,
  MAX_A1_ROWS,
  type SheetData,
  type WorkbookData,
} from "@agenteschat/live";
import { stripFunctionPrefixes } from "./formulas";
import { isOfficeError, OFFICE_LIMITS, officeEncrypted, officeTooLarge, officeUnreadable } from "./limits";
import { OfficePackage } from "./package";
import { sheetPrefix } from "./xls-formula";
import { isoSerial, ptToPx } from "./xlsx-read";
import { type SaxAttrs, sax } from "./xml";

/**
 * OpenDocument spreadsheets (`.ods`) read into `WorkbookData` (ADR 0198) by the server's own zip reader and XML
 * scanner, as `.xlsx` is: every visible sheet with its values (numbers, percentages, currencies, dates, times,
 * booleans, text, errors), formulas (OpenFormula written back in A1: `[.A1]` references, `;` separators), styles
 * (fonts, fills, borders, alignment, wrapping, number formats from the file's data styles), merged cells, column
 * widths, row heights, frozen panes and tab colors. Repeats (`number-rows-repeated`, `number-columns-repeated`) are
 * counted against the cell limit before a single cell is made, and a sheet's long styled tail is kept only where its
 * cells are: a few bytes can't ask for a million rows.
 */

/** Each OpenDocument namespace by the prefix this reader uses for it, whatever prefix the file chose. */
const NAMESPACES: Readonly<Record<string, string>> = {
  "urn:oasis:names:tc:opendocument:xmlns:office:1.0": "office",
  "urn:oasis:names:tc:opendocument:xmlns:table:1.0": "table",
  "urn:oasis:names:tc:opendocument:xmlns:text:1.0": "text",
  "urn:oasis:names:tc:opendocument:xmlns:style:1.0": "style",
  "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0": "fo",
  "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0": "number",
  "urn:oasis:names:tc:opendocument:xmlns:config:1.0": "config",
  "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0": "draw",
  "urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0": "calcext",
};

interface Handler {
  open(name: string, attrs: SaxAttrs, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
}

/** Walks a part with names under this reader's prefixes (the root's namespace declarations say which is which). */
function scan(text: string, part: string, handler: Handler) {
  let prefixes: Map<string, string> | null = null;
  // Files written with the usual prefixes (nearly all) are passed through as they are.
  let usual = true;
  const canonical = (qname: string) => {
    const colon = qname.indexOf(":");
    if (colon < 0 || !prefixes) return qname;
    const mapped = prefixes.get(qname.slice(0, colon));
    return mapped ? `${mapped}${qname.slice(colon)}` : qname;
  };
  sax(
    text,
    {
      open(name, attrs, selfClosing) {
        if (!prefixes) {
          prefixes = new Map();
          for (const [key, value] of Object.entries(attrs)) {
            const ns = key.startsWith("xmlns:") ? NAMESPACES[value] : undefined;
            if (!ns) continue;
            prefixes.set(key.slice(6), ns);
            if (key.slice(6) !== ns) usual = false;
          }
        }
        if (usual) return handler.open(name, attrs, selfClosing);
        const named: SaxAttrs = {};
        for (const [key, value] of Object.entries(attrs)) named[canonical(key)] = value;
        handler.open(canonical(name), named, selfClosing);
      },
      close: handler.close ? (name) => handler.close?.(usual ? name : canonical(name)) : undefined,
      text: handler.text,
    },
    part,
    { qualified: true },
  );
}

/** `content.xml` up to its body: its automatic styles, which come first, without the cells after them. */
function beforeBody(text: string): string {
  const at = text.search(/<[\w-]+:body[\s>]/);
  return at >= 0 ? text.slice(0, at) : text;
}

// ── Styles ───────────────────────────────────────────────────────────────────

interface RawStyle {
  family: string;
  parent: string | null;
  /** The attributes of the style and its property elements, merged (`fo:color`, `style:data-style-name`, …). */
  props: Record<string, string>;
}

interface DataStyle {
  /** The format code of this section, as Excel writes it. */
  code: string;
  /** `[Red]` and the like, from the section's text color. */
  color: string | null;
  maps: { condition: string; apply: string }[];
  /** Whether the format is plain General (one number with no decimals given). */
  general: boolean;
}

/** An Excel literal: kept bare when it is punctuation Excel shows as it is, quoted otherwise. */
const literal = (text: string) => (text === "%" || /^[ $\-+/():]*$/.test(text) ? text : `"${text.replace(/"/g, "")}"`);

const int = (v: string | undefined) => {
  const n = v === undefined ? Number.NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/** A workbook's cell, column, row and table styles and its data styles (number formats). */
class Styles {
  readonly raw = new Map<string, RawStyle>();
  readonly data = new Map<string, DataStyle>();
  private readonly made = new Map<string, CellStyle | undefined>();
  private base: { size: number; color: string } | null = null;

  /** Reads the styles of a part (`styles.xml`, then `content.xml`'s automatic styles). */
  read(text: string, part: string, onBody?: () => void) {
    let style: RawStyle | null = null;
    let styleName = "";
    let dataStyle: DataStyle | null = null;
    let dataName = "";
    let dataKind = "";
    let elapsed = false;
    let firstHours = true;
    let reading: "text" | "currency" | null = null;
    let literalText = "";
    let done = false;
    scan(text, part, {
      open: (name, a) => {
        if (done) return;
        if (name === "office:body") {
          // Automatic styles come before the body: nothing after it is a style.
          done = true;
          onBody?.();
          return;
        }
        if (name === "style:style" || name === "style:default-style") {
          const family = a["style:family"] ?? "";
          styleName = name === "style:default-style" ? `default:${family}` : (a["style:name"] ?? "");
          const props: Record<string, string> = {};
          if (a["style:data-style-name"]) props["style:data-style-name"] = a["style:data-style-name"];
          style = { family, parent: a["style:parent-style-name"] ?? null, props };
          return;
        }
        if (style && name.startsWith("style:") && name.endsWith("-properties")) {
          Object.assign(style.props, a);
          return;
        }
        if (name.startsWith("number:") && name.endsWith("-style") && a["style:name"]) {
          dataName = a["style:name"];
          dataKind = name;
          dataStyle = { code: "", color: null, maps: [], general: false };
          elapsed = a["number:truncate-on-overflow"] === "false";
          firstHours = true;
          return;
        }
        if (!dataStyle) return;
        const long = a["number:style"] === "long";
        switch (name) {
          case "number:number": {
            const decimals = int(a["number:decimal-places"]);
            const minDecimals = int(a["number:min-decimal-places"]) ?? decimals ?? 0;
            const minInt = int(a["number:min-integer-digits"]) ?? 0;
            const grouping = a["number:grouping"] === "true";
            let code = grouping
              ? `#,##${minInt >= 1 ? "0".repeat(Math.max(1, minInt)) : "#"}`
              : minInt >= 1
                ? "0".repeat(minInt)
                : "#";
            if (decimals !== null && decimals > 0) {
              const zeros = Math.min(minDecimals, decimals);
              code += `.${"0".repeat(zeros)}${"#".repeat(decimals - zeros)}`;
            }
            if (decimals === null && !grouping && dataStyle.code === "") dataStyle.general = true;
            dataStyle.code += code;
            break;
          }
          case "number:scientific-number": {
            const decimals = int(a["number:decimal-places"]) ?? 0;
            const exp = int(a["number:min-exponent-digits"]) ?? 2;
            dataStyle.code += `0${decimals > 0 ? `.${"0".repeat(decimals)}` : ""}E+${"0".repeat(Math.max(1, exp))}`;
            break;
          }
          case "number:fraction": {
            const whole = (int(a["number:min-integer-digits"]) ?? 0) > 0 ? "# " : "";
            const num = "?".repeat(Math.max(1, int(a["number:min-numerator-digits"]) ?? 1));
            const value = int(a["number:denominator-value"]);
            const den = value ? String(value) : "?".repeat(Math.max(1, int(a["number:min-denominator-digits"]) ?? 1));
            dataStyle.code += `${whole}${num}/${den}`;
            break;
          }
          case "number:day":
            dataStyle.code += long ? "dd" : "d";
            break;
          case "number:month":
            dataStyle.code += a["number:textual"] === "true" ? (long ? "mmmm" : "mmm") : long ? "mm" : "m";
            break;
          case "number:year":
            dataStyle.code += long ? "yyyy" : "yy";
            break;
          case "number:day-of-week":
            dataStyle.code += long ? "dddd" : "ddd";
            break;
          case "number:hours": {
            const h = long ? "hh" : "h";
            dataStyle.code += elapsed && firstHours ? `[${h}]` : h;
            firstHours = false;
            break;
          }
          case "number:minutes":
            dataStyle.code += long ? "mm" : "m";
            break;
          case "number:seconds": {
            const decimals = int(a["number:decimal-places"]) ?? 0;
            dataStyle.code += `${long ? "ss" : "s"}${decimals > 0 ? `.${"0".repeat(decimals)}` : ""}`;
            break;
          }
          case "number:am-pm":
            dataStyle.code += "AM/PM";
            break;
          case "number:text-content":
            dataStyle.code += "@";
            break;
          case "number:text":
            reading = "text";
            literalText = "";
            break;
          case "number:currency-symbol":
            reading = "currency";
            literalText = "";
            break;
          case "style:text-properties":
            if ((a["fo:color"] ?? "").toLowerCase() === "#ff0000") dataStyle.color = "[Red]";
            break;
          case "style:map":
            if (a["style:condition"] && a["style:apply-style-name"]) {
              dataStyle.maps.push({ condition: a["style:condition"], apply: a["style:apply-style-name"] });
            }
            break;
        }
      },
      close: (name) => {
        if (done) return;
        if ((name === "style:style" || name === "style:default-style") && style) {
          this.raw.set(styleName, style);
          style = null;
          return;
        }
        if (dataStyle && name === dataKind) {
          if (dataKind === "number:text-style" && !dataStyle.code.includes("@")) dataStyle.code += "@";
          if (dataKind === "number:boolean-style") dataStyle.general = true;
          this.data.set(dataName, dataStyle);
          dataStyle = null;
          return;
        }
        if (dataStyle && reading && (name === "number:text" || name === "number:currency-symbol")) {
          if (literalText !== "")
            dataStyle.code += reading === "currency" ? `"${literalText.replace(/"/g, "")}"` : literal(literalText);
          reading = null;
        }
      },
      text: (chunk) => {
        if (reading) literalText += chunk;
      },
    });
  }

  /** A style's properties with its parents' (and the family's default) under them. */
  private merged(name: string): Record<string, string> {
    const chain: RawStyle[] = [];
    const seen = new Set<string>();
    for (let n: string | null = name; n && !seen.has(n); ) {
      seen.add(n);
      const s = this.raw.get(n);
      if (!s) break;
      chain.unshift(s);
      n = s.parent;
    }
    const family = chain[0]?.family ?? "table-cell";
    return Object.assign({}, this.raw.get(`default:${family}`)?.props ?? {}, ...chain.map((s) => s.props));
  }

  /** A column's, row's or table's own properties (no inheritance to speak of). */
  props(name: string | undefined): Record<string, string> {
    return name ? this.merged(name) : {};
  }

  /** The number format a data style stands for, its conditional sections joined (`positive;negative`). */
  format(name: string | undefined): string | undefined {
    const own = name ? this.data.get(name) : undefined;
    if (!own) return undefined;
    const section = (d: DataStyle) => `${d.color ?? ""}${d.code}`;
    const positive = own.maps.find((m) => m.condition.replace(/\s/g, "") === "value()>=0");
    if (positive) {
      const p = this.data.get(positive.apply);
      if (p) return `${section(p)};${section(own)}`;
    }
    const above = own.maps.find((m) => m.condition.replace(/\s/g, "") === "value()>0");
    const below = own.maps.find((m) => m.condition.replace(/\s/g, "") === "value()<0");
    const a = above ? this.data.get(above.apply) : undefined;
    const b = below ? this.data.get(below.apply) : undefined;
    if (a && b) return `${section(a)};${section(b)};${section(own)}`;
    if (own.general || own.code === "") return undefined;
    return section(own);
  }

  private baseFont(): { size: number; color: string } {
    if (!this.base) {
      const p = this.merged(this.raw.has("Default") ? "Default" : "default:table-cell");
      this.base = { size: points(p["fo:font-size"]) ?? 10, color: hex(p["fo:color"]) ?? "#000000" };
    }
    return this.base;
  }

  /** A cell style by name, or undefined when it looks like the workbook's default. */
  cell(name: string | undefined): CellStyle | undefined {
    const key = name ?? "Default";
    if (this.made.has(key)) return this.made.get(key);
    const style = this.build(key);
    this.made.set(key, style);
    return style;
  }

  private build(name: string): CellStyle | undefined {
    if (!this.raw.has(name)) return undefined;
    const p = this.merged(name);
    const base = this.baseFont();
    const s: CellStyle = {};
    const weight = p["fo:font-weight"];
    if (weight === "bold" || (int(weight) ?? 0) >= 600) s.b = 1;
    if (p["fo:font-style"] === "italic" || p["fo:font-style"] === "oblique") s.i = 1;
    if (p["style:text-underline-style"] && p["style:text-underline-style"] !== "none") s.u = 1;
    if (p["style:text-line-through-style"] && p["style:text-line-through-style"] !== "none") s.x = 1;
    const color = hex(p["fo:color"]);
    if (color && color !== base.color) s.fc = color;
    const size = points(p["fo:font-size"]);
    if (size !== null && size !== base.size && size > 0 && size <= 409) s.fs = size;
    const bg = hex(p["fo:background-color"]);
    if (bg) s.bg = bg;
    const border: NonNullable<CellStyle["bd"]> = {};
    (
      [
        ["t", "fo:border-top"],
        ["r", "fo:border-right"],
        ["b", "fo:border-bottom"],
        ["l", "fo:border-left"],
      ] as const
    ).forEach(([side, key]) => {
      const line = borderOf(p[key] ?? p["fo:border"]);
      if (line) border[side] = line;
    });
    if (Object.keys(border).length > 0) s.bd = border;
    const h = p["fo:text-align"];
    if (h === "start" || h === "left" || h === "justify") s.ha = "l";
    else if (h === "center") s.ha = "c";
    else if (h === "end" || h === "right") s.ha = "r";
    // Bottom is every cell's default: only the others are said.
    const v = p["style:vertical-align"];
    if (v === "top") s.va = "t";
    else if (v === "middle") s.va = "m";
    if (p["fo:wrap-option"] === "wrap") s.w = 1;
    const nf = this.format(p["style:data-style-name"]);
    if (nf) s.nf = nf.slice(0, 255);
    return Object.keys(s).length > 0 ? s : undefined;
  }
}

/** `#rrggbb`, or null (transparent, missing, anything else). */
function hex(value: string | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v && /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

/** A length in points ("10pt", "0.5cm", "0.2in", "3mm", "12px"), or null. */
function points(value: string | undefined): number | null {
  const m = /^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(pt|cm|mm|in|pc|px)?$/.exec(value?.trim() ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "pt";
  const pt =
    unit === "cm"
      ? (n * 72) / 2.54
      : unit === "mm"
        ? (n * 72) / 25.4
        : unit === "in"
          ? n * 72
          : unit === "pc"
            ? n * 12
            : unit === "px"
              ? n * 0.75
              : n;
  return Number.isFinite(pt) ? Math.round(pt * 100) / 100 : null;
}

/** A border (`0.74pt solid #000000`) as a side: heavy past 2.5 pt or double, medium past 1 pt. */
function borderOf(value: string | undefined): NonNullable<CellStyle["bd"]>["t"] | null {
  if (!value || value === "none") return null;
  const parts = value.trim().split(/\s+/);
  if (parts.includes("none") || parts.includes("hidden")) return null;
  const width = points(parts.find((p) => /\d/.test(p) && !p.startsWith("#")));
  if (width !== null && width <= 0) return null;
  const w = parts.includes("double") || (width ?? 0) > 2.5 ? 3 : (width ?? 0) > 1 ? 2 : 1;
  const c = hex(parts.find((p) => p.startsWith("#")));
  return c ? { w, c } : { w };
}

// ── Formulas ─────────────────────────────────────────────────────────────────

/** One end of an OpenFormula reference (`$Sheet1.$A$1`, `.A1`, `'My sheet'.B`), or null. */
function refPart(text: string): { sheet: string | null; at: string } | null {
  let i = 0;
  let sheet: string | null = null;
  if (text[i] === "$") i++;
  if (text[i] === "'") {
    let name = "";
    let j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === "'") {
        if (text[j + 1] === "'") {
          name += "'";
          j++;
          continue;
        }
        break;
      }
      name += text[j];
    }
    if (text[j] !== "'") return null;
    sheet = name;
    i = j + 1;
  } else {
    const dot = text.indexOf(".", i);
    if (dot < 0) return null;
    if (dot > i) sheet = text.slice(i, dot);
    i = dot;
  }
  if (text[i] !== ".") return null;
  const at = text.slice(i + 1);
  if (!/^(?:\$?[A-Za-z]{1,3}\$?\d{1,7}|\$?[A-Za-z]{1,3}|\$?\d{1,7})$/.test(at)) return null;
  return { sheet, at: at.toUpperCase() };
}

/** An OpenFormula reference's inside (`.A1:.B2`, `$Sheet2.A1`) in A1, or null for one this reader doesn't write. */
function a1Ref(inside: string): string | null {
  if (inside.includes("#REF!")) return "#REF!";
  // Another document's cells ('file:///…'#$Sheet1.A1) can't be reached from a live sheet.
  if (inside.includes("#")) return null;
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < inside.length; i++) {
    if (inside[i] === "'") quoted = !quoted;
    else if (inside[i] === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  const first = refPart(colon < 0 ? inside : inside.slice(0, colon));
  if (!first) return null;
  const prefix = first.sheet !== null ? sheetPrefix(first.sheet) : "";
  if (colon < 0) return `${prefix}${first.at}`;
  const second = refPart(inside.slice(colon + 1));
  if (!second || (second.sheet !== null && second.sheet !== first.sheet)) return null;
  return `${prefix}${first.at}:${second.at}`;
}

/**
 * An OpenDocument formula (`of:=SUM([.A1:.A3];2)`) in A1 without the "=", or null for what this reader doesn't
 * write (unions and intersections, other documents, LibreOffice's own functions): the cell keeps its value.
 */
export function odsFormula(raw: string): string | null {
  let s = raw.trim();
  // A file written by Excel may keep Excel's own syntax.
  if (s.startsWith("msoxl:=")) return s.slice(7).trim() ? stripFunctionPrefixes(s.slice(7).trim()) : null;
  if (s.startsWith("of:=")) s = s.slice(4);
  else if (s.startsWith("oooc:=")) s = s.slice(6);
  else if (s.startsWith("=")) s = s.slice(1);
  else return null;
  let out = "";
  let inArray = false;
  for (let i = 0; i < s.length; ) {
    const ch = s[i] as string;
    if (ch === '"') {
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') {
            j++;
            continue;
          }
          break;
        }
      }
      if (j >= s.length) return null;
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      let quoted = false;
      for (; j < s.length; j++) {
        if (s[j] === "'") quoted = !quoted;
        else if (s[j] === "]" && !quoted) break;
      }
      if (j >= s.length) return null;
      const ref = a1Ref(s.slice(i + 1, j));
      if (ref === null) return null;
      out += ref;
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[\w.]/.test(s[j] as string)) j++;
      let word = s.slice(i, j);
      if (/^(?:ORG\.OPENOFFICE|ORG\.LIBREOFFICE)\./i.test(word)) return null;
      word = word.replace(/^COM\.MICROSOFT\./i, "");
      // OpenFormula writes the logical constants as functions: TRUE() is TRUE.
      if (/^(?:TRUE|FALSE)$/i.test(word) && s.startsWith("()", j)) j += 2;
      out += word;
      i = j;
      continue;
    }
    if (ch === "{") inArray = true;
    else if (ch === "}") inArray = false;
    if (ch === ";") out += ",";
    else if (ch === "|" && inArray) out += ";";
    // A union (~) or an intersection (!) of references: not written.
    else if (ch === "~" || ch === "!") return null;
    else out += ch;
    i++;
  }
  out = out.trim();
  return out ? stripFunctionPrefixes(out) : null;
}

// ── Cells ────────────────────────────────────────────────────────────────────

type Cell = SheetData["cells"][number];

/** Counts cells across a workbook against `OFFICE_LIMITS.cells`, before they are made. */
class CellBudget {
  private count = 0;
  add(n: number) {
    this.count += n;
    if (this.count > OFFICE_LIMITS.cells) throw officeTooLarge("cells");
  }
}

/** How many times an element repeats: a whole number of at least one (anything else is one). */
function repeats(value: string | undefined): number {
  const n = value === undefined ? 1 : Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** An ISO 8601 duration (`PT12H30M00S`) as a fraction of a day. */
function durationSerial(text: string | undefined): number | null {
  const m = /^(-)?P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    text?.trim() ?? "",
  );
  if (!m) return null;
  const seconds = Number(m[2] ?? 0) * 86400 + Number(m[3] ?? 0) * 3600 + Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0);
  return Number.isFinite(seconds) ? ((m[1] ? -1 : 1) * seconds) / 86400 : null;
}

/** A cell's content as read (before its repeats are laid out). */
interface Content {
  v?: number | string | boolean;
  f?: string;
  e?: ErrorCode;
}

/** A styled run of empty cells, laid out only where the sheet's content reaches. */
interface StyledRun {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
  style: CellStyle;
}

interface SheetSettings {
  frozen?: { rows: number; cols: number };
  tab?: string;
}

/** `settings.xml`: each sheet's frozen panes and tab color, as LibreOffice keeps them. */
function readSettings(text: string | null): Map<string, SheetSettings> {
  const out = new Map<string, SheetSettings>();
  if (!text) return out;
  let depthInTables = 0;
  let sheet: string | null = null;
  let item: string | null = null;
  let value = "";
  const items = new Map<string, Record<string, string>>();
  scan(text, "settings.xml", {
    open(name, a, selfClosing) {
      if (name === "config:config-item-map-named" && a["config:name"] === "Tables") depthInTables = 1;
      else if (depthInTables > 0 && name === "config:config-item-map-entry") {
        depthInTables++;
        if (depthInTables === 2) sheet = a["config:name"] ?? null;
      } else if (sheet && depthInTables === 2 && name === "config:config-item" && !selfClosing) {
        item = a["config:name"] ?? null;
        value = "";
      }
    },
    close(name) {
      if (name === "config:config-item" && item && sheet) {
        const record = items.get(sheet) ?? {};
        record[item] = value.trim();
        items.set(sheet, record);
        item = null;
      } else if (depthInTables > 0 && name === "config:config-item-map-entry") {
        if (depthInTables === 2) sheet = null;
        depthInTables--;
      } else if (name === "config:config-item-map-named" && depthInTables === 1) depthInTables = 0;
    },
    text(chunk) {
      if (item) value += chunk;
    },
  });
  for (const [name, record] of items) {
    const settings: SheetSettings = {};
    const cols = record.HorizontalSplitMode === "2" ? (int(record.HorizontalSplitPosition) ?? 0) : 0;
    const rows = record.VerticalSplitMode === "2" ? (int(record.VerticalSplitPosition) ?? 0) : 0;
    if (rows > 0 || cols > 0) settings.frozen = { rows, cols };
    const tab = int(record.TabColor);
    if (tab !== null && tab >= 0) settings.tab = `#${(tab & 0xffffff).toString(16).padStart(6, "0")}`;
    out.set(name, settings);
  }
  return out;
}

/** The sheets of `content.xml`, scanned once. */
function readSheets(text: string, styles: Styles, settings: Map<string, SheetSettings>): SheetData[] {
  const budget = new CellBudget();
  const sheets: SheetData[] = [];
  // The sheet being read.
  let sheet: SheetData | null = null;
  let hidden = false;
  let row = 0;
  let col = 0;
  let maxRow = -1;
  let maxCol = -1;
  let runs: StyledRun[] = [];
  let merges: NonNullable<SheetData["merges"]> = [];
  let widthRuns: { c1: number; c2: number; px: number }[] = [];
  let heightRuns: { r1: number; r2: number; px: number }[] = [];
  let colDefaults: { c1: number; c2: number; style: string }[] = [];
  // The row being read: its repeat, its default style, its cells with their own repeats.
  let rowRepeat = 1;
  let rowDefault: string | undefined;
  let rowCells: { c: number; n: number; content: Content; style: CellStyle | undefined }[] = [];
  let rowRuns: { c1: number; c2: number; style: CellStyle }[] = [];
  // The cell being read.
  let cell: { attrs: SaxAttrs; repeat: number; covered: boolean } | null = null;
  let paragraphs: string[] | null = null;
  // Inside a paragraph of the cell (text between paragraphs is the file's own indentation).
  let inParagraph = 0;
  let skipDepth = 0;

  const colDefault = (c: number) => colDefaults.find((d) => c >= d.c1 && c <= d.c2)?.style;

  const finishCell = () => {
    if (!cell) return;
    const { attrs: a, repeat, covered } = cell;
    cell = null;
    const c = col;
    col += repeat;
    if (covered || c >= MAX_A1_COLS) return;
    const n = Math.min(repeat, MAX_A1_COLS - c);
    const textValue = paragraphs ? paragraphs.join("\n") : "";
    paragraphs = null;
    const content: Content = {};
    const type = a["office:value-type"];
    switch (type) {
      case "float":
      case "percentage":
      case "currency": {
        const v = Number(a["office:value"]);
        if (a["office:value"] !== undefined && Number.isFinite(v)) content.v = v;
        break;
      }
      case "date": {
        const v = isoSerial(a["office:date-value"] ?? "");
        if (v !== null) content.v = v;
        break;
      }
      case "time": {
        const v = durationSerial(a["office:time-value"]);
        if (v !== null) content.v = v;
        break;
      }
      case "boolean": {
        const v = (a["office:boolean-value"] ?? "").toLowerCase();
        if (v) content.v = v === "true" || v === "1";
        break;
      }
      default: {
        const s = a["office:string-value"] ?? textValue;
        if (s !== "") content.v = s;
      }
    }
    if (a["calcext:value-type"] === "error") {
      delete content.v;
      content.e = (isErrorCode(textValue) ? textValue : "#VALUE!") as ErrorCode;
    }
    const formula = a["table:formula"] ? odsFormula(a["table:formula"]) : null;
    if (formula) content.f = formula;
    const named = a["table:style-name"] ?? rowDefault;
    const hasContent = content.v !== undefined || content.f !== undefined || content.e !== undefined;
    if (hasContent) {
      rowCells.push({ c, n, content, style: styles.cell(named ?? colDefault(c)) });
    } else if (named) {
      const style = styles.cell(named);
      if (style) rowRuns.push({ c1: c, c2: c + n - 1, style });
    } else {
      // No style of its own: each column's default, run by run.
      for (const d of colDefaults) {
        const c1 = Math.max(c, d.c1);
        const c2 = Math.min(c + n - 1, d.c2);
        const style = c1 <= c2 ? styles.cell(d.style) : undefined;
        if (style) rowRuns.push({ c1, c2, style });
      }
    }
    // A merged block starts here.
    const spanCols = repeats(a["table:number-columns-spanned"]);
    const spanRows = repeats(a["table:number-rows-spanned"]);
    if ((spanCols > 1 || spanRows > 1) && row < MAX_A1_ROWS) {
      merges.push({
        r1: row,
        c1: c,
        r2: Math.min(row + spanRows - 1, MAX_A1_ROWS - 1),
        c2: Math.min(c + spanCols - 1, MAX_A1_COLS - 1),
      });
    }
  };

  const finishRow = () => {
    const r1 = row;
    const n = Math.max(0, Math.min(rowRepeat, MAX_A1_ROWS - r1));
    row += rowRepeat;
    if (n > 0) {
      // Every cell this row lays out, counted before one is made.
      const total = rowCells.reduce((sum, rc) => sum + rc.n, 0) * n;
      if (total > 0) budget.add(total);
      for (let k = 0; k < n; k++) {
        for (const rc of rowCells) {
          for (let i = 0; i < rc.n; i++) {
            const out: Cell = { r: r1 + k, c: rc.c + i, ...rc.content };
            if (rc.style) out.s = rc.style;
            (sheet as SheetData).cells.push(out);
          }
        }
      }
      if (rowCells.length > 0) {
        maxRow = Math.max(maxRow, r1 + n - 1);
        for (const rc of rowCells) maxCol = Math.max(maxCol, rc.c + rc.n - 1);
      }
      for (const run of rowRuns) runs.push({ r1, r2: r1 + n - 1, ...run });
    }
    rowCells = [];
    rowRuns = [];
  };

  const finishSheet = () => {
    if (!sheet) return;
    const s = sheet;
    sheet = null;
    if (hidden) return;
    const own = settings.get(s.name);
    if (own?.frozen) s.frozen = own.frozen;
    if (own?.tab) s.tab = own.tab;
    for (const m of merges) {
      maxRow = Math.max(maxRow, m.r2);
      maxCol = Math.max(maxCol, m.c2);
    }
    // Styled empty cells only where the content reaches (a style down a whole column is no content).
    for (const run of runs) {
      const r2 = Math.min(run.r2, maxRow);
      const c2 = Math.min(run.c2, maxCol);
      if (run.r1 > r2 || run.c1 > c2) continue;
      budget.add((r2 - run.r1 + 1) * (c2 - run.c1 + 1));
      for (let r = run.r1; r <= r2; r++) for (let c = run.c1; c <= c2; c++) s.cells.push({ r, c, s: run.style });
    }
    s.rows = Math.max(maxRow + 1, s.frozen?.rows ?? 0, 1);
    s.cols = Math.max(maxCol + 1, s.frozen?.cols ?? 0, 1);
    const widths: Record<number, number> = {};
    for (const w of widthRuns)
      for (let c = w.c1; c <= Math.min(w.c2, s.cols - 1); c++) if (w.px !== 100) widths[c] = w.px;
    if (Object.keys(widths).length > 0) s.colWidths = widths;
    const heights: Record<number, number> = {};
    for (const h of heightRuns) for (let r = h.r1; r <= Math.min(h.r2, s.rows - 1); r++) heights[r] = h.px;
    if (Object.keys(heights).length > 0) s.rowHeights = heights;
    if (merges.length > 0) s.merges = merges;
    sheets.push(s);
  };

  scan(text, "content.xml", {
    open(name, a, selfClosing) {
      if (skipDepth > 0) {
        if (!selfClosing) skipDepth++;
        return;
      }
      switch (name) {
        case "table:table": {
          finishSheet();
          const tableProps = styles.props(a["table:style-name"]);
          hidden = tableProps["table:display"] === "false";
          sheet = { name: a["table:name"] ?? `Sheet ${sheets.length + 1}`, rows: 0, cols: 0, cells: [] };
          row = 0;
          maxRow = -1;
          maxCol = -1;
          runs = [];
          merges = [];
          widthRuns = [];
          heightRuns = [];
          colDefaults = [];
          col = 0;
          break;
        }
        case "table:table-column": {
          if (!sheet) break;
          const n = repeats(a["table:number-columns-repeated"]);
          const c1 = col;
          const c2 = Math.min(col + n - 1, MAX_A1_COLS - 1);
          col += n;
          if (c1 > c2) break;
          if (a["table:default-cell-style-name"] && a["table:default-cell-style-name"] !== "Default") {
            colDefaults.push({ c1, c2, style: a["table:default-cell-style-name"] });
          }
          const width = points(styles.props(a["table:style-name"])["style:column-width"]);
          if (width !== null && width > 0 && a["table:visibility"] !== "collapse") {
            widthRuns.push({ c1, c2, px: ptToPx(width) });
          }
          break;
        }
        case "table:table-row": {
          if (!sheet) break;
          col = 0;
          rowRepeat = repeats(a["table:number-rows-repeated"]);
          rowDefault = a["table:default-cell-style-name"];
          rowCells = [];
          rowRuns = [];
          const p = styles.props(a["table:style-name"]);
          const height = points(p["style:row-height"]);
          if (
            height !== null &&
            height > 0 &&
            p["style:use-optimal-row-height"] === "false" &&
            (a["table:visibility"] ?? "visible") === "visible" &&
            row < MAX_A1_ROWS
          ) {
            heightRuns.push({ r1: row, r2: Math.min(row + rowRepeat - 1, MAX_A1_ROWS - 1), px: ptToPx(height) });
          }
          if (selfClosing) finishRow();
          break;
        }
        case "table:table-cell":
        case "table:covered-table-cell":
          if (!sheet) break;
          cell = {
            attrs: a,
            repeat: repeats(a["table:number-columns-repeated"]),
            covered: name === "table:covered-table-cell",
          };
          paragraphs = null;
          if (selfClosing) finishCell();
          break;
        case "office:annotation":
        case "draw:frame":
        case "draw:custom-shape":
        case "draw:g":
          // A comment or a drawing in a cell: not the cell's text.
          if (!selfClosing) skipDepth = 1;
          break;
        case "text:p":
        case "text:h":
          if (cell) {
            paragraphs ??= [];
            paragraphs.push("");
            inParagraph++;
          }
          break;
        case "text:s":
          if (cell && paragraphs && inParagraph > 0) {
            const n = Math.min(repeats(a["text:c"]), 1000);
            paragraphs[paragraphs.length - 1] += " ".repeat(n);
          }
          break;
        case "text:tab":
          if (cell && paragraphs && inParagraph > 0) paragraphs[paragraphs.length - 1] += "\t";
          break;
        case "text:line-break":
          if (cell && paragraphs && inParagraph > 0) paragraphs[paragraphs.length - 1] += "\n";
          break;
      }
    },
    close(name) {
      if (skipDepth > 0) {
        skipDepth--;
        return;
      }
      if ((name === "text:p" || name === "text:h") && inParagraph > 0) inParagraph--;
      else if (name === "table:table-cell" || name === "table:covered-table-cell") {
        inParagraph = 0;
        finishCell();
      } else if (name === "table:table-row") finishRow();
      else if (name === "table:table") finishSheet();
    },
    text(chunk) {
      if (skipDepth === 0 && inParagraph > 0 && cell && paragraphs) paragraphs[paragraphs.length - 1] += chunk;
    },
  });
  finishSheet();
  return sheets;
}

/** An OpenDocument spreadsheet as data: its visible sheets in order. */
export function readOds(bytes: Uint8Array): WorkbookData {
  try {
    return readOdsBook(bytes);
  } catch (error) {
    // A file damaged in a way no check names is still just a damaged file.
    if (isOfficeError(error)) throw error;
    throw officeUnreadable("it is damaged");
  }
}

function readOdsBook(bytes: Uint8Array): WorkbookData {
  const pkg = OfficePackage.open(bytes);
  const manifest = pkg.text("META-INF/manifest.xml");
  // A document saved with a password lists how each of its parts was encrypted.
  if (manifest && /encryption-data/.test(manifest)) throw officeEncrypted();
  const content = pkg.text("content.xml");
  if (!content) throw officeUnreadable("it has no content");
  const styles = new Styles();
  const common = pkg.text("styles.xml");
  if (common) styles.read(common, "styles.xml");
  styles.read(beforeBody(content), "content.xml");
  const sheets = readSheets(content, styles, readSettings(pkg.text("settings.xml")));
  if (sheets.length === 0) throw officeUnreadable("it has no sheet to show");
  return { sheets };
}
