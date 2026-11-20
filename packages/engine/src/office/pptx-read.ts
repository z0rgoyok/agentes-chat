import {
  type DeckData,
  type DeckElementData,
  type DeckSlideData,
  type ElementStyle,
  normalizeRich,
  type RichDoc,
  type RichParagraph,
  type RichRun,
  type ShapeKind,
  type SlideLayout,
  type SlideRole,
} from "@agenteschat/live";
import {
  type ColorContext,
  colorMap,
  type DrawnColor,
  drawingColor,
  luminance,
  themeColors,
  themeFonts,
} from "./colors";
import { OFFICE_LIMITS, officeTooLarge, officeUnreadable } from "./limits";
import { imageTypeOf, OfficePackage, REL } from "./package";
import { attr, boolAttr, dig, type Element, intAttr, kid, kids, nameOf, numAttr, relAttr, textOf } from "./xml";

/**
 * PowerPoint decks (`.pptx`) read into `DeckData` (ADR 0198): the slides in their order (hidden ones marked), each
 * with its background, its speaker notes and its elements bottom to top: text boxes and placeholders with their
 * formatting (runs bold, italic, underlined, struck, colored, linked; paragraphs aligned, leveled, bulleted or
 * numbered), shapes, lines, pictures (the media taken out of the file), tables, and what the slide's layout and master
 * draw behind it. Placeholders take their position, size and text style from their layout and master; colors and
 * fonts resolve through the theme and its color map; groups place their children. Coordinates are EMUs scaled so the
 * deck is 1920 wide. Charts, SmartArt, animations and embedded objects are left out (an object's picture stays).
 */

const DECK_W = 1920;
/** EMUs in a hundredth of a point (sizes in DrawingML are hundredths of points). */
const EMU_PER_CENTIPOINT = 127;
/** The size text takes when nothing in its chain gives one (18 pt). */
const DEFAULT_SIZE = 1800;
/** Elements of one slide kept at most (a slide past this is noise, not content). */
const ELEMENTS_MAX = 400;

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface Theme {
  colors: Record<string, string>;
  major: string | null;
  minor: string | null;
  /** `fmtScheme`'s line widths by style index (1-based in references). */
  lines: number[];
  /** `fmtScheme`'s background fills (references 1001…). */
  backgrounds: Element[];
  /** `fmtScheme`'s fills (references 1…). */
  fills: Element[];
  part: string | null;
}

/** A placement: child coordinates (EMU) to the slide's (EMU), as groups nest. */
interface Xform {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  rot: number;
}

const IDENTITY: Xform = { sx: 1, sy: 1, tx: 0, ty: 0, rot: 0 };

/** Properties text takes, merged down its chain of styles (later ones over earlier ones). */
interface TextProps {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: DrawnColor | null;
  font?: string;
  align?: "left" | "center" | "right";
  bullet?: "char" | "auto" | "none";
}

/** Where a shape lives: its part (for its relationships) and how its colors resolve. */
interface PartContext {
  part: string;
  colors: ColorContext;
}

/** A placeholder of a layout or master: its shape and the part it is in. */
interface Placeholder {
  sp: Element;
  ctx: PartContext;
}

/** What a slide's chain gives its placeholders. */
interface Chain {
  master: { root: Element; ctx: PartContext } | null;
  layout: { root: Element; ctx: PartContext } | null;
}

function placeholderOf(sp: Element): { type: string; idx: string | null } | null {
  const nvPr = kid(kids(sp).find((k) => nameOf(k).startsWith("nv")) ?? null, "nvPr");
  const ph = kid(nvPr, "ph");
  if (!ph) return null;
  return { type: attr(ph, "type") ?? "body", idx: attr(ph, "idx") };
}

/** The master's placeholder type a slide's or layout's stands for. */
function masterType(type: string): string {
  if (type === "ctrTitle" || type === "title") return "title";
  if (type === "dt" || type === "ftr" || type === "sldNum") return type;
  return "body";
}

/** Shapes of a part's tree, groups included (their children are searched for placeholders too). */
function allShapes(root: Element | null): Element[] {
  const tree = dig(root, "cSld", "spTree");
  const out: Element[] = [];
  const walk = (el: Element | null) => {
    for (const k of kids(el)) {
      const name = nameOf(k);
      if (name === "sp" || name === "pic" || name === "graphicFrame") out.push(k);
      else if (name === "grpSp") walk(k);
      else if (name === "AlternateContent") walk(kid(k, "Fallback") ?? kid(k, "Choice"));
    }
  };
  walk(tree);
  return out;
}

function findPlaceholder(
  root: Element | null,
  ph: { type: string; idx: string | null },
  byType: boolean,
): Element | null {
  const shapes = allShapes(root).filter((s) => placeholderOf(s) !== null);
  if (!byType && ph.idx !== null) {
    const same = shapes.find((s) => placeholderOf(s)?.idx === ph.idx);
    if (same) return same;
  }
  const wanted = byType ? masterType(ph.type) : ph.type;
  return (
    shapes.find((s) => {
      const p = placeholderOf(s) as { type: string };
      return (byType ? masterType(p.type) : p.type) === wanted;
    }) ?? null
  );
}

class DeckReader {
  private readonly media: DeckData["media"] = {};
  private readonly mediaByPath = new Map<string, string | null>();
  private readonly theme: Theme;
  private readonly scale: number;
  private readonly defaultTextStyle: Element | null;
  private readonly height: number;

  constructor(
    private readonly pkg: OfficePackage,
    private readonly presentation: Element,
    private readonly presentationPart: string,
  ) {
    const size = kid(presentation, "sldSz");
    const cx = intAttr(size, "cx") ?? 12_192_000;
    const cy = intAttr(size, "cy") ?? 6_858_000;
    this.scale = DECK_W / (cx > 0 ? cx : 12_192_000);
    this.height = Math.round((cy > 0 ? cy : 6_858_000) * this.scale);
    this.defaultTextStyle = kid(presentation, "defaultTextStyle");
    this.theme = this.readTheme();
  }

  private readTheme(): Theme {
    // The deck's theme is its first master's.
    const firstMaster = this.masterParts()[0] ?? null;
    const rel = firstMaster ? this.pkg.relOfType(firstMaster, REL.theme) : null;
    const part = rel && !rel.external ? rel.target : null;
    const root = part ? this.pkg.xml(part) : null;
    const fonts = themeFonts(root);
    const fmt = dig(root, "themeElements", "fmtScheme");
    return {
      colors: themeColors(root),
      major: fonts.major,
      minor: fonts.minor,
      lines: kids(kid(fmt, "lnStyleLst"), "ln").map((ln) => intAttr(ln, "w") ?? 12_700),
      backgrounds: kids(kid(fmt, "bgFillStyleLst")),
      fills: kids(kid(fmt, "fillStyleLst")),
      part,
    };
  }

  private masterParts(): string[] {
    return kids(kid(this.presentation, "sldMasterIdLst"), "sldMasterId")
      .map((m) => this.pkg.target(this.presentationPart, relAttr(m)))
      .filter((p): p is string => p !== null);
  }

  /** The slides' parts in the deck's order. */
  slideParts(): string[] {
    return kids(kid(this.presentation, "sldIdLst"), "sldId")
      .map((s) => this.pkg.target(this.presentationPart, relAttr(s)))
      .filter((p): p is string => p !== null && this.pkg.has(p));
  }

  private u(emu: number): number {
    return Math.round(emu * this.scale * 100) / 100;
  }

  // ── Colors, fills and lines ────────────────────────────────────────────────

  private fillOf(spPr: Element | null, ctx: PartContext, style: Element | null): DrawnColor | "none" | null {
    for (const k of kids(spPr)) {
      switch (nameOf(k)) {
        case "noFill":
          return "none";
        case "solidFill":
          return drawingColor(k, ctx.colors);
        case "gradFill": {
          const stops = kids(kid(k, "gsLst"), "gs");
          return drawingColor(stops[Math.floor(stops.length / 2)] ?? stops[0] ?? null, ctx.colors);
        }
        case "pattFill":
          return drawingColor(kid(k, "fgClr"), ctx.colors);
        case "grpFill":
          return null;
      }
    }
    // The shape's style: a theme fill in the reference's color.
    const ref = kid(style, "fillRef");
    const idx = intAttr(ref, "idx") ?? 0;
    if (ref && idx > 0) {
      const color = drawingColor(ref, ctx.colors);
      const fill = this.theme.fills[idx - 1];
      if (fill && nameOf(fill) === "noFill") return "none";
      return color;
    }
    return null;
  }

  private lineOf(
    spPr: Element | null,
    ctx: PartContext,
    style: Element | null,
  ): { color: DrawnColor; width: number; arrow: boolean } | null {
    const ln = kid(spPr, "ln");
    const ref = kid(style, "lnRef");
    const refIdx = intAttr(ref, "idx") ?? 0;
    if (kid(ln, "noFill")) return null;
    let color = drawingColor(kid(ln, "solidFill"), ctx.colors);
    const grad = kids(kid(kid(ln, "gradFill"), "gsLst"), "gs")[0];
    if (!color && grad) color = drawingColor(grad, ctx.colors);
    if (!color && refIdx > 0) color = drawingColor(ref, ctx.colors);
    if (!color) return null;
    const width = intAttr(ln, "w") ?? (refIdx > 0 ? (this.theme.lines[refIdx - 1] ?? 12_700) : 12_700);
    const tail = attr(kid(ln, "tailEnd"), "type");
    return { color, width, arrow: tail !== null && tail !== "none" };
  }

  // ── Text ────────────────────────────────────────────────────────────────────

  private typefaceOf(face: string | null | undefined): string | undefined {
    if (!face) return undefined;
    if (face.startsWith("+mj")) return this.theme.major ?? undefined;
    if (face.startsWith("+mn")) return this.theme.minor ?? undefined;
    return face;
  }

  /** Run properties (`rPr`, `defRPr`, `endParaRPr`) over `base`. */
  private runProps(el: Element | null, base: TextProps, ctx: PartContext): TextProps {
    if (!el) return base;
    const out: TextProps = { ...base };
    const sz = intAttr(el, "sz");
    if (sz !== null && sz > 0) out.size = sz;
    if (attr(el, "b") !== null) out.bold = boolAttr(el, "b");
    if (attr(el, "i") !== null) out.italic = boolAttr(el, "i");
    const u = attr(el, "u");
    if (u !== null) out.underline = u !== "none";
    const strike = attr(el, "strike");
    if (strike !== null) out.strike = strike !== "noStrike";
    const fill = kid(el, "solidFill");
    if (fill) out.color = drawingColor(fill, ctx.colors) ?? out.color;
    const face = this.typefaceOf(attr(kid(el, "latin"), "typeface"));
    if (face) out.font = face;
    return out;
  }

  /** Paragraph properties (`pPr`, `lvlNpPr`) over `base`, their default run properties included. */
  private paraProps(el: Element | null, base: TextProps, ctx: PartContext): TextProps {
    if (!el) return base;
    const out = this.runProps(kid(el, "defRPr"), { ...base }, ctx);
    const algn = attr(el, "algn");
    if (algn) out.align = algn === "ctr" ? "center" : algn === "r" ? "right" : "left";
    if (kid(el, "buNone")) out.bullet = "none";
    else if (kid(el, "buAutoNum")) out.bullet = "auto";
    else if (kid(el, "buChar") || kid(el, "buBlip")) out.bullet = "char";
    return out;
  }

  /** The list styles a shape's text inherits, lowest first: the deck's default, the master's, its placeholders'. */
  private textChain(
    sp: Element,
    chain: Chain,
    ph: { type: string; idx: string | null } | null,
  ): { styles: { el: Element; ctx: PartContext }[]; bodyPr: Element[] } {
    const styles: { el: Element; ctx: PartContext }[] = [];
    const bodyPr: Element[] = [];
    const master = chain.master;
    if (this.defaultTextStyle && master) styles.push({ el: this.defaultTextStyle, ctx: master.ctx });
    if (master) {
      const txStyles = kid(master.root, "txStyles");
      const family = ph ? masterType(ph.type) : null;
      const which =
        family === "title" ? "titleStyle" : family === "body" ? "bodyStyle" : family ? "otherStyle" : "otherStyle";
      const own = kid(txStyles, which);
      if (own) styles.push({ el: own, ctx: master.ctx });
      if (ph) {
        const mph = findPlaceholder(master.root, ph, true);
        const lst = dig(mph, "txBody", "lstStyle");
        if (lst) styles.push({ el: lst, ctx: master.ctx });
        const body = dig(mph, "txBody", "bodyPr");
        if (body) bodyPr.push(body);
      }
    }
    if (ph && chain.layout) {
      const lph = findPlaceholder(chain.layout.root, ph, false);
      const lst = dig(lph, "txBody", "lstStyle");
      if (lst) styles.push({ el: lst, ctx: chain.layout.ctx });
      const body = dig(lph, "txBody", "bodyPr");
      if (body) bodyPr.push(body);
    }
    const ownBody = dig(sp, "txBody", "bodyPr");
    if (ownBody) bodyPr.push(ownBody);
    return { styles, bodyPr };
  }

  /**
   * A shape's text as rich paragraphs, with the look of its first run (the element's own size, color and font) and
   * how it sits in its box.
   */
  private textOf(
    sp: Element,
    ctx: PartContext,
    chain: Chain,
    ph: { type: string; idx: string | null } | null,
    slideNumber: number,
  ): { rich: RichDoc; look: TextProps; valign?: ElementStyle["valign"] } | null {
    const body = kid(sp, "txBody");
    if (!body) return null;
    const { styles, bodyPr } = this.textChain(sp, chain, ph);
    const ownLst = kid(body, "lstStyle");
    // How the text sits and shrinks: the last body properties that say.
    let anchor: string | null = null;
    let scale = 1;
    for (const b of bodyPr) {
      anchor = attr(b, "anchor") ?? anchor;
      const fit = kid(b, "normAutofit");
      if (fit) scale = (numAttr(fit, "fontScale") ?? 100_000) / 100_000;
    }
    // The shape's style says its text color over what the master and the deck say, under the shape's own styles.
    const fontRef = dig(sp, "style", "fontRef");
    const refColor = fontRef ? drawingColor(fontRef, ctx.colors) : null;
    const baseColor = this.schemeColor("tx1", ctx);

    const paragraphs: RichParagraph[] = [];
    let first: TextProps | null = null;
    for (const p of kids(body, "p")) {
      const pPr = kid(p, "pPr");
      const lvl = Math.max(0, Math.min(8, intAttr(pPr, "lvl") ?? 0));
      let props: TextProps = { size: DEFAULT_SIZE, color: baseColor, align: "left" };
      const level = `lvl${lvl + 1}pPr`;
      for (const s of styles) props = this.paraProps(kid(s.el, level), props, s.ctx);
      if (refColor) props = { ...props, color: refColor };
      props = this.paraProps(kid(ownLst, level), props, ctx);
      props = this.paraProps(pPr, props, ctx);
      const runs: RichRun[] = [];
      for (const r of kids(p)) {
        const name = nameOf(r);
        if (name !== "r" && name !== "br" && name !== "fld") continue;
        const rp = this.runProps(kid(r, "rPr"), props, ctx);
        let text: string;
        if (name === "br") text = "\n";
        else if (name === "fld" && attr(r, "type") === "slidenum") text = String(slideNumber);
        else text = textOf(kid(r, "t")).replace(/\t/g, " ");
        if (text === "") continue;
        if (!first && name !== "br" && text.trim() !== "") first = rp;
        runs.push(this.runOf(text, rp, kid(r, "rPr"), ctx));
      }
      const paragraph: RichParagraph = { runs };
      if (props.align && props.align !== "left") paragraph.align = props.align;
      if (lvl > 0) paragraph.level = Math.min(lvl, 4);
      const hasText = runs.some((r) => r.text.trim() !== "");
      if (hasText && props.bullet === "char") paragraph.list = "bullet";
      if (hasText && props.bullet === "auto") paragraph.list = "ordered";
      paragraphs.push(paragraph);
    }
    if (!paragraphs.some((p) => p.runs.some((r) => r.text.trim() !== ""))) return null;
    const look: TextProps = { ...(first ?? {}) };
    if (look.size !== undefined) look.size = look.size * scale;
    // Run colors equal to the element's own color are left to it.
    const elementColor = look.color?.hex;
    for (const p of paragraphs) {
      for (const r of p.runs) if (r.color && r.color === elementColor) delete r.color;
    }
    const firstAlign = paragraphs[0]?.align;
    look.align = firstAlign ?? "left";
    const valign = anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : anchor === "t" ? "top" : undefined;
    return { rich: normalizeRich(paragraphs), look, valign };
  }

  private schemeColor(name: string, ctx: PartContext): DrawnColor | null {
    const mapped = ctx.colors.map[name] ?? name;
    const hex = ctx.colors.scheme[mapped];
    return hex ? { hex, alpha: 1 } : null;
  }

  private runOf(text: string, props: TextProps, rPr: Element | null, ctx: PartContext): RichRun {
    const run: RichRun = { text };
    if (props.bold) run.bold = true;
    if (props.italic) run.italic = true;
    if (props.underline) run.underline = true;
    if (props.strike) run.strike = true;
    if (props.color) run.color = props.color.hex;
    const link = this.pkg.rels(ctx.part).get(relAttr(kid(rPr, "hlinkClick")) ?? "");
    if (link?.external && /^(?:https?:|mailto:)/i.test(link.target) && link.target.length <= 2000)
      run.link = link.target;
    return run;
  }

  // ── Media ──────────────────────────────────────────────────────────────────

  /** A picture of the file by its relationship, taken out once; its name in `media`, or null when it can't be shown. */
  private mediaOf(part: string, rId: string | null): string | null {
    const path = this.pkg.target(part, rId);
    if (!path) return null;
    if (this.mediaByPath.has(path)) return this.mediaByPath.get(path) ?? null;
    let name: string | null = null;
    const bytes = this.pkg.bytes(path);
    const type = bytes ? imageTypeOf(bytes) : null;
    if (bytes && type && MEDIA_TYPES.has(type)) {
      const base = (path.split("/").pop() ?? "image").replace(/[^\w.-]/g, "_");
      name = base;
      for (let n = 2; this.media[name]; n++) name = `${n}-${base}`;
      this.media[name] = { type, bytes };
    }
    this.mediaByPath.set(path, name);
    return name;
  }

  // ── Elements ────────────────────────────────────────────────────────────────

  /** A shape's box in deck units, from its own transform or its placeholder's. */
  private boxOf(
    xfrm: Element | null,
    fallback: Element | null,
    at: Xform,
  ): { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean } | null {
    const t = xfrm && kid(xfrm, "off") ? xfrm : fallback;
    const off = kid(t, "off");
    const ext = kid(t, "ext");
    if (!off || !ext) return null;
    const x = numAttr(off, "x") ?? 0;
    const y = numAttr(off, "y") ?? 0;
    const cx = numAttr(ext, "cx") ?? 0;
    const cy = numAttr(ext, "cy") ?? 0;
    const rot = ((numAttr(t, "rot") ?? 0) / 60_000 + at.rot) % 360;
    return {
      x: this.u(at.tx + x * at.sx),
      y: this.u(at.ty + y * at.sy),
      w: this.u(cx * at.sx),
      h: this.u(cy * at.sy),
      rot: rot < 0 ? rot + 360 : rot,
      flipH: boolAttr(t, "flipH"),
      flipV: boolAttr(t, "flipV"),
    };
  }

  private placeholderShape(
    ph: { type: string; idx: string | null } | null,
    chain: Chain,
  ): { layout: Placeholder | null; master: Placeholder | null } {
    if (!ph) return { layout: null, master: null };
    const l = chain.layout ? findPlaceholder(chain.layout.root, ph, false) : null;
    const m = chain.master ? findPlaceholder(chain.master.root, ph, true) : null;
    return {
      layout: l && chain.layout ? { sp: l, ctx: chain.layout.ctx } : null,
      master: m && chain.master ? { sp: m, ctx: chain.master.ctx } : null,
    };
  }

  private roleOf(ph: { type: string } | null, bodies: { n: number }): SlideRole | undefined {
    if (!ph) return undefined;
    if (ph.type === "title" || ph.type === "ctrTitle") return "title";
    if (ph.type === "subTitle") return "subtitle";
    if (ph.type === "body" || ph.type === "obj") return bodies.n++ === 0 ? "body" : "body2";
    return undefined;
  }

  /** Elements of a shape tree, groups flattened, in drawing order. */
  private elementsOf(
    tree: Element | null,
    ctx: PartContext,
    chain: Chain,
    at: Xform,
    out: DeckElementData[],
    opts: { slideNumber: number; placeholders: boolean; bodies: { n: number } },
  ): void {
    for (const el of kids(tree)) {
      if (out.length >= ELEMENTS_MAX) return;
      switch (nameOf(el)) {
        case "sp":
        case "cxnSp":
          this.shape(el, ctx, chain, at, out, opts);
          break;
        case "pic":
          this.picture(el, ctx, chain, at, out, opts);
          break;
        case "graphicFrame":
          this.frame(el, at, out, opts);
          break;
        case "grpSp": {
          const xfrm = dig(el, "grpSpPr", "xfrm");
          const off = kid(xfrm, "off");
          const ext = kid(xfrm, "ext");
          const chOff = kid(xfrm, "chOff");
          const chExt = kid(xfrm, "chExt");
          let inner = at;
          if (off && ext && chOff && chExt) {
            const cw = numAttr(chExt, "cx") || 1;
            const ch = numAttr(chExt, "cy") || 1;
            const gsx = (numAttr(ext, "cx") ?? cw) / cw;
            const gsy = (numAttr(ext, "cy") ?? ch) / ch;
            inner = {
              sx: at.sx * gsx,
              sy: at.sy * gsy,
              tx: at.tx + at.sx * ((numAttr(off, "x") ?? 0) - (numAttr(chOff, "x") ?? 0) * gsx),
              ty: at.ty + at.sy * ((numAttr(off, "y") ?? 0) - (numAttr(chOff, "y") ?? 0) * gsy),
              rot: at.rot + (numAttr(xfrm, "rot") ?? 0) / 60_000,
            };
          }
          this.elementsOf(el, ctx, chain, inner, out, opts);
          break;
        }
        case "AlternateContent": {
          const pick = kid(el, "Fallback") ?? kid(el, "Choice");
          this.elementsOf(pick, ctx, chain, at, out, opts);
          break;
        }
      }
    }
  }

  private shape(
    sp: Element,
    ctx: PartContext,
    chain: Chain,
    at: Xform,
    out: DeckElementData[],
    opts: { slideNumber: number; placeholders: boolean; bodies: { n: number } },
  ): void {
    const ph = placeholderOf(sp);
    // A layout's or master's placeholders are only patterns for the slide's; their dates and numbers too.
    if (ph && !opts.placeholders) return;
    const spPr = kid(sp, "spPr");
    const inherited = this.placeholderShape(ph, chain);
    const box = this.boxOf(
      kid(spPr, "xfrm"),
      dig(inherited.layout?.sp ?? null, "spPr", "xfrm") ?? dig(inherited.master?.sp ?? null, "spPr", "xfrm"),
      at,
    );
    if (!box) return;
    const style = kid(sp, "style");
    const geometry = attr(kid(spPr, "prstGeom"), "prst") ?? (kid(spPr, "custGeom") ? "custom" : "rect");
    const line = this.lineOf(spPr, ctx, style);
    if (geometry === "line" || geometry.startsWith("straightConnector") || nameOf(sp) === "cxnSp") {
      if (!line) return;
      const x1 = box.flipH ? box.x + box.w : box.x;
      const y1 = box.flipV ? box.y + box.h : box.y;
      const x2 = box.flipH ? box.x : box.x + box.w;
      const y2 = box.flipV ? box.y : box.y + box.h;
      const lineStyle: ElementStyle = { stroke: line.color.hex, strokeWidth: this.width(line.width) };
      if (line.arrow) lineStyle.lineEnd = "arrow";
      if (line.color.alpha < 1) lineStyle.opacity = line.color.alpha;
      out.push({ type: "line", x: x1, y: y1, w: x2 - x1, h: y2 - y1, style: lineStyle });
      return;
    }
    // A picture filling a shape is a picture.
    const blip = kid(kid(spPr, "blipFill"), "blip");
    if (blip) {
      const media = this.mediaOf(ctx.part, relAttr(blip, "embed"));
      if (media) {
        out.push({ type: "image", x: box.x, y: box.y, w: box.w, h: box.h, media, fit: "cover", ...this.rotated(box) });
      }
      return;
    }
    const fill = this.fillOf(spPr, ctx, style) ?? this.inheritedFill(inherited);
    const text = this.textOf(sp, ctx, chain, ph, opts.slideNumber);
    const filled = fill && fill !== "none";
    if (!filled && !line && !text) return;
    const el: DeckElementData = {
      type: filled || line ? "shape" : "text",
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      ...this.rotated(box),
    };
    const role = this.roleOf(ph, opts.bodies);
    if (role) el.role = role;
    const s: ElementStyle = {};
    if (el.type === "shape") {
      s.shape = this.shapeKind(geometry);
      s.fill = filled ? fill.hex : "none";
      if (filled && fill.alpha < 1) s.opacity = Math.round(fill.alpha * 100) / 100;
      if (line) {
        s.stroke = line.color.hex;
        s.strokeWidth = this.width(line.width);
      } else s.stroke = "none";
      if (geometry === "roundRect") {
        const adj = this.adjust(spPr, 16_667);
        s.radius = Math.round(Math.min(box.w, box.h) * adj * 100) / 100;
      }
    }
    if (text) {
      el.text = text.rich;
      Object.assign(s, this.textStyle(text.look));
      // PowerPoint's text starts at the top of its box unless the box says otherwise.
      s.valign = text.valign ?? "top";
    }
    if (Object.keys(s).length > 0) el.style = s;
    out.push(el);
  }

  private inheritedFill(inherited: { layout: Placeholder | null; master: Placeholder | null }) {
    for (const p of [inherited.layout, inherited.master]) {
      if (!p) continue;
      const fill = this.fillOf(kid(p.sp, "spPr"), p.ctx, null);
      if (fill) return fill;
    }
    return null;
  }

  /** A shape's first adjustment as a fraction (a rounded rectangle's corner), or `fallback` in 100,000ths. */
  private adjust(spPr: Element | null, fallback: number): number {
    const gd = kids(dig(spPr, "prstGeom", "avLst"), "gd")[0];
    const fmla = attr(gd, "fmla");
    const m = fmla ? /^val\s+(-?\d+)$/.exec(fmla.trim()) : null;
    return Math.max(0, Math.min(50_000, m ? Number(m[1]) : fallback)) / 100_000;
  }

  private width(emu: number): number {
    return Math.max(0.5, Math.round(emu * this.scale * 100) / 100);
  }

  private rotated(box: { rot: number }): { rot?: number } {
    return box.rot ? { rot: Math.round(box.rot * 100) / 100 } : {};
  }

  private shapeKind(prst: string): ShapeKind {
    if (prst === "ellipse" || prst === "circle" || prst === "pie" || prst === "chord") return "ellipse";
    if (prst === "triangle" || prst === "rtTriangle") return "triangle";
    if (prst === "diamond") return "diamond";
    if (/arrow/i.test(prst) && !/callout/i.test(prst)) return "arrow";
    return "rect";
  }

  /** The element's text look in deck units. */
  private textStyle(look: TextProps): ElementStyle {
    const s: ElementStyle = { weight: 400 };
    if (look.size !== undefined) {
      s.size = Math.max(4, Math.min(1000, Math.round(look.size * EMU_PER_CENTIPOINT * this.scale * 10) / 10));
    }
    if (look.color) s.color = look.color.hex;
    const heading = this.theme.major && this.theme.major !== this.theme.minor && look.font === this.theme.major;
    s.font = heading ? "heading" : "body";
    if (look.align) s.align = look.align;
    return s;
  }

  private picture(
    pic: Element,
    ctx: PartContext,
    chain: Chain,
    at: Xform,
    out: DeckElementData[],
    opts: { placeholders: boolean },
  ): void {
    const ph = placeholderOf(pic);
    if (ph && !opts.placeholders) return;
    const blipFill = kid(pic, "blipFill");
    const blip = kid(blipFill, "blip");
    const media = this.mediaOf(ctx.part, relAttr(blip, "embed"));
    if (!media) return;
    const inherited = this.placeholderShape(ph, chain);
    const box = this.boxOf(
      dig(pic, "spPr", "xfrm"),
      dig(inherited.layout?.sp ?? null, "spPr", "xfrm") ?? dig(inherited.master?.sp ?? null, "spPr", "xfrm"),
      at,
    );
    if (!box) return;
    const crop = kid(blipFill, "srcRect");
    const cropped = ["l", "t", "r", "b"].some((side) => (numAttr(crop, side) ?? 0) !== 0);
    const el: DeckElementData = {
      type: "image",
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      media,
      fit: cropped ? "cover" : "contain",
      ...this.rotated(box),
    };
    const alt = attr(dig(pic, "nvPicPr", "cNvPr"), "descr");
    if (alt) el.alt = alt.slice(0, 1000);
    out.push(el);
  }

  private frame(frame: Element, at: Xform, out: DeckElementData[], opts: { placeholders: boolean }): void {
    if (placeholderOf(frame) && !opts.placeholders) return;
    const tbl = dig(frame, "graphic", "graphicData", "tbl");
    if (!tbl) return;
    const box = this.boxOf(kid(frame, "xfrm"), null, at);
    if (!box) return;
    const rows: string[][] = [];
    for (const tr of kids(tbl, "tr").slice(0, 50)) {
      const row: string[] = [];
      for (const tc of kids(tr, "tc").slice(0, 20)) {
        const merged = boolAttr(tc, "hMerge") || boolAttr(tc, "vMerge");
        const text = merged
          ? ""
          : kids(kid(tc, "txBody"), "p")
              .map((p) =>
                kids(p)
                  .map((r) =>
                    nameOf(r) === "br" ? "\n" : nameOf(r) === "r" || nameOf(r) === "fld" ? textOf(kid(r, "t")) : "",
                  )
                  .join(""),
              )
              .join("\n");
        row.push(text.slice(0, 2000));
      }
      rows.push(row);
    }
    if (rows.length === 0) return;
    const header = boolAttr(kid(tbl, "tblPr"), "firstRow");
    out.push({ type: "table", x: box.x, y: box.y, w: box.w, h: box.h, table: { rows, header } });
  }

  // ── Slides ──────────────────────────────────────────────────────────────────

  private partContext(part: string, map: Record<string, string>): PartContext {
    return { part, colors: { scheme: this.theme.colors, map } };
  }

  /** A part's background: a color or a picture, or null when it leaves it to the part under it. */
  private backgroundOf(root: Element | null, ctx: PartContext): DeckSlideData["bg"] | null {
    const bg = dig(root, "cSld", "bg");
    if (!bg) return null;
    const pr = kid(bg, "bgPr");
    if (pr) {
      for (const k of kids(pr)) {
        const name = nameOf(k);
        if (name === "solidFill") return drawingColor(k, ctx.colors)?.hex ?? null;
        if (name === "gradFill") {
          const stops = kids(kid(k, "gsLst"), "gs");
          return drawingColor(stops[0] ?? null, ctx.colors)?.hex ?? null;
        }
        if (name === "blipFill") {
          const media = this.mediaOf(ctx.part, relAttr(kid(k, "blip"), "embed"));
          return media ? { media } : null;
        }
        if (name === "pattFill") return drawingColor(kid(k, "bgClr"), ctx.colors)?.hex ?? null;
      }
      return null;
    }
    const ref = kid(bg, "bgRef");
    if (!ref) return null;
    const color = drawingColor(ref, ctx.colors);
    const idx = intAttr(ref, "idx") ?? 0;
    const style = idx >= 1001 ? this.theme.backgrounds[idx - 1001] : idx > 0 ? this.theme.fills[idx - 1] : undefined;
    if (style && nameOf(style) === "blipFill" && this.theme.part) {
      const media = this.mediaOf(this.theme.part, relAttr(kid(style, "blip"), "embed"));
      if (media) return { media };
    }
    if (style && (nameOf(style) === "solidFill" || nameOf(style) === "gradFill")) {
      const first = nameOf(style) === "solidFill" ? style : (kids(kid(style, "gsLst"), "gs")[0] ?? null);
      const resolved = drawingColor(first, { ...ctx.colors, placeholder: color });
      if (resolved) return resolved.hex;
    }
    return color?.hex ?? null;
  }

  private layoutOf(root: Element | null): SlideLayout {
    switch (attr(root, "type")) {
      case "title":
        return "title";
      case "obj":
      case "tx":
      case "txAndObj":
      case "objTx":
        return "title-body";
      case "secHead":
        return "section";
      case "twoObj":
      case "twoTxTwoObj":
      case "twoColTx":
        return "two-columns";
      case "picTx":
        return "image-right";
      case "titleOnly":
        return "title-only";
      case "blank":
        return "blank";
      default:
        return "blank";
    }
  }

  slide(part: string, number: number): DeckSlideData {
    const root = this.pkg.xml(part);
    if (!root) throw officeUnreadable(`${part} is missing`);
    const layoutPart = this.pkg.relOfType(part, REL.slideLayout);
    const layoutRoot = layoutPart && !layoutPart.external ? this.pkg.xml(layoutPart.target) : null;
    const masterRel =
      layoutPart && !layoutPart.external ? this.pkg.relOfType(layoutPart.target, REL.slideMaster) : null;
    const masterRoot = masterRel && !masterRel.external ? this.pkg.xml(masterRel.target) : null;
    const masterMap = colorMap(kid(masterRoot, "clrMap"));
    const override = (r: Element | null) => {
      const o = dig(r, "clrMapOvr", "overrideClrMapping");
      return o ? colorMap(o) : null;
    };
    const layoutMap = override(layoutRoot) ?? masterMap;
    const slideMap = override(root) ?? layoutMap;
    const chain: Chain = {
      master: masterRoot && masterRel ? { root: masterRoot, ctx: this.partContext(masterRel.target, masterMap) } : null,
      layout:
        layoutRoot && layoutPart ? { root: layoutRoot, ctx: this.partContext(layoutPart.target, layoutMap) } : null,
    };
    const ctx = this.partContext(part, slideMap);
    const elements: DeckElementData[] = [];
    const bodies = { n: 0 };
    // What the master and the layout draw behind the slide (unless the slide or the layout hides it).
    const showMaster = attr(root, "showMasterSp") !== "0" && attr(layoutRoot, "showMasterSp") !== "0";
    if (chain.master && showMaster) {
      const tree = dig(chain.master.root, "cSld", "spTree");
      this.elementsOf(tree, chain.master.ctx, { master: chain.master, layout: null }, IDENTITY, elements, {
        slideNumber: number,
        placeholders: false,
        bodies,
      });
    }
    if (chain.layout && attr(root, "showMasterSp") !== "0") {
      const tree = dig(chain.layout.root, "cSld", "spTree");
      this.elementsOf(tree, chain.layout.ctx, { master: chain.master, layout: null }, IDENTITY, elements, {
        slideNumber: number,
        placeholders: false,
        bodies,
      });
    }
    this.elementsOf(dig(root, "cSld", "spTree"), ctx, chain, IDENTITY, elements, {
      slideNumber: number,
      placeholders: true,
      bodies,
    });
    const bg =
      this.backgroundOf(root, ctx) ??
      (chain.layout ? this.backgroundOf(chain.layout.root, chain.layout.ctx) : null) ??
      (chain.master ? this.backgroundOf(chain.master.root, chain.master.ctx) : null) ??
      this.schemeColor("bg1", ctx)?.hex ??
      "#ffffff";
    const slide: DeckSlideData = { layout: this.layoutOf(layoutRoot), bg, elements: elements.slice(0, ELEMENTS_MAX) };
    if (attr(root, "show") === "0") slide.hidden = true;
    const notes = this.notesOf(part);
    if (notes) slide.notes = notes;
    return slide;
  }

  /** The speaker notes of a slide: its notes page's body text. */
  private notesOf(part: string): string | null {
    const rel = this.pkg.relOfType(part, REL.notesSlide);
    const root = rel && !rel.external ? this.pkg.xml(rel.target) : null;
    for (const sp of allShapes(root)) {
      const ph = placeholderOf(sp);
      if (ph?.type !== "body") continue;
      const text = kids(kid(sp, "txBody"), "p")
        .map((p) =>
          kids(p)
            .map((r) =>
              nameOf(r) === "br" ? "\n" : nameOf(r) === "r" || nameOf(r) === "fld" ? textOf(kid(r, "t")) : "",
            )
            .join(""),
        )
        .join("\n")
        .trim();
      if (text) return text.slice(0, 20_000);
    }
    return null;
  }

  finish(slides: DeckSlideData[]): DeckData {
    const firstBg = slides.find((s) => typeof s.bg === "string")?.bg;
    const dark = typeof firstBg === "string" && luminance(firstBg) < 0.2;
    return { w: DECK_W, h: this.height, theme: dark ? "night" : "sky", slides, media: this.media };
  }
}

/** A PowerPoint deck as data: its slides in order, at 1920 units wide. */
export function readPptx(bytes: Uint8Array): DeckData {
  const pkg = OfficePackage.open(bytes);
  const presentationPart = pkg.mainPart("ppt/presentation.xml");
  const presentation = pkg.xml(presentationPart);
  if (!presentation) throw officeUnreadable("it has no presentation");
  const reader = new DeckReader(pkg, presentation, presentationPart);
  const parts = reader.slideParts();
  if (parts.length > OFFICE_LIMITS.slides) throw officeTooLarge("slides");
  const slides = parts.map((part, i) => reader.slide(part, i + 1));
  return reader.finish(slides);
}
