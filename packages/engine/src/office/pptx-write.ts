import {
  catalogFont,
  type DeckView,
  type ElementView,
  fontAssetOf,
  type RichParagraph,
  type RichRun,
  type SlideTheme,
  type SlideView,
  shapeFill,
  type TextLook,
  textLook,
  themeOf,
} from "@agenteschat/live";
import { imageSize } from "../image-size";
import { zip } from "../zip";
import { type ChartMark, chartMarks } from "./chart-draw";
import { imageTypeOf } from "./package";
import { XML_HEAD, xmlAttr, xmlText } from "./xml";

/**
 * Presentations written as PowerPoint files (ADR 0198): one master and one layout, a theme with the deck's own colors
 * and fonts, and each slide with its background, its text boxes (runs bold, italic, underlined, struck, colored and
 * linked; paragraphs aligned, leveled, bulleted or numbered; titles and bodies as the slide's placeholders), shapes,
 * lines, pictures (cropped or fitted as the apps show them), tables, charts drawn as shapes, and speaker notes. Every
 * look is written on the element itself, so the file shows the same in PowerPoint, Keynote, LibreOffice and Google
 * Slides whatever their defaults.
 */

/** A picture of the deck by its asset id: its bytes and type, or null when it is gone. */
export type DeckMediaReader = (asset: string) => Promise<{ bytes: Uint8Array; type: string } | null>;

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const ROOT_NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;

/** The slide: 16:9 at 13.333 × 7.5 inches. */
const SLIDE_EMU_W = 12_192_000;
const TABLE_STYLE = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";

const EXT_OF: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const hex6 = (color: string) => {
  const v = color.replace(/^#/, "");
  const full = v.length === 3 || v.length === 4 ? [...v.slice(0, 3)].map((c) => c + c).join("") : v.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(full) ? full.toUpperCase() : "000000";
};

/** A color's alpha from `#rrggbbaa` (1 when it has none). */
const alphaOf = (color: string) => {
  const v = color.replace(/^#/, "");
  return v.length === 8 ? Number.parseInt(v.slice(6), 16) / 255 : 1;
};

function solid(color: string, opacity = 1): string {
  const alpha = Math.min(1, Math.max(0, alphaOf(color) * opacity));
  const a = alpha < 1 ? `<a:alpha val="${Math.round(alpha * 100_000)}"/>` : "";
  return `<a:solidFill><a:srgbClr val="${hex6(color)}">${a}</a:srgbClr></a:solidFill>`;
}

/** What one slide's XML needs to say about its pictures and links: relationships by id. */
class SlideRels {
  private readonly rels: string[] = [];
  private readonly ids = new Map<string, string>();
  constructor(private next = 2) {}
  add(type: string, target: string, external = false): string {
    const key = `${type} ${target}`;
    const known = this.ids.get(key);
    if (known) return known;
    const id = `rId${this.next++}`;
    this.ids.set(key, id);
    this.rels.push(
      `<Relationship Id="${id}" Type="${REL}/${type}" Target="${xmlAttr(target)}"${external ? ' TargetMode="External"' : ""}/>`,
    );
    return id;
  }
  xml(first: string): string {
    return `${XML_HEAD}<Relationships xmlns="${NS_PKG}">${first}${this.rels.join("")}</Relationships>`;
  }
}

interface Media {
  path: string;
  bytes: Uint8Array;
  type: string;
  size: { width: number; height: number } | null;
}

class Writer {
  /** EMUs per slide unit. */
  readonly emu: number;
  readonly theme: SlideTheme;
  private readonly media = new Map<string, Media | null>();
  private mediaCount = 0;

  constructor(
    readonly deck: DeckView,
    private readonly read: DeckMediaReader,
    /** The file's own fonts' family names, by asset id (ADR 0220 §2). */
    readonly fileFonts: ReadonlyMap<string, string> = new Map(),
  ) {
    this.emu = SLIDE_EMU_W / (deck.w > 0 ? deck.w : 1920);
    this.theme = themeOf(deck.theme);
  }

  e(units: number): number {
    return Math.round(units * this.emu);
  }

  /** Font size in hundredths of a point. */
  sz(units: number): number {
    return Math.max(100, Math.min(400_000, Math.round((units * this.emu) / 127)));
  }

  async picture(asset: string): Promise<Media | null> {
    if (this.media.has(asset)) return this.media.get(asset) ?? null;
    const got = await this.read(asset).catch(() => null);
    const type = got ? imageTypeOf(got.bytes) : null;
    let media: Media | null = null;
    if (got && type) {
      this.mediaCount++;
      media = {
        path: `media/image${this.mediaCount}.${EXT_OF[type]}`,
        bytes: got.bytes,
        type,
        size: imageSize(got.bytes),
      };
    }
    this.media.set(asset, media);
    return media;
  }

  mediaFiles(): Media[] {
    return [...this.media.values()].filter((m): m is Media => m !== null);
  }

  xfrm(el: { x: number; y: number; w: number; h: number; rot?: number }, extra = ""): string {
    const rot = el.rot ? ` rot="${Math.round(el.rot * 60_000)}"` : "";
    const w = Math.max(0, this.e(el.w));
    const h = Math.max(0, this.e(el.h));
    return `<a:xfrm${rot}${extra}><a:off x="${this.e(el.x)}" y="${this.e(el.y)}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
  }

  // ── Text ────────────────────────────────────────────────────────────────────

  /** The typeface a font ref names in an office file (a file's own font under its own family name). */
  typeface(ref: string | undefined, fallback: string): string {
    if (!ref) return fallback;
    const asset = fontAssetOf(ref);
    if (asset) return this.fileFonts.get(asset) ?? fallback;
    return catalogFont(ref)?.family ?? fallback;
  }

  private run(run: RichRun, look: TextLook, rels: SlideRels): string {
    const parts = run.text.split("\n");
    // Weight is bold or not in office files (ADR 0220 §7): 600 and up is bold.
    const weight = run.weight ?? (run.bold ? 700 : look.weight);
    const bold = weight >= 600;
    const size = run.size ?? look.size;
    const tracking = run.tracking ?? look.tracking;
    const props = (tag: string) => {
      const attrs = [
        'lang="en-US"',
        `sz="${this.sz(size)}"`,
        bold ? 'b="1"' : "",
        run.italic ? 'i="1"' : "",
        run.underline ? 'u="sng"' : "",
        run.strike ? 'strike="sngStrike"' : "",
        run.caps || look.caps ? 'cap="all"' : "",
        // Letter spacing in hundredths of a point.
        tracking ? `spc="${Math.round((tracking / 1000) * this.sz(size))}"` : "",
        'dirty="0"',
      ]
        .filter(Boolean)
        .join(" ");
      const link =
        run.link && /^(?:https?:|mailto:)/i.test(run.link)
          ? `<a:hlinkClick r:id="${rels.add("hyperlink", run.link, true)}"/>`
          : "";
      const face = xmlAttr(this.typeface(run.font, this.typeface(look.fontRef, look.fontFamily)));
      const highlight = run.highlight ? `<a:highlight><a:srgbClr val="${hex6(run.highlight)}"/></a:highlight>` : "";
      return `<a:${tag} ${attrs}>${solid(run.color ?? look.color)}${highlight}<a:latin typeface="${face}"/><a:cs typeface="${face}"/>${link}</a:${tag}>`;
    };
    return parts
      .map((text, i) => {
        const br = i > 0 ? `<a:br>${props("rPr")}</a:br>` : "";
        return text === "" ? br : `${br}<a:r>${props("rPr")}<a:t>${xmlText(text)}</a:t></a:r>`;
      })
      .join("");
  }

  paragraphs(rich: readonly RichParagraph[], look: TextLook, rels: SlideRels): string {
    const size = this.e(look.size);
    const list = rich.length > 0 ? rich : [{ runs: [] }];
    return list
      .map((p) => {
        const level = Math.max(0, Math.min(4, p.level ?? 0));
        const align = p.align ?? look.align;
        const algn = align === "center" ? "ctr" : align === "right" ? "r" : "l";
        const step = Math.round(size * 1.2);
        let bullet = "<a:buNone/>";
        let indent = level > 0 ? ` marL="${level * step}" indent="0"` : ' marL="0" indent="0"';
        if (p.list === "bullet") {
          bullet = `<a:buFont typeface="Arial"/><a:buChar char="•"/>`;
          indent = ` marL="${(level + 1) * step}" indent="-${Math.round(step * 0.75)}"`;
        } else if (p.list === "ordered") {
          bullet = '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>';
          indent = ` marL="${(level + 1) * step}" indent="-${Math.round(step * 0.9)}"`;
        }
        const lineHeight = p.lineHeight ?? look.lineHeight;
        const spacing = `<a:lnSpc><a:spcPct val="${Math.round((lineHeight / 1.2) * 100_000)}"/></a:lnSpc>`;
        const after = p.spaceAfter ? `<a:spcAft><a:spcPts val="${this.sz(p.spaceAfter)}"/></a:spcAft>` : "";
        const pPr = `<a:pPr algn="${algn}"${level > 0 ? ` lvl="${level}"` : ""}${indent}>${spacing}${after}${bullet}</a:pPr>`;
        const runs = p.runs.map((r) => this.run(r, look, rels)).join("");
        const end = `<a:endParaRPr lang="en-US" sz="${this.sz(look.size)}" dirty="0"/>`;
        return `<a:p>${pPr}${runs}${end}</a:p>`;
      })
      .join("");
  }

  txBody(rich: readonly RichParagraph[], look: TextLook, rels: SlideRels, inset: number): string {
    const anchor = look.valign === "middle" ? "ctr" : look.valign === "bottom" ? "b" : "t";
    const ins = this.e(inset);
    return `<p:txBody><a:bodyPr wrap="square" lIns="${ins}" tIns="${ins}" rIns="${ins}" bIns="${ins}" anchor="${anchor}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${this.paragraphs(rich, look, rels)}</p:txBody>`;
  }
}

/** One slide's elements as shape tree XML; titles and bodies become the slide's placeholders. */
async function slideTree(w: Writer, slide: SlideView, rels: SlideRels): Promise<string> {
  const out: string[] = [];
  let id = 2;
  let title = false;
  let body = false;
  for (const el of slide.elements) {
    const xml = await elementXml(w, el, rels, id, () => {
      if (el.role === "title" && !title) {
        title = true;
        return '<p:ph type="title"/>';
      }
      if ((el.role === "body" || el.role === "subtitle") && !body) {
        body = true;
        return '<p:ph idx="1"/>';
      }
      return null;
    });
    if (xml) {
      out.push(xml.xml);
      id = xml.next;
    }
  }
  return out.join("");
}

function shapeGeometry(kind: string | undefined, el: ElementView): string {
  switch (kind) {
    case "ellipse":
      return '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>';
    case "triangle":
      return '<a:prstGeom prst="triangle"><a:avLst/></a:prstGeom>';
    case "diamond":
      return '<a:prstGeom prst="diamond"><a:avLst/></a:prstGeom>';
    case "arrow":
      return '<a:prstGeom prst="rightArrow"><a:avLst/></a:prstGeom>';
    default: {
      const radius = el.style?.radius ?? 0;
      const side = Math.min(Math.abs(el.w), Math.abs(el.h));
      if (radius > 0 && side > 0) {
        const adj = Math.round(Math.min(0.5, radius / side) * 100_000);
        return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`;
      }
      return '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
    }
  }
}

async function elementXml(
  w: Writer,
  el: ElementView,
  rels: SlideRels,
  id: number,
  placeholder: () => string | null,
): Promise<{ xml: string; next: number } | null> {
  const theme = w.theme;
  const name = (kind: string) => `<p:cNvPr id="${id}" name="${kind} ${id}"/>`;
  switch (el.type) {
    case "text":
    case "shape": {
      const look = textLook(theme, el, w.deck.fonts);
      const text = el.text ?? [];
      const hasText = text.some((p) => p.runs.some((r) => r.text.trim() !== ""));
      if (el.type === "text" && !hasText) return null;
      const ph = el.type === "text" ? placeholder() : null;
      const nv = ph
        ? `<p:nvSpPr>${name(ph.includes("title") ? "Title" : "Content")}<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>`
        : `<p:nvSpPr>${name(el.type === "text" ? "TextBox" : "Shape")}<p:cNvSpPr${el.type === "text" ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr>`;
      let fill = "<a:noFill/>";
      let line = "<a:ln><a:noFill/></a:ln>";
      let geometry = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
      let effects = "";
      if (el.type === "shape") {
        const color = shapeFill(theme, el.style);
        const g = el.style?.gradient;
        fill = g
          ? `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0">${solid(g.from).replace(/^<a:solidFill>|<\/a:solidFill>$/g, "")}</a:gs><a:gs pos="100000">${solid(g.to).replace(/^<a:solidFill>|<\/a:solidFill>$/g, "")}</a:gs></a:gsLst><a:lin ang="${Math.round((((g.angle - 90) % 360) + 360) % 360) * 60000}" scaled="0"/></a:gradFill>`
          : color === "none"
            ? "<a:noFill/>"
            : solid(color, el.style?.opacity ?? 1);
        const stroke = el.style?.stroke;
        if (stroke && stroke !== "none") {
          const dash =
            el.style?.dash === "dashed"
              ? '<a:prstDash val="dash"/>'
              : el.style?.dash === "dotted"
                ? '<a:prstDash val="sysDot"/>'
                : "";
          line = `<a:ln w="${w.e(el.style?.strokeWidth ?? 2)}">${solid(stroke, el.style?.opacity ?? 1)}${dash}</a:ln>`;
        }
        geometry = shapeGeometry(el.style?.shape, el);
        const sh = el.style?.shadow;
        if (sh) {
          const dist = w.e(Math.hypot(sh.x, sh.y));
          const dir = Math.round(((((Math.atan2(sh.y, sh.x) * 180) / Math.PI) % 360) + 360) % 360) * 60000;
          const alpha = sh.color.length === 9 ? Number.parseInt(sh.color.slice(7), 16) / 255 : 1;
          effects = `<a:effectLst><a:outerShdw blurRad="${w.e(sh.blur)}" dist="${dist}" dir="${dir}" algn="ctr" rotWithShape="0">${solid(sh.color.slice(0, 7), alpha).replace(/^<a:solidFill>|<\/a:solidFill>$/g, "")}</a:outerShdw></a:effectLst>`;
        }
      }
      const spPr = `<p:spPr>${w.xfrm(el)}${geometry}${fill}${line}${effects}</p:spPr>`;
      const inset = look.padding || (el.type === "shape" ? 12 : 0);
      const tx = hasText || el.type === "shape" ? w.txBody(text, look, rels, inset) : "";
      return { xml: `<p:sp>${nv}${spPr}${tx}</p:sp>`, next: id + 1 };
    }
    case "line": {
      const x1 = el.x;
      const y1 = el.y;
      const x2 = el.x + el.w;
      const y2 = el.y + el.h;
      const flip = `${x2 < x1 ? ' flipH="1"' : ""}${y2 < y1 ? ' flipV="1"' : ""}`;
      const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(el.w), h: Math.abs(el.h), rot: el.rot };
      const stroke = el.style?.stroke && el.style.stroke !== "none" ? el.style.stroke : theme.colors.text;
      const arrow = el.style?.lineEnd === "arrow" ? '<a:tailEnd type="triangle" w="med" len="med"/>' : "";
      const ln = `<a:ln w="${w.e(el.style?.strokeWidth ?? 4)}">${solid(stroke, el.style?.opacity ?? 1)}${arrow}</a:ln>`;
      return {
        xml: `<p:cxnSp><p:nvCxnSpPr>${name("Line")}<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${w.xfrm(box, flip)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>${ln}</p:spPr></p:cxnSp>`,
        next: id + 1,
      };
    }
    case "image": {
      if (!el.asset) return null;
      const media = await w.picture(el.asset);
      if (!media) return null;
      const rId = rels.add("image", `../${media.path}`);
      let box = { x: el.x, y: el.y, w: el.w, h: el.h, rot: el.rot };
      let crop = "";
      const size = media.size;
      if (size && el.w > 0 && el.h > 0) {
        const pic = size.width / size.height;
        const frame = el.w / el.h;
        if (el.fit === "cover") {
          // The picture fills its box, cut evenly on the sides that overflow.
          const cut = pic > frame ? (1 - frame / pic) / 2 : (1 - pic / frame) / 2;
          const v = Math.round(cut * 100_000);
          crop = pic > frame ? `<a:srcRect l="${v}" r="${v}"/>` : `<a:srcRect t="${v}" b="${v}"/>`;
        } else if (Math.abs(pic - frame) > 0.001) {
          // Fitted inside its box, centered: PowerPoint stretches a picture to its frame.
          const fw = pic > frame ? el.w : el.h * pic;
          const fh = pic > frame ? el.w / pic : el.h;
          box = { x: el.x + (el.w - fw) / 2, y: el.y + (el.h - fh) / 2, w: fw, h: fh, rot: el.rot };
        }
      }
      const alt = el.alt ? ` descr="${xmlAttr(el.alt)}"` : "";
      return {
        xml: `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"${alt}/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${w.xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
        next: id + 1,
      };
    }
    case "table": {
      const table = el.table;
      if (!table || table.rows.length === 0) return null;
      const cols = Math.max(1, ...table.rows.map((r) => r.length));
      const totalW = Math.max(cols, w.e(el.w));
      const totalH = Math.max(table.rows.length, w.e(el.h));
      const colW = Math.floor(totalW / cols);
      const rowH = Math.floor(totalH / table.rows.length);
      const textSize = Math.max(12, Math.min(theme.sizes.body * 0.75, (el.h / table.rows.length) * 0.4));
      const look: TextLook = { ...textLook(theme, { type: "text" }), size: textSize, align: "left", valign: "middle" };
      const border = (tag: string) => `<a:${tag} w="12700">${solid(theme.colors.line)}</a:${tag}>`;
      const grid = Array.from(
        { length: cols },
        (_, i) => `<a:gridCol w="${i === cols - 1 ? totalW - colW * (cols - 1) : colW}"/>`,
      ).join("");
      const rows = table.rows
        .map((row, r) => {
          const head = table.header && r === 0;
          const cells = Array.from({ length: cols }, (_, c) => {
            const runs: RichRun[] = row[c]
              ? [{ text: row[c] as string, ...(head ? { bold: true as const } : {}) }]
              : [];
            const paras = w.paragraphs([{ runs }], look, rels);
            const fill = head ? solid(theme.colors.surface) : "<a:noFill/>";
            return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paras}</a:txBody><a:tcPr marL="${w.e(12)}" marR="${w.e(12)}" marT="${w.e(6)}" marB="${w.e(6)}" anchor="ctr">${border("lnL")}${border("lnR")}${border("lnT")}${border("lnB")}${fill}</a:tcPr></a:tc>`;
          }).join("");
          return `<a:tr h="${r === table.rows.length - 1 ? totalH - rowH * (table.rows.length - 1) : rowH}">${cells}</a:tr>`;
        })
        .join("");
      return {
        xml: `<p:graphicFrame><p:nvGraphicFramePr>${name("Table")}<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${w.e(el.x)}" y="${w.e(el.y)}"/><a:ext cx="${totalW}" cy="${totalH}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr${table.header ? ' firstRow="1"' : ""} bandRow="1"><a:tableStyleId>${TABLE_STYLE}</a:tableStyleId></a:tblPr><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
        next: id + 1,
      };
    }
    case "chart": {
      if (!el.chart) return null;
      const marks = chartMarks(el.chart, el, theme);
      let next = id + 1;
      const shapes = marks.map((m) => markXml(w, m, next++, rels)).join("");
      // The group's children are placed in slide coordinates: its child space is its own box.
      const extent = `<a:chOff x="${w.e(el.x)}" y="${w.e(el.y)}"/><a:chExt cx="${Math.max(0, w.e(el.w))}" cy="${Math.max(0, w.e(el.h))}"/>`;
      const group = w.xfrm(el).replace("</a:xfrm>", `${extent}</a:xfrm>`);
      return {
        xml: `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${group}</p:grpSpPr>${shapes}</p:grpSp>`,
        next,
      };
    }
  }
  return null;
}

/** One mark of a chart as a shape. */
function markXml(w: Writer, mark: ChartMark, id: number, rels: SlideRels): string {
  const nv = (kind: string) => `<p:nvSpPr><p:cNvPr id="${id}" name="${kind} ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`;
  if (mark.kind === "rect") {
    return `<p:sp>${nv("Bar")}<p:spPr>${w.xfrm(mark)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${solid(mark.fill)}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
  }
  if (mark.kind === "text") {
    const look: TextLook = {
      ...textLook(w.theme, { type: "text" }),
      size: mark.size,
      color: mark.color,
      align: mark.align,
      valign: "middle",
      weight: mark.bold ? 700 : 400,
    };
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Label ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${w.xfrm(mark)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>${w.txBody([{ runs: [{ text: mark.text }] }], look, rels, 0)}</p:sp>`;
  }
  const xs = mark.points.map((p) => p[0]);
  const ys = mark.points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const bw = Math.max(1, Math.max(...xs) - x0);
  const bh = Math.max(1, Math.max(...ys) - y0);
  const pw = w.e(bw);
  const ph = w.e(bh);
  const pt = (p: [number, number]) => `<a:pt x="${w.e(p[0] - x0)}" y="${w.e(p[1] - y0)}"/>`;
  const [first, ...rest] = mark.points;
  const path = `<a:moveTo>${pt(first as [number, number])}</a:moveTo>${rest.map((p) => `<a:lnTo>${pt(p)}</a:lnTo>`).join("")}${mark.closed ? "<a:close/>" : ""}`;
  const fill = mark.fill ? solid(mark.fill) : "<a:noFill/>";
  const line = mark.stroke
    ? `<a:ln w="${w.e(mark.width ?? 2)}">${solid(mark.stroke)}</a:ln>`
    : "<a:ln><a:noFill/></a:ln>";
  return `<p:sp>${nv("Path")}<p:spPr>${w.xfrm({ x: x0, y: y0, w: bw, h: bh })}<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${pw}" h="${ph}"${mark.fill ? "" : ' fill="none"'}>${path}</a:path></a:pathLst></a:custGeom>${fill}${line}</p:spPr></p:sp>`;
}

function backgroundXml(w: Writer, slide: SlideView, rels: SlideRels, media: Media | null): string {
  if (media) {
    const rId = rels.add("image", `../${media.path}`);
    return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${rId}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
  }
  const color = typeof slide.bg === "string" ? slide.bg : w.theme.colors.bg;
  return `<p:bg><p:bgPr>${solid(color)}<a:effectLst/></p:bgPr></p:bg>`;
}

const TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function notesXml(w: Writer, notes: string): string {
  const look: TextLook = {
    ...textLook(w.theme, { type: "text" }),
    size: 24,
    color: "#000000",
    fontFamily: w.theme.fonts.body,
  };
  const rels = new SlideRels();
  const paragraphs = notes.split("\n").map((line) => ({ runs: line ? [{ text: line }] : [] }));
  return `${XML_HEAD}<p:notes ${ROOT_NS}><p:cSld><p:spTree>${TREE_HEAD}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${w.paragraphs(paragraphs, look, rels)}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

/** A theme part with the deck's colors and fonts. */
function themeXml(theme: SlideTheme, name: string): string {
  const c = theme.colors;
  const dark = theme.dark;
  const slot = (tag: string, color: string) => `<a:${tag}><a:srgbClr val="${hex6(color)}"/></a:${tag}>`;
  // Light 1 is always the light one: a dark deck maps its background to dark 1 (`clrMap`).
  const scheme = [
    slot("dk1", dark ? c.bg : c.text),
    slot("lt1", dark ? c.text : c.bg),
    slot("dk2", dark ? c.surface : c.muted),
    slot("lt2", dark ? c.muted : c.surface),
    slot("accent1", c.accent),
    slot("accent2", c.accent2),
    slot("accent3", c.muted),
    slot("accent4", c.line),
    slot("accent5", c.accent),
    slot("accent6", c.accent2),
    slot("hlink", c.accent),
    slot("folHlink", c.accent2),
  ].join("");
  const font = (face: string) => `<a:latin typeface="${xmlAttr(face)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const phFill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const ln = (wd: number) =>
    `<a:ln w="${wd}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return `${XML_HEAD}<a:theme xmlns:a="${NS_A}" name="${xmlAttr(name)}"><a:themeElements><a:clrScheme name="${xmlAttr(name)}">${scheme}</a:clrScheme><a:fontScheme name="${xmlAttr(name)}"><a:majorFont>${font(theme.fonts.heading)}</a:majorFont><a:minorFont>${font(theme.fonts.body)}</a:minorFont></a:fontScheme><a:fmtScheme name="${xmlAttr(name)}"><a:fillStyleLst>${phFill}${phFill}${phFill}</a:fillStyleLst><a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${phFill}${phFill}${phFill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

function clrMap(dark: boolean): string {
  return dark
    ? 'bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'
    : 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
}

/** A master's text levels: no bullets of its own (each paragraph says its own), the theme's fonts and text color. */
function levels(sz: number, face: "+mj-lt" | "+mn-lt"): string {
  return Array.from(
    { length: 5 },
    (_, i) =>
      `<a:lvl${i + 1}pPr marL="0" indent="0" algn="l"><a:buNone/><a:defRPr sz="${sz}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="${face}"/></a:defRPr></a:lvl${i + 1}pPr>`,
  ).join("");
}

function masterXml(w: Writer): string {
  const t = w.theme;
  const ph = (id: number, name: string, ph: string, box: { x: number; y: number; w: number; h: number }) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${w.xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr anchor="t"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
  const height = w.deck.h > 0 ? w.deck.h : 1080;
  const width = w.deck.w > 0 ? w.deck.w : 1920;
  const tree = `${TREE_HEAD}${ph(2, "Title Placeholder 1", '<p:ph type="title"/>', { x: 120, y: 80, w: width - 240, h: 200 })}${ph(3, "Text Placeholder 2", '<p:ph type="body" idx="1"/>', { x: 120, y: 320, w: width - 240, h: height - 440 })}`;
  const title = levels(w.sz(t.sizes.title), "+mj-lt");
  const body = levels(w.sz(t.sizes.body), "+mn-lt");
  return `${XML_HEAD}<p:sldMaster ${ROOT_NS}><p:cSld><p:bg><p:bgPr>${solid(t.colors.bg)}<a:effectLst/></p:bgPr></p:bg><p:spTree>${tree}</p:spTree></p:cSld><p:clrMap ${clrMap(t.dark)}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>${title}</p:titleStyle><p:bodyStyle>${body}</p:bodyStyle><p:otherStyle>${body}</p:otherStyle></p:txStyles></p:sldMaster>`;
}

const LAYOUT_XML = `${XML_HEAD}<p:sldLayout ${ROOT_NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${TREE_HEAD}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

function notesMasterXml(w: Writer): string {
  return `${XML_HEAD}<p:notesMaster ${ROOT_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${TREE_HEAD}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap ${clrMap(false)}/><p:notesStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="${xmlAttr(w.theme.fonts.body)}"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;
}

/**
 * A presentation as a `.pptx` file; `media` reads its pictures by asset id (a missing one is left out); `fileFonts`
 * names the file's own fonts by asset id, so runs in them keep their family (ADR 0220 §7).
 */
export async function writePptx(
  deck: DeckView,
  media: DeckMediaReader,
  fileFonts: ReadonlyMap<string, string> = new Map(),
): Promise<Uint8Array> {
  const w = new Writer(deck, media, fileFonts);
  const slides = deck.slides;
  const slideFiles: [string, string][] = [];
  for (const [i, slide] of slides.entries()) {
    const n = i + 1;
    const rels = new SlideRels();
    const bgMedia = slide.bg && typeof slide.bg === "object" ? await w.picture(slide.bg.asset) : null;
    const bg = backgroundXml(w, slide, rels, bgMedia);
    const tree = await slideTree(w, slide, rels);
    if (slide.notes.trim()) rels.add("notesSlide", `../notesSlides/notesSlide${n}.xml`);
    const hidden = slide.hidden ? ' show="0"' : "";
    slideFiles.push([
      `ppt/slides/slide${n}.xml`,
      `${XML_HEAD}<p:sld ${ROOT_NS}${hidden}><p:cSld>${bg}<p:spTree>${TREE_HEAD}${tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    ]);
    slideFiles.push([
      `ppt/slides/_rels/slide${n}.xml.rels`,
      rels.xml(`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`),
    ]);
    if (slide.notes.trim()) {
      slideFiles.push([`ppt/notesSlides/notesSlide${n}.xml`, notesXml(w, slide.notes)]);
      slideFiles.push([
        `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${n}.xml"/></Relationships>`,
      ]);
    }
  }
  const pictures = w.mediaFiles();
  const notes = slides.map((s, i) => (s.notes.trim() ? i + 1 : 0)).filter((n) => n > 0);
  const types = [...new Set(pictures.map((p) => p.type))];
  const contentTypes = [
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...types.map((t) => `<Default Extension="${EXT_OF[t]}" ContentType="${t}"/>`),
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>',
    ...slides.map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    ),
    ...notes.map(
      (n) =>
        `<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
    ),
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>',
    '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>',
    '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    "</Types>",
  ].join("");
  const firstSlideRel = 3;
  const presentationRels = [
    `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
    `<Relationship Id="rId2" Type="${REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/>`,
    ...slides.map(
      (_, i) => `<Relationship Id="rId${firstSlideRel + i}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`,
    ),
    `<Relationship Id="rId${firstSlideRel + slides.length}" Type="${REL}/theme" Target="theme/theme1.xml"/>`,
    `<Relationship Id="rId${firstSlideRel + slides.length + 1}" Type="${REL}/presProps" Target="presProps.xml"/>`,
    `<Relationship Id="rId${firstSlideRel + slides.length + 2}" Type="${REL}/viewProps" Target="viewProps.xml"/>`,
    `<Relationship Id="rId${firstSlideRel + slides.length + 3}" Type="${REL}/tableStyles" Target="tableStyles.xml"/>`,
  ].join("");
  const cy = Math.round((deck.h > 0 ? deck.h : 1080) * w.emu);
  const sldIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${firstSlideRel + i}"/>`).join("");
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const files: [string, string | Uint8Array][] = [
    ["[Content_Types].xml", contentTypes],
    [
      "_rels/.rels",
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    ],
    [
      "docProps/core.xml",
      `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
    ],
    [
      "docProps/app.xml",
      `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>agentes.chat</Application><Slides>${slides.length}</Slides></Properties>`,
    ],
    [
      "ppt/presentation.xml",
      `${XML_HEAD}<p:presentation ${ROOT_NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>${sldIds ? `<p:sldIdLst>${sldIds}</p:sldIdLst>` : ""}<p:sldSz cx="${SLIDE_EMU_W}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}">${presentationRels}</Relationships>`,
    ],
    ["ppt/presProps.xml", `${XML_HEAD}<p:presentationPr ${ROOT_NS}/>`],
    [
      "ppt/viewProps.xml",
      `${XML_HEAD}<p:viewPr ${ROOT_NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    ],
    ["ppt/tableStyles.xml", `${XML_HEAD}<a:tblStyleLst xmlns:a="${NS_A}" def="${TABLE_STYLE}"/>`],
    ["ppt/theme/theme1.xml", themeXml(w.theme, "agentes.chat")],
    ["ppt/theme/theme2.xml", themeXml(w.theme, "agentes.chat notes")],
    ["ppt/slideMasters/slideMaster1.xml", masterXml(w)],
    [
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`,
    ],
    ["ppt/slideLayouts/slideLayout1.xml", LAYOUT_XML],
    [
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    ],
    ["ppt/notesMasters/notesMaster1.xml", notesMasterXml(w)],
    [
      "ppt/notesMasters/_rels/notesMaster1.xml.rels",
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/></Relationships>`,
    ],
    ...slideFiles,
    ...pictures.map((p): [string, Uint8Array] => [`ppt/${p.path}`, p.bytes]),
  ];
  // Pictures are compressed already: stored as they are.
  return zip(files, { store: (path) => path.startsWith("ppt/media/") });
}
