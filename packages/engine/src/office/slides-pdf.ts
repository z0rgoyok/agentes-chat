import { deflateSync } from "node:zlib";
import {
  type DeckView,
  type ElementView,
  type RichParagraph,
  type SlideTheme,
  type SlideView,
  shapeFill,
  type TextLook,
  textLook,
  themeOf,
} from "@agenteschat/live";
import { brandFonts, embedFont, escapePdfString, HELVETICA, HELVETICA_BOLD } from "../pdf";
import type { TrueTypeFont } from "../ttf";
import { type ChartMark, chartMarks } from "./chart-draw";
import { type PdfImage, pdfImage } from "./pdf-images";
import type { DeckMediaReader } from "./pptx-write";

/**
 * A presentation as a PDF, one page per slide (hidden ones left out), in pure TypeScript (ADR 0198): backgrounds,
 * text boxes laid out and wrapped as the apps lay them out (the theme's look for each role, then the element's own
 * style; runs bold, italic, underlined, struck and colored; paragraphs aligned, leveled, bulleted and numbered),
 * shapes, lines with their arrows, pictures (cropped or fitted), tables and charts. Text is set in the engine's own
 * fonts, embedded as subsets (any character they cover), or in the PDF's standard ones when their files are missing.
 * Pages are 960 × 540 points: a 1920-unit slide at half a point a unit.
 */

const PT_PER_UNIT = 0.5;

type FontKey = "F1" | "F2";

interface Fonts {
  /** The embedded faces, or null for the standard fonts. */
  brand: { F1: TrueTypeFont; F2: TrueTypeFont } | null;
  used: Record<FontKey, Map<number, number>>;
}

function width(fonts: Fonts, text: string, font: FontKey, size: number): number {
  let w = 0;
  if (fonts.brand) {
    const f = fonts.brand[font];
    for (const ch of text) w += f.advance(f.glyphOf(ch.codePointAt(0) ?? 63)) / f.unitsPerEm;
    return w * size;
  }
  const table = font === "F2" ? HELVETICA_BOLD : HELVETICA;
  for (const ch of text) {
    const code = ch.normalize("NFD").charCodeAt(0);
    w += (code >= 32 && code <= 126 ? (table[code - 32] ?? 556) : 556) / 1000;
  }
  return w * size;
}

/** Text as the content stream shows it: glyph ids in hex (embedded fonts) or a WinAnsi string. */
function shown(fonts: Fonts, text: string, font: FontKey): string {
  if (!fonts.brand) return `(${escapePdfString(text)})`;
  const f = fonts.brand[font];
  const used = fonts.used[font];
  let hex = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 63;
    const gid = f.glyphOf(cp);
    if (!used.has(gid)) used.set(gid, cp);
    hex += gid.toString(16).padStart(4, "0");
  }
  return `<${hex}>`;
}

const n = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(2)).toString() : "0");

function rgb(color: string): [number, number, number, number] {
  let v = color.replace(/^#/, "");
  if (v.length === 3 || v.length === 4) v = [...v].map((c) => c + c).join("");
  const num = (i: number) => Number.parseInt(v.slice(i, i + 2), 16) / 255;
  const ok = /^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(v);
  return ok ? [num(0), num(2), num(4), v.length === 8 ? num(6) : 1] : [0, 0, 0, 1];
}

/** One page's drawing: its operators, and the opacities and pictures it asks of the document. */
class Page {
  readonly ops: string[] = [];
  constructor(
    private readonly doc: PdfDoc,
    readonly theme: SlideTheme,
  ) {}

  private alpha(fill: number, stroke: number) {
    if (fill >= 1 && stroke >= 1) return;
    this.ops.push(`${this.doc.opacity(fill, stroke)} gs`);
  }

  fillColor(color: string, opacity = 1): number {
    const [r, g, b, a] = rgb(color);
    this.ops.push(`${n(r)} ${n(g)} ${n(b)} rg`);
    return a * opacity;
  }

  strokeColor(color: string, opacity = 1): number {
    const [r, g, b, a] = rgb(color);
    this.ops.push(`${n(r)} ${n(g)} ${n(b)} RG`);
    return a * opacity;
  }

  /** A path (already added with `path`) filled and/or stroked. */
  paint(path: string, fill: string | null, stroke: { color: string; width: number } | null, opacity = 1) {
    if (!fill && !stroke) return;
    this.ops.push("q");
    const fa = fill ? this.fillColor(fill, opacity) : 1;
    const sa = stroke ? this.strokeColor(stroke.color, opacity) : 1;
    this.alpha(fa, sa);
    if (stroke) this.ops.push(`${n(stroke.width)} w`);
    this.ops.push(path, fill && stroke ? "B" : fill ? "f" : "S", "Q");
  }

  rect(x: number, y: number, w: number, h: number, fill: string, opacity = 1) {
    this.paint(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re`, fill, null, opacity);
  }

  /** Text at a baseline, in slide units (the page is flipped: y grows down). */
  text(text: string, x: number, baseline: number, size: number, font: FontKey, color: string, italic: boolean) {
    if (!text) return;
    this.ops.push("q");
    const a = this.fillColor(color);
    this.alpha(a, 1);
    const skew = italic ? 0.2 : 0;
    this.ops.push(
      `BT /${font} ${n(size)} Tf 1 0 ${n(skew)} -1 ${n(x)} ${n(baseline)} Tm ${shown(this.doc.fonts, text, font)} Tj ET`,
      "Q",
    );
  }

  image(img: PdfImage, ref: string, box: { x: number; y: number; w: number; h: number }, fit: "cover" | "contain") {
    const turned = img.turn === 90 || img.turn === 270;
    const shownW = turned ? img.height : img.width;
    const shownH = turned ? img.width : img.height;
    const scale = fit === "cover" ? Math.max(box.w / shownW, box.h / shownH) : Math.min(box.w / shownW, box.h / shownH);
    const w = shownW * scale;
    const h = shownH * scale;
    const x = box.x + (box.w - w) / 2;
    const y = box.y + (box.h - h) / 2;
    this.ops.push("q");
    if (fit === "cover") this.ops.push(`${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)} re W n`);
    // The image's unit square, upright, into its box (the page's y grows down).
    this.ops.push(`1 0 0 1 ${n(x + w / 2)} ${n(y + h / 2)} cm`);
    if (img.turn) {
      const r = (img.turn * Math.PI) / 180;
      this.ops.push(`${n(Math.cos(r))} ${n(Math.sin(r))} ${n(-Math.sin(r))} ${n(Math.cos(r))} 0 0 cm`);
    }
    const sw = turned ? h : w;
    const sh = turned ? w : h;
    this.ops.push(`${n(sw)} 0 0 ${n(-sh)} ${n(-sw / 2)} ${n(sh / 2)} cm /${ref} Do`, "Q");
  }
}

class PdfDoc {
  private readonly objects: (string | Uint8Array)[] = [];
  private readonly states = new Map<string, number>();
  private readonly images = new Map<string, { ref: string; image: PdfImage } | null>();
  readonly xobjects = new Map<string, number>();
  readonly fonts: Fonts;

  constructor() {
    const brand = brandFonts();
    this.fonts = { brand: brand ? { F1: brand.F1, F2: brand.F2 } : null, used: { F1: new Map(), F2: new Map() } };
  }

  add(body: string | Uint8Array): number {
    this.objects.push(body);
    return this.objects.length;
  }

  set(id: number, body: string | Uint8Array) {
    this.objects[id - 1] = body;
  }

  stream(dict: string, data: Uint8Array): number {
    const head = new TextEncoder().encode(`<< ${dict} /Length ${data.byteLength} >>\nstream\n`);
    const tail = new TextEncoder().encode("\nendstream");
    const out = new Uint8Array(head.length + data.length + tail.length);
    out.set(head, 0);
    out.set(data, head.length);
    out.set(tail, head.length + data.length);
    return this.add(out);
  }

  opacity(fill: number, stroke: number): string {
    const key = `${n(Math.max(0, Math.min(1, fill)))}/${n(Math.max(0, Math.min(1, stroke)))}`;
    let id = this.states.get(key);
    if (id === undefined) {
      id = this.states.size + 1;
      this.states.set(key, id);
    }
    return `/GS${id}`;
  }

  /** A picture's image object (made once per asset): its name in the resources, or null when it can't be drawn. */
  async picture(asset: string, read: DeckMediaReader): Promise<{ ref: string; image: PdfImage } | null> {
    if (this.images.has(asset)) return this.images.get(asset) ?? null;
    const got = await read(asset).catch(() => null);
    const image = got ? pdfImage(got.bytes) : null;
    let out: { ref: string; image: PdfImage } | null = null;
    if (image) {
      const mask = image.mask
        ? this.stream(
            `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
            image.mask,
          )
        : null;
      const id = this.stream(
        `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ${image.dict}${mask ? ` /SMask ${mask} 0 R` : ""}`,
        image.data,
      );
      const ref = `Im${this.xobjects.size + 1}`;
      this.xobjects.set(ref, id);
      out = { ref, image };
    }
    this.images.set(asset, out);
    return out;
  }

  /** The finished file: fonts embedded with the glyphs the pages used, one shared resources dictionary. */
  bytes(pages: string[][], title: string): Uint8Array {
    const catalog = this.add("");
    const pagesId = this.add("");
    const resources = this.add("");
    const pageIds = pages.map((ops) => {
      const content = this.stream(
        "/Filter /FlateDecode",
        new Uint8Array(deflateSync(Buffer.from(ops.join("\n"), "latin1"))),
      );
      return this.add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(1920 * PT_PER_UNIT)} ${n(1080 * PT_PER_UNIT)}] /Resources ${resources} 0 R /Contents ${content} 0 R >>`,
      );
    });
    const add = (body: string) => this.add(body);
    const fonts = this.fonts.brand
      ? {
          F1: embedFont(add, this.fonts.brand.F1, this.fonts.used.F1),
          F2: embedFont(add, this.fonts.brand.F2, this.fonts.used.F2),
        }
      : {
          F1: this.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
          F2: this.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
        };
    const states = [...this.states].map(([key, id]) => {
      const [ca, CA] = key.split("/");
      return `/GS${id} << /Type /ExtGState /ca ${ca} /CA ${CA} >>`;
    });
    const xobjects = [...this.xobjects].map(([ref, id]) => `/${ref} ${id} 0 R`);
    this.set(
      resources,
      `<< /Font << /F1 ${fonts.F1} 0 R /F2 ${fonts.F2} 0 R >> /ExtGState << ${states.join(" ")} >> /XObject << ${xobjects.join(" ")} >> >>`,
    );
    this.set(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    this.set(
      pagesId,
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
    );
    const info = this.add(`<< /Title (${escapePdfString(title)}) /Producer (agentes.chat) >>`);
    const chunks: Uint8Array[] = [];
    let length = 0;
    const push = (part: string | Uint8Array) => {
      const bytes = typeof part === "string" ? Buffer.from(part, "latin1") : part;
      chunks.push(bytes);
      length += bytes.byteLength;
    };
    push("%PDF-1.4\n%âãÏÓ\n");
    const offsets: number[] = [];
    this.objects.forEach((body, i) => {
      offsets.push(length);
      push(`${i + 1} 0 obj\n`);
      push(body);
      push("\nendobj\n");
    });
    const xref = length;
    push(`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`);
    push(offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join(""));
    push(
      `trailer\n<< /Size ${this.objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    );
    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

// ── Text layout ──────────────────────────────────────────────────────────────

interface Piece {
  text: string;
  font: FontKey;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string;
  width: number;
}

interface Line {
  pieces: Piece[];
  width: number;
}

/** A paragraph's runs broken into lines no wider than `max` (a word wider than a line broken where it must be). */
function layoutParagraph(fonts: Fonts, p: RichParagraph, look: TextLook, max: number): Line[] {
  const lines: Line[] = [];
  const size = look.size;
  let line: Line = { pieces: [], width: 0 };
  let wrapped = false;
  const push = (byWrap: boolean) => {
    // Spaces at the end of a broken line take no room.
    const last = line.pieces[line.pieces.length - 1];
    if (last && /^\s+$/.test(last.text)) {
      line.width -= last.width;
      line.pieces.pop();
    }
    lines.push(line);
    line = { pieces: [], width: 0 };
    wrapped = byWrap;
  };
  for (const run of p.runs) {
    const font: FontKey = run.bold || look.weight >= 600 ? "F2" : "F1";
    const style = {
      font,
      italic: run.italic === true,
      underline: run.underline === true,
      strike: run.strike === true,
      color: run.color ?? look.color,
    };
    const add = (text: string, w: number) => {
      line.pieces.push({ ...style, text, width: w });
      line.width += w;
    };
    run.text.split("\n").forEach((part, k) => {
      if (k > 0) push(false);
      for (const token of part.match(/\s+|\S+/g) ?? []) {
        const w = width(fonts, token, font, size);
        if (/^\s+$/.test(token)) {
          // A wrapped line starts at its first word.
          if (line.pieces.length === 0 && wrapped) continue;
          if (line.width + w > max) push(true);
          else add(token, w);
          continue;
        }
        if (line.width + w <= max) {
          add(token, w);
          continue;
        }
        if (line.pieces.length > 0 && w <= max) {
          push(true);
          add(token, w);
          continue;
        }
        // A word wider than the line: as many characters as fit on each line.
        let chunk = "";
        for (const ch of token) {
          if (chunk && line.width + width(fonts, chunk + ch, font, size) > max) {
            add(chunk, width(fonts, chunk, font, size));
            push(true);
            chunk = ch;
          } else chunk += ch;
        }
        if (chunk) add(chunk, width(fonts, chunk, font, size));
      }
    });
  }
  push(false);
  return lines;
}

/** Text in a box as the apps set it: wrapped, aligned, listed, placed top, middle or bottom. */
function drawText(
  page: Page,
  fonts: Fonts,
  rich: readonly RichParagraph[],
  look: TextLook,
  box: { x: number; y: number; w: number; h: number },
  inset: number,
) {
  const size = look.size;
  const lineH = size * look.lineHeight;
  const indent = size * 1.2;
  const inner = { x: box.x + inset, y: box.y + inset, w: Math.max(1, box.w - inset * 2), h: box.h - inset * 2 };
  const counters: number[] = [];
  const laid = rich.map((p) => {
    const level = Math.max(0, Math.min(4, p.level ?? 0));
    const left = (level + (p.list ? 1 : 0)) * indent;
    if (p.list === "ordered") {
      counters[level] = (counters[level] ?? 0) + 1;
      counters.length = level + 1;
    } else counters.length = level;
    const marker = p.list === "bullet" ? "•" : p.list === "ordered" ? `${counters[level]}.` : null;
    const lines = layoutParagraph(fonts, p, look, Math.max(size, inner.w - left));
    return { p, left, lines, marker };
  });
  const total = laid.reduce((h, l) => h + Math.max(1, l.lines.length) * lineH, 0);
  let y = inner.y;
  if (look.valign === "middle") y += (inner.h - total) / 2;
  else if (look.valign === "bottom") y += inner.h - total;
  for (const { p, left, lines, marker } of laid) {
    const align = p.align ?? look.align;
    lines.forEach((line, k) => {
      const baseline = y + (lineH - size) / 2 + size * 0.82;
      const room = inner.w - left;
      const x =
        inner.x + left + (align === "center" ? (room - line.width) / 2 : align === "right" ? room - line.width : 0);
      if (marker && k === 0) {
        const mw = width(fonts, marker, "F1", size);
        page.text(
          marker,
          inner.x + left - Math.max(mw + size * 0.35, indent * 0.75),
          baseline,
          size,
          "F1",
          look.color,
          false,
        );
      }
      let at = x;
      for (const piece of line.pieces) {
        page.text(piece.text, at, baseline, size, piece.font, piece.color, piece.italic);
        if (piece.underline || piece.strike) {
          const thick = Math.max(1, size / 16);
          if (piece.underline) page.rect(at, baseline + size * 0.1, piece.width, thick, piece.color);
          if (piece.strike) page.rect(at, baseline - size * 0.3, piece.width, thick, piece.color);
        }
        at += piece.width;
      }
      y += lineH;
    });
    if (lines.length === 0) y += lineH;
  }
}

// ── Shapes ───────────────────────────────────────────────────────────────────

const K = 0.5523;

function shapePath(kind: string | undefined, x: number, y: number, w: number, h: number, radius: number): string {
  switch (kind) {
    case "ellipse": {
      const rx = w / 2;
      const ry = h / 2;
      const cx = x + rx;
      const cy = y + ry;
      return [
        `${n(cx + rx)} ${n(cy)} m`,
        `${n(cx + rx)} ${n(cy + ry * K)} ${n(cx + rx * K)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
        `${n(cx - rx * K)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + ry * K)} ${n(cx - rx)} ${n(cy)} c`,
        `${n(cx - rx)} ${n(cy - ry * K)} ${n(cx - rx * K)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
        `${n(cx + rx * K)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - ry * K)} ${n(cx + rx)} ${n(cy)} c h`,
      ].join(" ");
    }
    case "triangle":
      return `${n(x + w / 2)} ${n(y)} m ${n(x + w)} ${n(y + h)} l ${n(x)} ${n(y + h)} l h`;
    case "diamond":
      return `${n(x + w / 2)} ${n(y)} m ${n(x + w)} ${n(y + h / 2)} l ${n(x + w / 2)} ${n(y + h)} l ${n(x)} ${n(y + h / 2)} l h`;
    case "arrow": {
      const head = Math.min(w * 0.4, h);
      const body = h * 0.25;
      return [
        `${n(x)} ${n(y + body)} m`,
        `${n(x + w - head)} ${n(y + body)} l`,
        `${n(x + w - head)} ${n(y)} l`,
        `${n(x + w)} ${n(y + h / 2)} l`,
        `${n(x + w - head)} ${n(y + h)} l`,
        `${n(x + w - head)} ${n(y + h - body)} l`,
        `${n(x)} ${n(y + h - body)} l h`,
      ].join(" ");
    }
    default: {
      const r = Math.max(0, Math.min(radius, w / 2, h / 2));
      if (r <= 0) return `${n(x)} ${n(y)} ${n(w)} ${n(h)} re`;
      const c = r * (1 - K);
      return [
        `${n(x + r)} ${n(y)} m`,
        `${n(x + w - r)} ${n(y)} l`,
        `${n(x + w - c)} ${n(y)} ${n(x + w)} ${n(y + c)} ${n(x + w)} ${n(y + r)} c`,
        `${n(x + w)} ${n(y + h - r)} l`,
        `${n(x + w)} ${n(y + h - c)} ${n(x + w - c)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} c`,
        `${n(x + r)} ${n(y + h)} l`,
        `${n(x + c)} ${n(y + h)} ${n(x)} ${n(y + h - c)} ${n(x)} ${n(y + h - r)} c`,
        `${n(x)} ${n(y + r)} l`,
        `${n(x)} ${n(y + c)} ${n(x + c)} ${n(y)} ${n(x + r)} ${n(y)} c h`,
      ].join(" ");
    }
  }
}

function drawMark(page: Page, fonts: Fonts, mark: ChartMark, theme: SlideTheme) {
  if (mark.kind === "rect") {
    page.rect(mark.x, mark.y, mark.w, mark.h, mark.fill);
    return;
  }
  if (mark.kind === "text") {
    const look: TextLook = {
      ...textLook(theme, { type: "text" }),
      size: mark.size,
      color: mark.color,
      align: mark.align,
      valign: "middle",
      weight: mark.bold ? 700 : 400,
      lineHeight: 1.2,
    };
    drawText(page, fonts, [{ runs: [{ text: mark.text }] }], look, mark, 0);
    return;
  }
  const [first, ...rest] = mark.points;
  if (!first) return;
  const path = `${n(first[0])} ${n(first[1])} m ${rest.map((p) => `${n(p[0])} ${n(p[1])} l`).join(" ")}${mark.closed ? " h" : ""}`;
  page.paint(path, mark.fill ?? null, mark.stroke ? { color: mark.stroke, width: mark.width ?? 2 } : null);
}

async function drawElement(page: Page, doc: PdfDoc, el: ElementView, read: DeckMediaReader) {
  const theme = page.theme;
  const fonts = doc.fonts;
  const rotated = el.rot && el.type !== "line" ? el.rot : 0;
  if (rotated) {
    const r = (rotated * Math.PI) / 180;
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    page.ops.push(
      "q",
      `1 0 0 1 ${n(cx)} ${n(cy)} cm`,
      `${n(Math.cos(r))} ${n(Math.sin(r))} ${n(-Math.sin(r))} ${n(Math.cos(r))} 0 0 cm`,
      `1 0 0 1 ${n(-cx)} ${n(-cy)} cm`,
    );
  }
  const opacity = el.style?.opacity ?? 1;
  switch (el.type) {
    case "text":
      if (el.text) drawText(page, fonts, el.text, textLook(theme, el), el, 0);
      break;
    case "shape": {
      const fill = shapeFill(theme, el.style);
      const stroke =
        el.style?.stroke && el.style.stroke !== "none"
          ? { color: el.style.stroke, width: el.style.strokeWidth ?? 2 }
          : null;
      page.paint(
        shapePath(el.style?.shape, el.x, el.y, el.w, el.h, el.style?.radius ?? 0),
        fill === "none" ? null : fill,
        stroke,
        opacity,
      );
      if (el.text) drawText(page, fonts, el.text, textLook(theme, el), el, 12);
      break;
    }
    case "line": {
      const color = el.style?.stroke && el.style.stroke !== "none" ? el.style.stroke : theme.colors.text;
      const lw = el.style?.strokeWidth ?? 4;
      const x2 = el.x + el.w;
      const y2 = el.y + el.h;
      page.paint(`${n(el.x)} ${n(el.y)} m ${n(x2)} ${n(y2)} l`, null, { color, width: lw }, opacity);
      if (el.style?.lineEnd === "arrow") {
        const len = Math.hypot(el.w, el.h) || 1;
        const ux = el.w / len;
        const uy = el.h / len;
        const head = Math.max(lw * 4, 16);
        const bx = x2 - ux * head;
        const by = y2 - uy * head;
        const path = `${n(x2)} ${n(y2)} m ${n(bx - uy * head * 0.5)} ${n(by + ux * head * 0.5)} l ${n(bx + uy * head * 0.5)} ${n(by - ux * head * 0.5)} l h`;
        page.paint(path, color, null, opacity);
      }
      break;
    }
    case "image": {
      const pic = el.asset ? await doc.picture(el.asset, read) : null;
      if (pic) page.image(pic.image, pic.ref, el, el.fit === "cover" ? "cover" : "contain");
      else page.rect(el.x, el.y, el.w, el.h, theme.colors.surface);
      break;
    }
    case "table": {
      const table = el.table;
      if (!table || table.rows.length === 0) break;
      const cols = Math.max(1, ...table.rows.map((r) => r.length));
      const cw = el.w / cols;
      const rh = el.h / table.rows.length;
      const size = Math.max(12, Math.min(theme.sizes.body * 0.75, rh * 0.4));
      table.rows.forEach((row, r) => {
        const head = table.header && r === 0;
        if (head) page.rect(el.x, el.y, el.w, rh, theme.colors.surface);
        for (let c = 0; c < cols; c++) {
          const cell = row[c] ?? "";
          if (!cell) continue;
          const look: TextLook = {
            ...textLook(theme, { type: "text" }),
            size,
            valign: "middle",
            weight: head ? 700 : 400,
          };
          drawText(
            page,
            fonts,
            [{ runs: [{ text: cell }] }],
            look,
            { x: el.x + c * cw, y: el.y + r * rh, w: cw, h: rh },
            12,
          );
        }
      });
      const grid: string[] = [];
      for (let r = 0; r <= table.rows.length; r++)
        grid.push(`${n(el.x)} ${n(el.y + r * rh)} m ${n(el.x + el.w)} ${n(el.y + r * rh)} l`);
      for (let c = 0; c <= cols; c++)
        grid.push(`${n(el.x + c * cw)} ${n(el.y)} m ${n(el.x + c * cw)} ${n(el.y + el.h)} l`);
      page.paint(grid.join(" "), null, { color: theme.colors.line, width: 2 });
      break;
    }
    case "chart":
      if (el.chart) for (const mark of chartMarks(el.chart, el, theme)) drawMark(page, fonts, mark, theme);
      break;
  }
  if (rotated) page.ops.push("Q");
}

async function drawSlide(doc: PdfDoc, theme: SlideTheme, slide: SlideView, read: DeckMediaReader): Promise<string[]> {
  const page = new Page(doc, theme);
  // Slide units, y down: half a point a unit, the origin at the top left.
  page.ops.push(`${PT_PER_UNIT} 0 0 ${-PT_PER_UNIT} 0 ${n(1080 * PT_PER_UNIT)} cm`);
  const bg = slide.bg;
  page.rect(0, 0, 1920, 1080, typeof bg === "string" ? bg : theme.colors.bg);
  if (bg && typeof bg === "object") {
    const pic = await doc.picture(bg.asset, read);
    if (pic) page.image(pic.image, pic.ref, { x: 0, y: 0, w: 1920, h: 1080 }, "cover");
  }
  for (const el of slide.elements) await drawElement(page, doc, el, read);
  return page.ops;
}

/** A presentation as a PDF; `media` reads its pictures by asset id (a missing one is left out). */
export async function slidesPdf(deck: DeckView, media: DeckMediaReader, title = "Presentation"): Promise<Uint8Array> {
  const doc = new PdfDoc();
  const theme = themeOf(deck.theme);
  const pages: string[][] = [];
  // A deck of another size is drawn scaled into the page, centered.
  const scale = Math.min(1920 / (deck.w || 1920), 1080 / (deck.h || 1080));
  for (const slide of deck.slides) {
    if (slide.hidden) continue;
    const ops = await drawSlide(doc, theme, slide, media);
    if (scale !== 1) {
      const ox = (1920 - (deck.w || 1920) * scale) / 2;
      const oy = (1080 - (deck.h || 1080) * scale) / 2;
      ops.splice(1, 0, `${n(scale)} 0 0 ${n(scale)} ${n(ox)} ${n(oy)} cm`);
    }
    pages.push(ops);
  }
  // A deck with every slide hidden still gives a page.
  if (pages.length === 0)
    pages.push(await drawSlide(doc, theme, { id: "", index: 0, layout: "blank", notes: "", elements: [] }, media));
  return doc.bytes(pages, title);
}
