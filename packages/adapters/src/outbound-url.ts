/** Credential shapes that never belong in an address or a message: API keys, tokens. */
export const KEY_SHAPES =
  /\b(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9._-]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g;
/**
 * Credential shapes that signed and presigned addresses carry by design (an AWS key id, a JWT). Read through
 * `replaceShapes`.
 */
export const SIGNED_SHAPES = /\b(AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,})/g;
const WORD_START = /\b(?=\w)/g;
const JWT_RUN = /[\w-]*/y;

/**
 * `text.replace(shapes, by)`, read in time, for key shapes that each start a word and of which only a JWT starts with
 * `eyJ` (`SIGNED_SHAPES`, it with `KEY_SHAPES`). A JWT's first part runs to the end of its run of letters, digits, `_`
 * and `-`: once one fails, every later start in that run fails too, and isn't tried. `String.replace` reads the run to
 * its end again from each, the square of its length on a long run of `eyJ-`.
 */
export function replaceShapes(text: string, shapes: RegExp, by: string | ((found: string) => string)): string {
  const at = new RegExp(shapes.source, "y");
  let out = "";
  let done = 0;
  let failed = 0;
  for (const { index } of text.matchAll(WORD_START)) {
    const jwt = text.startsWith("eyJ", index);
    if (index < done || (jwt && index < failed)) continue;
    at.lastIndex = index;
    const found = at.exec(text)?.[0];
    if (found !== undefined) {
      out += text.slice(done, index) + (typeof by === "string" ? by : by(found));
      done = index + found.length;
    } else if (jwt) {
      JWT_RUN.lastIndex = index;
      JWT_RUN.test(text);
      failed = JWT_RUN.lastIndex;
    }
  }
  return out + text.slice(done);
}

/** `text` with every key shape (`KEY_SHAPES`, `SIGNED_SHAPES`) replaced by `[REDACTED]`. */
export const maskKeyShapes = (text: string) =>
  replaceShapes(text.replace(KEY_SHAPES, "[REDACTED]"), SIGNED_SHAPES, "[REDACTED]");
/** A private key, by its first line. */
export const PRIVATE_KEY = /-----BEGIN[A-Z0-9\s]*?\sPRIVATE\s+KEY/;

export type OutboundCode = "outbound.private_text" | "outbound.credential" | "outbound.long";

export const OUTBOUND_MESSAGES: Record<OutboundCode, string> = {
  "outbound.private_text":
    "This address carries text this run read from private data. Addresses can't carry it. To look something up use web_search, or open the link as it appeared.",
  "outbound.credential": "An address can't carry a key.",
  "outbound.long":
    "This address is too long to open by itself. Open it from a search result or a link, or use web_search.",
};

const MAX_QUERY = 512;
const MAX_SEGMENT = 200;
/** Shortest run of private text that counts as copied: longer than a word, a date or an id prefix. */
const WINDOW = 24;

/** The form of an address `seen` compares: https, lowercase host, no fragment, no trailing slash. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.protocol = "https:";
  // From a run's first `/` only: without the lookbehind each `/` of a long run inside the address reads it to its end.
  return u.toString().replace(/(?<!\/)\/+$/, "");
}

const URLS_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = ".,;:!?)]}*";

/** Every address written in a text, normalized (trailing punctuation dropped). */
export function urlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URLS_IN_TEXT)) {
    // A walk back, not `/[…]+$/`: that pattern is quadratic on a long run of punctuation that does not end the text.
    let end = m[0].length;
    while (end > 0 && TRAILING_PUNCTUATION.includes(m[0][end - 1] as string)) end--;
    const n = normalizeUrl(m[0].slice(0, end));
    if (n) out.push(n);
  }
  return out;
}

/** Collapsed whitespace, case-folded: how query text and private text compare. */
export const foldText = (s: string) => s.replace(/\s+/g, " ").toLowerCase();

const decode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
};

/**
 * Why an agent may not open this address by itself (null: it may): the address carries a key, is long enough to
 * smuggle data, or copies text the run read from private data (`privateText`). An address that appeared as is
 * (`seen`: in the conversation or a tool's result) always passes, whatever it carries. No privateText (the runner,
 * where the run's reads aren't known): AWS key ids and JWTs pass, since signed addresses carry them.
 */
export function outboundUrlProblem(
  url: string,
  opts: { seen?: (normalized: string) => boolean; privateText?: TextPrints } = {},
): { code: OutboundCode; message: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const normalized = normalizeUrl(url);
  if (normalized && opts.seen?.(normalized)) return null;
  const problem = (code: OutboundCode) => ({ code, message: OUTBOUND_MESSAGES[code] });
  const decoded = carried(u);
  const whole = `${decode(u.href)} ${decoded}`;
  if (new RegExp(KEY_SHAPES.source).test(whole) || PRIVATE_KEY.test(whole)) return problem("outbound.credential");
  if (opts.privateText && replaceShapes(whole, SIGNED_SHAPES, "") !== whole) return problem("outbound.credential");
  if (decoded.length > MAX_QUERY || u.pathname.split("/").some((s) => s.length > MAX_SEGMENT)) {
    return problem("outbound.long");
  }
  if (opts.privateText?.copiedIn(decoded)) {
    return problem("outbound.private_text");
  }
  return null;
}

/** The text an address carries for its server: its query values and fragment, decoded. */
function carried(u: URL) {
  return [...u.searchParams.values(), decode(u.hash.slice(1))].filter(Boolean).join(" ");
}

/** Whether an address's query or fragment copies a private text (`outboundUrlProblem`'s private-text rule alone). */
export function urlCopiesPrivateText(url: string, privateText: TextPrints): boolean {
  try {
    return privateText.copiedIn(carried(new URL(url)));
  } catch {
    return false;
  }
}

/** Characters per fingerprinted gram. Any `WINDOW`-long run spans `GRAMS` of them, so it holds one both sides keep. */
const GRAM = 20;
const GRAMS = WINDOW - GRAM + 1;
const B1 = 0x01000193;
const B2 = 0x5bd1e995;
const B1_OUT = (() => {
  let p = 1;
  for (let i = 0; i < GRAM; i++) p = Math.imul(p, B1);
  return p;
})();
const B2_OUT = (() => {
  let p = 1;
  for (let i = 0; i < GRAM; i++) p = Math.imul(p, B2);
  return p;
})();
const mix = (h: number) => {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

/**
 * Winnowing (Schleimer et al., 2003): two 32-bit hashes of each `GRAM`-character gram of the folded text, and of every
 * `GRAMS` grams in a row the one with the smallest hash (the rightmost on a tie) goes to `keep`. The choice depends on
 * those grams alone, so two texts sharing `WINDOW` characters in a row both keep the same gram. `keep` returns true to
 * stop.
 */
function winnow(text: string, keep: (a: number, b: number) => boolean) {
  const folded = foldText(text);
  if (folded.length < WINDOW) return;
  const as = new Uint32Array(GRAMS);
  const bs = new Uint32Array(GRAMS);
  let h1 = 0;
  let h2 = 0;
  let last = -1;
  for (let i = 0; i < folded.length; i++) {
    const c = folded.charCodeAt(i);
    h1 = (Math.imul(h1, B1) + c) | 0;
    h2 = (Math.imul(h2, B2) + c) | 0;
    if (i >= GRAM) {
      const out = folded.charCodeAt(i - GRAM);
      h1 = (h1 - Math.imul(out, B1_OUT)) | 0;
      h2 = (h2 - Math.imul(out, B2_OUT)) | 0;
    }
    const g = i - GRAM + 1;
    if (g < 0) continue;
    as[g % GRAMS] = mix(h1);
    bs[g % GRAMS] = mix(h2 ^ 0x9e3779b9);
    if (g < GRAMS - 1) continue;
    let min = g;
    for (let p = g - 1; p > g - GRAMS; p--) if ((as[p % GRAMS] as number) < (as[min % GRAMS] as number)) min = p;
    if (min === last) continue;
    last = min;
    if (keep(as[min % GRAMS] as number, bs[min % GRAMS] as number)) return;
  }
}

/** Bits each fingerprint takes in a filter, and the bits it sets: about 5 in 100 million lookups wrongly match. */
const BITS_PER_PRINT = 48;
const PROBES = 10;
const FIRST_WORDS = 256;

/**
 * What a run read from private data, as fingerprints of its text (`winnow`) in Bloom filters: no text is kept, and
 * checking an address costs its own length, not all the run read. Each new filter is twice the last, up to `maxBytes`
 * in all; past it the newest takes every further fingerprint, so a run that read more than that refuses more addresses
 * wrongly, never fewer: no read stops being checked.
 */
export class TextPrints {
  private filters: Uint32Array[] = [];
  private room = 0;
  /** Bytes its filters take. */
  bytes = 0;
  constructor(private readonly maxBytes: number) {}

  add(text: string) {
    winnow(text, (a, b) => {
      if (this.has(a, b)) return false;
      if (this.room === 0) this.grow();
      const filter = this.filters.at(-1) as Uint32Array;
      const mask = filter.length * 32 - 1;
      for (let i = 0; i < PROBES; i++) {
        const bit = mix(a + Math.imul(i, b)) & mask;
        filter[bit >>> 5] = (filter[bit >>> 5] as number) | (1 << (bit & 31));
      }
      this.room--;
      return false;
    });
  }

  /**
   * Whether `text` copies a text added: true whenever `WINDOW` characters in a row of it (any case and spacing) appear
   * in one, and at times for a shared `GRAM` or a filter's false match.
   */
  copiedIn(text: string) {
    let hit = false;
    winnow(text, (a, b) => {
      hit = this.has(a, b);
      return hit;
    });
    return hit;
  }

  private has(a: number, b: number) {
    return this.filters.some((filter) => {
      const mask = filter.length * 32 - 1;
      for (let i = 0; i < PROBES; i++) {
        const bit = mix(a + Math.imul(i, b)) & mask;
        if (!((filter[bit >>> 5] as number) & (1 << (bit & 31)))) return false;
      }
      return true;
    });
  }

  private grow() {
    const words = (this.filters.at(-1)?.length ?? FIRST_WORDS / 2) * 2;
    if (this.filters.length > 0 && this.bytes + words * 4 > this.maxBytes) {
      this.room = Number.POSITIVE_INFINITY;
      return;
    }
    this.filters.push(new Uint32Array(words));
    this.bytes += words * 4;
    this.room = Math.floor((words * 32) / BITS_PER_PRINT);
  }
}

/**
 * What a guarded `fetch` throws for an address it won't connect to (the server's `publicHttpsFetch`, for hosts people
 * type): not https, or a host that is or resolves to a private, loopback, link-local or internal address. An adapter
 * that takes a `fetch` tells it from a network failure by this class (ADR 0144).
 */
export class OutboundAddressError extends Error {
  constructor(message = "This address points to an internal network") {
    super(message);
    this.name = "OutboundAddressError";
  }
}
