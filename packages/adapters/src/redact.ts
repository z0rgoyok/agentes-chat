/** How a credential's name ends where a shell or a header writes it (`PASSWORD=`, `x-api-key:`). */
const NAME = "password|passwd|secret|token|api[_-]?key";
/** What comes before `token` in a page cursor's name (`next_page_token`, `$skiptoken`, `StartingToken`). */
const CURSOR =
  "page|next|prev(?:ious)?|continuation|cursor|sync|pagination|paging|skip|delta|resume|starting|scroll|after|before|offset";
/**
 * How a field's own name ends when its value is a credential: `NAME`'s words, and those that are prose anywhere but
 * in a field's name (`Authorization`, `Set-Cookie`). Never a plural, which is how a count is named (`max_tokens`),
 * nor a page cursor (`next_page_token`).
 */
const FIELD = `(?:${[
  "pass(?:word|wd|phrase)",
  "secret(?:[_-]?(?:access[_-]?)?key)?",
  // The cursor is looked for behind a `token` that is there, not at every place of the text.
  `token(?<!(?:${CURSOR})[_-]?token)`,
  "api[_-]?key",
  "private[_-]?key",
  "authorization",
  "cookie",
].join("|")})`;
const FIELD_NAME = new RegExp(`${FIELD}$`, "i");

const BACKSLASH = 92;

/** Where each quote of one kind is in a text, and how many backslashes are written right before it. */
interface Quotes {
  at: number[];
  slashes: number[];
  /** The first of them not yet passed: values are asked for from the text's start to its end. */
  next: number;
  /** Of those passed, the ways of writing one (its backslashes) met an odd number of times: a string is open. */
  open: Set<number>;
}

function quotesOf(text: string, quote: string): Quotes {
  const quotes: Quotes = { at: [], slashes: [], next: 0, open: new Set() };
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    let run = at;
    while (text.charCodeAt(run - 1) === BACKSLASH) run--;
    quotes.at.push(at);
    quotes.slashes.push(at - run);
  }
  return quotes;
}

/** Passes the quotes up to `until`, keeping which ways of writing one stand open there. */
function pass(quotes: Quotes, until: number) {
  for (; (quotes.at[quotes.next] ?? Number.POSITIVE_INFINITY) <= until; quotes.next++) {
    const slashes = quotes.slashes[quotes.next] ?? 0;
    if (!quotes.open.delete(slashes)) quotes.open.add(slashes);
  }
}

/**
 * An unquoted value: up to its first space, to a line end or a tab as JSON writes them (`\n`, `\r`, `\t`), or to a
 * quote, plain or written with backslashes, before `,`, `}`, `]`, `:`, a space or the text's end. Such a quote ends
 * the value only where it closes the string the value sits in (`valueEnds`). Read one character at a time: a run of
 * backslashes is passed over once, wherever the reading starts.
 */
function unquotedEnd(text: string, from: number) {
  let at = from;
  for (;;) {
    const char = text[at];
    if (char === undefined || SPACE.test(char)) return at;
    let run = at;
    while (text.charCodeAt(run) === BACKSLASH) run++;
    const next = text[run];
    if (next === '"' || next === "'") {
      const after = text[run + 1];
      if (after === undefined || ENDS_A_STRING.test(after)) return at;
      at = run + 1;
    } else if (run > at) {
      if (next === "n" || next === "r" || next === "t") return at;
      at = run;
    } else at++;
  }
}
const SPACE = /\s/;
const ENDS_A_STRING = /[,}\]:\s]/;
/** What a shell reads as one word with the quoted value before it (`TOKEN="abc"def`). */
const GLUED = /[^\s"'\\,;&|<>()[\]{}]*/y;
const NO_SPACE = /\S*/y;

/** Where what `pattern` matches at `at` ends. `pattern` is sticky and matches the empty text too, so never fails. */
function endAt(pattern: RegExp, text: string, at: number) {
  pattern.lastIndex = at;
  pattern.test(text);
  return pattern.lastIndex;
}

/** For one text, where the value that starts at a place ends; a value of no length is left as it is. */
type Ends = (at: number, opener: RegExpExecArray) => number;

/**
 * A quoted value, whole, however many times the text it sits in was itself written as a JSON string: each time
 * doubles the backslashes before a quote and adds one. So the value ends at the quote with as many backslashes as
 * the one that opened it (or that many and escaped backslashes of its own), or with fewer: the string around it
 * ended first. One with no such end is masked as far as its next quote. An unquoted value goes as far as `unquotedEnd`
 * says, and ends at a quote only inside a string: where a quote written the same way stands open before the value
 * (`"line":"token: …"},{"line":"password: …"}`), so the next string's name and value are read on their own. With none
 * open the quote is the value's own (`PASSWORD=ab",cd`), and so is a written quote that would open one after a bare
 * name. `glued`: a quoted value takes with it what a shell reads as one word with it.
 *
 * The quotes are listed once, so a value with no end costs its quotes, never the rest of the text: a quote that does
 * not end a value has more backslashes than the one that opened it, and the time stays linear in the text.
 */
const valueEnds =
  (glued = false) =>
  (text: string): Ends => {
    const kinds = new Map<string, Quotes>();
    const listed = (quote: string) => {
      const quotes = kinds.get(quote) ?? quotesOf(text, quote);
      kinds.set(quote, quotes);
      return quotes;
    };
    const unquoted = (from: number) => {
      let end = unquotedEnd(text, from);
      for (;;) {
        let quote = end;
        while (text.charCodeAt(quote) === BACKSLASH) quote++;
        const kind = text[quote];
        if (kind !== '"' && kind !== "'") return end;
        const quotes = listed(kind);
        pass(quotes, from - 1);
        if (quotes.open.has(quote - end)) return end;
        end = unquotedEnd(text, quote + 1);
      }
    };
    /** Whether a string whose quotes are written with `slashes` backslashes stands open before `at`. */
    const inString = (slashes: number, at: number) =>
      ['"', "'"].some((kind) => {
        const quotes = listed(kind);
        pass(quotes, at - 1);
        return quotes.open.has(slashes);
      });
    return (at, opener) => {
      let open = at;
      while (text.charCodeAt(open) === BACKSLASH) open++;
      const quote = text[open];
      if (quote === '"' || quote === "'") {
        const depth = open - at;
        // A quote written with backslashes is one only inside a string, whose own quotes are written with half as
        // many. After a bare name with none open it is a character of the value (`PASSWORD=\"ab\",cd`).
        if (depth > 0 && !/["']/.test(opener[0]) && !inString((depth - 1) >> 1, at)) return unquoted(at);
        const quotes = listed(quote);
        pass(quotes, open);
        let close = depth === 0 ? quotes.at[quotes.next] : undefined;
        for (let i = quotes.next; i < quotes.at.length; i++) {
          const slashes = quotes.slashes[i] ?? 0;
          if (slashes < depth || (slashes - depth) % (2 * depth + 2) === 0) {
            close = quotes.at[i];
            break;
          }
        }
        if (close !== undefined) return glued ? endAt(GLUED, text, close + 1) : close + 1;
        // Cut off before its closing quote: the quote that opens it ends nothing.
        return unquoted(open + 1);
      }
      return unquoted(at);
    };
  };

/** `text` with the value after each match of `opener` masked, as far as `endsOf` says it goes. */
function maskAfter(text: string, opener: RegExp, endsOf: (text: string) => Ends): string {
  let ends: Ends | undefined;
  let masked = "";
  let done = 0;
  opener.lastIndex = 0;
  for (let found = opener.exec(text); found; found = opener.exec(text)) {
    const at = found.index + found[0].length;
    ends ??= endsOf(text);
    const end = ends(at, found);
    if (end > at) {
      masked += `${text.slice(done, at)}***`;
      done = end;
    }
    opener.lastIndex = Math.max(end, found.index + 1);
  }
  return done ? masked + text.slice(done) : text;
}

/**
 * `text` with the value after each match of `name` masked, read as `redactCommon` reads a value: a quoted one whole,
 * at any depth of writing, an unquoted one up to its first space. `name` is a global pattern that ends where the
 * value starts.
 */
export const maskValuesAfter = (text: string, name: RegExp) => maskAfter(text, name, valueEnds());

/**
 * What stands between a name and its value: `=` or `:`, also as an address writes them (`%3D`) and `=` as a code
 * point (`\u003d`, as a JSON writer that escapes HTML writes it).
 */
const IS = String.raw`(?:[=:]|%(?:25)*3[AD]|\\+u003d)`;
/**
 * `password=…`, `token: …`, before its value: up to its first space, or a quoted one whole. A name with nothing after
 * it on its line takes the next line as its value, unless that line names a credential of its own: masking that name
 * would leave its value.
 */
const NAMED = new RegExp(
  String.raw`(?:${NAME})\s*${IS}(?:[^\S\n]*(?=\S)|\s*(?![\w.-]*(?:${NAME})\s*${IS})(?=\S))`,
  "gi",
);
/**
 * `"password": `, as JSON, a Python dict or a Ruby hash writes a field, before its value: only a text, and never an
 * empty one. A number, `true`, `false` or `null` under such a name is no credential.
 */
const FIELD_NAMED = new RegExp(String.raw`${FIELD}\\*["']\s*(?:=>?|:)\s*(?=\\*["'])(?!(\\*)(["'])\1\2)`, "gi");
/** A quoted text that ends as a credential's field does, as JSON writes it (`"X-Api-Key"`). */
const NAME_TEXT = String.raw`\\*["'][^"'\\]*${FIELD}\\*["']`;
/** A quoted text with no quote of its own inside, as a list keeps a name. */
const PLAIN_TEXT = String.raw`\\*["'](?:[^"'\\]|\\+[^"'\\])*\\*["']`;
/**
 * Two shapes only a record can tell, where text keeps the record as JSON wrote it and can't be opened (a message that
 * quotes it, a result cut off), before the value: the `value` of a record that names it
 * (`"name":"X-Api-Key","value":"…"`), and the second text of a pair that starts a list or follows another
 * (`[["x-api-key","…"],["cookie","…"]]`). A pair is a name and its value among lists of two texts, as in a record:
 * never where its own list goes on past its second text (`[["token","name","date"]]`), nor beside a list that
 * plainly has one text or more than two (`[["id"],["token","asc"]]`).
 */
const RECORD_NAMED = new RegExp(
  String.raw`(?:(?<=["'])(?:name|key|header)\\*["']\s*:\s*${NAME_TEXT}\s*,\s*\\*["']value\\*["']\s*:|(?:\[|\]\s*,(?<!(?:\[\s*${PLAIN_TEXT}|,\s*${PLAIN_TEXT}\s*,\s*${PLAIN_TEXT})\s*\]\s*,))\s*\[\s*${NAME_TEXT}\s*,\s*(?!${PLAIN_TEXT}\s*(?:,|\]\s*,\s*\[\s*${PLAIN_TEXT}\s*(?:\]|,\s*${PLAIN_TEXT}\s*,))))\s*(?=\\*["'])`,
  "gi",
);
/** The same field with its quotes written out: percent-encoded in an address, an HTML entity, a log's code point. */
const WRITTEN_QUOTE = String.raw`%(?:25)*2[27]|&(?:amp;)*(?:quot|apos|#0*3[49]|#x0*2[27]);|\\+(?:u00|x)2[27]`;
const WRITTEN_GAP = String.raw`(?:\s|\+|%(?:25)*20)*`;
const WRITTEN_FIELD_NAMED = new RegExp(`${FIELD}(${WRITTEN_QUOTE})${WRITTEN_GAP}(?::|%(?:25)*3A)${WRITTEN_GAP}`, "gi");
/** A written quote that can end a value: none with a backslash before it, plain or as an address writes it. */
const WRITTEN_END = new RegExp(String.raw`(?<!\\|%(?:25)*5C)(?:${WRITTEN_QUOTE})`, "gi");

/**
 * A value in written quotes: from the quote that opens it, which is written as the one around its field's name, to
 * the next one written the same; with no such quote, up to its first space. The written quotes are listed once, by
 * how each is written, for the same reason a text's quotes are.
 */
function writtenEnds(text: string): Ends {
  let places: Map<string, { at: number[]; next: number }> | undefined;
  return (at, opener) => {
    const quote = (opener[1] ?? "").toLowerCase();
    const written = (from: number) => text.slice(from, from + quote.length).toLowerCase() === quote;
    const start = at + quote.length;
    if (!written(at) || written(start)) return at;
    if (!places) {
      places = new Map();
      for (const found of text.matchAll(WRITTEN_END)) {
        const how = found[0].toLowerCase();
        const same = places.get(how) ?? { at: [], next: 0 };
        same.at.push(found.index);
        places.set(how, same);
      }
    }
    const same = places.get(quote);
    while (same && (same.at[same.next] ?? Number.POSITIVE_INFINITY) < start) same.next++;
    const close = same?.at[same.next];
    return close === undefined ? endAt(NO_SPACE, text, start) : close + quote.length;
  };
}

/**
 * Masks what looks like a credential in free text that leaves its place (the runner's diagnostics and
 * activity log, the operator API's review block): machine tokens, bearer headers, common API key shapes,
 * `password=`/`token:` values, and a field named for a credential as JSON writes it (`"password": "…"`), at any
 * depth of JSON inside a JSON string. The agent's own secrets are masked by their values (ADR 0027) before this.
 */
export function redactCommon(text: string): string {
  const shaped = text
    .replace(/\bagm_[A-Za-z0-9_-]{6,}/g, "agm_***")
    // A `/` may be written `\/`, as a JSON writer may.
    .replace(/\b(Bearer|Basic)\s+(?:[A-Za-z0-9._~+/=-]|\\+\/){8,}/gi, "$1 ***")
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{12,})/g, "sk-***")
    .replace(/\b(gh[pousr]_[A-Za-z0-9._-]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "gh_***")
    .replace(/\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, "xox-***")
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, "AKIA***");
  const fields = maskAfter(maskAfter(shaped, FIELD_NAMED, valueEnds()), WRITTEN_FIELD_NAMED, writtenEnds);
  return maskAfter(maskAfter(fields, RECORD_NAMED, valueEnds()), NAMED, valueEnds(true));
}

/** An option named for a secret, as one text of a list of arguments (`--password`, `-api-key`). */
const OPTION = new RegExp(`^--?[\\w-]*(?:${NAME})[\\w-]*$`, "i");
/** A number after an option named in the plural sets a count (`--max-tokens`, `4096`), and is no credential. */
const setsCount = (option: string, value: string) => /s$/i.test(option) && /^\d+$/.test(value);
/** A list of two texts: among others like it a name and its value, as headers are kept (`[["x-api-key", "…"], …]`). */
const isPair = (value: unknown): value is [string, string] =>
  Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "string");
/** The fields of a record that hold the name its `value` goes by (`{"name": "Authorization", "value": "…"}`). */
const NAMING = /^(?:name|key|header)$/i;
/** How many times a text that is itself JSON is opened, and the longest text opened: the time stays linear. */
const JSON_DEPTH = 4;
const JSON_CHARS = 1_000_000;

/** A text that is itself a JSON record or list, its credentials masked; undefined when it is not one, or holds none. */
function maskedJson(text: string, rule: (text: string) => string, depth: number): string | undefined {
  if (depth >= JSON_DEPTH || text.length > JSON_CHARS || !/^\s*[[{]/.test(text)) return undefined;
  try {
    const record: unknown = JSON.parse(text);
    const masked = JSON.stringify(maskSecretFields(record, rule, false, depth + 1));
    // Written back only when something was masked: writing it again drops its layout and rounds its long numbers.
    return masked === JSON.stringify(record) ? undefined : masked;
  } catch {
    return undefined;
  }
}

/**
 * A record with its credentials masked at any depth, before it is written as text. Under a field named for a
 * credential every text is masked: in text, a value with spaces is masked only up to its first space. A number,
 * `true`, `false` or `null` stays: it is a count or a switch. Masked too: the text after an option named for a
 * secret in a list (`["--password", "…"]`), the second of a pair in a list of pairs (`[["x-api-key", "…"]]`) and the
 * `value` of a record whose name is a credential's (`{"name": "Authorization", "value": "…"}`). Every other text goes
 * through `rule` as itself: written as JSON its line ends and quotes are backslashes, and a rule for text reads one
 * long word. A text that is itself JSON (a result kept as a string, a body inside a body) is opened, masked the same
 * way and written back.
 */
export function maskSecretFields(
  value: unknown,
  rule: (text: string) => string = (text) => text,
  named = false,
  depth = 0,
): unknown {
  const inner = (v: unknown, secret: boolean) => maskSecretFields(v, rule, named || secret, depth);
  if (typeof value === "string") {
    if (named) return value && "***";
    return maskedJson(value, rule, depth) ?? rule(value);
  }
  if (Array.isArray(value)) {
    // Alone, a list of two texts is two names (`"required": ["password", "email"]`).
    if (value.every(isPair)) {
      return value.map(([name, second]) => [inner(name, false), inner(second, FIELD_NAME.test(name))]);
    }
    return value.map((v, i) => {
      const before: unknown = value[i - 1];
      const optionValue =
        typeof v === "string" &&
        !v.startsWith("-") &&
        typeof before === "string" &&
        OPTION.test(before) &&
        !setsCount(before, v);
      return inner(v, optionValue);
    });
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value);
  const namesOne = entries.some(([key, v]) => NAMING.test(key) && typeof v === "string" && FIELD_NAME.test(v));
  return Object.fromEntries(
    entries.map(([key, v]) => [key, inner(v, FIELD_NAME.test(key) || (namesOne && /^value$/i.test(key)))]),
  );
}

/** A field holding a service's own credential (`access_token`, a Page's `page_access_token`), never a page cursor. */
const TOKEN_FIELD = /(^|_)(access|refresh)_?token$/i;

/**
 * An answer without its credential fields, at any depth: Facebook lists a person's Pages with each Page's access
 * token, which would let an agent act around its approvals.
 */
export function withoutTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, v]) => (TOKEN_FIELD.test(key) ? [] : [[key, withoutTokens(v)]])),
  );
}

/**
 * A crash's stack frame (`at fn (/x/y.js:1:2)`, `at /x/y.js:1:2`) or the Node.js version line it ends with. No
 * leading `\s*`: before a word boundary it backtracks over every run of spaces (quadratic on output full of them),
 * and what it would take is trimmed with the line anyway.
 */
const STACK_FRAME = /\bat (?:async |new )?(?:[^\s()]+ \([^)]*\)|\/\S+|file:\/\/\S+|node:\S+)|\bNode\.js v[\d.]+/g;
/** Something named in quotes (`'node'`, `"node"`, `«node»`), as cmd.exe names a program it can't find. */
const QUOTED = /['"‘“„«][^'"’”»\s][^'"’”»]*['"’”»]/;
/** A line that names what went wrong (`Error: …`, `TypeError: …`, `ENOSPC: …`, `error: …`). */
const ERROR_LINE = /(?:\w*Error|\bE[A-Z]{3,}|\berror)\b:/;

/**
 * The line of a command-line tool's output that says what went wrong: its last line naming an error, else its last
 * line, without the stack frames and the Node.js version a crash ends with. Empty when it said nothing else. A last
 * line that goes on from one naming something in quotes (a small letter after no full stop) comes with it: cmd.exe
 * wraps its not found over two lines in every language, and the second alone (`ou externo, um programa operável…`)
 * doesn't name the program.
 */
export function errorLineOf(output: string): string {
  const lines = output
    .replace(STACK_FRAME, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const named = lines.filter((l) => ERROR_LINE.test(l)).at(-1);
  if (named) return named;
  const [before = "", last = ""] = lines.length > 1 ? lines.slice(-2) : ["", lines[0]];
  const goesOn = QUOTED.test(before) && /^\p{Ll}/u.test(last) && !/[.!?:;]$/.test(before);
  return goesOn ? `${before} ${last}` : last;
}

/** Whether a program's words say its disk is full, or its user's disk quota is (`ENOSPC: no space left on device`). */
export const saysDiskFull = (said: string) =>
  /\b(?:ENOSPC|EDQUOT)\b|no space left on device|disk quota exceeded/i.test(said);

/** `text` in at most `max` characters: when longer, cut after its last whole word, with "…". */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "");
  const space = head.lastIndexOf(" ");
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}
