import { OFFICE_LIMITS, officeTooLarge, officeUnreadable } from "./limits";
import { imageTypeOf, OfficePackage, REL } from "./package";
import { attr, boolAttr, dig, type Element, intAttr, kid, kids, nameOf, relAttr, textOf } from "./xml";

/**
 * Word documents (`.docx`) as clean HTML (ADR 0198), safe by construction: what is read becomes a small model
 * (headings, paragraphs, runs bold, italic, underlined or struck, links, line breaks, lists from the document's
 * numbering, tables with merged cells, pictures) and only that model is written out, with a fixed set of tags and
 * attributes, every text escaped, links only to https and mailto addresses and pictures only as PNG, JPEG or GIF data
 * addresses checked by their bytes. Nothing in the file runs: fields show their last result, macros, embedded objects,
 * comments, headers and footers are left out. The same model gives the Markdown of "Edit as document".
 */

export interface DocxText {
  kind: "text";
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  href?: string;
}

type Text = DocxText;

/** A picture as read: its data address (for the HTML), and its bytes and type (for a live document, ADR 0200). */
export interface DocxPicture {
  kind: "img";
  src: string;
  alt: string;
  bytes: Uint8Array;
  type: string;
}

export type DocxInline = Text | { kind: "br" } | DocxPicture;
type Inline = DocxInline;

export interface DocxParagraph {
  kind: "p";
  /** 1–6 for a heading, 0 for a paragraph. */
  heading: number;
  list?: { ordered: boolean; level: number };
  inlines: Inline[];
}

type Paragraph = DocxParagraph;

export interface DocxCell {
  blocks: Block[];
  colspan: number;
  rowspan: number;
  header: boolean;
}

type Cell = DocxCell;

export interface DocxTable {
  kind: "table";
  rows: Cell[][];
}

export type DocxBlock = Paragraph | DocxTable;
type Block = DocxBlock;
type Table = DocxTable;

/** The largest document part read into a tree (the text of thousands of pages). */
const DOCUMENT_PART_BYTES = 20 * 1024 * 1024;
const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);

interface StyleInfo {
  name: string;
  basedOn: string | null;
  outline: number | null;
  numId: string | null;
  ilvl: number | null;
}

class DocxReader {
  private readonly styles = new Map<string, StyleInfo>();
  private readonly numbering = new Map<string, Map<number, boolean>>();
  private pictureBytes = 0;

  constructor(
    private readonly pkg: OfficePackage,
    private readonly part: string,
    /** Whether pictures are taken out (the HTML shows them; the Markdown leaves them out). */
    private readonly pictures: boolean,
  ) {
    const stylesRel = pkg.relOfType(part, REL.styles);
    const styles = stylesRel && !stylesRel.external ? pkg.xml(stylesRel.target) : null;
    for (const s of kids(styles, "style")) {
      const id = attr(s, "styleId");
      if (!id) continue;
      const pPr = kid(s, "pPr");
      const numPr = kid(pPr, "numPr");
      this.styles.set(id, {
        name: attr(kid(s, "name"), "val") ?? id,
        basedOn: attr(kid(s, "basedOn"), "val"),
        outline: intAttr(kid(pPr, "outlineLvl"), "val"),
        numId: attr(kid(numPr, "numId"), "val"),
        ilvl: intAttr(kid(numPr, "ilvl"), "val"),
      });
    }
    const numberingRel = pkg.relOfType(part, REL.numbering);
    const numbering = numberingRel && !numberingRel.external ? pkg.xml(numberingRel.target) : null;
    const abstract = new Map<string, Map<number, boolean>>();
    for (const a of kids(numbering, "abstractNum")) {
      const id = attr(a, "abstractNumId");
      if (id === null) continue;
      const lvls = new Map<number, boolean>();
      for (const lvl of kids(a, "lvl")) {
        const fmt = attr(kid(lvl, "numFmt"), "val") ?? "decimal";
        lvls.set(intAttr(lvl, "ilvl") ?? 0, fmt !== "bullet" && fmt !== "none");
      }
      abstract.set(id, lvls);
    }
    for (const n of kids(numbering, "num")) {
      const id = attr(n, "numId");
      const a = attr(kid(n, "abstractNumId"), "val");
      if (id !== null && a !== null) this.numbering.set(id, abstract.get(a) ?? new Map());
    }
  }

  /** A style and the styles it is based on, nearest first (a loop is cut). */
  private styleChain(id: string | null): StyleInfo[] {
    const out: StyleInfo[] = [];
    const seen = new Set<string>();
    let at = id;
    while (at && !seen.has(at) && out.length < 20) {
      seen.add(at);
      const s = this.styles.get(at);
      if (!s) {
        // A style the document doesn't define: its id may still say what it is.
        out.push({ name: at, basedOn: null, outline: null, numId: null, ilvl: null });
        break;
      }
      out.push(s);
      at = s.basedOn;
    }
    return out;
  }

  private headingOf(pPr: Element | null, chain: StyleInfo[]): number {
    const own = intAttr(kid(pPr, "outlineLvl"), "val");
    if (own !== null && own >= 0 && own <= 5) return own + 1;
    for (const s of chain) {
      const named = /^(?:heading|ttulo|t[ií]tulo)\s*([1-6])$/i.exec(s.name.trim());
      if (named) return Number(named[1]);
      if (/^title$/i.test(s.name.trim())) return 1;
      if (/^subtitle$/i.test(s.name.trim())) return 2;
      if (s.outline !== null && s.outline >= 0 && s.outline <= 5) return s.outline + 1;
    }
    return 0;
  }

  private listOf(pPr: Element | null, chain: StyleInfo[]): Paragraph["list"] {
    const numPr = kid(pPr, "numPr");
    let numId = attr(kid(numPr, "numId"), "val");
    let level = intAttr(kid(numPr, "ilvl"), "val");
    for (const s of chain) {
      numId ??= s.numId;
      level ??= s.ilvl;
    }
    if (!numId || numId === "0") return undefined;
    const lvl = Math.max(0, Math.min(8, level ?? 0));
    const ordered = this.numbering.get(numId)?.get(lvl) ?? false;
    return { ordered, level: lvl };
  }

  // ── Inline content ──────────────────────────────────────────────────────────

  private picture(rId: string | null, alt: string): Inline | null {
    if (!this.pictures) return null;
    const path = this.pkg.target(this.part, rId);
    const size = path ? this.pkg.sizeOf(path) : null;
    if (!path || size === null) return null;
    if (this.pictureBytes + size > OFFICE_LIMITS.inlineImageBytes) return null;
    const bytes = this.pkg.bytes(path);
    const type = bytes ? imageTypeOf(bytes) : null;
    if (!bytes || !type || !PICTURE_TYPES.has(type)) return null;
    this.pictureBytes += bytes.byteLength;
    return {
      kind: "img",
      src: `data:${type};base64,${Buffer.from(bytes).toString("base64")}`,
      alt: alt.slice(0, 500),
      bytes,
      type,
    };
  }

  private hrefOf(el: Element): string | undefined {
    const rel = this.pkg.rels(this.part).get(relAttr(el) ?? "");
    const target = rel?.external ? rel.target : undefined;
    return target && /^(?:https:|mailto:)/i.test(target) && target.length <= 2000 ? target : undefined;
  }

  /** A paragraph's runs, fields showing their result (a HYPERLINK field links it). */
  private inlines(p: Element): Inline[] {
    const out: Inline[] = [];
    // Complex fields: their instructions are skipped, their result shown.
    let depth = 0;
    let inInstruction = false;
    let instruction = "";
    let fieldLink: string | undefined;
    const run = (r: Element, href: string | undefined) => {
      const rPr = kid(r, "rPr");
      if (kid(rPr, "vanish") && boolAttr(kid(rPr, "vanish"), "val", true)) return;
      const flag = (name: string) => {
        const el = kid(rPr, name);
        return el !== null && boolAttr(el, "val", true);
      };
      const u = kid(rPr, "u");
      const look = {
        b: flag("b"),
        i: flag("i"),
        u: u !== null && attr(u, "val") !== "none",
        s: flag("strike") || flag("dstrike"),
      };
      for (const k of kids(r)) {
        switch (nameOf(k)) {
          case "fldChar": {
            const type = attr(k, "fldCharType");
            if (type === "begin") {
              depth++;
              inInstruction = true;
              instruction = "";
            } else if (type === "separate") {
              inInstruction = false;
              const m = /HYPERLINK\s+"([^"]+)"/i.exec(instruction);
              const target = m?.[1];
              fieldLink = target && /^(?:https:|mailto:)/i.test(target) ? target : undefined;
            } else if (type === "end") {
              depth = Math.max(0, depth - 1);
              inInstruction = false;
              if (depth === 0) fieldLink = undefined;
            }
            break;
          }
          case "instrText":
            if (inInstruction) instruction += textOf(k);
            break;
          case "t":
            if (!inInstruction) {
              const text = textOf(k);
              if (text) out.push({ kind: "text", text, ...look, href: href ?? fieldLink });
            }
            break;
          case "tab":
          case "ptab":
            if (!inInstruction) out.push({ kind: "text", text: " ", ...look, href: href ?? fieldLink });
            break;
          case "noBreakHyphen":
            if (!inInstruction) out.push({ kind: "text", text: "-", ...look });
            break;
          case "br":
          case "cr": {
            const type = attr(k, "type");
            if (!inInstruction && type !== "page" && type !== "column") out.push({ kind: "br" });
            break;
          }
          case "drawing":
            if (!inInstruction) {
              const alt = attr(dig(kids(k)[0] ?? null, "docPr"), "descr") ?? "";
              for (const blip of this.blips(k)) {
                const img = this.picture(relAttr(blip, "embed"), alt);
                if (img) out.push(img);
              }
            }
            break;
          case "pict":
          case "object": {
            const data = this.find(k, "imagedata");
            const img = data ? this.picture(relAttr(data, "id"), attr(data, "title") ?? "") : null;
            if (img && !inInstruction) out.push(img);
            break;
          }
          case "AlternateContent":
            for (const pick of [kid(k, "Fallback") ?? kid(k, "Choice")]) if (pick) run(pick, href);
            break;
        }
      }
    };
    const walk = (el: Element, href: string | undefined) => {
      for (const k of kids(el)) {
        switch (nameOf(k)) {
          case "r":
            run(k, href);
            break;
          case "hyperlink":
            walk(k, this.hrefOf(k) ?? href);
            break;
          case "ins":
          case "smartTag":
          case "customXml":
          case "fldSimple":
          case "moveTo":
            walk(k, href);
            break;
          case "sdt":
            walk(kid(k, "sdtContent") ?? k, href);
            break;
          case "AlternateContent": {
            const pick = kid(k, "Fallback") ?? kid(k, "Choice");
            if (pick) walk(pick, href);
            break;
          }
        }
      }
    };
    walk(p, undefined);
    return out;
  }

  private blips(el: Element): Element[] {
    const out: Element[] = [];
    const visit = (node: Element) => {
      for (const k of kids(node)) {
        if (nameOf(k) === "blip") out.push(k);
        else visit(k);
      }
    };
    visit(el);
    return out;
  }

  private find(el: Element, name: string): Element | null {
    for (const k of kids(el)) {
      if (nameOf(k) === name) return k;
      const below = this.find(k, name);
      if (below) return below;
    }
    return null;
  }

  // ── Blocks ──────────────────────────────────────────────────────────────────

  private paragraph(p: Element): Paragraph {
    const pPr = kid(p, "pPr");
    const chain = this.styleChain(attr(kid(pPr, "pStyle"), "val"));
    const heading = this.headingOf(pPr, chain);
    const list = heading ? undefined : this.listOf(pPr, chain);
    const out: Paragraph = { kind: "p", heading, inlines: this.inlines(p) };
    if (list) out.list = list;
    return out;
  }

  private table(tbl: Element): Table {
    const rows: Cell[][] = [];
    // The cell each grid column's vertical merge started in, to grow its row span.
    const above = new Map<number, Cell>();
    for (const tr of kids(tbl, "tr")) {
      const trPr = kid(tr, "trPr");
      const header = kid(trPr, "tblHeader") !== null && boolAttr(kid(trPr, "tblHeader"), "val", true);
      let col = intAttr(kid(trPr, "gridBefore"), "val") ?? 0;
      const row: Cell[] = [];
      for (const tc of kids(tr, "tc")) {
        const tcPr = kid(tc, "tcPr");
        const span = Math.max(1, Math.min(63, intAttr(kid(tcPr, "gridSpan"), "val") ?? 1));
        const vMerge = kid(tcPr, "vMerge");
        const merge = vMerge ? (attr(vMerge, "val") ?? "continue") : null;
        if (merge === "continue") {
          const start = above.get(col);
          if (start) {
            start.rowspan++;
            col += span;
            continue;
          }
        }
        const cell: Cell = { blocks: this.blocks(tc), colspan: span, rowspan: 1, header };
        row.push(cell);
        for (let c = col; c < col + span; c++) {
          if (merge === "restart") above.set(c, cell);
          else above.delete(c);
        }
        col += span;
      }
      rows.push(row);
    }
    return { kind: "table", rows };
  }

  blocks(el: Element): Block[] {
    const out: Block[] = [];
    for (const k of kids(el)) {
      switch (nameOf(k)) {
        case "p":
          out.push(this.paragraph(k));
          break;
        case "tbl":
          out.push(this.table(k));
          break;
        case "sdt":
          out.push(...this.blocks(kid(k, "sdtContent") ?? k));
          break;
        case "customXml":
        case "ins":
          out.push(...this.blocks(k));
          break;
        case "AlternateContent": {
          const pick = kid(k, "Fallback") ?? kid(k, "Choice");
          if (pick) out.push(...this.blocks(pick));
          break;
        }
      }
    }
    return out;
  }
}

/** A Word document's content as blocks (with its pictures when `pictures`): the HTML, the Markdown and a document's. */
export function readDocx(bytes: Uint8Array, pictures: boolean): Block[] {
  const pkg = OfficePackage.open(bytes);
  const part = pkg.mainPart("word/document.xml");
  const size = pkg.sizeOf(part);
  if (size === null) throw officeUnreadable("it has no document");
  if (size > DOCUMENT_PART_BYTES) throw officeTooLarge("document");
  const root = pkg.xml(part);
  const body = kid(root, "body");
  if (!body) throw officeUnreadable("it has no document body");
  return new DocxReader(pkg, part, pictures).blocks(body);
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const sameLook = (a: Text, b: Text) => a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.href === b.href;

/** Neighboring runs that look the same as one. */
function merged(inlines: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const item of inlines) {
    const last = out[out.length - 1];
    if (item.kind === "text" && last?.kind === "text" && sameLook(last, item)) last.text += item.text;
    else out.push(item.kind === "text" ? { ...item } : item);
  }
  return out;
}

function inlineHtml(inlines: readonly Inline[]): string {
  let html = "";
  let link: string | undefined;
  for (const item of merged(inlines)) {
    const href = item.kind === "text" ? item.href : undefined;
    if (href !== link) {
      if (link) html += "</a>";
      if (href) html += `<a href="${escapeHtml(href)}">`;
      link = href;
    }
    if (item.kind === "br") html += "<br>";
    else if (item.kind === "img") html += `<img src="${item.src}" alt="${escapeHtml(item.alt)}">`;
    else {
      let text = escapeHtml(item.text);
      if (item.s) text = `<s>${text}</s>`;
      if (item.u) text = `<u>${text}</u>`;
      if (item.i) text = `<em>${text}</em>`;
      if (item.b) text = `<strong>${text}</strong>`;
      html += text;
    }
  }
  if (link) html += "</a>";
  return html;
}

const hasContent = (p: Paragraph) =>
  p.inlines.some((i) => i.kind === "img" || (i.kind === "text" && i.text.trim() !== ""));

function blocksHtml(blocks: readonly Block[]): string {
  let html = "";
  // Open lists, outermost first: each with its level and kind, and whether its last item is still open.
  const open: { level: number; ordered: boolean }[] = [];
  const closeTo = (level: number) => {
    while (open.length > 0 && (open[open.length - 1] as { level: number }).level > level) {
      const list = open.pop() as { ordered: boolean };
      html += `</li></${list.ordered ? "ol" : "ul"}>`;
    }
  };
  for (const block of blocks) {
    if (block.kind === "p" && block.list && hasContent(block)) {
      const { level, ordered } = block.list;
      closeTo(level);
      const top = open[open.length - 1];
      if (top && top.level === level && top.ordered !== ordered) closeTo(level - 1);
      const current = open[open.length - 1];
      if (current && current.level === level) html += "</li>";
      else {
        open.push({ level, ordered });
        html += `<${ordered ? "ol" : "ul"}>`;
      }
      html += `<li>${inlineHtml(block.inlines)}`;
      continue;
    }
    closeTo(-1);
    if (block.kind === "table") {
      html += "<table><tbody>";
      for (const row of block.rows) {
        html += "<tr>";
        for (const cell of row) {
          const tag = cell.header ? "th" : "td";
          const span = `${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ""}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ""}`;
          html += `<${tag}${span}>${blocksHtml(cell.blocks)}</${tag}>`;
        }
        html += "</tr>";
      }
      html += "</tbody></table>";
    } else if (hasContent(block)) {
      const tag = block.heading ? `h${block.heading}` : "p";
      html += `<${tag}>${inlineHtml(block.inlines)}</${tag}>`;
    }
  }
  closeTo(-1);
  return html;
}

/** A Word document as clean HTML, for the isolated frame the apps draw it in. */
export async function docxToHtml(bytes: Uint8Array): Promise<string> {
  return blocksHtml(readDocx(bytes, true));
}

// ── Markdown ─────────────────────────────────────────────────────────────────

/** Text with Markdown's marks escaped, so a star or a bracket in the document stays one. */
const escapeMd = (text: string) => text.replace(/([\\`*_[\]<>|~])/g, "\\$1");

function inlineMd(inlines: readonly Inline[]): string {
  let out = "";
  for (const item of merged(inlines)) {
    if (item.kind === "br") out += "  \n";
    else if (item.kind === "text") {
      const lead = /^\s*/.exec(item.text)?.[0] ?? "";
      const trail = /\s*$/.exec(item.text)?.[0] ?? "";
      const core = item.text.trim();
      if (!core) {
        out += item.text;
        continue;
      }
      let text = escapeMd(core);
      if (item.s) text = `~~${text}~~`;
      if (item.i) text = `*${text}*`;
      if (item.b) text = `**${text}**`;
      if (item.href) text = `[${text}](${item.href.replace(/[()\s]/g, encodeURIComponent)})`;
      out += lead + text + trail;
    }
  }
  return out.trim();
}

/** A line's first characters escaped where Markdown would read them as a block (`# `, `- `, `1. `, `> `). */
const safeStart = (line: string) => line.replace(/^(#{1,6}\s|[-+]\s|>)/, "\\$1").replace(/^(\d+)([.)]\s)/, "$1\\$2");

function blocksMd(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  let listing = false;
  for (const block of blocks) {
    if (block.kind === "p" && block.list && hasContent(block)) {
      const indent = "  ".repeat(Math.min(block.list.level, 6));
      out.push(`${listing ? "" : "\n"}${indent}${block.list.ordered ? "1." : "-"} ${inlineMd(block.inlines)}`);
      listing = true;
      continue;
    }
    listing = false;
    if (block.kind === "table") {
      const width = Math.max(1, ...block.rows.map((r) => r.reduce((n, c) => n + c.colspan, 0)));
      // Pipes escaped so they don't split the row; backslashes stay, as they are already Markdown's escapes
      // (`escapeMd`) and a table reads `\|` as a pipe before anything else: escaping them again would double them.
      const cellText = (cell: Cell) =>
        blocksMd(cell.blocks).join(" ").replace(/\s+/g, " ").split("|").join("\\|").trim();
      // Rows below a cell that spans down keep its columns empty, so every cell stays under its header.
      const below: number[] = [];
      const rows = block.rows.map((row) => {
        const cells: string[] = [];
        const skip = () => {
          while ((below[cells.length] ?? 0) > 0) {
            below[cells.length] = (below[cells.length] as number) - 1;
            cells.push("");
          }
        };
        for (const cell of row) {
          skip();
          const at = cells.length;
          cells.push(cellText(cell));
          for (let k = 1; k < cell.colspan; k++) cells.push("");
          if (cell.rowspan > 1) for (let k = 0; k < cell.colspan; k++) below[at + k] = cell.rowspan - 1;
        }
        skip();
        while (cells.length < width) cells.push("");
        return `| ${cells.join(" | ")} |`;
      });
      if (rows.length > 0) {
        rows.splice(1, 0, `|${" --- |".repeat(width)}`);
        out.push(`\n${rows.join("\n")}`);
      }
      continue;
    }
    if (!hasContent(block)) continue;
    const text = inlineMd(block.inlines);
    if (!text) continue;
    out.push(block.heading ? `\n${"#".repeat(block.heading)} ${text}` : `\n${safeStart(text)}`);
  }
  return out;
}

/** A Word document as Markdown ("Edit as document"): pictures are left out. */
export async function docxToMarkdown(bytes: Uint8Array): Promise<string> {
  return `${blocksMd(readDocx(bytes, false)).join("\n").trim()}\n`;
}
