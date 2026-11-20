import { DOMParser, type Element, type Node } from "@xmldom/xmldom";
import { decodeXmlEntities } from "../format";
import { officeUnreadable } from "./limits";

/**
 * XML for the Office readers and writers (ADR 0198). Parts are parsed with @xmldom/xmldom and read by local names, so
 * whatever prefixes a writer chose read the same; a document type declaration is refused before parsing (Office never
 * writes one, and none of its entities is ever expanded). The parts that can be large (a worksheet's cells, a
 * workbook's strings) go through `sax`, a linear scanner that builds no tree. The writers escape through `xmlText` and
 * `xmlAttr`, which also drop the characters XML 1.0 can't hold.
 */

export type { Element };

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;

/** The relationships namespace: `r:id`, `r:embed` and `r:link` are read in it (`relAttr`). */
export const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const USED_PREFIX = /<\/?([A-Za-z_][\w.-]*):[A-Za-z_]|\s([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*\s*=/g;
const DECLARED_PREFIX = /\sxmlns:([A-Za-z_][\w.-]*)\s*=/g;

/**
 * The part with a declaration for every prefix it uses but never declares: such a part isn't namespace-well-formed
 * and the parser refuses it, yet some writers leave declarations out (`r` is always the relationships one).
 */
function declarePrefixes(text: string): string {
  const declared = new Set<string>(["xml", "xmlns"]);
  for (const m of text.matchAll(DECLARED_PREFIX)) declared.add(m[1] as string);
  const missing = new Set<string>();
  for (const m of text.matchAll(USED_PREFIX)) {
    const prefix = (m[1] ?? m[2]) as string;
    if (!declared.has(prefix)) missing.add(prefix);
  }
  if (missing.size === 0) return text;
  const root = /<[A-Za-z_][\w.:-]*/.exec(text);
  if (!root) return text;
  const at = root.index + root[0].length;
  const declarations = [...missing]
    .map((p) => ` xmlns:${p}="${p === "r" ? RELATIONSHIPS_NS : `urn:agentes:unbound:${p}`}"`)
    .join("");
  return text.slice(0, at) + declarations + text.slice(at);
}

/** The root element of a part, or `officeUnreadable` when it isn't well-formed XML. */
/**
 * The most tags one part may hold (ADR 0198): a few megabytes of empty tags would build a tree of a gigabyte in the
 * server's memory, while real Word and PowerPoint parts stay far below this.
 */
export const MAX_XML_TAGS = 1_000_000;
/** The same for all the parts one package's reader parses, together. */
export const MAX_PACKAGE_TAGS = 2_000_000;

/** The tags a part's text holds (its `<`), counted without building anything. */
export function tagCount(text: string): number {
  let n = 0;
  for (let i = text.indexOf("<"); i !== -1; i = text.indexOf("<", i + 1)) n++;
  return n;
}

export function parseXml(text: string, part: string): Element {
  if (/<!DOCTYPE/i.test(text.slice(0, 4096)) || text.includes("<!ENTITY")) {
    throw officeUnreadable(`${part} declares a document type`);
  }
  if (tagCount(text) > MAX_XML_TAGS) throw officeUnreadable(`${part} is too large to read`);
  let root: Element | null = null;
  try {
    const parser = new DOMParser({
      locator: false,
      onError: (level, message) => {
        if (level === "fatalError") throw new Error(message);
      },
    });
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    root = parser.parseFromString(declarePrefixes(clean), "text/xml").documentElement as Element | null;
  } catch {
    throw officeUnreadable(`${part} is not well-formed`);
  }
  if (!root) throw officeUnreadable(`${part} is empty`);
  return root;
}

/** An element's local name (`a:t` → `t`). */
export function nameOf(el: Element | Node): string {
  const node = el as Element;
  return node.localName ?? node.nodeName.slice(node.nodeName.indexOf(":") + 1);
}

/** Direct element children, all or those with a local name. */
export function kids(el: Element | null | undefined, name?: string): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT_NODE && (name === undefined || nameOf(n) === name)) out.push(n as Element);
  }
  return out;
}

/** The first direct child with a local name. */
export function kid(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT_NODE && nameOf(n) === name) return n as Element;
  }
  return null;
}

/** Down a path of local names, the first match at each step. */
export function dig(el: Element | null | undefined, ...names: string[]): Element | null {
  let at: Element | null = el ?? null;
  for (const name of names) {
    at = kid(at, name);
    if (!at) return null;
  }
  return at;
}

/** Every element below with a local name, in document order. */
export function below(el: Element | null | undefined, name: string): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  const walk = (node: Element) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== ELEMENT_NODE) continue;
      if (nameOf(n) === name) out.push(n as Element);
      walk(n as Element);
    }
  };
  walk(el);
  return out;
}

/**
 * An attribute by its local name (`val` finds `w:val` and `val`), or null. `ns` narrows it to a namespace ending so
 * (`relationships` for `r:id`, whatever prefix the file gave it).
 */
export function attr(el: Element | null | undefined, name: string, ns?: string): string | null {
  if (!el) return null;
  const attrs = el.attributes;
  if (!attrs) return null;
  let fallback: string | null = null;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs.item(i);
    if (!a) continue;
    const local = a.localName ?? a.nodeName.slice(a.nodeName.indexOf(":") + 1);
    if (local !== name) continue;
    if (ns !== undefined) {
      if ((a.namespaceURI ?? "").endsWith(ns)) return a.value;
      continue;
    }
    // Unprefixed first: `id` is never mistaken for `r:id` when both are there.
    if (!a.prefix) return a.value;
    fallback ??= a.value;
  }
  return fallback;
}

/** A relationship id on an element (`r:id`, `r:embed`, `r:link`): what its target is in the part's rels. */
export const relAttr = (el: Element | null | undefined, name = "id") => attr(el, name, "relationships");

/** An attribute as a whole number, or null. */
export function intAttr(el: Element | null | undefined, name: string): number | null {
  const raw = attr(el, name);
  if (raw === null || !/^-?\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** An attribute as a number, or null. */
export function numAttr(el: Element | null | undefined, name: string): number | null {
  const raw = attr(el, name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** OOXML's booleans: "1"/"true"/"on" (an element present without the attribute is true where the caller says so). */
export function boolAttr(el: Element | null | undefined, name: string, absent = false): boolean {
  const raw = attr(el, name);
  if (raw === null) return absent;
  return raw === "1" || raw === "true" || raw === "on";
}

/** All the text inside an element. */
export function textOf(el: Element | null | undefined): string {
  if (!el) return "";
  let out = "";
  const walk = (node: Element) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE) out += (n as unknown as { data: string }).data;
      else if (n.nodeType === ELEMENT_NODE) walk(n as Element);
    }
  };
  walk(el);
  return out;
}

// ── A linear scanner for large parts ─────────────────────────────────────────

/** Attributes by local name (the last one wins). */
export type SaxAttrs = Record<string, string>;

export interface SaxHandler {
  open?(name: string, attrs: SaxAttrs, selfClosing: boolean): void;
  close?(name: string): void;
  /** Character data between tags, entities decoded (whitespace between tags too: the handler knows what it keeps). */
  text?(text: string): void;
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const localOf = (qname: string) => qname.slice(qname.indexOf(":") + 1);

function attrsOf(source: string, keyOf: (qname: string) => string): SaxAttrs {
  const attrs: SaxAttrs = {};
  if (source.length === 0) return attrs;
  ATTRIBUTE.lastIndex = 0;
  for (let m = ATTRIBUTE.exec(source); m; m = ATTRIBUTE.exec(source)) {
    const value = m[2] ?? m[3] ?? "";
    attrs[keyOf(m[1] as string)] = value.includes("&") ? decodeXmlEntities(value) : value;
  }
  return attrs;
}

const asWritten = (qname: string) => qname;

/**
 * Walks XML once, in linear time, calling `handler` for each start tag, end tag and run of text. Comments and
 * processing instructions are skipped; a document type declaration, or a tag that never ends, is `officeUnreadable`.
 * Names are local ("c" for "x:c") unless `qualified`, for formats whose attributes share local names across
 * namespaces (OpenDocument's `office:value-type` and `calcext:value-type`).
 */
export function sax(xml: string, handler: SaxHandler, part = "a part", options: { qualified?: boolean } = {}): void {
  const keyOf = options.qualified ? asWritten : localOf;
  const n = xml.length;
  let i = 0;
  const wantText = handler.text !== undefined;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (wantText) handler.text?.(decodeXmlEntities(xml.slice(i)));
      return;
    }
    if (lt > i && wantText) {
      const raw = xml.slice(i, lt);
      handler.text?.(raw.includes("&") ? decodeXmlEntities(raw) : raw);
    }
    const next = xml.charCodeAt(lt + 1);
    if (next === 33 /* ! */) {
      if (xml.startsWith("<!--", lt)) {
        const end = xml.indexOf("-->", lt + 4);
        if (end < 0) throw officeUnreadable(`${part} has an unclosed comment`);
        i = end + 3;
        continue;
      }
      if (xml.startsWith("<![CDATA[", lt)) {
        const end = xml.indexOf("]]>", lt + 9);
        if (end < 0) throw officeUnreadable(`${part} has an unclosed CDATA section`);
        if (wantText) handler.text?.(xml.slice(lt + 9, end));
        i = end + 3;
        continue;
      }
      throw officeUnreadable(`${part} declares a document type`);
    }
    if (next === 63 /* ? */) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw officeUnreadable(`${part} has an unclosed processing instruction`);
      i = end + 2;
      continue;
    }
    // The tag's end: the first ">" outside quotes.
    let j = lt + 1;
    let quote = 0;
    for (; j < n; j++) {
      const c = xml.charCodeAt(j);
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) quote = c;
      else if (c === 62) break;
    }
    if (j >= n) throw officeUnreadable(`${part} has a tag that never ends`);
    if (next === 47 /* / */) {
      handler.close?.(keyOf(xml.slice(lt + 2, j).trim()));
    } else {
      const selfClosing = xml.charCodeAt(j - 1) === 47;
      const body = xml.slice(lt + 1, selfClosing ? j - 1 : j);
      let k = 0;
      while (k < body.length) {
        const c = body.charCodeAt(k);
        if (c === 32 || c === 9 || c === 10 || c === 13) break;
        k++;
      }
      const name = keyOf(body.slice(0, k));
      handler.open?.(name, attrsOf(body.slice(k), keyOf), selfClosing);
      if (selfClosing) handler.close?.(name);
    }
    i = j + 1;
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

/** Whether XML 1.0 can hold a UTF-16 code unit here (`next` for a surrogate's pair). */
function allowed(code: number, prev: number, next: number): boolean {
  if (code >= 0x20 && code < 0xd800) return true;
  if (code === 0x9 || code === 0xa || code === 0xd) return true;
  if (code >= 0xd800 && code <= 0xdbff) return next >= 0xdc00 && next <= 0xdfff;
  if (code >= 0xdc00 && code <= 0xdfff) return prev >= 0xd800 && prev <= 0xdbff;
  return code >= 0xe000 && code !== 0xfffe && code !== 0xffff;
}

/** Text with only the characters XML 1.0 holds (control characters and lone surrogates left out). */
export function cleanXmlChars(text: string): string {
  let bad = false;
  for (let i = 0; i < text.length; i++) {
    if (!allowed(text.charCodeAt(i), text.charCodeAt(i - 1), text.charCodeAt(i + 1))) {
      bad = true;
      break;
    }
  }
  if (!bad) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (allowed(code, text.charCodeAt(i - 1), text.charCodeAt(i + 1))) out += text.charAt(i);
  }
  return out;
}

/** Text for an element's content. */
export function xmlText(text: string): string {
  return cleanXmlChars(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text for an attribute's value (in double quotes); tabs and line breaks kept as references. */
export function xmlAttr(text: string): string {
  return cleanXmlChars(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

/** The XML declaration every part starts with. */
export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
