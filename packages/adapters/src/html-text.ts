/**
 * Outside HTML and text made safe to read (ADR 0117): one HTML-to-text converter for web pages, mail and
 * search results, which drops what a person never sees on the page (so hidden text can't speak to the
 * model), one cleaner for any outside text, which strips characters that hide or reorder text, and a
 * marker finder that sees through invisible characters and look-alike forms without changing the text.
 */

/** Bidi overrides and isolates: they reorder what a person sees on screen. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu;
/**
 * Unicode tag characters, an invisible ASCII side channel, except inside an emoji subdivision flag
 * (U+1F3F4, tags, cancel tag), which stays whole.
 */
const STRAY_TAGS = /(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\u{E0000}-\u{E007F}]/gu;

/**
 * Outside text without the characters that hide or reorder text (bidi overrides and isolates, stray tag
 * characters). Everything else stays exactly as written (ZWJ emoji, RLM/LRM, ellipses, full-width forms), so
 * text an agent reads and writes back is unchanged; disguised markers are found by `replaceDisguised`.
 */
export function cleanOutside(text: string): string {
  return text.replace(BIDI_CONTROLS, "").replace(STRAY_TAGS, (_m, flag?: string) => flag ?? "");
}

/** Whether the text carries characters `cleanOutside` strips. */
export const hasInvisible = (text: string) => cleanOutside(text) !== text;

/**
 * Ignored when looking for a disguised marker: zero-width, joiners, bidi marks, soft hyphen, combining grapheme
 * joiner, Mongolian vowel separator, Hangul fillers, variation selectors and tag characters.
 */
const SKIPPED_IN_MARKERS =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: tested on one code point at a time, never on a sequence
  /[\u00AD\u034F\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0F\uFEFF]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

/** Look-alikes NFKC leaves alone, for the characters of envelope markers (Cyrillic, Greek, angle brackets, slashes). */
const CONFUSABLES: Record<string, string> = {
  а: "a",
  с: "c",
  ԁ: "d",
  е: "e",
  ɡ: "g",
  һ: "h",
  і: "i",
  ӏ: "l",
  о: "o",
  р: "p",
  ѕ: "s",
  т: "t",
  ս: "u",
  ԝ: "w",
  х: "x",
  α: "a",
  ε: "e",
  ι: "i",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  А: "A",
  В: "B",
  С: "C",
  Е: "E",
  Н: "H",
  І: "I",
  М: "M",
  О: "O",
  Р: "P",
  Т: "T",
  Х: "X",
  "‹": "<",
  "〈": "<",
  "⟨": "<",
  "˂": "<",
  "›": ">",
  "〉": ">",
  "⟩": ">",
  "˃": ">",
  "∕": "/",
  "⁄": "/",
  "⧸": "/",
};

/**
 * `text` with every match of `pattern` (global) replaced, matching on a folded copy (invisible characters
 * skipped, NFKC and look-alike letters folded) so a disguised marker is found, while the rest of the text stays as
 * written. The replaced span covers the disguise.
 */
export function replaceDisguised(text: string, pattern: RegExp, replacement: string): string {
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of text) {
    const end = i + ch.length;
    if (!SKIPPED_IN_MARKERS.test(ch)) {
      const f = CONFUSABLES[ch] ?? ch.normalize("NFKC");
      folded += f;
      for (let k = 0; k < f.length; k++) {
        from.push(i);
        to.push(end);
      }
    }
    i = end;
  }
  let out = "";
  let last = 0;
  for (const m of folded.matchAll(pattern)) {
    const start = from[m.index] ?? text.length;
    const stop = to[m.index + m[0].length - 1] ?? text.length;
    if (start < last) continue;
    out += text.slice(last, start) + replacement;
    last = stop;
  }
  return last === 0 ? text : out + text.slice(last);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  divide: "÷",
  iexcl: "¡",
  iquest: "¿",
  aacute: "á",
  Aacute: "Á",
  agrave: "à",
  Agrave: "À",
  acirc: "â",
  Acirc: "Â",
  atilde: "ã",
  Atilde: "Ã",
  auml: "ä",
  ccedil: "ç",
  Ccedil: "Ç",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  ecirc: "ê",
  Ecirc: "Ê",
  euml: "ë",
  iacute: "í",
  Iacute: "Í",
  icirc: "î",
  oacute: "ó",
  Oacute: "Ó",
  ocirc: "ô",
  Ocirc: "Ô",
  otilde: "õ",
  Otilde: "Õ",
  ouml: "ö",
  uacute: "ú",
  Uacute: "Ú",
  ucirc: "û",
  uuml: "ü",
  ntilde: "ñ",
  Ntilde: "Ñ",
  szlig: "ß",
  zwnj: "",
  zwj: "",
  shy: "",
};

/** Decodes HTML entities (named, decimal and hex). Unknown names stay as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS =
  "address|article|aside|blockquote|center|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|tbody|thead|tfoot|tr|ul";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const ATTR = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

const SLASH = 47;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const GREATER = 62;
const isAsciiLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** `[\w:-]`: an ASCII letter or digit, `_`, `:` or `-`. */
const isNameChar = (c: number) => isAsciiLetter(c) || (c >= 48 && c <= 57) || c === 95 || c === 58 || c === 45;

/**
 * For each index of `html`, the `>` that closes a tag's attributes read from there, a quoted value (`"…"` or `'…'`)
 * skipped whole with any `>` in it, or -1 when none does (a quote never closed, or the end of the page). Filled
 * from the end, so the page is read once however many tags it leaves open.
 */
function attributeEnds(html: string): Int32Array {
  const ends = new Int32Array(html.length + 1);
  ends[html.length] = -1;
  let nextDouble = -1;
  let nextSingle = -1;
  for (let at = html.length - 1; at >= 0; at--) {
    const c = html.charCodeAt(at);
    if (c === GREATER) ends[at] = at;
    else if (c === DOUBLE_QUOTE) {
      ends[at] = nextDouble < 0 ? -1 : (ends[nextDouble + 1] ?? -1);
      nextDouble = at;
    } else if (c === SINGLE_QUOTE) {
      ends[at] = nextSingle < 0 ? -1 : (ends[nextSingle + 1] ?? -1);
      nextSingle = at;
    } else ends[at] = ends[at + 1] ?? -1;
  }
  return ends;
}

interface Tag {
  /** Index of the `<`. */
  start: number;
  /** Index just past the `>`. */
  end: number;
  closing: boolean;
  name: string;
  /** What is between the name and the `>`. */
  raw: string;
}

/**
 * The page's tags in order, exactly as `/<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g` finds them, read
 * by index: run on a page, that pattern reads the rest of it again from each `<` that nothing closes, quadratic in
 * the page's length. A name that fails at its longest fails at every shorter length too (the letters it gives up
 * are read as attributes up to the same `>`), so the longest is the only one to try.
 */
function* tags(html: string): Generator<Tag> {
  let ends: Int32Array | undefined;
  for (let at = html.indexOf("<"); at >= 0; ) {
    const closing = html.charCodeAt(at + 1) === SLASH;
    const nameAt = at + (closing ? 2 : 1);
    if (isAsciiLetter(html.charCodeAt(nameAt))) {
      let nameEnd = nameAt + 1;
      while (isNameChar(html.charCodeAt(nameEnd))) nameEnd++;
      ends ??= attributeEnds(html);
      const close = ends[nameEnd] ?? -1;
      if (close >= 0) {
        yield {
          start: at,
          end: close + 1,
          closing,
          name: html.slice(nameAt, nameEnd),
          raw: html.slice(nameEnd, close),
        };
        at = html.indexOf("<", close + 1);
        continue;
      }
    }
    at = html.indexOf("<", at + 1);
  }
}

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) {
    const name = (m[1] ?? "").toLowerCase();
    if (name && !out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

const isZero = (v: string) => /^[+-]?0*(\.0*)?[a-z%]*$/.test(v) && /0/.test(v) && !/[1-9]/.test(v);

/** Whether an inline style hides the element from a person looking at the page. */
function styleHides(style: string): boolean {
  const decl = new Map<string, string>();
  for (const part of style.toLowerCase().split(";")) {
    const i = part.indexOf(":");
    if (i > 0)
      decl.set(
        part.slice(0, i).trim(),
        part
          .slice(i + 1)
          .replace(/!important/g, "")
          .replace(/\s+/g, ""),
      );
  }
  const get = (k: string) => decl.get(k) ?? "";
  if (get("display") === "none" || get("visibility") === "hidden") return true;
  if (decl.has("opacity") && isZero(get("opacity"))) return true;
  if (decl.has("font-size") && isZero(get("font-size"))) return true;
  const color = get("color");
  if (color && (color === get("background-color") || color === get("background"))) return true;
  if (/^(transparent|rgba\(.*,0(\.0*)?\)|#[0-9a-f]{6}00|#[0-9a-f]{3}0)$/.test(color)) return true;
  const far = (v: string) => /^-\d+(\.\d+)?px$/.test(v) && Number.parseFloat(v) <= -1000;
  if (/^(absolute|fixed)$/.test(get("position")) && (far(get("left")) || far(get("top")))) return true;
  if (far(get("text-indent"))) return true;
  if (/^rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)$/.test(get("clip")) || /^inset\(50%\)$/.test(get("clip-path")))
    return true;
  if (/^scale\(0(\.0*)?(,0(\.0*)?)?\)$/.test(get("transform"))) return true;
  const overflowHidden = /^(hidden|clip)$/.test(get("overflow"));
  if (overflowHidden && ((decl.has("width") && isZero(get("width"))) || (decl.has("height") && isZero(get("height")))))
    return true;
  return false;
}

function hiddenElement(name: string, raw: string): boolean {
  if (name === "template") return true;
  const attrs = attributes(raw);
  if (attrs.has("hidden") || attrs.get("aria-hidden")?.toLowerCase() === "true") return true;
  const style = attrs.get("style");
  return style ? styleHides(style) : false;
}

/**
 * Drops every element a person can't see (template, `hidden`, `aria-hidden="true"`, inline styles that hide
 * it or move it off screen) with its whole subtree. A stack walk, so nested elements of the same name close
 * where the browser would close them. ponytail: inline styles only, colors compared as written; a class
 * hidden by a stylesheet still shows, which needs a CSS engine.
 */
export function dropHidden(html: string): string {
  let out = "";
  let last = 0;
  let skip: { name: string; depth: number } | null = null;
  for (const tag of tags(html)) {
    const name = tag.name.toLowerCase();
    const selfClosing = VOID_TAGS.has(name) || tag.raw.trimEnd().endsWith("/");
    if (skip) {
      if (name !== skip.name) continue;
      if (tag.closing) skip.depth--;
      else if (!selfClosing) skip.depth++;
      if (skip.depth === 0) {
        skip = null;
        last = tag.end;
      }
      continue;
    }
    if (tag.closing || !hiddenElement(name, tag.raw)) continue;
    out += html.slice(last, tag.start);
    last = tag.end;
    if (!selfClosing) skip = { name, depth: 1 };
  }
  // An unclosed hidden element hides the rest of the page, as in a browser.
  return skip ? out : out + html.slice(last);
}

// The page's comments, unread elements and tags are taken out by index below, exactly as these patterns take them:
//   /<!--[\s\S]*?-->/g
//   /<(head|style|script|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
//   /<[^>]*>/g
// Run on a page, those read the rest of it again from each `<!--`, `<script` or `<` that nothing closes: quadratic in
// the page's length.

/** `html` without its comments, each from a `<!--` to the first `-->` after it; one left open stays. */
function withoutComments(html: string): string {
  let out = "";
  let from = 0;
  for (let at = html.indexOf("<!--"); at >= 0; at = html.indexOf("<!--", from)) {
    const end = html.indexOf("-->", at + 4);
    // No `-->` after this `<!--`: none after a later one either.
    if (end < 0) break;
    out += html.slice(from, at);
    from = end + 3;
  }
  return out + html.slice(from);
}

/** Elements a reader never sees as text, taken out with all they hold. */
const UNREAD_ELEMENTS = ["head", "style", "script", "title", "noscript"];

const isSpace = (ch: string) => /\s/.test(ch);
const isWordChar = (ch: string) => /\w/.test(ch);
/** Whether `text` has `name` (lowercase ASCII) at `at`, in any case of its ASCII letters. */
function nameAt(text: string, at: number, name: string): boolean {
  if (at + name.length > text.length) return false;
  for (let i = 0; i < name.length; i++) {
    const ch = text.charAt(at + i);
    if ((ch >= "A" && ch <= "Z" ? ch.toLowerCase() : ch) !== name.charAt(i)) return false;
  }
  return true;
}

/**
 * `html` without its unread elements: from `<script` (or another of `UNREAD_ELEMENTS`, in any case, not followed by
 * a letter, digit or `_`) through its tag's `>` to the first `</script>` after it, spaces allowed before that `>`.
 * One never closed stays. Each search goes on from where the last one for the same thing stopped, so the page is read
 * a few times at most.
 */
function withoutUnreadElements(html: string): string {
  let gtFrom = Number.POSITIVE_INFINITY;
  let gtAt = -1;
  /** The first `>` at or after `from`, or -1. */
  const nextGt = (from: number) => {
    if (from < gtFrom || (gtAt >= 0 && from > gtAt)) {
      gtFrom = from;
      gtAt = html.indexOf(">", from);
    }
    return gtAt;
  };
  const closes = new Map<string, { from: number; at: number; end: number }>();
  /** Where the first `</name>` at or after `from` ends, or -1. */
  const closeEnd = (name: string, from: number) => {
    const seen = closes.get(name);
    if (seen && from >= seen.from && (seen.at < 0 || from <= seen.at)) return seen.end;
    let at = html.indexOf("</", from);
    let end = -1;
    for (; at >= 0; at = html.indexOf("</", at + 1)) {
      if (!nameAt(html, at + 2, name)) continue;
      let gt = at + 2 + name.length;
      while (gt < html.length && isSpace(html.charAt(gt))) gt++;
      if (html.charAt(gt) === ">") {
        end = gt + 1;
        break;
      }
    }
    closes.set(name, { from, at, end });
    return end;
  };
  let out = "";
  let from = 0;
  let at = html.indexOf("<");
  while (at >= 0) {
    const name = UNREAD_ELEMENTS.find((n) => nameAt(html, at + 1, n));
    const afterName = at + 1 + (name?.length ?? 0);
    if (name && !isWordChar(html.charAt(afterName))) {
      const tagEnd = nextGt(afterName);
      // No `>` after this tag's name: none after a later one either.
      if (tagEnd < 0) break;
      const end = closeEnd(name, tagEnd + 1);
      if (end >= 0) {
        out += html.slice(from, at);
        from = end;
        at = html.indexOf("<", end);
        continue;
      }
    }
    at = html.indexOf("<", at + 1);
  }
  return out + html.slice(from);
}

/** `html` without its tags, each from a `<` to the first `>` after it; a `<` left open stays. */
function withoutTags(html: string): string {
  let out = "";
  let from = 0;
  for (let at = html.indexOf("<"); at >= 0; at = html.indexOf("<", from)) {
    const end = html.indexOf(">", at + 1);
    // No `>` after this `<`: none after a later one either.
    if (end < 0) break;
    out += html.slice(from, at);
    from = end + 1;
  }
  return out + html.slice(from);
}

/** Whether `text` has `doctype` at `at`, in any case of its ASCII letters (as `/doctype/i` reads it). */
function doctypeAt(text: string, at: number): boolean {
  const word = "doctype";
  for (let k = 0; k < word.length; k++) {
    const c = text.charCodeAt(at + k);
    const w = word.charCodeAt(k);
    if (c !== w && c !== w - 32) return false;
  }
  return true;
}

/**
 * `html` without its `<!doctype …>` declarations, read by index. Not by `/<!doctype[^>]*>/gi`: on outside HTML with
 * many `<!doctype` and no `>`, that pattern reads the rest of the text again from each of them (quadratic).
 */
function withoutDoctypes(html: string): string {
  let out = "";
  let from = 0;
  let at = html.indexOf("<!", from);
  while (at >= 0) {
    if (!doctypeAt(html, at + 2)) {
      at = html.indexOf("<!", at + 2);
      continue;
    }
    const end = html.indexOf(">", at + 9);
    // No `>` after this one: none after a later one either, so nothing more is a declaration.
    if (end < 0) break;
    out += html.slice(from, at);
    from = end + 1;
    at = html.indexOf("<!", from);
  }
  return out + html.slice(from);
}

/**
 * HTML to readable plain text: drops head/style/script and comments and every element a person can't see
 * (`dropHidden`), turns blocks and `<br>` into line breaks, list items into "- ", table cells into tabs,
 * images into their alt text, and links into "text (url)" (just the url when the text is the url). The
 * result goes through `cleanOutside`.
 */
export function htmlToText(html: string): string {
  let text = withoutDoctypes(withoutUnreadElements(withoutComments(html)));
  text = dropHidden(text);
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attrs: string, inner: string) => {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const url = decodeEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim());
    const label = withoutTags(inner).replace(/\s+/g, " ").trim();
    const labelText = decodeEntities(label);
    if (!url || /^(javascript|data):/i.test(url) || url.startsWith("#")) return label;
    const shownUrl = url.replace(/^mailto:/i, "");
    if (!labelText || labelText === url || labelText === shownUrl) return shownUrl;
    return `${label} (${shownUrl})`;
  });
  text = text.replace(/<img\b[^>]*?\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (_m, a?: string, b?: string) => {
    const alt = (a ?? b ?? "").trim();
    return alt ? `[${alt}]` : "";
  });
  text = withoutTags(
    text
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(td|th)\s*>/gi, "\t")
      .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
      .replace(/<\/li\s*>/gi, ""),
  );
  text = decodeEntities(text).replace(/ /g, " ");
  return cleanOutside(text)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
