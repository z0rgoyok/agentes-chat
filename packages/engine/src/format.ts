import { createHash } from "node:crypto";
import { type AppLocale, localeInfo } from "@agenteschat/i18n/locale";
/**
 * At most `max` UTF-16 units of `text`, never half of a pair (an emoji) at the end: Postgres refuses jsonb that
 * holds a lone surrogate.
 */
export const cutText = (text: string, max: number) => text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");

/** `cutText` for text people read: a cut ends in "…", never passing for the whole. */
export const cutMarked = (text: string, max: number) => (text.length > max ? `${cutText(text, max - 1)}…` : text);

/**
 * A JSON object or array as compact JSON within `max` characters, its longest strings shortened first (each cut one
 * ends in "…"): every key, number and short value stays, where a cut at the end drops whole fields. Null when the text
 * isn't one, when even its keys alone don't fit, or when written again it would say another number (an id past 2^53).
 */
export function shortenJson(text: string, max: number): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || changesNumbers(value)) return null;
  const capped = (cap: number) =>
    JSON.stringify(value, (_key, v) => (typeof v === "string" && v.length > cap ? `${cutText(v, cap)}…` : v));
  if (capped(0).length > max) return null;
  let [lo, hi] = [0, text.length];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (capped(mid).length <= max) lo = mid;
    else hi = mid - 1;
  }
  return capped(lo);
}

/** A parsed JSON value holding a number that `JSON.stringify` would not write back as it was read. */
const changesNumbers = (v: unknown): boolean =>
  typeof v === "number"
    ? !Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))
    : typeof v === "object" && v !== null && Object.values(v).some(changesNumbers);

/** A sentence's words as they compare: lower case, no accents, no punctuation or emoji, single spaces. */
export const plainWords = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** "Ana's", for the English the agents read. */
export const possessive = (name: string) => `${name}'s`;

/** "in 3 h", "in 2 days": how soon `at` comes, for the English the agents read. */
export function fromNow(at: Date, now = Date.now()) {
  const minutes = Math.max(1, Math.round((at.getTime() - now) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} days`;
}

/** "Ana, Bia and Caio", for the English the agents read. */
export const andList = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** The first `max` items, then how many more ("a, b, +3 more"). */
export const firstOf = (items: string[], max: number) =>
  items.length > max ? `${items.slice(0, max).join(", ")}, +${items.length - max} more` : items.join(", ");

/**
 * Whether `text` asks something by its punctuation, in any script: `?`, the full-width `？`, the Arabic `؟`, the
 * Spanish `¿`. Greek's `;` is left out: it is also a semicolon.
 */
export const hasQuestionMark = (text: string) => /[?？؟¿]/.test(text);

/** A person's first name, from their whole name. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
/** How many words `text` has, in any script: Chinese, Japanese or Thai, written without spaces, count theirs too. */
export function wordCount(text: string) {
  let n = 0;
  for (const s of WORDS.segment(text)) if (s.isWordLike) n++;
  return n;
}

/** `cutText` from the end: the last `max` units, never half of a pair at the start. */
/**
 * `text` without the characters `strip` takes at its ends (`"end"`: only at its end), read by index. Not by a pattern
 * like `/^-+|-+$/g`: titles, names and paths come from people and programs, and such a pattern reads each run that
 * doesn't reach the end again from each of its characters, quadratic in the run's length.
 */
export function trimEdges(text: string, strip: (c: string) => boolean, edges: "both" | "end" = "both"): string {
  let start = 0;
  let end = text.length;
  if (edges === "both") while (start < end && strip(text.charAt(start))) start++;
  while (end > start && strip(text.charAt(end - 1))) end--;
  return text.slice(start, end);
}

export const cutTextEnd = (text: string, max: number) =>
  text.slice(Math.max(0, text.length - max)).replace(/^[\uDC00-\uDFFF]/, "");

/** The strings of an untrusted value: its string items when it is an array, else none. */
export const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** `value` when it is a whole number from `min` to `max`, else null: a stored hour or weekday that may hold anything. */
export const wholeIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;

/** A JSON object, never an array: what Postgres's `jsonb_typeof` calls `object`. */
export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What sits at a dot path in a JSON value (`conversation.id`, `items.0.id`), else undefined. */
export const valueAtPath = (value: unknown, path: string) =>
  path
    .split(".")
    .reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), value);

/** `value` when it is a finite number from `min` to `max`, else null: a stored measure that may hold anything. */
export const numberIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;

/** A measure the database worked out, to the nearest whole; null where it measured nothing. */
export const wholeOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Math.round(Number(value));

/** Postgres text and jsonb refuse NUL and lone UTF-16 surrogates: `text` without either. */
export const pgSafeText = (text: string) =>
  text.replaceAll("\0", "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

/** `JSON.stringify` with every string and key in it `pgSafeText`, for a jsonb write that must never fail on its text. */
export const pgSafeStringify = (value: unknown) =>
  JSON.stringify(value, (_key, v) => {
    if (typeof v === "string") return pgSafeText(v);
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const keys = Object.keys(v);
    // Keys come from third parties too (MCP structuredContent): rebuilt only when one needs it.
    return keys.every((k) => pgSafeText(k) === k)
      ? v
      : Object.fromEntries(keys.map((k) => [pgSafeText(k), (v as Record<string, unknown>)[k]]));
  });

/** A JSON value as `pgSafeStringify` writes it. */
export const pgSafeJson = <T>(value: T): T => {
  const json = pgSafeStringify(value);
  return json === undefined ? value : JSON.parse(json);
};

/**
 * The text of file bytes, or null when they are binary. UTF-8 first; a UTF-16 BOM decodes as UTF-16; otherwise
 * bytes with no NUL and few control characters are Windows-1252 text (an Excel CSV export, a Latin-1 file).
 */
export function textOfBytes(bytes: Uint8Array): string | null {
  const bom =
    bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : null;
  if (bom) return new TextDecoder(bom).decode(bytes, { stream: true });
  if (bytes.includes(0)) return null;
  try {
    // `stream`: a character cut at the end (the read stopped mid-file) is no reason to call it binary.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
  } catch {
    let control = 0;
    for (const b of bytes) if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) control++;
    // ponytail: control-byte share as the binary test; magic bytes would catch a NUL-free binary that passes it.
    return control > bytes.length / 20 ? null : new TextDecoder("windows-1252").decode(bytes);
  }
}

/** A moment as m:ss (h:mm:ss past an hour). */
export function clockOf(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** `2.3 MB`, `12 KB`, `512 bytes`, `50.0 GB`: sizes in the English agents read. */
export function formatBytes(n: number) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * A moment as a person reads it in their time zone and language: the day ("November 6, 2026", "6 de novembro de
 * 2026") and the time with its zone ("3:42 PM GMT-3", "15:42 BRT").
 */
export function dayAndTime(at: Date, timeZone: string, locale: AppLocale) {
  const tag = localeInfo(locale).intl;
  return {
    day: new Intl.DateTimeFormat(tag, { timeZone, dateStyle: "long" }).format(at),
    time: new Intl.DateTimeFormat(tag, { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(
      at,
    ),
  };
}

/** A `YYYY-MM-DD` day from 2000 to 2999 as the ms of its start in UTC, or null when it isn't a real day. */
export function utcDayMs(day: string) {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return /^2\d{3}-\d\d-\d\d$/.test(day) && !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(day) ? ms : null;
}

/**
 * The next time from `now` at `id`'s own moment of the UTC day (from a hash of it), and that day's date: daily work
 * per workspace lands spread over the whole day, each at the same time every day, never all at once after a tick.
 */
export function dailySlot(id: string, now: Date): { at: Date; day: string } {
  const day = 86_400_000;
  const at = now.getTime() - (now.getTime() % day) + (createHash("sha256").update(id).digest().readUInt32BE(0) % day);
  const slot = new Date(at < now.getTime() ? at + day : at);
  return { at: slot, day: slot.toISOString().slice(0, 10) };
}

/** The value under `key`, made and kept the first time it is asked for. */
export function getOrMake<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const found = map.get(key);
  if (found !== undefined) return found;
  const made = make();
  map.set(key, made);
  return made;
}

/** Levenshtein distance: the fewest one-character insertions, deletions or substitutions from `a` to `b`. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, sub));
    }
    prev = row;
  }
  return prev[b.length] as number;
}

/**
 * The `p` quantile (0..1) of `values` by nearest rank: the smallest of them that a `p` share of them don't exceed;
 * 0 for none.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1] as number;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The text of XML character data: the five named entities and numeric ones (`&#233;`, `&#xE9;`) decoded. */
export const decodeXmlEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] !== "#") return XML_ENTITIES[e] ?? whole;
    const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

/** CSV with RFC 4180 quoting. */
export function tableToCsv(columns: string[], rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

/**
 * A Markdown link or image: its words, its address. Every part is bounded or stops at the next `[`, so a text of
 * nothing but brackets is read once, not once per bracket: this runs in the server's own thread on text a model wrote.
 */
const LINK = /!?\[([^\][]*)\]\(([^)\s]{0,2048})\)/g;

/**
 * Text with nothing an app turns into a link, whatever grammar the app reads it by. Two things hold for what comes
 * back, anywhere in it, code included: no `](`, so nothing reads as a Markdown link, and no `://` with something
 * right after it, so nothing reads as an address. Each app pairs backticks and fences its own way, so what one shows
 * as code another shows as words: an address wrapped as code would be a link there.
 *
 * An address loses its `http://` or `https://`. Outside code a link or an image keeps its words alone (its address
 * when it has none). What this takes for code is for looks only: there a link stays as typed, its joint pulled apart.
 */
export function inertLinks(text: string): string {
  return (
    text
      .split(/(```[\s\S]*?```|`[^`\n]+`)/)
      .map((part, i) =>
        i % 2 ? part : part.replace(LINK, (_, words: string, address: string) => words.trim() || address),
      )
      .join("")
      .replace(/https?:\/\//gi, "")
      // What dropping a scheme put together again ("hthttps://tps://"), and any other scheme: pulled apart, which
      // only adds a space and so puts nothing together.
      .replace(/:\/\/(?=\S)/g, ":// ")
      // Last: a scheme dropped between "]" and "(" makes a joint.
      .replaceAll("](", "] (")
  );
}

/** A JSON value with every string in it made inert (`inertLinks`). */
export const inertJson = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "string" ? inertLinks(v) : v)));

/** Whole seconds from an ISO time to `now`, never negative; null when there is no readable time. */
export const secondsBefore = (now: Date, at: string | null | undefined) =>
  at && Number.isFinite(Date.parse(at)) ? Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 1000)) : null;

/**
 * Markdown longer than `max` as consecutive parts of at most `max` characters, cut between paragraphs, never inside a
 * fenced code block unless the block alone is longer: then between its lines, each part closing the fence and the next
 * opening it again as it was opened. A line longer than a part is cut at a space, else anywhere (never inside an
 * emoji). Text within `max` comes back whole.
 */
export function splitMarkdown(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let part = "";
  for (const block of markdownBlocks(text))
    for (const piece of fitBlock(block, max)) {
      if (part && part.length + 2 + piece.length <= max) part += `\n\n${piece}`;
      else {
        if (part) parts.push(part);
        part = piece;
      }
    }
  if (part) parts.push(part);
  return parts;
}

// Any indent: a fence in a nested list item sits deeper than CommonMark's three spaces. A backtick fence's info string
// holds no backtick ("```x``` and more" is inline code).
const FENCE_OPEN = /^\s*(`{3,}(?!.*`)|~{3,})/;

/** Markdown's paragraphs and fenced code blocks, in order; a fence nobody closed runs to the end. */
function markdownBlocks(text: string) {
  const blocks: { lines: string[]; fence?: { open: string; close: string } }[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0) blocks.push({ lines });
    lines = [];
  };
  const all = text.split("\n");
  for (let i = 0; i < all.length; i++) {
    const line = all[i] as string;
    const marker = FENCE_OPEN.exec(line)?.[1];
    if (marker) {
      flush();
      const body: string[] = [];
      let close = marker;
      for (i++; i < all.length; i++) {
        const t = (all[i] as string).trim();
        if (t.length >= marker.length && t === marker.charAt(0).repeat(t.length)) {
          close = all[i] as string;
          break;
        }
        body.push(all[i] as string);
      }
      blocks.push({ lines: body, fence: { open: line, close } });
    } else if (line.trim() === "") flush();
    else lines.push(line);
  }
  flush();
  return blocks;
}

/** A block as pieces of at most `max` characters: whole when it fits, else cut between its lines. */
function fitBlock(block: { lines: string[]; fence?: { open: string; close: string } }, max: number): string[] {
  const { fence } = block;
  const whole = fence ? [fence.open, ...block.lines, fence.close].join("\n") : block.lines.join("\n");
  if (whole.length <= max) return [whole];
  const room = fence ? max - fence.open.length - fence.close.length - 2 : max;
  // A fence line that leaves little room is cut like text: the parts must stay within `max`.
  if (!fence || room < max / 2) return packLines(fence ? whole.split("\n") : block.lines, max);
  return packLines(block.lines, room).map((c) => `${fence.open}\n${c}\n${fence.close}`);
}

function packLines(lines: string[], room: number): string[] {
  const chunks: string[] = [];
  let chunk: string | null = null;
  for (const line of lines)
    for (const piece of cutLine(line, room)) {
      if (chunk !== null && chunk.length + 1 + piece.length <= room) chunk += `\n${piece}`;
      else {
        if (chunk !== null) chunks.push(chunk);
        chunk = piece;
      }
    }
  if (chunk !== null) chunks.push(chunk);
  return chunks;
}

function cutLine(line: string, room: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > room) {
    const space = rest.lastIndexOf(" ", room);
    const cut = space >= room / 2 ? space : room > 1 && /[\uD800-\uDBFF]/.test(rest.charAt(room - 1)) ? room - 1 : room;
    out.push(rest.slice(0, cut));
    rest = rest.slice(space === cut ? cut + 1 : cut);
  }
  out.push(rest);
  return out;
}
