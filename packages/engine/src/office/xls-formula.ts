import { colName, type ErrorCode } from "@agenteschat/live";

/**
 * A legacy workbook's formulas (BIFF8 parsed expressions, MS-XLS 2.5.198) written back as A1 text (ADR 0198): the
 * tokens are a postfix program, replayed on a stack of texts. Anything this reader doesn't know (array constants,
 * data tables, references to other workbooks, a function past the table) makes the whole formula unreadable, and
 * the cell keeps the value Excel last calculated, which is always stored beside it.
 */

/** Excel's binary error numbers. */
export const BIFF_ERRORS: Readonly<Record<number, ErrorCode>> = {
  0: "#NULL!",
  7: "#DIV/0!",
  15: "#VALUE!",
  23: "#REF!",
  29: "#NAME?",
  36: "#NUM!",
  42: "#N/A",
};

/**
 * The built-in functions by their number in the BIFF8 function table (MS-XLS 2.5.198.17), with the argument count of
 * the fixed ones (a `ptgFunc` names no count). Numbers past the table, and macro-sheet commands, are left out: a
 * formula using one keeps its value only.
 */
const FUNCTIONS: Readonly<Record<number, readonly [string, number?]>> = {
  0: ["COUNT"],
  1: ["IF"],
  2: ["ISNA", 1],
  3: ["ISERROR", 1],
  4: ["SUM"],
  5: ["AVERAGE"],
  6: ["MIN"],
  7: ["MAX"],
  8: ["ROW"],
  9: ["COLUMN"],
  10: ["NA", 0],
  11: ["NPV"],
  12: ["STDEV"],
  13: ["DOLLAR"],
  14: ["FIXED"],
  15: ["SIN", 1],
  16: ["COS", 1],
  17: ["TAN", 1],
  18: ["ATAN", 1],
  19: ["PI", 0],
  20: ["SQRT", 1],
  21: ["EXP", 1],
  22: ["LN", 1],
  23: ["LOG10", 1],
  24: ["ABS", 1],
  25: ["INT", 1],
  26: ["SIGN", 1],
  27: ["ROUND", 2],
  28: ["LOOKUP"],
  29: ["INDEX"],
  30: ["REPT", 2],
  31: ["MID", 3],
  32: ["LEN", 1],
  33: ["VALUE", 1],
  34: ["TRUE", 0],
  35: ["FALSE", 0],
  36: ["AND"],
  37: ["OR"],
  38: ["NOT", 1],
  39: ["MOD", 2],
  40: ["DCOUNT", 3],
  41: ["DSUM", 3],
  42: ["DAVERAGE", 3],
  43: ["DMIN", 3],
  44: ["DMAX", 3],
  45: ["DSTDEV", 3],
  46: ["VAR"],
  47: ["DVAR", 3],
  48: ["TEXT", 2],
  49: ["LINEST"],
  50: ["TREND"],
  51: ["LOGEST"],
  52: ["GROWTH"],
  56: ["PV"],
  57: ["FV"],
  58: ["NPER"],
  59: ["PMT"],
  60: ["RATE"],
  61: ["MIRR", 3],
  62: ["IRR"],
  63: ["RAND", 0],
  64: ["MATCH"],
  65: ["DATE", 3],
  66: ["TIME", 3],
  67: ["DAY", 1],
  68: ["MONTH", 1],
  69: ["YEAR", 1],
  70: ["WEEKDAY"],
  71: ["HOUR", 1],
  72: ["MINUTE", 1],
  73: ["SECOND", 1],
  74: ["NOW", 0],
  75: ["AREAS", 1],
  76: ["ROWS", 1],
  77: ["COLUMNS", 1],
  78: ["OFFSET"],
  82: ["SEARCH"],
  83: ["TRANSPOSE", 1],
  86: ["TYPE", 1],
  97: ["ATAN2", 2],
  98: ["ASIN", 1],
  99: ["ACOS", 1],
  100: ["CHOOSE"],
  101: ["HLOOKUP"],
  102: ["VLOOKUP"],
  105: ["ISREF", 1],
  109: ["LOG"],
  111: ["CHAR", 1],
  112: ["LOWER", 1],
  113: ["UPPER", 1],
  114: ["PROPER", 1],
  115: ["LEFT"],
  116: ["RIGHT"],
  117: ["EXACT", 2],
  118: ["TRIM", 1],
  119: ["REPLACE", 4],
  120: ["SUBSTITUTE"],
  121: ["CODE", 1],
  124: ["FIND"],
  125: ["CELL"],
  126: ["ISERR", 1],
  127: ["ISTEXT", 1],
  128: ["ISNUMBER", 1],
  129: ["ISBLANK", 1],
  130: ["T", 1],
  131: ["N", 1],
  140: ["DATEVALUE", 1],
  141: ["TIMEVALUE", 1],
  142: ["SLN", 3],
  143: ["SYD", 4],
  144: ["DDB"],
  148: ["INDIRECT"],
  162: ["CLEAN", 1],
  163: ["MDETERM", 1],
  164: ["MINVERSE", 1],
  165: ["MMULT", 2],
  167: ["IPMT"],
  168: ["PPMT"],
  169: ["COUNTA"],
  183: ["PRODUCT"],
  184: ["FACT", 1],
  189: ["DPRODUCT", 3],
  190: ["ISNONTEXT", 1],
  193: ["STDEVP"],
  194: ["VARP"],
  195: ["DSTDEVP", 3],
  196: ["DVARP", 3],
  197: ["TRUNC"],
  198: ["ISLOGICAL", 1],
  199: ["DCOUNTA", 3],
  204: ["USDOLLAR"],
  205: ["FINDB"],
  206: ["SEARCHB"],
  207: ["REPLACEB", 4],
  208: ["LEFTB"],
  209: ["RIGHTB"],
  210: ["MIDB", 3],
  211: ["LENB", 1],
  212: ["ROUNDUP", 2],
  213: ["ROUNDDOWN", 2],
  214: ["ASC", 1],
  215: ["DBCS", 1],
  216: ["RANK"],
  219: ["ADDRESS"],
  220: ["DAYS360"],
  221: ["TODAY", 0],
  222: ["VDB"],
  227: ["MEDIAN"],
  228: ["SUMPRODUCT"],
  229: ["SINH", 1],
  230: ["COSH", 1],
  231: ["TANH", 1],
  232: ["ASINH", 1],
  233: ["ACOSH", 1],
  234: ["ATANH", 1],
  235: ["DGET", 3],
  244: ["INFO", 1],
  247: ["DB"],
  252: ["FREQUENCY", 2],
  261: ["ERROR.TYPE", 1],
  269: ["AVEDEV"],
  270: ["BETADIST"],
  271: ["GAMMALN", 1],
  272: ["BETAINV"],
  273: ["BINOMDIST", 4],
  274: ["CHIDIST", 2],
  275: ["CHIINV", 2],
  276: ["COMBIN", 2],
  277: ["CONFIDENCE", 3],
  278: ["CRITBINOM", 3],
  279: ["EVEN", 1],
  280: ["EXPONDIST", 3],
  281: ["FDIST", 3],
  282: ["FINV", 3],
  283: ["FISHER", 1],
  284: ["FISHERINV", 1],
  285: ["FLOOR", 2],
  286: ["GAMMADIST", 4],
  287: ["GAMMAINV", 3],
  288: ["CEILING", 2],
  289: ["HYPGEOMDIST", 4],
  290: ["LOGNORMDIST", 3],
  291: ["LOGINV", 3],
  292: ["NEGBINOMDIST", 3],
  293: ["NORMDIST", 4],
  294: ["NORMSDIST", 1],
  295: ["NORMINV", 3],
  296: ["NORMSINV", 1],
  297: ["STANDARDIZE", 3],
  298: ["ODD", 1],
  299: ["PERMUT", 2],
  300: ["POISSON", 3],
  301: ["TDIST", 3],
  302: ["WEIBULL", 4],
  303: ["SUMXMY2", 2],
  304: ["SUMX2MY2", 2],
  305: ["SUMX2PY2", 2],
  306: ["CHITEST", 2],
  307: ["CORREL", 2],
  308: ["COVAR", 2],
  309: ["FORECAST", 3],
  310: ["FTEST", 2],
  311: ["INTERCEPT", 2],
  312: ["PEARSON", 2],
  313: ["RSQ", 2],
  314: ["STEYX", 2],
  315: ["SLOPE", 2],
  316: ["TTEST", 4],
  317: ["PROB"],
  318: ["DEVSQ"],
  319: ["GEOMEAN"],
  320: ["HARMEAN"],
  321: ["SUMSQ"],
  322: ["KURT"],
  323: ["SKEW"],
  324: ["ZTEST"],
  325: ["LARGE", 2],
  326: ["SMALL", 2],
  327: ["QUARTILE", 2],
  328: ["PERCENTILE", 2],
  329: ["PERCENTRANK"],
  330: ["MODE"],
  331: ["TRIMMEAN", 2],
  332: ["TINV", 2],
  336: ["CONCATENATE"],
  337: ["POWER", 2],
  342: ["RADIANS", 1],
  343: ["DEGREES", 1],
  344: ["SUBTOTAL"],
  345: ["SUMIF"],
  346: ["COUNTIF", 2],
  347: ["COUNTBLANK", 1],
  350: ["ISPMT", 4],
  351: ["DATEDIF", 3],
  354: ["ROMAN"],
  358: ["GETPIVOTDATA"],
  359: ["HYPERLINK"],
  361: ["AVERAGEA"],
  362: ["MAXA"],
  363: ["MINA"],
  364: ["STDEVPA"],
  365: ["VARPA"],
  366: ["STDEVA"],
  367: ["VARA"],
};

/** A user-defined or add-in function call: its first argument names the function (`ptgFuncVar` number 255). */
const CALL_BY_NAME = 255;

/**
 * Marks a name that stands for a function (an add-in's, or a future function's "_xlfn." name): only a call by name
 * takes it off. A formula still holding one used a name as a value, which a live sheet can't resolve.
 */
export const FUNCTION_NAME_MARK = "\u0000";

/** What a formula's references and names resolve against. */
export interface FormulaContext {
  /** Every sheet's name, by its index in the workbook (hidden ones too). */
  sheets: readonly string[];
  /** The workbook's defined names, 1-based as `ptgName` counts them (null where one can't be written). */
  names: readonly (string | null)[];
  /** `EXTERNSHEET`'s entries: the sheets a 3-D reference points at, or null for another workbook's. */
  externSheets: readonly ({ first: number; last: number } | null)[];
  /** `ptgNameX` names by `EXTERNSHEET` entry, 1-based (add-in functions, future functions, names). */
  externNames: (ixti: number, index: number) => string | null;
}

class Unreadable extends Error {}

const fail = (): never => {
  throw new Unreadable();
};

interface Item {
  text: string;
  /** How tightly it binds: operands are 10, comparisons 0 (Excel's operator precedence). */
  prec: number;
}

const ATOM = 10;

const BINARY: Readonly<Record<number, readonly [string, number, boolean]>> = {
  // [operator, precedence, whether a right operand of the same precedence needs no parentheses]
  3: ["+", 2, true], // 0x03
  4: ["-", 2, false], // 0x04
  5: ["*", 3, true], // 0x05
  6: ["/", 3, false], // 0x06
  7: ["^", 4, false], // 0x07
  8: ["&", 1, true], // 0x08
  9: ["<", 0, false], // 0x09
  10: ["<=", 0, false], // 0x0a
  11: ["=", 0, false], // 0x0b
  12: [">=", 0, false], // 0x0c
  13: [">", 0, false], // 0x0d
  14: ["<>", 0, false], // 0x0e
  15: [" ", 8, true], // 0x0f
  16: [",", 7, true], // 0x10
  17: [":", 9, true], // 0x11
};

/** A sheet's name as a reference writes it: bare when it can be, quoted otherwise. */
export function sheetPrefix(name: string): string {
  const plain = /^[A-Za-z_À-￿][\w.À-￿]*$/.test(name);
  if (plain && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^R\d*C\d*$/i.test(name)) return `${name}!`;
  return `'${name.replace(/'/g, "''")}'!`;
}

/** A cell address, `$` where it is absolute. */
function a1(row: number, col: number, rowRel: boolean, colRel: boolean): string {
  return `${colRel ? "" : "$"}${colName(col)}${rowRel ? "" : "$"}${row + 1}`;
}

/** Reads one formula; `at` is the cell it belongs to (relative references in shared formulas count from it). */
class Replay {
  private pos = 0;
  private readonly stack: Item[] = [];
  private readonly view: DataView;

  constructor(
    private readonly rgce: Uint8Array,
    private readonly ctx: FormulaContext,
    private readonly row: number,
    private readonly col: number,
    /** Whether plain and 3-D references are relative offsets too (a shared formula's body). */
    private readonly shared: boolean,
  ) {
    this.view = new DataView(rgce.buffer, rgce.byteOffset, rgce.byteLength);
  }

  private need(n: number) {
    if (this.pos + n > this.rgce.byteLength) fail();
  }
  private u8() {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  private u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  private u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  private f64() {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  private skip(n: number) {
    this.need(n);
    this.pos += n;
  }
  private push(text: string, prec = ATOM) {
    this.stack.push({ text, prec });
  }
  private pop(): Item {
    return this.stack.pop() ?? fail();
  }

  /** A short string (`ptgStr`): its length in characters, its byte width, the characters. */
  private shortString(): string {
    const cch = this.u8();
    const high = (this.u8() & 1) === 1;
    this.need(cch * (high ? 2 : 1));
    let out = "";
    for (let i = 0; i < cch; i++) {
      out += String.fromCharCode(high ? this.view.getUint16(this.pos + i * 2, true) : this.view.getUint8(this.pos + i));
    }
    this.pos += cch * (high ? 2 : 1);
    return out;
  }

  /** One end of a reference: absolute coordinates, or offsets from the formula's cell when they are relative. */
  private loc(rw: number, colField: number, offsets: boolean): string {
    const rowRel = (colField & 0x8000) !== 0;
    const colRel = (colField & 0x4000) !== 0;
    let row = rw;
    let col = colField & 0x3fff;
    if (offsets && rowRel) row = (this.row + ((rw << 16) >> 16) + 0x10000) % 0x10000;
    if (offsets && colRel) col = (this.col + (((colField & 0xff) << 24) >> 24) + 0x100) % 0x100;
    return a1(row, col, rowRel, colRel);
  }

  /** An area, written as whole columns or whole rows when it spans the legacy grid's height or width. */
  private area(r1: number, r2: number, c1: number, c2: number, offsets: boolean): string {
    const wholeColumns = r1 === 0 && r2 === 0xffff;
    const wholeRows = (c1 & 0x3fff) === 0 && (c2 & 0x3fff) === 0xff;
    if (wholeColumns && !offsets) {
      const a = `${c1 & 0x4000 ? "" : "$"}${colName(c1 & 0x3fff)}`;
      const b = `${c2 & 0x4000 ? "" : "$"}${colName(c2 & 0x3fff)}`;
      return `${a}:${b}`;
    }
    if (wholeRows && !offsets) {
      return `${c1 & 0x8000 ? "" : "$"}${r1 + 1}:${c2 & 0x8000 ? "" : "$"}${r2 + 1}`;
    }
    return `${this.loc(r1, c1, offsets)}:${this.loc(r2, c2, offsets)}`;
  }

  private sheetOf(ixti: number): string {
    const ext = this.ctx.externSheets[ixti];
    if (!ext || ext.first !== ext.last) return fail();
    const name = this.ctx.sheets[ext.first];
    return name === undefined ? fail() : sheetPrefix(name);
  }

  private call(name: string, argc: number) {
    if (argc > this.stack.length) fail();
    const args = this.stack.splice(this.stack.length - argc, argc).map((a) => a.text);
    this.push(`${name}(${args.join(",")})`);
  }

  private binary(op: string, prec: number, sameOk: boolean) {
    const right = this.pop();
    const left = this.pop();
    const l = left.prec < prec ? `(${left.text})` : left.text;
    const r = right.prec < prec || (right.prec === prec && !sameOk) ? `(${right.text})` : right.text;
    this.push(`${l}${op}${r}`, prec);
  }

  run(): string {
    const end = this.rgce.byteLength;
    while (this.pos < end) {
      const ptg = this.u8();
      const binary = BINARY[ptg];
      if (binary) {
        this.binary(binary[0], binary[1], binary[2]);
        continue;
      }
      // Reference tokens come in three classes (reference, value, array); the low five bits say which token it is.
      const base = ptg >= 0x20 ? (ptg & 0x1f) | 0x20 : ptg;
      switch (base) {
        case 0x12: {
          const x = this.pop();
          this.push(`+${x.prec < 6 ? `(${x.text})` : x.text}`, 6);
          break;
        }
        case 0x13: {
          const x = this.pop();
          this.push(`-${x.prec < 6 ? `(${x.text})` : x.text}`, 6);
          break;
        }
        case 0x14: {
          const x = this.pop();
          this.push(`${x.prec < 5 ? `(${x.text})` : x.text}%`, 5);
          break;
        }
        case 0x15:
          this.push(`(${this.pop().text})`);
          break;
        case 0x16:
          this.push("");
          break;
        case 0x17:
          this.push(`"${this.shortString().replace(/"/g, '""')}"`);
          break;
        case 0x19:
          this.attr();
          break;
        case 0x1c:
          this.push(BIFF_ERRORS[this.u8()] ?? "#N/A");
          break;
        case 0x1d:
          this.push(this.u8() ? "TRUE" : "FALSE");
          break;
        case 0x1e:
          this.push(String(this.u16()));
          break;
        case 0x1f: {
          const n = this.f64();
          if (!Number.isFinite(n)) fail();
          this.push(String(n).replace("e", "E"));
          break;
        }
        case 0x21: {
          const fn = FUNCTIONS[this.u16()];
          if (!fn || fn[1] === undefined) fail();
          this.call((fn as readonly [string, number])[0], (fn as readonly [string, number])[1]);
          break;
        }
        case 0x22: {
          const argc = this.u8() & 0x7f;
          const index = this.u16() & 0x7fff;
          if (index === CALL_BY_NAME) {
            // The function's name is its first operand (a defined or external name).
            if (argc < 1 || argc > this.stack.length) fail();
            const args = this.stack.splice(this.stack.length - argc, argc).map((a) => a.text);
            const marked = args.shift() as string;
            if (!marked.startsWith(FUNCTION_NAME_MARK)) fail();
            const name = marked.slice(FUNCTION_NAME_MARK.length);
            if (!/^[A-Za-z_][\w.]*$/.test(name)) fail();
            this.push(`${name}(${args.join(",")})`);
          } else {
            const fn = FUNCTIONS[index];
            if (!fn) fail();
            this.call((fn as readonly [string, number?])[0], argc);
          }
          break;
        }
        case 0x23: {
          const name = this.ctx.names[this.u32() - 1];
          if (!name) fail();
          this.push(name as string);
          break;
        }
        case 0x24:
          this.push(this.loc(this.u16(), this.u16(), this.shared));
          break;
        case 0x25: {
          const r1 = this.u16();
          const r2 = this.u16();
          const c1 = this.u16();
          const c2 = this.u16();
          this.push(this.area(r1, r2, c1, c2, this.shared));
          break;
        }
        case 0x26:
        case 0x27:
        case 0x28:
          // A memory area, error or no-memory mark: a header before the subexpression that follows inline.
          this.skip(6);
          break;
        case 0x29:
          this.skip(2);
          break;
        case 0x2a:
          this.skip(4);
          this.push("#REF!");
          break;
        case 0x2b:
          this.skip(8);
          this.push("#REF!");
          break;
        case 0x2c:
          this.push(this.loc(this.u16(), this.u16(), true));
          break;
        case 0x2d: {
          const r1 = this.u16();
          const r2 = this.u16();
          const c1 = this.u16();
          const c2 = this.u16();
          this.push(this.area(r1, r2, c1, c2, true));
          break;
        }
        case 0x39: {
          const name = this.ctx.externNames(this.u16(), this.u32());
          if (!name) fail();
          this.push(name as string);
          break;
        }
        case 0x3a: {
          const sheet = this.sheetOf(this.u16());
          this.push(`${sheet}${this.loc(this.u16(), this.u16(), this.shared)}`);
          break;
        }
        case 0x3b: {
          const sheet = this.sheetOf(this.u16());
          const r1 = this.u16();
          const r2 = this.u16();
          const c1 = this.u16();
          const c2 = this.u16();
          this.push(`${sheet}${this.area(r1, r2, c1, c2, this.shared)}`);
          break;
        }
        case 0x3c:
          this.skip(6);
          this.push("#REF!");
          break;
        case 0x3d:
          this.skip(10);
          this.push("#REF!");
          break;
        default:
          // Array constants, data tables, shared-formula pointers out of place, extended tokens: not read.
          fail();
      }
    }
    if (this.stack.length !== 1) fail();
    return (this.stack[0] as Item).text;
  }

  /** `ptgAttr`: spacing, volatility and jump tables are skipped; a one-argument sum is `SUM(x)`. */
  private attr() {
    const flags = this.u8();
    if (flags & 0x04) {
      // A CHOOSE jump table: the count, then one offset per case plus one.
      const cases = this.u16();
      this.skip((cases + 1) * 2);
      return;
    }
    this.skip(2);
    if (flags & 0x10) this.push(`SUM(${this.pop().text})`);
  }
}

/** A formula's tokens as A1 text without the "=", or null when it uses something this reader doesn't write. */
export function formulaText(
  rgce: Uint8Array,
  ctx: FormulaContext,
  at: { row: number; col: number },
  shared = false,
): string | null {
  if (rgce.byteLength === 0) return null;
  try {
    const text = new Replay(rgce, ctx, at.row, at.col, shared).run();
    return text.trim() === "" || text.includes(FUNCTION_NAME_MARK) ? null : text;
  } catch (error) {
    if (error instanceof Unreadable || error instanceof RangeError) return null;
    throw error;
  }
}
